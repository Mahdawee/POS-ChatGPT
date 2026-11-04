import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Post, Query } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { InventoryAdjustmentDto, StockTransferDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("inventory")
export class InventoryController {
  constructor(private readonly prisma: PrismaService) {}
  @Get("movements")
  movements(@Query("take") take = "100") { return this.prisma.inventoryMovement.findMany({ take: Math.min(250, Math.max(1, Number(take) || 100)), include: { product: { select: { name: true, sku: true, unit: true } } }, orderBy: { createdAt: "desc" } }); }

  /** Live batch/lot quantities with their own expiry dates (FEFO list). */
  @Get("batches")
  batches(@Query("take") take = "100") {
    return this.prisma.productBatch.findMany({
      take: Math.min(300, Math.max(1, Number(take) || 100)),
      where: { remainingQty: { gt: 0 } },
      include: { product: { select: { name: true, sku: true, unit: true } } },
      orderBy: { expiryDate: "asc" },
    });
  }

  /** لیست دستگاه‌های سریال‌دار یک کالا (IMEI/سریال) با وضعیت هرکدام. */
  @Get("serials")
  async serials(@Query("productId") productId?: string, @Query("status") status?: string, @Query("q") q?: string, @Query("saleId") saleId?: string) {
    const where: { productId?: string; status?: string; serial?: { contains: string }; saleItemId?: { in: string[] } } = {};
    // saleId narrows the list to the units this invoice handed over (their
    // saleItemId points at one of its items) — the sale-return screen offers
    // exactly those for picking, status SOLD filtering out already-returned
    // ones.
    if (saleId) {
      const sale = await this.prisma.sale.findUnique({ where: { id: saleId }, select: { items: { select: { id: true } } } });
      if (!sale) throw new NotFoundException("فاکتور پیدا نشد.");
      where.saleItemId = { in: sale.items.map((item) => item.id) };
    }
    if (productId) where.productId = productId;
    if (status === "IN_STOCK" || status === "SOLD" || status === "RETURNED") where.status = status;
    const search = q?.trim();
    if (search) where.serial = { contains: search };
    return this.prisma.serialUnit.findMany({ where, include: { product: { select: { id: true, name: true, sku: true } } }, orderBy: { createdAt: "desc" }, take: 300 });
  }

  /**
   * پیشنهاد سفارش خرید: برای هر کالای فعال، سرعت فروش ۳۰ روز اخیر و
   * موجودی آزاد (قفسه + انبار پشتیبان − رزرو) را می‌سنجد و مقدار پیشنهادی
   * برای ۱۴ روز آینده را می‌دهد. کالاهای زیر نقطهٔ سفارش اولویت دارند.
   */
  @Get("reorder")
  async reorder() {
    const since = new Date(Date.now() - 30 * 86400000);
    const [products, soldRows, returnedRows, purchases] = await Promise.all([
      this.prisma.product.findMany({ where: { isActive: true, isBundle: false }, select: { id: true, name: true, sku: true, unit: true, stock: true, backstock: true, reserved: true, minStock: true, cost: true } }),
      this.prisma.saleItem.findMany({ where: { sale: { createdAt: { gte: since } } }, select: { productId: true, quantity: true } }),
      this.prisma.saleReturnItem.findMany({ where: { saleReturn: { createdAt: { gte: since } } }, select: { productId: true, quantity: true } }),
      this.prisma.purchaseItem.findMany({ orderBy: { purchase: { createdAt: "desc" } }, take: 2000, select: { productId: true, purchase: { select: { supplier: { select: { id: true, name: true, phone: true } } } } } }),
    ]);
    // Net velocity: goods sold and then returned did not really leave the
    // shop, so they must not inflate the reorder suggestion.
    const soldMap = new Map<string, number>();
    for (const row of soldRows) soldMap.set(row.productId, (soldMap.get(row.productId) || 0) + row.quantity);
    for (const row of returnedRows) soldMap.set(row.productId, (soldMap.get(row.productId) || 0) - row.quantity);
    const lastSupplier = new Map<string, { id: string; name: string; phone: string | null }>();
    for (const item of purchases) {
      if (!lastSupplier.has(item.productId) && item.purchase.supplier) {
        lastSupplier.set(item.productId, item.purchase.supplier);
      }
    }
    const rows = products.map((product) => {
      const sold = Math.max(0, soldMap.get(product.id) || 0); // returns can exceed in-window sales
      const velocity = sold / 30;
      const onHand = product.stock + product.backstock - product.reserved;
      const daysLeft = velocity > 0 ? onHand / velocity : null;
      const target = velocity * 14 + product.minStock;
      const suggested = Math.max(0, Math.ceil(target - onHand));
      return {
        productId: product.id, name: product.name, sku: product.sku, unit: product.unit,
        onHand, reserved: product.reserved, minStock: product.minStock,
        soldLast30: Math.round(sold * 1000) / 1000, velocityPerDay: Math.round(velocity * 1000) / 1000,
        daysLeft: daysLeft == null ? null : Math.round(daysLeft * 10) / 10,
        suggested, belowMin: onHand <= product.minStock,
        lastSupplier: lastSupplier.get(product.id) ?? null, estimatedCost: suggested * product.cost,
      };
    });
    // Only rows that need action: below the reorder point or a suggestion > 0.
    return rows.filter((row) => row.belowMin || row.suggested > 0).sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999)).slice(0, 100);
  }

  @Post("adjust")
  async adjust(@Body() dto: InventoryAdjustmentDto, @CurrentUser() user: SessionUser) {
    if (!dto.quantity) throw new BadRequestException("تعداد تعدیل نمی‌تواند صفر باشد.");
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: dto.productId } });
      if (!product || !product.isActive) throw new BadRequestException("کالا پیدا نشد.");
      const stock = product.stock + dto.quantity;
      if (stock < 0) throw new BadRequestException(`موجودی ${product.name} کافی نیست.`);
      await tx.product.update({ where: { id: product.id }, data: { stock } });
      const movement = await tx.inventoryMovement.create({ data: { productId: product.id, type: dto.quantity > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: dto.quantity, stockAfter: stock, note: dto.note?.trim() || "تعدیل دستی" } });
      await tx.auditLog.create({ data: { actor: user.username, action: "ADJUST_STOCK", entity: "Product", entityId: product.id, detail: String(dto.quantity) } });
      return { product: { ...product, stock }, movement };
    });
  }

  /** انتقال بین قفسهٔ فروش و انبار پشتیبان — جمع کل دست‌نخورده می‌ماند. */
  @Post("transfer")
  async transfer(@Body() dto: StockTransferDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: dto.productId } });
      if (!product || !product.isActive) throw new BadRequestException("کالا پیدا نشد.");
      if (dto.direction === "TO_BACKROOM") {
        // Reservations live on the shelf: moving promised units to the
        // backroom would strand the pre-order waiting for them.
        const free = product.stock - product.reserved;
        if (free < dto.quantity) throw new BadRequestException(`موجودی آزاد قفسهٔ فروش ${product.name} کافی نیست. موجودی آزاد: ${free} (رزرو سفارش: ${product.reserved})`);
        const stock = product.stock - dto.quantity;
        await tx.product.update({ where: { id: product.id }, data: { stock, backstock: { increment: dto.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_OUT", quantity: -dto.quantity, stockAfter: stock, note: "انتقال به انبار پشتیبان" } });
      } else {
        if (product.backstock < dto.quantity) throw new BadRequestException(`موجودی انبار پشتیبان ${product.name} کافی نیست. موجودی فعلی: ${product.backstock}`);
        const stock = product.stock + dto.quantity;
        await tx.product.update({ where: { id: product.id }, data: { stock, backstock: { decrement: dto.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: dto.quantity, stockAfter: stock, note: "انتقال از انبار پشتیبان به قفسهٔ فروش" } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "TRANSFER_STOCK", entity: "Product", entityId: product.id, detail: `${dto.direction} / ${dto.quantity}` } });
      return tx.product.findUnique({ where: { id: product.id } });
    });
  }
}

@Module({ controllers: [InventoryController] })
export class InventoryModule {}
