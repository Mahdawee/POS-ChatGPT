import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { SessionUser } from "../auth";
import type { SaleDto } from "../dto";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { LicenseService } from "../license/license.service";

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
    if (this.license) await this.license.assertLicensed();
    if (idempotencyKey) {
      const previous = await this.prisma.sale.findUnique({ where: { idempotencyKey }, include: { items: true, customer: true } });
      if (previous) return previous;
    }
    const quantities = new Map<string, number>();
    const lineDiscounts = new Map<string, number>();
    const serialsByProduct = new Map<string, string[]>();
    for (const line of dto.items) {
      quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
      lineDiscounts.set(line.productId, Math.max(0, lineDiscounts.get(line.productId) || 0) + (line.discount || 0));
      if (line.serials?.length) serialsByProduct.set(line.productId, (serialsByProduct.get(line.productId) || []).concat(line.serials));
    }
    const lines = [...quantities.entries()];
    return this.prisma.$transaction(async (tx) => {
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
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        if (product.isBundle) {
          const rows = await tx.bundleComponent.findMany({ where: { bundleId: productId }, include: { component: true } });
          if (!rows.length) throw new BadRequestException(`برای بستهٔ «${product.name}» اجزا تعیین نشده است.`);
          const parts = rows.map((row) => ({ component: row.component as StockishProduct, quantity: row.quantity * quantity }));
          for (const part of parts) {
            if (part.component.isBundle) throw new BadRequestException("بسته داخل بسته مجاز نیست؛ اجزای بسته باید کالای ساده باشند.");
            const available = part.component.stock - part.component.reserved;
            if (available < part.quantity) throw new BadRequestException(`موجودی جزء ${part.component.name} از بستهٔ ${product.name} کافی نیست. موجودی آزاد: ${available}`);
          }
          bundleComponents.set(productId, parts);
        } else {
          const available = product.stock - product.reserved;
          if (available < quantity) throw new BadRequestException(`موجودی ${product.name} کافی نیست. موجودی آزاد: ${available}${product.reserved > 0 ? " (بخشی از موجودی رزرو سفارش است)" : ""}`);
        }
        if (product.isSerialized) {
          const serials = serialsByProduct.get(productId) || [];
          if (!serials.length) throw new BadRequestException(`برای «${product.name}» شمارهٔ سریال/IMEI هر دستگاه را وارد کنید.`);
          if (!Number.isInteger(quantity) || serials.length !== quantity) throw new BadRequestException(`تعداد سریال‌های «${product.name}» باید دقیقاً ${quantity} باشد.`);
          const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
          const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
          for (const serial of serials) {
            const unit = unitMap.get(serial);
            if (!unit || unit.productId !== productId) throw new BadRequestException(`سریال ${serial} برای این کالا ثبت نشده است.`);
            if (unit.status !== "IN_STOCK") throw new BadRequestException(`سریال ${serial} قبلاً فروخته یا برگشتی است.`);
          }
        }
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
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        const physical: Array<{ product: StockishProduct; quantity: number }> = product.isBundle
          ? bundleComponents.get(productId)!.map((part) => ({ product: part.component, quantity: part.quantity }))
          : [{ product, quantity }];
        for (const part of physical) {
          const stockAfter = part.product.stock - part.quantity;
          await tx.product.update({ where: { id: part.product.id }, data: { stock: { decrement: part.quantity } } });
          await tx.inventoryMovement.create({ data: { productId: part.product.id, type: "SALE", quantity: -part.quantity, stockAfter, reference: receiptNo, note: product.isBundle ? `جزء بستهٔ ${product.name}` : undefined } });
          // Best-effort FEFO batch deduction for expiry warnings; never gates
          // the sale and silently stops when tracked batches run out.
          let batchRemaining = part.quantity;
          const batches = await tx.productBatch.findMany({ where: { productId: part.product.id, remainingQty: { gt: 0 } }, orderBy: { expiryDate: "asc" } });
          for (const batch of batches) {
            if (batchRemaining <= 0) break;
            const take = Math.min(batch.remainingQty, batchRemaining);
            await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: { decrement: take } } });
            batchRemaining -= take;
          }
        }
        // Serialized units flip to SOLD and remember the sale item they left with.
        if (product.isSerialized) {
          const saleItem = sale.items.find((item) => item.productId === productId);
          const serials = serialsByProduct.get(productId) || [];
          for (const serial of serials) {
            await tx.serialUnit.update({ where: { serial }, data: { status: "SOLD", saleItemId: saleItem?.id, updatedAt: new Date() } });
          }
        }
      }
      // ── Wallet settlement ────────────────────────────────────────────
      if (walletPart > 0 && dto.customerId) {
        await tx.customer.update({ where: { id: dto.customerId }, data: { walletBalance: { decrement: walletPart } } });
        await tx.customerWalletTxn.create({ data: { customerId: dto.customerId, type: "SALE", amount: walletPart, note: `خرید از کیف پول — فاکتور ${invoiceNo}`, saleId: sale.id, userId: user.id } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CHECKOUT", entity: "Sale", entityId: sale.id, detail: `${receiptNo} / ${total}` } });
      return sale;
    });
  }
}
