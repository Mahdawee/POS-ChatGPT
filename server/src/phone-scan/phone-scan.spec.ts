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

  it("گواهی خودامضا کش می‌شود و HTTPS هم می‌پذیرد", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "phone-scan-cert-"));
    const tlsBridge = new PhoneScanBridge();
    await tlsBridge.start({ tls: true, port: 0, dataDir, log: () => undefined });
    const port = tlsBridge.status().port as number;
    try {
      expect(tlsBridge.status().tls).toBe(true);
      const body = await new Promise<string>((resolve, reject) => {
        // cert خودامضاست؛ مثل مرورگرِ گوشیِ کاربر که یک‌بار آن را پذیرفته
        httpsGet({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
          expect(res.statusCode).toBe(200);
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      expect(body).toContain("dir=\"rtl\"");
      // کش: دفعهٔ بعد همان گواهی از دیسک برمی‌گردد
      const cached = JSON.parse(readFileSync(join(dataDir, "phone-scan-cert.json"), "utf8")) as { cert: string; private: string };
      expect(cached.cert).toMatch(/BEGIN CERTIFICATE/);
      expect(cached.private).toMatch(/BEGIN PRIVATE KEY/);
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
});
