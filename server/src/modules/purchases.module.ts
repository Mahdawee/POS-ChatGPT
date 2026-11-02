import { BadRequestException, Body, Controller, Get, Module, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { PurchaseDto, PurchaseReturnDto } from "../dto";
import { PrismaService } from "../prisma.service";

/** ثبت خرید و ورود کالا به انبار */
@Controller("purchases")
export class PurchasesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query("skip") skip?: string, @Query("take") take?: string) {
    // Windowed listing like /sales: a shop that has been buying for years
    // must still be able to page back to its oldest receipts.
    const limit = Math.min(300, Math.max(1, Number(take) || 50));
    const offset = Math.max(0, Number(skip) || 0);
    return this.prisma.purchase.findMany({
      skip: offset,
      take: limit,
      include: { supplier: true, user: { select: { displayName: true } }, items: true },
      orderBy: { createdAt: "desc" },
    });
  }

  @Post()
  async create(@Body() dto: PurchaseDto, @CurrentUser() user: SessionUser) {
    // Merge duplicated product lines before touching the database. Serials
    // (IMEI) ride along per line; they are registered as tracked units after
    // the purchase row exists, so duplicates must keep their list.
    const merged = new Map<string, { quantity: number; unitCost: number; expiryDate?: string; serials: string[] }>();
    for (const line of dto.items) {
      const current = merged.get(line.productId);
      merged.set(line.productId, { quantity: (current?.quantity || 0) + line.quantity, unitCost: line.unitCost ?? current?.unitCost ?? 0, expiryDate: line.expiryDate ?? current?.expiryDate, serials: (current?.serials || []).concat(line.serials || []) });
    }
    const lines = [...merged.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاهای رسید فعال نیست یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      let total = 0;
      for (const [, { quantity, unitCost }] of lines) {
        const lineTotal = Math.round(quantity * unitCost);
        if (!Number.isSafeInteger(lineTotal) || lineTotal > 2147483647) throw new BadRequestException("مبلغ یک قلم از سقف مجاز بیشتر است.");
        total += lineTotal;
        if (total > 2147483647) throw new BadRequestException("جمع رسید خرید از سقف مجاز بیشتر است.");
      }
      if (dto.supplierId && !(await tx.supplier.findUnique({ where: { id: dto.supplierId } }))) throw new BadRequestException("تأمین‌کننده پیدا نشد.");
      // Amount settled at purchase time; the remainder becomes supplier debt.
      // This is bookkeeping only and never touches the cash drawer.
      const paidAmount = dto.paidAmount === undefined ? total : Math.min(dto.paidAmount, total);
      const purchase = await tx.purchase.create({
        data: {
          invoiceNo: dto.invoiceNo?.trim() || null,
          note: dto.note?.trim() || null,
          supplierId: dto.supplierId || null,
          userId: user.id,
          total,
          paidAmount,
          items: {
            create: lines.map(([productId, { quantity, unitCost, expiryDate }]) => {
              const product = productMap.get(productId)!;
              return { productId, name: product.name, sku: product.sku, quantity, unitCost, lineTotal: Math.round(quantity * unitCost), expiryDate: expiryDate ? new Date(`${expiryDate}T00:00:00.000Z`) : null };
            }),
          },
        },
        include: { items: true, supplier: true },
      });
      for (const [productId, { quantity, unitCost, expiryDate, serials }] of lines) {
        const product = productMap.get(productId)!;
        // Serialized goods must declare one serial per unit — the tracked
        // units are what the POS will later insist on handing over.
        if (product.isSerialized) {
          if (!serials.length || serials.length !== Math.round(quantity)) throw new BadRequestException(`برای «${product.name}» تعداد سریال/IMEI باید دقیقاً ${Math.round(quantity)} باشد.`);
          const existing = await tx.serialUnit.findMany({ where: { serial: { in: serials } }, select: { serial: true } });
          if (existing.length) throw new BadRequestException(`سریال ${existing[0].serial} قبلاً ثبت شده است.`);
        } else if (serials.length) {
          throw new BadRequestException(`«${product.name}» کالای سریال‌دار نیست؛ فیلد سریال را خالی بگذارید.`);
        }
        await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity }, cost: unitCost } });
        await tx.inventoryMovement.create({ data: { productId, type: "PURCHASE", quantity, stockAfter: product.stock + quantity, reference: purchase.id, note: "ورود خرید" } });
        // Deliveries with their own expiry date are tracked as batches so the
        // dashboard can warn per-lot (FEFO) instead of per-product.
        if (expiryDate) {
          await tx.productBatch.create({ data: { productId, expiryDate: new Date(`${expiryDate}T00:00:00.000Z`), initialQty: quantity, remainingQty: quantity, purchaseId: purchase.id } });
        }
        if (serials.length) {
          const purchaseItem = purchase.items.find((item) => item.productId === productId);
          await tx.serialUnit.createMany({ data: serials.map((serial) => ({ productId, serial: serial.trim(), status: "IN_STOCK", purchaseItemId: purchaseItem?.id })) });
        }
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_PURCHASE", entity: "Purchase", entityId: purchase.id, detail: String(total) } });
      return purchase;
    });
  }
}

