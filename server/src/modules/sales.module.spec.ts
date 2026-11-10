import { BadRequestException } from "@nestjs/common";
import { SalesController } from "./sales.module";
import { CheckoutService } from "../services/checkout";
import type { SaleDto } from "../dto";

const admin = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const cashier = { id: "user-2", username: "cashier", displayName: "Cashier", role: "CASHIER" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 2, price: 10, cost: 6, isActive: true, backstock: 0, reserved: 0, isBundle: false, isSerialized: false };

function setup(stock = 2) {
  // قفسهٔ شبیه‌سازی‌شده برای کسر اتمیِ شرطی (UPDATE … WHERE stock >= qty):
  // پارامترها به ترتیب ظاهر در SQL می‌آیند — (quantity, id, quantity) — و
  // mock فقط با دو مقدار نخست کار می‌کند. findUnique هم همین قفسه را
  // می‌خواند تا stockAfter رکورد cardex با دیتابیس واقعی هم‌خوان بماند.
  const shelf = new Map<string, number>([[product.id, stock]]);
  const tx = {
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [quantity, id] = values as [number, string];
      const base = shelf.get(id) ?? 0;
      if (base < quantity) return 0;
      shelf.set(id, base - quantity);
      return 1;
    }),
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock }]), update: jest.fn().mockResolvedValue({}), findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, stock: shelf.get(where.id) ?? 0 })) },
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
    sale: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  };
  const service = new CheckoutService(prisma as never);
  return { controller: new SalesController(prisma as never, service), service, tx, prisma, shelf };
}

