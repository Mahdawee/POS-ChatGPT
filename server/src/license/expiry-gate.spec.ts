import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma.service";
import { LicenseService } from "./license.service";
import { machineKeyFromFacts, signLicense, type LicensePayload } from "./license-core";
import { applyLicenseGate } from "../main";

/**
 * ── صحنه‌سازی انقضای لایسنس ──────────────────────────────────────────────
 * A staged, end-to-end proof that an expired license locks the user out of
 * the WHOLE app — through the real HTTP stack:
 *
 *   1. fresh install           → even /auth/login answers 402
 *   2. activate a short license → login works, /license/status is ok
 *   3. the license expires      → login 402, health probe still 200,
 *                                 /license/status reports LICENSE_EXPIRED
 *   4. checkout's second gate   → assertLicensed() rejects too
 *   5. a fresh license          → unlock again (login 200)
 *
 * The gate applied here is the REAL one exported from main.ts (applyLicenseGate),
 * and the license is really signed/verified with Ed25519 — only Prisma is an
 * in-memory stand-in (no SQLite engine needed offline).
 */

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGGoSxRNoDl/ye2HRuSM/gZhX6plyhxAD5AEdqrVx1ks
-----END PRIVATE KEY-----`;
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAhdQWvkYHKU90izzUVREGg7jHmfDwdVhduHgyVTodqQ=
-----END PUBLIC KEY-----`;

const facts = { hostname: "till-01", platform: "linux", arch: "x64", cpuModel: "Intel i5", mac: "aa:bb:cc:dd:ee:ff", machineId: "deadbeef" };
const MACHINE_KEY = machineKeyFromFacts(facts);
const PASSWORD = "staging-pass-123";

type LicenseRow = { licenseText: string | null; maxSeenAt: Date | null; trialStartedAt: Date | null; tamperFlag: boolean };

/** In-memory Prisma: the license row + an admin user for /auth/login. */
function makeDb() {
  const row: LicenseRow = { licenseText: null, maxSeenAt: null, trialStartedAt: null, tamperFlag: false };
  return {
    licenseState: {
      findUnique: async () => (row.maxSeenAt || row.trialStartedAt || row.licenseText ? row : null),
      create: async ({ data }: { data: { maxSeenAt: Date } }) => { Object.assign(row, data, { id: "1" }); return row; },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return row; },
    },
    user: {
      findUnique: async () => ({ id: "u1", username: "admin", displayName: "مدیر صحنه‌سازی", role: "ADMIN", isActive: true, passwordHash: bcrypt.hashSync(PASSWORD, 4) }),
    },
    auditLog: { create: async () => undefined },
  };
}

/** A real signed license for this machine, valid for `ms` milliseconds. */
function licenseValidFor(ms: number, licenseId: string): string {
  const payload: LicensePayload = {
    v: 1,
    licenseId,
    customer: "دکان صحنه‌سازی",
    plan: "MONTHLY",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ms).toISOString(),
    machineKey: MACHINE_KEY,
    features: ["*"],
  };
  return signLicense(payload, PRIVATE_KEY);
}

describe("license expiry — staged end-to-end lockout", () => {
  let app: INestApplication;
  let base: string;
  let db: ReturnType<typeof makeDb>;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pos-expiry-"));
    process.env.POS_DATA_DIR = dir;
    process.env.POS_MACHINE_KEY = MACHINE_KEY;
    const pubFile = join(dir, "public.pem");
    writeFileSync(pubFile, PUBLIC_KEY);
    process.env.POS_LICENSE_PUBLIC_KEY_FILE = pubFile;
    db = makeDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    // The REAL gate from main.ts — the exact middleware production uses.
    applyLicenseGate(app, app.get(LicenseService));
    await app.init();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.POS_MACHINE_KEY;
    delete process.env.POS_LICENSE_PUBLIC_KEY_FILE;
  });

  const login = async () => fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  const status = async () => (await (await fetch(`${base}/license/status`)).json()) as { ok: boolean; reason: string; mode: string; plan: string | null; daysLeft: number | null };
  const activate = async (licenseText: string) => fetch(`${base}/license/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ licenseText }) });

  it("a fresh install is fully locked (even login is 402)", async () => {
    const response = await login();
    expect(response.status).toBe(402);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("LICENSE_TRIAL_NOT_STARTED");
    expect(body.message).toContain("دورهٔ آزمایشی");
  });

  it("a valid license unlocks the app", async () => {
    const activation = await activate(licenseValidFor(2500, "L-SHORT-1"));
    expect(activation.status).toBe(201);
    expect((await activation.json()).ok).toBe(true);
    const state = await status();
    expect(state.ok).toBe(true);
    expect(state.mode).toBe("LICENSED");
    expect(state.plan).toBe("MONTHLY");
    const response = await login();
    expect(response.status).toBe(201); // the login itself succeeded
    expect(((await response.json()) as { user: { username: string } }).user.username).toBe("admin");
  });

  it("after expiry the user has NO access — gate, status and checkout all block", async () => {
    // Wait until the 2.5s license really expires on the machine clock.
    await new Promise((resolve) => setTimeout(resolve, 2800));
    // 1) The HTTP gate: even LOGIN (and thus every other /api route) is 402.
    const response = await login();
    expect(response.status).toBe(402);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("LICENSE_LICENSE_EXPIRED");
    expect(body.message).toContain("مدت لایسنس به پایان رسیده است");
    // 2) The health probe stays reachable (the client needs it to reconnect).
    expect((await fetch(`${base}/auth/health`)).status).toBe(200);
    // 3) The license screen still works and reports the expiry reason.
    const state = await status();
    expect(state.ok).toBe(false);
    expect(state.reason).toBe("LICENSE_EXPIRED");
    expect(state.daysLeft).toBe(0);
    // 4) The SECOND enforcement point: checkout refuses to write a sale even
    //    if someone bypassed the HTTP middleware.
    await expect(app.get(LicenseService).assertLicensed()).rejects.toThrow("مدت لایسنس به پایان رسیده است");
  });

  it("activating a fresh license unlocks the app again", async () => {
    const activation = await activate(licenseValidFor(24 * 3600 * 1000, "L-FRESH-2"));
    expect(activation.status).toBe(201);
    const response = await login();
    expect(response.status).toBe(201);
    expect((await status()).ok).toBe(true);
  });
});
