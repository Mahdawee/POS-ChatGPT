import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
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
