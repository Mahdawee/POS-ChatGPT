import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ── LAN network mode ──────────────────────────────────────────────────────
 * The Settings → Network page persists the shop's LAN mode into a
 * `network-mode` file inside the shared data directory (written by the
 * Tauri shell's set_network_mode command):
 *   "server"   → bind 0.0.0.0 so registers on other machines can connect
 *   "http://…" → this machine is a network client; a locally started dev
 *                API stays on localhost (the UI talks to the remote server)
 *   ""/"local" → single-computer mode (default)
 *
 * The packaged app spawns this server with an explicit API_HOST env, but in
 * development (`npm run dev`) the API is started by npm without any env — so
 * at boot the file is the source of truth the dev API follows too. Without
 * this, choosing «سرور شبکه» in dev never actually opened the port and
 * /auth/health kept reporting "local".
 */
let boundHost: string | null = null;

/** Where the `network-mode` file can live. The Tauri shell writes into
 *  %APPDATA%\DarPOSERP on Windows — the same directory the server uses. On
 *  Linux/macOS development the shell's fallback is the identifier-based
 *  app-data dir, so that location is probed as well. */
function networkModeCandidates(dataDir: string): string[] {
  const own = join(dataDir, "network-mode");
  if (process.platform === "win32") return [own];
  const tauriDir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "af.darpos.local")
    : join(homedir(), ".local", "share", "af.darpos.local");
  return [own, join(tauriDir, "network-mode")];
}

/** Reads the persisted LAN mode ("" when nothing was saved yet). */
export function readNetworkMode(dataDir: string): string {
  for (const candidate of networkModeCandidates(dataDir)) {
    try {
      const content = readFileSync(candidate, "utf8").trim();
      if (content) return content;
    } catch { /* not written there — try the next location */ }
  }
  return "";
}

/** Resolves and remembers the host this API binds to. An explicit API_HOST
 *  env always wins (the packaged app sets it); otherwise the network-mode
 *  file decides. The remembered value is what /auth/health reports. */
export function resolveApiHost(dataDir: string): string {
  const envHost = (process.env.API_HOST || "").trim();
  if (envHost) {
    boundHost = envHost;
    return envHost;
  }
  boundHost = readNetworkMode(dataDir) === "server" ? "0.0.0.0" : "127.0.0.1";
  return boundHost;
}

/** The host this API actually bound to (127.0.0.1 or 0.0.0.0). */
export function apiHost(): string {
  return boundHost || (process.env.API_HOST || "").trim() || "127.0.0.1";
}
