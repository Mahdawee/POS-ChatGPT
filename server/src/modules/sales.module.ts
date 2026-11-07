import { BadRequestException, Body, Controller, Get, Headers, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { SaleDto, SaleReturnDto, VoidDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { CheckoutService } from "../services/checkout";
import type { Prisma } from "@prisma/client";

@Controller("sales")
export class SalesController {
  constructor(private readonly prisma: PrismaService, private readonly checkoutService: CheckoutService) {}
  @Get() async list(@Query("from") from?: string, @Query("to") to?: string, @Query("skip") skip?: string, @Query("take") take?: string, @Query("method") method?: string, @Query("sort") sort?: string, @Query("dir") dir?: string, @Query("q") q?: string) {
    const where: Prisma.SaleWhereInput = {};
    // Unparsable date strings are ignored rather than crashing the query.
    const createdAt: Prisma.DateTimeFilter = {};
    // A date-only «from» means local midnight — same clock as «to» below. Parsing
    // it bare would jump to UTC and drop the 00:00–04:30 sales of that day.
    if (from && Number.isFinite(Date.parse(from))) createdAt.gte = new Date(from.length === 10 ? `${from}T00:00:00` : from);
    const toDay = to ? (to.length === 10 ? `${to}T23:59:59.999` : to) : "";
    if (toDay && Number.isFinite(Date.parse(toDay))) createdAt.lte = new Date(toDay);
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;
    // Payment-method filter for the register's history table.
    if (method === "CASH" || method === "MOBILE" || method === "CREDIT" || method === "WALLET") where.paymentMethod = method;
    // Server-side search (receipt/invoice number, customer or cashier name)
    // so it composes with pagination instead of only searching one page.
    const search = q?.trim();
    if (search) where.OR = [
      { receiptNo: { contains: search } }, { invoiceNo: { contains: search } },
      { customer: { name: { contains: search } } }, { user: { displayName: { contains: search } } },
    ];
    const limit = Math.min(300, Math.max(1, Number(take) || 100));
    const offset = Math.max(0, Number(skip) || 0);
    // Column sorting for the history table; unknown values fall back to the
    // default newest-first window.
    const direction = dir === "asc" ? "asc" as const : "desc" as const;
    const orderBy = sort === "total" ? { total: direction } : sort === "receiptNo" ? { receiptNo: direction } : sort === "customer" ? { customer: { name: direction } } : { createdAt: direction };
    // { list, total } so the client can render real page numbers.
    // History rows ship only what the table, exports and dialogs read from
    // the LIST row: the customer's name/phone, and per line just the
    // quantity (the «اقلام» column and exports count lines; full item rows
    // come from /sales/:id when a detail, return or share dialog opens).
    // On a ledger of thousands this roughly halves the page payload.
    const [list, total] = await Promise.all([
      this.prisma.sale.findMany({ where, skip: offset, take: limit, include: { customer: { select: { id: true, name: true, phone: true } }, user: { select: { displayName: true } }, items: { select: { quantity: true } }, returns: { select: { id: true, total: true } } }, orderBy }),
      this.prisma.sale.count({ where }),
    ]);
    return { list, total };
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
      // Net shelf usage of THIS invoice: what its SALE movements took minus
      // what earlier returns already put back. A kit's recipe may have been
      // edited after the sale, so returning TODAY'S recipe could restock a
      // component this invoice never deducted. Clamping every component to
      // the net usage keeps the shelf from silently inflating.
      const takenMoves = await tx.inventoryMovement.findMany({ where: { reference: sale.receiptNo, type: "SALE" }, select: { productId: true, quantity: true } });
      const taken = new Map<string, number>();
      for (const move of takenMoves) taken.set(move.productId, (taken.get(move.productId) || 0) + Math.abs(move.quantity));
      const earlierReturnNos = sale.returns.map((record) => record.returnNo).filter((value): value is string => Boolean(value));
      const putBackMoves = earlierReturnNos.length ? await tx.inventoryMovement.findMany({ where: { reference: { in: earlierReturnNos }, type: "SALE_RETURN" }, select: { productId: true, quantity: true } }) : [];
      const putBack = new Map<string, number>();
      for (const move of putBackMoves) putBack.set(move.productId, (putBack.get(move.productId) || 0) + move.quantity);
      const roomFor = (productId: string): number => Math.max(0, (taken.get(productId) || 0) - (putBack.get(productId) || 0));
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
          for (const row of rows) {
            const want = row.quantity * line.quantity;
            // Cap at the net usage when movements are on record; a kit whose
            // recipe grew after the sale must not stock more than it took.
            const allowed = takenMoves.length ? Math.min(want, roomFor(row.componentId)) : want;
            if (allowed > 0) await restock(row.component, allowed, `برگشت جزء بستهٔ ${product.name}`);
          }
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

  /**
   * ابطال فاکتور (void) — nothing is deleted: the sale row, its items and
   * every effect stay in the database; the void columns record when, why and
   * by whom. At void time the physical effects are reversed in ONE
   * transaction: shelf stock comes back (bundles restock their components),
   * handed-over serials return to sellable, wallet spending is refunded, and
   * the cash part is taken back out of the drawer IF that drawer is still
   * open (closed sessions are history and stay untouched). Reports, debt and
   * the dashboard exclude voided rows from then on.
   */
  @AdminOnly()
  @Post(":id/void")
  async voidSale(@Param("id") id: string, @Body() dto: VoidDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id }, include: { items: true, returns: { select: { id: true } } } });
      if (!sale) throw new NotFoundException("فروش پیدا نشد.");
      if (sale.voidedAt) throw new BadRequestException("این فاکتور قبلاً ابطال شده است.");
      if (sale.returns.length) throw new BadRequestException("فاکتوری که برگشت کالا دارد قابل ابطال نیست؛ نخست وضعیت برگشتی آن را بررسی کنید.");
      // An installment plan that already collected money must be settled by
      // hand first — reversing collected installments automatically would
      // rewrite payment history.
      const plans = await tx.installmentPlan.findMany({ where: { saleId: id } });
      if (plans.some((plan) => plan.paidAmount > 0)) throw new BadRequestException("برای این فاکتور قسط پرداخت‌شده وجود دارد؛ نخست اقساط را تسویه کنید.");

      // Shelf stock comes back. The exact quantities are replayed from THIS
      // invoice's own SALE movements (written at checkout, bundle components
      // included) instead of re-expanding the bundle's CURRENT recipe: the
      // shop may have edited a kit's components since the sale, and restocking
      // today's recipe would put back goods this invoice never took.
      const saleMoves = await tx.inventoryMovement.findMany({ where: { reference: sale.receiptNo, type: "SALE" }, select: { productId: true, quantity: true } });
      const restock = new Map<string, number>();
      if (saleMoves.length) {
        for (const move of saleMoves) restock.set(move.productId, (restock.get(move.productId) || 0) + Math.abs(move.quantity));
      } else {
        // Legacy sale rows written before movements existed (or by a foreign
        // write path): fall back to expanding items with the current recipe.
        const products = await tx.product.findMany({ where: { id: { in: [...new Set(sale.items.map((item) => item.productId))] } }, include: { bundleComponents: true } });
        const byId = new Map(products.map((product) => [product.id, product]));
        for (const item of sale.items) {
          const product = byId.get(item.productId);
          if (!product) continue;
          if (product.isBundle) {
            for (const part of product.bundleComponents) restock.set(part.componentId, (restock.get(part.componentId) || 0) + part.quantity * item.quantity);
          } else restock.set(product.id, (restock.get(product.id) || 0) + item.quantity);
        }
      }
      for (const [productId, quantity] of restock) {
        const product = await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity } }, select: { stock: true } });
        await tx.inventoryMovement.create({ data: { productId, type: "ADJUSTMENT_IN", quantity, stockAfter: product.stock, note: `ابطال فاکتور ${sale.receiptNo} — ${dto.reason}` } });
      }
      // Serial units handed over with this invoice become sellable again
      // (the row keeps its links — the trail is the audit).
      await tx.serialUnit.updateMany({ where: { saleItemId: { in: sale.items.map((item) => item.id) }, status: "SOLD" }, data: { status: "IN_STOCK" } });
      // Wallet spending is refunded to the customer's prepaid balance.
      if (sale.walletPart > 0 && sale.customerId) {
        await tx.customer.update({ where: { id: sale.customerId }, data: { walletBalance: { increment: sale.walletPart } } });
        await tx.customerWalletTxn.create({ data: { customerId: sale.customerId, type: "REFUND", amount: sale.walletPart, note: `ابطال فاکتور ${sale.receiptNo} — ${dto.reason}`, saleId: sale.id, userId: user.id } });
      }
      // یافتهٔ شکار باگ: ابطال فاکتور نسیِ بعداً تسویه‌شده، پرداخت‌های مشتری
      // را بستانکارِ معلق در دفتر می‌کرد (بدهی منفی، بدون هیچ راه برگشتی
      // برای پول). حالا اگر با حذف نسیِ همین فاکتور دفتر مشتری منفی شود،
      // همان‌اندازه — حداکثر به اندازهٔ نسیِ این فاکتور — به کیف پولش
      // برمی‌گردد و یک ردیف پرداختِ خنثی‌کننده ثبت می‌شود تا دفتر
      // (نسی − برگشت − پرداخت) دقیقاً صفر بماند و پول قابل خرج شود.
      if (sale.creditPart > 0 && sale.customerId) {
        const [otherCredit, returnsAgg, paidAgg] = await Promise.all([
          tx.sale.aggregate({ _sum: { creditPart: true }, where: { customerId: sale.customerId, voidedAt: null, id: { not: sale.id } } }),
          tx.saleReturn.aggregate({ _sum: { creditRelief: true }, where: { sale: { customerId: sale.customerId } } }),
          tx.customerPayment.aggregate({ _sum: { amount: true }, where: { customerId: sale.customerId } }),
        ]);
        const balanceAfter = (otherCredit._sum.creditPart || 0) - (returnsAgg._sum.creditRelief || 0) - (paidAgg._sum.amount || 0);
        const creditRefund = Math.min(sale.creditPart, Math.max(0, -balanceAfter));
        if (creditRefund > 0) {
          await tx.customer.update({ where: { id: sale.customerId }, data: { walletBalance: { increment: creditRefund } } });
          await tx.customerWalletTxn.create({ data: { customerId: sale.customerId, type: "REFUND", amount: creditRefund, note: `ابطال فاکتور نسی ${sale.receiptNo} — پرداخت شما به کیف پول برگشت`, saleId: sale.id, userId: user.id } });
          await tx.customerPayment.create({ data: { customerId: sale.customerId, amount: -creditRefund, note: `خنثی‌سازی پرداخت‌ها پس از ابطال فاکتور ${sale.receiptNo}`, userId: user.id } });
        }
      }
      // Cash part: only the STILL-OPEN drawer gives the money back (as a
      // normal OUT movement, so the close math stays honest). Closed drawers
      // are history — the void itself is the correction.
      if (sale.cashPart > 0 && sale.cashSessionId) {
        const session = await tx.cashSession.findUnique({ where: { id: sale.cashSessionId }, select: { id: true, closedAt: true } });
        if (session && !session.closedAt) {
          await tx.cashMovement.create({ data: { type: "OUT", amount: sale.cashPart, description: `ابطال فاکتور ${sale.receiptNo} — ${dto.reason}`, cashSessionId: session.id } });
        }
      }
      // Unpaid installment plans on this invoice are voided with it.
      for (const plan of plans) await tx.installmentPlan.update({ where: { id: plan.id }, data: { status: "VOID" } });

      await tx.sale.update({ where: { id }, data: { voidedAt: new Date(), voidReason: dto.reason, voidedBy: user.username } });
      await tx.auditLog.create({ data: { actor: user.username, action: "VOID_SALE", entity: "Sale", entityId: id, detail: `${sale.receiptNo} — ${dto.reason}` } });
      return { id: sale.id, receiptNo: sale.receiptNo, voidedAt: new Date() };
    });
  }
}

@Module({ controllers: [SalesController], providers: [CheckoutService] })
export class SalesModule {}
