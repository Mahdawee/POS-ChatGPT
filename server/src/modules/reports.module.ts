import { BadRequestException, Controller, Get, Module, Query } from "@nestjs/common";
import { AdminOnly } from "../auth";
import { customerBalances, supplierBalances } from "../balances";
import { PrismaService } from "../prisma.service";

/**
 * ── Report cache ──────────────────────────────────────────────────────────
 * The profit report scans every sale in the range; re-opening the same range
 * (or switching the comparison toggle back and forth) shouldn't rescan it.
 * Identical queries are served from memory for up to 60s, and any write
 * request (main.ts wires a middleware) clears the cache so reports never go
 * stale after a sale/return/expense is recorded.
 */
const REPORT_CACHE_TTL = 60_000;
const REPORT_CACHE_LIMIT = 50;
const reportCache = new Map<string, { at: number; value: unknown }>();

/** Clears every cached report — called for any non-GET /api request. */
export function invalidateReportCache(): void {
  reportCache.clear();
}

/** Serves `key` from the cache when fresh, otherwise runs `compute` and
 *  remembers the result (bounded LRU-ish: the oldest entry is evicted). */
function cachedReport<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < REPORT_CACHE_TTL) return Promise.resolve(hit.value as T);
  return compute().then((value) => {
    if (reportCache.size >= REPORT_CACHE_LIMIT) {
      const oldest = reportCache.keys().next().value;
      if (oldest !== undefined) reportCache.delete(oldest);
    }
    reportCache.set(key, { at: Date.now(), value });
    return value;
  });
}

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
    // Same 60s memory cache as the other reports (any non-GET /api request
    // clears it): the aging replay walks every credit sale, return and
    // payment, which is pointless to redo on a refresh nothing changed.
    return cachedReport("debtors", async () => {
    const [customers, suppliers, customerMap, supplierMap, creditSales, creditReturns, payments] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      this.prisma.supplier.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      customerBalances(this.prisma),
      supplierBalances(this.prisma),
      this.prisma.sale.findMany({ where: { creditPart: { gt: 0 }, voidedAt: null }, select: { customerId: true, createdAt: true, creditPart: true }, orderBy: { createdAt: "asc" } }),
      this.prisma.saleReturn.findMany({ where: { sale: { creditPart: { gt: 0 } } }, select: { creditRelief: true, createdAt: true, sale: { select: { customerId: true } } }, orderBy: { createdAt: "asc" } }),
      this.prisma.customerPayment.findMany({ select: { customerId: true, amount: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    ]);
    // Age the outstanding credit chronologically: invoices, returns and
    // payments are replayed in the order they happened, and a payment can
    // only settle invoices that already existed when it was made. (Settling
    // oldest-first regardless of dates let an advance payment silently eat a
    // LATER invoice, mis-bucketing the aging report.)
    const dayMs = 86400000;
    const now = Date.now();
    type LedgerEntry = { at: number; customerId: string | null; kind: "invoice" | "settle"; amount: number };
    const ledger: LedgerEntry[] = [];
    for (const sale of creditSales) if (sale.customerId) ledger.push({ at: sale.createdAt.getTime(), customerId: sale.customerId, kind: "invoice", amount: sale.creditPart });
    for (const record of creditReturns) ledger.push({ at: record.createdAt.getTime(), customerId: record.sale.customerId, kind: "settle", amount: record.creditRelief });
    for (const payment of payments) ledger.push({ at: payment.createdAt.getTime(), customerId: payment.customerId, kind: "settle", amount: payment.amount });
    ledger.sort((a, b) => a.at - b.at);
    const invoices = new Map<string, Array<{ at: number; open: number }>>();
    for (const entry of ledger) {
      if (!entry.customerId || entry.amount <= 0) continue;
      if (entry.kind === "invoice") {
        const list = invoices.get(entry.customerId) || [];
        list.push({ at: entry.at, open: entry.amount });
        invoices.set(entry.customerId, list);
        continue;
      }
      let left = entry.amount;
      for (const invoice of invoices.get(entry.customerId) || []) {
        if (left <= 0) break;
        const take = Math.min(invoice.open, left);
        invoice.open -= take;
        left -= take;
      }
      // Whatever stays unapplied was an advance payment: it is credit, not
      // aged debt, so it never lands in a bucket.
    }
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
    });
  }

  /** Core profit computation shared by the report and its period comparison. */
  private async profitFor(start: Date, end: Date): Promise<ProfitFor> {
    const range = { gte: start, lte: end };
    const [sales, saleItems, returns, purchasesAgg, expensesAgg, mix, users, sessions, windowCount] = await Promise.all([
      // Hard cap protects memory on very long ranges; a small shop cannot
      // realistically reach 50k sales inside one report window.
      // Round 40: sales and lines load as two FLAT queries instead of one
      // parent query with nested item→product→category includes — the
      // include graph shipped every line three levels deep and made a
      // 30-day report crawl (~1s on 25k invoices). The lines use one raw
      // SQL join (flat rows, ~5× faster than the nested select) bound with
      // epoch-ms integers, which is how Prisma itself stores DateTimes.
      this.prisma.sale.findMany({ where: { createdAt: range, voidedAt: null }, take: 50000, select: { id: true, total: true, createdAt: true, userId: true, cashSessionId: true } }),
      this.prisma.$queryRawUnsafe<Array<{ saleId: string | bigint; productId: string | bigint; name: string; quantity: number; unitCost: number | bigint; lineTotal: number | bigint; categoryName: string | null }>>(
        `SELECT si."saleId", si."productId", si."name", si."quantity", si."unitCost", si."lineTotal", c."name" AS "categoryName"
         FROM "SaleItem" si
         JOIN "Sale" s ON s."id" = si."saleId"
         LEFT JOIN "Product" p ON p."id" = si."productId"
         LEFT JOIN "Category" c ON c."id" = p."categoryId"
         WHERE s."createdAt" >= ? AND s."createdAt" <= ? AND s."voidedAt" IS NULL
         LIMIT 200000`,
        start.getTime(), end.getTime(),
      ),
      this.prisma.saleReturn.findMany({ where: { createdAt: range }, include: { items: { include: { product: { select: { category: { select: { name: true } } } } } }, sale: { select: { cashSessionId: true } } } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: range, voidedAt: null } }),
      this.prisma.expense.aggregate({ _sum: { amount: true }, where: { createdAt: range } }),
      this.prisma.sale.aggregate({ _sum: { cashPart: true, mobilePart: true, creditPart: true, walletPart: true }, where: { createdAt: range, voidedAt: null } }),
      this.prisma.user.findMany({ select: { id: true, displayName: true } }),
      this.prisma.cashSession.findMany({ where: { openedAt: { lte: end } }, select: { id: true, userId: true, openedAt: true, closedAt: true }, orderBy: { openedAt: "desc" }, take: 200 }),
      // True invoice count for the window: the 50k memory cap above can
      // silently truncate a multi-year range, and the report must SAY so
      // instead of quietly showing a fifth of the decade.
      this.prisma.sale.count({ where: { createdAt: range, voidedAt: null } }),
    ]);
    // Group the flat line rows back under their invoice for the per-invoice
    // passes below (day/hour/cashier buckets and per-product totals). Raw
    // values are coerced once — SQLite may hand back BigInt for INTEGER.
    const itemsBySale = new Map<string, Array<{ productId: string; name: string; quantity: number; unitCost: number; lineTotal: number; categoryName: string | null }>>();
    for (const row of saleItems) {
      const item = { productId: String(row.productId), name: String(row.name), quantity: Number(row.quantity), unitCost: Number(row.unitCost), lineTotal: Number(row.lineTotal), categoryName: row.categoryName == null ? null : String(row.categoryName) };
      const bucket = itemsBySale.get(String(row.saleId));
      if (bucket) bucket.push(item);
      else itemsBySale.set(String(row.saleId), [item]);
    }
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
      const saleLines = itemsBySale.get(sale.id) || [];
      for (const item of saleLines) {
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
      for (const item of saleLines) {
        const categoryName = item.categoryName;
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
      // Refunded money must also walk back the per-cashier, per-shift,
      // per-hour and per-category views — no slice of the report may count
      // returned money as sales.
      const userBucket = perUser.get(record.userId) || { userId: record.userId, cashier: userNames.get(record.userId) || "—", revenue: 0, profit: 0, count: 0 };
      userBucket.revenue -= returnedValue;
      userBucket.profit -= returnedValue - returnCost;
      perUser.set(record.userId, userBucket);
      const returnSessionId = record.sale?.cashSessionId;
      if (returnSessionId && sessionById.has(returnSessionId)) {
        const sessionBucket = perSession.get(returnSessionId);
        if (sessionBucket) sessionBucket.revenue -= returnedValue;
      }
      const hourBucket = perHour.get(record.createdAt.getHours()) || { hour: record.createdAt.getHours(), revenue: 0, count: 0 };
      hourBucket.revenue -= returnedValue;
      perHour.set(hourBucket.hour, hourBucket);
      for (const item of record.items) {
        const categoryName = item.product?.category?.name;
        if (!categoryName) continue;
        const categoryBucket = perCategory.get(categoryName) || { category: categoryName, revenue: 0, profit: 0, quantity: 0 };
        categoryBucket.revenue -= item.lineTotal;
        categoryBucket.profit -= item.lineTotal - item.unitCost * item.quantity;
        categoryBucket.quantity -= item.quantity;
        perCategory.set(categoryName, categoryBucket);
      }
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
      _windowInvoiceCount: windowCount,
      _truncated: windowCount > sales.length,
    } as ProfitFor & Record<string, unknown>;
  }

  @Get("profit")
  async profit(@Query("from") from?: string, @Query("to") to?: string, @Query("compare") compare?: string) {
    const end = to ? new Date(to.length === 10 ? `${to}T23:59:59.999` : to) : new Date();
    if (!to) end.setHours(23, 59, 59, 999);
    const start = from ? new Date(from.length === 10 ? `${from}T00:00:00` : from) : new Date(end.getTime() - 29 * 86400000);
    if (!from) start.setHours(0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new BadRequestException("بازهٔ تاریخ گزارش معتبر نیست.");
    return cachedReport(`${from || ""}|${to || ""}|${compare || ""}`, async () => {
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
      /** True when the 50k-sale memory cap left invoices outside the report. */
      truncated: Boolean(data._truncated),
      trueInvoiceCount: (data._windowInvoiceCount as number) ?? data.invoiceCount,
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
        { method: "WALLET", total: (data._mix as { _sum: { walletPart: number | null } })._sum.walletPart || 0 },
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
    });
  }

  /** Shared [start, end] window for the per-topic reports below. */
  private reportRange(from?: string, to?: string): { start: Date; end: Date } {
    const end = to ? new Date(to.length === 10 ? `${to}T23:59:59.999` : to) : new Date();
    if (!to) end.setHours(23, 59, 59, 999);
    const start = from ? new Date(from.length === 10 ? `${from}T00:00:00` : from) : new Date(end.getTime() - 29 * 86400000);
    if (!from) start.setHours(0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new BadRequestException("بازهٔ تاریخ گزارش معتبر نیست.");
    return { start, end };
  }

  /** گزارش خریدها: جمع، پرداخت‌شده، مانده و تفکیک تأمین‌کننده/روز. */
  @Get("purchases")
  async purchases(@Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = this.reportRange(from, to);
    return cachedReport(`purchases|${from || ""}|${to || ""}`, async () => {
      const rows = await this.prisma.purchase.findMany({
        where: { createdAt: { gte: start, lte: end }, voidedAt: null },
        select: { total: true, paidAmount: true, createdAt: true, supplier: { select: { name: true } } },
      });
      const bySupplier = new Map<string, { name: string; total: number; count: number }>();
      const byDay = new Map<string, { day: string; total: number }>();
      let total = 0, paid = 0;
      for (const row of rows) {
        total += row.total; paid += row.paidAmount;
        const key = row.supplier?.name || "—";
        const bucket = bySupplier.get(key) || { name: key, total: 0, count: 0 };
        bucket.total += row.total; bucket.count += 1; bySupplier.set(key, bucket);
        const day = localDay(row.createdAt);
        const dayBucket = byDay.get(day) || { day, total: 0 };
        dayBucket.total += row.total; byDay.set(day, dayBucket);
      }
      return {
        from: start.toISOString(), to: end.toISOString(), invoiceCount: rows.length,
        total, paid, outstanding: Math.max(0, total - paid),
        bySupplier: [...bySupplier.values()].sort((a, b) => b.total - a.total),
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      };
    });
  }

  /** گزارش تخفیف‌ها: تخفیف فاکتور و تخفیف قلم، به تفکیک روز و کالا. */
  @Get("discounts")
  async discounts(@Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = this.reportRange(from, to);
    return cachedReport(`discounts|${from || ""}|${to || ""}`, async () => {
      // Round 40: same flat-two-query shape as the profit report — the
      // nested items include was the whole cost of this endpoint.
      const [rows, lineRows] = await Promise.all([
        this.prisma.sale.findMany({
          where: { createdAt: { gte: start, lte: end }, voidedAt: null },
          select: { id: true, discount: true, createdAt: true },
        }),
        this.prisma.$queryRawUnsafe<Array<{ saleId: string | bigint; name: string; quantity: number; discount: number | bigint }>>(
          `SELECT si."saleId", si."name", si."quantity", si."discount"
           FROM "SaleItem" si
           JOIN "Sale" s ON s."id" = si."saleId"
           WHERE s."createdAt" >= ? AND s."createdAt" <= ? AND s."voidedAt" IS NULL`,
          start.getTime(), end.getTime(),
        ),
      ]);
      const linesBySale = new Map<string, Array<{ name: string; quantity: number; discount: number }>>();
      for (const row of lineRows) {
        const line = { name: String(row.name), quantity: Number(row.quantity), discount: Number(row.discount) };
        const bucket = linesBySale.get(String(row.saleId));
        if (bucket) bucket.push(line);
        else linesBySale.set(String(row.saleId), [line]);
      }
      const byDay = new Map<string, { day: string; total: number }>();
      const perProduct = new Map<string, { name: string; quantity: number; discount: number }>();
      let invoiceDiscount = 0, lineDiscount = 0, invoiceCount = 0;
      for (const row of rows) {
        const items = linesBySale.get(row.id) || [];
        const lineSum = items.reduce((sum, item) => sum + item.discount, 0);
        if (row.discount > 0 || lineSum > 0) {
          invoiceCount += 1;
          const day = localDay(row.createdAt);
          const bucket = byDay.get(day) || { day, total: 0 };
          bucket.total += row.discount + lineSum; byDay.set(day, bucket);
        }
        invoiceDiscount += row.discount; lineDiscount += lineSum;
        for (const item of items) if (item.discount > 0) {
          const bucket = perProduct.get(item.name) || { name: item.name, quantity: 0, discount: 0 };
          bucket.quantity += item.quantity; bucket.discount += item.discount; perProduct.set(item.name, bucket);
        }
      }
      return {
        from: start.toISOString(), to: end.toISOString(),
        invoiceDiscount, lineDiscount, total: invoiceDiscount + lineDiscount, invoiceCount,
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
        topProducts: [...perProduct.values()].sort((a, b) => b.discount - a.discount).slice(0, 12),
      };
    });
  }

  /** گزارش مشتریان: خرید، نسیه و کیف پول به تفکیک مشتری در بازه. */
  @Get("customers")
  async customers(@Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = this.reportRange(from, to);
    return cachedReport(`customers|${from || ""}|${to || ""}`, async () => {
      const rows = await this.prisma.sale.findMany({
        where: { createdAt: { gte: start, lte: end }, voidedAt: null, customerId: { not: null } },
        select: { total: true, creditPart: true, walletPart: true, customerId: true, customer: { select: { name: true, phone: true } } },
      });
      const perCustomer = new Map<string, { name: string; phone: string | null; invoices: number; total: number; credit: number; wallet: number }>();
      for (const row of rows) {
        if (!row.customerId) continue;
        const bucket = perCustomer.get(row.customerId) || { name: row.customer?.name || "—", phone: row.customer?.phone || null, invoices: 0, total: 0, credit: 0, wallet: 0 };
        bucket.invoices += 1; bucket.total += row.total; bucket.credit += row.creditPart; bucket.wallet += row.walletPart;
        perCustomer.set(row.customerId, bucket);
      }
      const byCustomer = [...perCustomer.values()].sort((a, b) => b.total - a.total);
      return {
        from: start.toISOString(), to: end.toISOString(),
        customerCount: byCustomer.length,
        total: byCustomer.reduce((sum, row) => sum + row.total, 0),
        credit: byCustomer.reduce((sum, row) => sum + row.credit, 0),
        byCustomer: byCustomer.slice(0, 50),
      };
    });
  }

  /** گزارش تأمین‌کنندگان: خرید و پرداخت به تفکیک تأمین‌کننده در بازه. */
  @Get("suppliers")
  async suppliers(@Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = this.reportRange(from, to);
    return cachedReport(`suppliers|${from || ""}|${to || ""}`, async () => {
      const rows = await this.prisma.purchase.findMany({
        where: { createdAt: { gte: start, lte: end }, voidedAt: null, supplierId: { not: null } },
        select: { total: true, paidAmount: true, supplierId: true, supplier: { select: { name: true, phone: true } } },
      });
      const perSupplier = new Map<string, { name: string; phone: string | null; invoices: number; total: number; paid: number }>();
      for (const row of rows) {
        if (!row.supplierId) continue;
        const bucket = perSupplier.get(row.supplierId) || { name: row.supplier?.name || "—", phone: row.supplier?.phone || null, invoices: 0, total: 0, paid: 0 };
        bucket.invoices += 1; bucket.total += row.total; bucket.paid += row.paidAmount;
        perSupplier.set(row.supplierId, bucket);
      }
      const bySupplier = [...perSupplier.values()].sort((a, b) => b.total - a.total);
      return {
        from: start.toISOString(), to: end.toISOString(),
        supplierCount: bySupplier.length,
        total: bySupplier.reduce((sum, row) => sum + row.total, 0),
        paid: bySupplier.reduce((sum, row) => sum + row.paid, 0),
        bySupplier: bySupplier.slice(0, 50),
      };
    });
  }

  /** گزارش موجودی انبار: ارزش خرید و فروش، کم‌موجود، ناموجود و انقضا. */
  @Get("inventory")
  async inventory() {
    return cachedReport("inventory", async () => {
      const products = await this.prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true, sku: true, unit: true, stock: true, backstock: true, minStock: true, cost: true, price: true, isBundle: true, expiryDate: true, category: { select: { name: true } } },
      });
      const goods = products.filter((product) => !product.isBundle);
      const expiringCutoff = Date.now() + 14 * 86400000;
      // Batch-tracked goods carry their expiry on live ProductBatch rows, not
      // on the product — the dashboard card already counts both. This report
      // used to read only product.expiryDate, so a batch-tracked item near its
      // date showed on the dashboard (۱) but never in the inventory report (۰).
      // Same suppression rule as the dashboard: live batches count on their
      // own; products WITH live batches skip their product-level date.
      const [liveBatchProducts, expiringBatches] = await Promise.all([
        this.prisma.productBatch.findMany({ where: { remainingQty: { gt: 0 } }, select: { productId: true } }),
        this.prisma.productBatch.findMany({ where: { remainingQty: { gt: 0 }, expiryDate: { lte: new Date(expiringCutoff) } }, select: { remainingQty: true, product: { select: { cost: true } } } }),
      ]);
      const batchProductIds = new Set(liveBatchProducts.map((batch) => batch.productId));
      let stockValue = 0, backstockValue = 0, lowStockCount = 0, outOfStockCount = 0, expiringCount = 0, expiringValue = 0;
      const byCategory = new Map<string, { name: string; count: number; value: number }>();
      for (const product of goods) {
        const value = product.stock * product.cost;
        stockValue += value;
        backstockValue += product.backstock * product.cost;
        if (product.stock <= product.minStock) lowStockCount += 1;
        if (product.stock <= 0) outOfStockCount += 1;
        if (product.expiryDate && product.expiryDate.getTime() <= expiringCutoff && !batchProductIds.has(product.id)) {
          expiringCount += 1;
          expiringValue += product.stock * product.cost;
        }
        const key = product.category?.name || "—";
        const bucket = byCategory.get(key) || { name: key, count: 0, value: 0 };
        bucket.count += 1; bucket.value += (product.stock + product.backstock) * product.cost;
        byCategory.set(key, bucket);
      }
      expiringCount += expiringBatches.length;
      expiringValue += expiringBatches.reduce((sum, batch) => sum + batch.remainingQty * (batch.product?.cost || 0), 0);
      return {
        productCount: goods.length,
        stockValue, backstockValue, totalValue: stockValue + backstockValue,
        lowStockCount, outOfStockCount, expiringCount, expiringValue,
        byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value),
      };
    });
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
