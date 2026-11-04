import { BadRequestException } from "@nestjs/common";
import { PurchaseReturnsController, PurchasesController } from "./purchases.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 2, cost: 10, price: 15, isActive: true };

function setup() {
  const created: Record<string, unknown> = { id: "purchase-1", total: 0, items: [] };
  const tx = {
    product: { findMany: jest.fn().mockResolvedValue([{ ...product }]), update: jest.fn().mockResolvedValue({}) },
    supplier: { findUnique: jest.fn().mockResolvedValue({ id: "supplier-1", name: "تأمین‌کننده" }) },
    purchase: { create: jest.fn().mockImplementation(({ data }: { data: { total: number } }) => { created.total = data.total; return Promise.resolve({ ...created, total: data.total }); }) },
    productBatch: { create: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), purchase: tx.purchase };
  return { controller: new PurchasesController(prisma as never), tx };
}

describe("Purchases", () => {
  it("windows, date-filters and sorts the receipt history", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const controller = new PurchasesController({ purchase: { findMany } } as never);
    await controller.list("20", "10", "2026-01-01", "2026-01-31", "total", "asc");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 10,
      where: { createdAt: { gte: new Date("2026-01-01"), lte: new Date("2026-01-31T23:59:59.999") } },
      orderBy: { total: "asc" },
    }));
    // No filters → the default newest-first window with an empty where.
    await controller.list(undefined, undefined, undefined, undefined, "bogus", "asc");
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: {}, orderBy: { createdAt: "asc" } }));
    // Unparsable dates are ignored instead of poisoning the query.
    await controller.list(undefined, undefined, "not-a-date", "garbage", undefined, undefined);
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }));
  });

  it("increments stock, refreshes cost and records a PURCHASE movement in one transaction", async () => {
    const { controller, tx } = setup();
    await controller.create({ items: [{ productId: "product-1", quantity: 5, unitCost: 12 }], supplierId: "supplier-1" }, user);
    expect(tx.purchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ total: 60, supplierId: "supplier-1" }) }));
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { increment: 5 }, cost: 12 } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "PURCHASE", quantity: 5, stockAfter: 7 }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("tracks a delivery with its own expiry date as a batch (lot)", async () => {
    const { controller, tx } = setup();
    await controller.create({ items: [{ productId: "product-1", quantity: 5, unitCost: 12, expiryDate: "2026-12-01" }], supplierId: "supplier-1" }, user);
    expect(tx.productBatch.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ productId: "product-1", initialQty: 5, remainingQty: 5, expiryDate: new Date("2026-12-01T00:00:00.000Z") }) }));
    expect(tx.purchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ items: { create: [expect.objectContaining({ expiryDate: new Date("2026-12-01T00:00:00.000Z") })] } }) }));
    // No expiry on the line → no batch row, item keeps a null expiry.
    await controller.create({ items: [{ productId: "product-1", quantity: 2, unitCost: 10 }] }, user);
    expect(tx.productBatch.create).toHaveBeenCalledTimes(1);
  });

  it("rounds stray fractional counts of countable goods to whole units (round-30 stepper repair)", async () => {
    const { controller, tx } = setup();
    await controller.create({ items: [{ productId: "product-1", quantity: 5.002, unitCost: 12 }] }, user);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { increment: 5 }, cost: 12 } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ quantity: 5, stockAfter: 7 }) }));
  });

  it("merges duplicated lines for the same product before writing", async () => {
    const { controller, tx } = setup();
    await controller.create({ items: [{ productId: "product-1", quantity: 2, unitCost: 10 }, { productId: "product-1", quantity: 3, unitCost: 10 }] }, user);
    expect(tx.purchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ total: 50 }) }));
    expect(tx.product.update).toHaveBeenCalledTimes(1);
  });

  it("refuses to buy a bundle — kits are assembled from components, their own stock is never real", async () => {
    const { controller, tx } = setup();
    tx.product.findMany.mockResolvedValue([{ ...product, isBundle: true }]);
    await expect(controller.create({ items: [{ productId: "product-1", quantity: 1, unitCost: 10 }] }, user)).rejects.toThrow(/بسته است و خریدنی نیست/);
    expect(tx.purchase.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("rejects a purchase containing an unknown or archived product", async () => {
    const { controller, tx } = setup();
    tx.product.findMany.mockResolvedValue([]);
    await expect(controller.create({ items: [{ productId: "missing", quantity: 1, unitCost: 5 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.purchase.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown supplier", async () => {
    const { controller, tx } = setup();
    tx.supplier.findUnique.mockResolvedValue(null);
    await expect(controller.create({ items: [{ productId: "product-1", quantity: 1, unitCost: 5 }], supplierId: "missing" }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.purchase.create).not.toHaveBeenCalled();
  });

  it("defaults to fully paid and clamps overpayment to the purchase total", async () => {
    const { controller, tx } = setup();
    await controller.create({ items: [{ productId: "product-1", quantity: 5, unitCost: 12 }] }, user);
    expect(tx.purchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ total: 60, paidAmount: 60 }) }));
    await controller.create({ items: [{ productId: "product-1", quantity: 5, unitCost: 12 }], paidAmount: 999999 }, user);
    expect(tx.purchase.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ total: 60, paidAmount: 60 }) }));
    await controller.create({ items: [{ productId: "product-1", quantity: 5, unitCost: 12 }], paidAmount: 20 }, user);
    expect(tx.purchase.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ total: 60, paidAmount: 20 }) }));
  });
});

