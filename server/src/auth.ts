import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLocalStorage } from "./storage";

export const PUBLIC_ROUTE = "pos:public";
export const ADMIN_ROUTE = "pos:admin";
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const AdminOnly = () => SetMetadata(ADMIN_ROUTE, true);
export type SessionUser = { id: string; username: string; displayName: string; role: "ADMIN" | "CASHIER" };
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => context.switchToHttp().getRequest().user);

export function sessionSecret(): string {
  if (process.env.POS_SESSION_SECRET) return process.env.POS_SESSION_SECRET;
  const keyPath = join(configureLocalStorage(), "session.key");
  try {
    process.env.POS_SESSION_SECRET = readFileSync(keyPath, "utf8").trim();
  } catch {
    const generated = randomBytes(32).toString("hex");
    try { writeFileSync(keyPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch {
      try { process.env.POS_SESSION_SECRET = readFileSync(keyPath, "utf8").trim(); }
      catch { process.env.POS_SESSION_SECRET = generated; }
    }
    process.env.POS_SESSION_SECRET ||= generated;
  }
  return process.env.POS_SESSION_SECRET;
}

@Injectable()
export class LocalAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization as string | undefined;
    if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedException("برای ادامه وارد شوید.");
    try {
      request.user = jwt.verify(authorization.slice(7), sessionSecret()) as SessionUser;
    } catch {
      throw new UnauthorizedException("نشست شما پایان یافته است. دوباره وارد شوید.");
    }
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ROUTE, [context.getHandler(), context.getClass()]);
    if (adminOnly && request.user.role !== "ADMIN") throw new ForbiddenException("این بخش فقط برای مدیر فروشگاه است.");
    return true;
  }
}
