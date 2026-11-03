import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "./prisma.service";
import { configureLocalStorage } from "./storage";

/**
 * Creates a consistent snapshot of the SQLite database in the local
 * `backups` folder using `VACUUM INTO`. Must be called OUTSIDE a
 * transaction. Returns the absolute path of the created file.
 */
/** The folder backups are currently written to: the validated custom dir
 *  from Settings (backupDir), or the standard local one. Pruning MUST
 *  resolve the same folder createBackup writes to — otherwise automatic
 *  backups pile up forever in a custom folder (USB stick / second drive)
 *  until it fills up. */
export function resolveBackupDir(custom?: string | null): string {
  const fallback = join(configureLocalStorage(), "backups");
  const trimmed = custom?.trim();
  if (!trimmed) return fallback;
  try { mkdirSync(trimmed, { recursive: true }); return trimmed; } catch { return fallback; }
}

export async function createBackup(prisma: PrismaService, prefix = "dar-pos"): Promise<string> {
  // Optional custom backup folder (Settings). Read at backup time — not
  // boot — so changing it applies immediately without a restart.
  let custom: string | null = null;
  try { custom = (await prisma.setting.findUnique({ where: { key: "backupDir" } }))?.value ?? null; } catch { /* keep default */ }
  const backupDir = resolveBackupDir(custom);
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
export function pruneAutoBackups(keep = 10, custom?: string | null): void {
  try {
    const backupDir = resolveBackupDir(custom);
    const files = readdirSync(backupDir).filter((name) => name.startsWith("auto-") && name.endsWith(".db"));
    files.sort();
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(backupDir, stale)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
