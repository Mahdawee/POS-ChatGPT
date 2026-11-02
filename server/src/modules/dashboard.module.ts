import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

@Controller("dashboard")
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}
  @Get("summary") async summary() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [sales, productCount, lowStock, expiring, recentSales, purchasesToday, returnsToday, creditSalesTotal, creditReturnsTotal, paymentsTotal, stockValue] = await Promise.all([
      this.prisma.sale.findMany({ where: { createdAt: { gte: start } }, select: { total: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; stock: number; minStock: number }>>`SELECT id, name, sku, stock, minStock FROM Product WHERE isActive = 1 AND stock <= minStock ORDER BY stock ASC LIMIT 8`,
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; expiryDate: string }>>`SELECT id, name, sku, expiryDate FROM Product WHERE isActive = 1 AND expiryDate IS NOT NULL AND expiryDate <= datetime('now', '+14 days') ORDER BY expiryDate ASC LIMIT 8`,
      this.prisma.sale.findMany({ take: 6, include: { customer: { select: { name: true } }, user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: { gte: start } } }),
      this.prisma.saleReturn.aggregate({ _sum: { total: true }, where: { createdAt: { gte: start } } }),
      this.prisma.sale.aggregate({ _sum: { total: true }, where: { paymentMethod: "CREDIT" } }),
      this.prisma.saleReturn.aggregate({ _sum: { total: true }, where: { sale: { paymentMethod: "CREDIT" } } }),
      this.prisma.customerPayment.aggregate({ _sum: { amount: true } }),
      this.prisma.$queryRaw<Array<{ value: number | bigint }>>`SELECT COALESCE(SUM(stock * cost), 0) AS value FROM Product WHERE isActive = 1`,
    ]);
    return {
      todaySales: sales.reduce((sum, sale) => sum + sale.total, 0),
      todayCount: sales.length,
      todayPurchases: purchasesToday._sum.total || 0,
      todayReturns: returnsToday._sum.total || 0,
      creditOutstanding: (creditSalesTotal._sum.total || 0) - (creditReturnsTotal._sum.total || 0) - (paymentsTotal._sum.amount || 0),
      stockValue: Number(stockValue[0]?.value ?? 0),
      productCount,
      lowStockCount: lowStock.length,
      lowStock,
      expiringCount: expiring.length,
      expiring,
      recentSales,
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
