import { Body, Controller, Get, Module, Param, Patch, Post } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { CategoryDto, ProductDto } from "../dto";

@Controller("categories")
class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.category.findMany({ include: { _count: { select: { products: true } } }, orderBy: { name: "asc" } }); }
  @Post() async create(@Body() dto: CategoryDto) {
    const item = await this.prisma.category.create({ data: { name: dto.name.trim(), color: dto.color || "#7488a3" } });
    await this.prisma.auditLog.create({ data: { action: "CREATE", entity: "Category", entityId: item.id, detail: item.name } });
    return item;
  }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: CategoryDto) { return this.prisma.category.update({ where: { id }, data: { name: dto.name.trim(), color: dto.color } }); }
}

@Controller("products")
class ProductsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.product.findMany({ where: { isActive: true }, include: { category: true }, orderBy: { name: "asc" } }); }
  @Post() async create(@Body() dto: ProductDto) {
    const stock = dto.stock ?? 0;
    const item = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { sku: dto.sku.trim(), barcode: dto.barcode?.trim() || null, name: dto.name.trim(), unit: dto.unit || "عدد", price: dto.price, cost: dto.cost ?? 0, stock, minStock: dto.minStock ?? 0, categoryId: dto.categoryId || null } });
      if (stock > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: stock, stockAfter: stock, note: "موجودی اولیه" } });
      await tx.auditLog.create({ data: { action: "CREATE", entity: "Product", entityId: product.id, detail: product.sku } });
      return product;
    });
    return item;
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: ProductDto) {
    const { stock: _stock, ...fields } = dto;
    return this.prisma.product.update({ where: { id }, data: { ...fields, sku: fields.sku.trim(), barcode: fields.barcode?.trim() || null, name: fields.name.trim(), categoryId: fields.categoryId || null } });
  }
  @Patch(":id/archive") async archive(@Param("id") id: string) { return this.prisma.product.update({ where: { id }, data: { isActive: false } }); }
}

@Module({ controllers: [CategoriesController, ProductsController] })
export class CatalogModule {}
