import { backfillPaymentParts, ensureColumnMigrations } from "./prisma.service";

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
      Sale: ["id", "receiptNo", "subtotal", "total", "paymentMethod"],
      SaleItem: ["id", "saleId", "productId", "name", "sku", "quantity", "unitPrice", "lineTotal"],
      SaleReturn: ["id", "returnNo", "total"],
      SaleReturnItem: ["id", "saleReturnId", "productId", "name", "sku", "quantity", "unitPrice", "lineTotal"],
      Purchase: ["id", "invoiceNo", "note", "supplierId", "userId", "total", "createdAt"],
      PurchaseItem: ["id", "purchaseId", "productId", "quantity", "unitCost", "lineTotal"],
      Product: ["id", "name", "sku", "stock", "price", "cost", "isActive", "isWeighted", "expiryDate", "wholesalePrice", "wholesaleMinQty"],
      Customer: ["id", "name", "phone", "isActive"],
    });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([
      `ALTER TABLE "SaleItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturnItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Purchase" ADD COLUMN "paidAmount" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Product" ADD COLUMN "backstock" REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE "Customer" ADD COLUMN "creditLimit" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Sale" ADD COLUMN "cashPart" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Sale" ADD COLUMN "mobilePart" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Sale" ADD COLUMN "creditPart" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Sale" ADD COLUMN "invoiceNo" TEXT`,
      `ALTER TABLE "SaleItem" ADD COLUMN "discount" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturn" ADD COLUMN "creditRelief" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturn" ADD COLUMN "cashAmount" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "PurchaseItem" ADD COLUMN "expiryDate" DATETIME`,
    ]);
  });

  it("does nothing when all columns already exist", async () => {
    const { client, statements } = db({
      SaleItem: ["unitCost", "discount"],
      SaleReturnItem: ["unitCost"],
      Purchase: ["paidAmount"],
      PurchaseItem: ["expiryDate"],
      Product: ["isWeighted", "expiryDate", "wholesalePrice", "wholesaleMinQty", "backstock"],
      Customer: ["creditLimit"],
      Sale: ["cashPart", "mobilePart", "creditPart", "invoiceNo"],
      SaleReturn: ["creditRelief", "cashAmount"],
    });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([]);
  });

  it("does nothing when a table itself is missing", async () => {
    const { client, statements } = db({ SaleItem: ["unitCost", "discount"] });
    await ensureColumnMigrations(client);
    expect(statements).toEqual([]);
  });
});

describe("Payment-parts backfill for pre-parts databases", () => {
  it("derives parts from the legacy payment method and keeps round-14 down-payments on credit", async () => {
    const statements: string[] = [];
    const client = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(1); }) };
    await backfillPaymentParts(client);
    expect(statements).toEqual([
      expect.stringContaining(`UPDATE "Sale" SET "cashPart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'CASH'`),
      expect.stringContaining(`UPDATE "Sale" SET "mobilePart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'MOBILE'`),
      // plain credit sale: the down-payment amount stays cash-settled
      expect.stringContaining(`SET "creditPart" = "total" - "amountPaid"`),
      // round-14 down-payment rows exist: the whole total stays credit so the payment keeps settling it
      expect.stringContaining(`SET "creditPart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'CREDIT'
     AND EXISTS (SELECT 1 FROM "CustomerPayment" p WHERE p."note" LIKE '%فاکتور ' || "Sale"."receiptNo")`),
      // old returns against cash sales left the drawer; credit returns were relief
      expect.stringContaining(`UPDATE "SaleReturn" SET "cashAmount" = "total"`),
      expect.stringContaining(`UPDATE "SaleReturn" SET "creditRelief" = "total"`),
    ]);
    // Every Sale statement only touches rows whose parts are all still zero —
    // idempotent; re-running never rewrites an already-split payment.
    const saleStatements = statements.filter((sql) => sql.startsWith('UPDATE "Sale" SET'));
    expect(saleStatements.length).toBe(4);
    for (const sql of saleStatements) expect(sql).toContain(`WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0`);
  });
});
