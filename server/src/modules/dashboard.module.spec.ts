import { mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("node:fs", () => ({ ...jest.requireActual("node:fs"), readdirSync: jest.fn(), statSync: jest.fn() }));

import { DashboardController } from "./dashboard.module";

const mockedReaddir = readdirSync as unknown as jest.Mock;
const mockedStat = statSync as unknown as jest.Mock;

/** Minimal Prisma stub: every aggregate/list query returns empty. */
function setup(backupDir: string | null) {
  const prisma = {
    sale: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: { creditPart: 0 } }) },
    product: { count: jest.fn().mockResolvedValue(0) },
    purchase: { aggregate: jest.fn().mockResolvedValue({ _sum: { total: 0 } }) },
    saleReturn: { aggregate: jest.fn().mockResolvedValue({ _sum: { total: 0, creditRelief: 0 } }) },
    customerPayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    installment: { findMany: jest.fn().mockResolvedValue([]) },
    customerOrder: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    setting: { findUnique: jest.fn().mockResolvedValue(backupDir === null ? null : { key: "backupDir", value: backupDir }) },
  };
  return { controller: new DashboardController(prisma as never), prisma };
}

describe("Dashboard summary — lastBackupAt", () => {
  beforeAll(() => {
    // lastBackupTimestamp() resolves the default folder through the storage
    // helper, which mkdirs POS_DATA_DIR; point it at a scratch folder.
    process.env.POS_DATA_DIR = join(tmpdir(), "pos-dashboard-spec");
    mkdirSync(process.env.POS_DATA_DIR, { recursive: true });
  });

  beforeEach(() => {
    mockedReaddir.mockReset();
    mockedStat.mockReset();
  });

  it("reports the newest backup from a custom folder even when the default folder does not exist yet", async () => {
    const { controller } = setup("/custom/backups");
    // First scanned folder = the custom one (has a fresh backup)…
    mockedReaddir.mockReturnValueOnce(["dar-pos-2026-11-02.db"]);
    mockedStat.mockReturnValueOnce({ mtimeMs: 1730000000000 });
    // …second scanned folder = the default one, never created because every
    // backup so far went to the custom location. This used to abort the whole
    // scan and hide the custom folder's backup from the dashboard.
    mockedReaddir.mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const summary = await controller.summary();

    expect(summary.lastBackupAt).toBe(new Date(1730000000000).toISOString());
  });

  it("falls back to the default folder when no custom dir is configured", async () => {
    const { controller } = setup(null);
    mockedReaddir.mockReturnValueOnce(["a.db", "dar-pos-newest.db"]);
    mockedStat.mockReturnValueOnce({ mtimeMs: 100 });
    mockedStat.mockReturnValueOnce({ mtimeMs: 200 });

    const summary = await controller.summary();

    expect(summary.lastBackupAt).toBe(new Date(200).toISOString());
  });

  it("returns null when no backup exists anywhere", async () => {
    const { controller } = setup(null);
    mockedReaddir.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const summary = await controller.summary();

    expect(summary.lastBackupAt).toBeNull();
  });
});
