import { BadRequestException, Body, Controller, Delete, Get, Module, Param, Post, Query } from "@nestjs/common";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { ExpenseDto } from "../dto";
import { PrismaService } from "../prisma.service";

/**
 * Store expenses (rent, electricity, transport, …). Expenses paid from the
 * drawer are recorded as a cash OUT movement of the open register so the
 * Z-report and the expected amount stay truthful.
 */
@AdminOnly()
@Controller("expenses")
export class ExpensesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query("from") from?: string, @Query("to") to?: string) {
    const end = to ? new Date(to.length === 10 ? `${to}T23:59:59.999` : to) : new Date();
    if (!to) end.setHours(23, 59, 59, 999);
    const start = from ? new Date(from.length === 10 ? `${from}T00:00:00` : from) : new Date(end.getTime() - 29 * 86400000);
    if (!from) start.setHours(0, 0, 0, 0);
    const where = { createdAt: { gte: start, lte: end } };
    const [list, agg] = await Promise.all([
      this.prisma.expense.findMany({ where, take: 300, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: "desc" } }),
      this.prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { list, total: agg._sum.amount || 0 };
  }

  @Post()
  async create(@Body() dto: ExpenseDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      // Money leaves the drawer only when the caller explicitly asks for it
      // and a register is open; otherwise it is bookkeeping only.
      let sessionId: string | null = null;
      if (dto.fromCash) {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
        if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
        sessionId = session.id;
      }
      const expense = await tx.expense.create({
        data: { title: dto.title.trim(), amount: dto.amount, category: dto.category?.trim() || null, note: dto.note?.trim() || null, fromCash: Boolean(dto.fromCash), cashSessionId: sessionId, userId: user.id },
        include: { user: { select: { displayName: true } } },
      });
      if (sessionId) {
        await tx.cashMovement.create({ data: { type: "OUT", amount: dto.amount, description: `هزینهٔ ${dto.title.trim()}`, cashSessionId: sessionId } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_EXPENSE", entity: "Expense", entityId: expense.id, detail: String(dto.amount) } });
      return expense;
    });
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: SessionUser) {
    await this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw new BadRequestException("هزینه پیدا نشد.");
      if (expense.cashSessionId) {
        // The drawer movement belongs to a shift; once that shift is closed
        // the history is sealed and the expense can only be removed by an
        // offsetting entry, never by rewriting the past.
        const session = await tx.cashSession.findUnique({ where: { id: expense.cashSessionId } });
        if (session?.status === "OPEN") {
          await tx.cashMovement.create({ data: { type: "IN", amount: expense.amount, description: `لغو هزینهٔ ${expense.title}`, cashSessionId: session.id } });
        } else {
          throw new BadRequestException("این هزینه در نوبت کاری بسته‌شده ثبت شده و قابل حذف نیست.");
        }
      }
      await tx.expense.delete({ where: { id } });
      await tx.auditLog.create({ data: { actor: user.username, action: "DELETE_EXPENSE", entity: "Expense", entityId: id, detail: String(expense.amount) } });
    });
    return { ok: true };
  }
}

@Module({ controllers: [ExpensesController] })
export class ExpensesModule {}
