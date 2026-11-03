import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { CreateOrderDto, DeliverOrderDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { CheckoutService } from "../services/checkout";

/**
 * سفارش/رزرو مشتری (pre-order): اقلام سفارش از موجودی «آزاد» رزرو
 * می‌شوند (موجودی آزاد = موجودی − رزروِ سفارش‌های باز)، پس فروش حضوری
 * ناخواسته جنسِ مشتری دیگر را نمی‌فروشد. تحویل، فروش واقعی می‌سازد و
 * به همان اندازه رزرو را آزاد می‌کند؛ قیمت نهایی در لحظهٔ تحویل و
 * توسط همان خط‌لولهٔ صندوق (صادق و سمت سرور) محاسبه می‌شود.
 */
@Controller("orders")
export class OrdersController {
  constructor(private readonly prisma: PrismaService, private readonly checkout: CheckoutService) {}

  @Post()
  async create(@Body() dto: CreateOrderDto, @CurrentUser() user: SessionUser) {
    const quantities = new Map<string, number>();
    for (const line of dto.items) quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
    return this.prisma.$transaction(async (tx) => {
      if (dto.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
        if (!customer || !customer.isActive) throw new BadRequestException("مشتری پیدا نشد.");
      }
      const products = await tx.product.findMany({ where: { id: { in: [...quantities.keys()] }, isActive: true } });
      if (products.length !== quantities.size) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      for (const product of products) {
        const quantity = quantities.get(product.id)!;
        if (product.isBundle) throw new BadRequestException(`«${product.name}» بسته است و فعلاً در سفارش رزرو نمی‌شود؛ اجزای آن را جدا سفارش دهید.`);
        const available = product.stock - product.reserved;
        if (available < quantity) throw new BadRequestException(`موجودی آزاد ${product.name} کافی نیست. موجودی آزاد: ${available}`);
      }
      const orderNo = `ORD-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const order = await tx.customerOrder.create({
        data: {
          orderNo, customerId: dto.customerId || null, note: dto.note?.trim(), userId: user.id,
          lines: {
            create: [...quantities.entries()].map(([productId, quantity]) => {
              const product = products.find((row) => row.id === productId)!;
              return { productId, name: product.name, sku: product.sku, quantity, unitPrice: product.price };
            }),
          },
        },
        include: { lines: true, customer: { select: { id: true, name: true, phone: true } } },
      });
      for (const [productId, quantity] of quantities) {
        await tx.product.update({ where: { id: productId }, data: { reserved: { increment: quantity } } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_ORDER", entity: "CustomerOrder", entityId: order.id, detail: `${orderNo} / ${order.lines.length} قلم` } });
      return order;
    });
  }

  @Get()
  list(@Query("status") status?: string) {
    const where: { status?: string } = {};
    if (status === "OPEN" || status === "FULFILLED" || status === "CANCELLED") where.status = status;
    return this.prisma.customerOrder.findMany({ where, include: { lines: true, customer: { select: { id: true, name: true, phone: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const order = await this.prisma.customerOrder.findUnique({ where: { id }, include: { lines: true, customer: { select: { id: true, name: true, phone: true } } } });
    if (!order) throw new NotFoundException("سفارش پیدا نشد.");
    return order;
  }

  /** تحویل (کامل یا جزئی): رزرو آزاد می‌شود و فروش واقعی ثبت می‌شود. */
  @Post(":id/deliver")
  async deliver(@Param("id") id: string, @Body() dto: DeliverOrderDto, @CurrentUser() user: SessionUser) {
    const order = await this.prisma.customerOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!order) throw new NotFoundException("سفارش پیدا نشد.");
    if (order.status !== "OPEN") throw new BadRequestException("این سفارش بسته شده است.");
    const requested = new Map(order.lines.map((line) => [line.id, 0]));
    const serialsByLine = new Map<string, string[]>();
    for (const delivery of dto.deliveries) {
      if (!requested.has(delivery.lineId)) throw new BadRequestException("یکی از اقلام تحویل در این سفارش نیست.");
      requested.set(delivery.lineId, (requested.get(delivery.lineId) || 0) + delivery.quantity);
      if (delivery.serials?.length) serialsByLine.set(delivery.lineId, (serialsByLine.get(delivery.lineId) || []).concat(delivery.serials));
    }
    for (const line of order.lines) {
      const deliverQty = requested.get(line.id) || 0;
      if (deliverQty > line.quantity - line.deliveredQty) throw new BadRequestException(`بیشتر از مقدار سفارش نمی‌توان تحویل کرد. قابل تحویل «${line.name}»: ${line.quantity - line.deliveredQty}`);
    }
    const releasing: Array<{ productId: string; quantity: number }> = [];
    for (const line of order.lines) {
      const deliverQty = requested.get(line.id) || 0;
      if (deliverQty > 0) releasing.push({ productId: line.productId, quantity: deliverQty });
    }
    // ONE transaction: release the reservation, run the shared checkout
    // pipeline and record the delivery together. Any failure (funds, stock,
    // license, crash) rolls the whole delivery back — a compensating-write
    // dance could never cover the gap between the sale and the order update,
    // which left an order deliverable twice (double charge).
    return this.prisma.$transaction(async (tx) => {
      const fresh = await tx.customerOrder.findUnique({ where: { id: order.id }, select: { status: true } });
      if (fresh?.status !== "OPEN") throw new BadRequestException("این سفارش بسته شده است.");
      for (const item of releasing) {
        await tx.product.update({ where: { id: item.productId }, data: { reserved: { decrement: item.quantity } } });
      }
      const sale = await this.checkout.checkoutInTx(
        tx,
        {
          items: releasing.map((item) => {
            const line = order.lines.find((row) => row.productId === item.productId)!;
            return { productId: item.productId, quantity: item.quantity, discount: 0, serials: serialsByLine.get(line.id) };
          }),
          paymentMethod: dto.paymentMethod,
          amountPaid: dto.amountPaid,
          splitCash: dto.splitCash,
          splitMobile: dto.splitMobile,
          overrideCreditLimit: dto.overrideCreditLimit,
          customerId: order.customerId || undefined,
          note: dto.note?.trim() || `تحویل سفارش ${order.orderNo}`,
        },
        user,
      );
      for (const line of order.lines) {
        const deliverQty = requested.get(line.id) || 0;
        if (deliverQty > 0) await tx.customerOrderLine.update({ where: { id: line.id }, data: { deliveredQty: { increment: deliverQty } } });
      }
      const refreshed = await tx.customerOrder.findUnique({ where: { id: order.id }, include: { lines: true } });
      const complete = refreshed?.lines.every((line) => line.deliveredQty >= line.quantity) ?? false;
      if (complete) await tx.customerOrder.update({ where: { id: order.id }, data: { status: "FULFILLED" } });
      await tx.auditLog.create({ data: { actor: user.username, action: "DELIVER_ORDER", entity: "CustomerOrder", entityId: order.id, detail: `${order.orderNo} / ${releasing.length} قلم` } });
      return sale;
    });
  }

  /** لغو سفارش: رزروِ اقلام تحویل‌نشده آزاد می‌شود. */
  @Post(":id/cancel")
  async cancel(@Param("id") id: string, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!order) throw new NotFoundException("سفارش پیدا نشد.");
      if (order.status !== "OPEN") throw new BadRequestException("این سفارش بسته شده است.");
      for (const line of order.lines) {
        const undelivered = line.quantity - line.deliveredQty;
        if (undelivered > 0) await tx.product.update({ where: { id: line.productId }, data: { reserved: { decrement: undelivered } } });
      }
      const updated = await tx.customerOrder.update({ where: { id }, data: { status: "CANCELLED" } });
      await tx.auditLog.create({ data: { actor: user.username, action: "CANCEL_ORDER", entity: "CustomerOrder", entityId: order.id, detail: order.orderNo } });
      return updated;
    });
  }
}

@Module({ controllers: [OrdersController], providers: [CheckoutService] })
export class OrdersModule {}
