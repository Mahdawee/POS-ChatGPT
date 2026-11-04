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
    // Prisma persists DateTime columns as epoch milliseconds in SQLite, so the
    // expiry window must be compared as an INTEGER. `<= datetime('now', ...)`
    // compares INTEGER to TEXT, which SQLite orders as always-true — with real
    // months of data the card counted every dated item, not the near-expiry ones.
    const expiryCutoff = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const [sales, productCount, lowStock, lowStockCountRows, expiring, recentSales, purchasesToday, returnsToday, creditSalesTotal, creditReturnsTotal, paymentsTotal, stockValue, chartSales, backroom, overdueInstallments, openOrders] = await Promise.all([
      this.prisma.sale.findMany({ where: { createdAt: { gte: start } }, select: { total: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      // Bundles never carry their own stock (availability is built from their
      // components), so a kit's permanent stock=0 must not light up the
      // low-stock card. The unit travels along for an honest display.
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; unit: string; stock: number; minStock: number }>>`SELECT id, name, sku, unit, stock, minStock FROM Product WHERE isActive = 1 AND isBundle = 0 AND stock <= minStock ORDER BY stock ASC LIMIT 8`,
      // True low-stock count: the list above is capped at 8 rows for the
      // card, but months of use leave dozens of items below minimum —
      // "۱۲ کالا کم‌موجود" must not silently read as ۸.
      this.prisma.$queryRaw<Array<{ count: number | bigint }>>`SELECT COUNT(*) AS count FROM Product WHERE isActive = 1 AND isBundle = 0 AND stock <= minStock`,
      this.prisma.$queryRaw<Array<{ id: string; name: string; sku: string; expiryDate: string }>>`SELECT id, name, sku, expiryDate FROM Product WHERE isActive = 1 AND expiryDate IS NOT NULL AND expiryDate <= ${expiryCutoff} ORDER BY expiryDate ASC LIMIT 8`,
      this.prisma.sale.findMany({ take: 6, include: { customer: { select: { name: true } }, user: { select: { displayName: true } }, items: true }, orderBy: { createdAt: "desc" } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: { gte: start } } }),
      this.prisma.saleReturn.aggregate({ _sum: { total: true, creditRelief: true }, where: { createdAt: { gte: start } } }),
      this.prisma.sale.aggregate({ _sum: { creditPart: true }, where: { creditPart: { gt: 0 } } }),
      this.prisma.saleReturn.aggregate({ _sum: { creditRelief: true }, where: { sale: { creditPart: { gt: 0 } } } }),
      this.prisma.customerPayment.aggregate({ _sum: { amount: true } }),
      this.prisma.$queryRaw<Array<{ value: number | bigint }>>`SELECT COALESCE(SUM(stock * cost), 0) AS value FROM Product WHERE isActive = 1`,
      this.prisma.sale.findMany({ where: { createdAt: { gte: chartStart } }, select: { createdAt: true, total: true } }),
      this.prisma.$queryRaw<Array<{ value: number | bigint }>>`SELECT COALESCE(SUM(backstock * cost), 0) AS value FROM Product WHERE isActive = 1`,
      // Round 16 cards: overdue installments and open pre-orders.
      this.prisma.installment.findMany({ where: { paidAt: null, dueDate: { lt: new Date() }, plan: { status: "OPEN" } }, include: { plan: { include: { customer: { select: { id: true, name: true, phone: true } } } } }, orderBy: { dueDate: "asc" }, take: 50 }),
      this.prisma.customerOrder.findMany({ where: { status: "OPEN" }, include: { lines: true, customer: { select: { id: true, name: true, phone: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    // Batch/lot expiries: live batches tracking a delivery's own expiry date.
    // They complement (not replace) the product-level date above; products
    // with live batches are suppressed from the product-level list so a
    // single item never appears twice.
    const batchExpiring = await this.prisma.$queryRawUnsafe<Array<{ id: string; name: string; sku: string; expiryDate: string; remainingQty: number }>>(
      `SELECT b.id, p.name, p.sku, b.expiryDate, b.remainingQty FROM ProductBatch b JOIN Product p ON p.id = b.productId WHERE b.remainingQty > 0 AND b.expiryDate <= ${expiryCutoff} ORDER BY b.expiryDate ASC LIMIT 8`,
    );
    const batchProductIds = new Set((await this.prisma.$queryRawUnsafe<Array<{ productId: string }>>("SELECT DISTINCT productId FROM ProductBatch WHERE remainingQty > 0")).map((row) => row.productId));
    const productExpiring = expiring.filter((item) => !batchProductIds.has(item.id));
    // True expiry count with the same suppression rule as the card list:
    // product-level dates for goods WITHOUT live batches, plus live batches
    // themselves. The merged card list is capped at 8 — the count must not be.
    const [productExpiringCountRows, batchExpiringCountRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ count: number | bigint }>>(`SELECT COUNT(*) AS count FROM Product WHERE isActive = 1 AND expiryDate IS NOT NULL AND expiryDate <= ${expiryCutoff} AND id NOT IN (SELECT DISTINCT productId FROM ProductBatch WHERE remainingQty > 0)`),
      this.prisma.$queryRawUnsafe<Array<{ count: number | bigint }>>(`SELECT COUNT(*) AS count FROM ProductBatch WHERE remainingQty > 0 AND expiryDate <= ${expiryCutoff}`),
    ]);
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
      lowStockCount: Number(lowStockCountRows[0]?.count ?? 0),
      lowStock,
      expiringCount: Number(productExpiringCountRows[0]?.count ?? 0) + Number(batchExpiringCountRows[0]?.count ?? 0),
      expiring: mergedExpiring,
      recentSales,
      // Newest backup file age, for the "has it been a while?" warning.
      lastBackupAt: await lastBackupTimestamp(this.prisma),
      // اقساط سررسیدشدهٔ پرداخت‌نشده (مبلغ و مشتری) برای کارت هشدار.
      overdueInstallments: overdueInstallments.map((inst) => ({ id: inst.id, seq: inst.seq, amount: inst.amount - inst.paidAmount, dueDate: inst.dueDate, customer: inst.plan.customer, planId: inst.planId })),
      overdueInstallmentsTotal: overdueInstallments.reduce((sum, inst) => sum + (inst.amount - inst.paidAmount), 0),
      // سفارش‌های باز (رزرو شده) با مقدار تحویل‌نشده.
      openOrders: openOrders.map((order) => ({ id: order.id, orderNo: order.orderNo, createdAt: order.createdAt, note: order.note, customer: order.customer, lines: order.lines.map((line) => ({ id: line.id, name: line.name, quantity: line.quantity, deliveredQty: line.deliveredQty, unitPrice: line.unitPrice })) })),
      openOrdersCount: openOrders.length,
      // Daily totals for the last 14 days (dashboard chart), bucketed by the
      // machine's LOCAL day. SQLite's date() would bucket by UTC day, which
      // shifts sales made after midnight (e.g. 00:00-04:30 in UTC+4:30) into
      // the previous day's bar and desyncs the chart from the "today" cards.
      salesByDay: (() => {
        const perDay = chartSales.reduce((perDay: Record<string, number>, sale) => {
          const day = localDay(sale.createdAt);
          perDay[day] = (perDay[day] || 0) + sale.total;
          return perDay;
        }, {});
        // Zero-fill every day of the window: a closed Friday is a 0-bar, not
        // a missing column that quietly shifts the rest of the chart.
        const days: Array<{ day: string; total: number }> = [];
        for (let back = 13; back >= 0; back -= 1) {
          const date = new Date(start);
          date.setDate(date.getDate() - back);
          const key = localDay(date);
          days.push({ day: key, total: perDay[key] || 0 });
        }
        return days;
      })(),
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
