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
      const serialsByProduct = new Map<string, string[]>();
      for (const line of dto.items) {
        requested.set(line.productId, (requested.get(line.productId) || 0) + line.quantity);
        if (line.serials?.length) serialsByProduct.set(line.productId, (serialsByProduct.get(line.productId) || []).concat(line.serials));
      }
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
      // What the customer actually settled at checkout (cash + mobile + the
      // prepaid wallet part; a legacy overpaid cash sale carries only its
      // total as cashPart). Without walletPart here, WALLET sales would
      // compute a zero refund ceiling and return nothing.
      const paidPart = sale.cashPart + sale.mobilePart + sale.walletPart;
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
      // The wallet portion goes back to the prepaid balance (no drawer move).
      const alreadyWalletRefunded = sale.returns.reduce((sum, record) => sum + record.walletRefund, 0);
      const walletLeft = Math.max(0, sale.walletPart - alreadyWalletRefunded);
      const walletRefund = Math.min(total - cashAmount, walletLeft);
      const products = await tx.product.findMany({ where: { id: { in: lines.map((line) => line.productId) } } });
      const productMap = new Map(products.map((product) => [product.id, product]));
      // Serialized goods — and kits carrying serialized components: the exact
      // units coming back must be named, or the serial list starts lying.
      const saleItemIds = new Set(sale.items.map((item) => item.id));
      for (const line of lines) {
        const product = productMap.get(line.productId);
        if (!product) continue;
        const serials = (serialsByProduct.get(line.productId) || []).map((value) => value.trim()).filter(Boolean);
        if (product.isSerialized) {
          if (!serials.length || serials.length !== Math.round(line.quantity)) throw new BadRequestException(`برای برگشت «${line.name}» شمارهٔ سریال هر دستگاه را وارد کنید (${Math.round(line.quantity)} عدد).`);
          if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در برگشت «${line.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
          const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
          const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
          for (const serial of serials) {
            const unit = unitMap.get(serial);
            if (!unit || !unit.saleItemId || !saleItemIds.has(unit.saleItemId)) throw new BadRequestException(`سریال ${serial} در فاکتور اصلی نیست.`);
            if (unit.status !== "SOLD") throw new BadRequestException(`سریال ${serial} قبلاً برگشت داده شده است.`);
          }
        } else if (product.isBundle) {
          // A returned kit brings its serialized components home: their units
          // were SOLD against this invoice's bundle line and must flip back,
          // otherwise the device sits on the shelf as unsellable forever.
          const rows = await tx.bundleComponent.findMany({ where: { bundleId: line.productId }, include: { component: true } });
          const serializedParts = rows.filter((row) => row.component.isSerialized).map((row) => ({ id: row.component.id, name: row.component.name, quantity: row.quantity * line.quantity }));
          if (!serializedParts.length) continue;
          const needed = serializedParts.reduce((sum, part) => sum + part.quantity, 0);
          if (!serials.length) throw new BadRequestException(`برای برگشت «${line.name}» شمارهٔ سریال/IMEI اجزای سریال‌دار هر بسته را وارد کنید (${needed} عدد).`);
          if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در برگشت «${line.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
          const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
          const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
          const perComponent = new Map<string, number>();
          for (const serial of serials) {
            const unit = unitMap.get(serial);
            const part = unit ? serializedParts.find((row) => row.id === unit.productId) : undefined;
            if (!unit || !part) throw new BadRequestException(`سریال ${serial} برای اجزای بستهٔ «${line.name}» ثبت نشده است.`);
            if (!unit.saleItemId || !saleItemIds.has(unit.saleItemId)) throw new BadRequestException(`سریال ${serial} در فاکتور اصلی نیست.`);
            if (unit.status !== "SOLD") throw new BadRequestException(`سریال ${serial} قبلاً برگشت داده شده است.`);
            perComponent.set(unit.productId, (perComponent.get(unit.productId) || 0) + 1);
          }
          for (const part of serializedParts) {
            const have = perComponent.get(part.id) || 0;
            if (have !== part.quantity) throw new BadRequestException(`برای جزء «${part.name}» از بستهٔ «${line.name}» دقیقاً ${part.quantity} سریال لازم است (${have} عدد وارد شد).`);
          }
        }
      }
      const returnNo = `RET-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      // Restock with a running stock map: a component shared by several
      // returned bundles must chain its increments so every movement row's
      // stockAfter stays truthful.
      const runningStock = new Map<string, number>();
      const restock = async (product: { id: string; stock: number }, quantity: number, note: string): Promise<void> => {
        const before = runningStock.has(product.id) ? runningStock.get(product.id)! : product.stock;
        const stockAfter = before + quantity;
        runningStock.set(product.id, stockAfter);
        await tx.product.update({ where: { id: product.id }, data: { stock: { increment: quantity } } });
        await tx.inventoryMovement.create({ data: { productId: product.id, type: "SALE_RETURN", quantity, stockAfter, reference: returnNo, note } });
      };
      const record = await tx.saleReturn.create({
        data: { returnNo, saleId: sale.id, total, creditRelief, cashAmount, walletRefund, note: dto.note?.trim(), userId: user.id, items: { create: lines } },
        include: { items: true },
      });
      for (const line of lines) {
        const product = productMap.get(line.productId);
        if (!product) continue; // product row vanished; keep the financial record
        // Bundles never carried their own stock: the components come back.
        if (product.isBundle) {
          const rows = await tx.bundleComponent.findMany({ where: { bundleId: line.productId }, include: { component: true } });
          for (const row of rows) await restock(row.component, row.quantity * line.quantity, `برگشت جزء بستهٔ ${product.name}`);
        } else {
          await restock(product, line.quantity, "برگشت از فروش");
        }
        // Tracked units re-enter sellable stock (kit lines carry the
        // serials of their serialized components on the bundle line).
        for (const serial of (serialsByProduct.get(line.productId) || []).map((value) => value.trim()).filter(Boolean)) {
          await tx.serialUnit.update({ where: { serial }, data: { status: "IN_STOCK", saleItemId: null, updatedAt: new Date(), note: `برگشت ${returnNo}` } });
        }
      }
      // Wallet refunds land back on the prepaid balance immediately.
      if (walletRefund > 0 && sale.customerId) {
        await tx.customer.update({ where: { id: sale.customerId }, data: { walletBalance: { increment: walletRefund } } });
        await tx.customerWalletTxn.create({ data: { customerId: sale.customerId, type: "REFUND", amount: walletRefund, note: `برگشت فاکتور ${sale.receiptNo}`, saleId: sale.id, userId: user.id } });
      }
      // Cash refunds leave the register when a shift is still open; refunds
      // on closed shifts (or non-cash sales) stay bookkeeping-only. The OUT
      // movement belongs to the register the invoice was rung up on when that
      // shift is still open — only otherwise does the currently open one
      // take it, so a multi-register shop's Z-reports stay attributable.
      if (cashAmount > 0) {
        const original = sale.cashSessionId ? await tx.cashSession.findUnique({ where: { id: sale.cashSessionId } }) : null;
        const session = original?.status === "OPEN" ? original : await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (session) await tx.cashMovement.create({ data: { type: "OUT", amount: cashAmount, description: `برگشت فاکتور ${sale.receiptNo}`, cashSessionId: session.id } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "SALE_RETURN", entity: "Sale", entityId: sale.id, detail: `${returnNo} / ${total}` } });
      return record;
    });
  }

  /**
   * متن سادهٔ فاکتور برای ارسال دیجیتال (پیام‌رسان/ایمیل/SMS): بدون وابستگی
   * به چاپگر، قابل کپی و خواندن روی هر گوشی. وضعیت اقلام برگشتی هم لحاظ
   * می‌شود تا مشتری نسخهٔ صادقانه‌ای بگیرد.
   */
  @Get(":id/receipt")
  async receiptText(@Param("id") id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: { items: true, customer: true, user: { select: { displayName: true } }, returns: { include: { items: true } } } });
    if (!sale) throw new NotFoundException("فروش پیدا نشد.");
    const settings = await this.prisma.setting.findMany({ where: { key: { in: ["shopName", "receiptFooter"] } } });
    const shopName = settings.find((row) => row.key === "shopName")?.value || "فروشگاه";
    const footer = settings.find((row) => row.key === "receiptFooter")?.value || "";
    const returned = new Map<string, number>();
    for (const record of sale.returns) for (const item of record.items) returned.set(item.productId, (returned.get(item.productId) || 0) + item.quantity);
    const lines = [
      shopName,
      `فاکتور ${sale.invoiceNo || sale.receiptNo}`,
      `تاریخ: ${new Date(sale.createdAt).toLocaleString("fa-AF")}`,
      sale.customer ? `مشتری: ${sale.customer.name}${sale.customer.phone ? ` (${sale.customer.phone})` : ""}` : "مشتری: نقدی",
      "────────────────────",
      ...sale.items.map((item) => {
        const back = returned.get(item.productId) || 0;
        const note = back > 0 ? ` (برگشتی: ${back})` : "";
        return `${item.name} × ${item.quantity} = ${item.lineTotal}${note}`;
      }),
      "────────────────────",
      `جمع: ${sale.subtotal}`,
      sale.discount > 0 ? `تخفیف: ${sale.discount}` : null,
      `پرداختنی: ${sale.total}`,
      sale.cashPart > 0 ? `نقدی: ${sale.cashPart}` : null,
      sale.mobilePart > 0 ? `موبایل: ${sale.mobilePart}` : null,
      sale.walletPart > 0 ? `کیف پول: ${sale.walletPart}` : null,
      sale.creditPart > 0 ? `نسیه: ${sale.creditPart}` : null,
      `صندوقدار: ${sale.user.displayName}`,
      footer,
    ].filter((line): line is string => line !== null);
    return { text: lines.join("\n"), sale: { id: sale.id, invoiceNo: sale.invoiceNo, receiptNo: sale.receiptNo, total: sale.total, customerPhone: sale.customer?.phone ?? null } };
  }

  @Post()
  checkout(@Body() dto: SaleDto, @CurrentUser() user: SessionUser, @Headers("idempotency-key") requestKey?: string) {
    // Keyed sales (offline queue retries) return the original receipt.
    return this.checkoutService.checkout(dto, user, requestKey?.slice(0, 100));
  }
}

@Module({ controllers: [SalesController], providers: [CheckoutService] })
export class SalesModule {}
