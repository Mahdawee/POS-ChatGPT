import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "./prisma.service";
import { configureLocalStorage } from "./storage";

/**
 * Creates a consistent snapshot of the SQLite database in the local
 * `backups` folder using `VACUUM INTO`. Must be called OUTSIDE a
 * transaction. Returns the absolute path of the created file.
 */
export async function createBackup(prisma: PrismaService, prefix = "dar-pos"): Promise<string> {
  const dataDir = configureLocalStorage();
  // Optional custom backup folder (Settings). Read at backup time — not
  // boot — so changing it applies immediately without a restart; blank or
  // unreadable values fall back to the standard local folder.
  let backupDir = join(dataDir, "backups");
  try {
    const setting = await prisma.setting.findUnique({ where: { key: "backupDir" } });
    const custom = setting?.value?.trim();
    if (custom) {
      mkdirSync(custom, { recursive: true });
      backupDir = custom;
    }
  } catch { /* keep default */ }
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(backupDir, `${prefix}-${stamp}.db`).replace(/\\/g, "/");
  const sqlPath = filePath.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);
  return filePath;
}

/**
 * Keeps only the newest `keep` automatic backups (files starting with
 * "auto-") so closing the shift never fills the disk.
 */
export function pruneAutoBackups(keep = 10): void {
  try {
    const backupDir = join(configureLocalStorage(), "backups");
    const files = readdirSync(backupDir).filter((name) => name.startsWith("auto-") && name.endsWith(".db"));
    files.sort();
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(backupDir, stale)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
