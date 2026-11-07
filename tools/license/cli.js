#!/usr/bin/env node
/**
 * Dar POS — vendor license CLI.
 *
 * Offline licensing workflow (no internet needed at the shop):
 *
 *   1. keygen      once, on the vendor machine → keys/private.pem + keys/public.pem
 *   2. machinekey  the shopkeeper runs the app once and reads their machine
 *                  key from the license screen (or `node cli.js machinekey`
 *                  on their machine) and sends it to the vendor
 *   3. issue       the vendor signs a license bound to that machine key
 *   4. show        verify what a license contains before sending it
 *
 * The shopkeeper pastes the license block into the app's license screen.
 * The PRIVATE key never leaves the vendor machine — back it up (see README).
 */
const { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

const LICENSE_BEGIN = "-----DARPOS LICENSE-----";
const LICENSE_END = "-----END DARPOS LICENSE-----";
const KEYS_DIR = join(__dirname, "keys");

const usage = `استفاده:
  node cli.js keygen [--dir keys]                    ساخت جفت‌کلید (یک بار)
  node cli.js machinekey                              کلید همین دستگاه
  node cli.js issue --customer "نام" --plan MONTHLY|YEARLY|CUSTOM|LIFETIME
                     --machine-key MK-XXXX-XXXX-XXXX-XXXX
                     [--days N | --expires YYYY-MM-DD] [--note "یادداشت"]
                     [--key keys/private.pem] [--out file.txt]
  node cli.js show --license "بلوک لایسنس" | --file license.txt [--key keys/public.pem]
  node cli.js verify --file license.txt --machine-key MK-...   بررسی کامل برای یک دستگاه`;

function fail(message) {
  console.error("خطا: " + message);
  process.exit(1);
}

function cmdKeygen(args) {
  const dir = resolve(args.dir || KEYS_DIR);
  const priv = join(dir, "private.pem");
  const pub = join(dir, "public.pem");
  // A healthy existing key needs an explicit --force to replace; a file that
  // exists but cannot be decoded (empty / truncated / wrong content) is
  // replaced freely — it never signed a usable license.
  let broken = false;
  if (existsSync(priv)) {
    try {
      createPrivateKey(readFileSync(priv, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      broken = true;
    }
    if (!broken && !args.force) fail(`کلید از قبل موجود است: ${priv}\nاگر واقعاً می‌خواهید کلید تازه بسازید --force بدهید (همهٔ لایسنس‌های قبلی نامعتبر می‌شوند!).`);
    if (broken) console.log(`توجه: فایل کلید خصوصی موجود اما خراب/ناخواناست — نادیده گرفته می‌شود و جفت‌کلید تازه ساخته می‌شود: ${priv}`);
  }
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`کلید خصوصی: ${priv}\nکلید عمومی:  ${pub}\n\n⚠ کلید خصوصی را همان‌جا نگه دارید و از آن بکاپ امن تهیه کنید؛ بدون آن نمی‌توانید لایسنس جدید صادر کنید.`);
}

function machineFacts() {
  const ifaces = Object.values(os.networkInterfaces()).flat();
  const mac = (ifaces.find((i) => i && !i.internal && i.mac !== "00:00:00:00:00:00") || {}).mac || "";
  let machineId = "";
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    if (existsSync(p)) machineId = machineId || readFileSync(p, "utf8").trim();
  }
  if (!machineId && os.platform() === "win32") {
    try {
      machineId = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" })
        .split("\n").map((l) => l.trim()).find((l) => l.startsWith("MachineGuid"))?.split(/\s+/).pop() || "";
    } catch { /* optional */ }
  }
  if (!machineId && os.platform() === "darwin") {
    try {
      machineId = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" })
        .split("\n").map((l) => l.trim()).find((l) => l.startsWith('"IOPlatformUUID"'))?.split("=").pop()?.replace(/"/g, "").trim() || "";
    } catch { /* optional */ }
  }
  return { hostname: os.hostname(), platform: os.platform(), arch: os.arch(), cpuModel: (os.cpus()[0] || {}).model || "", mac, machineId };
}

function machineKeyOf() {
  const crypto = require("node:crypto");
  const f = machineFacts();
  const digest = crypto.createHash("sha256").update([f.hostname, f.platform, f.arch, f.cpuModel, f.mac, f.machineId].join("\u0000")).digest("hex").toUpperCase();
  return `MK-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`;
}

function cmdMachineKey() {
  console.log(machineKeyOf());
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
      else { args[a.slice(2)] = next; i += 1; }
    } else args._ = (args._ || []).concat(a);
  }
  return args;
}