function returnSetup() {
  const product = { id: "product-1", name: "چای", sku: "T-1", stock: 8, cost: 10, price: 15, isActive: true };
  const tx = {
    product: { findMany: jest.fn().mockResolvedValue([{ ...product }]), update: jest.fn().mockResolvedValue({}) },
    supplier: { findUnique: jest.fn().mockResolvedValue({ id: "supplier-1", name: "تأمین‌کننده" }) },
    purchase: { findUnique: jest.fn().mockResolvedValue({ supplierId: "supplier-1" }) },
    purchaseReturn: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "return-1", ...data })) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    serialUnit: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
  return { controller: new PurchaseReturnsController(prisma as never), tx };
}

describe("Purchase returns", () => {
  it("decrements stock, records a PURCHASE_RETURN movement and settles the supplier account", async () => {
    const { controller, tx } = returnSetup();
    const record = (await controller.createReturn({ purchaseId: "purchase-1", items: [{ productId: "product-1", quantity: 5 }] }, user)) as { total: number; supplierId: string | null };
    expect(record.total).toBe(50); // 5 × cost 10
    expect(record.supplierId).toBe("supplier-1");
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { decrement: 5 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "PURCHASE_RETURN", quantity: 5, stockAfter: 3 }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects a return larger than the stock on hand", async () => {
    const { controller, tx } = returnSetup();
    await expect(controller.createReturn({ items: [{ productId: "product-1", quantity: 9 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.purchaseReturn.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown product", async () => {
    const { controller, tx } = returnSetup();
    tx.product.findMany.mockResolvedValue([]);
    await expect(controller.createReturn({ items: [{ productId: "missing", quantity: 1 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires the exact serials of serialized units going back to the supplier and marks them RETURNED", async () => {
    const { controller, tx } = returnSetup();
    tx.product.findMany.mockResolvedValue([{ ...product, isSerialized: true }]);
    tx.serialUnit = { findMany: jest.fn().mockResolvedValue([{ serial: "IMEI-1", productId: "product-1", status: "IN_STOCK" }, { serial: "IMEI-2", productId: "product-1", status: "IN_STOCK" }]), update: jest.fn().mockResolvedValue({}) };
    // Missing serials → refused before anything is written.
    await expect(controller.createReturn({ items: [{ productId: "product-1", quantity: 2 }] }, user)).rejects.toThrow(/سریال\/IMEI هر دستگاه/);
    expect(tx.purchaseReturn.create).not.toHaveBeenCalled();
    // Wrong count → refused too.
    await expect(controller.createReturn({ items: [{ productId: "product-1", quantity: 2, serials: ["IMEI-1"] }] }, user)).rejects.toThrow(/سریال\/IMEI هر دستگاه/);
    // A unit that already left the shop cannot be returned again.
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-1", productId: "product-1", status: "IN_STOCK" }, { serial: "IMEI-2", productId: "product-1", status: "SOLD" }]);
    await expect(controller.createReturn({ items: [{ productId: "product-1", quantity: 2, serials: ["IMEI-1", "IMEI-2"] }] }, user)).rejects.toThrow(/IMEI-2 در انبار نیست/);
    expect(tx.purchaseReturn.create).not.toHaveBeenCalled();
    // The happy path: both units leave the tracked stock for good.
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-1", productId: "product-1", status: "IN_STOCK" }, { serial: "IMEI-2", productId: "product-1", status: "IN_STOCK" }]);
    await controller.createReturn({ items: [{ productId: "product-1", quantity: 2, serials: ["IMEI-1", "IMEI-2"] }] }, user);
    expect(tx.serialUnit.update).toHaveBeenCalledTimes(2);
    expect(tx.serialUnit.update).toHaveBeenCalledWith(expect.objectContaining({ where: { serial: "IMEI-1" }, data: expect.objectContaining({ status: "RETURNED" }) }));
  });
});
