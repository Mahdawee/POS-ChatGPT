// ─────────────────────────────────────────────────────────────────────────────
// تست E2E (سر تا سر) برنامهٔ دسکتاپ — ربات مرورگر مثل کاربر واقعی کار می‌کند.
//
// پیش‌نیازها (فقط برای اجرای تست — به وابستگی‌های پروژه اضافه نمی‌شود):
//   1) سرور در حال اجرا روی 127.0.0.1:4317 (POS_DATA_DIR تازه = دیتابیس خالی)
//   2) بیلد دسکتاپ سرو شده روی 127.0.0.1:1420 (مثلاً: cd desktop && npm run build && npx vite preview)
//   3) پکیج playwright (اختیاری، فقط ابزار تست):
//        npm i -D playwright && npx playwright install chromium
//
// اجرا:  node e2e/ui-test.mjs
// متغیرهای محیطی (همه اختیاری):
//   E2E_UI=http://127.0.0.1:1420   نشانی UI دسکتاپ
//   E2E_API=http://127.0.0.1:4317/api  ریشهٔ API سرور
//   E2E_BRIDGE=http://127.0.0.1:4319   نشانی HTTP پل اسکن گوشی
//   E2E_EXECUTABLE_PATH=…             مسیر کرومیوم جایگزین (اگر مرورگر
//                                     پیش‌فرض playwright در دسترس نیست)
//
// سناریوها (۱۸ چک): ورود، شروع دورهٔ آزمایشی، ثبت سریع کالا با کد خودکار،
// اسکن بارکد با گوشیِ شبیه‌سازی‌شده (پل PIN) داخل فرم کالا، «ذخیره و کالای
// بعدی»، Enter، لیست سبک صندوق (/products/pos)، کد خودکار مشتری،
// اسکن خارج از صندوق (نباید بی‌سروصدا به سبد اضافه شود)، payload قدیمی
// تأمین‌کننده، و PWA (manifest، sw.js، ثبت سرویس‌ورکر).
// ─────────────────────────────────────────────────────────────────────────────

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("پکیج playwright نصب نیست. برای اجرای تست E2E (به پروژه اضافه نمی‌شود، فقط ابزار تست):\n  npm i -D playwright\n  npx playwright install chromium");
  process.exit(1);
}

const UI = process.env.E2E_UI || "http://127.0.0.1:1420";
const API = process.env.E2E_API || "http://127.0.0.1:4317/api";
const BRIDGE = process.env.E2E_BRIDGE || "http://127.0.0.1:4319";
const scanCode = "9" + String(Date.now()).slice(-12); // بارکد یکتای ۱۳ رقمی هر اجرا

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
};

