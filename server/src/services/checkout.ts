import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { SessionUser } from "../auth";
import type { SaleDto } from "../dto";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { LicenseService } from "../license/license.service";
import { roundQty } from "../quantities";

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** A product row with the licensing-relevant stock fields. */
type StockishProduct = {
  id: string; name: string; sku: string; cost: number;
  price: number; wholesalePrice: number | null; wholesaleMinQty: number | null;
  stock: number; reserved: number; isBundle: boolean; isSerialized: boolean;
};

/**
 * Checkout as a service: the POS endpoint, quote conversion, order delivery
 * and any future caller (e.g. an API integration) share one
 * price/stock/payment pipeline.
 *
 * Round 16 additions, all enforced server-side (never trusting the client):
 * - wholesale-tier customers buy at the wholesale price regardless of qty;
 * - WALLET pays from the customer's prepaid balance (full payment only);
 * - bundle (BOM) lines deduct their components instead of the bundle itself;
 * - serialized lines must hand over exact IN_STOCK serial/IMEI units;
 * - open pre-orders reserve stock, so availability = stock − reserved;
 * - a license check runs before anything is written (second enforcement
 *   point after the API middleware — patching one is not enough).
 */
@Injectable()
export class CheckoutService {
  constructor(private readonly prisma: PrismaService, private readonly license?: LicenseService) {}

  /** Daily invoice sequence (INV-YYYYMMDD-0001) inside the caller's transaction. */
  private async nextInvoiceNo(tx: Prisma.TransactionClient): Promise<string> {
    const now = new Date();
    const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const counterKey = `invoiceSeq:${ymd}`;
    const counter = await tx.setting.findUnique({ where: { key: counterKey } });
    let seq = (counter ? Number(counter.value) || 0 : 0) + 1;
    // The counter lives in Setting and is bumped inside the transaction, so
    // numbers are gapless per machine/day under SQLite's single writer. A
    // restored backup can rewind it, so collisions just skip forward.
    let invoiceNo = `INV-${ymd}-${pad(seq, 4)}`;
    while (await tx.sale.findUnique({ where: { invoiceNo } })) {
      seq += 1;
      invoiceNo = `INV-${ymd}-${pad(seq, 4)}`;
    }
    await tx.setting.upsert({ where: { key: counterKey }, create: { key: counterKey, value: String(seq) }, update: { value: String(seq) } });
    return invoiceNo;
  }

  async checkout(dto: SaleDto, user: SessionUser, idempotencyKey?: string): Promise<unknown> {
    // License gate BEFORE the transaction opens. assertLicensed() reads and
    // writes the licenseState row through the pooled (parent) client, but a
    // SQLite interactive transaction owns the only pooled connection (and
    // the write lock) from its first statement — any parent-client query
    // inside the callback can never complete, the transaction expires after
    // its 5 s window and every sale dies with P2028 (“سرور موقتاً مشغول است”).
    // Callers that hand us their own transaction (order delivery, quote
    // conversion) run this gate before opening it.
    await this.assertLicensed();
    // A wider window than the 5 s default: a large invoice on a slow disk
    // (or a second register waiting on SQLite's busy_timeout) is a retryable
    // hiccup, not a lost basket.
    return this.prisma.$transaction((tx) => this.checkoutInTx(tx, dto, user, idempotencyKey), { timeout: 15_000, maxWait: 5_000 });
  }

  /** License gate shared by every checkout entry point — POS, quote
   *  conversion and order delivery. Always OUTSIDE the caller's transaction. */
  async assertLicensed(): Promise<void> {
    await this.license?.assertLicensed();
  }

