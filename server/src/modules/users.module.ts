import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { ResetPasswordDto, UserDto } from "../dto";
import { PrismaService } from "../prisma.service";

@AdminOnly()
@Controller("users")
class UsersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.user.findMany({ select: { id: true, username: true, displayName: true, role: true, isActive: true, createdAt: true }, orderBy: { displayName: "asc" } }); }
  @Post() async create(@Body() dto: UserDto) {
    const user = await this.prisma.user.create({ data: { username: dto.username.trim(), displayName: dto.displayName.trim(), passwordHash: await bcrypt.hash(dto.password, 12), role: dto.role } });
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, isActive: user.isActive };
  }
  @Patch(":id/deactivate") async deactivate(@Param("id") id: string, @CurrentUser() actor: SessionUser) {
    if (id === actor.id) throw new BadRequestException("حساب مدیر جاری را نمی‌توان غیرفعال کرد.");
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException("کاربر پیدا نشد.");
    const user = await this.prisma.user.update({ where: { id }, data: { isActive: false }, select: { id: true, username: true, displayName: true, role: true, isActive: true } });
    await this.prisma.auditLog.create({ data: { actor: actor.username, action: "DEACTIVATE_USER", entity: "User", entityId: id } });
    return user;
  }
  @Patch(":id/activate") async activate(@Param("id") id: string, @CurrentUser() actor: SessionUser) {
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException("کاربر پیدا نشد.");
    const user = await this.prisma.user.update({ where: { id }, data: { isActive: true }, select: { id: true, username: true, displayName: true, role: true, isActive: true } });
    await this.prisma.auditLog.create({ data: { actor: actor.username, action: "ACTIVATE_USER", entity: "User", entityId: id } });
    return user;
  }
  @Patch(":id/reset-password") async resetPassword(@Param("id") id: string, @Body() dto: ResetPasswordDto, @CurrentUser() actor: SessionUser) {
    if (id === actor.id) throw new BadRequestException("برای تغییر گذرواژهٔ خود از بخش تنظیمات استفاده کنید.");
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException("کاربر پیدا نشد.");
    const user = await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) }, select: { id: true, username: true, displayName: true } });
    await this.prisma.auditLog.create({ data: { actor: actor.username, action: "RESET_PASSWORD", entity: "User", entityId: id } });
    return user;
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
