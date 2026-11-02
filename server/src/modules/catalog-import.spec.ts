import { ProductsController } from "./catalog.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };

function setup(existing: unknown = null) {
  const tx = {
    product: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "new-1", ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    category: { upsert: jest.fn().mockResolvedValue({ id: "cat-1", name: "نوشیدنی" }) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return { controller: new ProductsController(prisma as never), tx, prisma };
}

describe("Bulk product import", () => {
  it("creates new products and records an initial stock movement", async () => {
    const { controller, tx } = setup();
    const result = await controller.importProducts({ rows: [{ name: "روغن", sku: "O-1", price: 120, stock: 4 }] }, user);
    expect(result).toEqual({ created: 1, updated: 0, errors: [] });
    expect(tx.product.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: "روغن", sku: "O-1", price: 120, stock: 4 }) }));
    expect(tx.inventoryMovement.create).toHaveBeenCalled();
  });

  it("updates an existing product matched by barcode without duplicating it", async () => {
    const existing = { id: "p-1", name: "روغن", sku: "O-1", price: 100, cost: 60, stock: 2, minStock: 0, unit: "عدد", isWeighted: false, expiryDate: null, categoryId: null };
    const { controller, tx } = setup(existing);
    const result = await controller.importProducts({ rows: [{ name: "روغن", barcode: "123", price: 130 }] }, user);
    expect(result).toEqual({ created: 0, updated: 1, errors: [] });
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p-1" }, data: expect.objectContaining({ price: 130 }) }));
    expect(tx.product.create).not.toHaveBeenCalled();
  });

  it("records a stock movement when the import file changes an existing product's stock", async () => {
    const existing = { id: "p-1", name: "روغن", sku: "O-1", price: 100, cost: 60, stock: 2, minStock: 0, unit: "عدد", isWeighted: false, expiryDate: null, categoryId: null };
    const { controller, tx } = setup(existing);
    await controller.importProducts({ rows: [{ name: "روغن", sku: "O-1", stock: 7 }] }, user);
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "ADJUSTMENT_IN", quantity: 5, stockAfter: 7, note: "ورود از فایل" }) }));
    // A stock drop goes the other way (the mock's existing stock stays 2).
    await controller.importProducts({ rows: [{ name: "روغن", sku: "O-1", stock: 1 }] }, user);
    expect(tx.inventoryMovement.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "ADJUSTMENT_OUT", quantity: -1, stockAfter: 1 }) }));
  });

  it("does not write a stock movement when the imported stock is unchanged", async () => {
    const existing = { id: "p-1", name: "روغن", sku: "O-1", price: 100, cost: 60, stock: 2, minStock: 0, unit: "عدد", isWeighted: false, expiryDate: null, categoryId: null };
    const { controller, tx } = setup(existing);
    await controller.importProducts({ rows: [{ name: "روغن", sku: "O-1", price: 130 }] }, user);
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it("collects per-row errors instead of failing the whole import", async () => {
    const { controller } = setup();
    const result = await controller.importProducts({ rows: [{ name: "  " }] }, user);
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
  });
});
