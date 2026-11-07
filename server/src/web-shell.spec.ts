import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isSpaFallbackRequest } from "./main";

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
