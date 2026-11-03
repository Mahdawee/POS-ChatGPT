import { BadRequestException, Controller, Get, Module, Query } from "@nestjs/common";
import { AdminOnly } from "../auth";
import { customerBalances, supplierBalances } from "../balances";
import { PrismaService } from "../prisma.service";

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Snapshot of the profit metrics for one date range. */
type ProfitFor = {
  from: Date;
  to: Date;
  revenue: number;
  refunds: number;
  netRevenue: number;
  cost: number;
  profit: number;
  invoiceCount: number;
  byDay: Array<{ day: string; revenue: number; profit: number }>;
  byUser: Array<{ userId: string; cashier: string; revenue: number; profit: number; count: number }>;
  bySession: Array<{ sessionId: string; cashier: string; openedAt: Date; closedAt: Date | null; revenue: number; count: number }>;
};

/** گزارش سود و تحلیل فروش برای یک بازهٔ زمانی (پیش‌فرض: ۳۰ روز اخیر) */
@AdminOnly()
@Controller("reports")
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** فهرست بدهی‌داران (مشتریان) و بدهی‌ها (تأمین‌کنندگان) با ماندهٔ کل */
  @Get("debtors")
  async debtors() {
    const [customers, suppliers, customerMap, supplierMap, creditSales, creditReturns, payments] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      this.prisma.supplier.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      customerBalances(this.prisma),
      supplierBalances(this.prisma),
      this.prisma.sale.findMany({ where: { creditPart: { gt: 0 } }, select: { customerId: true, createdAt: true, creditPart: true }, orderBy: { createdAt: "asc" } }),
      this.prisma.saleReturn.findMany({ where: { sale: { creditPart: { gt: 0 } } }, select: { creditRelief: true, createdAt: true, sale: { select: { customerId: true } } }, orderBy: { createdAt: "asc" } }),
      this.prisma.customerPayment.findMany({ select: { customerId: true, amount: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    ]);
    // Age the outstanding credit FIFO: returns and payments settle the oldest
    // invoices first, then each invoice's remainder lands in an age bucket.
    const dayMs = 86400000;
    const now = Date.now();
    const invoices = new Map<string, Array<{ at: number; open: number }>>();
    for (const sale of creditSales) {
      if (!sale.customerId) continue;
      const list = invoices.get(sale.customerId) || [];
      list.push({ at: sale.createdAt.getTime(), open: sale.creditPart });
      invoices.set(sale.customerId, list);
    }
    const settle = (customerId: string | null, amount: number) => {
      if (!customerId || amount <= 0) return;
      let left = amount;
      for (const invoice of invoices.get(customerId) || []) {
        if (left <= 0) break;
        const take = Math.min(invoice.open, left);
        invoice.open -= take;
        left -= take;
      }
    };
    for (const record of creditReturns) settle(record.sale.customerId, record.creditRelief);
    for (const payment of payments) settle(payment.customerId, payment.amount);
    const aging = new Map<string, { d30: number; d60: number; older: number }>();
    for (const [customerId, list] of invoices) {
      const bucket = { d30: 0, d60: 0, older: 0 };
      for (const invoice of list) {
        if (invoice.open <= 0) continue;
        const age = Math.floor((now - invoice.at) / dayMs);
        if (age <= 30) bucket.d30 += invoice.open;
        else if (age <= 60) bucket.d60 += invoice.open;
        else bucket.older += invoice.open;
      }
      aging.set(customerId, bucket);
    }
    const debtorCustomers = customers
      .map((customer) => ({ ...customer, balance: customerMap.get(customer.id) || 0, aging: aging.get(customer.id) || { d30: 0, d60: 0, older: 0 } }))
      .filter((customer) => customer.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    const debtorSuppliers = suppliers.map((supplier) => ({ ...supplier, balance: supplierMap.get(supplier.id) || 0 })).filter((supplier) => supplier.balance > 0).sort((a, b) => b.balance - a.balance);
    return {
      customers: debtorCustomers,
      customersTotal: debtorCustomers.reduce((sum, customer) => sum + customer.balance, 0),
      suppliers: debtorSuppliers,
      suppliersTotal: debtorSuppliers.reduce((sum, supplier) => sum + supplier.balance, 0),
    };
  }

  /** Core profit computation shared by the report and its period comparison. */
  private async profitFor(start: Date, end: Date): Promise<ProfitFor> {
    const range = { gte: start, lte: end };
    const [sales, returns, purchasesAgg, expensesAgg, mix, users, sessions] = await Promise.all([
      // Hard cap protects memory on very long ranges; a small shop cannot
      // realistically reach 50k sales inside one report window.
      this.prisma.sale.findMany({ where: { createdAt: range }, take: 50000, include: { items: { include: { product: { select: { categoryId: true, category: { select: { name: true } } } } } } } }),
      this.prisma.saleReturn.findMany({ where: { createdAt: range }, include: { items: true } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: range } }),
      this.prisma.expense.aggregate({ _sum: { amount: true }, where: { createdAt: range } }),
      this.prisma.sale.aggregate({ _sum: { cashPart: true, mobilePart: true, creditPart: true }, where: { createdAt: range } }),
      this.prisma.user.findMany({ select: { id: true, displayName: true } }),
      this.prisma.cashSession.findMany({ where: { openedAt: { lte: end } }, select: { id: true, userId: true, openedAt: true, closedAt: true }, orderBy: { openedAt: "desc" }, take: 200 }),
    ]);
    const userNames = new Map(users.map((user) => [user.id, user.displayName]));
    let revenue = 0;
    let refunds = 0;
    let cost = 0;
    let returnsCost = 0;
    let unknownCostRevenue = 0;
    const perDay = new Map<string, { revenue: number; profit: number }>();
    const perUser = new Map<string, { userId: string; cashier: string; revenue: number; profit: number; count: number }>();
    const perSession = new Map<string, { sessionId: string; cashier: string; openedAt: Date; closedAt: Date | null; revenue: number; count: number }>();
    const perProduct = new Map<string, { productId: string; name: string; quantity: number; revenue: number; profit: number }>();
    const perCategory = new Map<string, { category: string; revenue: number; profit: number; quantity: number }>();
    const perHour = new Map<number, { hour: number; revenue: number; count: number }>();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    for (const sale of sales) {
      revenue += sale.total;
      let saleProfit = 0;
      for (const item of sale.items) {
        const lineCost = item.unitCost * item.quantity;
        cost += lineCost;
        if (item.unitCost === 0) unknownCostRevenue += item.lineTotal;
        saleProfit += item.lineTotal - lineCost;
        const product = perProduct.get(item.productId) || { productId: item.productId, name: item.name, quantity: 0, revenue: 0, profit: 0 };
        product.quantity += item.quantity;
        product.revenue += item.lineTotal;
        product.profit += item.lineTotal - lineCost;
        perProduct.set(item.productId, product);
      }
      const day = localDay(sale.createdAt);
      const dayBucket = perDay.get(day) || { revenue: 0, profit: 0 };
      dayBucket.revenue += sale.total;
      dayBucket.profit += saleProfit;
      perDay.set(day, dayBucket);
      const hourBucket = perHour.get(sale.createdAt.getHours()) || { hour: sale.createdAt.getHours(), revenue: 0, count: 0 };
      hourBucket.revenue += sale.total;
      hourBucket.count += 1;
      perHour.set(hourBucket.hour, hourBucket);
      const userBucket = perUser.get(sale.userId) || { userId: sale.userId, cashier: userNames.get(sale.userId) || "—", revenue: 0, profit: 0, count: 0 };
      userBucket.revenue += sale.total;
      userBucket.profit += saleProfit;
      userBucket.count += 1;
      perUser.set(sale.userId, userBucket);
      if (sale.cashSessionId) {
        const session = sessionById.get(sale.cashSessionId);
        if (session) {
          const sessionBucket = perSession.get(sale.cashSessionId) || { sessionId: sale.cashSessionId, cashier: userNames.get(session.userId) || "—", openedAt: session.openedAt, closedAt: session.closedAt, revenue: 0, count: 0 };
          sessionBucket.revenue += sale.total;
          sessionBucket.count += 1;
          perSession.set(sale.cashSessionId, sessionBucket);
        }
      }
      for (const item of sale.items) {
        const categoryName = item.product?.category?.name;
        if (!categoryName) continue;
        const categoryBucket = perCategory.get(categoryName) || { category: categoryName, revenue: 0, profit: 0, quantity: 0 };
        const lineCost = item.unitCost * item.quantity;
        categoryBucket.revenue += item.lineTotal;
        categoryBucket.profit += item.lineTotal - lineCost;
        categoryBucket.quantity += item.quantity;
        perCategory.set(categoryName, categoryBucket);
      }
    }
    for (const record of returns) {
      // A return reverses both the refunded money and the relieved credit.
      const returnedValue = record.total + record.creditRelief;
      refunds += returnedValue;
      let returnCost = 0;
      for (const item of record.items) {
        returnCost += item.unitCost * item.quantity;
        const product = perProduct.get(item.productId);
        if (product) {
          product.quantity -= item.quantity;
          product.revenue -= item.lineTotal;
          product.profit -= item.lineTotal - item.unitCost * item.quantity;
        }
      }
      returnsCost += returnCost;
      const day = localDay(record.createdAt);
      const bucket = perDay.get(day) || { revenue: 0, profit: 0 };
      bucket.revenue -= returnedValue;
      bucket.profit -= returnedValue - returnCost;
      perDay.set(day, bucket);
    }
    const netRevenue = revenue - refunds;
    const netCost = cost - returnsCost;
    const profit = netRevenue - netCost;
    return {
      from: start,
      to: end,
      revenue,
      refunds,
      netRevenue,
      cost: netCost,
      profit,
      invoiceCount: sales.length,
      byDay: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, value]) => ({ day, ...value })),
      byUser: [...perUser.values()].sort((a, b) => b.revenue - a.revenue),
      bySession: [...perSession.values()].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime()),
      _expenses: expensesAgg._sum.amount || 0,
      _purchases: purchasesAgg._sum.total || 0,
      _mix: mix,
      _unknownCostRevenue: unknownCostRevenue,
      _perProduct: perProduct,
      _perCategory: perCategory,
      _perHour: perHour,
    } as ProfitFor & Record<string, unknown>;
  }

  @Get("profit")
  async profit(@Query("from") from?: string, @Query("to") to?: string, @Query("compare") compare?: string) {
    const end = to ? new Date(to.length === 10 ? `${to}T23:59:59.999` : to) : new Date();
    if (!to) end.setHours(23, 59, 59, 999);
    const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86400000);
    if (!from) start.setHours(0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new BadRequestException("بازهٔ تاریخ گزارش معتبر نیست.");
    const current = await this.profitFor(start, end);
    const build = (data: ProfitFor & Record<string, unknown>) => ({
      from: data.from.toISOString(),
      to: data.to.toISOString(),
      revenue: data.revenue,
      refunds: data.refunds,
      netRevenue: data.netRevenue,
      cost: data.cost,
      profit: data.profit,
      expenses: data._expenses as number,
      netProfit: data.profit - (data._expenses as number),
      margin: data.netRevenue > 0 ? data.profit / data.netRevenue : 0,
      unknownCostRevenue: data._unknownCostRevenue as number,
      invoiceCount: data.invoiceCount,
      purchasesTotal: data._purchases as number,
      byDay: data.byDay,
      byUser: data.byUser,
      bySession: data.bySession,
      topProducts: [...(data._perProduct as Map<string, { productId: string; name: string; quantity: number; revenue: number; profit: number }>).values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      byCategory: [...(data._perCategory as Map<string, { category: string; revenue: number; profit: number; quantity: number }>).values()].sort((a, b) => b.revenue - a.revenue),
      byHour: [...(data._perHour as Map<number, { hour: number; revenue: number; count: number }>).values()].sort((a, b) => a.hour - b.hour),
      paymentMix: [
        { method: "CASH", total: (data._mix as { _sum: { cashPart: number | null } })._sum.cashPart || 0 },
        { method: "MOBILE", total: (data._mix as { _sum: { mobilePart: number | null } })._sum.mobilePart || 0 },
        { method: "CREDIT", total: (data._mix as { _sum: { creditPart: number | null } })._sum.creditPart || 0 },
      ],
    });
    const report = build(current);
    // Same-length window immediately before the selected one, for the
    // "compare with the previous period" view.
    if (compare === "1") {
      const span = end.getTime() - start.getTime();
      const prevEnd = new Date(start.getTime() - 1);
      const prevStart = new Date(prevEnd.getTime() - span);
      prevStart.setHours(0, 0, 0, 0);
      const previous = build(await this.profitFor(prevStart, prevEnd));
      const delta = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
      return {
        ...report,
        previous,
        comparison: {
          revenue: delta(report.revenue, previous.revenue),
          netRevenue: delta(report.netRevenue, previous.netRevenue),
          profit: delta(report.profit, previous.profit),
          netProfit: delta(report.netProfit, previous.netProfit),
          invoiceCount: delta(report.invoiceCount, previous.invoiceCount),
        },
      };
    }
    return report;
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
