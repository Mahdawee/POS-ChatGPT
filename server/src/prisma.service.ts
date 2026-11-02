import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInitialData } from "./bootstrap-data";

/**
 * Columns added to EXISTING tables after the first release. `schema.sql` only
 * creates tables that do not exist yet, so additive columns on old tables are
 * backfilled here with idempotent `ALTER TABLE ... ADD COLUMN` statements.
 * Never remove an entry: installed databases rely on this list to catch up.
 */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "SaleItem", column: "unitCost", ddl: `ALTER TABLE "SaleItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0` },
  { table: "SaleReturnItem", column: "unitCost", ddl: `ALTER TABLE "SaleReturnItem" ADD COLUMN "unitCost" INTEGER NOT NULL DEFAULT 0` },
  { table: "Purchase", column: "paidAmount", ddl: `ALTER TABLE "Purchase" ADD COLUMN "paidAmount" INTEGER NOT NULL DEFAULT 0` },
  { table: "Product", column: "isWeighted", ddl: `ALTER TABLE "Product" ADD COLUMN "isWeighted" BOOLEAN NOT NULL DEFAULT false` },
  { table: "Product", column: "expiryDate", ddl: `ALTER TABLE "Product" ADD COLUMN "expiryDate" DATETIME` },
  { table: "Product", column: "wholesalePrice", ddl: `ALTER TABLE "Product" ADD COLUMN "wholesalePrice" INTEGER` },
  { table: "Product", column: "wholesaleMinQty", ddl: `ALTER TABLE "Product" ADD COLUMN "wholesaleMinQty" REAL` },
  { table: "Product", column: "backstock", ddl: `ALTER TABLE "Product" ADD COLUMN "backstock" REAL NOT NULL DEFAULT 0` },
  { table: "Customer", column: "creditLimit", ddl: `ALTER TABLE "Customer" ADD COLUMN "creditLimit" INTEGER NOT NULL DEFAULT 0` },
  { table: "Sale", column: "cashPart", ddl: `ALTER TABLE "Sale" ADD COLUMN "cashPart" INTEGER NOT NULL DEFAULT 0` },
  { table: "Sale", column: "mobilePart", ddl: `ALTER TABLE "Sale" ADD COLUMN "mobilePart" INTEGER NOT NULL DEFAULT 0` },
  { table: "Sale", column: "creditPart", ddl: `ALTER TABLE "Sale" ADD COLUMN "creditPart" INTEGER NOT NULL DEFAULT 0` },
  { table: "Sale", column: "invoiceNo", ddl: `ALTER TABLE "Sale" ADD COLUMN "invoiceNo" TEXT` },
  { table: "SaleItem", column: "discount", ddl: `ALTER TABLE "SaleItem" ADD COLUMN "discount" INTEGER NOT NULL DEFAULT 0` },
  { table: "SaleReturn", column: "creditRelief", ddl: `ALTER TABLE "SaleReturn" ADD COLUMN "creditRelief" INTEGER NOT NULL DEFAULT 0` },
  { table: "SaleReturn", column: "cashAmount", ddl: `ALTER TABLE "SaleReturn" ADD COLUMN "cashAmount" INTEGER NOT NULL DEFAULT 0` },
  { table: "PurchaseItem", column: "expiryDate", ddl: `ALTER TABLE "PurchaseItem" ADD COLUMN "expiryDate" DATETIME` },
];

/**
 * One-time data migration for databases created before payment "parts"
 * (cashPart/mobilePart/creditPart) existed: derive the parts from the legacy
 * paymentMethod/amountPaid columns. Idempotent — rows already carrying a
 * non-zero part are left alone, and re-running produces the same values.
 * Sales written by the short-lived round-14 down-payment path (they carry a
 * customerPayment whose note references the receipt) keep their full total
 * as creditPart so the payment row keeps settling it, exactly as before.
 */
