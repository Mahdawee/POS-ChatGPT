import { BadRequestException, Injectable } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { configureLocalStorage } from "../storage";
import {
  daysLeft,
  openShadow,
  ROLLBACK_GRACE_MS,
  sealShadow,
  TRIAL_DAYS,
  verifyLicense,
  type LicensePayload,
} from "./license-core";
import { licensePublicKey } from "./license-public-key";
import { machineKey } from "./machine-key";

export type LicenseStatus = {
  /** Whether the app currently lets the till operate. */
  ok: boolean;
  /** TRIAL | LICENSED, or LICENSE_EXPIRED / TRIAL_EXPIRED / TAMPERED reasons when !ok. */
  mode: "TRIAL" | "LICENSED";
  reason: "NONE" | "TRIAL_EXPIRED" | "LICENSE_EXPIRED" | "TAMPERED" | "MACHINE_MISMATCH";
  plan: LicensePayload["plan"] | null;
  licenseId: string | null;
  customer: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  /** Machine clock effective for licensing (max of now and the high-water mark). */
  effectiveNow: string;
  trialStartedAt: string | null;
  trialDaysLeft: number | null;
  machineKey: string;
  features: string[];
};

type LicenseRow = { licenseText: string | null; maxSeenAt: Date | null; trialStartedAt: Date | null; tamperFlag: boolean };

/**
 * Licensing state machine.
 *
 * Two layers defend the vendor's revenue offline:
 * 1. The signed license itself (Ed25519, bound to one machine key).
 * 2. A monotonic clock: the maximum date ever observed is kept BOTH in the
 *    database and in an HMAC-sealed shadow file outside every backup. The
 *    effective "now" is the max of both, so setting the clock back neither
 *    rewinds an expiry nor restarts a trial — and a rollback larger than the
 *    24h grace window (timezone/DST corrections) is flagged as tampering,
 *    which blocks the app until a valid license for this machine arrives.
 */
@Injectable()
export class LicenseService {
  private readonly shadowPath = join(configureLocalStorage(), "license-shadow.json");

  constructor(private readonly prisma: PrismaService) {}

  private async row(tx?: Prisma.TransactionClient): Promise<LicenseRow> {
    const client = tx ?? this.prisma;
    let row = await client.licenseState.findUnique({ where: { id: "1" } });
    if (!row) {
      // First boot on this machine: the trial clock starts today.
      row = await client.licenseState.create({
        data: { id: "1", trialStartedAt: new Date(), maxSeenAt: new Date() },
      });
    }
    return row;
  }

  private readShadow(machine: string): { maxSeenAt: Date; tamperFlag: boolean; licenseId: string | null } | null {
    try {
      const sealed = readFileSync(this.shadowPath, "utf8").trim();
      const opened = openShadow(sealed, machine);
      if (!opened) return null;
      const at = new Date(opened.maxSeenAt);
      if (Number.isNaN(at.getTime())) return null;
      return { maxSeenAt: at, tamperFlag: opened.tamperFlag, licenseId: opened.licenseId };
    } catch {
      return null;
    }
  }

