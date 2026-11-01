import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

@Controller("dashboard")
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}
  @Get("summary") async summary() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [sales, productCount, lowStock, recentSales] = await Promise.all([
      this.prisma.sale.findMany({ where: { createdAt: { gte: start } }, select: { total: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; stock: number; minStock: number }>>`SELECT id, name, sku, stock, minStock FROM Product WHERE isActive = 1 AND stock <= minStock ORDER BY stock ASC LIMIT 8`,
      this.prisma.sale.findMany({ take: 6, include: { customer: { select: { name: true } }, user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } }),
    ]);
    return { todaySales: sales.reduce((sum, sale) => sum + sale.total, 0), todayCount: sales.length, productCount, lowStockCount: lowStock.length, lowStock, recentSales };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