const launchOptions = { headless: true };
if (process.env.E2E_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.E2E_EXECUTABLE_PATH;
  launchOptions.args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
}
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();
page.setDefaultTimeout(15000);
try {
  // ── ۱) ورود (دیتابیس تازه: اول صفحهٔ لایسنس می‌آید)
  await page.goto(UI);
  const startTrial = page.getByRole("button", { name: "شروع دورهٔ آزمایشی ۱۴ روزه" });
  try { await startTrial.click({ timeout: 8000 }); await page.waitForTimeout(1500); } catch { /* از قبل فعال */ }
  await page.waitForSelector("form.login-form", { timeout: 20000 });
  await page.locator("form.login-form input").nth(0).fill("admin");
  await page.locator("form.login-form input").nth(1).fill("admin12345");
  await page.locator("button.login-submit").click();
  await page.waitForSelector("form.login-form", { state: "detached", timeout: 20000 });
  await page.waitForTimeout(1500);
  check("ورود به برنامه", true);
  const login2 = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin12345" }) }).then((r) => r.json());
  const authHeaders = { Authorization: `Bearer ${login2.accessToken}` };

  // ── ۲) کد بعدی را از وضعیت فعلی دیتابیس حساب کن (تست را تکرارپذیر می‌کند)
  const prodsNow = await fetch(`${API}/products`, { headers: authHeaders }).then((r) => r.json());
  const maxP = prodsNow.reduce((m, p) => { const g = /^P-(\d+)$/.exec(p.sku || ""); return g ? Math.max(m, +g[1]) : m; }, 1000);
  const nextP1 = `P-${maxP + 1}`, nextP2 = `P-${maxP + 2}`;
  const custsNow = await fetch(`${API}/customers`, { headers: authHeaders }).then((r) => r.json());
  const maxC = custsNow.reduce((m, c) => { const g = /^C-(\d+)$/.exec(c.code || ""); return g ? Math.max(m, +g[1]) : m; }, 1000);
  const nextC1 = `C-${maxC + 1}`;

  // ── لیست سبک صندوق: فقط فیلدهای فروش سریع، فقط کالاهای فعال
  const posRes = await fetch(`${API}/products/pos`, { headers: authHeaders });
  const posList = posRes.ok ? await posRes.json() : [];
  const posShapeOk = Array.isArray(posList) && posList.every((p) => "id" in p && "name" in p && "price" in p && "stock" in p && "barcode" in p);
  check("لیست سبک صندوق (/products/pos) پاسخ می‌دهد و شکل درست دارد", posRes.ok && posShapeOk, `HTTP ${posRes.status}، ${posList.length} کالا`);

  // ── ۳) صفحهٔ کالاها → کالای جدید (فقط نام و قیمت — بدون کد)
  await page.getByRole("button", { name: "کالاها", exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "کالای جدید" }).click();
  const modal = page.locator("section.modal").first();
  const nameInput = modal.locator("input").first();
  const prodName = `شیر تازه ${String(Date.now()).slice(-4)}`;
  await nameInput.fill(prodName);
  await modal.locator('input[type="number"]').first().fill("65");

  // ── ۴) شبیه‌سازی اسکن گوشی: جفت‌شدن با PIN همین دستگاه و فرستادن بارکد
  // (نشست per-دستگاه: PIN باید با شناسهٔ همین صفحه گرفته شود تا اسکن به همین
  // دستگاه برسد، نه دستگاه‌های دیگر)
  const scanClient = await page.evaluate(() => localStorage.getItem("darpos:scan-client-id") || "");
  const pin = await fetch(`${API}/phone-scan/pin${scanClient ? `?client=${encodeURIComponent(scanClient)}` : ""}`, { headers: authHeaders }).then((r) => r.json());
  const pair = await fetch(`${BRIDGE}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pin.pin }) }).then((r) => r.json());
  check("جفت‌شدن شبیه‌سازی‌شدهٔ گوشی با پل (PIN)", Boolean(pair.token));

  // فرم کالا هنوز باز است → اسکن باید در فیلد بارکد بنشیند
  await fetch(`${BRIDGE}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: pair.token, code: scanCode }) });
  const barcodeInput = modal.locator('input[data-scan-target="product-barcode"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('input[data-scan-target="product-barcode"]');
    return el && el.value.length > 0;
  }, { timeout: 8000 });
  const barcodeValue = await barcodeInput.inputValue();
  check("بارکد اسکن‌شده با «گوشی» در فیلد بارکد فرم کالا نشست", barcodeValue === scanCode, barcodeValue);

  // ── ۵) ذخیره و کالای بعدی: فرم باز می‌ماند + کد خودکار در پیام
  const saved1 = page.waitForResponse((r) => r.url().includes("/api/products") && r.request().method() === "POST", { timeout: 12000 });
  await page.getByRole("button", { name: "ذخیره و کالای بعدی" }).click();
  const resp1 = await saved1;
  await page.waitForTimeout(1200);
  const toasts1 = await page.locator(".toast").allTextContents().catch(() => []);
  const toast1 = toasts1.join(" | ");
  check(`پیامِ ثبت شامل کد خودکار ${nextP1}`, resp1.status() === 201 && toast1.includes(nextP1), toast1.slice(0, 70));
  const stillOpen = await modal.locator('input[data-scan-target="product-barcode"]').count();
  check("فرم برای کالای بعدی باز ماند", stillOpen === 1);
  const nameAfter = await modal.locator("input").first().inputValue();
  const barcodeAfter = await barcodeInput.inputValue();
  check("فرم برای کالای بعدی پاک شد (نام و بارکد خالی)", nameAfter === "" && barcodeAfter === "", `name="${nameAfter}" barcode="${barcodeAfter}"`);

  // ── ۶) کالای دوم با Enter (بدون کد و بارکد)
  await modal.locator("input").first().fill("ماست کلاسیک");
  await modal.locator('input[type="number"]').first().fill("45");
  const saved2 = page.waitForResponse((r) => r.url().includes("/api/products") && r.request().method() === "POST", { timeout: 12000 });
  await page.keyboard.press("Enter");
  const resp2 = await saved2;
  await page.waitForTimeout(1200);
  const toasts2 = await page.locator(".toast").allTextContents().catch(() => []);
  const toast2 = toasts2.join(" | ");
  check(`Enter هم «کالای بعدی» را می‌زند و کد ${nextP2} ساخت`, resp2.status() === 201 && toast2.includes(nextP2), toast2.slice(0, 70));

  // ── ۷) ذخیره و بستن → در جدول کد و بارکد دیده شود
  await modal.locator("input").first().fill("پنیر سفید");
  await modal.locator('input[type="number"]').first().fill("120");
  const saved3 = page.waitForResponse((r) => r.url().includes("/api/products") && r.request().method() === "POST", { timeout: 12000 });
  await page.getByRole("button", { name: "ذخیره و بستن" }).click();
  await saved3;
  await page.locator("section.modal").first().waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(800);
  const row = page.locator("tr", { hasText: prodName });
  await row.first().waitFor({ state: "visible", timeout: 8000 });
  check("ردیف کالا در جدول با بارکد", (await row.locator("text=" + scanCode).count()) === 1);

  // ── ۸) مشتری بدون کد → کد خودکار C-…
  await page.getByRole("button", { name: "مشتریان", exact: true }).click();
  await page.waitForTimeout(800);
  await page.locator("section.surface button.primary-button", { hasText: "افزودن" }).first().click();
  await page.waitForTimeout(400);
  const cmodal = page.locator("section.modal").first();
  const custName = `نجیب ${String(Date.now()).slice(-4)}`;
  await cmodal.locator("input").first().fill(custName);
  await cmodal.locator("button.primary-button").last().click();
  await page.locator("section.modal").first().waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(800);
  const crow = page.locator("tr", { hasText: custName });
  check(`کد مشتری خودکار ${nextC1} در جدول`, (await crow.locator(`text=${nextC1}`).count()) === 1);

  // ── ۹) اسکنِ خارج از صندوق: صندوق را باز کن (نصب می‌ماند)، به کالاها
  // برگرد، اسکن کن → فقط پیام، سبد نباید بی‌سروصدا پر شود.
  await page.getByRole("button", { name: "صندوق فروش", exact: false }).first().click();
  await page.waitForTimeout(800);
  const gridCount = await page.locator(".pos-product").count();
  check("صفحهٔ صندوق با لیست سبک کالاها را نشان می‌دهد", gridCount > 0, `${gridCount} کالا در گرید`);
  await page.getByRole("button", { name: "کالاها", exact: true }).click();
  await page.waitForTimeout(800);
  await fetch(`${BRIDGE}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: pair.token, code: scanCode }) });
  await page.waitForTimeout(2500);
  const toast3 = (await page.locator(".toast").allTextContents().catch(() => [])).join(" | ");
  check("اسکن روی صفحهٔ کالاها → پیام (نه افزودن بی‌سروصدا)", toast3.includes(scanCode), toast3.trim().slice(0, 50));
  await page.getByRole("button", { name: "صندوق فروش", exact: false }).first().click();
  await page.waitForTimeout(1200);
  const cartLines = await page.locator("aside.cart-panel .cart-line").count();
  const cartEmpty = await page.locator("aside.cart-panel .cart-empty").count();
  check("سبد صندوق پس از اسکنِ خارج از صندوق خالی ماند", cartLines === 0 && cartEmpty === 1, `ردیف‌های سبد: ${cartLines}، حالت خالی: ${cartEmpty}`);

  // ── ۱۰) payload قدیمی تأمین‌کننده (creditLimit/tier) — از API
  const sup = await fetch(`${API}/suppliers`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ name: "تست تأمین‌کننده", creditLimit: 500, tier: "RETAIL" }) });
  check("ساخت تأمین‌کننده با payload قدیمی (creditLimit/tier) بدون خطا", sup.status === 201, `HTTP ${sup.status}`);
  if (sup.status === 201) {
    const sj = await sup.json();
    const upd = await fetch(`${API}/suppliers/${sj.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ name: "تست تأمین‌کننده ویرایش", phone: "07001112233", creditLimit: 900, tier: "WHOLESALE", code: "X-9" }) });
    check("ویرایش تأمین‌کننده با payload قدیمی بدون خطا", upd.status === 200, `HTTP ${upd.status}`);
  }

  // ── ۱۱) PWA: فایل‌های نصب از مبدأ UI سرو می‌شوند و سرویس‌ورکر ثبت می‌شود
  const manifestRes = await fetch(`${UI}/manifest.webmanifest`);
  let manifestOk = manifestRes.status === 200;
  if (manifestOk) {
    const manifest = await manifestRes.json().catch(() => null);
    manifestOk = !!manifest && String(manifest.name || "").includes("روشن");
  }
  check("PWA: manifest.webmanifest از مبدأ UI سرو می‌شود", manifestOk, `HTTP ${manifestRes.status}`);
  const swRes = await fetch(`${UI}/sw.js`);
  const swText = swRes.status === 200 ? await swRes.text() : "";
  check("PWA: sw.js از مبدأ UI سرو می‌شود", swRes.status === 200 && swText.includes("install"), `HTTP ${swRes.status}`);
  const swScope = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => (r ? r.scope : ""))).catch(() => "");
  check("PWA: سرویس‌ورکر روی صفحه ثبت شده است", !!swScope, swScope ? `scope: ${swScope}` : "بدون ثبت");
} catch (e) {
  check("اجرای کامل سناریو (خطای غیرمنتظره: " + e.message.split("\n").slice(0, 4).join(" | ").slice(0, 160) + ")", false);
} finally {
  await page.screenshot({ path: "e2e/last-run.png" }).catch(() => {});
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n═══ ${results.length - failed.length}/${results.length} سبز ═══`);
if (failed.length) {
  console.log("شکست‌ها:\n" + failed.map((r) => `  ✗ ${r.name}`).join("\n"));
}
process.exit(failed.length ? 1 : 0);
