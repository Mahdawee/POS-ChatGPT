import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { BundleDto, CategoryDto, ProductDto, ProductImportDto } from "../dto";
import { PrismaService } from "../prisma.service";

/**
 * Prisma's unique-constraint error (P2002) would surface as a raw 500; the
 * cashier only needs to know the code/barcode is already taken.
 */
function mapProductConflict(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002") {
    const target = JSON.stringify((error as { meta?: unknown }).meta ?? "");
    const field = target.includes("barcode") ? "بارکد" : "کد کالا";
    return new BadRequestException(`این ${field} برای کالای دیگری ثبت شده است.`);
  }
  return error;
}

@Controller("categories")
class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.category.findMany({ include: { _count: { select: { products: true } } }, orderBy: { name: "asc" } }); }
  @Post() async create(@Body() dto: CategoryDto) {
    const item = await this.prisma.category.create({ data: { name: dto.name.trim(), color: dto.color || "#7488a3" } });
    await this.prisma.auditLog.create({ data: { action: "CREATE", entity: "Category", entityId: item.id, detail: item.name } });
    return item;
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: CategoryDto) {
    const item = await this.prisma.category.update({ where: { id }, data: { name: dto.name.trim(), color: dto.color } });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Category", entityId: id, detail: item.name } });
    return item;
  }
}

