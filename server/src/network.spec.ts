import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiHost, readNetworkMode, resolveApiHost } from "./network";

/** The LAN boot rule: an explicit API_HOST env wins; otherwise the persisted
 *  network-mode file decides — "server" opens 0.0.0.0, everything else stays
 *  on localhost. This is what makes Settings → Network work in development,
 *  where the API is started by npm (no env) instead of the Tauri shell. */
describe("network mode resolution (server/src/network.ts)", () => {
  let dir: string;
  const previousHost = process.env.API_HOST;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "darpos-net-"));
    delete process.env.API_HOST;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  afterAll(() => {
    if (previousHost === undefined) delete process.env.API_HOST;
    else process.env.API_HOST = previousHost;
  });

  test("no saved mode → localhost, reported as local", () => {
    expect(resolveApiHost(dir)).toBe("127.0.0.1");
    expect(apiHost()).toBe("127.0.0.1");
  });

  test('mode "server" → binds all interfaces (LAN clients can connect)', () => {
    writeFileSync(join(dir, "network-mode"), "server");
    expect(resolveApiHost(dir)).toBe("0.0.0.0");
    expect(apiHost()).toBe("0.0.0.0");
  });

  test('modes "local" and a client URL keep the dev API on localhost', () => {
    writeFileSync(join(dir, "network-mode"), "local");
    expect(resolveApiHost(dir)).toBe("127.0.0.1");
    writeFileSync(join(dir, "network-mode"), "http://192.168.1.10:4317");
    expect(resolveApiHost(dir)).toBe("127.0.0.1");
    expect(readNetworkMode(dir)).toBe("http://192.168.1.10:4317");
  });

  test("an explicit API_HOST env (packaged app) always wins over the file", () => {
    writeFileSync(join(dir, "network-mode"), "local");
    process.env.API_HOST = "0.0.0.0";
    expect(resolveApiHost(dir)).toBe("0.0.0.0");
    // The shell pins localhost while the file says server: env still wins.
    writeFileSync(join(dir, "network-mode"), "server");
    process.env.API_HOST = "127.0.0.1";
    expect(resolveApiHost(dir)).toBe("127.0.0.1");
  });

  test("apiHost() falls back sensibly before any resolve call", () => {
    delete process.env.API_HOST;
    // apiHost() is also read by /auth/health in tests that never resolve.
    expect(["127.0.0.1", "0.0.0.0"]).toContain(apiHost());
  });
});
