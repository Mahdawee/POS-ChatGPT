import { BadRequestException, Body, Controller, Get, Headers, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { SaleDto, SaleReturnDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { CheckoutService } from "../services/checkout";

@Controller("sales")
export class SalesController {
  constructor(private readonly prisma: PrismaService, private readonly checkoutService: CheckoutService) {}
  @Get() list(@Query("from") from?: string, @Query("to") to?: string, @Query("skip") skip?: string, @Query("take") take?: string) {
    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (from) where.createdAt = { ...where.createdAt, gte: new Date(from) };
    if (to) where.createdAt = { ...where.createdAt, lte: new Date(to.length === 10 ? `${to}T23:59:59.999` : to) };
    // Windowed listing ("load more"): each request is capped so a busy
    // register never pulls its whole history at once.
    const limit = Math.min(300, Math.max(1, Number(take) || 100));
    const offset = Math.max(0, Number(skip) || 0);
    return this.prisma.sale.findMany({ where, skip: offset, take: limit, include: { customer: true, user: { select: { displayName: true } }, items: true, returns: { select: { id: true, total: true } } }, orderBy: { createdAt: "desc" } });
  }

  /** آخرین فاکتور یک مشتری با اقلامش — برای «تکرار آخرین خرید» در صندوق. */
  @Get("customer/:customerId/last")
  async lastForCustomer(@Param("customerId") customerId: string) {
    const sale = await this.prisma.sale.findFirst({ where: { customerId }, orderBy: { createdAt: "desc" }, include: { items: true } });
    if (!sale) throw new NotFoundException("فروشی برای این مشتری ثبت نشده است.");
    return sale;
  }
  @Get(":id") async detail(@Param("id") id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: { customer: true, user: { select: { displayName: true } }, items: true, returns: { include: { user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } } } });
    if (!sale) throw new NotFoundException("فروش پیدا نشد.");
    return sale;
  }

  /** برگشت کالا از فروش (کامل یا جزئی) و بازگشت آن به انبار */
  @Post(":id/return")
  async returnSale(@Param("id") id: string, @Body() dto: SaleReturnDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id }, include: { items: true, returns: { include: { items: true } } } });
      if (!sale) throw new NotFoundException("فروش پیدا نشد.");
      const requested = new Map<string, number>();
      for (const line of dto.items) requested.set(line.productId, (requested.get(line.productId) || 0) + line.quantity);
      const returned = new Map<string, number>();
      for (const item of sale.returns.flatMap((record) => record.items)) returned.set(item.productId, (returned.get(item.productId) || 0) + item.quantity);
      let lineSum = 0;
      const lines: { productId: string; name: string; sku: string; quantity: number; unitPrice: number; unitCost: number; lineTotal: number }[] = [];
      for (const [productId, quantity] of requested) {
        const saleItem = sale.items.find((item) => item.productId === productId);
        if (!saleItem) throw new BadRequestException("این کالا در فاکتور اصلی وجود ندارد.");
        const already = returned.get(productId) || 0;
        if (already + quantity > saleItem.quantity) throw new BadRequestException(`بیشتر از مقدار فاکتور نمی‌توان برگشت داد. قابل برگشت: ${saleItem.quantity - already}`);
        const lineTotal = Math.round(saleItem.unitPrice * quantity);
        if (!Number.isSafeInteger(lineSum + lineTotal)) throw new BadRequestException("مبلغ برگشتی از سقف مجاز بیشتر است.");
        lineSum += lineTotal;
        lines.push({ productId, name: saleItem.name, sku: saleItem.sku, quantity, unitPrice: saleItem.unitPrice, unitCost: saleItem.unitCost, lineTotal });
      }
      // What the customer actually settled at checkout (cash + mobile; a
      // legacy overpaid cash sale carries only its total as cashPart).
      const paidPart = sale.cashPart + sale.mobilePart;
      const alreadyRefunded = sale.returns.reduce((sum, record) => sum + record.total, 0);
      const alreadyRelieved = sale.returns.reduce((sum, record) => sum + record.creditRelief, 0);
      const alreadyCashRefunded = sale.returns.reduce((sum, record) => sum + record.cashAmount, 0);
      // Returning every item of the invoice refunds the final paid amount
      // (i.e. the sale total after discount); partial returns refund the
      // undiscounted line prices — but never more than what was actually
      // paid, so a discounted invoice cannot be refunded above its collection.
      const fullReturn = sale.items.every((item) => (returned.get(item.productId) || 0) + (requested.get(item.productId) || 0) >= item.quantity);
      let total = fullReturn ? Math.min(sale.total, paidPart) : lineSum;
      total = Math.min(total, Math.max(0, paidPart - alreadyRefunded));
      // Goods bought on credit stop being a debt the moment they come back:
      // a full return clears whatever credit is still open, a partial return
      // relieves the (undiscounted) value of the returned goods.
      const reliefLeft = Math.max(0, sale.creditPart - alreadyRelieved);
      const creditRelief = sale.creditPart > 0 ? Math.min(fullReturn ? reliefLeft : lineSum, reliefLeft) : 0;
      // Only the cash portion of the refund may leave the drawer.
      const cashLeft = Math.max(0, sale.cashPart - alreadyCashRefunded);
      const cashAmount = Math.min(total, cashLeft);
      const products = await tx.product.findMany({ where: { id: { in: lines.map((line) => line.productId) } } });
      const productMap = new Map(products.map((product) => [product.id, product]));
      const returnNo = `RET-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const record = await tx.saleReturn.create({
        data: { returnNo, saleId: sale.id, total, creditRelief, cashAmount, note: dto.note?.trim(), userId: user.id, items: { create: lines } },
        include: { items: true },
      });
      for (const line of lines) {
        const product = productMap.get(line.productId);
        if (!product) continue; // product row vanished; keep the financial record
        await tx.product.update({ where: { id: line.productId }, data: { stock: { increment: line.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: line.productId, type: "SALE_RETURN", quantity: line.quantity, stockAfter: product.stock + line.quantity, reference: returnNo, note: "برگشت از فروش" } });
      }
      // Cash refunds leave the register when a shift is still open; refunds
      // on closed shifts (or non-cash sales) stay bookkeeping-only.
      if (cashAmount > 0) {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (session) await tx.cashMovement.create({ data: { type: "OUT", amount: cashAmount, description: `برگشت فاکتور ${sale.receiptNo}`, cashSessionId: session.id } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "SALE_RETURN", entity: "Sale", entityId: sale.id, detail: `${returnNo} / ${total}` } });
      return record;
    });
  }

  @Post()
  checkout(@Body() dto: SaleDto, @CurrentUser() user: SessionUser, @Headers("idempotency-key") requestKey?: string) {
    // Keyed sales (offline queue retries) return the original receipt.
    return this.checkoutService.checkout(dto, user, requestKey?.slice(0, 100));
  }
}

@Module({ controllers: [SalesController], providers: [CheckoutService] })
export class SalesModule {}
