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
