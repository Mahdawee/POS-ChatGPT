#!/usr/bin/env node
/**
 * Dar POS — license manager PANEL (visual replacement for cli.js).
 *
 * A tiny zero-dependency local web app (node:http only) that runs on the
 * VENDOR's machine and gives the whole offline licensing workflow a UI:
 *
 *   keygen → issue (sign for one machine key) → ledger → verify
 *
 * Security model:
 *   - Binds to 127.0.0.1 ONLY: the private key never leaves the machine and
 *     nothing on the LAN can reach the panel.
 *   - POST endpoints require a custom `x-panel` header, which cross-site
 *     forms/fetches cannot send without a CORS preflight we never answer —
 *     so a malicious website in the vendor's browser cannot issue licenses.
 *   - The private key is used for signing server-side and is never sent to
 *     the browser.
 *
 * Run:  node tools/license/panel.js        (or double-click panel-run.bat)
 * Env:  LM_PORT (default 4390) · LM_KEYS_DIR · LM_LEDGER_PATH · LM_NO_OPEN=1
 */
"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign: edSign,
  verify: edVerify,
} = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const LICENSE_BEGIN = "-----DARPOS LICENSE-----";
const LICENSE_END = "-----END DARPOS LICENSE-----";
const PLANS = ["MONTHLY", "YEARLY", "CUSTOM", "LIFETIME"];
const MACHINE_KEY_RE = /^MK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

const ROOT = __dirname;
const KEYS_DIR = process.env.LM_KEYS_DIR ? resolve(process.env.LM_KEYS_DIR) : join(ROOT, "keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "private.pem");
const PUBLIC_KEY_PATH = join(KEYS_DIR, "public.pem");
const LEDGER_PATH = process.env.LM_LEDGER_PATH ? resolve(process.env.LM_LEDGER_PATH) : join(ROOT, "ledger.json");
// The public key embedded into the shipped app — read from the server source
// so the panel can warn when the pair here no longer matches the build.
const EMBEDDED_KEY_TS = join(ROOT, "..", "..", "server", "src", "license", "license-public-key.ts");

const fail = (res, status, message) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
};
const send = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

// ── keys ───────────────────────────────────────────────────────────────────

function readPublicKey() {
  return existsSync(PUBLIC_KEY_PATH) ? readFileSync(PUBLIC_KEY_PATH, "utf8") : null;
}

/** Reads AND validates the signing key. Returns:
 *    { missing: true }        — no private.pem at all
 *    { ok: true, pem }        — decodable and usable for signing
 *    { broken: true }         — the file exists but OpenSSL cannot decode it
 *  (empty file, a truncated copy, a public key pasted by mistake, …).
 *  The one recoverable case — a BOM saved by Notepad — is tolerated by
 *  stripping it before parsing, so signing keeps working. */
function readPrivateKey() {
  if (!existsSync(PRIVATE_KEY_PATH)) return { missing: true };
  const raw = readFileSync(PRIVATE_KEY_PATH, "utf8");
  const stripped = raw.replace(/^\uFEFF/, "");
  for (const pem of [raw, stripped]) {
    try {
      createPrivateKey(pem);
      return { ok: true, pem };
    } catch { /* try the next candidate */ }
  }
  return { broken: true };
}

function embeddedPublicKey() {
  try {
    const src = readFileSync(EMBEDDED_KEY_TS, "utf8");
    const match = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function keygen(force) {
  const existing = readPrivateKey();
  if (existing.ok && !force) {
    throw new Error("کلید خصوصی از قبل موجود و سالم است. برای ساخت مجدد باید گزینهٔ «مطمئنم» را بزنید — همهٔ لایسنس‌های قبلی نامعتبر می‌شوند!");
  }
  // A missing OR broken key may be replaced freely: it never signed a usable
  // license, so overwriting it loses nothing (no «مطمئنم» needed).
  mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(PUBLIC_KEY_PATH, publicKey.export({ type: "spki", format: "pem" }));
  return { publicKey: readPublicKey(), replacedBroken: existing.broken === true };
}

// ── ledger ─────────────────────────────────────────────────────────────────

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return Array.isArray(parsed.licenses) ? parsed : { version: 1, licenses: [] };
  } catch {
    return { version: 1, licenses: [] };
  }
}