/** ثبت برگشت خرید: کالا به تأمین‌کننده برمی‌گردد و مانده حساب او کم می‌شود. */
@Controller("purchases")
export class PurchaseReturnsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("returns")
  listReturns(@Query("skip") skip?: string, @Query("take") take?: string) {
    const limit = Math.min(300, Math.max(1, Number(take) || 100));
    const offset = Math.max(0, Number(skip) || 0);
    return this.prisma.purchaseReturn.findMany({
      skip: offset,
      take: limit,
      include: { supplier: true, user: { select: { displayName: true } }, purchase: { select: { invoiceNo: true } }, items: true },
      orderBy: { createdAt: "desc" },
    });
  }

  @Post("returns")
  async createReturn(@Body() dto: PurchaseReturnDto, @CurrentUser() user: SessionUser) {
    // Merge duplicated product lines before touching the database.
    const merged = new Map<string, number>();
    for (const line of dto.items) merged.set(line.productId, (merged.get(line.productId) || 0) + line.quantity);
    const lines = [...merged.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) } } });
      if (products.length !== lines.length) throw new BadRequestException("کالا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      let supplierId = dto.supplierId || null;
      if (dto.purchaseId) {
        const purchase = await tx.purchase.findUnique({ where: { id: dto.purchaseId }, select: { supplierId: true } });
        if (!purchase) throw new BadRequestException("رسید خرید پیدا نشد.");
        supplierId = supplierId || purchase.supplierId;
      }
      if (supplierId && !(await tx.supplier.findUnique({ where: { id: supplierId } }))) throw new BadRequestException("تأمین‌کننده پیدا نشد.");
      let total = 0;
      const rows: Array<{ productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number }> = [];
      for (const [productId, quantity] of lines) {
        const product = productMap.get(productId)!;
        // Goods must physically be in stock to go back to the supplier.
        if (quantity > product.stock) throw new BadRequestException("موجودی انبار برای برگشت این کالا کافی نیست.");
        const unitCost = dto.items.find((line) => line.productId === productId)?.unitCost ?? product.cost;
        const lineTotal = Math.round(quantity * unitCost);
        if (!Number.isSafeInteger(lineTotal) || lineTotal > 2147483647) throw new BadRequestException("مبلغ یک قلم از سقف مجاز بیشتر است.");
        total += lineTotal;
        if (total > 2147483647) throw new BadRequestException("جمع برگشت خرید از سقف مجاز بیشتر است.");
        rows.push({ productId, name: product.name, sku: product.sku, quantity, unitCost, lineTotal });
      }
      const returnNo = `PRet-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const record = await tx.purchaseReturn.create({
        data: { returnNo, purchaseId: dto.purchaseId || null, supplierId, total, note: dto.note?.trim() || null, userId: user.id, items: { create: rows } },
        include: { items: true, supplier: true, user: { select: { displayName: true } }, purchase: { select: { invoiceNo: true } } },
      });
      for (const row of rows) {
        const product = productMap.get(row.productId)!;
        await tx.product.update({ where: { id: row.productId }, data: { stock: { decrement: row.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: row.productId, type: "PURCHASE_RETURN", quantity: row.quantity, stockAfter: product.stock - row.quantity, reference: returnNo, note: "برگشت خرید" } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "PURCHASE_RETURN", entity: "PurchaseReturn", entityId: record.id, detail: `${returnNo} / ${total}` } });
      return record;
    });
  }
}

@Module({ controllers: [PurchasesController, PurchaseReturnsController] })
export class PurchasesModule {}
