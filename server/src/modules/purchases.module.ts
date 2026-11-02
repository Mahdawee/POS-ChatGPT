import { BadRequestException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { PurchaseDto } from "../dto";
import { PrismaService } from "../prisma.service";

/** ثبت خرید و ورود کالا به انبار */
@Controller("purchases")
export class PurchasesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.purchase.findMany({
      take: 50,
      include: { supplier: true, user: { select: { displayName: true } }, items: true },
      orderBy: { createdAt: "desc" },
    });
  }

  @Post()
  async create(@Body() dto: PurchaseDto, @CurrentUser() user: SessionUser) {
    // Merge duplicated product lines before touching the database.
    const merged = new Map<string, { quantity: number; unitCost: number }>();
    for (const line of dto.items) {
      const current = merged.get(line.productId);
      merged.set(line.productId, { quantity: (current?.quantity || 0) + line.quantity, unitCost: line.unitCost ?? current?.unitCost ?? 0 });
    }
    const lines = [...merged.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاهای رسید فعال نیست یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      let total = 0;
      for (const [, { quantity, unitCost }] of lines) {
        const lineTotal = quantity * unitCost;
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
            create: lines.map(([productId, { quantity, unitCost }]) => {
              const product = productMap.get(productId)!;
              return { productId, name: product.name, sku: product.sku, quantity, unitCost, lineTotal: quantity * unitCost };
            }),
          },
        },
        include: { items: true, supplier: true },
      });
      for (const [productId, { quantity, unitCost }] of lines) {
        const product = productMap.get(productId)!;
        await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity }, cost: unitCost } });
        await tx.inventoryMovement.create({ data: { productId, type: "PURCHASE", quantity, stockAfter: product.stock + quantity, reference: purchase.id, note: "ورود خرید" } });
      }
      await tx.auditLog.create({ data: { actor: user.username, action: "CREATE_PURCHASE", entity: "Purchase", entityId: purchase.id, detail: String(total) } });
      return purchase;
    });
  }
}

@Module({ controllers: [PurchasesController] })
export class PurchasesModule {}
