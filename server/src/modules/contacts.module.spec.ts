import { CustomersController, SuppliersController } from "./contacts.module";

function setup() {
  const tx = {
    customer: { findUnique: jest.fn().mockResolvedValue({ id: "customer-1", name: "احمد", isActive: true }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    customerPayment: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "payment-1", ...data })) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    customer: {
      findMany: jest.fn().mockResolvedValue([
        { id: "customer-1", name: "احمد", isActive: true },
        { id: "customer-2", name: "زبیده", isActive: true },
      ]),
    },
    sale: { groupBy: jest.fn().mockResolvedValue([{ customerId: "customer-1", _sum: { total: 500 } }]) },
    saleReturn: { findMany: jest.fn().mockResolvedValue([{ total: 100, sale: { customerId: "customer-1" } }]) },
    customerPayment: { groupBy: jest.fn().mockResolvedValue([{ customerId: "customer-1", _sum: { amount: 150 } }]) },
  };
  return { controller: new CustomersController(prisma as never), tx, prisma };
}

describe("Customer credit balances", () => {
  it("computes balance as credit sales minus returns minus payments per customer", async () => {
    const { controller } = setup();
    const list = (await controller.list()) as Array<{ id: string; balance: number }>;
    const ahmad = list.find((customer) => customer.id === "customer-1");
    const zubeida = list.find((customer) => customer.id === "customer-2");
    expect(ahmad?.balance).toBe(250); // 500 - 100 - 150
    expect(zubeida?.balance).toBe(0); // no credit activity
  });

  it("books a repayment as cash-in on the open session inside one transaction", async () => {
    const { controller, tx } = setup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.pay("customer-1", { amount: 200, note: "قسط نخست" }, user);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "IN", amount: 200, cashSessionId: "cash-1" }) }));
    expect(tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: "customer-1", amount: 200, userId: user.id }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
});

function supplierSetup() {
  const tx = {
    supplier: { findUnique: jest.fn().mockResolvedValue({ id: "supplier-1", name: "تأمین‌کننده نمونه", isActive: true }) },
    supplierPayment: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "payment-1", ...data })) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    supplier: { findMany: jest.fn().mockResolvedValue([{ id: "supplier-1", name: "تأمین‌کننده نمونه", isActive: true }]) },
    purchase: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "supplier-1", _sum: { total: 800, paidAmount: 500 } }]) },
    supplierPayment: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "supplier-1", _sum: { amount: 100 } }]) },
    purchaseReturn: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  return { controller: new SuppliersController(prisma as never), tx, prisma };
}

describe("Supplier balances", () => {
  it("computes balance as purchases minus paid-at-purchase minus later payments", async () => {
    const { controller } = supplierSetup();
    const list = (await controller.list()) as Array<{ id: string; balance: number }>;
    expect(list[0]?.balance).toBe(200); // 800 - 500 - 100
  });

  it("records a supplier payment as bookkeeping only, without touching the cash drawer", async () => {
    const { controller, tx } = supplierSetup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.pay("supplier-1", { amount: 150 }, user);
    expect(tx.supplierPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierId: "supplier-1", amount: 150, userId: user.id }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(tx).not.toHaveProperty("cashMovement");
  });
});
