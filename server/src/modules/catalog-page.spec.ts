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
