import { BadRequestException } from "@nestjs/common";
import { CheckoutService } from "../services/checkout";
import { InstallmentsController } from "./installments.module";
import { OrdersController } from "./orders.module";
import { InventoryController } from "./inventory.module";
import { SettingsController } from "./settings.module";
import { nextScheduledRun } from "./backup-scheduler";

const admin = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };

type ProductFixture = {
  id: string; name: string; sku: string; cost: number; price: number;
  wholesalePrice: number | null; wholesaleMinQty: number | null;
  stock: number; reserved: number; isBundle: boolean; isSerialized: boolean; isActive: boolean;
};
const product = (overrides: Partial<ProductFixture> = {}): ProductFixture => ({
  id: "product-1", name: "چای", sku: "T-1", cost: 6, price: 10, wholesalePrice: 8, wholesaleMinQty: 5,
  stock: 20, reserved: 0, isBundle: false, isSerialized: false, isActive: true, ...overrides,
});

/**
 * Prisma stand-in for checkout tests: products + customer + serials +
 * bundle components, with write spies. `sale.create` echoes its input so
 * assertions can inspect the persisted row.
 */
function checkoutSetup(products: ProductFixture[], options: { customer?: Record<string, unknown> | null; serialUnits?: Array<Record<string, unknown>>; components?: Array<{ bundleId: string; componentId: string; quantity: number }> } = {}) {
  const saleCreate = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    const created = (data.items as { create: Array<Record<string, unknown>> })?.create || [];
    return Promise.resolve({ ...data, id: "sale-1", receiptNo: "POS-1", items: created.map((row, index) => ({ id: `item-${index}`, ...row })) });
  });
  const bundleFindMany = jest.fn().mockImplementation(({ where }: { where: { bundleId: string } }) => {
    const rows = (options.components || []).filter((row) => row.bundleId === where.bundleId);
    return Promise.resolve(rows.map((row) => ({ ...row, component: products.find((p) => p.id === row.componentId) })));
  });
  const productFindMany = jest.fn().mockImplementation(({ where }: { where?: { id?: { in: string[] } } }) =>
    Promise.resolve(where?.id?.in ? products.filter((row) => where.id!.in.includes(row.id)) : products));
  const tx = {
    product: {
      findMany: productFindMany,
      update: jest.fn().mockResolvedValue({}),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue(options.customer === undefined ? null : options.customer),
      update: jest.fn().mockResolvedValue({}),
    },
    sale: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditPart: null } }), create: saleCreate, findUnique: jest.fn().mockResolvedValue(null) },
    saleReturn: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditRelief: null } }) },
    customerPayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    setting: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    productBatch: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    bundleComponent: { findMany: bundleFindMany },
    serialUnit: { findMany: jest.fn().mockResolvedValue(options.serialUnits || []), update: jest.fn().mockResolvedValue({}) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), sale: { findUnique: jest.fn().mockResolvedValue(null) } };
  const service = new CheckoutService(prisma as never);
  return { service, tx, prisma };
}