function cmdIssue(args) {
  const customer = args.customer;
  const plan = (args.plan || "").toUpperCase();
  const machineKeyArg = args["machine-key"];
  if (!customer) fail("--customer لازم است (نام دکان/مشتری).");
  if (!["TRIAL", "MONTHLY", "YEARLY", "CUSTOM", "LIFETIME"].includes(plan)) fail("--plan باید یکی از MONTHLY، YEARLY، CUSTOM یا LIFETIME باشد.");
  if (!/^MK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(machineKeyArg || "")) fail("--machine-key باید به شکل MK-XXXX-XXXX-XXXX-XXXX باشد (از صفحهٔ لایسنس برنامه بگیرید).");
  let expiresAt = null;
  if (plan === "LIFETIME") {
    expiresAt = null;
  } else if (args.expires) {
    const d = new Date(`${args.expires}T23:59:59`);
    if (Number.isNaN(d.getTime())) fail("--expires باید تاریخ YYYY-MM-DD باشد.");
    expiresAt = d.toISOString();
  } else {
    const days = Number(args.days || (plan === "MONTHLY" ? 30 : plan === "YEARLY" ? 365 : 0));
    if (!Number.isInteger(days) || days < 1 || days > 3650) fail("برای این پلن --days (یا --expires) لازم است.");
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  }
  const keyPath = resolve(args.key || join(KEYS_DIR, "private.pem"));
  if (!existsSync(keyPath)) fail(`کلید خصوصی پیدا نشد: ${keyPath} — ابتدا keygen کنید.`);
  let signingKey;
  try {
    // A readable-but-invalid file (empty / truncated / wrong content) throws
    // a raw OpenSSL "DECODER routines::unsupported" — translate it.
    signingKey = createPrivateKey(readFileSync(keyPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    fail(`فایل کلید خصوصی موجود است اما محتوایش معتبر نیست و نمی‌توان با آن امضا کرد: ${keyPath}\nفایل خالی، ناقص یا خراب است — دوباره keygen کنید (کلید خراب بدون --force هم جایگزین می‌شود).`);
  }
  const payload = {
    v: 1,
    licenseId: randomUUID(),
    customer: String(customer),
    plan,
    issuedAt: new Date().toISOString(),
    expiresAt,
    machineKey: machineKeyArg,
    features: ["*"],
    ...(args.note ? { note: String(args.note) } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(body, "utf8"), signingKey);
  const license = `${LICENSE_BEGIN}\n${body}.${signature.toString("base64url")}\n${LICENSE_END}\n`;
  if (args.out) { writeFileSync(resolve(args.out), license); console.log(`لایسنس در ${resolve(args.out)} ذخیره شد.`); }
  process.stdout.write(license);
  console.log(`\nشناسه: ${payload.licenseId}\nمشتری: ${payload.customer}\nپلن: ${plan}\nاعتبار تا: ${expiresAt || "ابدی (lifetime)"}`);
}

function readLicenseText(args) {
  if (args.file) return readFileSync(resolve(args.file), "utf8");
  if (typeof args.license === "string" && args.license.length > 30) return args.license;
  fail("لایسنس را با --file یا --license بدهید.");
}

function verifyLicenseText(text, publicKeyPem) {
  const match = text.match(/-----DARPOS LICENSE-----\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*-----END DARPOS LICENSE-----/);
  if (!match) throw new Error("بلوک لایسنس پیدا نشد.");
  const [body, signature] = match[1].split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  const ok = verify(null, Buffer.from(body, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  if (!ok) throw new Error("امضای لایسنس معتبر نیست!");
  return payload;
}

function cmdShow(args) {
  const keyPath = resolve(args.key || join(KEYS_DIR, "public.pem"));
  if (!existsSync(keyPath)) fail(`کلید عمومی پیدا نشد: ${keyPath}`);
  const payload = verifyLicenseText(readLicenseText(args), readFileSync(keyPath, "utf8"));
  console.log(JSON.stringify(payload, null, 2));
}

function cmdVerify(args) {
  const keyPath = resolve(args.key || join(KEYS_DIR, "public.pem"));
  const payload = verifyLicenseText(readLicenseText(args), readFileSync(keyPath, "utf8"));
  const expectedMachine = args["machine-key"];
  const now = new Date();
  const expired = payload.expiresAt != null && now > new Date(payload.expiresAt);
  const mismatch = expectedMachine && payload.machineKey !== expectedMachine;
  console.log(`امضا: معتبر\nشناسه: ${payload.licenseId}\nمشتری: ${payload.customer}\nپلن: ${payload.plan}\nصادر شده: ${payload.issuedAt}\nاعتبار تا: ${payload.expiresAt || "ابدی"}\nدستگاه: ${payload.machineKey}${expectedMachine ? ` (انتظار: ${expectedMachine})` : ""}`);
  if (expired) { console.log("وضعیت: ⚠ منقضی شده است"); process.exit(2); }
  if (mismatch) { console.log("وضعیت: ⚠ برای دستگاه دیگری است"); process.exit(3); }
  console.log("وضعیت: ✅ معتبر و فعال");
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
switch (command) {
  case "keygen": cmdKeygen(args); break;
  case "machinekey": cmdMachineKey(); break;
  case "issue": cmdIssue(args); break;
  case "show": cmdShow(args); break;
  case "verify": cmdVerify(args); break;
  default: console.log(usage); process.exit(command ? 1 : 0);
}
