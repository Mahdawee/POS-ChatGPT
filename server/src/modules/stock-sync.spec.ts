/**
 * Round 77 — live stock sync between network devices.
 *
 * Two guarantees keep two cashiers from selling the same shelf twice:
 *  1. Server-side: checkout decrements stock with ONE atomic conditional
 *     UPDATE (`… WHERE stock >= qty`), so the last item can be sold exactly
 *     once no matter how many devices race for it.
 *  2. Client-side: a tiny `pos/version` freshness key lets the other device
 *     notice the change with one cheap query and refetch silently.
 */
import { BadRequestException } from "@nestjs/common";
import { ProductsController, composePosVersion } from "./catalog.module";
import { CheckoutService } from "../services/checkout";

const admin = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const product = { id: "product-1", name: "چای", sku: "T-1", stock: 1, price: 10, cost: 6, isActive: true, backstock: 0, reserved: 0, isBundle: false, isSerialized: false };

/** Same mock shape as sales.module.spec, with a shared simulated shelf. */
function setup(stock = 1) {
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
  return { service: new CheckoutService(prisma as never), tx, shelf };
}

describe("pos/version — freshness key for multi-device stock sync", () => {
  const emptyRow = {
    moveCount: 0, moveMax: "",
    productCount: 0, productMaxUpdated: "",
    cashCount: 0, cashMaxOpened: "", cashMaxClosed: "",
    customerCount: 0, customerMaxUpdated: "",
  };

  it("is stable while nothing changes (same row ⇒ same key)", () => {
    expect(composePosVersion(emptyRow)).toBe(composePosVersion(emptyRow));
  });

  it("changes when stock moves (a new InventoryMovement row)", () => {
    const before = { ...emptyRow, moveCount: 12, moveMax: "clx1" };
    const after = { ...emptyRow, moveCount: 13, moveMax: "clx2" };
    expect(composePosVersion(before)).not.toBe(composePosVersion(after));
  });

  it("changes when the catalog itself changes (price edit bumps Product.updatedAt)", () => {
    const before = { ...emptyRow, productCount: 5, productMaxUpdated: "2026-11-07 08:00:00.000" };
    const after = { ...emptyRow, productCount: 5, productMaxUpdated: "2026-11-07 08:05:00.000" };
    expect(composePosVersion(before)).not.toBe(composePosVersion(after));
  });

  it("changes when the register (cash session) or customers change", () => {
    const base = { ...emptyRow, cashCount: 3, cashMaxOpened: "a", cashMaxClosed: "", customerCount: 9, customerMaxUpdated: "c1" };
    expect(composePosVersion({ ...base, cashCount: 4 })).not.toBe(composePosVersion(base));
    expect(composePosVersion({ ...base, cashMaxClosed: "z" })).not.toBe(composePosVersion(base));
    expect(composePosVersion({ ...base, customerCount: 10 })).not.toBe(composePosVersion(base));
  });

  it("normalizes Date objects and raw strings to the same key (driver differences)", () => {
    const asDate = { ...emptyRow, productMaxUpdated: new Date("2026-11-07T08:00:00.000Z") };
    const asString = { ...emptyRow, productMaxUpdated: "2026-11-07T08:00:00.000Z" };
    expect(composePosVersion(asDate)).toBe(composePosVersion(asString));
  });

  it("accepts BigInt counts from raw COUNT(*) and the endpoint wires it through", async () => {
    const row = { ...emptyRow, moveCount: 10n, productCount: 5n, cashCount: 1n, customerCount: 2n };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([row]) };
    const controller = new ProductsController(prisma as never);
    const result = await controller.posVersion();
    expect(typeof result.version).toBe("string");
    expect(result.version).toContain("movements|10");
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // A later state (one more movement) yields a different key through the endpoint.
    prisma.$queryRaw.mockResolvedValue([{ ...row, moveCount: 11n, moveMax: "clx9" }]);
    const next = await controller.posVersion();
    expect(next.version).not.toBe(result.version);
  });
});

describe("checkout — atomic stock floor across concurrent devices", () => {
  it("sells the LAST item exactly once: one of two racing checkouts wins, the shelf never goes negative", async () => {
    const { service, shelf } = setup(1);
    const attempt = service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 10 }, admin);
    const rival = service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 10 }, admin);
    const results = await Promise.allSettled([attempt, rival]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    // موجودی هرگز منفی نمی‌شود — همان تضمینی که UPDATE شرطی می‌دهد.
    expect(shelf.get("product-1")).toBe(0);
  });

  it("explains the race to the losing cashier instead of silently corrupting stock", async () => {
    const { service } = setup(1);
    const attempt = service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 10 }, admin);
    const rival = service.checkout({ items: [{ productId: "product-1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 10 }, admin);
    const results = await Promise.allSettled([attempt, rival]);
    const loss = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loss.reason.message)).toMatch(/در همین لحظه کافی نیست/);
  });

  it("still sells normally when stock is plentiful (the guard adds no false rejections)", async () => {
    const { service, shelf } = setup(7);
    await expect(service.checkout({ items: [{ productId: "product-1", quantity: 3 }], paymentMethod: "CASH", amountPaid: 30 }, admin)).resolves.toBeTruthy();
    expect(shelf.get("product-1")).toBe(4);
  });
});