describe("Round 16 — checkout wallet/tier/bundle/serial/reserved", () => {
  it("pays from the customer wallet and books a wallet transaction", async () => {
    const { service, tx } = checkoutSetup([product()], { customer: { id: "customer-1", creditLimit: 0, tier: "RETAIL", walletBalance: 500 } });
    const sale = (await service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "WALLET", customerId: "customer-1" }, admin)) as Record<string, unknown>;
    expect(sale.total).toBe(30);
    expect(sale.walletPart).toBe(30);
    expect(sale.paymentMethod).toBe("WALLET");
    expect(tx.customer.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ walletBalance: { decrement: 30 } }) }));
    expect(tx.customerWalletTxn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE", amount: 30, customerId: "customer-1" }) }));
    // Wallet sales never open the drawer.
    expect(tx.cashSession.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a wallet payment above the balance and without a customer", async () => {
    const poor = checkoutSetup([product()], { customer: { id: "customer-1", creditLimit: 0, tier: "RETAIL", walletBalance: 5 } });
    await expect(poor.service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "WALLET", customerId: "customer-1" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    const anonymous = checkoutSetup([product()]);
    await expect(anonymous.service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "WALLET" }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("WHOLESALE-tier customers get the wholesale price at any quantity", async () => {
    const { service, tx } = checkoutSetup([product()], { customer: { id: "customer-1", creditLimit: 0, tier: "WHOLESALE", walletBalance: 0 } });
    const sale = (await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", customerId: "customer-1", amountPaid: 100 }, admin)) as Record<string, unknown>;
    expect(sale.total).toBe(16); // 2 × 8 wholesale, not 2 × 10
    expect((sale.items as Array<{ unitPrice: number }>)[0]?.unitPrice).toBe(8);
    void tx;
  });

  it("RETAIL keeps the minimum-quantity rule for the wholesale price", async () => {
    const { service } = checkoutSetup([product()], { customer: { id: "customer-1", creditLimit: 0, tier: "RETAIL", walletBalance: 0 } });
    const sale = (await service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", customerId: "customer-1", amountPaid: 100 }, admin)) as Record<string, unknown>;
    expect(sale.total).toBe(20);
  });

  it("selling a bundle deducts its components, not the bundle itself", async () => {
    const bundle = product({ id: "bundle-1", name: "بستهٔ چای", isBundle: true, stock: 0 });
    const tea = product({ id: "product-1", stock: 10 });
    const sugar = product({ id: "product-2", name: "شکر", sku: "S-1", stock: 4 });
    const { service, tx } = checkoutSetup([bundle, tea, sugar], { components: [{ bundleId: "bundle-1", componentId: "product-1", quantity: 2 }, { bundleId: "bundle-1", componentId: "product-2", quantity: 1 }] });
    await service.checkout({ items: [{ productId: "bundle-1", quantity: 3 }], paymentMethod: "CASH" }, admin);
    const updates = (tx.product.update as jest.Mock).mock.calls.map((call) => call[0]);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: { id: "product-1" }, data: { stock: { decrement: 6 } } }),
      expect.objectContaining({ where: { id: "product-2" }, data: { stock: { decrement: 3 } } }),
    ]));
    expect(updates.find((call) => call.where?.id === "bundle-1")).toBeUndefined();
  });

  it("rejects a bundle sale when a component is short", async () => {
    const bundle = product({ id: "bundle-1", isBundle: true });
    const tea = product({ id: "product-1", stock: 2 });
    const { service } = checkoutSetup([bundle, tea], { components: [{ bundleId: "bundle-1", componentId: "product-1", quantity: 2 }] });
    await expect(service.checkout({ items: [{ productId: "bundle-1", quantity: 2 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/جزء/);
  });

  it("serialized products require one in-stock serial per unit and flip them to SOLD", async () => {
    const phone = product({ id: "phone-1", name: "گوشی", isSerialized: true, stock: 2 });
    const serials = [
      { serial: "IMEI-1", productId: "phone-1", status: "IN_STOCK", saleItemId: null },
      { serial: "IMEI-2", productId: "phone-1", status: "IN_STOCK", saleItemId: null },
    ];
    const missing = checkoutSetup([phone], { serialUnits: serials });
    await expect(missing.service.checkout({ items: [{ productId: "phone-1", quantity: 1 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/سریال/);
    const wrongCount = checkoutSetup([phone], { serialUnits: serials });
    await expect(wrongCount.service.checkout({ items: [{ productId: "phone-1", quantity: 2, serials: ["IMEI-1"] }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/دقیقاً/);
    const sold = checkoutSetup([phone], { serialUnits: [{ ...serials[0], status: "SOLD" }] });
    await expect(sold.service.checkout({ items: [{ productId: "phone-1", quantity: 1, serials: ["IMEI-1"] }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/قبلاً فروخته/);
    const ok = checkoutSetup([phone], { serialUnits: serials });
    await ok.service.checkout({ items: [{ productId: "phone-1", quantity: 2, serials: ["IMEI-1", "IMEI-2"] }], paymentMethod: "CASH" }, admin);
    expect(ok.tx.serialUnit.update).toHaveBeenCalledTimes(2);
    expect(ok.tx.serialUnit.update).toHaveBeenCalledWith(expect.objectContaining({ where: { serial: "IMEI-1" }, data: expect.objectContaining({ status: "SOLD" }) }));
  });

  it("reserved stock is not sellable to walk-in customers", async () => {
    const { service } = checkoutSetup([product({ stock: 5, reserved: 3 })]);
    await expect(service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/رزرو|آزاد/);
    const fits = checkoutSetup([product({ stock: 5, reserved: 3 })]);
    await expect(fits.service.checkout({ items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH" }, admin)).resolves.toBeTruthy();
  });
});

function installmentsSetup() {
  const tx = {
    customer: { findUnique: jest.fn().mockResolvedValue({ id: "customer-1", name: "احمد", isActive: true }) },
    installmentPlan: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "plan-1", ...data, installments: (data.installments?.create || []).map((row: Record<string, unknown>, index: number) => ({ id: `inst-${index}`, ...row })) })), update: jest.fn().mockResolvedValue({}) },
    installment: { findUnique: jest.fn().mockResolvedValue({ id: "inst-1", amount: 4000, paidAmount: 0, paidAt: null, plan: { id: "plan-1", status: "OPEN", total: 12000, paidAmount: 0, customerId: "customer-1", installments: [{}, {}, {}], customer: { id: "customer-1", name: "احمد" } } }), update: jest.fn().mockResolvedValue({}) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    customerPayment: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), customer: { findUnique: jest.fn().mockResolvedValue({ id: "customer-1", name: "احمد", isActive: true }) }, installmentPlan: { findMany: jest.fn().mockResolvedValue([]) }, sale: { findUnique: jest.fn().mockResolvedValue(null) } };
  const controller = new InstallmentsController(prisma as never);
  return { controller, tx, prisma };
}

describe("Round 16 — installments", () => {
  it("splits the total into dated installments that add up exactly", async () => {
    const { controller, tx } = installmentsSetup();
    const plan = (await controller.create({ customerId: "customer-1", total: 10000, installmentCount: 3, intervalDays: 30 }, admin)) as { installments: Array<{ amount: number; seq: number; dueDate: Date }> };
    const amounts = plan.installments.map((row) => row.amount);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(plan.installments).toHaveLength(3);
    expect(plan.installments[1].dueDate.getTime() - plan.installments[0].dueDate.getTime()).toBe(30 * 86400000);
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("paying an installment books a customer payment and settles the plan at the end", async () => {
    const { controller, tx } = installmentsSetup();
    const result = (await controller.pay("inst-1", { amount: 4000, fromCash: true }, admin)) as { amount: number; installmentPaid: boolean; planSettled: boolean };
    expect(result).toEqual({ ok: true, amount: 4000, installmentPaid: true, planSettled: false });
    expect(tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: "customer-1", amount: 4000 }) }));
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "IN", amount: 4000 }) }));
    expect(tx.installment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ paidAmount: 4000, paidAt: expect.any(Date) }) }));
    expect(tx.installmentPlan.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ paidAmount: 4000, status: "OPEN" }) }));
  });

  it("never overpays an installment beyond its remaining amount", async () => {
    const { controller, tx } = installmentsSetup();
    tx.installment.findUnique.mockResolvedValue({ id: "inst-1", amount: 4000, paidAmount: 3500, paidAt: null, plan: { id: "plan-1", status: "OPEN", total: 12000, paidAmount: 3500, customerId: "customer-1", installments: [{}, {}, {}], customer: { id: "customer-1", name: "احمد" } } });
    const result = (await controller.pay("inst-1", { amount: 9999 }, admin)) as { amount: number };
    expect(result.amount).toBe(500);
  });

  it("rejects payment on a settled plan", async () => {
    const { controller, tx } = installmentsSetup();
    tx.installment.findUnique.mockResolvedValue({ id: "inst-1", amount: 4000, paidAmount: 0, paidAt: null, plan: { id: "plan-1", status: "SETTLED", total: 12000, paidAmount: 12000, customerId: "customer-1", installments: [{}, {}, {}], customer: { id: "customer-1", name: "احمد" } } });
    await expect(controller.pay("inst-1", { amount: 100 }, admin)).rejects.toThrow(/بسته/);
  });
});

