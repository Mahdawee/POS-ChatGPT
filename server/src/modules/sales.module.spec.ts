import { BadRequestException } from "@nestjs/common";
import { SalesController } from "./sales.module";
import { CheckoutService } from "../services/checkout";
import type { SaleDto } from "../dto";

const admin = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const cashier = { id: "user-2", username: "cashier", displayName: "Cashier", role: "CASHIER" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 2, price: 10, cost: 6, isActive: true, backstock: 0, reserved: 0, isBundle: false, isSerialized: false };

function setup(stock = 2) {
  const tx = {
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock }]), update: jest.fn().mockResolvedValue({}) },
    customer: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    sale: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditPart: null } }), create: jest.fn().mockResolvedValue({ id: "sale-1", receiptNo: "POS-1", items: [] }), findUnique: jest.fn().mockResolvedValue(null) },
    saleReturn: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditRelief: null } }) },
    customerPayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    setting: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    productBatch: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    bundleComponent: { findMany: jest.fn().mockResolvedValue([]) },
    serialUnit: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    sale: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn(), findMany: jest.fn() },
  };
  const service = new CheckoutService(prisma as never);
  return { controller: new SalesController(prisma as never, service), service, tx, prisma };
}

describe("POS checkout", () => {
  it("rejects a sale that would take stock below zero before writing anything", async () => {
    const { service, tx } = setup(2);
    await expect(service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "CASH", amountPaid: 30 }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.sale.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it("switches the line to the wholesale price once quantity reaches the wholesale minimum", async () => {
    const { service, tx } = setup(10);
    tx.product.findMany.mockResolvedValue([{ ...product, stock: 10, wholesalePrice: 8, wholesaleMinQty: 5 }]);
    await service.checkout({ items: [{ productId: "product-1", quantity: 6 }], paymentMethod: "CASH", amountPaid: 48 }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 48, total: 48, change: 0, items: { create: [expect.objectContaining({ unitPrice: 8, lineTotal: 48 })] } }) }));
    // Below the minimum the retail price applies, wholesale fields or not.
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", amountPaid: 20 }, admin);
    expect(tx.sale.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 20, items: { create: [expect.objectContaining({ unitPrice: 10 })] } }) }));
  });

  it("records the sale and its stock movement inside the same database transaction", async () => {
    const { service, tx } = setup(5);
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", amountPaid: 25 }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 20, total: 20, change: 5, cashPart: 20, mobilePart: 0, creditPart: 0 }) }));
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ items: { create: [{ productId: "product-1", name: "چای", sku: "T-1", quantity: 2, unitPrice: 10, unitCost: 6, discount: 0, lineTotal: 20 }] } }) }));
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { decrement: 2 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE", quantity: -2, stockAfter: 3 }) }));
  });

  it("splits a mixed payment into cash, mobile and credit parts", async () => {
    const { service, tx } = setup(5);
    tx.customer.findUnique.mockResolvedValue({ id: "customer-1", name: "احمد", creditLimit: 0 });
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CREDIT", splitCash: 8, splitMobile: 7, customerId: "customer-1" }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cashPart: 8, mobilePart: 7, creditPart: 5, paymentMethod: "CREDIT", amountPaid: 15, change: 0, cashSessionId: "cash-1" }) }));
  });

  it("keeps a full-credit sale bookkeeping-only (no payment row, no drawer movement)", async () => {
    const { service, tx } = setup(5);
    tx.customer.findUnique.mockResolvedValue({ id: "customer-1", name: "احمد", creditLimit: 0 });
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CREDIT", amountPaid: 0, customerId: "customer-1" }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cashPart: 0, mobilePart: 0, creditPart: 20, cashSessionId: undefined }) }));
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("treats a credit sale's down-payment as its cash part tied to the open register", async () => {
    const { service, tx } = setup(5);
    tx.customer.findUnique.mockResolvedValue({ id: "customer-1", name: "احمد", creditLimit: 0 });
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CREDIT", amountPaid: 10, customerId: "customer-1" }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cashPart: 10, creditPart: 10, cashSessionId: "cash-1" }) }));
    expect(tx.cashMovement.create).not.toHaveBeenCalled(); // tracked via cashPart on the session, not a manual movement
  });

  it("blocks a credit sale above the customer's limit unless an admin overrides", async () => {
    const { service, tx } = setup(5);
    tx.customer.findUnique.mockResolvedValue({ id: "customer-1", name: "احمد", creditLimit: 30 });
    tx.sale.aggregate.mockResolvedValue({ _sum: { creditPart: 25 } }); // existing debt
    const dto: SaleDto = { items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CREDIT", amountPaid: 0, customerId: "customer-1" };
    await expect(service.checkout(dto, cashier)).rejects.toThrow("سقف اعتبار");
    await expect(service.checkout({ ...dto, overrideCreditLimit: true }, cashier)).rejects.toBeInstanceOf(BadRequestException); // override is admin-only
    await service.checkout({ ...dto, overrideCreditLimit: true }, admin); // admin override passes
    expect(tx.sale.create).toHaveBeenCalledTimes(1);
  });

  it("applies a per-line discount and a percentage invoice discount (never both)", async () => {
    const { service, tx } = setup(5);
    await service.checkout({ items: [{ productId: "product-1", quantity: 2, discount: 4 }], paymentMethod: "CASH" }, admin);
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 16, discount: 0, total: 16, items: { create: [expect.objectContaining({ discount: 4, lineTotal: 16 })] } }) }));
    await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", discountPercent: 10 }, admin);
    expect(tx.sale.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ subtotal: 20, discount: 2, total: 18 }) }));
  });

  it("numbers invoices per day from the Setting counter and skips restored-backup collisions", async () => {
    const { service, tx } = setup(5);
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const counterKey = `invoiceSeq:${ymd}`;
    tx.setting.findUnique.mockResolvedValue({ key: counterKey, value: "3" });
    await service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH" }, admin);
    expect(tx.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: counterKey }, create: { key: counterKey, value: "4" } }));
    expect(tx.sale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ invoiceNo: `INV-${ymd}-0004` }) }));
    // A restored backup rewound the counter: the colliding number is skipped.
    tx.sale.findUnique.mockImplementation(({ where }: { where: { invoiceNo?: string } }) => Promise.resolve(where.invoiceNo === `INV-${ymd}-0004` ? { id: "old-sale" } : null));
    await service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH" }, admin);
    expect(tx.sale.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ invoiceNo: `INV-${ymd}-0005` }) }));
    expect(tx.setting.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ create: { key: counterKey, value: "5" } }));
  });

  it("deducts tracked batches FEFO (first-expiry-first-out) without gating the sale", async () => {
    const { service, tx } = setup(10);
    tx.productBatch.findMany.mockResolvedValue([
      { id: "batch-1", productId: "product-1", expiryDate: new Date("2026-02-01"), initialQty: 5, remainingQty: 5 },
      { id: "batch-2", productId: "product-1", expiryDate: new Date("2026-03-01"), initialQty: 5, remainingQty: 5 },
    ]);
    await service.checkout({ items: [{ productId: "product-1", quantity: 7 }], paymentMethod: "CASH" }, admin);
    expect(tx.productBatch.update).toHaveBeenCalledTimes(2);
    expect(tx.productBatch.update).toHaveBeenNthCalledWith(1, { where: { id: "batch-1" }, data: { remainingQty: { decrement: 5 } } });
    expect(tx.productBatch.update).toHaveBeenNthCalledWith(2, { where: { id: "batch-2" }, data: { remainingQty: { decrement: 2 } } });
  });

  it("replays the original receipt when the same idempotency key arrives again", async () => {
    const { service, prisma, tx } = setup(5);
    const first = { id: "sale-9", receiptNo: "POS-9", items: [] };
    prisma.sale.findUnique.mockResolvedValue(first);
    const replayed = await service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH" }, admin, "key-1");
    expect(replayed).toBe(first);
    expect(tx.sale.create).not.toHaveBeenCalled(); // no double charge, no stock movement
  });
});

