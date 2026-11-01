import { BadRequestException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { CashMovementDto, CloseCashDto, OpenCashDto } from "../dto";
import { CurrentUser, SessionUser } from "../auth";
import { PrismaService } from "../prisma.service";

@Controller("cash")
class CashController {
  constructor(private readonly prisma: PrismaService) {}

  private async snapshot(sessionId: string) {
    const session = await this.prisma.cashSession.findUnique({ where: { id: sessionId }, include: { user: { select: { displayName: true } }, movements: { orderBy: { createdAt: "desc" } }, sales: { where: { paymentMethod: "CASH" }, select: { total: true } } } });
    if (!session) return null;
    const manual = session.movements.reduce((total, movement) => total + (movement.type === "IN" ? movement.amount : -movement.amount), 0);
    const cashSalesAmount = session.sales.reduce((total, sale) => total + sale.total, 0);
    return { ...session, expectedCash: session.openingCash + manual + cashSalesAmount, cashSalesAmount, sales: undefined };
  }

  @Get("current") async current() {
    const session = await this.prisma.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
    return session ? this.snapshot(session.id) : null;
  }

  @Get("sessions") async sessions() {
    const list = await this.prisma.cashSession.findMany({ take: 30, include: { user: { select: { displayName: true } } }, orderBy: { openedAt: "desc" } });
    return Promise.all(list.map(async (session) => ({ ...session, ...(await this.snapshot(session.id)) })));
  }

  @Post("open") async open(@Body() dto: OpenCashDto, @CurrentUser() user: SessionUser) {
    const session = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
      if (existing) throw new BadRequestException("یک صندوق از قبل باز است.");
      const created = await tx.cashSession.create({ data: { openingCash: dto.openingCash, note: dto.note?.trim(), userId: user.id } });
      await tx.auditLog.create({ data: { actor: user.username, action: "OPEN_CASH", entity: "CashSession", entityId: created.id } });
      return created;
    });
    return this.snapshot(session.id);
  }

  @Post("movement") async movement(@Body() dto: CashMovementDto, @CurrentUser() user: SessionUser) {
    const sessionId = await this.prisma.$transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
      if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
      const movement = await tx.cashMovement.create({ data: { cashSessionId: session.id, type: dto.type, amount: dto.amount, description: dto.description.trim() } });
      await tx.auditLog.create({ data: { actor: user.username, action: `CASH_${dto.type}`, entity: "CashMovement", entityId: movement.id } });
      return session.id;
    });
    return this.snapshot(sessionId);
  }

  @Post("close") async close(@Body() dto: CloseCashDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
      if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
      const [cashIn, cashOut, cashSales] = await Promise.all([
        tx.cashMovement.aggregate({ where: { cashSessionId: session.id, type: "IN" }, _sum: { amount: true } }),
        tx.cashMovement.aggregate({ where: { cashSessionId: session.id, type: "OUT" }, _sum: { amount: true } }),
        tx.sale.aggregate({ where: { cashSessionId: session.id, paymentMethod: "CASH" }, _sum: { total: true } }),
      ]);
      const expected = session.openingCash + (cashIn._sum.amount || 0) - (cashOut._sum.amount || 0) + (cashSales._sum.total || 0);
      const updated = await tx.cashSession.update({ where: { id: session.id }, data: { status: "CLOSED", expectedCash: expected, countedCash: dto.countedCash, note: dto.note?.trim() || session.note, closedAt: new Date() } });
      await tx.auditLog.create({ data: { actor: user.username, action: "CLOSE_CASH", entity: "CashSession", entityId: session.id, detail: `expected=${expected}; counted=${dto.countedCash}` } });
      return { ...updated, difference: dto.countedCash - expected };
    });
  }
}

@Module({ controllers: [CashController] })
export class CashModule {}