describe("Round 16 — backup scheduler", () => {
  it("first run waits for the configured hour today, or tomorrow if passed", () => {
    const morning = new Date(2026, 10, 2, 9, 30);
    expect(nextScheduledRun(null, 14, morning).getTime()).toBe(new Date(2026, 10, 2, 14).getTime());
    const evening = new Date(2026, 10, 2, 15, 0);
    expect(nextScheduledRun(null, 14, evening).getTime()).toBe(new Date(2026, 10, 3, 14).getTime());
  });

  it("keeps exactly one run per day even after restarts", () => {
    const lastRun = new Date(2026, 10, 1, 14, 3);
    const now = new Date(2026, 10, 2, 8, 0);
    expect(nextScheduledRun(lastRun, 14, now).getTime()).toBe(new Date(2026, 10, 2, 14).getTime());
    const afterRun = new Date(2026, 10, 2, 14, 5);
    expect(nextScheduledRun(afterRun, 14, afterRun).getTime()).toBe(new Date(2026, 10, 3, 14).getTime());
  });
});

describe("Round 16 — settings validation", () => {
  function settingsSetup() {
    const prisma = {
      setting: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return { controller: new SettingsController(prisma as never), prisma };
  }
  it("accepts valid calendar/timezone/currency values", async () => {
    const { controller, prisma } = settingsSetup();
    await controller.put({ key: "calendar", value: "islamic-umalqura" }, admin);
    await controller.put({ key: "timezone", value: "Asia/Kabul" }, admin);
    await controller.put({ key: "currency", value: "USD" }, admin);
    await controller.put({ key: "backupHour", value: "2" }, admin);
    expect(prisma.setting.upsert).toHaveBeenCalledTimes(4);
  });
  it("rejects invalid values with a Persian message", async () => {
    const { controller } = settingsSetup();
    await expect(controller.put({ key: "calendar", value: "aztec" }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "timezone", value: "Mars/Olympus" }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "currency", value: "XYZ" }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "backupHour", value: "99" }, admin)).rejects.toThrow(BadRequestException);
  });
  it("protects internal keys", async () => {
    const { controller } = settingsSetup();
    await expect(controller.put({ key: "lastScheduledBackupAt", value: "2000-01-01" }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "invoiceSeq:20261102", value: "0" }, admin)).rejects.toThrow(BadRequestException);
  });
  it("manages the shop currency list: AFN is permanent, extras come and go", async () => {
    const { controller, prisma } = settingsSetup();
    // A custom list with AFN + USD + a shop-added currency is accepted…
    const list = [{ code: "AFN", label: "افغانی" }, { code: "USD", label: "دلار امریکا" }, { code: "EUR", label: "یورو" }];
    await controller.put({ key: "currencies", value: JSON.stringify(list) }, admin);
    expect(prisma.setting.upsert).toHaveBeenCalledWith({ where: { key: "currencies" }, create: { key: "currencies", value: JSON.stringify(list) }, update: { value: JSON.stringify(list) } });
    // …and once stored, EUR becomes a valid base currency.
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue({ key: "currencies", value: JSON.stringify(list) });
    await controller.put({ key: "currency", value: "EUR" }, admin);
    // Removing AFN from the list is refused — it is the permanent base currency.
    const withoutAfn = list.slice(1);
    await expect(controller.put({ key: "currencies", value: JSON.stringify(withoutAfn) }, admin)).rejects.toThrow(BadRequestException);
    // Malformed lists (bad codes, duplicates, wrong shapes) are refused too.
    await expect(controller.put({ key: "currencies", value: JSON.stringify([{ code: "afn", label: "افغانی" }]) }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "currencies", value: JSON.stringify([{ code: "AFN", label: "افغانی" }, { code: "AFN", label: "افغانی دیگر" }]) }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "currencies", value: "not json" }, admin)).rejects.toThrow(BadRequestException);
    await expect(controller.put({ key: "currencies", value: JSON.stringify([{ code: "AFN" }]) }, admin)).rejects.toThrow(BadRequestException);
    // A base currency outside the stored list stays rejected.
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue({ key: "currencies", value: JSON.stringify(list) });
    await expect(controller.put({ key: "currency", value: "PKR" }, admin)).rejects.toThrow(BadRequestException);
  });
  it("falls back to the default currency list when the stored one is missing", async () => {
    const { controller } = settingsSetup();
    // findUnique → null: defaults are AFN + USD only.
    await expect(controller.put({ key: "currency", value: "EUR" }, admin)).rejects.toThrow(BadRequestException);
    await controller.put({ key: "currency", value: "USD" }, admin);
    // A corrupt stored value also falls back to the defaults.
    const { controller: broken, prisma } = settingsSetup();
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue({ key: "currencies", value: "{not-json" });
    await expect(broken.put({ key: "currency", value: "EUR" }, admin)).rejects.toThrow(BadRequestException);
  });
});

