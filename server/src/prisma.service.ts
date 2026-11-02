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
];

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
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private optimizeTimer: NodeJS.Timeout | undefined;

  async onModuleInit() {
    await this.$connect();
    await this.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await this.$queryRawUnsafe("PRAGMA optimize");
    const schemaPath = join(__dirname, "../prisma/schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    for (const statement of schema.split(";").map((sql) => sql.trim()).filter(Boolean)) await this.$executeRawUnsafe(statement);
    await ensureColumnMigrations(this);
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
