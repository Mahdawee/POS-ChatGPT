import { BadRequestException } from "@nestjs/common";
import { SalesController } from "./sales.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 2, price: 10, isActive: true };

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
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { decrement: 2 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE", quantity: -2, stockAfter: 3 }) }));
  });
});
