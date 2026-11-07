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
  // بیلد فقط-سرور: رفتار عمدی است (استقرار API خالی)، اما وبِ کهنه را هم
  // پاک می‌کنیم تا سرور نسخهٔ قدیمی UI را سرو نکند و هشدار روشن می‌دهیم.
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log("removed stale dist/web (it would have served an outdated web UI)");
  }
  console.log("⚠  no desktop/dist found — server built WITHOUT the web UI.");
  console.log("   Phones/browsers opening the server address will see a setup page instead of the app.");
  console.log("   Fix: run the build from the project root (npm run build) so the frontend is built before the server; the running server picks it up on the next page refresh — no restart needed.");
}
