import { BadRequestException, Body, Controller, Get, Module, Post, Put } from "@nestjs/common";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { createBackup } from "../backup";
import { RestoreBackupDto, SettingDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { configureLocalStorage } from "../storage";

@Controller("settings")
class SettingsController {
  constructor(private readonly prisma: PrismaService) {}
  // Reading settings (shop name, receipt footer, …) is allowed for every
  // signed-in user so receipts and the header show the configured name.
  @Get() async get() {
    const entries = await this.prisma.setting.findMany({ orderBy: { key: "asc" } });
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
  }
  @AdminOnly() @Put() async put(@Body() dto: SettingDto, @CurrentUser() user: SessionUser) {
    const setting = await this.prisma.setting.upsert({ where: { key: dto.key }, create: dto, update: { value: dto.value } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "UPDATE_SETTING", entity: "Setting", entityId: dto.key } });
    return setting;
  }
  @AdminOnly() @Post("backup") async backup(@CurrentUser() user: SessionUser) {
    const filePath = await createBackup(this.prisma);
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "CREATE_BACKUP", entity: "Database", detail: filePath } });
    return { path: filePath, createdAt: new Date().toISOString() };
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
    const dbPath = (process.env.DATABASE_URL || "").replace(/^file:/, "");
    if (!dbPath) throw new BadRequestException("مسیر دیتابیس محلی پیدا نشد.");
    const safetyPath = await createBackup(this.prisma, "before-restore");
    await this.prisma.$disconnect();
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

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
