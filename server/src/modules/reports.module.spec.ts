import { invalidateReportCache, ReportsController } from "./reports.module";

const day = (text: string) => new Date(`2026-11-${text}T10:00:00`);

function setup() {
  const allSales = [
    {
      id: "sale-1", total: 40, createdAt: day("01"), userId: "user-1", cashSessionId: "session-1",
      items: [{ productId: "p1", name: "چای", quantity: 2, unitPrice: 10, unitCost: 6, lineTotal: 20, product: { categoryId: "cat-1", category: { name: "نوشیدنی" } } }, { productId: "p2", name: "شکر", quantity: 1, unitPrice: 20, unitCost: 12, lineTotal: 20, product: { categoryId: "cat-2", category: { name: "خواربار" } } }],
    },
    { id: "sale-2", total: 15, createdAt: day("02"), userId: "user-2", cashSessionId: "session-2", items: [{ productId: "p1", name: "چای", quantity: 1, unitPrice: 15, unitCost: 6, lineTotal: 15, product: { categoryId: "cat-1", category: { name: "نوشیدنی" } } }] },
  ];
  const prisma = {
    sale: {
      findMany: jest.fn().mockImplementation(({ where }: { where?: { createdAt?: { gte?: Date; lte?: Date } } }) =>
        Promise.resolve(allSales.filter((sale) => (!where?.createdAt?.gte || sale.createdAt >= where.createdAt.gte) && (!where?.createdAt?.lte || sale.createdAt <= where.createdAt.lte)))),
      aggregate: jest.fn().mockResolvedValue({ _sum: { cashPart: 40, mobilePart: 0, creditPart: 15, walletPart: 0 } }),
    },
    saleReturn: {
      findMany: jest.fn().mockResolvedValue([
        { id: "return-1", total: 10, creditRelief: 0, cashAmount: 10, walletRefund: 0, userId: "user-2", createdAt: day("02"), sale: { cashSessionId: "session-2" }, items: [{ productId: "p1", name: "چای", quantity: 1, unitPrice: 10, unitCost: 6, lineTotal: 10, product: { category: { name: "نوشیدنی" } } }] },
      ]),
    },
    purchase: { aggregate: jest.fn().mockResolvedValue({ _sum: { total: 120 } }) },
    expense: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 70 } }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "user-1", displayName: "ادمین" }, { id: "user-2", displayName: "صندوقدار" }]) },
    cashSession: { findMany: jest.fn().mockResolvedValue([{ id: "session-1", userId: "user-1", openedAt: day("01"), closedAt: day("01") }, { id: "session-2", userId: "user-2", openedAt: day("02"), closedAt: null }]) },
  };
  return { controller: new ReportsController(prisma as never), prisma };
}

describe("Profit report", () => {
  it("nets revenue, refunds, cost and returns into a correct gross profit", async () => {
    const { controller } = setup();
    const report = await controller.profit("2026-11-01", "2026-11-30");
    expect(report.revenue).toBe(55);            // 40 + 15
    expect(report.refunds).toBe(10);
    expect(report.netRevenue).toBe(45);
    expect(report.cost).toBe(24);               // (12 + 12 + 6) - 6 returned
    expect(report.profit).toBe(21);             // 45 - 24
    expect(report.margin).toBeCloseTo(21 / 45);
    expect(report.purchasesTotal).toBe(120);
    expect(report.expenses).toBe(70);
    expect(report.netProfit).toBe(-49);         // 21 gross - 70 expenses
    expect(report.invoiceCount).toBe(2);
  });

  it("groups daily buckets and ranks products by revenue", async () => {
    const { controller } = setup();
    const report = await controller.profit("2026-11-01", "2026-11-30");
    expect(report.byDay).toEqual([
      { day: "2026-11-01", revenue: 40, profit: 16 },  // (20-12) + (20-12)
      { day: "2026-11-02", revenue: 5, profit: 5 },    // (15-6) - (10-6)
    ]);
    const tea = report.topProducts.find((product) => product.productId === "p1");
    expect(tea).toMatchObject({ name: "چای", quantity: 2, revenue: 25, profit: 13 }); // 20+15-10 revenue; 8+9-4 profit
    expect(report.topProducts[0].productId).toBe("p1");
    expect(report.paymentMix).toEqual([
      { method: "CASH", total: 40 },
      { method: "MOBILE", total: 0 },
      { method: "CREDIT", total: 15 },
      { method: "WALLET", total: 0 },
    ]);
  });

  it("breaks revenue down per cashier and per register shift, with returns walked back", async () => {
    const { controller } = setup();
    const report = await controller.profit("2026-11-01", "2026-11-30");
    // The return was processed by user-2 on session-2: their slices carry it.
    expect(report.byUser).toEqual([
      { userId: "user-1", cashier: "ادمین", revenue: 40, profit: 16, count: 1 },
      { userId: "user-2", cashier: "صندوقدار", revenue: 5, profit: 5, count: 1 },
    ]);
    expect(report.bySession).toEqual([
      { sessionId: "session-2", cashier: "صندوقدار", openedAt: day("02"), closedAt: null, revenue: 5, count: 1 },
      { sessionId: "session-1", cashier: "ادمین", openedAt: day("01"), closedAt: day("01"), revenue: 40, count: 1 },
    ]);
    // Hourly and category views net the refund out too.
    expect(report.byHour).toEqual([{ hour: 10, revenue: 45, count: 2 }]);
    expect(report.byCategory).toEqual([
      { category: "نوشیدنی", revenue: 25, profit: 13, quantity: 2 },
      { category: "خواربار", revenue: 20, profit: 8, quantity: 1 },
    ]);
  });

  it("compares with the same-length previous window when compare=1", async () => {
    const { controller } = setup();
    const report = (await controller.profit("2026-11-02", "2026-11-03", "1")) as { previous: { revenue: number }; comparison: { revenue: number | null } };
    expect(report.previous.revenue).toBe(40); // only sale-1 falls in the previous window
    expect(report.comparison.revenue).toBe(-62); // 15 vs 40 → (15-40)/40 = -62.5 → -62
  });
});

