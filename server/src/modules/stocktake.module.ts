import { BadRequestException, Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CurrentUser, SessionUser } from "../auth";
import { StocktakeDto } from "../dto";
import { PrismaService } from "../prisma.service";

/**
 * Physical stock counts (شمارش انبار): a count is registered with the
 * expected quantity frozen at creation time, then applied — immediately or
 * later — as one stock adjustment per differing line.
 */
@Controller("stocktakes")
export class StocktakesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.stocktake.findMany({
      take: 50,
      include: { user: { select: { displayName: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const record = await this.prisma.stocktake.findUnique({ where: { id }, include: { user: { select: { displayName: true } }, lines: { include: { product: { select: { name: true, sku: true, unit: true } } } } } });
    if (!record) throw new BadRequestException("شمارش پیدا نشد.");
    return record;
  }

  @Post()
  async create(@Body() dto: StocktakeDto, @CurrentUser() user: SessionUser) {
    // Merge duplicated lines before touching the database.
    const counted = new Map<string, number>();
    for (const line of dto.lines) counted.set(line.productId, (counted.get(line.productId) || 0) + line.counted);
    const lines = [...counted.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      const record = await tx.stocktake.create({
        data: {
          name: dto.name?.trim() || null,
          note: dto.note?.trim() || null,
          status: "OPEN",
          userId: user.id,
          lines: { create: lines.map(([productId, quantity]) => { const product = productMap.get(productId)!; return { productId, expected: product.stock, counted: quantity, diff: quantity - product.stock }; }) },
        },
        include: { lines: { include: { product: { select: { name: true, sku: true, unit: true } } } } },
      });
      await tx.auditLog.create({ data: { actor: user.username, action: "STOCKTAKE", entity: "Stocktake", entityId: record.id, detail: `${record.lines.length} قلم${dto.apply ? " / اعمال فوری" : ""}` } });
      if (dto.apply) return this.apply(record.id, user, tx);
      return record;
    });
  }

  @Post(":id/apply")
  applyEndpoint(@Param("id") id: string, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => this.apply(id, user, tx));
  }

  private async apply(id: string, user: SessionUser, tx: Prisma.TransactionClient) {
    const record = await tx.stocktake.findUnique({ where: { id }, include: { lines: true } });
    if (!record) throw new BadRequestException("شمارش پیدا نشد.");
    if (record.status !== "OPEN") throw new BadRequestException("این شمارش قبلاً اعمال یا ابطال شده است.");
    const label = record.name || record.id;
    let adjusted = 0;
    for (const line of record.lines) {
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      if (!product) continue; // product vanished; skip silently
      const diff = line.counted - product.stock;
      if (Math.abs(diff) < 0.0005) continue;
      await tx.product.update({ where: { id: line.productId }, data: { stock: line.counted } });
      await tx.inventoryMovement.create({ data: { productId: line.productId, type: diff > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: diff, stockAfter: line.counted, note: `شمارش انبار ${label}` } });
      adjusted += 1;
    }
    const updated = await tx.stocktake.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date() }, include: { lines: { include: { product: { select: { name: true, sku: true, unit: true } } } }, user: { select: { displayName: true } }, _count: { select: { lines: true } } } });
    await tx.auditLog.create({ data: { actor: user.username, action: "STOCKTAKE_APPLY", entity: "Stocktake", entityId: id, detail: `${adjusted} قلم تعدیل شد` } });
    return updated;
  }

  @Post(":id/void")
  async void(@Param("id") id: string, @CurrentUser() user: SessionUser) {
    const record = await this.prisma.stocktake.findUnique({ where: { id } });
    if (!record) throw new BadRequestException("شمارش پیدا نشد.");
    if (record.status !== "OPEN") throw new BadRequestException("این شمارش قابل ابطال نیست.");
    const updated = await this.prisma.stocktake.update({ where: { id }, data: { status: "VOID" } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "STOCKTAKE_VOID", entity: "Stocktake", entityId: id } });
    return updated;
  }
}

@Module({ controllers: [StocktakesController] })
export class StocktakeModule {}