describe("Round 16 — reorder suggestions", () => {
  it("suggests buying for items whose 14-day cover is short", async () => {
    const products = [
      { id: "p1", name: "چای", sku: "T-1", unit: "عدد", stock: 2, backstock: 0, reserved: 0, minStock: 5, cost: 6 },
      { id: "p2", name: "شکر", sku: "S-1", unit: "کیلو", stock: 100, backstock: 0, reserved: 0, minStock: 5, cost: 60 },
    ];
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
      saleItem: { findMany: jest.fn().mockResolvedValue([{ productId: "p1", quantity: 30 }, { productId: "p2", quantity: 3 }]) },
      // Six of the thirty sold units came straight back: the net velocity is
      // 24/30 per day, not 30/30 — returns must not inflate the suggestion.
      saleReturnItem: { findMany: jest.fn().mockResolvedValue([{ productId: "p1", quantity: 6 }]) },
      purchaseItem: { findMany: jest.fn().mockResolvedValue([{ productId: "p1", purchase: { supplier: { id: "sup-1", name: "تأمین‌کننده", phone: null } } }]) },
    };
    const controller = new InventoryController(prisma as never);
    const rows = (await controller.reorder()) as Array<{ productId: string; suggested: number; belowMin: boolean; soldLast30: number; lastSupplier: { id: string } | null }>;
    const tea = rows.find((row) => row.productId === "p1");
    expect(tea).toBeDefined();
    expect(tea!.belowMin).toBe(true);
    expect(tea!.suggested).toBe(Math.ceil(0.8 * 14 + 5 - 2)); // net velocity 0.8/day (24 sold − 6 returned) + minStock − on hand
    expect(tea!.soldLast30).toBe(24);
    expect(tea!.lastSupplier?.id).toBe("sup-1");
    expect(rows.find((row) => row.productId === "p2")).toBeUndefined();
  });
});

