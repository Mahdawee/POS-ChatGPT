import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { UserDto } from "../dto";
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
    const user = await this.prisma.user.update({ where: { id }, data: { isActive: false }, select: { id: true, username: true, displayName: true, role: true, isActive: true } });
    await this.prisma.auditLog.create({ data: { actor: actor.username, action: "DEACTIVATE_USER", entity: "User", entityId: id } });
    return user;
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
