import { BadRequestException, Body, Controller, Get, Headers, Module, NotFoundException, Param, Post } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { SaleDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("sales")
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.sale.findMany({ take: 100, include: { customer: true, user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } }); }
  @Get(":id") async detail(@Param("id") id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: { customer: true, user: { select: { displayName: true } }, items: true } });
    if (!sale) throw new NotFoundException("فروش پیدا نشد.");
    return sale;
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
          items: { create: lines.map(([productId, quantity]) => { const product = productMap.get(productId)!; return { productId, name: product.name, sku: product.sku, quantity, unitPrice: product.price, lineTotal: product.price * quantity }; }) },
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
