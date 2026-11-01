import { BadRequestException, Body, Controller, Get, Module, Post, Query } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { InventoryAdjustmentDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("inventory")
class InventoryController {
  constructor(private readonly prisma: PrismaService) {}
  @Get("movements")
  movements(@Query("take") take = "100") { return this.prisma.inventoryMovement.findMany({ take: Math.min(250, Math.max(1, Number(take) || 100)), include: { product: { select: { name: true, sku: true, unit: true } } }, orderBy: { createdAt: "desc" } }); }

  @Post("adjust")
  async adjust(@Body() dto: InventoryAdjustmentDto, @CurrentUser() user: SessionUser) {
    if (!dto.quantity) throw new BadRequestException("تعداد تعدیل نمی‌تواند صفر باشد.");
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: dto.productId } });
      if (!product || !product.isActive) throw new BadRequestException("کالا پیدا نشد.");
      const stock = product.stock + dto.quantity;
      if (stock < 0) throw new BadRequestException(`موجودی ${product.name} کافی نیست.`);
      await tx.product.update({ where: { id: product.id }, data: { stock } });
      const movement = await tx.inventoryMovement.create({ data: { productId: product.id, type: dto.quantity > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: dto.quantity, stockAfter: stock, note: dto.note?.trim() || "تعدیل دستی" } });
      await tx.auditLog.create({ data: { actor: user.username, action: "ADJUST_STOCK", entity: "Product", entityId: product.id, detail: String(dto.quantity) } });
      return { product: { ...product, stock }, movement };
    });
  }
}

@Module({ controllers: [InventoryController] })
export class InventoryModule {}
