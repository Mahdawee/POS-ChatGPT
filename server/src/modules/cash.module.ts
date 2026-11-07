import { BadRequestException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { CashMovementDto, CloseCashDto, OpenCashDto } from "../dto";
import { CurrentUser, SessionUser } from "../auth";
import { createBackup, pruneAutoBackups } from "../backup";
import { PrismaService } from "../prisma.service";

@Controller("cash")
export class CashController {
  constructor(private readonly prisma: PrismaService) {}

  private async snapshot(sessionId: string) {
    const session = await this.prisma.cashSession.findUnique({ where: { id: sessionId }, include: { user: { select: { displayName: true } }, movements: { orderBy: { createdAt: "desc" } }, sales: { select: { cashPart: true } } } });
    if (!session) return null;
    const manual = session.movements.reduce((total, movement) => total + (movement.type === "IN" ? movement.amount : -movement.amount), 0);
    // Mixed payments contribute their cash part; a session is linked to a
    // sale exactly when that part is non-zero.
    const cashSalesAmount = session.sales.reduce((total, sale) => total + sale.cashPart, 0);
    // A CLOSED shift is history: its expected cash was computed and stored at
    // the moment of closing, and that number must never drift afterwards. A
    // sale voided (or a refund issued) AFTER the drawer closed posts no
    // movement to it, so re-deriving the sum today would contradict the
    // money that was actually counted that night.
    if (session.status === "CLOSED") return { ...session, cashSalesAmount, sales: undefined };
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
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
      if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
      const [cashIn, cashOut, partsAgg, returnsAgg, invoiceCount] = await Promise.all([
        tx.cashMovement.aggregate({ where: { cashSessionId: session.id, type: "IN" }, _sum: { amount: true } }),
        tx.cashMovement.aggregate({ where: { cashSessionId: session.id, type: "OUT" }, _sum: { amount: true } }),
        tx.sale.aggregate({ _sum: { cashPart: true, mobilePart: true, creditPart: true, walletPart: true }, where: { cashSessionId: session.id } }),
        tx.saleReturn.aggregate({ _sum: { total: true, creditRelief: true, cashAmount: true, walletRefund: true }, where: { sale: { cashSessionId: session.id } } }),
        tx.sale.count({ where: { cashSessionId: session.id } }),
      ]);
      const expected = session.openingCash + (cashIn._sum.amount || 0) - (cashOut._sum.amount || 0) + (partsAgg._sum.cashPart || 0);
      // expectedCash is stored as a 32-bit integer. A mistyped entry (e.g. a
      // manual "IN" movement with too many zeros) can push the sum past that
      // limit, and the overflowing update used to fail with Prisma P2023 —
      // which rolled the transaction back and left the shift PERMANENTLY
      // unclosable ("internal server error" on every attempt). The stored
      // value is clamped instead so the shift can always be closed; the Z
      // report below still carries the true computed number.
      const storedExpected = Math.max(-2147483648, Math.min(2147483647, Math.round(expected)));
      const updated = await tx.cashSession.update({ where: { id: session.id }, data: { status: "CLOSED", expectedCash: storedExpected, countedCash: dto.countedCash, note: dto.note?.trim() || session.note, closedAt: new Date() } });
      await tx.auditLog.create({ data: { actor: user.username, action: "CLOSE_CASH", entity: "CashSession", entityId: session.id, detail: `expected=${expected}; counted=${dto.countedCash}` } });
      // End-of-shift (Z) report payload: everything the printed slip needs.
      // Mixed payments are split across their parts, so the three buckets
      // always add up to the shift's invoiced total.
      const z = {
        sessionId: session.id,
        cashier: user.displayName,
        openedAt: session.openedAt,
        closedAt: updated.closedAt,
        openingCash: session.openingCash,
        cashIn: cashIn._sum.amount || 0,
        cashOut: cashOut._sum.amount || 0,
        cashSales: partsAgg._sum.cashPart || 0,
        mobileSales: partsAgg._sum.mobilePart || 0,
        creditSales: partsAgg._sum.creditPart || 0,
        walletSales: partsAgg._sum.walletPart || 0,
        invoiceCount,
        returnsTotal: (returnsAgg._sum.total || 0) + (returnsAgg._sum.creditRelief || 0),
        // Refunds that went back over mobile money: total minus the parts
        // that left the drawer or returned to the wallet. Tracked so the
        // settlement stays visible instead of vanishing from the books.
        mobileRefunds: Math.max(0, (returnsAgg._sum.total || 0) - (returnsAgg._sum.cashAmount || 0) - (returnsAgg._sum.walletRefund || 0)),
        expected,
        counted: dto.countedCash,
        difference: dto.countedCash - expected,
      };
      return { ...updated, difference: z.difference, z };
    });
    // Automatic safety snapshot whenever a shift is closed. A backup failure
    // must never invalidate the already-committed close, so it is best effort.
    try {
      const path = await createBackup(this.prisma, "auto");
      // Prune the folder the auto backup was actually written to (a custom
      // backupDir from Settings would otherwise grow without bound).
      const customDir = (await this.prisma.setting.findUnique({ where: { key: "backupDir" } }))?.value;
      pruneAutoBackups(10, customDir);
      await this.prisma.auditLog.create({ data: { actor: user.username, action: "CREATE_BACKUP", entity: "Database", detail: path } });
    } catch (error) {
      await this.prisma.auditLog.create({ data: { actor: user.username, action: "BACKUP_FAILED", entity: "Database", detail: String(error) } }).catch(() => undefined);
    }
    return result;
  }
}

@Module({ controllers: [CashController] })
export class CashModule {}
