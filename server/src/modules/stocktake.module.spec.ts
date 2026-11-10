import { BadRequestException } from "@nestjs/common";
import { StocktakesController } from "./stocktake.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };

function setup(products = [
  { id: "product-1", name: "چای", sku: "T-1", stock: 8, isActive: true, isWeighted: false },
  { id: "product-2", name: "شکر", sku: "S-1", stock: 5, isActive: true, isWeighted: false },
]) {
  const stocktakeRow = { id: "st-1", name: "شمارش پایان هفته", status: "OPEN", lines: [] as unknown[] };
  let createdRow: Record<string, unknown> | null = null;
  const tx = {
    product: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) => Promise.resolve(products.filter((product) => where.id.in.includes(product.id)))),
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(products.find((product) => product.id === where.id) || null)),
      update: jest.fn().mockResolvedValue({}),
    },
    stocktake: {
      // Resolve with the nested `lines.create` flattened, the way Prisma
      // returns the created row including its relations.
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> & { lines: { create: unknown[] } } }) => {
        createdRow = { ...stocktakeRow, ...data, lines: data.lines.create };
        return Promise.resolve(createdRow);
      }),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(createdRow)),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...(createdRow || stocktakeRow), status: "APPLIED", ...data })),
    },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  // void/list/detail run outside a transaction, straight on the client.
  const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), stocktake: tx.stocktake, auditLog: tx.auditLog };
  return { controller: new StocktakesController(prisma as never), tx, stocktakeRow };
}

describe("Stocktakes", () => {
  it("freezes the expected quantity and the difference per line at creation", async () => {
    const { controller, tx } = setup();
    const record = (await controller.create({ lines: [{ productId: "product-1", counted: 6 }, { productId: "product-2", counted: 5 }] }, user)) as { lines: { productId: string; expected: number; counted: number; diff: number }[] };
    expect(tx.stocktake.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "OPEN", userId: user.id }) }));
    expect(record.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: "product-1", expected: 8, counted: 6, diff: -2 }),
        expect.objectContaining({ productId: "product-2", expected: 5, counted: 5, diff: 0 }),
      ]),
    );
    // Open counts adjust nothing yet.
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it("merges duplicated lines before writing", async () => {
    const { controller, tx } = setup();
    await controller.create({ lines: [{ productId: "product-1", counted: 2 }, { productId: "product-1", counted: 4 }] }, user);
    expect(tx.stocktake.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lines: { create: [expect.objectContaining({ counted: 6 })] } }) }));
  });

  it("keeps weighted counts and diffs free of float dirt (0.1 + 0.2 counted over 0.1 stock)", async () => {
    // دور ۸۱: جمع خام شمارش ۰٫۳۰۰۰…۴ و تفریق خام diff ۰٫۱۹۹۹…۹ ذخیره می‌شد.
    const { controller } = setup([{ id: "product-w", name: "برنج", sku: "R-1", stock: 0.1, isActive: true, isWeighted: true }]);
    const record = (await controller.create({ lines: [{ productId: "product-w", counted: 0.1 }, { productId: "product-w", counted: 0.2 }] }, user)) as { lines: { counted: number; expected: number; diff: number }[] };
    expect(record.lines).toHaveLength(1);
    expect(record.lines[0].counted).toBe(0.3);
    expect(record.lines[0].diff).toBe(0.2);
  });

  it("applies differences as stock adjustments with traceable movements", async () => {
    const { controller, tx, stocktakeRow } = setup();
    tx.stocktake.findUnique.mockResolvedValue({ ...stocktakeRow, status: "OPEN", lines: [{ productId: "product-1", counted: 6 }, { productId: "product-2", counted: 7 }] });
    await controller.applyEndpoint("st-1", user);
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: 6 } });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-2" }, data: { stock: 7 } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "ADJUSTMENT_OUT", quantity: -2, stockAfter: 6 }) }));
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "ADJUSTMENT_IN", quantity: 2, stockAfter: 7 }) }));
    expect(tx.stocktake.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) }));
  });

  it("creates + applies in one step when apply is set", async () => {
    const { controller, tx, stocktakeRow } = setup();
    tx.stocktake.findUnique.mockResolvedValue({ ...stocktakeRow, status: "OPEN", lines: [{ productId: "product-1", counted: 9, expected: 8, diff: 1 }] });
    const record = (await controller.create({ lines: [{ productId: "product-1", counted: 9 }], apply: true }, user)) as { status: string };
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: "product-1" }, data: { stock: 9 } });
    expect(record.status).toBe("APPLIED");
  });

  it("refuses to apply or void an already settled count", async () => {
    const { controller, tx, stocktakeRow } = setup();
    tx.stocktake.findUnique.mockResolvedValue({ ...stocktakeRow, status: "APPLIED", lines: [] });
    await expect(controller.applyEndpoint("st-1", user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.void("st-1", user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("voids an open count without touching stock", async () => {
    const { controller, tx, stocktakeRow } = setup();
    tx.stocktake.findUnique.mockResolvedValue({ ...stocktakeRow, status: "OPEN", lines: [{ productId: "product-1", counted: 99 }] });
    await controller.void("st-1", user);
    expect(tx.stocktake.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "VOID" } }));
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});
