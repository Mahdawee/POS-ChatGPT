// ─────────────────────────────────────────────────────────────────────────────
// تست A/B سیاست امنیتی (CSP) وب‌ویو Tauri برای عکس کالا
// ─────────────────────────────────────────────────────────────────────────────
// پس‌زمینه: در برنامهٔ دسکتاپ (Tauri) رابط کاربری از مبدأی جدا از سرورِ API
// بار می‌شود (tauri://localhost یا http://tauri.localhost)؛ CSP داخل
// tauri.conf.json تعیین می‌کند کدام مبدأها مجازند. «connect-src» درخواست‌های
// fetch را می‌پذیرد ولی «img-src» باید جداگانه تگ <img> (بندانگشتی عکس کالا)
// را بپذیرد — وگرنه برنامهٔ کاملاً سالم، بدون هیچ خطایی، همه‌جا عکس را نشان
// نمی‌دهد (باگ واقعی: CSP قدیمی فقط 'self' داشت و عکس‌های سرور بلاک می‌شدند).
//
// این تست محیط Tauri را در مرورگر شبیه‌سازی می‌کند:
//   ۱) سند برنامه با هدر CSP تزریقی سرو می‌شود (مثل تزریق خود Tauri)؛
//   ۲) localStorage «darpos-server-origin» از قبل تنظیم می‌شود تا همهٔ
//      درخواست‌ها و عکس‌ها مستقیم از http://127.0.0.1:4317 بیایند (مثل
//      کلاینت شبکه / وب‌ویو Tauri)، نه از پراکسی هم‌مبدأِ vite.
//
// دو گذر:
//   A) CSP قدیمی (بدون میزبان‌های API در img-src) → عکس بلاک، بازگشت نرم
//      به حرف اول نام کالا + ثبت خطای «Refused to load the image»؛
//   B) CSP فعلی — مستقیم از desktop/src-tauri/tauri.conf.json خوانده می‌شود
//      (نه رونوشت دستی) تا اگر کسی بعداً img-src را تنگ کرد، تست بشکند.
//
// پیش‌نیاز: سرور API روی 4317 + preview رابط روی 1420 + یک کالای عکس‌دار
// (اجرای e2e/ui-test.mjs روی همان دیتابیس این را فراهم می‌کند:
//   cd desktop && npm run build && npx vite preview --port 1420 &
//   POS_DATA_DIR=… API_PORT=4317 node server/dist/main.js
//   node e2e/ui-test.mjs && node e2e/csp-image-check.mjs)
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("پکیج playwright نصب نیست (فقط ابزار تست است، به پروژه اضافه نمی‌شود):\n  npm i -D playwright");
  process.exit(1);
}

const UI = process.env.E2E_UI || "http://127.0.0.1:1420";
const API_ORIGIN = process.env.E2E_API_ORIGIN || "http://127.0.0.1:4317";
const API = `${API_ORIGIN}/api`;
// نکتهٔ اجرا (مهم): شبیه‌سازی باید «مبدأِ صفحه ≠ مبدأ API» باشد؛ اما مرورگرهای
// جدید (Local Network Access) fetch به نشانی loopback از صفحهٔ غیرهممبدأ را
// بدون اجازه بلاک می‌کنند — محدودیتِ محیط تست است، نه برنامهٔ واقعی (وب‌ویو
// Tauri و حالت PWA هم‌مبدأ چنین محدودیتی ندارند). راه‌حل: مجوز
// «local-network-access» به مبدأ صفحه داده می‌شود تا fetchها رد شوند و فقط
// CSP بر سر راه عکس‌ها بماند — همان چیزی که می‌خواهیم بسنجیم.
const PRODUCT_ROW_TEXT = "رب گوجه فرنگی"; // کالای عکس‌دار که ui-test.mjs می‌سازد

// CSP جاریِ برنامهٔ دسکتاپ — منبع حقیقت: فایل پیکربندی Tauri
// (ریشهٔ مخزن از متغیر E2E_REPO یا نسبت به جای همین اسکریپت پیدا می‌شود؛
// چون playwright وابستگی پروژه نیست، اسکریپت معمولاً مثل ui-test.mjs به
// /tmp/pwtest کپی و از آن‌جا اجرا می‌شود — آن‌وقت E2E_REPO لازم است.)
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.E2E_REPO || [here, join(here, "..")].find((base) => existsSync(join(base, "desktop/src-tauri/tauri.conf.json")));
if (!repoRoot) {
  console.error("✗ ریشهٔ مخزن پیدا نشد — E2E_REPO=/path/to/POS-ChatGPT را تنظیم کنید.");
  process.exit(1);
}
const tauriConf = JSON.parse(readFileSync(join(repoRoot, "desktop/src-tauri/tauri.conf.json"), "utf8"));
const NEW_CSP = tauriConf.app.security.csp;
// CSP قدیمی (نسخهٔ دارای باگ): میزبان‌های API از img-src حذف می‌شوند
const OLD_CSP = NEW_CSP.replace("data: http://127.0.0.1:4317 http://*:*;", "data:;");
if (OLD_CSP === NEW_CSP) {
  console.error("✗ ساخت CSP قدیمی از tauri.conf.json ناموفق بود — الگوی img-src عوض شده؟");
  process.exit(1);
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
};

// رمز ادمین بعد از اجرای ui-test.mjs (گارد تغییر گذرواژه E2ePass12345 گذاشته؛
// برای تکرارپذیری روی دیتابیس‌های دیگر admin12345 هم امتحان می‌شود)
const loginOk = (pw) => fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: pw }) }).then((r) => r.ok);
const password = (await loginOk("E2ePass12345")) ? "E2ePass12345" : "admin12345";