  private writeShadow(machine: string, maxSeenAt: Date, tamperFlag: boolean, licenseId: string | null): void {
    try {
      mkdirSync(configureLocalStorage(), { recursive: true });
      writeFileSync(
        this.shadowPath,
        sealShadow({ maxSeenAt: maxSeenAt.toISOString(), tamperFlag, licenseId }, machine),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Shadow file is defence-in-depth; failing to write must not crash the till.
    }
  }

  /**
   * Advances (never rewinds) the licensing clock. Returns the effective now
   * and persists the new high-water mark + tamper flag.
   */
  private async tick(row: LicenseRow, machine: string): Promise<{ effectiveNow: Date; tamper: boolean }> {
    const now = new Date();
    const shadow = this.readShadow(machine);
    const dbMax = row.maxSeenAt ? new Date(row.maxSeenAt).getTime() : 0;
    const shadowMax = shadow ? shadow.maxSeenAt.getTime() : 0;
    const highWater = Math.max(dbMax, shadowMax, now.getTime());
    const effectiveNow = new Date(highWater);
    // A clock reading far BELOW the high-water mark means someone rolled the
    // system date back. Small skews (timezone/DST/NTP) stay inside the grace.
    const rolledBack = highWater - now.getTime() > ROLLBACK_GRACE_MS;
    const tamper = row.tamperFlag || (shadow?.tamperFlag ?? false) || rolledBack;
    const licenseId = this.payloadOf(row)?.licenseId ?? shadow?.licenseId ?? null;
    if (effectiveNow.getTime() !== dbMax || tamper !== row.tamperFlag) {
      await this.prisma.licenseState.update({
        where: { id: "1" },
        data: { maxSeenAt: effectiveNow, tamperFlag: tamper },
      }).catch(() => undefined);
    }
    this.writeShadow(machine, effectiveNow, tamper, licenseId);
    return { effectiveNow, tamper };
  }

  private payloadOf(row: { licenseText: string | null }): LicensePayload | null {
    if (!row.licenseText) return null;
    try {
      return verifyLicense(row.licenseText, licensePublicKey());
    } catch {
      return null;
    }
  }

  /** Full status for the license screen; also the gate's data source. */
  async status(): Promise<LicenseStatus> {
    const machine = machineKey();
    const row = await this.row();
    const { effectiveNow, tamper } = await this.tick(row, machine);
    const payload = this.payloadOf(row);
    const base = {
      effectiveNow: effectiveNow.toISOString(),
      trialStartedAt: row.trialStartedAt ? new Date(row.trialStartedAt).toISOString() : null,
      machineKey: machine,
    };
    if (payload) {
      if (payload.machineKey !== machine) {
        return { ...base, ok: false, mode: "LICENSED", reason: "MACHINE_MISMATCH", plan: payload.plan, licenseId: payload.licenseId, customer: payload.customer, expiresAt: payload.expiresAt, daysLeft: daysLeft(payload.expiresAt, effectiveNow), trialDaysLeft: null, features: payload.features };
      }
      const expired = payload.expiresAt != null && effectiveNow.getTime() > new Date(payload.expiresAt).getTime();
      const days = daysLeft(payload.expiresAt, effectiveNow);
      return {
        ...base,
        ok: !tamper && !expired,
        mode: "LICENSED",
        reason: tamper ? "TAMPERED" : expired ? "LICENSE_EXPIRED" : "NONE",
        plan: payload.plan, licenseId: payload.licenseId, customer: payload.customer,
        expiresAt: payload.expiresAt, daysLeft: days, trialDaysLeft: null, features: payload.features,
      };
    }
    const trialEnd = row.trialStartedAt ? new Date(row.trialStartedAt).getTime() + TRIAL_DAYS * 86400000 : 0;
    const trialLeft = trialEnd ? Math.ceil((trialEnd - effectiveNow.getTime()) / 86400000) : null;
    const trialExpired = trialEnd > 0 && effectiveNow.getTime() > trialEnd;
    return {
      ...base,
      ok: !tamper && !trialExpired,
      mode: "TRIAL",
      reason: tamper ? "TAMPERED" : trialExpired ? "TRIAL_EXPIRED" : "NONE",
      plan: null, licenseId: null, customer: null, expiresAt: null, daysLeft: null,
      trialDaysLeft: trialLeft, features: [],
    };
  }

  /** Fast gate used by the middleware and by checkout: may this till sell? */
  async assertLicensed(): Promise<void> {
    const s = await this.status();
    if (s.ok) return;
    const messages: Record<LicenseStatus["reason"], string> = {
      NONE: "لایسنس فعال نیست.",
      TRIAL_EXPIRED: "دورهٔ آزمایشی ۱۴ روزه به پایان رسیده است. برای ادامه، لایسنس فعال کنید.",
      LICENSE_EXPIRED: "مدت لایسنس به پایان رسیده است. برای ادامه، لایسنس جدید فعال کنید.",
      TAMPERED: "تاریخ سیستم دستکاری شده است. برای ادامه، لایسنس معتبر فعال کنید.",
      MACHINE_MISMATCH: "این لایسنس برای دستگاه دیگری صادر شده است.",
    };
    throw new BadRequestException({ message: messages[s.reason], code: `LICENSE_${s.reason}` });
  }

  /** Imports a pasted license block after full verification. */
  async activate(licenseText: string): Promise<LicenseStatus> {
    let payload: LicensePayload;
    try {
      payload = verifyLicense(licenseText.trim(), licensePublicKey());
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "لایسنس معتبر نیست.");
    }
    const machine = machineKey();
    if (payload.machineKey !== machine) {
      throw new BadRequestException("این لایسنس برای دستگاه دیگری صادر شده است. لایسنس مخصوص همین دستگاه را وارد کنید.");
    }
    const row = await this.row();
    const { effectiveNow } = await this.tick(row, machine);
    if (payload.expiresAt != null && effectiveNow.getTime() > new Date(payload.expiresAt).getTime()) {
      throw new BadRequestException("مدت این لایسنس به پایان رسیده است. لایسنس جدید بگیرید.");
    }
    // Activating a DIFFERENT license clears a tamper flag: a shopkeeper who
    // pays for a fresh license after a clock mishap is let back in, while
    // simply re-importing the same blocked license changes nothing.
    const previous = this.payloadOf(row);
    const clearsTamper = previous?.licenseId !== payload.licenseId;
    await this.prisma.licenseState.update({
      where: { id: "1" },
      data: { licenseText: licenseText.trim(), ...(clearsTamper ? { tamperFlag: false } : {}) },
    });
    if (clearsTamper) {
      const fresh = await this.row();
      await this.tick(fresh, machine);
    }
    return this.status();
  }

  /** Admin: forget the imported license (back to trial / expired state). */
  async deactivate(): Promise<LicenseStatus> {
    await this.row();
    await this.prisma.licenseState.update({ where: { id: "1" }, data: { licenseText: null } });
    return this.status();
  }

  /**
   * Feature gate for future modules: `featureEnabled("wallet")` on a licensed
   * install with features ["*"] is always true, so new features keep working
   * under licenses issued today.
   */
  async featureEnabled(feature: string): Promise<boolean> {
    const row = await this.row();
    const payload = this.payloadOf(row);
    if (!payload) return true; // trial: everything included
    return payload.features.includes("*") || payload.features.includes(feature);
  }
}
