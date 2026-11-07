import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Absolute file path of the SQLite database — the `file:` prefix and any
 *  connection parameters (e.g. ?socket_timeout=15) stripped. File-level
 *  operations (backup/restore) need the bare path: a Windows path carrying a
 *  `?` is not even a legal filename and writeFileSync would fail. */
export function databaseFilePath(): string {
  return (process.env.DATABASE_URL || "").replace(/^file:/, "").replace(/\?.*$/, "");
}

export function configureLocalStorage(): string {
  const dataDir = resolve(process.env.POS_DATA_DIR || join(process.env.APPDATA || join(homedir(), ".local", "share"), "DarPOSERP"));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "pos.db").replace(/\\/g, "/");
  // socket_timeout (seconds) is applied by the Prisma SQLite connector to
  // EVERY pooled connection as SQLite's busy_timeout. A plain
  // `PRAGMA busy_timeout` via $queryRawUnsafe would only reach the single
  // connection that happens to run it. 15s means a second register's checkout
  // WAITS for a heavy import/report to release the write lock instead of
  // failing instantly with "database is locked" — WAL already lets reads
  // through, this only serializes writers.
  process.env.DATABASE_URL ||= `file:${dbPath}?socket_timeout=15`;
  return dataDir;
}