describe("Round 16 — orders reserve and release stock", () => {
  function ordersSetup(productRow: Record<string, unknown>, order: Record<string, unknown> | null = null) {
    const findOrder = jest.fn().mockResolvedValue(order);
    const tx = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: "customer-1", name: "احمد", isActive: true }) },
      product: { findMany: jest.fn().mockResolvedValue([productRow]), update: jest.fn().mockResolvedValue({}) },
      customerOrder: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "order-1", orderNo: "ORD-1", ...data, lines: (data.lines?.create || []).map((row: Record<string, unknown>, index: number) => ({ id: `line-${index}`, deliveredQty: 0, ...row })) })), findUnique: findOrder, update: jest.fn().mockResolvedValue({}) },
      customerOrderLine: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      customerOrder: { findUnique: findOrder, findMany: jest.fn().mockResolvedValue([]) },
    };
    // Deliveries run inside one transaction via checkoutInTx.
    const checkout = { checkout: jest.fn().mockResolvedValue({ id: "sale-1", total: 100 }), checkoutInTx: jest.fn().mockResolvedValue({ id: "sale-1", total: 100 }), assertLicensed: jest.fn().mockResolvedValue(undefined) };
    const controller = new OrdersController(prisma as never, checkout as never);
    return { controller, tx, prisma, checkout, findOrder };
  }

  it("creating an order reserves the ordered quantity", async () => {
    const { controller, tx } = ordersSetup({ id: "product-1", name: "چای", sku: "T-1", price: 10, stock: 10, reserved: 0, isBundle: false, isActive: true });
    const order = (await controller.create({ items: [{ productId: "product-1", quantity: 4 }], customerId: "customer-1" }, admin)) as { orderNo: string };
    expect(order.orderNo).toMatch(/^ORD-/);
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ data: { reserved: { increment: 4 } } }));
  });

  it("delivering runs in ONE transaction — a checkout failure leaves the order untouched", async () => {
    const productRow = { id: "product-1", name: "چای", sku: "T-1", price: 10, stock: 10, reserved: 4, isBundle: false, isActive: true };
    const order = { id: "order-1", orderNo: "ORD-1", status: "OPEN", customerId: "customer-1", lines: [{ id: "line-1", productId: "product-1", quantity: 4, deliveredQty: 0 }] };
    const { controller, tx, prisma, checkout } = ordersSetup(productRow, order);
    // The shared checkout refuses (e.g. price/stock/license): the delivery
    // must throw inside the same transaction — no deliveredQty bump, no
    // separate compensating transactions to half-apply.
    checkout.checkoutInTx.mockRejectedValue(new Error("موجودی کافی نیست"));
    await expect(controller.deliver("order-1", { deliveries: [{ lineId: "line-1", quantity: 4 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/موجودی/);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.customerOrderLine.update).not.toHaveBeenCalled();
    expect(tx.customerOrder.update).not.toHaveBeenCalled();
  });

  it("refuses an order above free stock", async () => {
    const { controller } = ordersSetup({ id: "product-1", name: "چای", sku: "T-1", price: 10, stock: 3, reserved: 0, isBundle: false, isActive: true });
    await expect(controller.create({ items: [{ productId: "product-1", quantity: 4 }] }, admin)).rejects.toThrow(/آزاد/);
  });

  it("delivering releases the reservation and runs the real checkout", async () => {
    const { controller, tx, checkout } = ordersSetup(
      { id: "product-1", name: "چای", sku: "T-1", price: 10, stock: 10, reserved: 4, isBundle: false, isActive: true },
      { id: "order-1", orderNo: "ORD-1", status: "OPEN", customerId: "customer-1", lines: [{ id: "line-1", productId: "product-1", name: "چای", sku: "T-1", quantity: 4, unitPrice: 10, deliveredQty: 0 }] },
    );
    await controller.deliver("order-1", { deliveries: [{ lineId: "line-1", quantity: 4 }], paymentMethod: "CASH" }, admin);
    expect(checkout.checkoutInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ items: [{ productId: "product-1", quantity: 4, discount: 0, serials: undefined }], paymentMethod: "CASH" }), admin);
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ data: { reserved: { decrement: 4 } } }));
    expect(tx.customerOrderLine.update).toHaveBeenCalledWith(expect.objectContaining({ data: { deliveredQty: { increment: 4 } } }));
  });

  it("cancel releases the undelivered remainder only", async () => {
    const { controller, tx } = ordersSetup(
      { id: "product-1", name: "چای", sku: "T-1", price: 10, stock: 10, reserved: 4, isBundle: false, isActive: true },
      { id: "order-1", orderNo: "ORD-1", status: "OPEN", lines: [{ id: "line-1", productId: "product-1", quantity: 4, deliveredQty: 1 }] },
    );
    await controller.cancel("order-1", admin);
    expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({ data: { reserved: { decrement: 3 } } }));
    expect(tx.customerOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
  });
});

