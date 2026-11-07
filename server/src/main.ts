import "reflect-metadata";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, static as serveStatic } from "express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { configureLocalStorage } from "./storage";
import { LicenseService } from "./license/license.service";
import { resolveApiHost } from "./network";
import { invalidateReportCache } from "./modules/reports.module";

async function bootstrap() {
  const dataDir = configureLocalStorage();
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  // Express defaults to a 100KB JSON body, which silently rejects larger
  // receipt logos (data URLs up to ~300KB) and database restore payloads.
  app.use(json({ limit: "64mb" }));
  app.setGlobalPrefix("api");
  // LAN mode: desktop clients on other machines connect to this API, so any
  // origin is reflected (authentication still happens per-request via JWT).
  app.enableCors({ origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  // Heavy reports are cached in memory; any write (sale, return, expense,
  // purchase, settings…) must drop the cache so reports never go stale.
  app.use((req: { method?: string }, _res: unknown, next: () => void) => {
    if (req.method && req.method !== "GET" && req.method !== "OPTIONS" && req.method !== "HEAD") invalidateReportCache();
    next();
  });
  applyLicenseGate(app, app.get(LicenseService));
  // PWA: serve the built web UI from the API origin so phones and other
  // computers can open the app at this address without installing anything.
  serveWebApp(app);
  const port = Number(process.env.API_PORT || 4317);
  // The desktop app pins API_HOST=127.0.0.1; a machine shared as the LAN
  // server is started with API_HOST=0.0.0.0 so other registers can connect.
  // In development the env is not set, so the persisted network-mode file
  // (Settings → Network) decides — same rule as the packaged app.
  const host = resolveApiHost(dataDir);
  await app.listen(port, host);
  console.log(`Dar POS API listening on ${host}:${port}; local data: ${dataDir}`);
}

/** Persian messages for the 402 gate — also asserted by the expiry staging test. */
export const LICENSE_GATE_MESSAGES = {
  TRIAL_NOT_STARTED: "دورهٔ آزمایشی هنوز شروع نشده است. از صفحهٔ لایسنس، دورهٔ آزمایشی را شروع کنید یا لایسنس فعال کنید.",
  TRIAL_EXPIRED: "دورهٔ آزمایشی ۱۴ روزه به پایان رسیده است. برای ادامه، لایسنس فعال کنید.",
  LICENSE_EXPIRED: "مدت لایسنس به پایان رسیده است. برای ادامه، لایسنس جدید فعال کنید.",
  TAMPERED: "تاریخ سیستم دستکاری شده است. برای ادامه، لایسنس معتبر فعال کنید.",
  MACHINE_MISMATCH: "این لایسنس برای دستگاه دیگری صادر شده است.",
  NONE: "لایسنس فعال نیست.",
} as const;

/**
 * ── License gate ─────────────────────────────────────────────────────────
 * Every /api route except the license endpoints themselves (and the health
 * probe) answers 402 while the app is unlicensed/expired/tampered. This is
 * the first of two enforcement points; CheckoutService re-checks before
 * writing a sale, so patching the middleware alone does not open the till.
 * Exported so the staging test boots the REAL gate, not a copy of it.
 */
export function applyLicenseGate(app: { use(middleware: (req: { method?: string; path: string }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => void): unknown }, license: { status(): Promise<{ ok: boolean; reason: keyof typeof LICENSE_GATE_MESSAGES }> }): void {
  app.use((req: { method?: string; path: string }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    const path = req.path ?? "";
    if (
      req.method === "OPTIONS" ||
      !path.startsWith("/api") ||
      path.startsWith("/api/license") ||
      path === "/api/auth/health"
    ) {
      next();
      return;
    }
    void license
      .status()
      .then((state) => {
        if (state.ok) next();
        else res.status(402).json({ statusCode: 402, code: `LICENSE_${state.reason}`, message: LICENSE_GATE_MESSAGES[state.reason] });
      })
      .catch(() => next());
  });
}

// Run only when executed directly (node dist/main.js), not when a test
// imports applyLicenseGate from this module.
if (require.main === module) void bootstrap();

/** True when a request is a browser page load that should get the SPA shell
 *  (any non-API GET that no static file matched). Exported for unit tests. */
export function isSpaFallbackRequest(method: string | undefined, path: string): boolean {
  return method === "GET" && !path.startsWith("/api");
}

type MiddlewareApp = { use(middleware: (req: Request, res: Response, next: NextFunction) => void): unknown };

/**
 * ── Web UI / PWA serving ─────────────────────────────────────────────────
 * When a built frontend sits next to the compiled API, it is served from the
 * API origin: a phone or another computer on the network opens the server
 * address and gets the app (installable PWA), and the browser build talks to
 * the same-origin /api (see desktop/src/lib/api.ts). The web root is
 * resolved as:
 *   1. POS_WEB_DIR environment variable
 *   2. dist/web — copied next to the compiled API by scripts/copy-web.mjs,
 *      and bundled into the packaged desktop app's server the same way.
 * A pure API deployment (no web files present) serves nothing — behaviour
 * is exactly as before. /api requests are never intercepted: unknown API
 * routes keep returning the JSON 402/404 they return today.
 */
export function serveWebApp(app: MiddlewareApp): void {
  const root = process.env.POS_WEB_DIR || join(__dirname, "web");
  if (!existsSync(join(root, "index.html"))) {
    // بیلد وب کنار سرور نیست (مثلاً فقط سرور بیلد شده یا کلون تازه). تا قبل
    // از این، مرورگر JSON 404 بی‌توضیح می‌دید؛ حالا یک صفحهٔ راهنما می‌گیرد
    // که مشکل و راه‌حلش را صریح می‌گوید. مسیرهای /api دست‌نخورده می‌مانند.
    console.warn(`[web] فایل‌های نسخهٔ وب کنار سرور پیدا نشد (${join(root, "index.html")}). نسخهٔ مرورگر (گوشی/کامپیوترهای دیگر) تا بیلد وب فعال نمی‌شود — از ریشهٔ پروژه: npm run build (اول دسکتاپ، بعد سرور) و سپس ری‌استارت سرور.`);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!isSpaFallbackRequest(req.method, req.path)) return next();
      res.status(503).type("html").send(missingWebPageHtml());
    });
    return;
  }
  app.use(
    serveStatic(root, {
      index: false,
      setHeaders: (res, filePath) => {
        // Hashed bundles are immutable; everything else (sw.js, manifest,
        // icons) must always revalidate so updates reach the browsers.
        res.setHeader("Cache-Control", filePath.startsWith(join(root, "assets")) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isSpaFallbackRequest(req.method, req.path)) return next();
    res.sendFile(join(root, "index.html"));
  });
}

/** صفحهٔ راهنمای «وب بیلد نشده» — فقط HTML درون‌خطی، بدون فایل جانبی. */
export function missingWebPageHtml(): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>نسخهٔ وب هنوز نصب نیست</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{max-width:34rem;padding:2rem}h1{font-size:1.25rem}code{direction:ltr;display:inline-block;background:#1e293b;padding:.15rem .5rem;border-radius:.4rem;font-size:.9rem}li{margin:.5rem 0}</style></head><body><div><h1>سرور در حال اجراست، اما نسخهٔ وب برنامه کنار آن نصب نشده است</h1><p>به همین دلیل آدرس در مرورگر، خطای <code>Cannot GET /</code> می‌داد. خود برنامهٔ API سالم است؛ فقط فایل‌های وب (برای گوشی و کامپیوترهای دیگر) در این بیلد کنار سرور کپی نشده‌اند.</p><p>برای فعال‌کردن نسخهٔ مرورگر:</p><ol><li>در ریشهٔ پروژه اجرا کنید: <code>npm run build</code> (اول رابط کاربری، بعد سرور — ترتیب مهم است)</li><li>سرور را ری‌استارت کنید و همین آدرس را دوباره باز کنید</li></ol><p style="opacity:.7;font-size:.85rem">نصب پیشرفته: با متغیر محیطی <code>POS_WEB_DIR</code> می‌توانید مسیر دیگری برای فایل‌های وب مشخص کنید.</p></div></body></html>`;
}
