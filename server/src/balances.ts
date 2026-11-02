import { PrismaService } from "./prisma.service";

/**
 * Outstanding credit per customer: credit sales − credit returns − payments.
 * Computed over ALL customers (active and deactivated); callers filter.
 */
export async function customerBalances(prisma: PrismaService): Promise<Map<string, number>> {
  const [creditSales, creditReturns, payments] = await Promise.all([
    prisma.sale.groupBy({ by: ["customerId"], _sum: { total: true }, where: { paymentMethod: "CREDIT" } }),
    prisma.saleReturn.findMany({ where: { sale: { paymentMethod: "CREDIT" } }, select: { total: true, sale: { select: { customerId: true } } } }),
    prisma.customerPayment.groupBy({ by: ["customerId"], _sum: { amount: true } }),
  ]);
  const balance = new Map<string, number>();
  for (const row of creditSales) if (row.customerId) balance.set(row.customerId, (balance.get(row.customerId) || 0) + (row._sum.total || 0));
  for (const row of creditReturns) if (row.sale.customerId) balance.set(row.sale.customerId, (balance.get(row.sale.customerId) || 0) - row.total);
  for (const row of payments) balance.set(row.customerId, (balance.get(row.customerId) || 0) - (row._sum.amount || 0));
  return balance;
}

/**
 * Outstanding debt per supplier: purchases − paid at purchase − later payments.
 */
export async function supplierBalances(prisma: PrismaService): Promise<Map<string, number>> {
  const [purchases, payments] = await Promise.all([
    prisma.purchase.groupBy({ by: ["supplierId"], _sum: { total: true, paidAmount: true }, where: { supplierId: { not: null } } }),
    prisma.supplierPayment.groupBy({ by: ["supplierId"], _sum: { amount: true } }),
  ]);
  const balance = new Map<string, number>();
  for (const row of purchases) if (row.supplierId) balance.set(row.supplierId, (balance.get(row.supplierId) || 0) + (row._sum.total || 0) - (row._sum.paidAmount || 0));
  for (const row of payments) balance.set(row.supplierId, (balance.get(row.supplierId) || 0) - (row._sum.amount || 0));
  return balance;
}