@Controller("products")
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list(@Query("archived") archived?: string, @Query("q") q?: string) {
    // Server-side search keeps product lists snappy in warehouses with
    // thousands of rows; the POS still filters its own client-side copy.
    const search = q?.trim();
    const where: { isActive: boolean; OR?: Array<{ name: { contains: string } } | { sku: { contains: string } } | { barcode: { contains: string } }> } = { isActive: archived !== "1" };
    if (search) where.OR = [{ name: { contains: search } }, { sku: { contains: search } }, { barcode: { contains: search } }];
    return this.prisma.product.findMany({ where, include: { category: true, bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true } } } }, serialUnits: { where: { status: "IN_STOCK" }, select: { id: true } } }, orderBy: { name: "asc" } });
  }
  /** Paged variant of list() for the management table: same filters, but only
   *  one page of rows plus the total, so a 10k-item warehouse never ships the
   *  whole catalog (or renders it) at once. Consumers that need everything
   *  (POS local copy, purchase pickers) keep using GET /products. */
  @Get("page") async page(@Query("archived") archived?: string, @Query("q") q?: string, @Query("skip") skip?: string) {
    const search = q?.trim();
    const where: { isActive: boolean; OR?: Array<{ name: { contains: string } } | { sku: { contains: string } } | { barcode: { contains: string } }> } = { isActive: archived !== "1" };
    if (search) where.OR = [{ name: { contains: search } }, { sku: { contains: search } }, { barcode: { contains: search } }];
    const take = 100;
    const offset = Math.max(0, Number(skip) || 0);
    const include = { category: true, bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true } } } }, serialUnits: { where: { status: "IN_STOCK" }, select: { id: true } } } as const;
    const [list, total] = await Promise.all([
      this.prisma.product.findMany({ where, include, orderBy: { name: "asc" }, take, skip: offset }),
      this.prisma.product.count({ where }),
    ]);
    return { list, total, hasMore: offset + list.length < total };
  }
  @Post() async create(@Body() dto: ProductDto) {
    if (dto.isBundle && dto.isSerialized) throw new BadRequestException("یک کالا نمی‌تواند هم‌زمان بسته و سریال‌دار باشد؛ بسته اجزایی ساده دارد.");
    const stock = dto.stock ?? 0;
    const item = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { sku: dto.sku.trim(), barcode: dto.barcode?.trim() || null, name: dto.name.trim(), unit: dto.unit || "عدد", isWeighted: dto.isWeighted ?? false, isBundle: dto.isBundle ?? false, isSerialized: dto.isSerialized ?? false, expiryDate: dto.expiryDate ? new Date(`${dto.expiryDate}T00:00:00.000Z`) : null, price: dto.price, wholesalePrice: dto.wholesalePrice ?? null, wholesaleMinQty: dto.wholesaleMinQty ?? null, cost: dto.cost ?? 0, stock, minStock: dto.minStock ?? 0, categoryId: dto.categoryId || null } });
      if (stock > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: stock, stockAfter: stock, note: "موجودی اولیه" } });
      await tx.auditLog.create({ data: { action: "CREATE", entity: "Product", entityId: product.id, detail: product.sku } });
      return product;
    }).catch((error) => { throw mapProductConflict(error); });
    return item;
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: ProductDto) {
    const { stock: _stock, ...fields } = dto;
    // The flags are optional on PATCH: judge the request against the stored
    // product, not against absent keys.
    const stored = await this.prisma.product.findUnique({ where: { id }, select: { isBundle: true, isSerialized: true } });
    if (!stored) throw new NotFoundException("کالا پیدا نشد.");
    if ((fields.isBundle ?? stored.isBundle) && (fields.isSerialized ?? stored.isSerialized)) throw new BadRequestException("یک کالا نمی‌تواند هم‌زمان بسته و سریال‌دار باشد؛ بسته اجزایی ساده دارد.");
    const item = await this.prisma.product.update({ where: { id }, data: {
      ...fields,
      sku: fields.sku.trim(), barcode: fields.barcode?.trim() || null, name: fields.name.trim(), categoryId: fields.categoryId || null,
      // Same normalisation as create: an absent key leaves the date untouched,
      // null clears it (the product form sends null when the field is emptied),
      // and "YYYY-MM-DD" sets it. Passing the raw string through used to work
      // only by Prisma's good graces and could never clear a date.
      expiryDate: fields.expiryDate === undefined ? undefined : fields.expiryDate ? new Date(`${fields.expiryDate}T00:00:00.000Z`) : null,
    } }).catch((error) => { throw mapProductConflict(error); });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Product", entityId: id, detail: item.sku } });
    return item;
  }
  /** اجزای یک بسته/BOM را جایگزین می‌کند (اقلام قبلی پاک می‌شوند). */
  @AdminOnly()
  @Put(":id/bundle")
  async setBundle(@Param("id") id: string, @Body() dto: BundleDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const bundle = await tx.product.findUnique({ where: { id } });
      if (!bundle || !bundle.isActive) throw new BadRequestException("کالا پیدا نشد.");
      if (!bundle.isBundle) throw new BadRequestException("ابتدا کالا را به‌عنوان «بسته» ذخیره کنید.");
      if (bundle.isSerialized) throw new BadRequestException("کالای سریال‌دار نمی‌تواند بسته باشد؛ بسته اجزایی ساده دارد.");
      const ids = [...new Set(dto.components.map((row) => row.productId))];
      const components = await tx.product.findMany({ where: { id: { in: ids }, isActive: true } });
      if (components.length !== ids.length) throw new BadRequestException("یکی از اجزای بسته پیدا نشد یا غیرفعال است.");
      for (const component of components) {
        if (component.id === id) throw new BadRequestException("بسته نمی‌تواند جزء خودش باشد.");
        if (component.isBundle) throw new BadRequestException("بسته داخل بسته مجاز نیست.");
      }
      await tx.bundleComponent.deleteMany({ where: { bundleId: id } });
      await tx.bundleComponent.createMany({ data: dto.components.map((row) => ({ bundleId: id, componentId: row.productId, quantity: row.quantity })) });
      await tx.auditLog.create({ data: { actor: user.username, action: "SET_BUNDLE", entity: "Product", entityId: id, detail: `${dto.components.length} جزء` } });
      return tx.product.findUnique({ where: { id }, include: { bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true } } } } } });
    });
  }

  @Patch(":id/archive") async archive(@Param("id") id: string) { return this.prisma.product.update({ where: { id }, data: { isActive: false } }); }
  @Patch(":id/restore") async restore(@Param("id") id: string) { return this.prisma.product.update({ where: { id }, data: { isActive: true } }); }

  /** ورود گروهی کالا از فایل CSV/اکسل (برگزیدهٔ CSV) — ایجاد یا به‌روزرسانی بر اساس بارکد/کد/نام */
  @AdminOnly()
  @Post("import")
  async importProducts(@Body() dto: ProductImportDto, @CurrentUser() user: SessionUser) {
    let created = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (const [index, row] of dto.rows.entries()) {
      const name = row.name?.trim();
      if (!name) { errors.push({ row: index + 2, message: "نام کالا خالی است." }); continue; }
      try {
        await this.prisma.$transaction(async (tx) => {
          const existing = (row.barcode?.trim() ? await tx.product.findUnique({ where: { barcode: row.barcode.trim() } }) : null)
            || (row.sku?.trim() ? await tx.product.findUnique({ where: { sku: row.sku.trim() } }) : null)
            || (await tx.product.findFirst({ where: { name } }));
          let categoryId: string | null = null;
          if (row.category?.trim()) {
            const category = await tx.category.upsert({ where: { name: row.category.trim() }, create: { name: row.category.trim() }, update: {} });
            categoryId = category.id;
          }
          const expiryDate = row.expiryDate ? new Date(`${row.expiryDate}T00:00:00.000Z`) : null;
          if (existing) {
            const nextStock = row.stock ?? existing.stock;
            await tx.product.update({ where: { id: existing.id }, data: {
              price: row.price ?? existing.price, cost: row.cost ?? existing.cost,
              minStock: row.minStock ?? existing.minStock, stock: nextStock,
              unit: row.unit || existing.unit, isWeighted: row.isWeighted ?? existing.isWeighted,
              expiryDate: row.expiryDate === undefined ? existing.expiryDate : expiryDate,
              categoryId: categoryId || existing.categoryId,
            } });
            // Keep the cardex honest: a stock change coming from the import
            // file is an adjustment like any other, so it gets a movement row
            // too (without it the stock figure and the movement history
            // silently disagreed after an import).
            const stockDelta = nextStock - existing.stock;
            if (stockDelta !== 0) await tx.inventoryMovement.create({ data: { productId: existing.id, type: stockDelta > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: stockDelta, stockAfter: nextStock, note: "ورود از فایل" } });
            updated += 1;
          } else {
            const sku = row.sku?.trim() || `IMP-${Date.now()}-${index}`;
            const product = await tx.product.create({ data: {
              sku, barcode: row.barcode?.trim() || null, name, unit: row.unit || "عدد",
              isWeighted: row.isWeighted ?? false, expiryDate,
              price: row.price ?? 0, cost: row.cost ?? 0, stock: row.stock ?? 0, minStock: row.minStock ?? 0, categoryId,
            } });
            if ((row.stock ?? 0) > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: row.stock ?? 0, stockAfter: row.stock ?? 0, note: "ورود از فایل" } });
            created += 1;
          }
        });
      } catch (error) {
        errors.push({ row: index + 2, message: error instanceof Error && error.message.includes("Unique") ? "بارکد یا کد کالا تکراری است." : "ذخیرهٔ این سطر ممکن نشد." });
      }
    }
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "IMPORT_PRODUCTS", entity: "Product", detail: `created=${created}; updated=${updated}; errors=${errors.length}` } });
    return { created, updated, errors };
  }
}

@Module({ controllers: [CategoriesController, ProductsController] })
export class CatalogModule {}
