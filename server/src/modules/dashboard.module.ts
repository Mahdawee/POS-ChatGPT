import { Controller, Get, Module } from "@nestjs/common";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "../prisma.service";
import { configureLocalStorage } from "../storage";

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** mtime of the newest backup file, or null when none exists yet. */
async function lastBackupTimestamp(prisma: PrismaService): Promise<string | null> {
  try {
    // Custom backup folder wins when set (Settings → backupDir); the default
    // local folder is the fallback.
    const dirs = [join(configureLocalStorage(), "backups")];
    try {
      const custom = (await prisma.setting.findUnique({ where: { key: "backupDir" } }))?.value?.trim();
      if (custom) dirs.unshift(custom);
    } catch { /* setting table missing on very first boot */ }
    let newest = 0;
    for (const dir of dirs) {
      // A folder that has never received a backup yet simply doesn't exist;
      // it must not abort the scan of the other folders (e.g. a custom
      // backupDir with fresh backups while the default one is still empty).
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".db")) continue;
        try {
          const mtime = statSync(join(dir, name)).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch { /* raced deletion */ }
      }
    }
    return newest ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}
  @Get("summary") async summary() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const chartStart = new Date(start);
    chartStart.setDate(chartStart.getDate() - 13);
    const [sales, productCount, lowStock, expiring, recentSales, purchasesToday, returnsToday, creditSalesTotal, creditReturnsTotal, paymentsTotal, stockValue, chartSales, backroom] = await Promise.all([
      this.prisma.sale.findMany({ where: { createdAt: { gte: start } }, select: { total: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; stock: number; minStock: number }>>`SELECT id, name, sku, stock, minStock FROM Product WHERE isActive = 1 AND stock <= minStock ORDER BY stock ASC LIMIT 8`,
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; expiryDate: string }>>`SELECT id, name, sku, expiryDate FROM Product WHERE isActive = 1 AND expiryDate IS NOT NULL AND expiryDate <= datetime('now', '+14 days') ORDER BY expiryDate ASC LIMIT 8`,
      this.prisma.sale.findMany({ take: 6, include: { customer: { select: { name: true } }, user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: { gte: start } } }),
      this.prisma.saleReturn.aggregate({ _sum: { total: true, creditRelief: true }, where: { createdAt: { gte: start } } }),
      this.prisma.sale.aggregate({ _sum: { creditPart: true }, where: { creditPart: { gt: 0 } } }),
      this.prisma.saleReturn.aggregate({ _sum: { creditRelief: true }, where: { sale: { creditPart: { gt: 0 } } } }),
      this.prisma.customerPayment.aggregate({ _sum: { amount: true } }),
      this.prisma.$queryRaw<Array<{ value: number | bigint }>>`SELECT COALESCE(SUM(stock * cost), 0) AS value FROM Product WHERE isActive = 1`,
      this.prisma.sale.findMany({ where: { createdAt: { gte: chartStart } }, select: { createdAt: true, total: true } }),
      this.prisma.$queryRaw<Array<{ value: number | bigint }>>`SELECT COALESCE(SUM(backstock * cost), 0) AS value FROM Product WHERE isActive = 1`,
    ]);
    // Batch/lot expiries: live batches tracking a delivery's own expiry date.
    // They complement (not replace) the product-level date above; products
    // with live batches are suppressed from the product-level list so a
    // single item never appears twice.
    const batchExpiring = await this.prisma.$queryRawUnsafe<Array<{ id: string; name: string; sku: string; expiryDate: string; remainingQty: number }>>(
      "SELECT b.id, p.name, p.sku, b.expiryDate, b.remainingQty FROM ProductBatch b JOIN Product p ON p.id = b.productId WHERE b.remainingQty > 0 AND b.expiryDate <= datetime('now', '+14 days') ORDER BY b.expiryDate ASC LIMIT 8",
    );
    const batchProductIds = new Set((await this.prisma.$queryRawUnsafe<Array<{ productId: string }>>("SELECT DISTINCT productId FROM ProductBatch WHERE remainingQty > 0")).map((row) => row.productId));
    const productExpiring = expiring.filter((item) => !batchProductIds.has(item.id));
    const mergedExpiring = [...batchExpiring, ...productExpiring]
      .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))
      .slice(0, 8);
    return {
      todaySales: sales.reduce((sum, sale) => sum + sale.total, 0),
      todayCount: sales.length,
      todayPurchases: purchasesToday._sum.total || 0,
      todayReturns: (returnsToday._sum.total || 0) + (returnsToday._sum.creditRelief || 0),
      creditOutstanding: (creditSalesTotal._sum.creditPart || 0) - (creditReturnsTotal._sum.creditRelief || 0) - (paymentsTotal._sum.amount || 0),
      stockValue: Number(stockValue[0]?.value ?? 0),
      backroomValue: Number(backroom[0]?.value ?? 0),
      productCount,
      lowStockCount: lowStock.length,
      lowStock,
      expiringCount: mergedExpiring.length,
      expiring: mergedExpiring,
      recentSales,
      // Newest backup file age, for the "has it been a while?" warning.
      lastBackupAt: await lastBackupTimestamp(this.prisma),
      // Daily totals for the last 14 days (dashboard chart), bucketed by the
      // machine's LOCAL day. SQLite's date() would bucket by UTC day, which
      // shifts sales made after midnight (e.g. 00:00-04:30 in UTC+4:30) into
      // the previous day's bar and desyncs the chart from the "today" cards.
      salesByDay: Object.entries(
        chartSales.reduce((perDay: Record<string, number>, sale) => {
          const day = localDay(sale.createdAt);
          perDay[day] = (perDay[day] || 0) + sale.total;
          return perDay;
        }, {}),
      )
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, total]) => ({ day, total })),
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
