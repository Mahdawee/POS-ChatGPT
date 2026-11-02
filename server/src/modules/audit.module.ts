import { Controller, Get, Module, Query } from "@nestjs/common";
import { AdminOnly } from "../auth";
import { PrismaService } from "../prisma.service";

/** فعالیت‌های ثبت‌شدهٔ برنامه — چه کسی، چه کاری، کِی (برای مدیر). */
@AdminOnly()
@Controller("audit")
class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query("take") take?: string, @Query("actor") actor?: string, @Query("action") action?: string) {
    const limit = Math.min(300, Math.max(1, Number(take) || 100));
    const where: { actor?: string; action?: { startsWith?: string } } = {};
    if (actor?.trim()) where.actor = actor.trim();
    // Prefix match so filtering "CASH" also shows CASH_IN / CASH_OUT.
    if (action?.trim()) where.action = { startsWith: action.trim().toUpperCase() };
    return this.prisma.auditLog.findMany({ where, take: limit, orderBy: { createdAt: "desc" } });
  }

  /** Distinct action names, for the filter dropdown in the UI. */
  @Get("actions")
  async actions() {
    const rows = await this.prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } });
    return rows.map((row) => row.action);
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
