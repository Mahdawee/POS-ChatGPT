import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { PurchaseDto, PurchaseReturnDto, VoidDto } from "../dto";
import { PrismaService } from "../prisma.service";
import type { Prisma } from "@prisma/client";

/** ثبت خرید و ورود کالا به انبار */
@Controller("purchases")
export class PurchasesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query("skip") skip?: string, @Query("take") take?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("sort") sort?: string, @Query("dir") dir?: string, @Query("q") q?: string) {
    // Windowed listing like /sales: a shop that has been buying for years
    // must still be able to page back to its oldest receipts.
    const limit = Math.min(300, Math.max(1, Number(take) || 50));
    const offset = Math.max(0, Number(skip) || 0);
    // Date window, server-side search and column sorting, mirroring the
    // register's history table.
    const where: Prisma.PurchaseWhereInput = {};
    // Unparsable date strings are ignored rather than crashing the query.
    const createdAt: Prisma.DateTimeFilter = {};
    // A date-only «from» means local midnight — same clock as «to» below. Parsing
    // it bare would jump to UTC and drop the 00:00–04:30 sales of that day.
    if (from && Number.isFinite(Date.parse(from))) createdAt.gte = new Date(from.length === 10 ? `${from}T00:00:00` : from);
    const toDay = to ? (to.length === 10 ? `${to}T23:59:59.999` : to) : "";
    if (toDay && Number.isFinite(Date.parse(toDay))) createdAt.lte = new Date(toDay);
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;
    const search = q?.trim();
    if (search) where.OR = [
      { invoiceNo: { contains: search } },
      { supplier: { name: { contains: search } } }, { user: { displayName: { contains: search } } },
    ];
    const direction = dir === "asc" ? "asc" as const : "desc" as const;
    const orderBy = sort === "total" ? { total: direction } : sort === "invoiceNo" ? { invoiceNo: direction } : sort === "supplier" ? { supplier: { name: direction } } : { createdAt: direction };
    // { list, total } so the client can render real page numbers.
    const [list, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        skip: offset,
        take: limit,
        include: { supplier: true, user: { select: { displayName: true } }, items: true },
        orderBy,
      }),
      this.prisma.purchase.count({ where }),
    ]);
    return { list, total };
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
      // A bundle's own stock is never touched by sales (its components are
      // deducted instead), so "buying" a bundle would freeze that number
      // forever and mislead the POS. Assemble kits from their components.
      for (const product of products) {
        if (product.isBundle) throw new BadRequestException(`«${product.name}» بسته است و خریدنی نیست؛ اجزای آن را جداگانه وارد کنید.`);
      }
      const productMap = new Map(products.map((product) => [product.id, product]));
      // Countable goods are bought in whole units — a stray 1.001 from a
      // misaligned stepper must not poison stock math or serial counts.
      // `lines` shares these value objects, so rounding once heals every write.
      for (const [productId, line] of merged) {
        if (productMap.get(productId)!.isWeighted) continue;
        const rounded = Math.round(line.quantity);
        if (rounded < 1) throw new BadRequestException(`تعداد «${productMap.get(productId)!.name}» باید عدد صحیح و حداقل ۱ باشد.`);
        line.quantity = rounded;
      }
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
      for (const [productId, { quantity, unitCost, expiryDate, serials: rawSerials }] of lines) {
        const product = productMap.get(productId)!;
        // Serials are trimmed once and validated as a set: a duplicate inside
        // the delivery would reach createMany and die as a raw 500 (P2002).
        const serials = rawSerials.map((serial) => serial.trim()).filter(Boolean);
        // Serialized goods must declare one serial per unit — the tracked
        // units are what the POS will later insist on handing over.
        if (product.isSerialized) {
          if (!serials.length || serials.length !== Math.round(quantity)) throw new BadRequestException(`برای «${product.name}» تعداد سریال/IMEI باید دقیقاً ${Math.round(quantity)} باشد.`);
          if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در اقلام «${product.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
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
          await tx.serialUnit.createMany({ data: serials.map((serial) => ({ productId, serial, status: "IN_STOCK", purchaseItemId: purchaseItem?.id })) });
        }
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_PURCHASE", entity: "Purchase", entityId: purchase.id, detail: String(total) } });
      return purchase;
    });
  }

  /**
   * ابطال رسید خرید (void) — the receipt row and its items are never
   * deleted; the void columns record when, why and by whom. The reversal
   * (one transaction) takes the goods back out of the shelf and refuses to
   * run when that is impossible: anything already sold, a consumed expiry
   * lot or a serialized unit that left the shelf blocks the void with a
   * clear message instead of silently corrupting stock. Payments already
   * made to the supplier stay recorded — excluding the voided receipt from
   * the supplier's balance turns them into a plain advance/credit.
   */
  @AdminOnly()
  @Post(":id/void")
  async voidPurchase(@Param("id") id: string, @Body() dto: VoidDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUnique({ where: { id }, include: { items: true } });
      if (!purchase) throw new NotFoundException("رسید خرید پیدا نشد.");
      if (purchase.voidedAt) throw new BadRequestException("این رسید قبلاً ابطال شده است.");
      const returns = await tx.purchaseReturn.findMany({ where: { purchaseId: id }, select: { id: true } });
      if (returns.length) throw new BadRequestException("رسیدی که برگشت کالا دارد قابل ابطال نیست.");

      // The goods must still be on the shelf, whole.
      const products = await tx.product.findMany({ where: { id: { in: [...new Set(purchase.items.map((item) => item.productId))] } } });
      const byId = new Map(products.map((product) => [product.id, product]));
      const need = new Map<string, number>();
      for (const item of purchase.items) need.set(item.productId, (need.get(item.productId) || 0) + item.quantity);
      for (const [productId, quantity] of need) {
        const product = byId.get(productId);
        if (!product) continue;
        if (product.stock < quantity) throw new BadRequestException(`«${product.name}» از این خرید قبلاً فروش/مصرف شده و موجودی برای ابطال کافی نیست.`);
      }
      // Serialized units that came in with this receipt must still be here.
      const serials = await tx.serialUnit.findMany({ where: { purchaseItemId: { in: purchase.items.map((item) => item.id) } }, select: { serial: true, status: true } });
      if (serials.some((unit) => unit.status !== "IN_STOCK")) throw new BadRequestException("دستگاه‌های سریال‌دار این خرید هنوز در انبار نیستند؛ ابطال ممکن نیست.");
      // Expiry lots of this receipt must be untouched (fully remaining).
      const batches = await tx.productBatch.findMany({ where: { purchaseId: id } });
      if (batches.some((batch) => batch.remainingQty < batch.initialQty)) throw new BadRequestException("محصولات تاریخ‌دار این رسید تا حدی فروش/مصرف شده‌اند؛ ابطال ممکن نیست.");

      for (const [productId, quantity] of need) {
        const product = byId.get(productId)!;
        const updated = await tx.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } }, select: { stock: true } });
        await tx.inventoryMovement.create({ data: { productId, type: "ADJUSTMENT_OUT", quantity: -quantity, stockAfter: updated.stock, note: `ابطال رسید خرید${purchase.invoiceNo ? ` ${purchase.invoiceNo}` : ""} — ${dto.reason}` } });
      }
      // The expiry lots of this receipt are exhausted (rows stay as trail).
      for (const batch of batches) await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: 0 } });
      // Serial units that never really entered the shelf leave it.
      if (serials.length) await tx.serialUnit.updateMany({ where: { purchaseItemId: { in: purchase.items.map((item) => item.id) } }, data: { status: "VOID" } });

      await tx.purchase.update({ where: { id }, data: { voidedAt: new Date(), voidReason: dto.reason, voidedBy: user.username } });
      await tx.auditLog.create({ data: { actor: user.username, action: "VOID_PURCHASE", entity: "Purchase", entityId: id, detail: `${purchase.invoiceNo || id} — ${dto.reason}` } });
      return { id: purchase.id, invoiceNo: purchase.invoiceNo, voidedAt: new Date() };
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
    // Merge duplicated product lines before touching the database. Serials
    // ride along per line (IMEI units going back to the supplier).
    const merged = new Map<string, { quantity: number; serials: string[] }>();
    for (const line of dto.items) {
      const current = merged.get(line.productId);
      merged.set(line.productId, { quantity: (current?.quantity || 0) + line.quantity, serials: (current?.serials || []).concat(line.serials || []) });
    }
    const lines = [...merged.entries()].map(([productId, { quantity }]) => [productId, quantity] as [string, number]);
    const serialsByProduct = new Map<string, string[]>();
    for (const [productId, { serials }] of merged) if (serials.length) serialsByProduct.set(productId, serials);
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
        // Serialized goods must name the exact units leaving the shop;
        // otherwise their IMEIs would stay "in stock" forever and could be
        // handed to a customer that never arrived.
        if (product.isSerialized) {
          const serials = (serialsByProduct.get(productId) || []).map((serial) => serial.trim()).filter(Boolean);
          if (!serials.length || serials.length !== Math.round(quantity)) throw new BadRequestException(`برای برگشت «${product.name}» شمارهٔ سریال/IMEI هر دستگاه را وارد کنید (${Math.round(quantity)} عدد).`);
          if (new Set(serials).size !== serials.length) throw new BadRequestException(`سریال تکراری در برگشت «${product.name}» هست؛ هر دستگاه را یک بار وارد کنید.`);
          const units = await tx.serialUnit.findMany({ where: { serial: { in: serials } } });
          const unitMap = new Map(units.map((unit) => [unit.serial, unit]));
          for (const serial of serials) {
            const unit = unitMap.get(serial);
            if (!unit || unit.productId !== productId) throw new BadRequestException(`سریال ${serial} برای این کالا ثبت نشده است.`);
            if (unit.status !== "IN_STOCK") throw new BadRequestException(`سریال ${serial} در انبار نیست و قابل برگشت نیست.`);
          }
        }
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
        // Tracked units physically leave the shop: mark them RETURNED so the
        // serial list stays truthful and they can never be sold here again.
        if (product.isSerialized) {
          for (const serial of (serialsByProduct.get(row.productId) || []).map((value) => value.trim()).filter(Boolean)) {
            await tx.serialUnit.update({ where: { serial }, data: { status: "RETURNED", note: `برگشت به تأمین‌کننده ${returnNo}`, updatedAt: new Date() } });
          }
        }
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "PURCHASE_RETURN", entity: "PurchaseReturn", entityId: record.id, detail: `${returnNo} / ${total}` } });
      return record;
    });
  }
}

@Module({ controllers: [PurchasesController, PurchaseReturnsController] })
export class PurchasesModule {}
