import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function configureLocalStorage(): string {
  const dataDir = resolve(process.env.POS_DATA_DIR || join(process.env.APPDATA || join(homedir(), ".local", "share"), "DarPOSERP"));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "pos.db").replace(/\\/g, "/");
  process.env.DATABASE_URL ||= `file:${dbPath}`;
  return dataDir;
}