export async function backfillPaymentParts(db: {
  $queryRawUnsafe(sql: string): Promise<unknown>;
  $executeRawUnsafe(sql: string): Promise<unknown>;
}): Promise<void> {
  // Cash sales: everything was cash (change was already handed back).
  await db.$executeRawUnsafe(
    `UPDATE "Sale" SET "cashPart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'CASH'`,
  );
  // Mobile sales: everything was settled by mobile money.
  await db.$executeRawUnsafe(
    `UPDATE "Sale" SET "mobilePart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'MOBILE'`,
  );
  // Credit sales without a down-payment row: the paid part is amountPaid.
  await db.$executeRawUnsafe(
    `UPDATE "Sale" SET "creditPart" = "total" - "amountPaid" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'CREDIT'
     AND "amountPaid" <= "total" AND NOT EXISTS (SELECT 1 FROM "CustomerPayment" p WHERE p."note" LIKE '%فاکتور ' || "Sale"."receiptNo")`,
  );
  // Round-14 style down-payments already sit in a payment row: the whole
  // invoice total stays credit so the payment keeps settling it.
  await db.$executeRawUnsafe(
    `UPDATE "Sale" SET "creditPart" = "total" WHERE "cashPart" = 0 AND "mobilePart" = 0 AND "creditPart" = 0 AND "paymentMethod" = 'CREDIT'
     AND EXISTS (SELECT 1 FROM "CustomerPayment" p WHERE p."note" LIKE '%فاکتور ' || "Sale"."receiptNo")`,
  );
  // Old returns: cash sales refunded from the drawer; credit returns were
  // debt relief. Mirrors what the balance formulas used before parts existed.
  await db.$executeRawUnsafe(
    `UPDATE "SaleReturn" SET "cashAmount" = "total" WHERE "cashAmount" = 0 AND "creditRelief" = 0 AND "saleId" IN (SELECT "id" FROM "Sale" WHERE "paymentMethod" = 'CASH')`,
  );
  await db.$executeRawUnsafe(
    `UPDATE "SaleReturn" SET "creditRelief" = "total" WHERE "cashAmount" = 0 AND "creditRelief" = 0 AND "saleId" IN (SELECT "id" FROM "Sale" WHERE "paymentMethod" = 'CREDIT')`,
  );
}

export async function ensureColumnMigrations(db: { $queryRawUnsafe(sql: string): Promise<unknown> }): Promise<void> {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const rows = (await db.$queryRawUnsafe(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>;
    if (rows.length && !rows.some((row) => row.name === column)) await db.$queryRawUnsafe(ddl);
  }
}

/**
 * SQLite tuning applied to every database at boot:
 * - WAL lets reads (reports, lists) continue while a sale is being written.
 * - `PRAGMA optimize` refreshes the query planner's statistics; we repeat it
 *   once a day because long-running POS processes never see the connections
 *   that would normally trigger it automatically.
 * Note on quantity columns: existing databases keep their INTEGER-affinity
 * columns; SQLite stores fractional values (e.g. 1.5 kg) as REAL inside them
 * losslessly, which Prisma's Float fields read back unchanged. New databases
 * get REAL columns straight from schema.sql.
 */
/**
 * Models the application queries. The generated Prisma client must know all
 * of them; a stale client (schema.prisma updated by a pull, client never
 * regenerated) exposes `undefined` for the new models and every endpoint
 * touching them dies with "Cannot read properties of undefined (reading
 * 'findMany')". Checked loudly at boot so api.log names the real cause
 * instead of leaving the cashier with cryptic 5xx replies.
 */
const REQUIRED_MODELS = [
  "user", "setting", "category", "product", "customer", "supplier",
  "sale", "saleItem", "saleReturn", "saleReturnItem",
  "purchase", "purchaseItem", "purchaseReturn", "purchaseReturnItem",
  "customerPayment", "supplierPayment",
  "inventoryMovement", "cashSession", "cashMovement",
  "expense", "auditLog",
  "stocktake", "stocktakeLine", "quote", "quoteItem", "productBatch",
] as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private optimizeTimer: NodeJS.Timeout | undefined;

  async onModuleInit() {
    await this.$connect();
    const missing = REQUIRED_MODELS.filter((model) => !(this as unknown as Record<string, unknown>)[model]);
    if (missing.length) {
      // Loud and actionable: this is a developer-machine problem (stale
      // generated client), not a data problem. Dev starts regenerate the
      // client automatically now, so a restart fixes it.
      console.error(
        `[prisma-client] The generated Prisma client is OUT OF DATE — these models are missing: ${missing.join(", ")}. ` +
          "Run `npm run db:generate` in the server folder (or restart `npm run dev`) and restart the app.",
      );
    }
    await this.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await this.$queryRawUnsafe("PRAGMA optimize");
    const schemaPath = join(__dirname, "../prisma/schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    for (const statement of schema.split(";").map((sql) => sql.trim()).filter(Boolean)) await this.$executeRawUnsafe(statement);
    await ensureColumnMigrations(this);
    await backfillPaymentParts(this);
    await ensureInitialData(this);
    this.optimizeTimer = setInterval(() => {
      this.$queryRawUnsafe("PRAGMA optimize").catch(() => undefined);
    }, 24 * 60 * 60 * 1000);
  }
  async onModuleDestroy() {
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    await this.$queryRawUnsafe("PRAGMA optimize").catch(() => undefined);
    await this.$disconnect();
  }
}
