import { Body, Controller, Get, Module, Post, Put } from "@nestjs/common";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { createBackup } from "../backup";
import { SettingDto } from "../dto";
import { PrismaService } from "../prisma.service";

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
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