describe("Round 16 audit — regression fixes", () => {
  it("rejects the same serial twice in one sale (stock would drop double for one device)", async () => {
    const phone = product({ id: "phone-1", name: "گوشی", isSerialized: true, stock: 2 });
    const serials = [
      { serial: "IMEI-1", productId: "phone-1", status: "IN_STOCK", saleItemId: null },
      { serial: "IMEI-2", productId: "phone-1", status: "IN_STOCK", saleItemId: null },
    ];
    const { service } = checkoutSetup([phone], { serialUnits: serials });
    await expect(service.checkout({ items: [{ productId: "phone-1", quantity: 2, serials: ["IMEI-1", "IMEI-1"] }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/تکراری/);
  });

  it("checks the COMBINED component demand when two bundles share a component", async () => {
    // 5 teas on the shelf; each bundle takes 3 → each line alone fits, but
    // together they need 6 and must be refused instead of driving stock < 0.
    const boxA = product({ id: "bundle-a", name: "بستهٔ الف", isBundle: true, stock: 0 });
    const boxB = product({ id: "bundle-b", name: "بستهٔ ب", isBundle: true, stock: 0 });
    const tea = product({ id: "product-1", stock: 5 });
    const { service } = checkoutSetup([boxA, boxB, tea], { components: [
      { bundleId: "bundle-a", componentId: "product-1", quantity: 3 },
      { bundleId: "bundle-b", componentId: "product-1", quantity: 3 },
    ] });
    await expect(service.checkout({ items: [{ productId: "bundle-a", quantity: 1 }, { productId: "bundle-b", quantity: 1 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/مجموع بسته‌ها/);
  });

  it("chains stockAfter when a shared component is deducted for two bundles", async () => {
    const boxA = product({ id: "bundle-a", name: "بستهٔ الف", isBundle: true, stock: 0 });
    const boxB = product({ id: "bundle-b", name: "بستهٔ ب", isBundle: true, stock: 0 });
    const tea = product({ id: "product-1", stock: 10 });
    const { service, tx } = checkoutSetup([boxA, boxB, tea], { components: [
      { bundleId: "bundle-a", componentId: "product-1", quantity: 3 },
      { bundleId: "bundle-b", componentId: "product-1", quantity: 3 },
    ] });
    await service.checkout({ items: [{ productId: "bundle-a", quantity: 1 }, { productId: "bundle-b", quantity: 1 }], paymentMethod: "CASH" }, admin);
    const movements = (tx.inventoryMovement.create as jest.Mock).mock.calls
      .map((call) => call[0].data)
      .filter((data: { productId: string }) => data.productId === "product-1")
      .map((data: { stockAfter: number }) => data.stockAfter)
      .sort((a: number, b: number) => a - b);
    expect(movements).toEqual([4, 7]); // 10 − 3 − 3, each movement honest
  });

  it("refuses to move reserved shelf stock to the backroom", async () => {
    const tx = { product: { findUnique: jest.fn().mockResolvedValue({ id: "product-1", name: "چای", isActive: true, stock: 10, reserved: 6, backstock: 0 }) }, product_update: jest.fn().mockResolvedValue({}), inventoryMovement: { create: jest.fn() }, auditLog: { create: jest.fn() } };
    const prisma = { $transaction: jest.fn((work: (client: unknown) => unknown) => work({ product: { update: jest.fn() }, inventoryMovement: tx.inventoryMovement, auditLog: tx.auditLog })) };
    // Rebuild the controller with the row the transfer endpoint reads.
    const controller = new InventoryController({ ...prisma, $transaction: jest.fn(async (work: (client: unknown) => unknown) => work({ product: { findUnique: tx.product.findUnique, update: jest.fn().mockResolvedValue({}) }, inventoryMovement: tx.inventoryMovement, auditLog: tx.auditLog })) } as never);
    // Free shelf = 10 − 6 = 4: transferring 5 must be refused…
    await expect(controller.transfer({ productId: "product-1", quantity: 5, direction: "TO_BACKROOM" }, admin)).rejects.toThrow(/آزاد/);
    // …while 4 (the whole free part) goes through.
    await expect(controller.transfer({ productId: "product-1", quantity: 4, direction: "TO_BACKROOM" }, admin)).resolves.toBeTruthy();
  });

  it("rejects a product that is both bundle and serialized, and a duplicate sku surfaces as 400", async () => {
    const tx = {
      product: { create: jest.fn().mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["Product_sku_key"] } })) },
      inventoryMovement: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => Promise.resolve(work(tx))),
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: "product-1", isBundle: true, isSerialized: false }),
        update: jest.fn().mockResolvedValue({ id: "product-1", sku: "T-1" }),
      },
      auditLog: { create: jest.fn() },
    };
    const { ProductsController } = jest.requireActual("./catalog.module") as typeof import("./catalog.module");
    const controller = new ProductsController(prisma as never);
    await expect(controller.create({ sku: "T-1", name: "چای", price: 10, isBundle: true, isSerialized: true } as never)).rejects.toBeInstanceOf(BadRequestException);
    // A stored bundle that gets the serialized flag switched on via PATCH is refused too.
    await expect(controller.update("product-1", { sku: "T-1", name: "چای", price: 10, isSerialized: true } as never)).rejects.toThrow(/هم‌زمان/);
    // Unique violations map to a friendly BadRequest instead of a raw 500.
    await expect(controller.create({ sku: "T-1", name: "چای تکراری", price: 10 } as never)).rejects.toThrow(/کد کالا/);
  });

  it("setBundle logs the acting user, not a hardcoded 'admin'", async () => {
    const tx = {
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: "bundle-1", name: "بسته", isActive: true, isBundle: true, isSerialized: false, bundleComponents: [] }),
        findMany: jest.fn().mockResolvedValue([{ id: "product-1", name: "چای", isActive: true, isBundle: false, isSerialized: false }]),
      },
      bundleComponent: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const { ProductsController } = jest.requireActual("./catalog.module") as typeof import("./catalog.module");
    const controller = new ProductsController(prisma as never);
    await controller.setBundle("bundle-1", { components: [{ productId: "product-1", quantity: 2 }] }, { ...admin, username: "cashier-ali" });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actor: "cashier-ali", action: "SET_BUNDLE" }) }));
  });

  it("rejects an installment plan linked to another customer's (or a missing) sale", async () => {
    const { controller, prisma } = installmentsSetup();
    (prisma.sale.findUnique as jest.Mock).mockResolvedValue({ customerId: "someone-else" });
    await expect(controller.create({ customerId: "customer-1", total: 9000, installmentCount: 3, saleId: "sale-9" }, admin)).rejects.toThrow(/فاکتور/);
    (prisma.sale.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(controller.create({ customerId: "customer-1", total: 9000, installmentCount: 3, saleId: "sale-9" }, admin)).rejects.toThrow(/فاکتور/);
    // No saleId → no link check, plan is created as before.
    await expect(controller.create({ customerId: "customer-1", total: 9000, installmentCount: 3 }, admin)).resolves.toBeTruthy();
  });
});

