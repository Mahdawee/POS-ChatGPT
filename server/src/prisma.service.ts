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
];

export async function ensureColumnMigrations(db: { $queryRawUnsafe(sql: string): Promise<unknown> }): Promise<void> {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const rows = (await db.$queryRawUnsafe(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>;
    if (rows.length && !rows.some((row) => row.name === column)) await db.$queryRawUnsafe(ddl);
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    const schemaPath = join(__dirname, "../prisma/schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    for (const statement of schema.split(";").map((sql) => sql.trim()).filter(Boolean)) await this.$executeRawUnsafe(statement);
    await ensureColumnMigrations(this);
    await ensureInitialData(this);
  }
  async onModuleDestroy() { await this.$disconnect(); }
}
