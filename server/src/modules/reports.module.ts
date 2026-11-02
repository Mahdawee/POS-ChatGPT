import { Controller, Get, Module, Query } from "@nestjs/common";
import { AdminOnly } from "../auth";
import { customerBalances, supplierBalances } from "../balances";
import { PrismaService } from "../prisma.service";

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** گزارش سود و تحلیل فروش برای یک بازهٔ زمانی (پیش‌فرض: ۳۰ روز اخیر) */
@AdminOnly()
@Controller("reports")
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** فهرست بدهی‌داران (مشتریان) و بدهی‌ها (تأمین‌کنندگان) با ماندهٔ کل */
  @Get("debtors")
  async debtors() {
    const [customers, suppliers, customerMap, supplierMap] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      this.prisma.supplier.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      customerBalances(this.prisma),
      supplierBalances(this.prisma),
    ]);
    const debtorCustomers = customers.map((customer) => ({ ...customer, balance: customerMap.get(customer.id) || 0 })).filter((customer) => customer.balance > 0).sort((a, b) => b.balance - a.balance);
    const debtorSuppliers = suppliers.map((supplier) => ({ ...supplier, balance: supplierMap.get(supplier.id) || 0 })).filter((supplier) => supplier.balance > 0).sort((a, b) => b.balance - a.balance);
    return {
      customers: debtorCustomers,
      customersTotal: debtorCustomers.reduce((sum, customer) => sum + customer.balance, 0),
      suppliers: debtorSuppliers,
      suppliersTotal: debtorSuppliers.reduce((sum, supplier) => sum + supplier.balance, 0),
    };
  }

  @Get("profit")
  async profit(@Query("from") from?: string, @Query("to") to?: string) {
    const end = to ? new Date(to.length === 10 ? `${to}T23:59:59.999` : to) : new Date();
    if (!to) end.setHours(23, 59, 59, 999);
    const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86400000);
    if (!from) start.setHours(0, 0, 0, 0);
    const range = { gte: start, lte: end };
    const [sales, returns, purchasesAgg, mix] = await Promise.all([
      // Hard cap protects memory on very long ranges; a small shop cannot
      // realistically reach 50k sales inside one report window.
      this.prisma.sale.findMany({ where: { createdAt: range }, take: 50000, include: { items: true } }),
      this.prisma.saleReturn.findMany({ where: { createdAt: range }, include: { items: true } }),
      this.prisma.purchase.aggregate({ _sum: { total: true }, where: { createdAt: range } }),
      this.prisma.sale.groupBy({ by: ["paymentMethod"], _sum: { total: true }, _count: true, where: { createdAt: range } }),
    ]);
    let revenue = 0;
    let refunds = 0;
    let cost = 0;
    let returnsCost = 0;
    let unknownCostRevenue = 0;
    const perDay = new Map<string, { revenue: number; profit: number }>();
    const perProduct = new Map<string, { productId: string; name: string; quantity: number; revenue: number; profit: number }>();
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
      const bucket = perDay.get(day) || { revenue: 0, profit: 0 };
      bucket.revenue += sale.total;
      bucket.profit += saleProfit;
      perDay.set(day, bucket);
    }
    for (const record of returns) {
      refunds += record.total;
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
      bucket.revenue -= record.total;
      bucket.profit -= record.total - returnCost;
      perDay.set(day, bucket);
    }
    const netRevenue = revenue - refunds;
    const netCost = cost - returnsCost;
    const profit = netRevenue - netCost;
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      revenue,
      refunds,
      netRevenue,
      cost: netCost,
      profit,
      margin: netRevenue > 0 ? profit / netRevenue : 0,
      unknownCostRevenue,
      invoiceCount: sales.length,
      purchasesTotal: purchasesAgg._sum.total || 0,
      byDay: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, value]) => ({ day, ...value })),
      topProducts: [...perProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      paymentMix: mix.map((row) => ({ method: row.paymentMethod as string, total: row._sum.total || 0, count: row._count })),
    };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