describe("Round 30 — sale deadlock fix + serial picking", () => {
  it("checks the license BEFORE opening the transaction (SQLite P2028 regression)", async () => {
    // The bug: assertLicensed() used to run INSIDE the $transaction callback
    // and queried the parent client. SQLite gives an interactive transaction
    // the only pooled connection, so that query could never finish — the
    // transaction expired after 5 s and every sale died with P2028.
    const calls: string[] = [];
    const license = { assertLicensed: jest.fn(async () => { calls.push("license"); }) };
    const { tx } = checkoutSetup([product()]);
    const prisma = {
      $transaction: jest.fn(async (work: (client: unknown) => unknown) => { calls.push("transaction"); return work(tx); }),
    };
    const service = new CheckoutService(prisma as never, license as never);
    await service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH" }, admin);
    expect(calls).toEqual(["license", "transaction"]);
    // A wider window than the 5 s default, so slow disks retry instead of failing.
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15000, maxWait: 5000 });
  });

  it("exposes assertLicensed for callers that open their own transaction", async () => {
    const license = { assertLicensed: jest.fn().mockResolvedValue(undefined) };
    const service = new CheckoutService({} as never, license as never);
    await service.assertLicensed();
    expect(license.assertLicensed).toHaveBeenCalledTimes(1);
    const bare = new CheckoutService({} as never);
    await expect(bare.assertLicensed()).resolves.toBeUndefined();
  });

  it("serials(saleId) narrows the list to one invoice's still-out units", async () => {
    const prisma = {
      sale: { findUnique: jest.fn().mockResolvedValue({ items: [{ id: "item-1" }, { id: "item-2" }] }) },
      serialUnit: { findMany: jest.fn().mockResolvedValue([{ serial: "S1", saleItemId: "item-1", status: "SOLD" }]) },
    };
    const controller = new InventoryController(prisma as never);
    await controller.serials(undefined, "SOLD", undefined, "sale-1");
    expect(prisma.sale.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sale-1" } }));
    expect(prisma.serialUnit.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ saleItemId: { in: ["item-1", "item-2"] }, status: "SOLD" }) }));
  });

  it("serials(saleId) rejects an unknown invoice", async () => {
    const prisma = {
      sale: { findUnique: jest.fn().mockResolvedValue(null) },
      serialUnit: { findMany: jest.fn() },
    };
    const controller = new InventoryController(prisma as never);
    await expect(controller.serials(undefined, undefined, undefined, "nope")).rejects.toThrow(/فاکتور پیدا نشد/);
  });
});