function debtorsSetup() {
  const prisma = {
    customer: { findMany: jest.fn().mockResolvedValue([
      { id: "c1", name: "احمد", phone: null },
      { id: "c2", name: "زبیده", phone: "070" },
      { id: "c3", name: "نادر", phone: null },
    ]) },
    supplier: { findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "تأمین‌کننده", phone: null }]) },
    sale: { groupBy: jest.fn().mockResolvedValue([{ customerId: "c1", _sum: { creditPart: 500 } }]), findMany: jest.fn().mockResolvedValue([{ customerId: "c1", createdAt: day("01"), creditPart: 500 }]) },
    saleReturn: { findMany: jest.fn().mockResolvedValue([{ creditRelief: 100, createdAt: day("01"), sale: { customerId: "c1" } }]) },
    customerPayment: { groupBy: jest.fn().mockResolvedValue([{ customerId: "c1", _sum: { amount: 150 } }]), findMany: jest.fn().mockResolvedValue([{ customerId: "c1", amount: 150, createdAt: day("01") }]) },
    purchase: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "s1", _sum: { total: 800, paidAmount: 500 } }]) },
    supplierPayment: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "s1", _sum: { amount: 100 } }]) },
    purchaseReturn: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "s1", _sum: { total: 50 } }]) },
  };
  return { controller: new ReportsController(prisma as never), prisma };
}

describe("Debtors report", () => {
  it("does not let an advance payment eat a LATER invoice in the aging buckets", async () => {
    const { controller, prisma } = debtorsSetup();
    // 200 paid on 01-Nov (an advance), the 500 credit sale happens on 05-Nov.
    prisma.sale.findMany.mockResolvedValue([{ customerId: "c1", createdAt: day("05"), creditPart: 500 }]);
    prisma.saleReturn.findMany.mockResolvedValue([]);
    prisma.customerPayment.findMany.mockResolvedValue([{ customerId: "c1", amount: 200, createdAt: day("01") }]);
    prisma.sale.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { creditPart: 500 } }]);
    prisma.customerPayment.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { amount: 200 } }]);
    const report = await controller.debtors();
    // Balance nets the advance (300), but the aging report must show the
    // invoice itself still open (500) — it did not exist when the money came.
    expect(report.customers[0].balance).toBe(300);
    expect(report.customers[0].aging.d30).toBe(500);
    expect(report.customers[0].aging.d30 + report.customers[0].aging.d60 + report.customers[0].aging.older).toBe(500);
  });

  it("lists only customers and suppliers with a positive balance, sorted by debt", async () => {
    const { controller } = debtorsSetup();
    const report = await controller.debtors();
    expect(report.customers).toEqual([{ id: "c1", name: "احمد", phone: null, balance: 250, aging: expect.objectContaining({}) }]);
    expect(report.customers[0].aging.d30 + report.customers[0].aging.d60 + report.customers[0].aging.older).toBe(250);
    expect(report.customersTotal).toBe(250);
    expect(report.suppliers).toEqual([{ id: "s1", name: "تأمین‌کننده", phone: null, balance: 150 }]);
    expect(report.suppliersTotal).toBe(150); // 800 - 500 paid - 100 payments - 50 returned goods
  });
});

describe("Profit report cache", () => {
  it("serves an identical range from memory and recomputes after invalidation", async () => {
    invalidateReportCache(); // clean slate — earlier tests may have warmed the key
    const { controller, prisma } = setup();
    const first = await controller.profit("2026-11-01", "2026-11-30");
    const second = await controller.profit("2026-11-01", "2026-11-30");
    expect(second).toEqual(first);
    expect(prisma.sale.findMany).toHaveBeenCalledTimes(1); // second call was cached
    // A write (any non-GET request clears the cache) forces a full recompute.
    invalidateReportCache();
    await controller.profit("2026-11-01", "2026-11-30");
    expect(prisma.sale.findMany).toHaveBeenCalledTimes(2);
    // A different range never shares the cached entry.
    await controller.profit("2026-11-02", "2026-11-30");
    expect(prisma.sale.findMany).toHaveBeenCalledTimes(3);
  });
});
