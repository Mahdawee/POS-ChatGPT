import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post, Query } from "@nestjs/common";
import { AdminOnly, CurrentUser, SessionUser } from "../auth";
import { CategoryDto, ProductDto, ProductImportDto } from "../dto";
import { PrismaService } from "../prisma.service";

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
    return this.prisma.product.findMany({ where, include: { category: true }, orderBy: { name: "asc" } });
  }
  @Post() async create(@Body() dto: ProductDto) {
    const stock = dto.stock ?? 0;
    const item = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { sku: dto.sku.trim(), barcode: dto.barcode?.trim() || null, name: dto.name.trim(), unit: dto.unit || "عدد", isWeighted: dto.isWeighted ?? false, expiryDate: dto.expiryDate ? new Date(`${dto.expiryDate}T00:00:00.000Z`) : null, price: dto.price, cost: dto.cost ?? 0, stock, minStock: dto.minStock ?? 0, categoryId: dto.categoryId || null } });
      if (stock > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: stock, stockAfter: stock, note: "موجودی اولیه" } });
      await tx.auditLog.create({ data: { action: "CREATE", entity: "Product", entityId: product.id, detail: product.sku } });
      return product;
    });
    return item;
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: ProductDto) {
    const { stock: _stock, ...fields } = dto;
    const item = await this.prisma.product.update({ where: { id }, data: { ...fields, sku: fields.sku.trim(), barcode: fields.barcode?.trim() || null, name: fields.name.trim(), categoryId: fields.categoryId || null } });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Product", entityId: id, detail: item.sku } });
    return item;
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
            await tx.product.update({ where: { id: existing.id }, data: {
              price: row.price ?? existing.price, cost: row.cost ?? existing.cost,
              minStock: row.minStock ?? existing.minStock, stock: row.stock ?? existing.stock,
              unit: row.unit || existing.unit, isWeighted: row.isWeighted ?? existing.isWeighted,
              expiryDate: row.expiryDate === undefined ? existing.expiryDate : expiryDate,
              categoryId: categoryId || existing.categoryId,
            } });
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
