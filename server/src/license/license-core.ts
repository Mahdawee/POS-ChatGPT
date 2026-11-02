import { createHash, createHmac, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomUUID } from "node:crypto";

/**
 * Licensing core: pure crypto + parsing helpers shared by the API (verify
 * only) and the vendor CLI (sign). Kept free of Nest/DB so it can be unit
 * tested and reused by `tools/license/cli.js` via ts-node-free duplication —
 * the CLI has its own tiny copy, this file stays the server-side verifier.
 *
 * License format (plain text, easy to email/WhatsApp to a shopkeeper):
 *
 *   -----DARPOS LICENSE-----
 *   <base64url(JSON payload)>.<base64url(Ed25519 signature)>
 *   -----END DARPOS LICENSE-----
 *
 * The signature covers the payload bytes exactly, so any edit — a longer
 * expiry, another machine, another plan — breaks verification.
 */

export const LICENSE_BEGIN = "-----DARPOS LICENSE-----";
export const LICENSE_END = "-----END DARPOS LICENSE-----";

export type LicensePlan = "TRIAL" | "MONTHLY" | "YEARLY" | "CUSTOM" | "LIFETIME";

export type LicensePayload = {
  /** Format version — future-proofing for payload changes. */
  v: 1;
  licenseId: string;
  customer: string;
  plan: LicensePlan;
  /** ISO date when the license was issued (vendor side). */
  issuedAt: string;
  /** ISO date when it expires; null = lifetime. */
  expiresAt: string | null;
  /** Machine key of the ONE device this license unlocks. */
  machineKey: string;
  /** Feature keys; ["*"] = everything (keeps future features covered). */
  features: string[];
  note?: string;
};

export class LicenseFormatError extends Error {}

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** Serialises + signs a payload with the vendor's Ed25519 private key. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = edSign(null, Buffer.from(body, "utf8"), createPrivateKey(privateKeyPem));
  return `${LICENSE_BEGIN}\n${body}.${b64url(signature)}\n${LICENSE_END}`;
}

/** Extracts and signature-checks a license block. Throws LicenseFormatError. */
export function verifyLicense(text: string, publicKeyPem: string): LicensePayload {
  const match = text.match(/-----DARPOS LICENSE-----\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*-----END DARPOS LICENSE-----/);
  if (!match) throw new LicenseFormatError("متن لایسنس درست نیست. کل بلوک لایسنس را کپی کنید.");
  const [body, signature] = match[1].split(".");
  let payload: LicensePayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8")) as LicensePayload;
  } catch {
    throw new LicenseFormatError("محتوای لایسنس قابل خواندن نیست.");
  }
  if (!payload || typeof payload !== "object" || !payload.licenseId || !payload.machineKey || !payload.plan) {
    throw new LicenseFormatError("لایسنس ناقص است.");
  }
  const ok = edVerify(null, Buffer.from(body, "utf8"), createPublicKey(publicKeyPem), fromB64url(signature));
  if (!ok) throw new LicenseFormatError("امضای لایسنس معتبر نیست — متن تغییر کرده است.");
  return payload;
}

// ── Machine key ───────────────────────────────────────────────────────────

export type MachineFacts = {
  hostname: string;
  platform: string;
  arch: string;
  cpuModel: string;
  mac: string;
  machineId: string;
};

/**
 * Stable, hardware-tied identity of the machine running the till: hostname,
 * OS/platform/arch, CPU model, primary MAC address and the OS machine-id
 * (Linux `/etc/machine-id`, Windows `MachineGuid`, macOS IOPlatformUUID).
 * SHA-256 over the concatenation, formatted as MK-XXXX-XXXX-XXXX-XXXX.
 */
export function machineKeyFromFacts(facts: MachineFacts): string {
  const digest = createHash("sha256")
    .update([facts.hostname, facts.platform, facts.arch, facts.cpuModel, facts.mac, facts.machineId].join("\u0000"))
    .digest("hex")
    .toUpperCase();
  return `MK-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`;
}

// ── Shadow-file integrity (anti clock-rollback) ───────────────────────────

const SHADOW_PEPPER = "darpos.shadow.v1";

/** HMAC-bound shadow record — cannot be forged without the machine key. */
export function sealShadow(record: { maxSeenAt: string; tamperFlag: boolean; licenseId: string | null }, machineKey: string): string {
  const body = JSON.stringify(record);
  const mac = createHmac("sha256", `${SHADOW_PEPPER}:${machineKey}`).update(body).digest("base64url");
  return `${mac}.${b64url(Buffer.from(body, "utf8"))}`;
}

/** Inverse of sealShadow; returns null when the file was tampered with. */
export function openShadow(sealed: string, machineKey: string): { maxSeenAt: string; tamperFlag: boolean; licenseId: string | null } | null {
  const dot = sealed.indexOf(".");
  if (dot <= 0) return null;
  const mac = sealed.slice(0, dot);
  let body: string;
  try {
    body = fromB64url(sealed.slice(dot + 1)).toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", `${SHADOW_PEPPER}:${machineKey}`).update(body).digest("base64url");
  if (mac !== expected) return null;
  try {
    const parsed = JSON.parse(body) as { maxSeenAt: string; tamperFlag: boolean; licenseId: string | null };
    if (typeof parsed.maxSeenAt !== "string" || typeof parsed.tamperFlag !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

export const newLicenseId = (): string => randomUUID();

/** Days remaining until `expiresAt` (negative = already past). Null for lifetime. */
export function daysLeft(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 86400000);
}

export const TRIAL_DAYS = 14;
/** Clock rollback beyond this window is treated as tampering. */
export const ROLLBACK_GRACE_MS = 24 * 3600 * 1000;
