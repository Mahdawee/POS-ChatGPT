import { createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { LicenseService } from "./license.service";
import {
  LicenseFormatError,
  daysLeft,
  machineKeyFromFacts,
  openShadow,
  sealShadow,
  signLicense,
  verifyLicense,
  type LicensePayload,
} from "./license-core";

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGGoSxRNoDl/ye2HRuSM/gZhX6plyhxAD5AEdqrVx1ks
-----END PRIVATE KEY-----`;
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAhdQWvkYHKU90izzUVREGg7jHmfDwdVhduHgyVTodqQ=
-----END PUBLIC KEY-----`;

const facts = {
  hostname: "till-01",
  platform: "linux",
  arch: "x64",
  cpuModel: "Intel i5",
  mac: "aa:bb:cc:dd:ee:ff",
  machineId: "deadbeef",
};

const EXPECTED_MACHINE_KEY = machineKeyFromFacts(facts);

// Point the service at a sandbox data dir, a fixed machine identity and the
// test keypair BEFORE any service is constructed (the shadow path and the
// public key are resolved at call time, so per-test dirs also work).
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pos-license-"));
  process.env.POS_DATA_DIR = dir;
  process.env.POS_MACHINE_KEY = EXPECTED_MACHINE_KEY;
  const pubFile = join(dir, "test-public.pem");
  writeFileSync(pubFile, PUBLIC_KEY);
  process.env.POS_LICENSE_PUBLIC_KEY_FILE = pubFile;
});
afterEach(() => {
  delete process.env.POS_MACHINE_KEY;
  delete process.env.POS_LICENSE_PUBLIC_KEY_FILE;
});

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    licenseId: "L1",
    customer: "دکان احمد",
    plan: "YEARLY",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    machineKey: machineKeyFromFacts(facts),
    features: ["*"],
    ...overrides,
  };
}

