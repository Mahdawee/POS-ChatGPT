import { BadRequestException } from "@nestjs/common";
import { QuotesController } from "./quotes.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };

function setup(products = [
  { id: "product-1", name: "چای", sku: "T-1", price: 10, cost: 6, wholesalePrice: null, wholesaleMinQty: null, isActive: true },
  { id: "product-2", name: "شکر", sku: "S-1", price: 20, cost: 12, wholesalePrice: 15, wholesaleMinQty: 4, isActive: true },
]) {
  const quoteRow = { id: "quote-1", quoteNo: "QTE-1", status: "OPEN", total: 0, items: [] as unknown[] };
  const tx = {
    product: { findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) => Promise.resolve(products.filter((product) => where.id.in.includes(product.id)))) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    quote: {
      // Resolve with the nested `items.create` flattened, like Prisma does.
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> & { items: { create: unknown[] } } }) => Promise.resolve({ ...quoteRow, ...data, items: data.items.create })),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...quoteRow, status: "CONVERTED", ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const checkout = jest.fn();
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), quote: tx.quote, auditLog: tx.auditLog };
  const controller = new QuotesController(prisma as never, { checkout } as never);
  return { controller, tx, checkout, quoteRow };
}

describe("Quotes", () => {
  it("prices the basket with the same wholesale rule as checkout", async () => {
    const { controller } = setup();
    const quote = (await controller.create({ items: [{ productId: "product-1", quantity: 2 }, { productId: "product-2", quantity: 4 }] }, user)) as { total: number; items: { unitPrice: number; lineTotal: number }[] };
    expect(quote.total).toBe(80); // 2×10 retail + 4×15 wholesale
    expect(quote.items).toEqual([
      expect.objectContaining({ unitPrice: 10, lineTotal: 20 }),
      expect.objectContaining({ unitPrice: 15, lineTotal: 60 }),
    ]);
  });

  it("rejects a quote with an unknown product or an unknown customer", async () => {
    const { controller, tx } = setup();
    await expect(controller.create({ items: [{ productId: "missing", quantity: 1 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
    tx.customer.findUnique.mockResolvedValue(null);
    await expect(controller.create({ items: [{ productId: "product-1", quantity: 1 }], customerId: "ghost" }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("converts an open quote through the shared checkout pipeline and links the sale", async () => {
    const { controller, tx, checkout, quoteRow } = setup();
    tx.quote.findUnique.mockResolvedValue({
      ...quoteRow,
      customerId: "customer-1",
      items: [{ productId: "product-1", quantity: 2 }],
    });
    checkout.mockResolvedValue({ id: "sale-77", total: 20 });
    const updated = (await controller.convert("quote-1", user)) as { status: string; saleId: string };
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CREDIT", customerId: "customer-1" }),
      user,
    );
    expect(updated.status).toBe("CONVERTED");
    expect(updated.saleId).toBe("sale-77");
  });

  it("converts an anonymous quote as a plain cash sale", async () => {
    const { controller, tx, checkout, quoteRow } = setup();
    tx.quote.findUnique.mockResolvedValue({ ...quoteRow, customerId: null, items: [{ productId: "product-1", quantity: 1 }] });
    checkout.mockResolvedValue({ id: "sale-78" });
    await controller.convert("quote-1", user);
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: "CASH" }), user);
  });

  it("refuses to convert or void a quote that is not open", async () => {
    const { controller, tx, quoteRow } = setup();
    tx.quote.findUnique.mockResolvedValue({ ...quoteRow, status: "CONVERTED", items: [{ productId: "product-1", quantity: 1 }] });
    await expect(controller.convert("quote-1", user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.void("quote-1", user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.quote.update).not.toHaveBeenCalled();
  });

  it("voids an open quote without touching checkout", async () => {
    const { controller, tx, quoteRow } = setup();
    tx.quote.findUnique.mockResolvedValue({ ...quoteRow, status: "OPEN" });
    await controller.void("quote-1", user);
    expect(tx.quote.update).toHaveBeenCalledWith({ where: { id: "quote-1" }, data: { status: "VOID" } });
  });
});
