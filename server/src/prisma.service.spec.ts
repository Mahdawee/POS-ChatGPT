import { backfillPaymentParts, ensureColumnMigrations, ensureUniqueInvoiceNos } from "./prisma.service";

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
      `ALTER TABLE "Product" ADD COLUMN "isBundle" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "Product" ADD COLUMN "isSerialized" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "Product" ADD COLUMN "reserved" REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE "Customer" ADD COLUMN "walletBalance" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Customer" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'RETAIL'`,
      `ALTER TABLE "Sale" ADD COLUMN "walletPart" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturn" ADD COLUMN "walletRefund" INTEGER NOT NULL DEFAULT 0`,
    ]);
  });

  it("does nothing when all columns already exist", async () => {
    const { client, statements } = db({
      SaleItem: ["unitCost", "discount"],
      SaleReturnItem: ["unitCost"],
      Purchase: ["paidAmount"],
      PurchaseItem: ["expiryDate"],
      Product: ["isWeighted", "expiryDate", "wholesalePrice", "wholesaleMinQty", "backstock", "isBundle", "isSerialized", "reserved"],
      Customer: ["creditLimit", "walletBalance", "tier"],
      Sale: ["cashPart", "mobilePart", "creditPart", "invoiceNo", "walletPart"],
      SaleReturn: ["creditRelief", "cashAmount", "walletRefund"],
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

describe("Invoice-number repair before the unique index is built", () => {
  it("backfills blank numbers and only suffixes later duplicates", async () => {
    const statements: string[] = [];
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ name: "Sale" }]),
      $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(0); }),
    };
    await ensureUniqueInvoiceNos(client);
    expect(statements).toEqual([
      // 1) sales without a number inherit one from their receipt number…
      expect.stringContaining(`UPDATE "Sale" SET "invoiceNo" = 'INV-' || COALESCE("receiptNo", "id") WHERE "invoiceNo" IS NULL OR "invoiceNo" = ''`),
      // 2) …and within each duplicate group only the oldest row keeps the
      //    number; the rest get a stable `-<rowid>` suffix.
      expect.stringContaining(`UPDATE "Sale" SET "invoiceNo" = "invoiceNo" || '-' || "rowid" WHERE "rowid" NOT IN (SELECT MIN("rowid") FROM "Sale" GROUP BY "invoiceNo")`),
    ]);
    // Both statements are unconditional full-table passes that converge after
    // one run: on a second run every number is present and unique, so both
    // UPDATEs simply match zero rows (idempotent by construction).
  });

  it("does nothing on a brand-new database (Sale table not created yet)", async () => {
    // schema.sql runs AFTER this step, so a fresh install reaches here with
    // no Sale table — the repair must skip instead of crashing the boot.
    const statements: string[] = [];
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(0); }),
    };
    await ensureUniqueInvoiceNos(client);
    expect(statements).toEqual([]);
  });
});