describe("license-core crypto", () => {
  it("round-trips a signed license", () => {
    const text = signLicense(payload(), PRIVATE_KEY);
    expect(text).toContain("-----DARPOS LICENSE-----");
    const verified = verifyLicense(text, PUBLIC_KEY);
    expect(verified.customer).toBe("دکان احمد");
    expect(verified.plan).toBe("YEARLY");
  });

  it("rejects edited license text (signature covers payload bytes)", () => {
    const text = signLicense(payload(), PRIVATE_KEY);
    // Flip one character of the base64 body: the signature no longer matches.
    const lines = text.split("\n");
    const body = lines[1].slice(0, 40) + (lines[1][40] === "A" ? "B" : "A") + lines[1].slice(41);
    const tampered = [lines[0], body, ...lines.slice(2)].join("\n");
    expect(() => verifyLicense(tampered, PUBLIC_KEY)).toThrow(LicenseFormatError);
  });

  it("rejects a wrong public key", () => {
    const text = signLicense(payload(), PRIVATE_KEY);
    const other = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQKaMj3bhk+TffKq0c4i4zYfbNNTqOx+P6T5iZ3L6hbk=
-----END PUBLIC KEY-----`;
    expect(() => verifyLicense(text, other)).toThrow(LicenseFormatError);
  });

  it("accepts whitespace and surrounding notes around the block", () => {
    const text = signLicense(payload(), PRIVATE_KEY);
    const wrapped = `سلام، لایسنس شما:\n\n${text}\n\nموفق باشید!`;
    expect(verifyLicense(wrapped, PUBLIC_KEY).licenseId).toBe("L1");
  });

  it("formats and re-derives the machine key deterministically", () => {
    const key = machineKeyFromFacts(facts);
    expect(key).toMatch(/^MK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(machineKeyFromFacts({ ...facts, hostname: "other" })).not.toBe(key);
  });

  it("seals and opens the shadow record, rejecting forgeries", () => {
    const sealed = sealShadow({ maxSeenAt: "2026-06-01T00:00:00.000Z", tamperFlag: false, licenseId: "L1" }, machineKeyFromFacts(facts));
    expect(openShadow(sealed, machineKeyFromFacts(facts))?.maxSeenAt).toBe("2026-06-01T00:00:00.000Z");
    // Wrong machine key cannot open the seal.
    expect(openShadow(sealed, machineKeyFromFacts({ ...facts, machineId: "other" }))).toBeNull();
    // Edited body breaks the HMAC.
    expect(openShadow(sealed.slice(0, -4) + "AAAA", machineKeyFromFacts(facts))).toBeNull();
  });

  it("computes days-left including lifetime null", () => {
    expect(daysLeft(null, new Date())).toBeNull();
    expect(daysLeft("2026-11-16T00:00:00.000Z", new Date("2026-11-02T00:00:00.000Z"))).toBe(14);
  });
});

type Row = {
  licenseText: string | null;
  maxSeenAt: Date | null;
  trialStartedAt: Date | null;
  tamperFlag: boolean;
};

/** Minimal Prisma stand-in: only what LicenseService touches. */
function makeDb(row: Row) {
  const state: Row = row;
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    licenseState: {
      findUnique: async () => (state.maxSeenAt || state.trialStartedAt || state.licenseText ? state : null),
      create: async ({ data }: { data: { maxSeenAt: Date; trialStartedAt?: Date } }) => {
        Object.assign(state, data, { id: "1" });
        return state;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        Object.assign(state, data);
        return state;
      },
    },
  };
}

const serviceWith = (row: Row) => {
  const db = makeDb(row);
  const svc = new LicenseService(db as never);
  return { svc, db };
};

describe("LicenseService state machine", () => {
  it("keeps a fresh install LOCKED until the trial is explicitly started", async () => {
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: null, trialStartedAt: null, tamperFlag: false });
    const locked = await svc.status();
    expect(locked.ok).toBe(false);
    expect(locked.mode).toBe("TRIAL");
    expect(locked.reason).toBe("TRIAL_NOT_STARTED");
    expect(locked.trialDaysLeft).toBe(14);
    // The API gate and checkout read the same status: nothing works yet.
    await expect(svc.assertLicensed()).rejects.toThrow(/شروع نشده/);
  });

  it("startTrial unlocks the app for 14 days and never extends on repeat", async () => {
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: null, trialStartedAt: null, tamperFlag: false });
    const started = await svc.startTrial();
    expect(started.ok).toBe(true);
    expect(started.reason).toBe("NONE");
    expect(started.trialDaysLeft!).toBeLessThanOrEqual(14);
    expect(started.trialDaysLeft!).toBeGreaterThanOrEqual(13);
    // Pressing the button again (or a reinstall) must not buy extra days.
    const again = await svc.startTrial();
    expect(again.trialStartedAt).toBe(started.trialStartedAt);
    expect(again.trialDaysLeft).toBe(started.trialDaysLeft);
  });

  it("does not rewrite the license clock on every request (single-writer contention)", async () => {
    // ساعت تازه است → تیک‌های پیاپی در پنجرهٔ ۶۰ ثانیه نباید هیچ بنویسند؛
    // قبلاً هر درخواست یک UPDATE خودکار روی SQLite می‌زد که با تراکنش‌های
    // اصلی بر سر قفلِ تک‌نویسنده تصادم می‌کرد.
    const { svc, db } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(Date.now() - 3600000), tamperFlag: false });
    await svc.status(); // تیک اول: شادو نبوده → یک flush می‌سازد
    const afterFirst = db.updates.length;
    await svc.status();
    await svc.status();
    await svc.status();
    expect(db.updates.length).toBe(afterFirst);
  });

  it("refreshes the high-water mark only when it is meaningfully stale", async () => {
    // ساعتِ بالایی ۵ دقیقه عقب مانده → دقیقاً یک تازه‌سازی، نه بیشتر.
    const { svc, db } = serviceWith({ licenseText: null, maxSeenAt: new Date(Date.now() - 5 * 60000), trialStartedAt: new Date(Date.now() - 3600000), tamperFlag: false });
    await svc.status();
    expect(db.updates.length).toBe(1);
    await svc.status();
    expect(db.updates.length).toBe(1); // ساعت تازه شد → تیک بعدی ساکت
  });

  it("a wiped database cannot restart the trial — the shadow file remembers", async () => {
    // Trial started 20 days ago on this machine: status seals that start
    // into the shadow file outside the database.
    const first = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(Date.now() - 20 * 86400000), tamperFlag: false });
    expect((await first.svc.status()).reason).toBe("TRIAL_EXPIRED");
    // "Delete pos.db": a brand-new state row, same machine + shadow file.
    const second = serviceWith({ licenseText: null, maxSeenAt: null, trialStartedAt: null, tamperFlag: false });
    const wiped = await second.svc.status();
    expect(wiped.ok).toBe(false);
    expect(wiped.reason).toBe("TRIAL_EXPIRED");
    // Explicitly trying to start a fresh trial buys nothing either.
    const retry = await second.svc.startTrial();
    expect(retry.ok).toBe(false);
    expect(retry.reason).toBe("TRIAL_EXPIRED");
  });

  it("expires the trial when the trial window passes", async () => {
    // Trial started 34 days ago; the clock is honest (high-water = now).
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(Date.now() - 34 * 86400000), tamperFlag: false });
    const status = await svc.status();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("TRIAL_EXPIRED");
  });

  it("flags a clock rollback beyond 24h as tampering", async () => {
    // High-water mark is 10 days ahead of the current clock → rolled back.
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(Date.now() + 10 * 86400000), trialStartedAt: new Date(Date.now() - 2 * 86400000), tamperFlag: false });
    const status = await svc.status();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("TAMPERED");
  });

  it("does not flag small clock corrections (timezone/DST)", async () => {
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(Date.now() + 2 * 3600000), trialStartedAt: new Date(Date.now() - 2 * 86400000), tamperFlag: false });
    const status = await svc.status();
    expect(status.reason).toBe("NONE");
  });

  it("accepts a valid license for this machine and reports days left", async () => {
    const text = signLicense(payload({ plan: "MONTHLY", expiresAt: new Date(Date.now() + 10 * 86400000).toISOString() }), PRIVATE_KEY);
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(Date.now() - 40 * 86400000), tamperFlag: false });
    const status = await svc.activate(text);
    expect(status.ok).toBe(true);
    expect(status.mode).toBe("LICENSED");
    expect(status.plan).toBe("MONTHLY");
    expect(status.daysLeft).toBeGreaterThanOrEqual(9);
    expect(status.daysLeft).toBeLessThanOrEqual(10);
  });

  it("refuses a license issued for another machine", async () => {
    const text = signLicense(payload({ machineKey: "MK-0000-0000-0000-0001" }), PRIVATE_KEY);
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    await expect(svc.activate(text)).rejects.toThrow(BadRequestException);
  });

  it("refuses an already-expired license at activation", async () => {
    const text = signLicense(payload({ expiresAt: new Date(Date.now() - 86400000).toISOString() }), PRIVATE_KEY);
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    await expect(svc.activate(text)).rejects.toThrow(BadRequestException);
  });

  it("reports LICENSE_EXPIRED once the effective clock passes expiresAt", async () => {
    const text = signLicense(payload({ expiresAt: new Date(Date.now() - 2 * 86400000).toISOString() }), PRIVATE_KEY);
    const { svc } = serviceWith({ licenseText: text, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    const status = await svc.status();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("LICENSE_EXPIRED");
  });

  it("keeps a lifetime license ok with null expiry", async () => {
    const text = signLicense(payload({ plan: "LIFETIME", expiresAt: null }), PRIVATE_KEY);
    const { svc } = serviceWith({ licenseText: text, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    const status = await svc.status();
    expect(status.ok).toBe(true);
    expect(status.daysLeft).toBeNull();
  });

  it("cannot be unlocked by an unsigned license text", async () => {
    const fake = `-----DARPOS LICENSE-----\n${Buffer.from(JSON.stringify(payload())).toString("base64url")}.${Buffer.from("fakesig").toString("base64url")}\n-----END DARPOS LICENSE-----`;
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    await expect(svc.activate(fake)).rejects.toThrow(BadRequestException);
  });

  it("featureEnabled is true for star features and for trials", async () => {
    const text = signLicense(payload(), PRIVATE_KEY);
    const licensed = serviceWith({ licenseText: text, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    await expect(licensed.svc.featureEnabled("wallet")).resolves.toBe(true);
    const trial = serviceWith({ licenseText: null, maxSeenAt: new Date(), trialStartedAt: new Date(), tamperFlag: false });
    await expect(trial.svc.featureEnabled("wallet")).resolves.toBe(true);
  });

  it("assertLicensed throws a Persian message when the trial is over", async () => {
    const { svc } = serviceWith({ licenseText: null, maxSeenAt: new Date(Date.now() + 30 * 86400000), trialStartedAt: new Date(Date.now() - 34 * 86400000), tamperFlag: false });
    await expect(svc.assertLicensed()).rejects.toThrow(/لایسنس|آزمایشی/);
  });
});

// The embedded public key must be a loadable Ed25519 key so every license
// issued by tools/license/cli.js (whose keys/public.pem matches it) verifies.
describe("embedded public key", () => {
  it("loads as a valid Ed25519 SPKI key", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LICENSE_PUBLIC_KEY } = require("./license-public-key");
    expect(LICENSE_PUBLIC_KEY).toMatch(/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/);
    expect(() => createPublicKey(LICENSE_PUBLIC_KEY)).not.toThrow();
  });
});
