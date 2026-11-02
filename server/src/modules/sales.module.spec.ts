import { BadRequestException } from "@nestjs/common";
import { SalesController } from "./sales.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 2, price: 10, cost: 6, isActive: true };

function setup(stock = 2) {
  const tx = {
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock }]), update: jest.fn().mockResolvedValue({}) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    sale: { create: jest.fn().mockResolvedValue({ id: "sale-1", receiptNo: "POS-1", items: [] }), findUnique: jest.fn().mockResolvedValue(null) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), sale: tx.sale };
  return { controller: new SalesController(prisma as never), tx };
}

describe("POS checkout", () => {
  it("rejects a sale that would take stock below zero before writing anything", async () => {
    const { controller, tx } = setup(2);
    await expect(controller.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "CASH", amountPaid: 30 }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.sale.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it("records the sale and its stock movement inside the same database transaction", async () => {
    const { controller, tx } = setup(5);
    await controller.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", amountPaid: 25 }, user);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 20, total: 20, change: 5 }) }));
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ items: { create: [{ productId: "product-1", name: "چای", sku: "T-1", quantity: 2, unitPrice: 10, unitCost: 6, lineTotal: 20 }] } }) }));
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { decrement: 2 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE", quantity: -2, stockAfter: 3 }) }));
  });
});

const saleFixture = {
  id: "sale-1",
  receiptNo: "POS-1",
  subtotal: 30,
  discount: 5,
  total: 25,
  paymentMethod: "CASH",
  items: [{ id: "item-1", productId: "product-1", name: "چای", sku: "T-1", quantity: 3, unitPrice: 10, unitCost: 6, lineTotal: 30 }],
  returns: [] as { items: { productId: string; quantity: number }[] }[],
};

function returnSetup(sale: typeof saleFixture = saleFixture) {
  const tx = {
    sale: { findUnique: jest.fn().mockResolvedValue(sale) },
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock: 0 }]), update: jest.fn().mockResolvedValue({}) },
    saleReturn: { create: jest.fn().mockImplementation(({ data }: { data: { total: number; returnNo: string } }) => Promise.resolve({ id: "return-1", ...data })) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
  return { controller: new SalesController(prisma as never), tx };
}

describe("Sale returns", () => {
  it("restocks the goods and records a SALE_RETURN movement", async () => {
    const { controller, tx } = returnSetup();
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 2 }] }, user);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { increment: 2 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE_RETURN", quantity: 2, stockAfter: 2 }) }));
    expect(tx.saleReturn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ items: { create: [expect.objectContaining({ unitCost: 6 })] } }) }));
    expect(record.total).toBe(20);
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects returning more than what was sold, including already returned amounts", async () => {
    const { controller, tx } = returnSetup();
    await expect(controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 4 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
    const partially = { ...saleFixture, returns: [{ items: [{ productId: "product-1", quantity: 2 }] }] };
    const second = returnSetup(partially);
    await expect(second.controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 2 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.saleReturn.create).not.toHaveBeenCalled();
  });

  it("refunds the discounted total on a full return and takes cash out of the open session", async () => {
    const { controller, tx } = returnSetup();
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 3 }] }, user);
    expect(record.total).toBe(25); // sale.total after discount, not 30
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 25, cashSessionId: "cash-1" }) }));
  });

  it("rejects a product that was not on the original invoice", async () => {
    const { controller } = returnSetup();
    await expect(controller.returnSale("sale-1", { items: [{ productId: "other", quantity: 1 }] }, user)).rejects.toBeInstanceOf(BadRequestException);
  });
});
