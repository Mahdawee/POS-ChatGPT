import { ensureColumnMigrations } from "./prisma.service";

function db(tableColumns: Record<string, string[]>) {
  const statements: string[] = [];
  return {
    statements,
    client: {
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
        const match = /PRAGMA table_info\('([^']+)'\)/.exec(sql);
        if (match) {
          const columns = tableColumns[match[1]] || [];
          return Promise.resolve(columns.map((name) => ({ name })));
        }
        statements.push(sql);
        return Promise.resolve([]);
      }),
    },
  };
}

describe("Column migrations for installed databases", () => {
  it("adds every missing column to its existing table", async () => {
    const { client, statements } = db({
      SaleItem: ["id", "saleId", "productId", "name", "sku", "quantity", "unitPrice", "lineTotal"],
      SaleReturnItem: ["id", "saleReturnId", "productId", "name", "sku", "quantity", "unitPrice", "lineTotal"],
      Purchase: ["id", "invoiceNo", "note", "supplierId", "userId", "total", "createdAt"],
    });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([
      `ALTER TABLE "SaleItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturnItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Purchase" ADD COLUMN "paidAmount" INTEGER NOT NULL DEFAULT 0`,
    ]);
  });

  it("does nothing when all columns already exist", async () => {
    const { client, statements } = db({
      SaleItem: ["unitCost"],
      SaleReturnItem: ["unitCost"],
      Purchase: ["paidAmount"],
    });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([]);
  });

  it("does nothing when a table itself is missing", async () => {
    const { client, statements } = db({ SaleItem: ["unitCost"] });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([]);
  });
});
