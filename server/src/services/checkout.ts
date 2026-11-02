import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { SessionUser } from "../auth";
import type { SaleDto } from "../dto";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/**
 * Checkout as a service: the POS endpoint, quote conversion and any future
 * caller (e.g. an API integration) share one price/stock/payment pipeline.
 */
@Injectable()
export class CheckoutService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (idempotencyKey) {
      const previous = await this.prisma.sale.findUnique({ where: { idempotencyKey }, include: { items: true, customer: true } });
      if (previous) return previous;
    }
    const quantities = new Map<string, number>();
    const lineDiscounts = new Map<string, number>();
    for (const line of dto.items) {
      quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
      lineDiscounts.set(line.productId, Math.max(0, lineDiscounts.get(line.productId) || 0) + (line.discount || 0));
    }
    const lines = [...quantities.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      // Same rule as the POS screen: the line switches to the wholesale price
      // once its quantity reaches the wholesale minimum. Keeping it here (not
      // trusting client-sent prices) means the invoice total is always honest.
      const unitPriceFor = (product: { price: number; wholesalePrice: number | null; wholesaleMinQty: number | null }, quantity: number): number =>
        product.wholesalePrice != null && product.wholesaleMinQty != null && quantity >= product.wholesaleMinQty ? product.wholesalePrice : product.price;
      let subtotal = 0;
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        if (product.stock < quantity) throw new BadRequestException(`موجودی ${product.name} کافی نیست. موجودی فعلی: ${product.stock}`);
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
      // credit. Legacy mode: derive the parts from paymentMethod/amountPaid
      // exactly like rows written before parts existed.
      let cashPart = 0;
      let mobilePart = 0;
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
      } else {
        amountPaid = Math.min(dto.amountPaid ?? 0, total);
        cashPart = amountPaid;
      }
      const creditPart = total - cashPart - mobilePart;
      if (creditPart > 0 && !dto.customerId) throw new BadRequestException("برای ثبت فروش نسیه، مشتری را انتخاب کنید.");
      let customer: { id: string; creditLimit: number } | null = null;
      if (dto.customerId) {
        customer = await tx.customer.findUnique({ where: { id: dto.customerId }, select: { id: true, creditLimit: true } });
        if (!customer) throw new BadRequestException("مشتری پیدا نشد.");
      }
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
          change, cashPart, mobilePart, creditPart,
          paymentMethod: creditPart > 0 ? "CREDIT" : cashPart > 0 || dto.paymentMethod === "CASH" ? "CASH" : "MOBILE",
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
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        const stockAfter = product.stock - quantity;
        await tx.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } } });
        await tx.inventoryMovement.create({ data: { productId, type: "SALE", quantity: -quantity, stockAfter, reference: receiptNo } });
        // Best-effort FEFO batch deduction for expiry warnings; never gates
        // the sale and silently stops when tracked batches run out.
        let batchRemaining = quantity;
        const batches = await tx.productBatch.findMany({ where: { productId, remainingQty: { gt: 0 } }, orderBy: { expiryDate: "asc" } });
        for (const batch of batches) {
          if (batchRemaining <= 0) break;
          const take = Math.min(batch.remainingQty, batchRemaining);
          await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: { decrement: take } } });
          batchRemaining -= take;
        }
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CHECKOUT", entity: "Sale", entityId: sale.id, detail: `${receiptNo} / ${total}` } });
      return sale;
    });
  }
}
