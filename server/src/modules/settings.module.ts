import { Body, Controller, Get, Module, Post, Put } from "@nestjs/common";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { SettingDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { configureLocalStorage } from "../storage";

@AdminOnly()
@Controller("settings")
class SettingsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() async get() {
    const entries = await this.prisma.setting.findMany({ orderBy: { key: "asc" } });
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
  }
  @Put() async put(@Body() dto: SettingDto, @CurrentUser() user: SessionUser) {
    const setting = await this.prisma.setting.upsert({ where: { key: dto.key }, create: dto, update: { value: dto.value } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "UPDATE_SETTING", entity: "Setting", entityId: dto.key } });
    return setting;
  }
  @Post("backup") async backup(@CurrentUser() user: SessionUser) {
    const dataDir = configureLocalStorage();
    const backupDir = join(dataDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(backupDir, `dar-pos-${stamp}.db`).replace(/\\/g, "/");
    const sqlPath = filePath.replace(/'/g, "''");
    await this.prisma.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "CREATE_BACKUP", entity: "Database", detail: filePath } });
    return { path: filePath, createdAt: new Date().toISOString() };
  }
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