function writeLedger(ledger) {
  mkdirSync(resolve(LEDGER_PATH, ".."), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf-8" });
}

function entryStatus(entry, now = Date.now()) {
  if (entry.revoked) return "REVOKED";
  if (!entry.expiresAt) return "LIFETIME";
  return now > new Date(entry.expiresAt).getTime() ? "EXPIRED" : "ACTIVE";
}

function publicEntry(entry) {
  const daysLeft = entry.expiresAt ? Math.ceil((new Date(entry.expiresAt).getTime() - Date.now()) / 86400000) : null;
  return { ...entry, status: entryStatus(entry), daysLeft };
}

// ── issue / verify ─────────────────────────────────────────────────────────

function signLicense(payload, privateKeyPem) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = edSign(null, Buffer.from(body, "utf8"), createPrivateKey(privateKeyPem));
  return `${LICENSE_BEGIN}\n${body}.${signature.toString("base64url")}\n${LICENSE_END}\n`;
}

function parseLicense(text, publicKeyPem) {
  const match = String(text).match(/-----DARPOS LICENSE-----\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*-----END DARPOS LICENSE-----/);
  if (!match) throw new Error("بلوک لایسنس پیدا نشد. کل متن بین دو خط «DARPOS LICENSE» را کپی کنید.");
  const [body, signature] = match[1].split(".");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("محتوای لایسنس قابل خواندن نیست.");
  }
  const ok = edVerify(null, Buffer.from(body, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  if (!ok) throw new Error("امضای لایسنس معتبر نیست — متن تغییر کرده است.");
  return payload;
}

function computeExpiry(plan, days, expiresAt) {
  if (plan === "LIFETIME") return null;
  if (expiresAt) {
    const d = new Date(`${expiresAt}T23:59:59`);
    if (Number.isNaN(d.getTime())) throw new Error("تاریخ انقضا نامعتبر است.");
    return d.toISOString();
  }
  // Same plan defaults as cli.js: MONTHLY → 30 days, YEARLY → 365.
  const fallback = plan === "MONTHLY" ? 30 : plan === "YEARLY" ? 365 : undefined;
  const n = Number(days ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error("تعداد روز باید عددی بین ۱ و ۳۶۵۰ باشد.");
  return new Date(Date.now() + n * 86400000).toISOString();
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(new Error("درخواست خیلی بزرگ است."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("بدنهٔ درخواست معتبر نیست."));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  // Only the panel origin may talk to us (blocks DNS-rebinding). The explicit
  // opt-in exists solely for sandboxed demos where a platform proxy fronts
  // the panel under its own hostname; on a real vendor machine it stays off.
  const host = String(req.headers.host || "");
  const localHost = host.startsWith("127.0.0.1") || host.startsWith("localhost");
  if (!localHost && process.env.LM_ALLOW_REMOTE_PREVIEW !== "1") {
    return fail(res, 403, "پنل فقط روی همین دستگاه (127.0.0.1) در دسترس است.");
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = readFileSync(join(ROOT, "panel.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "POST") {
    // CSRF protection: custom header cannot be sent cross-site without a
    // preflight, and we never answer preflights.
    if (req.headers["x-panel"] !== "1") return fail(res, 403, "درخواست نامعتبر.");
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const pub = readPublicKey();
    const embedded = embeddedPublicKey();
    const same = pub && embedded
      ? pub.replace(/\s+/g, "") === embedded.replace(/\s+/g, "")
      : null;
    const priv = readPrivateKey();
    return send(res, {
      ok: true,
      keysDir: KEYS_DIR,
      hasPrivate: !priv.missing,
      privateKeyOk: priv.ok === true,
      publicKey: pub,
      embeddedMatch: same,
      embeddedKey: embedded,
      ledgerPath: LEDGER_PATH,
      ledgerCount: readLedger().licenses.length,
      cliHint: "node tools/license/cli.js",
    });
  }

  if (url.pathname === "/api/keygen" && req.method === "POST") {
    try {
      const { publicKey, replacedBroken } = keygen(Boolean((await readBody(req)).force));
      return send(res, { ok: true, publicKey, replacedBroken });
    } catch (error) {
      return fail(res, 409, error.message);
    }
  }

  if (url.pathname === "/api/issue" && req.method === "POST") {
    const body = await readBody(req);
    const customer = String(body.customer || "").trim();
    const plan = String(body.plan || "").toUpperCase();
    const machineKey = String(body.machineKey || "").trim().toUpperCase();
    if (!customer) return fail(res, 400, "نام دکان/مشتری لازم است.");
    if (!PLANS.includes(plan)) return fail(res, 400, "پلن را انتخاب کنید.");
    if (!MACHINE_KEY_RE.test(machineKey)) return fail(res, 400, "کلید دستگاه باید به شکل MK-XXXX-XXXX-XXXX-XXXX باشد (از صفحهٔ لایسنس برنامهٔ مشتری بگیرید).");
    let expiresAt;
    try {
      expiresAt = computeExpiry(plan, body.days, body.expiresAt ? String(body.expiresAt).slice(0, 10) : null);
    } catch (error) {
      return fail(res, 400, error.message);
    }
    // The key file may be missing — or exist yet be unreadable (empty /
    // truncated / wrong content). Catch both HERE with a clear message
    // instead of letting OpenSSL surface something like
    // "error:1E08010C:DECODER routines::unsupported".
    const priv = readPrivateKey();
    if (priv.missing) {
      return fail(res, 409, `کلید خصوصی پیدا نشد: ${PRIVATE_KEY_PATH} — اول از سربرگ «کلیدها» جفت‌کلید بسازید.`);
    }
    if (priv.broken) {
      return fail(res, 409, `فایل کلید خصوصی موجود است اما محتوایش معتبر نیست و نمی‌توان با آن لایسنس امضا کرد: ${PRIVATE_KEY_PATH} (فایل خالی، ناقص یا خراب). از سربرگ «کلیدها و راهنما» جفت‌کلید تازه بسازید — چون کلید فعلی عملاً قابل استفاده نیست، چیزی از دست نمی‌دهید. بعد از ساخت، کلید عمومی تازه را با دکمهٔ «همگام‌سازی کلید عمومی با سورس برنامه» جایگزین کنید و برنامه را دوباره بسازید.`);
    }
    const payload = {
      v: 1,
      licenseId: randomUUID(),
      customer,
      plan,
      issuedAt: new Date().toISOString(),
      expiresAt,
      machineKey,
      features: ["*"],
      ...(body.note ? { note: String(body.note) } : {}),
    };
    let license;
    try {
      license = signLicense(payload, priv.pem);
    } catch (error) {
      return fail(res, 409, `امضای لایسنس با کلید خصوصی ممکن نشد (${error.message}). از سربرگ «کلیدها و راهنما» جفت‌کلید را دوباره بسازید.`);
    }

    const ledger = readLedger();
    ledger.licenses.push({
      licenseId: payload.licenseId,
      customer,
      machineKey,
      plan,
      issuedAt: payload.issuedAt,
      expiresAt,
      note: body.note ? String(body.note) : "",
      features: payload.features,
      revoked: false,
      revokedAt: null,
      licenseText: license,
    });
    writeLedger(ledger);
    // Friendly hint: renewing a device that already has an active license.
    const existingActiveForMachine = ledger.licenses.filter(
      (e) => e.machineKey === machineKey && entryStatus(e) === "ACTIVE",
    ).length;
    return send(res, { ok: true, license, payload, existingActiveForMachine });
  }

  if (url.pathname === "/api/ledger" && req.method === "GET") {
    const ledger = readLedger();
    return send(res, { ok: true, licenses: ledger.licenses.map(publicEntry) });
  }

  if (url.pathname === "/api/revoke" && req.method === "POST") {
    const { licenseId, revoked } = await readBody(req);
    const ledger = readLedger();
    const entry = ledger.licenses.find((e) => e.licenseId === licenseId);
    if (!entry) return fail(res, 404, "این لایسنس در دفتر پیدا نشد.");
    entry.revoked = Boolean(revoked);
    entry.revokedAt = entry.revoked ? new Date().toISOString() : null;
    writeLedger(ledger);
    return send(res, { ok: true });
  }

  if (url.pathname === "/api/delete" && req.method === "POST") {
    const { licenseId } = await readBody(req);
    const ledger = readLedger();
    const before = ledger.licenses.length;
    ledger.licenses = ledger.licenses.filter((e) => e.licenseId !== licenseId);
    if (ledger.licenses.length === before) return fail(res, 404, "این لایسنس در دفتر پیدا نشد.");
    writeLedger(ledger);
    return send(res, { ok: true });
  }

  if (url.pathname === "/api/embed-sync" && req.method === "POST") {
    // Re-write the public key embedded in the shipped app source so a fresh
    // keypair becomes effective on the next `tauri:build`. Vendor-side
    // convenience; the panel runs next to the repo on the vendor machine.
    const pub = readPublicKey();
    if (!pub) return fail(res, 409, "کلید عمومی پیدا نشد — اول جفت‌کلید بسازید.");
    if (!existsSync(EMBEDDED_KEY_TS)) return fail(res, 404, `فایل سورس برنامه پیدا نشد: ${EMBEDDED_KEY_TS}`);
    const src = readFileSync(EMBEDDED_KEY_TS, "utf8");
    if (!/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.test(src)) {
      return fail(res, 422, "ساختار فایل license-public-key.ts شناسایی نشد — دستی جایگزین کنید.");
    }
    const updated = src.replace(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/, pub.trim());
    if (updated === src) return send(res, { ok: true, changed: false, message: "کلید از قبل هماهنگ است." });
    try {
      writeFileSync(`${EMBEDDED_KEY_TS}.bak`, src, { encoding: "utf-8" });
    } catch {
      // Backup is best-effort.
    }
    writeFileSync(EMBEDDED_KEY_TS, updated, { encoding: "utf-8" });
    return send(res, { ok: true, changed: true, message: "کلید عمومی تازه در سورس برنامه جایگزین شد (نسخهٔ قبلی در فایل .bak). حالا برنامه را دوباره بسازید: npm run tauri:build" });
  }

  if (url.pathname === "/api/verify" && req.method === "POST") {
    const body = await readBody(req);
    const publicKey = readPublicKey();
    if (!publicKey) return fail(res, 409, "کلید عمومی پیدا نشد — اول از سربرگ «کلیدها» جفت‌کلید بسازید.");
    let payload;
    try {
      payload = parseLicense(String(body.licenseText || ""), publicKey);
    } catch (error) {
      return send(res, { ok: true, valid: false, error: error.message });
    }
    const expected = String(body.machineKey || "").trim().toUpperCase();
    const now = Date.now();
    const expired = payload.expiresAt != null && now > new Date(payload.expiresAt).getTime();
    const entry = readLedger().licenses.find((e) => e.licenseId === payload.licenseId) || null;
    return send(res, {
      ok: true,
      valid: true,
      payload,
      expired,
      machineMatch: expected ? payload.machineKey === expected : null,
      ledger: entry ? { found: true, revoked: Boolean(entry.revoked) } : { found: false },
    });
  }

  fail(res, 404, "مسیر پیدا نشد.");
}

function openBrowser(url) {
  if (process.env.LM_NO_OPEN) return;
  const cmds = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmds[0], cmds[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is a convenience only.
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => fail(res, 500, error.message || "خطای داخلی پنل."));
});

const basePort = Number(process.env.LM_PORT) || 4390;
let attempt = 0;
const listen = (port) => {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < 20) {
      attempt += 1;
      listen(port + 1);
    } else {
      console.error("پنل راه‌اندازی نشد:", error.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`پنل مدیریت لایسنس Dar POS: ${url}`);
    console.log(`پوشهٔ کلیدها: ${KEYS_DIR}`);
    console.log("برای بستن، این پنجره را ببندید یا Ctrl+C بزنید.");
    openBrowser(url);
  });
};
listen(basePort);
