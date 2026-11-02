import { ReportsController } from "./reports.module";

const day = (text: string) => new Date(`2026-11-${text}T10:00:00`);

function setup() {
  const prisma = {
    sale: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "sale-1", total: 40, createdAt: day("01"),
          items: [{ productId: "p1", name: "چای", quantity: 2, unitPrice: 10, unitCost: 6, lineTotal: 20 }, { productId: "p2", name: "شکر", quantity: 1, unitPrice: 20, unitCost: 12, lineTotal: 20 }],
        },
        { id: "sale-2", total: 15, createdAt: day("02"), items: [{ productId: "p1", name: "چای", quantity: 1, unitPrice: 15, unitCost: 6, lineTotal: 15 }] },
      ]),
      groupBy: jest.fn().mockResolvedValue([{ paymentMethod: "CASH", _sum: { total: 40 }, _count: 1 }, { paymentMethod: "CREDIT", _sum: { total: 15 }, _count: 1 }]),
    },
    saleReturn: {
      findMany: jest.fn().mockResolvedValue([
        { id: "return-1", total: 10, createdAt: day("02"), items: [{ productId: "p1", name: "چای", quantity: 1, unitPrice: 10, unitCost: 6, lineTotal: 10 }] },
      ]),
    },
    purchase: { aggregate: jest.fn().mockResolvedValue({ _sum: { total: 120 } }) },
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
      { method: "CASH", total: 40, count: 1 },
      { method: "CREDIT", total: 15, count: 1 },
    ]);
  });
});
