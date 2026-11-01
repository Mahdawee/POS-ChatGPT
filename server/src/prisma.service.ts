import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInitialData } from "./bootstrap-data";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    const schemaPath = join(__dirname, "../prisma/schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    for (const statement of schema.split(";").map((sql) => sql.trim()).filter(Boolean)) await this.$executeRawUnsafe(statement);
    await ensureInitialData(this);
  }
  async onModuleDestroy() { await this.$disconnect(); }
}
