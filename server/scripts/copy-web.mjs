// ─────────────────────────────────────────────────────────────────────────────
// بیلد وب (../desktop/dist) را کنار API کامپایل‌شده (dist/web) کپی می‌کند تا
// سرور بتواند UI را از همان مبدأ سرو کند (PWA برای گوشی/کامپیوترهای دیگر).
// اگر desktop/dist وجود نداشته باشد (بیلد فقط-سرور)، بی‌صدا رد می‌شود و
// رفتار سرور مثل قبل می‌ماند. برای بیلد مستقل سرور، اول desktop را بیلد کنید.
// ─────────────────────────────────────────────────────────────────────────────
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url)); // server/scripts
const webDist = join(scriptDir, "..", "..", "desktop", "dist");
const target = join(scriptDir, "..", "dist", "web");

if (existsSync(webDist)) {
  rmSync(target, { recursive: true, force: true });
  cpSync(webDist, target, { recursive: true });
  console.log(`web UI copied to ${target}`);
} else {
  console.log("no desktop/dist found — server built without the web UI");
}
