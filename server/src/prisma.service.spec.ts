import { backfillPaymentParts, ensureColumnMigrations, ensureUniqueCustomerCodes, ensureUniqueInvoiceNos, repairFractionalQuantities } from "./prisma.service";

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
      User: ["id", "username", "displayName", "passwordHash", "role", "isActive"],
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
      `ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false`,
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
      `ALTER TABLE "Customer" ADD COLUMN "code" TEXT`,
      `ALTER TABLE "Sale" ADD COLUMN "walletPart" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "SaleReturn" ADD COLUMN "walletRefund" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "Sale" ADD COLUMN "voidedAt" DATETIME`,
      `ALTER TABLE "Sale" ADD COLUMN "voidReason" TEXT`,
      `ALTER TABLE "Sale" ADD COLUMN "voidedBy" TEXT`,
      `ALTER TABLE "Purchase" ADD COLUMN "voidedAt" DATETIME`,
      `ALTER TABLE "Purchase" ADD COLUMN "voidReason" TEXT`,
      `ALTER TABLE "Purchase" ADD COLUMN "voidedBy" TEXT`,
    ]);
  });

  it("does nothing when all columns already exist", async () => {
    const { client, statements } = db({
      SaleItem: ["unitCost", "discount"],
      SaleReturnItem: ["unitCost"],
      Purchase: ["paidAmount", "voidedAt", "voidReason", "voidedBy"],
      PurchaseItem: ["expiryDate"],
      Product: ["isWeighted", "expiryDate", "wholesalePrice", "wholesaleMinQty", "backstock", "isBundle", "isSerialized", "reserved"],
      Customer: ["creditLimit", "walletBalance", "tier", "code"],
      Sale: ["cashPart", "mobilePart", "creditPart", "invoiceNo", "walletPart", "voidedAt", "voidReason", "voidedBy"],
      SaleReturn: ["creditRelief", "cashAmount", "walletRefund"],
      User: ["mustChangePassword"],
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

describe("Fractional-quantity repair for countable goods (round-30 stepper bug)", () => {
  it("heals workflow lines, open stocktakes and recomputes reservations", async () => {
    const statements: string[] = [];
    const client = { $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(0); }) };
    await repairFractionalQuantities(client);
    // Only fractional quantities of countable (non-weighted) goods are touched…
    expect(statements[0]).toEqual(expect.stringContaining(`UPDATE "CustomerOrderLine" SET "quantity" = ROUND("quantity") WHERE "quantity" != ROUND("quantity") AND "productId" IN (SELECT id FROM "Product" WHERE "isWeighted" = 0)`));
    expect(statements[1]).toEqual(expect.stringContaining(`UPDATE "QuoteItem" SET "quantity" = ROUND("quantity")`));
    expect(statements[2]).toEqual(expect.stringContaining(`UPDATE "PurchaseItem" SET "quantity" = ROUND("quantity")`));
    expect(statements[3]).toEqual(expect.stringContaining(`UPDATE "StocktakeLine" SET "counted" = ROUND("counted")`));
    expect(statements[3]).toEqual(expect.stringContaining(`status = 'OPEN'`));
    // …and reservations are recomputed from the healed OPEN order lines, so
    // products whose lines were rounded down release the phantom fraction.
    expect(statements[4]).toEqual(expect.stringContaining(`UPDATE "Product" SET "reserved" = COALESCE((SELECT SUM(l."quantity" - l."deliveredQty")`));
    // Sales history stays untouched — financial records are never rewritten.
    expect(statements.some((sql) => sql.includes('"SaleItem"') || sql.includes('"SaleReturnItem"'))).toBe(false);
    // Idempotent: whole numbers never match `quantity != ROUND(quantity)`.
    expect(statements[0]).toEqual(expect.stringContaining(`WHERE "quantity" != ROUND("quantity")`));
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

describe("Customer-code repair before the unique index is built", () => {
  it("suffixes only later duplicates and leaves NULL codes alone", async () => {
    const statements: string[] = [];
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ name: "Customer" }]),
      $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(0); }),
    };
    await ensureUniqueCustomerCodes(client);
    // One pass: within each duplicate group only the oldest row keeps the
    // code; the rest get a stable `-<rowid>` suffix. NULL is guarded
    // explicitly — concatenating onto NULL would stay NULL anyway, but the
    // guard documents the intent (multiple NULLs are fine for the index).
    expect(statements).toEqual([
      expect.stringContaining(`UPDATE "Customer" SET "code" = "code" || '-' || "rowid" WHERE "code" IS NOT NULL AND "rowid" NOT IN (SELECT MIN("rowid") FROM "Customer" GROUP BY "code")`),
    ]);
  });

  it("does nothing on a brand-new database (Customer table not created yet)", async () => {
    const statements: string[] = [];
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => { statements.push(sql); return Promise.resolve(0); }),
    };
    await ensureUniqueCustomerCodes(client);
    expect(statements).toEqual([]);
  });
});
