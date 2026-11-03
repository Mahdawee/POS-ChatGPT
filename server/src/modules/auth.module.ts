import { Body, Controller, Get, Module, Post, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { ChangePasswordDto, LoginDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { CurrentUser, Public, sessionSecret, SessionUser } from "../auth";
import { SettingsController } from "./settings.module";

const TOKEN_TTL = "12h" as const;

@Controller("auth")
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("health")
  health() {
    // The Settings → Network page reads this: `mode` tells whether the running
    // API actually accepts LAN connections ("server" = bound to 0.0.0.0), and
    // `lan` lists this machine's IPv4 addresses so the exact client URLs
    // (http://<lan>:4317) can be shown without running ipconfig by hand.
    return { ok: true, mode: process.env.API_HOST === "0.0.0.0" ? "server" : "local", lan: SettingsController.lanAddresses() };
  }

  @Public()
  @Post("login")
  async login(@Body() dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username.trim() } });
    if (!user || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException("نام کاربری یا رمز عبور درست نیست.");
    const session = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
    const accessToken = jwt.sign(session, sessionSecret(), { expiresIn: TOKEN_TTL });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "LOGIN", entity: "User", entityId: user.id } });
    return { accessToken, user: session };
  }

  /** Sliding sessions: a signed-in client can exchange a still-valid token
   *  for a fresh one, so an always-on register never logs out mid-shift. */
  @Post("refresh")
  async refresh(@CurrentUser() session: SessionUser) {
    const user = await this.prisma.user.findUnique({ where: { id: session.id } });
    if (!user || !user.isActive) throw new UnauthorizedException("نشست معتبر نیست؛ دوباره وارد شوید.");
    const fresh = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
    return { accessToken: jwt.sign(fresh, sessionSecret(), { expiresIn: TOKEN_TTL }), user: fresh };
  }

  @Post("change-password")
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() session: SessionUser) {
    const user = await this.prisma.user.findUnique({ where: { id: session.id } });
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new UnauthorizedException("گذرواژه فعلی درست نیست.");
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "CHANGE_PASSWORD", entity: "User", entityId: user.id } });
    return { ok: true };
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
