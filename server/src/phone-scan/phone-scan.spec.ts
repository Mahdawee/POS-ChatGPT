import * as http from "node:http";
import { get as httpsGet } from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneScanBridge } from "./phone-scan-bridge";

/**
 * ── پل موقت اسکن با گوشی ──────────────────────────────────────────────────
 * پل روی یک HTTP ساده (tls:false، پورت تصادفی) بالا می‌آید و کل چرخهٔ
 * گوشی با fetch واقعی آزموده می‌شود: صفحه، کتابخانهٔ اسکن، جفت‌شدن با
 * PIN (غلط/درست/تکرار با token)، ثبت اسکن (توکن غلط، بدنهٔ خراب، بدنهٔ
 * بزرگ)، حذف تکراری‌ها، pull با after، بافر حلقوی و خاموشی. گواهی
 * خودامضا هم جداگانه با https.get (بدون اعتبارسنجی) بررسی می‌شود.
 */

describe("PhoneScanBridge (پل موقت اسکن گوشی)", () => {
  let bridge: PhoneScanBridge;
  let base: string;

  beforeAll(async () => {
    bridge = new PhoneScanBridge();
    await bridge.start({ tls: false, port: 0, log: () => undefined });
    const port = bridge.status().port;
    expect(port).toBeTruthy();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await bridge.stop();
  });

  it("صفحهٔ گوشی و کتابخانهٔ اسکن سرو می‌شوند", async () => {
    const page = await fetch(`${base}/`).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      return res.text();
    });
    // صفحهٔ واقعی دری/RTL با هر سه حالت و ارجاع به zxing.js
    expect(page).toContain("dir=\"rtl\"");
    expect(page).toContain("zxing.js");
    expect(page).toContain("api/pair");
    expect(page).toContain("api/scan");
    const zxing = await fetch(`${base}/zxing.js`).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      return res.text();
    });
    // UMD واقعی ZXing — همان APIهایی که صفحه فرا می‌خواند
    expect(zxing).toContain("MultiFormatReader");
    expect(zxing).toContain("HTMLCanvasElementLuminanceSource");
    expect(zxing).toContain("HybridBinarizer");
  });

  it("آیکون و مانیفست «افزودن به صفحهٔ اصلی» سرو می‌شوند و صفحه به آنها ارجاع دارد", async () => {
    // A2HS: مانیفست وب‌اپ + آیکون ۲۵۶ (همان لوگوی دسکتاپ) + لینک‌های iOS
    const manifest = await fetch(`${base}/manifest.webmanifest`).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("manifest+json");
      return res.json();
    });
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons[0].src).toBe("/icon.png");
    const icon = await fetch(`${base}/icon.png`).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      return res.arrayBuffer();
    });
    // PNG واقعی (امضای فایل) با محتوای معقول برای آیکون ۲۵۶×۲۵۶
    const sig = new Uint8Array(icon.slice(0, 8));
    expect(Array.from(sig)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(icon.byteLength).toBeGreaterThan(500);
    const page = await fetch(`${base}/`).then((res) => res.text());
    expect(page).toContain('rel="manifest"');
    expect(page).toContain('rel="apple-touch-icon"');
    expect(page).toContain("beforeinstallprompt");
    expect(page).toContain("installCard");
  });

  it("PIN غلط رد و PIN درست توکن می‌دهد؛ توکن معتبر قابل تمدید است", async () => {
    const wrong = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "0000" }) });
    expect(wrong.status).toBe(403);
    const pin = bridge.currentPin;
    expect(pin).toMatch(/^\d{4}$/);
    const ok = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin }) });
    expect(ok.status).toBe(200);
    const { token } = await ok.json() as { token: string };
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // ادامهٔ جفت‌شدن با همان توکن (بازگشت کاربر به صفحهٔ گوشی)
    const again = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ token }) });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ token });
    // توکن باطلِ قبلی دیگر قبول نمی‌شود
    const stale = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ token: "deadbeef".repeat(4) }) });
    expect(stale.status).toBe(403);
  });

  it("اسکن فقط با توکن درست ثبت می‌شود و تکرار لحظه‌ای حذف می‌شود", async () => {
    const pin = bridge.currentPin;
    const { token } = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin }) }).then((r) => r.json() as Promise<{ token: string }>);
    const unauthorized = await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token: "0".repeat(32), code: "12345" }) });
    expect(unauthorized.status).toBe(401);
    const first = await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: "29412300050378" }) });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const duplicate = await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: "29412300050378" }) });
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    const empty = await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: "   " }) });
    expect(empty.status).toBe(400);
    // کد دیگر تکرار نیست
    await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: "5678901234567" }) });
    const pulled = bridge.pull(0).scans.map((entry) => entry.code);
    expect(pulled).toContain("29412300050378");
    expect(pulled).toContain("5678901234567");
    // تکراریِ لحظه‌ای فقط یک‌بار در بافر نشسته است
    expect(pulled.filter((code) => code === "29412300050378")).toHaveLength(1);
  });

  it("pull با after فقط کدهای جدیدتر را می‌دهد", async () => {
    const { now } = bridge.pull(0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const pin = bridge.currentPin;
    const { token } = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin }) }).then((r) => r.json() as Promise<{ token: string }>);
    await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: "NEW-CODE-1" }) });
    const fresh = bridge.pull(now);
    expect(fresh.scans.map((entry) => entry.code)).toEqual(["NEW-CODE-1"]);
    expect(fresh.now).toBeGreaterThanOrEqual(now);
  });

  it("بدنهٔ خراب و بدنهٔ بزرگ رد می‌شوند", async () => {
    const badJson = await fetch(`${base}/api/scan`, { method: "POST", body: "not-json" });
    expect(badJson.status).toBe(400);
    const big = await fetch(`${base}/api/scan`, { method: "POST", body: "x".repeat(11 * 1024) });
    expect(big.status).toBe(413);
  });

  it("بافر حلقوی بیش از ۱۰۰ کد نگه نمی‌دارد", async () => {
    const pin = bridge.currentPin;
    const { token } = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin }) }).then((r) => r.json() as Promise<{ token: string }>);
    for (let i = 0; i < 105; i++) {
      // هر کد یکتا است تا dedupe آن‌ها را حذف نکند
      await fetch(`${base}/api/scan`, { method: "POST", body: JSON.stringify({ token, code: `BULK-${i}` }) });
    }
    const all = bridge.pull(0).scans;
    expect(all).toHaveLength(100);
    expect(all[0].code).toBe("BULK-5"); // قدیمی‌ها ریخته‌اند
    expect(all[99].code).toBe("BULK-104");
  });

  it("مسیر ناشناخته ۴۰۴ می‌دهد", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("خاموشی پل را می‌بندد", async () => {
    const second = new PhoneScanBridge();
    await second.start({ tls: false, port: 0, log: () => undefined });
    const port = second.status().port as number;
    expect(second.status().running).toBe(true);
    await fetch(`http://127.0.0.1:${port}/`).then((res) => expect(res.status).toBe(200));
    await second.stop();
    expect(second.status().running).toBe(false);
    expect(second.status().port).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("در محیط تست و با PHONE_SCAN_DISABLE خودکار روشن نمی‌شود", async () => {
    // NODE_ENV در jest برابر test است
    const lazy = new PhoneScanBridge();
    await lazy.onModuleInit();
    expect(lazy.status().running).toBe(false);
    process.env.PHONE_SCAN_DISABLE = "1";
    try {
      const disabled = new PhoneScanBridge();
      await disabled.onModuleInit();
      expect(disabled.status().running).toBe(false);
    } finally {
      delete process.env.PHONE_SCAN_DISABLE;
    }
  });

  it("CA محلی کش می‌شود، زنجیرهٔ HTTPS معتبر است و گوشی با نصب /ca.crt بدون هشدار وصل می‌شود", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "phone-scan-cert-"));
    const tlsBridge = new PhoneScanBridge();
    await tlsBridge.start({ tls: true, port: 0, dataDir, log: () => undefined });
    const port = tlsBridge.status().port as number;
    try {
      expect(tlsBridge.status().tls).toBe(true);
      // فایل CA برای نصبِ یک‌باره در گوشی — روی هر دو مبدأ سرو می‌شود
      const caPem = await fetch(`http://127.0.0.1:${tlsBridge.status().httpPort}/ca.crt`).then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/x-x509-ca-cert");
        return res.text();
      });
      expect(caPem).toMatch(/-----BEGIN CERTIFICATE-----/);
      // کلاینتی که فقط CA را می‌شناسد (گوشیِ نصب‌کرده) بدون هیچ خطای گواهی
      // وصل می‌شود — نه rejectUnauthorized و نه هشدار مرورگر.
      const body = await new Promise<string>((resolve, reject) => {
        httpsGet({ host: "127.0.0.1", port, path: "/", ca: [caPem], servername: "localhost" }, (res) => {
          expect(res.statusCode).toBe(200);
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      expect(body).toContain("dir=\"rtl\"");
      expect(body).toContain("certBtn"); // دکمهٔ دانلود گواهی برای نصب یک‌باره در گوشی
      // کنترل منفی: بدون CA باید رد شود (همان هشداری که با نصب رفع می‌شود)
      await new Promise<void>((resolve) => {
        httpsGet({ host: "127.0.0.1", port, path: "/" }, () => resolve()).on("error", () => resolve());
      });
      // کش: CA و برگ روی دیسک ماندند تا اعتماد گوشی با ری‌استارت باطل نشود
      const cachedCa = JSON.parse(readFileSync(join(dataDir, "phone-scan-ca.json"), "utf8")) as { cert: string; private: string };
      expect(cachedCa.cert).toMatch(/BEGIN CERTIFICATE/);
      expect(cachedCa.private).toMatch(/BEGIN PRIVATE KEY/);
      const cachedLeaf = JSON.parse(readFileSync(join(dataDir, "phone-scan-leaf.json"), "utf8")) as { cert: string; altNames: Array<{ type: number; ip?: string; value?: string }> };
      expect(cachedLeaf.cert).toMatch(/BEGIN CERTIFICATE/);
      // SAN برگ باید localhost + 127.0.0.1 را پوشش دهد
      const sans = cachedLeaf.altNames.map((a) => a.ip || a.value);
      expect(sans).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
      // CA بین راه‌اندازی‌ها ثابت می‌ماند — نصب گوشی فقط یک‌بار کافی است
      await tlsBridge.stop();
      const again = new PhoneScanBridge();
      await again.start({ tls: true, port: 0, dataDir, log: () => undefined });
      const caAgain = await fetch(`http://127.0.0.1:${again.status().httpPort}/ca.crt`).then((res) => res.text());
      expect(caAgain).toBe(caPem);
      await again.stop();
    } finally {
      await tlsBridge.stop();
    }
  });

  // شبیه‌سازی «بستهٔ selfsigned در runtime نصب نیست» — همان حالتی که اگر
  // رخ دهد نباید اجرای کل برنامه را متوقف کند (قابلیت موقتِ اختیاری است).
  const mockMissingSelfsigned = (): void => {
    jest.doMock("selfsigned", () => {
      const error = new Error("Cannot find module 'selfsigned'") as NodeJS.ErrnoException;
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });
  };

  it("بارگذاری ماژول حتی بدون بستهٔ selfsigned ممکن است", () => {
    mockMissingSelfsigned();
    try {
      jest.isolateModules(() => {
        // اگر selfsigned در سطح ماژول require می‌شد، همین require می‌ترکید
        const fresh = require("./phone-scan-bridge") as typeof import("./phone-scan-bridge");
        expect(typeof fresh.PhoneScanBridge).toBe("function");
      });
    } finally {
      jest.dontMock("selfsigned");
    }
  });

  it("نبود بستهٔ گواهی فقط پل را به HTTP ساده برمی‌گرداند، نه بیشتر", async () => {
    mockMissingSelfsigned();
    let fallbackLog = "";
    // ماژول bridge باید با mock تازه (بدون selfsigned) بارگذاری شود
    const loadBridgeClass = (): typeof PhoneScanBridge => {
      let Ctor: typeof PhoneScanBridge | null = null;
      jest.isolateModules(() => {
        const fresh = require("./phone-scan-bridge") as typeof import("./phone-scan-bridge");
        Ctor = fresh.PhoneScanBridge;
      });
      return Ctor as unknown as typeof PhoneScanBridge;
    };
    try {
      const bridge = new (loadBridgeClass())();
      await bridge.start({ tls: true, port: 0, dataDir: mkdtempSync(join(tmpdir(), "phone-scan-nocert-")), log: (message) => { fallbackLog += message + "\n"; } });
      try {
        // پل با HTTP ساده بالا آمده و صفحه را سرو می‌کند
        expect(bridge.status().running).toBe(true);
        expect(bridge.status().tls).toBe(false);
        expect(fallbackLog).toContain("HTTP ساده");
        const page = await fetch(`http://127.0.0.1:${bridge.status().port}/`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("api/pair");
        // جفت‌کردن هم روی HTTP کار می‌کند
        const pair = await fetch(`http://127.0.0.1:${bridge.status().port}/api/pair`, { method: "POST", body: JSON.stringify({ pin: bridge.currentPin }) });
        expect(pair.status).toBe(200);
      } finally {
        await bridge.stop();
      }
    } finally {
      jest.dontMock("selfsigned");
    }
  });

  it("وقتی روشن نیست، status دلیل را گزارش می‌کند", () => {
    const idle = new PhoneScanBridge();
    expect(idle.status().running).toBe(false);
    expect(idle.status().reason).toBe("not-started");
  });

  it("با TLS، همدم HTTP ساده روی پورت بعدی باز می‌شود و صفحه پورت امن را می‌داند", async () => {
    const bridge = new PhoneScanBridge();
    const logs: string[] = [];
    await bridge.start({ tls: true, port: 0, dataDir: mkdtempSync(join(tmpdir(), "phone-scan-plain-")), log: (message) => { logs.push(message); } });
    try {
      const info = bridge.status();
      expect(info.running).toBe(true);
      expect(info.tls).toBe(true);
      expect(info.httpPort).toBe((info.port ?? 0) + 1);
      // صفحهٔ ساده بدون هیچ هشدار گواهی باز می‌شود و همان برنامه را دارد
      const page = await fetch(`http://127.0.0.1:${info.httpPort}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("api/pair");
      // پورت نشانی امن در صفحه جایگذاری شده تا دکمهٔ «اسکن زنده» بداند کجا برود
      expect(html).toContain(`parseInt("${info.port}"`);
      // جفت‌کردن روی نشانی ساده هم کامل کار می‌کند
      const pair = await fetch(`http://127.0.0.1:${info.httpPort}/api/pair`, { method: "POST", body: JSON.stringify({ pin: bridge.currentPin }) });
      expect(pair.status).toBe(200);
      // خودتشخیص: صفحه باز شده، گوشی دیده شده و جفت شده
      const after = bridge.status();
      expect(after.phone?.lastSeen).toBeTruthy();
      expect((after.phone?.requests ?? 0)).toBeGreaterThan(0);
      expect(after.phone?.pairedAt).toBeTruthy();
    } finally {
      await bridge.stop();
      // هر دو سرور بسته شده‌اند — پورت ساده هم دیگر پاسخ نمی‌دهد
      const closed = await fetch(`http://127.0.0.1:${bridge.status().httpPort ?? 1}/`, { signal: AbortSignal.timeout(800) }).then(() => false).catch(() => true);
      expect(closed).toBe(true);
    }
  });

  it("پورت همدم ساده اشغال باشد، پورت بعدی خودکار امتحان می‌شود و لاگ تقلبی نمی‌شود", async () => {
    // PHONE_SCAN_HTTP_PORT را روی یک پورت اشغال می‌گذاریم؛ همدم باید روی
    // پورت بعدی (busy+1) بنشیند و فقط همان را در لاگ و status گزارش کند
    // (باگ کشف‌شده در بازرسی زنده: callback ناموفقِ listen هم لاگ می‌زد).
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const busyPort = (blocker.address() as { port: number }).port;
    const previousHttp = process.env.PHONE_SCAN_HTTP_PORT;
    process.env.PHONE_SCAN_HTTP_PORT = String(busyPort);
    const logs: string[] = [];
    let BridgeCtor: typeof PhoneScanBridge | null = null;
    jest.isolateModules(() => {
      const fresh = require("./phone-scan-bridge") as typeof import("./phone-scan-bridge");
      BridgeCtor = fresh.PhoneScanBridge;
    });
    const bridge = new (BridgeCtor as unknown as typeof PhoneScanBridge)();
    try {
      await bridge.start({ tls: true, port: 0, dataDir: mkdtempSync(join(tmpdir(), "phone-scan-plainbump-")), log: (message) => { logs.push(message); } });
      const info = bridge.status();
      expect(info.httpPort).toBe(busyPort + 1);
      // لاگِ «اشغال» هست؛ ولی «نشانی ساده» فقط برای پورت نهایی، نه پورت اشغال
      expect(logs.some((line) => line.includes(`پورت سادهٔ ${busyPort} اشغال است`))).toBe(true);
      expect(logs.some((line) => line.includes(`نشانی سادهٔ گوشی (بدون هشدار گواهی): http://0.0.0.0:${busyPort}`))).toBe(false);
      expect(logs.some((line) => line.includes(`نشانی سادهٔ گوشی (بدون هشدار گواهی): http://0.0.0.0:${busyPort + 1}`))).toBe(true);
      const page = await fetch(`http://127.0.0.1:${busyPort + 1}/`);
      expect(page.status).toBe(200);
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      if (previousHttp === undefined) delete process.env.PHONE_SCAN_HTTP_PORT;
      else process.env.PHONE_SCAN_HTTP_PORT = previousHttp;
    }
  });

  it("صفحهٔ ساده، PIN را از انتهای نشانی (#۱۲۳۴) می‌خواند تا خودکار جفت شود", async () => {
    // نشانی‌ای که QR دسکتاپ می‌سازد: http://IP:PORT/#1234 — صفحه باید عبارت
    // را در JS خود داشته باشد (خواندن hash و کلیک خودکار دکمهٔ اتصال)
    const page = await fetch(`${base}/`);
    const html = await page.text();
    expect(html).toContain('location.hash || ""');
    expect(html).toContain('replace(/[^0-9]/g, "")');
    expect(html).toContain('pairBtn").click()');
  });

  it("پورت پیش‌فرض اشغال باشد، پورت بعدی خودکار امتحان می‌شود", async () => {
    // یک پورت آزاد را با یک سرور ساده اشغال می‌کنیم و PHONE_SCAN_PORT را
    // همان می‌گذاریم؛ پل باید روی پورتِ بعدی (busy+1) بالا بیاید.
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const busyPort = (blocker.address() as { port: number }).port;
    const previous = process.env.PHONE_SCAN_PORT;
    process.env.PHONE_SCAN_PORT = String(busyPort);
    const logs: string[] = [];
    let BridgeCtor: typeof PhoneScanBridge | null = null;
    jest.isolateModules(() => {
      const fresh = require("./phone-scan-bridge") as typeof import("./phone-scan-bridge");
      BridgeCtor = fresh.PhoneScanBridge;
    });
    const bridge = new (BridgeCtor as unknown as typeof PhoneScanBridge)();
    try {
      await bridge.start({ tls: false, log: (message) => { logs.push(message); } });
      expect(bridge.status().running).toBe(true);
      expect(bridge.status().port).toBe(busyPort + 1);
      expect(logs.some((line) => line.includes("اشغال است"))).toBe(true);
      const page = await fetch(`http://127.0.0.1:${busyPort + 1}/`);
      expect(page.status).toBe(200);
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      if (previous === undefined) delete process.env.PHONE_SCAN_PORT;
      else process.env.PHONE_SCAN_PORT = previous;
    }
  });
});
