import { BadRequestException, Body, Controller, Get, Module, Post, Put } from "@nestjs/common";
import * as os from "node:os";
import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { createBackup } from "../backup";
import { RestoreBackupDto, SettingDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { configureLocalStorage, databaseFilePath } from "../storage";
import { BackupScheduler } from "./backup-scheduler";

@Controller("settings")
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}
  // Reading settings (shop name, receipt footer, …) is allowed for every
  // signed-in user so receipts and the header show the configured name.
  @Get() async get() {
    const entries = await this.prisma.setting.findMany({ orderBy: { key: "asc" } });
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
  }
  /** تقویم نمایش تاریخ‌ها: شمسی (پیش‌فرض)، قمری یا میلادی. */
  static readonly CALENDARS = ["persian", "islamic-umalqura", "gregorian"];
  /** ارزهای پیش‌فرض نمایش مبالغ — افغانی همیشه ارز اصلی و دلار ارز دوم است.
   *  فهرست کامل در تنظیم «currencies» (JSON) ذخیره می‌شود و از بخش
   *  «مدیریت ارزها» در تنظیمات فروشگاه قابل افزودن/حذف است. */
  static readonly DEFAULT_CURRENCIES = [
    { code: "AFN", label: "افغانی" },
    { code: "USD", label: "دلار امریکا" },
  ];
  /** فهرست مؤثر ارزها: از تنظیم currencies؛ در نبود/خرابی آن، پیش‌فرض‌ها. */
  private async currencyList(): Promise<Array<{ code: string; label: string }>> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: "currencies" } });
      if (row) {
        const parsed = JSON.parse(row.value) as unknown;
        if (SettingsController.isCurrencyList(parsed)) return parsed;
      }
    } catch { /* keep the defaults */ }
    return SettingsController.DEFAULT_CURRENCIES;
  }
  /** نشانی‌های IPv4 همین دستگاه در شبکهٔ محلی — برای نمایش نشانی سرور به
   *  کامپیوترهای دیگر در صفحهٔ تنظیمات شبکه. */
  static lanAddresses(): string[] {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((net): net is os.NetworkInterfaceInfo => Boolean(net) && !net!.internal && net!.family === "IPv4")
      .map((net) => net!.address);
  }
  /** شکل معتبر فهرست ارز: آرایه‌ای از {code,label} با کد یکتا. */
  static isCurrencyList(value: unknown): value is Array<{ code: string; label: string }> {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 12 &&
      value.every((row) => {
        if (!row || typeof row !== "object") return false;
        const entry = row as { code?: unknown; label?: unknown };
        return (
          typeof entry.code === "string" &&
          typeof entry.label === "string" &&
          /^[A-Z]{2,6}$/.test(entry.code) &&
          entry.label.trim().length >= 1 &&
          entry.label.trim().length <= 30
        );
      }) &&
      new Set((value as Array<{ code: string }>).map((row) => row.code)).size === value.length
    );
  }
  @AdminOnly() @Put() async put(@Body() dto: SettingDto, @CurrentUser() user: SessionUser) {
    // Internal, machine-owned keys must not be edited from the UI.
    if (dto.key === "lastScheduledBackupAt" || dto.key.startsWith("invoiceSeq:")) {
      throw new BadRequestException("این کلید تنظیم داخلی برنامه است و قابل تغییر نیست.");
    }
    if (dto.key === "calendar" && !SettingsController.CALENDARS.includes(dto.value)) {
      throw new BadRequestException("تقویم باید شمسی، قمری یا میلادی باشد.");
    }
    if (dto.key === "currencies") {
      let parsed: unknown;
      try { parsed = JSON.parse(dto.value); } catch { /* handled below */ }
      if (!SettingsController.isCurrencyList(parsed)) {
        throw new BadRequestException("فهرست ارزها معتبر نیست: هر ارز باید کد (۲ تا ۶ حرف لاتین بزرگ) و نام (تا ۳۰ نویسه) داشته باشد؛ حداکثر ۱۲ ارز و بدون کد تکراری.");
      }
      if (!parsed.some((row) => row.code === "AFN")) {
        throw new BadRequestException("ارز افغانی (AFN) ارز اصلی برنامه است و از فهرست حذف نمی‌شود.");
      }
    }
    if (dto.key === "currency") {
      // ارز پایه باید یکی از ارزهای فهرست فروشگاه باشد (پیش‌فرض: افغانی/دلار).
      const list = await this.currencyList();
      if (!list.some((row) => row.code === dto.value)) {
        throw new BadRequestException("این ارز در فهرست ارزهای فروشگاه نیست. ابتدا آن را از بخش «مدیریت ارزها» در تنظیمات اضافه کنید.");
      }
    }
    if (dto.key === "timezone") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: dto.value });
      } catch {
        throw new BadRequestException("منطقهٔ زمانی معتبر نیست (مثال: Asia/Kabul).");
      }
    }
    if (dto.key === "backupHour" && !(Number(dto.value) >= 0 && Number(dto.value) <= 23)) {
      throw new BadRequestException("ساعت بکاپ باید بین ۰ تا ۲۳ باشد.");
    }
    if (dto.key === "backupRetentionDays" && !(Number(dto.value) >= 0 && Number(dto.value) <= 3650)) {
      throw new BadRequestException("مدت نگهداری بکاپ باید بین ۰ تا ۳۶۵۰ روز باشد.");
    }
    const setting = await this.prisma.setting.upsert({ where: { key: dto.key }, create: dto, update: { value: dto.value } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "UPDATE_SETTING", entity: "Setting", entityId: dto.key } });
    return setting;
  }
  @AdminOnly() @Post("backup") async backup(@CurrentUser() user: SessionUser) {
    const filePath = await createBackup(this.prisma);
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "CREATE_BACKUP", entity: "Database", detail: filePath } });
    return { path: filePath, createdAt: new Date().toISOString() };
  }

  /**
   * Support diagnostics: the recent `[unhandled E…]` blocks from api.log,
   * matched to the reference codes shown on screen, so an error report can be
   * copied straight out of the app without hunting for the file on disk.
   */
  @AdminOnly() @Get("diagnostics")
  async diagnostics() {
    const dataDir = configureLocalStorage();
    const logPath = join(dataDir, "api.log");
    try {
      const size = statSync(logPath).size;
      // Only the tail is relevant (and bounded): read at most the last 256KB.
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const handle = openSync(logPath, "r");
      try { readSync(handle, buffer, 0, length, Math.max(0, size - length)); } finally { closeSync(handle); }
      const text = buffer.toString("utf8");
      const blocks = [...text.matchAll(/\[unhandled (E[0-9A-Z]+)\][^\[]*/g)].map((match) => ({ code: match[1], text: match[0].trim().slice(0, 2400) }));
      return { logPath, logSize: size, errors: blocks.slice(-20).reverse() };
    } catch {
      // No log yet (fresh install) or it is momentarily unreadable.
      return { logPath, logSize: 0, errors: [] };
    }
  }

  /** Portable snapshot (the whole SQLite file, base64) for USB transfer or
   *  archiving — restorable on any machine via `backup/restore`. */
  @AdminOnly() @Get("backup/export")
  async exportBackup(@CurrentUser() user: SessionUser) {
    const dataDir = configureLocalStorage();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempPath = join(dataDir, "backups", `export-${stamp}.db`).replace(/\\/g, "/");
    await this.prisma.$executeRawUnsafe(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    try {
      const data = readFileSync(tempPath).toString("base64");
      await this.prisma.auditLog.create({ data: { actor: user.username, action: "EXPORT_BACKUP", entity: "Database", detail: tempPath } });
      return { filename: `dar-pos-backup-${stamp}.db`, data };
    } finally {
      try { unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }

  /** Replaces the live database with a backup file (base64). A safety copy of
   *  the current database is taken first and restored automatically if the
   *  replacement turns out to be unreadable. */
  @AdminOnly() @Post("backup/restore")
  async restoreBackup(@Body() dto: RestoreBackupDto, @CurrentUser() user: SessionUser) {
    if (!dto?.data) throw new BadRequestException("فایل پشتیبان خالی است.");
    const buffer = Buffer.from(dto.data, "base64");
    // Every SQLite file starts with this 16-byte header string.
    if (buffer.length < 100 || buffer.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") {
      throw new BadRequestException("فایل انتخاب‌شده یک نسخهٔ پشتیبان معتبر این برنامه نیست.");
    }
    const dbPath = databaseFilePath();
    if (!dbPath) throw new BadRequestException("مسیر دیتابیس محلی پیدا نشد.");
    const safetyPath = await createBackup(this.prisma, "before-restore");
    await this.prisma.$disconnect();
    // A stale -wal/-shm belonging to the REPLACED database must never be
    // replayed over the freshly restored file.
    for (const suffix of ["-wal", "-shm"]) { try { unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ } }
    try {
      writeFileSync(dbPath, buffer);
      await this.prisma.$connect();
      await this.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      // A quick read proves the file is a working database (not just a
      // well-headed one) before we declare success.
      await this.prisma.user.count();
    } catch (error) {
      console.error("[restore] replacement database rejected:", error);
      writeFileSync(dbPath, readFileSync(safetyPath));
      await this.prisma.$connect();
      throw new BadRequestException("این فایل قابل بازیابی نیست؛ دیتابیس قبلی بدون تغییر باقی ماند.");
    }
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "RESTORE_BACKUP", entity: "Database", detail: `from safety ${safetyPath}` } });
    return { ok: true };
  }
}

@Module({ controllers: [SettingsController], providers: [BackupScheduler] })
export class SettingsModule {}
