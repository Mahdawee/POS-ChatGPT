import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createBackup, pruneAutoBackups, resolveBackupDir } from "../backup";
import { PrismaService } from "../prisma.service";

/**
 * Pure scheduling rule (unit tested): when is the next automatic backup?
 *
 * - never ran → the coming occurrence of `hour` (today if still ahead,
 *   otherwise tomorrow);
 * - ran before → the occurrence of `hour` at least 24h after the last run,
 *   so exactly one backup per day even if the app restarts mid-day.
 */
export function nextScheduledRun(lastRun: Date | null, hour: number, from: Date): Date {
  const base = lastRun ? new Date(lastRun.getTime() + 24 * 3600000) : new Date(from.getTime());
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, 0, 0, 0);
  if (candidate.getTime() < from.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/** Deletes `auto-` backups older than `days` (age by file mtime). */
export function pruneBackupsOlderThan(days: number, custom?: string | null): number {
  // Lazily imported to keep this function unit-testable without dragging the
  // whole fs surface in; readdir/unlink are cheap enough inline.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readdirSync, statSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { configureLocalStorage } = require("../storage") as typeof import("../storage");
  let removed = 0;
  try {
    const dir = resolveBackupDir(custom);
    const cutoff = Date.now() - days * 86400000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("auto-") || !name.endsWith(".db")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch { /* raced away */ }
    }
  } catch { /* no backups dir yet */ }
  return removed;
}

/**
 * بکاپ زمان‌بندی‌شده: هر ۱۰ دقیقه چک می‌کند و اگر ساعتِ تنظیم‌شده رسیده
 * باشد (و آخرین بکاپ خودکار حدود ۲۴ ساعت گذشته باشد) یک بکاپ «auto-»
 * می‌سازد و بر اساس «مدت نگهداری» فایل‌های قدیمی را پاک می‌کند. همهٔ
 * تنظیمات از جدول Setting خوانده می‌شوند، پس تغییرشان بدون ری‌استارت
 * اعمال می‌شود.
 */
@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  private async setting(key: string): Promise<string | undefined> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value;
  }

  /** Runs one scheduler pass — also called directly by tests. */
  async tick(now = new Date()): Promise<{ ran: boolean; path?: string; pruned?: number }> {
    const enabled = (await this.setting("backupScheduleEnabled")) === "1";
    if (!enabled) return { ran: false };
    const hour = Math.min(23, Math.max(0, Number(await this.setting("backupHour")) || 0));
    const lastRunValue = await this.setting("lastScheduledBackupAt");
    const lastRun = lastRunValue ? new Date(lastRunValue) : null;
    if (now < nextScheduledRun(lastRun, hour, now)) return { ran: false };
    const path = await createBackup(this.prisma, "auto");
    await this.prisma.setting.upsert({
      where: { key: "lastScheduledBackupAt" },
      create: { key: "lastScheduledBackupAt", value: now.toISOString() },
      update: { value: now.toISOString() },
    });
    const retentionDays = Number(await this.setting("backupRetentionDays")) || 0;
    const customDir = await this.setting("backupDir");
    const pruned = retentionDays > 0 ? pruneBackupsOlderThan(retentionDays, customDir) : (pruneAutoBackups(10, customDir), 0);
    await this.prisma.auditLog.create({ data: { action: "SCHEDULED_BACKUP", entity: "Database", detail: path } }).catch(() => undefined);
    return { ran: true, path, pruned };
  }

  onModuleInit() {
    // 10-minute cadence: an hourly backup window is always caught within
    // 10 minutes of opening, and the pass itself is idempotent per day.
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined);
    }, 10 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