  /** The whole checkout inside a CALLER-PROVIDED transaction. Order delivery
   *  and quote conversion use this so that their reservation release, the
   *  sale itself and their own workflow writes commit — or roll back — as
   *  ONE unit: a crash between the steps can never leave an order
   *  deliverable twice or an OPEN quote convertible again (double sale). */
  async checkoutInTx(tx: Prisma.TransactionClient, dto: SaleDto, user: SessionUser, idempotencyKey?: string): Promise<unknown> {
    // NOTE: no license check here — it queries the parent client and would
    // deadlock the transaction on SQLite (see checkout()). Callers must run
    // assertLicensed() before opening the transaction.
    if (idempotencyKey) {
      const previous = await tx.sale.findUnique({ where: { idempotencyKey }, include: { items: true, customer: true } });
      if (previous) return previous;
    }
    const quantities = new Map<string, number>();
    const lineDiscounts = new Map<string, number>();
    const serialsByProduct = new Map<string, string[]>();
    for (const line of dto.items) {
      // گردکردنِ جمع: ۰٫۱ + ۰٫۲ باید دقیقاً ۰٫۳ شود، نه ۰٫۳۰۰۰…۴ — وگرنه
      // هم DTO خطای «تعداد اعشاری» می‌دهد هم گارد اتمیکِ انتهایی فروش را
      // به‌اشتباه رد می‌کند.
      quantities.set(line.productId, roundQty((quantities.get(line.productId) || 0) + line.quantity));
      lineDiscounts.set(line.productId, Math.max(0, lineDiscounts.get(line.productId) || 0) + (line.discount || 0));
      if (line.serials?.length) serialsByProduct.set(line.productId, (serialsByProduct.get(line.productId) || []).concat(line.serials));
    }
    const lines = [...quantities.entries()];
    {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product as StockishProduct]));
      // Customer tier drives pricing (and wallet eligibility for WALLET).
      let customer: { id: string; creditLimit: number; tier: string; walletBalance: number } | null = null;
      if (dto.customerId) {
        customer = await tx.customer.findUnique({ where: { id: dto.customerId }, select: { id: true, creditLimit: true, tier: true, walletBalance: true } });
        if (!customer) throw new BadRequestException("مشتری پیدا نشد.");
      }
      const isWholesaleTier = customer?.tier === "WHOLESALE";
      // Same rule as the POS screen: the line switches to the wholesale price
      // once its quantity reaches the wholesale minimum — or immediately for
      // wholesale-tier customers. Keeping it here (not trusting client-sent
      // prices) means the invoice total is always honest.
      const unitPriceFor = (product: { price: number; wholesalePrice: number | null; wholesaleMinQty: number | null }, quantity: number): number =>
        product.wholesalePrice != null && (isWholesaleTier || (product.wholesaleMinQty != null && quantity >= product.wholesaleMinQty)) ? product.wholesalePrice : product.price;
      // ── Availability + serial validation ─────────────────────────────
      // Bundles never touch their own (untracked) stock: every component
      // must be available for the multiplied quantity. Open pre-orders
      // reserve stock, so walk-in availability is stock − reserved.
      const bundleComponents = new Map<string, Array<{ component: StockishProduct; quantity: number }>>();
      const componentById = new Map<string, StockishProduct>();
      // Serials that must flip to SOLD when the sale commits, keyed by the
      // sale line they leave with: a direct product, or the BUNDLE for units
      // handed over inside a kit (so a sale-return can still find them).
      const serialFlipPlan: Array<{ ownerProductId: string; serial: string }> = [];
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        if (product.isBundle) {
          const rows = await tx.bundleComponent.findMany({ where: { bundleId: productId }, include: { component: true } });
          if (!rows.length) throw new BadRequestException(`برای بستهٔ «${product.name}» اجزا تعیین نشده است.`);
          const parts = rows.map((row) => ({ component: row.component as StockishProduct, quantity: roundQty(row.quantity * quantity) }));
          for (const part of parts) {
            if (part.component.isBundle) throw new BadRequestException("بسته داخل بسته مجاز نیست؛ اجزای بسته باید کالای ساده باشند.");
            const available = roundQty(part.component.stock - part.component.reserved);
            if (available < part.quantity) throw new BadRequestException(`موجودی جزء ${part.component.name} از بستهٔ ${product.name} کافی نیست. موجودی آزاد: ${available}`);
            componentById.set(part.component.id, part.component);
          }
          bundleComponents.set(productId, parts);
        } else {
          const available = roundQty(product.stock - product.reserved);
          if (available < quantity) throw new BadRequestException(`موجودی ${product.name} کافی نیست. موجودی آزاد: ${available}${product.reserved > 0 ? " (بخشی از موجودی رزرو سفارش است)" : ""}`);
        }
        if (product.isSerialized) {
          const serials = serialsByProduct.get(productId) || [];
          if (!serials.length) throw new BadRequestException(`برای «${product.name}» شمارهٔ سریال/IMEI هر دستگاه را وارد کنید.`);
          if (!Number.isInteger(quantity) || serials.length !== quantity) throw new BadRequestException(`تعداد سریال‌های «${product.name}» باید دقیقاً ${quantity} باشد.`);
          // The same serial twice would pass the count check yet stand for one
          // physical unit — stock would drop by `quantity` for a single device.
          if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در اقلام «${product.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
          const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
          const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
          for (const serial of serials) {
            const unit = unitMap.get(serial);
            if (!unit || unit.productId !== productId) throw new BadRequestException(`سریال ${serial} برای این کالا ثبت نشده است.`);
            if (unit.status !== "IN_STOCK") throw new BadRequestException(`سریال ${serial} قبلاً فروخته یا برگشتی است.`);
          }
          for (const serial of serials) serialFlipPlan.push({ ownerProductId: productId, serial });
        }
        if (product.isBundle) {
          // A kit containing tracked devices hands those devices over too.
          // Their serials ride on the bundle line; without this the unit
          // leaves the shop while its serial stays "in stock" — sellable a
          // second time and returnable to the supplier as phantom stock.
          const serializedParts = (bundleComponents.get(productId) || []).filter((part) => part.component.isSerialized);
          if (serializedParts.length) {
            const serials = (serialsByProduct.get(productId) || []).map((value) => value.trim()).filter(Boolean);
            const needed = serializedParts.reduce((sum, part) => sum + part.quantity, 0);
            if (!serials.length) throw new BadRequestException(`برای «${product.name}» شمارهٔ سریال/IMEI اجزای سریال‌دار هر بسته را وارد کنید (${needed} عدد).`);
            if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در اقلام «${product.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
            const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
            const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
            const perComponent = new Map<string, string[]>();
            for (const serial of serials) {
              const unit = unitMap.get(serial);
              const part = serializedParts.find((row) => row.component.id === unit?.productId);
              if (!unit || !part) throw new BadRequestException(`سریال ${serial} برای اجزای بستهٔ «${product.name}» ثبت نشده است.`);
              if (unit.status !== "IN_STOCK") throw new BadRequestException(`سریال ${serial} قبلاً فروخته یا برگشتی است.`);
              perComponent.set(unit.productId, (perComponent.get(unit.productId) || []).concat(serial));
            }
            for (const part of serializedParts) {
              const have = (perComponent.get(part.component.id) || []).length;
              if (have !== part.quantity) throw new BadRequestException(`برای جزء «${part.component.name}» از بستهٔ «${product.name}» دقیقاً ${part.quantity} سریال لازم است (${have} عدد وارد شد).`);
            }
            for (const serial of serials) serialFlipPlan.push({ ownerProductId: productId, serial });
          }
        }
      }
      // A component shared by two bundles (or repeated across lines) must be
      // checked against its COMBINED demand: per-line checks alone would let
      // 3 + 3 pass over a stock of 5 and drive the shelf negative.
      const combined = new Map<string, number>();
      for (const parts of bundleComponents.values()) for (const part of parts) combined.set(part.component.id, roundQty((combined.get(part.component.id) || 0) + part.quantity));
      for (const [componentId, demand] of combined) {
        const component = componentById.get(componentId)!;
        const available = roundQty(component.stock - component.reserved);
        if (available < demand) throw new BadRequestException(`موجودی ${component.name} برای مجموع بسته‌های این فاکتور کافی نیست. موجودی آزاد: ${available}، لازم: ${demand}`);
      }
      let subtotal = 0;
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        // Weighted goods (kg) produce fractional math; money stays whole-afghani.
        const gross = Math.round(unitPriceFor(product, quantity) * quantity);
        const discount = Math.min(lineDiscounts.get(productId) || 0, gross);
        const lineTotal = gross - discount;
        if (!Number.isSafeInteger(lineTotal) || lineTotal > 2147483647) throw new BadRequestException("مبلغ یک قلم از سقف مجاز بیشتر است.");
        subtotal += lineTotal;
        if (subtotal > 2147483647) throw new BadRequestException("جمع فاکتور از سقف مجاز بیشتر است.");
      }
      // Flat discount and percentage discount never stack; percent wins the
      // tie so the POS toggle is predictable.
      const discount = dto.discountPercent != null ? Math.min(subtotal, Math.round((subtotal * dto.discountPercent) / 100)) : dto.discount || 0;
      if (discount > subtotal) throw new BadRequestException("تخفیف نمی‌تواند از مبلغ فروش بیشتر باشد.");
      const total = subtotal - discount;
      // ── Payment split ────────────────────────────────────────────────
      // Mixed mode (splitCash/splitMobile sent): the remainder becomes
      // credit. WALLET is a full-payment method like MOBILE: the whole total
      // leaves the customer's prepaid wallet. Legacy mode: derive the parts
      // from paymentMethod/amountPaid exactly like rows written before parts
      // existed.
      let cashPart = 0;
      let mobilePart = 0;
      let walletPart = 0;
      let amountPaid: number;
      let change = 0;
      const mixed = dto.splitCash != null || dto.splitMobile != null;
      if (mixed) {
        cashPart = Math.min(dto.splitCash || 0, total);
        mobilePart = Math.min(dto.splitMobile || 0, total - cashPart);
        amountPaid = cashPart + mobilePart;
        if (total - amountPaid > 0 && dto.paymentMethod === "CASH") throw new BadRequestException("برای فروش نقدی، مبلغ دریافتی نباید از جمع فاکتور کمتر باشد.");
      } else if (dto.paymentMethod === "CASH") {
        amountPaid = dto.amountPaid ?? total;
        if (amountPaid < total) throw new BadRequestException("مبلغ نقدی دریافتی کمتر از جمع فاکتور است.");
        cashPart = total;
        change = amountPaid - total;
      } else if (dto.paymentMethod === "MOBILE") {
        amountPaid = dto.amountPaid ?? total;
        if (amountPaid < total) throw new BadRequestException("پرداخت موبایلی باید کامل باشد.");
        mobilePart = total;
      } else if (dto.paymentMethod === "WALLET") {
        if (!customer) throw new BadRequestException("برای پرداخت از کیف پول، مشتری را انتخاب کنید.");
        if (customer.walletBalance < total) throw new BadRequestException(`ماندهٔ کیف پول ${customer.walletBalance} افغانی است و برای این فاکتور کافی نیست.`);
        walletPart = total;
        amountPaid = total;
      } else {
        amountPaid = Math.min(dto.amountPaid ?? 0, total);
        cashPart = amountPaid;
      }
      const creditPart = total - cashPart - mobilePart - walletPart;
      if (creditPart > 0 && !dto.customerId) throw new BadRequestException("برای ثبت فروش نسیه، مشتری را انتخاب کنید.");
      // Credit limit: warn-and-block unless an admin explicitly overrides.
      if (creditPart > 0 && customer && customer.creditLimit > 0) {
        const [salesAgg, reliefAgg, paymentsAgg] = await Promise.all([
          tx.sale.aggregate({ _sum: { creditPart: true }, where: { customerId: dto.customerId, creditPart: { gt: 0 } } }),
          tx.saleReturn.aggregate({ _sum: { creditRelief: true }, where: { sale: { customerId: dto.customerId, creditPart: { gt: 0 } } } }),
          tx.customerPayment.aggregate({ _sum: { amount: true }, where: { customerId: dto.customerId } }),
        ]);
        const outstanding = (salesAgg._sum.creditPart || 0) - (reliefAgg._sum.creditRelief || 0) - (paymentsAgg._sum.amount || 0);
        if (outstanding + creditPart > customer.creditLimit && !(dto.overrideCreditLimit && user.role === "ADMIN")) {
          throw new BadRequestException(`ماندهٔ نسیهٔ این مشتری با این فاکتور از سقف اعتبار (${customer.creditLimit}) بیشتر می‌شود. برای ادامه، تأیید مدیر لازم است.`);
        }
      }
      // Any cash portion requires an open register — exactly like pure cash sales.
      let cashSessionId: string | undefined;
      if (cashPart > 0 || dto.paymentMethod === "CASH") {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (!session) throw new BadRequestException("صندوق بسته است. ابتدا صندوق را باز کنید.");
        cashSessionId = session.id;
      }
      const receiptNo = `POS-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const invoiceNo = await this.nextInvoiceNo(tx);
      const sale = await tx.sale.create({
        data: {
          receiptNo, invoiceNo, idempotencyKey, subtotal, discount, total, amountPaid,
          change, cashPart, mobilePart, creditPart, walletPart,
          paymentMethod: creditPart > 0 ? "CREDIT" : walletPart > 0 ? "WALLET" : cashPart > 0 || dto.paymentMethod === "CASH" ? "CASH" : "MOBILE",
          note: dto.note?.trim(), customerId: dto.customerId || null,
          userId: user.id, cashSessionId,
          items: { create: lines.map(([productId, quantity]) => {
            const product = productMap.get(productId)!;
            const unitPrice = unitPriceFor(product, quantity);
            const gross = Math.round(unitPrice * quantity);
            const lineDiscount = Math.min(lineDiscounts.get(productId) || 0, gross);
            return { productId, name: product.name, sku: product.sku, quantity, unitPrice, unitCost: product.cost, discount: lineDiscount, lineTotal: gross - lineDiscount };
          }) },
        },
        include: { items: true, customer: true },
      });
      // ── Stock deduction ──────────────────────────────────────────────
      // Bundles deduct each component (movement + FEFO batches); simple
      // products deduct themselves. Reserved quantities are never touched
      // here — reservations are released by the order workflow itself.
      // The friendly pre-check above ran on rows read at the start of this
      // transaction; in network mode another device can sell the same shelf
      // inside that gap. This single conditional UPDATE is therefore the
      // hard, atomic guarantee: it only lands while the shelf still holds
      // the goods, so the database can never go negative from two devices
      // selling the last item at the same instant. The race loser gets a
      // clear message instead of a silently corrupted shelf.
      const deduct = async (product: StockishProduct, quantity: number, note?: string): Promise<void> => {
        // ROUND دو نقش دارد: مقدار نهاییِ ذخیره‌شده همیشه سه‌رقمیِ تمیز می‌ماند
        // (خطای ممیز شناورِ فروش‌های وزنیِ قبلی هم همین‌جا التیام می‌یابد) و
        // گارد روی مقدار گردشده مقایسه می‌شود تا «آخرین ۰٫۳ کیلو» قفسه‌ای که
        // ذخیرهٔ تاریخی‌اش ۰٫۲۹۹۹…۹۸ است به‌اشتباه رد نشود.
        const affected = await tx.$executeRaw`UPDATE Product SET stock = ROUND(stock - ${quantity}, 3) WHERE id = ${product.id} AND ROUND(stock, 3) >= ${quantity}`;
        if (affected === 0) {
          const shelf = await tx.product.findUnique({ where: { id: product.id }, select: { stock: true } });
          throw new BadRequestException(`موجودی «${product.name}» در همین لحظه کافی نیست — احتمالاً همین کالا همزمان روی دستگاه دیگری فروخته شده است. باقیماندهٔ فعلی: ${shelf?.stock ?? 0}. فهرست صندوق را دوباره بارگذاری کنید و دوباره امتحان کنید.`);
        }
        const after = await tx.product.findUnique({ where: { id: product.id }, select: { stock: true } });
        const stockAfter = after?.stock ?? roundQty(product.stock - quantity);
        await tx.inventoryMovement.create({ data: { productId: product.id, type: "SALE", quantity: -quantity, stockAfter, reference: receiptNo, note } });
        // Best-effort FEFO batch deduction for expiry warnings; never gates
        // the sale and silently stops when tracked batches run out.
        let batchRemaining = quantity;
        const batches = await tx.productBatch.findMany({ where: { productId: product.id, remainingQty: { gt: 0 } }, orderBy: { expiryDate: "asc" } });
        for (const batch of batches) {
          if (batchRemaining <= 0) break;
          const take = Math.min(batch.remainingQty, batchRemaining);
          await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: { decrement: take } } });
          batchRemaining -= take;
        }
      };
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        const physical: Array<{ product: StockishProduct; quantity: number }> = product.isBundle
          ? bundleComponents.get(productId)!.map((part) => ({ product: part.component, quantity: part.quantity }))
          : [{ product, quantity }];
        for (const part of physical) {
          // Bundle lines name the bundle so the cardex shows why the shelf moved.
          await deduct(part.product, part.quantity, product.isBundle ? `جزء بستهٔ ${product.name}` : undefined);
        }
      }
      // Serialized units flip to SOLD and remember the sale item they left
      // with — direct lines name the product, kit lines name the bundle.
      for (const flip of serialFlipPlan) {
        const saleItem = sale.items.find((item) => item.productId === flip.ownerProductId);
        await tx.serialUnit.update({ where: { serial: flip.serial }, data: { status: "SOLD", saleItemId: saleItem?.id, updatedAt: new Date() } });
      }
      // ── Wallet settlement ────────────────────────────────────────────
      if (walletPart > 0 && dto.customerId) {
        await tx.customer.update({ where: { id: dto.customerId }, data: { walletBalance: { decrement: walletPart } } });
        await tx.customerWalletTxn.create({ data: { customerId: dto.customerId, type: "SALE", amount: walletPart, note: `خرید از کیف پول — فاکتور ${invoiceNo}`, saleId: sale.id, userId: user.id } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CHECKOUT", entity: "Sale", entityId: sale.id, detail: `${receiptNo} / ${total}` } });
      return sale;
    }
  }
}