const launchOptions = { headless: true };
if (process.env.E2E_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.E2E_EXECUTABLE_PATH;
  launchOptions.args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
}
const browser = await chromium.launch(launchOptions);

/** یک گذر: سند با CSP داده‌شده سرو می‌شود؛ برنامه مثل کلاینت شبکه مستقیم به
 *  127.0.0.1:4317 وصل می‌شود. خروجی: وضعیت عکس در جدول کالاها + خطاهای کنسول. */
async function runPass(csp) {
  const context = await browser.newContext();
  // مجوز دسترسی به شبکهٔ محلی برای مبدأ صفحه (توضیح بالا) — اگر مرورگرِ تست
  // این نام مجوز را نشناسد، بی‌صدا رد می‌شود و خودِ چک‌ها نتیجه را نشان می‌دهند.
  await context.grantPermissions(["local-network-access"], { origin: UI }).catch(() => {});
  // شبیه‌سازی کلاینت شبکه: همهٔ درخواست‌ها/عکس‌ها از مبدأ API می‌آیند
  await context.addInitScript((origin) => localStorage.setItem("darpos-server-origin", origin), API_ORIGIN);
  // تزریق CSP روی خودِ سند — همان کاری که Tauri با meta CSP می‌کند
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), headers: { ...response.headers(), "content-security-policy": csp }, body: await response.body() });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const consoleErrors = [];
  // متن کامل نگه داشته می‌شود (پیام CSP با URLهای بلند، «img-src» را در ۲۰۰
  // کاراکتر اول نمی‌آورد)؛ فقط هنگام نمایش کوتاه می‌شود.
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  // رخداد استانداردِ نقض CSP — در کرومیوم‌های جدید پیامِ کنسول از مسیر
  // Reporting API می‌رود و در رویداد console دیده نمی‌شود؛ این رخداد همیشه
  // با directive دقیق (مثل img-src) و URL بلاک‌شده می‌آید.
  await page.addInitScript(() => {
    (window).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window).__cspViolations.push(`${event.violatedDirective || event.directive || "?"} ${event.blockedURL || ""}`.trim());
    });
  });

  await page.goto(UI);
  const startTrial = page.getByRole("button", { name: "شروع دورهٔ آزمایشی ۱۴ روزه" });
  try { await startTrial.click({ timeout: 6000 }); await page.waitForTimeout(1500); } catch { /* لایسنس از قبل فعال است */ }
  await page.waitForSelector("form.login-form", { timeout: 20000 });
  await page.locator("form.login-form input").nth(0).fill("admin");
  await page.locator("form.login-form input").nth(1).fill(password);
  await page.locator("button.login-submit").click();
  await page.waitForSelector("form.login-form", { state: "detached", timeout: 20000 });
  await page.waitForTimeout(1500);

  const out = { loginOk: true, consoleErrors };
  try {
    await page.getByRole("button", { name: "کالاها", exact: true }).click();
    const row = page.locator("tr", { hasText: PRODUCT_ROW_TEXT }).first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    const cell = row.locator(".product-initial");
    await page.waitForTimeout(3000); // فرصت برای lazy-load یا onError → بازگشت نرم
    out.tableImgCount = await cell.locator("img").count();
    out.tableImgLoaded = out.tableImgCount ? await cell.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0) : false;
    out.tableImgSrc = out.tableImgCount ? await cell.locator("img").getAttribute("src") : null;
    out.tableLetter = (await cell.innerText().catch(() => "")).trim();
    out.cspViolations = await page.evaluate(() => (window).__cspViolations || []);
  } catch (e) {
    out.loginOk = false;
    out.error = String(e.message || e).slice(0, 140);
  }
  await context.close();
  return out;
}

// ── گذر A: CSP قدیمی — تشخیص: fetchها کار می‌کنند ولی <img> بلاک می‌شود
const passA = await runPass(OLD_CSP);
check("A) با CSP قدیمی: ورود و کار با برنامه از مبدأ 4317 سالم است (connect-src)", passA.loginOk, passA.error || "fetch بدون مشکل");
check("A) با CSP قدیمی: عکس کالا بلاک و حرف اول نام به‌جای آن می‌نشیند (بازگشت نرم)", passA.loginOk && passA.tableImgCount === 0 && passA.tableLetter.length > 0, `img=${passA.tableImgCount}، حرف="${passA.tableLetter}"`);
const cspViolation = (passA.cspViolations || []).find((v) => v.startsWith("img-src")) || passA.consoleErrors.find((t) => t.includes("Refused to load the image"));
check("A) با CSP قدیمی: مرورگر نقض CSPِ img-src را ثبت می‌کند (ریشهٔ باگ)", Boolean(cspViolation), cspViolation ? String(cspViolation).slice(0, 110) : "بدون نقض CSP");

// ── گذر B: CSP فعلی از tauri.conf.json — عکس‌ها باید بارگذاری شوند
const passB = await runPass(NEW_CSP);
check("B) با CSP فعلی (از tauri.conf.json): بندانگشتی در جدول کالاها بارگذاری می‌شود", passB.loginOk && passB.tableImgLoaded === true, `src=${passB.tableImgSrc || "—"}، naturalWidth>0`);
check("B) با CSP فعلی: هیچ نقض CSP یا خطای کنسولِ CSP نیست", passB.loginOk && !(passB.cspViolations || []).length && !passB.consoleErrors.some((t) => t.includes("Content Security Policy")), (passB.cspViolations || []).slice(0, 1).join("").slice(0, 90) || passB.consoleErrors.filter((t) => t.includes("Content Security Policy")).slice(0, 1).join("").slice(0, 90));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `✗ ${failed} چک شکست خورد` : "همهٔ چک‌های CSP سبز است"} (${results.length} چک)`);
process.exit(failed ? 1 : 0);
