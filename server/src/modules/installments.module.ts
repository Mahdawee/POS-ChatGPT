import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { CreateInstallmentPlanDto, PayInstallmentDto } from "../dto";
import { PrismaService } from "../prisma.service";

/**
 * قسط‌بندی بدهی مشتری: یک پلن با N قسطِ تاریخ‌دار. پرداخت هر قسط همان
 * «وصولی از مشتری» است (CustomerPayment)، پس ماندهٔ نسیهٔ مشتری همیشه
 * با اقساط هم‌خوان می‌ماند؛ اینجا فقط برنامهٔ زمانی و وضعیت هر قسط
 * مدیریت می‌شود.
 */
@Controller("installments")
export class InstallmentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() dto: CreateInstallmentPlanDto, @CurrentUser() user: SessionUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer || !customer.isActive) throw new BadRequestException("مشتری پیدا نشد.");
    const interval = dto.intervalDays ?? 30;
    const start = dto.startDate ? new Date(`${dto.startDate}T00:00:00`) : new Date(Date.now() + interval * 86400000);
    if (Number.isNaN(start.getTime())) throw new BadRequestException("تاریخ شروع معتبر نیست.");
    // Even split; the last installment absorbs the rounding remainder so the
    // parts always add up to exactly the plan total.
    const base = Math.floor(dto.total / dto.installmentCount);
    const amounts = Array.from({ length: dto.installmentCount }, (_, index) => (index === dto.installmentCount - 1 ? dto.total - base * (dto.installmentCount - 1) : base));
    if (amounts.some((amount) => amount <= 0)) throw new BadRequestException("تعداد اقساط برای این مبلغ زیاد است؛ اقساط کوچک‌تر از ۱ افغانی می‌شوند.");
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.installmentPlan.create({
        data: {
          customerId: dto.customerId, total: dto.total, note: dto.note?.trim(),
          saleId: dto.saleId, userId: user.id,
          installments: {
            create: amounts.map((amount, index) => ({ seq: index + 1, amount, dueDate: new Date(start.getTime() + index * interval * 86400000) })),
          },
        },
        include: { installments: true, customer: { select: { name: true } } },
      });
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_INSTALLMENT_PLAN", entity: "InstallmentPlan", entityId: plan.id, detail: `${dto.total} / ${dto.installmentCount} قسط` } });
      return plan;
    });
  }

  @Get()
  list(@Query("customerId") customerId?: string, @Query("status") status?: string) {
    const where: { customerId?: string; status?: string } = {};
    if (customerId) where.customerId = customerId;
    if (status === "OPEN" || status === "SETTLED") where.status = status;
    return this.prisma.installmentPlan.findMany({ where, include: { installments: { orderBy: { seq: "asc" } }, customer: { select: { id: true, name: true, phone: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  /** اقساط سررسیدشده و پرداخت‌نشده — برای کارت هشدار داشبورد. */
  @Get("overdue")
  async overdue() {
    const now = new Date();
    const plans = await this.prisma.installmentPlan.findMany({
      where: { status: "OPEN" },
      include: { installments: { orderBy: { seq: "asc" } }, customer: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
    });
    const rows = plans
      .map((plan) => {
        const overdue = plan.installments.filter((inst) => !inst.paidAt && inst.dueDate < now);
        const next = plan.installments.find((inst) => !inst.paidAt);
        return { planId: plan.id, customer: plan.customer, total: plan.total, paidAmount: plan.paidAmount, overdueCount: overdue.length, overdueAmount: overdue.reduce((sum, inst) => sum + (inst.amount - inst.paidAmount), 0), nextDueDate: next?.dueDate ?? null, nextAmount: next ? next.amount - next.paidAmount : null };
      })
      .filter((row) => row.overdueCount > 0);
    return rows;
  }

  /** پرداخت یک قسط: قسط بسته می‌شود و به‌عنوان وصولی مشتری ثبت می‌شود. */
  @Post(":id/pay")
  async pay(@Param("id") id: string, @Body() dto: PayInstallmentDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const installment = await tx.installment.findUnique({ where: { id }, include: { plan: { include: { customer: true, installments: { orderBy: { seq: "asc" } } } } } });
      if (!installment) throw new NotFoundException("قسط پیدا نشد.");
      if (installment.plan.status !== "OPEN") throw new BadRequestException("این پلن قسط قبلاً بسته شده است.");
      const remaining = installment.amount - installment.paidAmount;
      if (remaining <= 0) throw new BadRequestException("این قسط قبلاً پرداخت شده است.");
      const amount = Math.min(dto.amount, remaining);
      if (amount <= 0) throw new BadRequestException("مبلغ پرداخت باید بیشتر از صفر باشد.");
      let cashSessionId: string | undefined;
      if (dto.fromCash) {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
        cashSessionId = session.id;
        await tx.cashMovement.create({ data: { type: "IN", amount, description: `قسط ${installment.plan.customer.name} (${installment.seq}/${installment.plan.installments.length})`, cashSessionId: session.id } });
      }
      // The installment payment is a customer collection: it settles debt in
      // the balance formulas exactly like a manual payment.
      await tx.customerPayment.create({ data: { customerId: installment.plan.customerId, amount, note: dto.note?.trim() || `پرداخت قسط ${installment.seq} از ${installment.plan.installments.length} — پلن ${installment.plan.id.slice(-6)}`, cashSessionId, userId: user.id } });
      const paidAmount = installment.paidAmount + amount;
      const fullyPaid = paidAmount >= installment.amount;
      await tx.installment.update({ where: { id }, data: { paidAmount, paidAt: fullyPaid ? new Date() : installment.paidAt } });
      const planPaid = installment.plan.paidAmount + amount;
      const planSettled = planPaid >= installment.plan.total;
      await tx.installmentPlan.update({ where: { id: installment.planId }, data: { paidAmount: planPaid, status: planSettled ? "SETTLED" : "OPEN" } });
      await tx.auditLog.create({ data: { actor: user.username, action: "PAY_INSTALLMENT", entity: "Installment", entityId: id, detail: String(amount) } });
      return { ok: true, amount, installmentPaid: fullyPaid, planSettled };
    });
  }
}

@Module({ controllers: [InstallmentsController] })
export class InstallmentsModule {}