describe("POS checkout", () => {
  it("ships list rows slim: per line only the quantity, customer only name/phone", async () => {
    // The history table, exports and list-row dialogs never read a line's
    // name/price from the LIST — full rows come from /sales/:id. Keeping the
    // window slim roughly halves the payload on ledgers of thousands.
    const { controller, prisma } = setup();
    await controller.list();
    expect(prisma.sale.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        user: { select: { displayName: true } },
        items: { select: { quantity: true } },
        returns: { select: { id: true, total: true } },
      },
    }));
  });

  it("filters the register history by payment method (months of use: reconcile نسیه)", async () => {
    const { controller, prisma } = setup();
    const result = await controller.list(undefined, undefined, undefined, undefined, "CREDIT");
    expect(prisma.sale.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ paymentMethod: "CREDIT" }) }));
    // { list, total } shape so the client can render real page numbers.
    expect(result).toEqual({ list: [], total: 0 });
    expect(prisma.sale.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ paymentMethod: "CREDIT" }) }));
  });

  it("searches the history server-side so search composes with pagination", async () => {
    const { controller, prisma } = setup();
    await controller.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, "جمیل");
    expect(prisma.sale.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ customer: { name: { contains: "جمیل" } } })]) }) }));
  });

  it("sorts the register history by the requested column and direction", async () => {
    const { controller, prisma } = setup();
    await controller.list(undefined, undefined, undefined, undefined, undefined, "total", "asc");
    expect(prisma.sale.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { total: "asc" } }));
    await controller.list(undefined, undefined, undefined, undefined, undefined, "total");
    expect(prisma.sale.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: { total: "desc" } }));
    // An unknown column falls back to the invoice-time ordering.
    await controller.list(undefined, undefined, undefined, undefined, undefined, "nope", "asc");
    expect(prisma.sale.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: { createdAt: "asc" } }));
  });

  it("rejects a sale that would take stock below zero before writing anything", async () => {
    const { service, tx } = setup(2);
    await expect(service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "CASH", amountPaid: 30 }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.sale.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
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
    // کسر اتمیِ شرطی: یک UPDATE واحد که فقط وقتی می‌نشیند که قفسه هنوز
    // کالا دارد — پادزهر قطعیِ فروش همزمانِ همان قلم روی دستگاه دیگر.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
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

  it("sells a kit's serialized components through the serials on the bundle line", async () => {
    const { service, tx, shelf } = setup();
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 5 };
    const kit = { ...product, id: "bundle-1", name: "بستهٔ گوشی", sku: "B-1", isBundle: true, price: 150, stock: 0 };
    shelf.set("phone-1", 5);
    tx.product.findMany.mockResolvedValue([kit]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-1", productId: "phone-1", status: "IN_STOCK" }]);
    tx.sale.create.mockResolvedValue({ id: "sale-1", receiptNo: "POS-1", items: [{ id: "sale-item-1", productId: "bundle-1" }] });
    await service.checkout({ items: [{ productId: "bundle-1", quantity: 1, serials: ["IMEI-1"] }], paymentMethod: "CASH" }, admin);
    // The component leaves the shelf (atomic conditional update on phone-1)…
    expect(shelf.get("phone-1")).toBe(4);
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ productId: "phone-1", type: "SALE", quantity: -1, stockAfter: 4 }) }));
    // …and its unit flips to SOLD against the bundle's sale line, so a later
    // sale-return can find it and the serial list never shows a phantom unit.
    expect(tx.serialUnit.update).toHaveBeenCalledWith({ where: { serial: "IMEI-1" }, data: expect.objectContaining({ status: "SOLD", saleItemId: "sale-item-1" }) });
  });

  it("refuses a kit with serialized components when no serials are given", async () => {
    const { service, tx } = setup();
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 5 };
    const kit = { ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([kit]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    await expect(service.checkout({ items: [{ productId: "bundle-1", quantity: 1 }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/اجزای سریال‌دار هر بسته را وارد کنید/);
    expect(tx.sale.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.serialUnit.update).not.toHaveBeenCalled();
  });

  it("refuses a kit whose component serial count does not match the kits sold", async () => {
    const { service, tx } = setup();
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 5 };
    const kit = { ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([kit]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    tx.serialUnit.findMany.mockResolvedValue([
      { serial: "IMEI-1", productId: "phone-1", status: "IN_STOCK" },
      { serial: "IMEI-2", productId: "phone-1", status: "IN_STOCK" },
    ]);
    await expect(service.checkout({ items: [{ productId: "bundle-1", quantity: 1, serials: ["IMEI-1", "IMEI-2"] }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/دقیقاً 1 سریال لازم است/);
    expect(tx.serialUnit.update).not.toHaveBeenCalled();
  });

  it("refuses a kit serial that belongs to a product outside the kit", async () => {
    const { service, tx } = setup();
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 5 };
    const kit = { ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([kit]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-9", productId: "other-1", status: "IN_STOCK" }]);
    await expect(service.checkout({ items: [{ productId: "bundle-1", quantity: 1, serials: ["IMEI-9"] }], paymentMethod: "CASH" }, admin)).rejects.toThrow(/برای اجزای بستهٔ/);
    expect(tx.serialUnit.update).not.toHaveBeenCalled();
  });

  it("replays the original receipt when the same idempotency key arrives again", async () => {
    const { service, prisma, tx } = setup(5);
    const first = { id: "sale-9", receiptNo: "POS-9", items: [] };
    // The idempotency lookup runs inside the checkout transaction now.
    tx.sale.findUnique.mockResolvedValue(first);
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
    $executeRaw: jest.fn().mockResolvedValue(0),
    sale: { findUnique: jest.fn().mockResolvedValue(sale) },
    product: { findMany: jest.fn().mockResolvedValue([{ ...product, stock: 0 }]), update: jest.fn().mockResolvedValue({}) },
    saleReturn: { create: jest.fn().mockImplementation(({ data }: { data: { total: number; returnNo: string } }) => Promise.resolve({ id: "return-1", ...data })) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
    customer: { update: jest.fn().mockResolvedValue({}) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }), findUnique: jest.fn().mockResolvedValue(null) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    serialUnit: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    bundleComponent: { findMany: jest.fn().mockResolvedValue([]) },
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

  it("never restocks more of a kit component than the invoice deducted (recipe edited after the sale)", async () => {
    const bundleSale = {
      ...saleFixture,
      receiptNo: "POS-2",
      items: [{ id: "item-b", productId: "bundle-1", name: "بستهٔ نمونه", sku: "B-1", quantity: 1, unitPrice: 50, unitCost: 30, lineTotal: 50, discount: 0 }],
    };
    const { controller, tx } = returnSetup(bundleSale);
    tx.product.findMany.mockResolvedValue([{ id: "bundle-1", name: "بستهٔ نمونه", isBundle: true, stock: 0 }]);
    // TODAY's recipe wants 9 of the component per kit…
    tx.bundleComponent.findMany.mockResolvedValue([{ componentId: "component-1", quantity: 9, component: { id: "component-1", name: "جزء نمونه", stock: 0 } }]);
    // …but this invoice's SALE movements only ever took 3.
    tx.inventoryMovement.findMany.mockResolvedValue([{ productId: "component-1", quantity: -3 }]);
    await controller.returnSale("sale-1", { items: [{ productId: "bundle-1", quantity: 1 }] }, admin);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "component-1" }, data: { stock: { increment: 3 } } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "SALE_RETURN", quantity: 3, stockAfter: 3 }) }));
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

  it("flips a named serial back to IN_STOCK when a serialized line is returned", async () => {
    const sale = { ...saleFixture, items: [{ ...saleFixture.items[0], productId: "phone-1", name: "گوشی", quantity: 2 }] };
    const { controller, tx } = returnSetup(sale as never);
    tx.product.findMany.mockResolvedValue([{ ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 0 }]);
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-1", productId: "phone-1", status: "SOLD", saleItemId: "item-1" }]);
    await controller.returnSale("sale-1", { items: [{ productId: "phone-1", quantity: 1, serials: ["IMEI-1"] }] }, admin);
    expect(tx.serialUnit.update).toHaveBeenCalledWith({ where: { serial: "IMEI-1" }, data: expect.objectContaining({ status: "IN_STOCK", saleItemId: null }) });
  });

  it("returns a kit's serialized components through the serials on the bundle line", async () => {
    const sale = { ...saleFixture, items: [{ ...saleFixture.items[0], productId: "bundle-1", name: "بستهٔ گوشی", quantity: 1 }] };
    const { controller, tx } = returnSetup(sale as never);
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([{ ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 }]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-1", productId: "phone-1", status: "SOLD", saleItemId: "item-1" }]);
    await controller.returnSale("sale-1", { items: [{ productId: "bundle-1", quantity: 1, serials: ["IMEI-1"] }] }, admin);
    // The component comes back to the shelf…
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "phone-1" }, data: { stock: { increment: 1 } } });
    // …and its serial is sellable again instead of stranded as SOLD.
    expect(tx.serialUnit.update).toHaveBeenCalledWith({ where: { serial: "IMEI-1" }, data: expect.objectContaining({ status: "IN_STOCK" }) });
  });

  it("refuses a kit return that does not name the components' serials", async () => {
    const sale = { ...saleFixture, items: [{ ...saleFixture.items[0], productId: "bundle-1", name: "بستهٔ گوشی", quantity: 1 }] };
    const { controller, tx } = returnSetup(sale as never);
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([{ ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 }]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    await expect(controller.returnSale("sale-1", { items: [{ productId: "bundle-1", quantity: 1 }] }, admin)).rejects.toThrow(/اجزای سریال‌دار هر بسته را وارد کنید/);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.serialUnit.update).not.toHaveBeenCalled();
  });

  it("refuses a kit return serial belonging to a product outside the kit", async () => {
    const sale = { ...saleFixture, items: [{ ...saleFixture.items[0], productId: "bundle-1", name: "بستهٔ گوشی", quantity: 1 }] };
    const { controller, tx } = returnSetup(sale as never);
    const phone = { ...product, id: "phone-1", name: "گوشی", isSerialized: true, stock: 0 };
    tx.product.findMany.mockResolvedValue([{ ...product, id: "bundle-1", name: "بستهٔ گوشی", isBundle: true, stock: 0 }]);
    tx.bundleComponent.findMany.mockResolvedValue([{ bundleId: "bundle-1", componentId: "phone-1", quantity: 1, component: phone }]);
    tx.serialUnit.findMany.mockResolvedValue([{ serial: "IMEI-9", productId: "other-1", status: "SOLD", saleItemId: "item-1" }]);
    await expect(controller.returnSale("sale-1", { items: [{ productId: "bundle-1", quantity: 1, serials: ["IMEI-9"] }] }, admin)).rejects.toThrow(/برای اجزای بستهٔ/);
    expect(tx.serialUnit.update).not.toHaveBeenCalled();
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

describe("voiding a sale (ابطال فاکتور)", () => {
  const voidUser = { id: "user-9", username: "auditor", displayName: "Auditor", role: "ADMIN" as const };
  function voidSetup(saleOverrides: Record<string, unknown> = {}) {
    const sale = {
      id: "sale-1", receiptNo: "POS-100", total: 500, cashPart: 300, mobilePart: 0, creditPart: 150, walletPart: 50,
      customerId: "customer-1", cashSessionId: "cash-1", voidedAt: null, returns: [],
      items: [{ id: "item-1", productId: "product-1", quantity: 2 }, { id: "item-2", productId: "product-2", quantity: 1 }],
      ...saleOverrides,
    };
    const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
      sale: { findUnique: jest.fn().mockResolvedValue(sale), update: jest.fn().mockResolvedValue({}), aggregate: jest.fn().mockResolvedValue({ _sum: { creditPart: 0 } }) },
      product: { findMany: jest.fn().mockResolvedValue([
        { id: "product-1", isBundle: false, bundleComponents: [] },
        { id: "product-2", isBundle: true, bundleComponents: [{ componentId: "component-1", quantity: 3 }] },
      ]), update: jest.fn().mockImplementation(({ data }: { data: { stock: { increment?: number; decrement?: number } } }) => Promise.resolve({ stock: (data.stock.increment ?? 10) })) },
      inventoryMovement: {
        create: jest.fn().mockResolvedValue({}),
        // What THIS invoice actually took from the shelf at checkout time:
        // 2 of product-1 plus 3 of component-1 (inside the kit line).
        findMany: jest.fn().mockResolvedValue([{ productId: "product-1", quantity: -2 }, { productId: "component-1", quantity: -3 }]),
      },
      serialUnit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      customer: { update: jest.fn().mockResolvedValue({}) },
      customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
      customerPayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }), create: jest.fn().mockResolvedValue({}) },
      saleReturn: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditRelief: 0 } }) },
      cashSession: { findUnique: jest.fn().mockResolvedValue({ id: "cash-1", closedAt: null }) },
      cashMovement: { create: jest.fn().mockResolvedValue({}) },
      installmentPlan: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    return { controller: new SalesController(prisma as never, {} as never), tx, sale };
  }
  it("reverses stock (bundles restock components), wallet, drawer and marks the trail — in ONE transaction", async () => {
    const { controller, tx } = voidSetup();
    const result = await controller.voidSale("sale-1", { reason: "فاکتور اشتباه صادر شد" }, voidUser);
    expect(result.receiptNo).toBe("POS-100");
    // plain product restocked, bundle expanded into its component (3 × 1)
    const updates = tx.product.update.mock.calls.map((call) => [call[0].where.id, call[0].data.stock.increment]);
    expect(updates).toEqual(expect.arrayContaining([["product-1", 2], ["component-1", 3]]));
    // cardex rows for every restock, referencing the receipt and the reason
    for (const call of tx.inventoryMovement.create.mock.calls) expect(call[0].data.note).toContain("POS-100");
    expect(tx.inventoryMovement.create).toHaveBeenCalledTimes(2);
    // serials back on the shelf
    expect(tx.serialUnit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { saleItemId: { in: ["item-1", "item-2"] }, status: "SOLD" }, data: { status: "IN_STOCK" } }));
    // wallet spend refunded with a ledger row
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: "customer-1" }, data: { walletBalance: { increment: 50 } } });
    expect(tx.customerWalletTxn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "REFUND", amount: 50, customerId: "customer-1" }) }));
    // cash part taken back out of the STILL-OPEN drawer
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 300, cashSessionId: "cash-1" }) }));
    // the row is flagged, never deleted, with reason and actor
    expect(tx.sale.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ voidReason: "فاکتور اشتباه صادر شد", voidedBy: "auditor" }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "VOID_SALE" }) }));
  });

  it("voids against what the invoice actually deducted, not the kit's CURRENT recipe", async () => {
    const { controller, tx } = voidSetup();
    // The kit's recipe was edited AFTER the sale: it now demands 9 of the
    // component per kit, while the sale only ever took 3 off the shelf.
    tx.product.findMany.mockResolvedValue([
      { id: "product-1", isBundle: false, bundleComponents: [] },
      { id: "product-2", isBundle: true, bundleComponents: [{ componentId: "component-1", quantity: 9 }] },
    ]);
    await controller.voidSale("sale-1", { reason: "دستور بسته بعد از فروش عوض شد" }, voidUser);
    const updates = tx.product.update.mock.calls.map((call) => [call[0].where.id, call[0].data.stock.increment]);
    // The SALE movements (2 × product-1, 3 × component-1) are the truth.
    expect(updates).toEqual(expect.arrayContaining([["product-1", 2], ["component-1", 3]]));
    expect(updates).not.toContainEqual(["component-1", 9]);
  });

  it("voiding a SETTLED credit sale returns the collected money to the wallet (نه بستانکار معلق در دفتر)", async () => {
    // نسیِ ۲۸۰ که بعداً کامل تسویه شده: بدهی 0 است. با ابطال، اگر کاری
    // نکنیم دفتر مشتری −۲۸۰ می‌شود (پرداخت‌ها می‌مانند، بدهی حذف می‌شود).
    // فیکس: همان ۲۸۰ به کیف پول برمی‌گردد و یک پرداخت خنثی‌کننده ثبت
    // می‌شود تا (نسی − برگشت − پرداخت) دقیقاً صفر بماند.
    const { controller, tx } = voidSetup({ total: 280, cashPart: 0, creditPart: 280, walletPart: 0 });
    tx.customerPayment.aggregate.mockResolvedValue({ _sum: { amount: 280 } });
    await controller.voidSale("sale-1", { reason: "ابطال بعد از تسویه" }, voidUser);
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: "customer-1" }, data: { walletBalance: { increment: 280 } } });
    expect(tx.customerWalletTxn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "REFUND", amount: 280, saleId: "sale-1" }) }));
    expect(tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: "customer-1", amount: -280 }) }));
  });

  it("voiding a PARTIALLY paid credit sale returns only the orphaned share to the wallet", async () => {
    // نسیِ ۲۸۰ با ۱۰۰ تسویهٔ جزئی: با ابطال، آن ۱۰۰ دیگر به هیچ فاکتوری
    // وصل نیست → فقط همان ۱۰۰ (نه ۲۸۰) به کیف برمی‌گردد.
    const { controller, tx } = voidSetup({ total: 280, cashPart: 0, creditPart: 280, walletPart: 0 });
    tx.customerPayment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    await controller.voidSale("sale-1", { reason: "ابطال نسی با تسویهٔ جزئی" }, voidUser);
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: "customer-1" }, data: { walletBalance: { increment: 100 } } });
    expect(tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: "customer-1", amount: -100 }) }));
  });

  it("voiding a credit sale with NO payments touches neither wallet nor payments", async () => {
    // نسیِ خالص بدون هیچ پرداختی: دفتر بعد از ابطال صفر است → هیچ برگشتی لازم نیست.
    const { controller, tx } = voidSetup({ total: 280, cashPart: 0, creditPart: 280, walletPart: 0 });
    await controller.voidSale("sale-1", { reason: "ابطال نسی پرداخت‌نشده" }, voidUser);
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(tx.customerWalletTxn.create).not.toHaveBeenCalled();
    expect(tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("does not touch a CLOSED drawer — history stays as it was", async () => {
    const { controller, tx } = voidSetup();
    tx.cashSession.findUnique.mockResolvedValue({ id: "cash-1", closedAt: new Date("2026-01-01") });
    await controller.voidSale("sale-1", { reason: "اصلاح سابقه" }, voidUser);
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("refuses to void an invoice that already has a return or a collected installment", async () => {
    const withReturn = voidSetup({ returns: [{ id: "r1" }] });
    await expect(withReturn.controller.voidSale("sale-1", { reason: "دلیل تست" }, voidUser)).rejects.toThrow(/برگشت کالا/);
    const withPlan = voidSetup();
    withPlan.tx.installmentPlan.findMany.mockResolvedValue([{ id: "plan-1", paidAmount: 100 }]);
    await expect(withPlan.controller.voidSale("sale-1", { reason: "دلیل تست" }, voidUser)).rejects.toThrow(/قسط/);
  });

  it("refuses to void twice", async () => {
    const twice = voidSetup({ voidedAt: new Date("2026-01-01") });
    await expect(twice.controller.voidSale("sale-1", { reason: "دوباره" }, voidUser)).rejects.toThrow(/قبلاً ابطال/);
  });
});
