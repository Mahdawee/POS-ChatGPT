import { BadRequestException, Body, Controller, Get, Headers, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { SaleDto, SaleReturnDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("sales")
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list(@Query("from") from?: string, @Query("to") to?: string) {
    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (from) where.createdAt = { ...where.createdAt, gte: new Date(from) };
    if (to) where.createdAt = { ...where.createdAt, lte: new Date(to.length === 10 ? `${to}T23:59:59.999` : to) };
    return this.prisma.sale.findMany({ where, take: 500, include: { customer: true, user: { select: { displayName: true } }, items: true, returns: { select: { id: true, total: true } } }, orderBy: { createdAt: "desc" } });
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
      let total = 0;
      const lines: { productId: string; name: string; sku: string; quantity: number; unitPrice: number; unitCost: number; lineTotal: number }[] = [];
      for (const [productId, quantity] of requested) {
        const saleItem = sale.items.find((item) => item.productId === productId);
        if (!saleItem) throw new BadRequestException("این کالا در فاکتور اصلی وجود ندارد.");
        const already = returned.get(productId) || 0;
        if (already + quantity > saleItem.quantity) throw new BadRequestException(`بیشتر از مقدار فاکتور نمی‌توان برگشت داد. قابل برگشت: ${saleItem.quantity - already}`);
        const lineTotal = saleItem.unitPrice * quantity;
        if (!Number.isSafeInteger(total + lineTotal)) throw new BadRequestException("مبلغ برگشتی از سقف مجاز بیشتر است.");
        total += lineTotal;
        lines.push({ productId, name: saleItem.name, sku: saleItem.sku, quantity, unitPrice: saleItem.unitPrice, unitCost: saleItem.unitCost, lineTotal });
      }
      // Returning every item of the invoice refunds the final paid amount
      // (i.e. the sale total after discount); partial returns refund the
      // undiscounted line prices.
      const fullReturn = sale.items.every((item) => (returned.get(item.productId) || 0) + (requested.get(item.productId) || 0) >= item.quantity);
      if (fullReturn) total = sale.total;
      const products = await tx.product.findMany({ where: { id: { in: lines.map((line) => line.productId) } } });
      const productMap = new Map(products.map((product) => [product.id, product]));
      const returnNo = `RET-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const record = await tx.saleReturn.create({
        data: { returnNo, saleId: sale.id, total, note: dto.note?.trim(), userId: user.id, items: { create: lines } },
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
      if (sale.paymentMethod === "CASH") {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (session) await tx.cashMovement.create({ data: { type: "OUT", amount: total, description: `برگشت فاکتور ${sale.receiptNo}`, cashSessionId: session.id } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "SALE_RETURN", entity: "Sale", entityId: sale.id, detail: `${returnNo} / ${total}` } });
      return record;
    });
  }

  @Post()
  async checkout(@Body() dto: SaleDto, @CurrentUser() user: SessionUser, @Headers("idempotency-key") requestKey?: string) {
    const idempotencyKey = requestKey?.slice(0, 100);
    if (idempotencyKey) {
      const previous = await this.prisma.sale.findUnique({ where: { idempotencyKey }, include: { items: true, customer: true } });
      if (previous) return previous;
    }
    const quantities = new Map<string, number>();
    for (const line of dto.items) quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
    const lines = [...quantities.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      let subtotal = 0;
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        if (product.stock < quantity) throw new BadRequestException(`موجودی ${product.name} کافی نیست. موجودی فعلی: ${product.stock}`);
        const lineTotal = product.price * quantity;
        if (!Number.isSafeInteger(lineTotal) || lineTotal > 2147483647) throw new BadRequestException("مبلغ یک قلم از سقف مجاز بیشتر است.");
        subtotal += lineTotal;
        if (subtotal > 2147483647) throw new BadRequestException("جمع فاکتور از سقف مجاز بیشتر است.");
      }
      const discount = dto.discount || 0;
      if (discount > subtotal) throw new BadRequestException("تخفیف نمی‌تواند از مبلغ فروش بیشتر باشد.");
      const total = subtotal - discount;
      const amountPaid = dto.amountPaid ?? (dto.paymentMethod === "CREDIT" ? 0 : total);
      if (dto.paymentMethod === "CASH" && amountPaid < total) throw new BadRequestException("مبلغ نقدی دریافتی کمتر از جمع فاکتور است.");
      if (dto.paymentMethod === "MOBILE" && amountPaid < total) throw new BadRequestException("پرداخت موبایلی باید کامل باشد.");
      if (dto.paymentMethod === "CREDIT" && amountPaid > total) throw new BadRequestException("مبلغ پرداختی نمی‌تواند از جمع فاکتور بیشتر باشد.");
      if (dto.paymentMethod === "CREDIT" && !dto.customerId) throw new BadRequestException("برای ثبت فروش نسیه، مشتری را انتخاب کنید.");
      if (dto.customerId && !(await tx.customer.findUnique({ where: { id: dto.customerId } }))) throw new BadRequestException("مشتری پیدا نشد.");
      let cashSessionId: string | undefined;
      if (dto.paymentMethod === "CASH") {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (!session) throw new BadRequestException("صندوق بسته است. ابتدا صندوق را باز کنید.");
        cashSessionId = session.id;
      }
      const receiptNo = `POS-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const sale = await tx.sale.create({
        data: {
          receiptNo, idempotencyKey, subtotal, discount, total, amountPaid,
          change: dto.paymentMethod === "CASH" ? amountPaid - total : 0,
          paymentMethod: dto.paymentMethod, note: dto.note?.trim(), customerId: dto.customerId || null,
          userId: user.id, cashSessionId,
          items: { create: lines.map(([productId, quantity]) => { const product = productMap.get(productId)!; return { productId, name: product.name, sku: product.sku, quantity, unitPrice: product.price, unitCost: product.cost, lineTotal: product.price * quantity }; }) },
        }, include: { items: true, customer: true },
      });
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        const stockAfter = product.stock - quantity;
        await tx.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } } });
        await tx.inventoryMovement.create({ data: { productId, type: "SALE", quantity: -quantity, stockAfter, reference: receiptNo } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CHECKOUT", entity: "Sale", entityId: sale.id, detail: `${receiptNo} / ${total}` } });
      return sale;
    });
  }
}

@Module({ controllers: [SalesController] })
export class SalesModule {}
