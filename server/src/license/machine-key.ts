import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces, platform, arch, cpus } from "node:os";
import { machineKeyFromFacts, type MachineFacts } from "./license-core";

/**
 * Collects the stable hardware identity of this machine. Every source is
 * best-effort: a missing one degrades to an empty string instead of failing,
 * because the key must be reproducible across reboots, not fragile.
 */
export function collectMachineFacts(): MachineFacts {
  const mac =
    Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface && !iface.internal && iface.mac !== "00:00:00:00:00:00")?.mac ?? "";
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "",
    mac,
    machineId: readOsMachineId(),
  };
}

function readOsMachineId(): string {
  const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const path of candidates) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  }
  if (platform() === "win32") {
    try {
      return execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("MachineGuid"))
        ?.split(/\s+/)
        .pop() ?? "";
    } catch {
      // Registry query unavailable — fall through.
    }
  }
  if (platform() === "darwin") {
    try {
      return execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith('"IOPlatformUUID"'))
        ?.split("=")
        .pop()
        ?.replace(/"/g, "")
        .trim() ?? "";
    } catch {
      // ioreg unavailable — fall through.
    }
  }
  return "";
}

/** The machine key of THIS device (what the shopkeeper sends to the vendor). */
export function machineKey(): string {
  // Test/harness override so the identity can be simulated deterministically.
  if (process.env.POS_MACHINE_KEY) return process.env.POS_MACHINE_KEY;
  return machineKeyFromFacts(collectMachineFacts());
}

/** Exposed for tests: derive a key from explicit facts without touching os. */
export const _machineKeyFromFacts = machineKeyFromFacts;
export const _sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
