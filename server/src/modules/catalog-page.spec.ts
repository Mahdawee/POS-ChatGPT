import { ProductsController } from "./catalog.module";

/** GET /products/page — the management table's paged window over big
 *  catalogs: same search filters as /products, plus total/hasMore. */
describe("Products page endpoint", () => {
  function setup(rows: Array<{ id: string; name: string; sku: string; barcode: string | null; isActive: boolean }>) {
    const prisma = {
      product: {
        findMany: jest.fn().mockImplementation(({ where, take, skip }: { where?: { isActive: boolean; OR?: unknown[] }; take?: number; skip?: number }) =>
          Promise.resolve(rows.filter((row) => row.isActive === where?.isActive).slice(skip || 0, (skip || 0) + (take || 0)))),
        count: jest.fn().mockImplementation(({ where }: { where?: { isActive: boolean; OR?: unknown[] } }) =>
          Promise.resolve(rows.filter((row) => row.isActive === where?.isActive).length)),
      },
    };
    return { controller: new ProductsController(prisma as never), prisma };
  }

  const rows = Array.from({ length: 250 }, (_, index) => ({ id: `p${index}`, name: `کالای ${index}`, sku: `S-${index}`, barcode: null, isActive: true }));

  it("returns the first page of 100 with the full total and hasMore", async () => {
    const { controller } = setup(rows);
    const page = await controller.page(undefined, undefined, undefined);
    expect(page.list).toHaveLength(100);
    expect(page.total).toBe(250);
    expect(page.hasMore).toBe(true);
  });

  it("respects skip and reports the last page", async () => {
    const { controller } = setup(rows);
    const page = await controller.page(undefined, undefined, "200");
    expect(page.list).toHaveLength(50);
    expect(page.hasMore).toBe(false);
  });

  it("sorts by the whitelisted column and direction through Prisma (price)", async () => {
    const { controller, prisma } = setup(rows);
    await controller.page(undefined, undefined, undefined, "price", "desc");
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { price: "desc" } }));
  });

  it("sorts by stock through the bundle-aware raw expression (kits are not always 0)", async () => {
    // Bundles keep their own stock at 0 by design; sorting them by the raw
    // column pinned every kit to the bottom/top of the "موجودی" column no
    // matter how many kits their components could build.
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1" }]) },
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
        sql.startsWith("SELECT COUNT(*)") ? Promise.resolve([{ count: 1 }]) : Promise.resolve([{ id: "p1" }])),
    };
    const controller = new ProductsController(prisma as never);
    await controller.page(undefined, undefined, undefined, "stock", "desc");
    const sql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0];
    expect(sql).toContain("ORDER BY ((CASE WHEN Product.isBundle = 1");
    expect(sql).toContain("BundleComponent");
    expect(sql).toContain("DESC");
    expect(sql).not.toContain("stock <= minStock"); // no stock filter, just sorting
  });

  it("falls back to name-asc for an unknown sort column (never reaches raw SQL)", async () => {
    const { controller, prisma } = setup(rows);
    await controller.page(undefined, undefined, undefined, "name); DROP TABLE Product", "desc");
    // The injected string never reaches SQL; the whitelisted fallback keeps
    // the user's requested direction.
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { name: "desc" } }));
  });

  it("keeps the current search after an in-place reload (edit no longer wipes it)", async () => {
    // The default parameter used to read "" instead of the live query, so
    // saving a product while searching silently reset the list.
    const { controller, prisma } = setup(rows);
    await controller.page(undefined, "شکر", undefined, "name", "asc");
    const where = (prisma.product.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
  });

  it("resolves the low-stock window in raw SQL (stock <= minStock needs column comparison)", async () => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", name: "چای", stock: 1 }]) },
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
        sql.startsWith("SELECT COUNT(*)") ? Promise.resolve([{ count: 12 }]) : Promise.resolve([{ id: "p1" }])),
    };
    const controller = new ProductsController(prisma as never);
    const page = await controller.page(undefined, "چای", "100", "stock", "asc", "low");
    const calls = (prisma.$queryRawUnsafe as jest.Mock).mock.calls.map((call) => call[0]);
    // The comparison runs on the EFFECTIVE stock: bundles count how many kits
    // their components can build, so a drying-up kit lights the filter too.
    expect(calls[0]).toContain("<= minStock");
    expect(calls[0]).toContain("CASE WHEN Product.isBundle = 1");
    expect(calls[0]).toContain("BundleComponent");
    expect(calls[0]).toContain("LIKE ?");
    expect(calls[0]).toContain("LIMIT 100 OFFSET 100");
    expect(page.total).toBe(12);
    expect(page.list).toEqual([{ id: "p1", name: "چای", stock: 1 }]);
    expect(page.hasMore).toBe(false); // 100 + 1 < 12 is false → last page
  });

  it("keeps the raw stock-filter window on ACTIVE products (archived flag matches the Prisma branch)", async () => {
    // The raw id-window used to bind isActive to (archived === "1" ? 1 : 0) —
    // the exact inverse of the Prisma branch (isActive: archived !== "1") —
    // so the default low/out filters returned archived goods and nothing else.
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", stock: 1 }]) },
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
        sql.startsWith("SELECT COUNT(*)") ? Promise.resolve([{ count: 1 }]) : Promise.resolve([{ id: "p1" }])),
    };
    const controller = new ProductsController(prisma as never);
    await controller.page(undefined, undefined, "0", "stock", "asc", "low");
    const defaultCall = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(defaultCall[0]).toContain("isActive = ?");
    expect(defaultCall[1]).toBe(1); // default view = active products
    await controller.page("1", undefined, "0", "stock", "asc", "low");
    const archivedCall = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[2];
    expect(archivedCall[1]).toBe(0); // archived view = deactivated products
  });

  it("out-of-stock filter compares stock <= 0 and hydrates in id order", async () => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "b" }, { id: "a" }]) },
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
        sql.startsWith("SELECT COUNT(*)") ? Promise.resolve([{ count: 2 }]) : Promise.resolve([{ id: "a" }, { id: "b" }])),
    };
    const controller = new ProductsController(prisma as never);
    const page = await controller.page(undefined, undefined, "0", "stock", "asc", "out");
    expect((prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0]).toContain("<= 0");
    // Raw id order wins: pagination stays contiguous regardless of findMany order.
    expect(page.list.map((row: { id: string }) => row.id)).toEqual(["a", "b"]);
  });

  it("applies the archived flag and passes the search term into the where filter", async () => {
    const { controller, prisma } = setup(rows);
    await controller.page("1", "شکر", "0");
    const where = (prisma.product.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.isActive).toBe(false);
    expect(where.OR).toEqual([{ name: { contains: "شکر" } }, { sku: { contains: "شکر" } }, { barcode: { contains: "شکر" } }]);
  });
});

describe("Product update — bundle flip", () => {
  function flipSetup(stored: { isBundle: boolean; isSerialized: boolean }) {
    const tx = {
      bundleComponent: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      product: { update: jest.fn().mockResolvedValue({ id: "p1", sku: "S-1" }) },
    };
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue({ isBundle: stored.isBundle, isSerialized: stored.isSerialized }) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return { controller: new ProductsController(prisma as never), tx };
  }

  it("drops the stale BOM when a kit is turned back into a plain product", async () => {
    const { controller, tx } = flipSetup({ isBundle: true, isSerialized: false });
    await controller.update("p1", { name: "کالا", sku: "S-1", unit: "عدد", price: 10, isBundle: false } as never);
    expect(tx.bundleComponent.deleteMany).toHaveBeenCalledWith({ where: { bundleId: "p1" } });
  });

  it("keeps the BOM when the bundle flag stays on", async () => {
    const { controller, tx } = flipSetup({ isBundle: true, isSerialized: false });
    await controller.update("p1", { name: "کالا", sku: "S-1", unit: "عدد", price: 10 } as never);
    expect(tx.bundleComponent.deleteMany).not.toHaveBeenCalled();
  });
});