const saleFixture = {
  id: "sale-1",
  receiptNo: "POS-1",
  invoiceNo: "INV-20260101-0001",
  subtotal: 30,
  discount: 5,
  total: 25,
  amountPaid: 25,
  change: 0,
  cashPart: 25,
  mobilePart: 0,
  creditPart: 0,
  walletPart: 0,
  paymentMethod: "CASH",
  items: [{ id: "item-1", productId: "product-1", name: "چای", sku: "T-1", quantity: 3, unitPrice: 10, unitCost: 6, lineTotal: 30, discount: 0 }],
  returns: [] as { total: number; creditRelief: number; cashAmount: number; items: { productId: string; quantity: number }[] }[],
};

function returnSetup(sale: typeof saleFixture = saleFixture) {
  const tx = {
    sale: { findUnique: jest.fn().mockResolvedValue(sale) },
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock: 0 }]), update: jest.fn().mockResolvedValue({}) },
    saleReturn: { create: jest.fn().mockImplementation(({ data }: { data: { total: number; returnNo: string } }) => Promise.resolve({ id: "return-1", ...data })) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
    customer: { update: jest.fn().mockResolvedValue({}) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
  const service = new CheckoutService(prisma as never);
  return { controller: new SalesController(prisma as never, service), tx };
}

describe("Sale returns", () => {
  it("restocks the goods and records a SALE_RETURN movement", async () => {
    const { controller, tx } = returnSetup();
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 2 }] }, admin);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: { increment: 2 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE_RETURN", quantity: 2, stockAfter: 2 }) }));
    expect(tx.saleReturn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ items: { create: [expect.objectContaining({ unitCost: 6 })] } }) }));
    expect(record.total).toBe(20);
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects returning more than what was sold, including already returned amounts", async () => {
    const { controller, tx } = returnSetup();
    await expect(controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 4 }] }, admin)).rejects.toBeInstanceOf(BadRequestException);
    const partially = { ...saleFixture, returns: [{ total: 20, creditRelief: 0, cashAmount: 20, items: [{ productId: "product-1", quantity: 2 }] }] };
    const second = returnSetup(partially);
    await expect(second.controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 2 }] }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.saleReturn.create).not.toHaveBeenCalled();
  });

  it("refunds the discounted total on a full return and takes cash out of the open session", async () => {
    const { controller, tx } = returnSetup();
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 3 }] }, admin);
    expect(record.total).toBe(25); // sale.total after discount, not 30
    expect(record.cashAmount).toBe(25);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 25, cashSessionId: "cash-1" }) }));
  });

  it("never refunds more than the customer paid across two returns of a discounted invoice", async () => {
    // Invoice: subtotal 30, discount 5, paid 25. A partial return first
    // refunds the undiscounted line price (10); the completing return must
    // then refund only the remaining 15 — not the full 25 again.
    const partially = { ...saleFixture, returns: [{ total: 10, creditRelief: 0, cashAmount: 10, items: [{ productId: "product-1", quantity: 1 }] }] };
    const { controller } = returnSetup(partially);
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 2 }] }, admin);
    expect(record.total).toBe(15); // 25 paid − 10 already refunded
  });

  it("caps a partial return at what is still refundable of the paid amount", async () => {
    // Subtotal 30 with a 15 discount = 15 paid. After a first partial refund
    // of 10, the undiscounted price of the next item (10) would exceed the
    // un-refunded remainder (5) — the cap wins.
    const discounted = { ...saleFixture, discount: 15, total: 15, cashPart: 15, returns: [{ total: 10, creditRelief: 0, cashAmount: 10, items: [{ productId: "product-1", quantity: 1 }] }] };
    const { controller } = returnSetup(discounted);
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 1 }] }, admin);
    expect(record.total).toBe(5);
  });

  it("relieves the open credit of a full return and refunds only the cash down-payment", async () => {
    // 5 paid in cash at checkout, 20 on credit. Returning everything refunds
    // the 5 and clears the 20 of debt; only 5 may leave the drawer.
    const creditSale = { ...saleFixture, amountPaid: 5, cashPart: 5, creditPart: 20, paymentMethod: "CREDIT", returns: [] };
    const { controller, tx } = returnSetup(creditSale);
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 3 }] }, admin);
    expect(record.total).toBe(5);
    expect(record.creditRelief).toBe(20);
    expect(record.cashAmount).toBe(5);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 5 }) }));
  });

  it("refunds a WALLET sale back to the customer's wallet", async () => {
    // Entirely paid from the prepaid balance: a partial return must go back
    // to the wallet (no drawer move). Regression test: paidPart used to omit
    // walletPart, so the refund ceiling was 0 and nothing came back.
    const walletSale = { ...saleFixture, customerId: "customer-1", amountPaid: 25, cashPart: 0, mobilePart: 0, walletPart: 25, paymentMethod: "WALLET", returns: [] };
    const { controller, tx } = returnSetup(walletSale);
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 1 }] }, admin);
    expect(record.total).toBe(10);
    expect(record.cashAmount).toBe(0);
    expect(record.walletRefund).toBe(10);
    expect(tx.customerWalletTxn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "REFUND", amount: 10 }) }));
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: "customer-1" }, data: { walletBalance: { increment: 10 } } });
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("relieves a partial return of a full-credit sale at the returned line value", async () => {
    const creditSale = { ...saleFixture, amountPaid: 0, cashPart: 0, creditPart: 25, paymentMethod: "CREDIT", returns: [] };
    const { controller, tx } = returnSetup(creditSale);
    const record = await controller.returnSale("sale-1", { items: [{ productId: "product-1", quantity: 1 }] }, admin);
    expect(record.total).toBe(0); // nothing was ever paid back in money
    expect(record.creditRelief).toBe(10); // the returned good's price leaves the debt
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("rejects a product that was not on the original invoice", async () => {
    const { controller } = returnSetup();
    await expect(controller.returnSale("sale-1", { items: [{ productId: "other", quantity: 1 }] }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });
});
