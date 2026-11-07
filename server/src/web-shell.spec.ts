import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSpaFallbackRequest, serveWebApp, resolveWebRoot } from "./main";

// ─────────────────────────────────────────────────────────────────────────────
// قرارداد پوستهٔ وب (PWA): این تست‌ها تضمین می‌کنند فایل‌های نصب برنامهٔ وب
// (manifest، سرویس‌ورکر، آیکون‌ها) سالم‌اند و سرور فقط مسیرهای غیر-API را
// به پوستهٔ SPA برمی‌گرداند.
// ─────────────────────────────────────────────────────────────────────────────

const publicDir = join(__dirname, "..", "..", "desktop", "public");

/** PNG dimensions live in the IHDR chunk: width/height at byte offsets 16/20. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("SPA fallback routing (serveWebApp)", () => {
  it("sends browser page loads (non-API GETs) to the app shell", () => {
    expect(isSpaFallbackRequest("GET", "/")).toBe(true);
    expect(isSpaFallbackRequest("GET", "/settings")).toBe(true);
    expect(isSpaFallbackRequest("GET", "/manifest.webmanifest")).toBe(true);
  });

  it("never intercepts /api routes or non-GET requests", () => {
    expect(isSpaFallbackRequest("GET", "/api/auth/login")).toBe(false);
    expect(isSpaFallbackRequest("GET", "/api/products/pos")).toBe(false);
    expect(isSpaFallbackRequest("POST", "/products")).toBe(false);
    expect(isSpaFallbackRequest("PUT", "/")).toBe(false);
    expect(isSpaFallbackRequest("HEAD", "/")).toBe(false);
    expect(isSpaFallbackRequest(undefined, "/")).toBe(false);
  });
});

describe("web root resolution (resolveWebRoot)", () => {
  it("honors POS_WEB_DIR when set", () => {
    const previous = process.env.POS_WEB_DIR;
    process.env.POS_WEB_DIR = "/custom/web/dir";
    try {
      expect(resolveWebRoot()).toBe("/custom/web/dir");
    } finally {
      if (previous === undefined) delete process.env.POS_WEB_DIR; else process.env.POS_WEB_DIR = previous;
    }
  });

  it("falls back to server/dist/web when running from src (npm run dev / ts-node-dev)", () => {
    // تست‌ها خودشان از src اجرا می‌شوند؛ پس resolveWebRoot باید (وقتی وبِ
    // کنار src نباشد) به خروجی بیلد یعنی server/dist/web اشاره کند —
    // همان باگی که در حالت dev صفحهٔ «وب نصب نیست» را ابدی می‌کرد.
    const previous = process.env.POS_WEB_DIR;
    delete process.env.POS_WEB_DIR;
    try {
      expect(resolveWebRoot()).toBe(join(__dirname, "..", "dist", "web"));
    } finally {
      if (previous !== undefined) process.env.POS_WEB_DIR = previous;
    }
  });
});

describe("missing web build (serveWebApp without dist/web)", () => {
  type Recorded = { status?: number; type?: string; body?: string; nexted?: boolean };
  const makeRes = (recorded: Recorded) =>
    ({ status: (code: number) => { recorded.status = code; return makeRes(recorded); }, type: (t: string) => { recorded.type = t; return makeRes(recorded); }, send: (b: string) => { recorded.body = b; return makeRes(recorded); } }) as unknown as import("express").Response;
  const makeReq = (method: string, path: string) => ({ method, path }) as import("express").Request;

  it("answers non-API browser loads with a Persian setup page instead of JSON 404", () => {
    const previous = process.env.POS_WEB_DIR;
    process.env.POS_WEB_DIR = mkdtempSync(join(tmpdir(), "pos-empty-web-")); // exists but has no index.html
    const middlewares: Array<(req: import("express").Request, res: import("express").Response, next: () => void) => void> = [];
    try {
      serveWebApp({ use: (m: typeof middlewares[number]) => { middlewares.push(m); } });
      expect(middlewares.length).toBeGreaterThan(0);
      const recorded: Recorded = {};
      middlewares[0](makeReq("GET", "/"), makeRes(recorded), () => { recorded.nexted = true; });
      expect(recorded.status).toBe(503);
      expect(recorded.type).toBe("html");
      expect(recorded.body).toContain("نسخهٔ وب");
      expect(recorded.body).toContain("npm run build");
      expect(recorded.body).toContain(process.env.POS_WEB_DIR!); // مسیر بررسی‌شده در صفحه چاپ می‌شود
      expect(recorded.nexted).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.POS_WEB_DIR; else process.env.POS_WEB_DIR = previous;
    }
  });

  it("keeps API routes untouched (middleware falls through)", () => {
    const previous = process.env.POS_WEB_DIR;
    process.env.POS_WEB_DIR = mkdtempSync(join(tmpdir(), "pos-empty-web-"));
    const middlewares: Array<(req: import("express").Request, res: import("express").Response, next: () => void) => void> = [];
    try {
      serveWebApp({ use: (m: typeof middlewares[number]) => { middlewares.push(m); } });
      const recorded: Recorded = {};
      middlewares[0](makeReq("GET", "/api/products"), makeRes(recorded), () => { recorded.nexted = true; });
      expect(recorded.nexted).toBe(true);
      expect(recorded.status).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.POS_WEB_DIR; else process.env.POS_WEB_DIR = previous;
    }
  });

  it("activates the web build without a server restart (per-request check)", () => {
    const previous = process.env.POS_WEB_DIR;
    const dir = mkdtempSync(join(tmpdir(), "pos-late-web-")); // empty at "boot"
    process.env.POS_WEB_DIR = dir;
    const middlewares: Array<(req: import("express").Request, res: import("express").Response, next: () => void) => void> = [];
    try {
      serveWebApp({ use: (m: typeof middlewares[number]) => { middlewares.push(m); } });
      // قبل از بیلد: صفحهٔ راهنما
      const before: Recorded = {};
      middlewares[0](makeReq("GET", "/"), makeRes(before), () => { before.nexted = true; });
      expect(before.status).toBe(503);
      expect(before.nexted).toBeUndefined();
      // وب وسط کار سرور بیلد می‌شود (مثل npm run build در حین اجرا)
      writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>app shell</body></html>");
      const after: Recorded = {};
      middlewares[0](makeReq("GET", "/"), makeRes(after), () => { after.nexted = true; });
      expect(after.nexted).toBe(true); // به استاتیک/SPA fallback واگذار می‌شود
      expect(after.status).toBeUndefined(); // دیگر 503 نیست
    } finally {
      if (previous === undefined) delete process.env.POS_WEB_DIR; else process.env.POS_WEB_DIR = previous;
    }
  });
});

describe("PWA manifest", () => {
  it("is valid JSON with the app identity and install icons", () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"));
    expect(manifest.name).toContain("روشن");
    expect(manifest.dir).toBe("rtl");
    expect(manifest.lang).toBe("fa");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");

    const icons = manifest.icons as Array<{ src: string; sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  });
});

describe("PWA service worker", () => {
  const sw = readFileSync(join(publicDir, "sw.js"), "utf8");

  it("caches the app shell but never serves /api from cache", () => {
    expect(sw).toContain("install");
    expect(sw).toContain("activate");
    expect(sw).toMatch(/\/api\//); // the early-return guard for live data
    expect(sw.match(/cache\.put\(request/)).toBeTruthy();
  });
});

describe("PWA icons", () => {
  it("ships exact-size PNG icons referenced by the manifest", () => {
    const cases = [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["icon-maskable-512.png", 512],
      ["icon-32.png", 32],
    ] as const;
    for (const [file, size] of cases) {
      const path = join(publicDir, "icons", file);
      expect(existsSync(path)).toBe(true);
      expect(pngSize(path)).toEqual({ width: size, height: size });
    }
  });
});
