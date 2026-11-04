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

describe("Dashboard summary — counts and chart after months of use", () => {
  it("reports the TRUE low-stock count, not the capped 8-row card list", async () => {
    const { controller, prisma } = setup(null);
    (prisma.$queryRaw as jest.Mock).mockImplementation((query: unknown) => {
      const sql = String(query);
      if (sql.includes("stock <= minStock") && sql.includes("COUNT(*)")) return Promise.resolve([{ count: 27 }]);
      if (sql.includes("stock <= minStock")) return Promise.resolve([{ id: "p1", name: "چای", sku: "T-1", unit: "بسته", stock: 2, minStock: 5 }]);
      return Promise.resolve([]);
    });
    const summary = await controller.summary();
    // The card list stays capped at 8 for the dashboard panel, but the count
    // a shopkeeper reads ("۲۷ کالا کم‌موجود") must be the real number.
    expect(summary.lowStock).toHaveLength(1);
    expect(summary.lowStockCount).toBe(27);
  });

  it("reports the true expiring count with the batch-suppression rule", async () => {
    const { controller, prisma } = setup(null);
    (prisma.$queryRawUnsafe as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes("FROM Product WHERE isActive = 1 AND expiryDate IS NOT NULL")) return Promise.resolve([{ count: 9 }]);
      if (sql.includes("FROM ProductBatch WHERE remainingQty > 0 AND expiryDate")) return Promise.resolve([{ count: 4 }]);
      return Promise.resolve([]);
    });
    const summary = await controller.summary();
    expect(summary.expiringCount).toBe(13);
  });

  it("compares expiry windows in epoch milliseconds, never against datetime()", async () => {
    // Prisma stores DateTime columns as epoch millis in SQLite; comparing that
    // INTEGER to datetime('now', ...) (TEXT) is always-true in SQLite and the
    // card used to count every dated item. The SQL must now carry a numeric cutoff.
    const { controller, prisma } = setup(null);
    await controller.summary();
    const rawCalls = [
      ...(prisma.$queryRaw as jest.Mock).mock.calls.map((call) => (Array.isArray(call[0]) ? call[0].join("?") : String(call[0]))),
      ...(prisma.$queryRawUnsafe as jest.Mock).mock.calls.map((call) => String(call[0])),
    ];
    const expirySqls = rawCalls.filter((sql) => sql.includes("expiryDate <="));
    expect(expirySqls.length).toBeGreaterThanOrEqual(4);
    for (const sql of expirySqls) {
      expect(sql).not.toContain("datetime(");
      expect(sql).toMatch(/expiryDate <= (?:\?|\d{9,})/);
    }
  });

  it("zero-fills all 14 chart days so a closed day is a 0-bar, not a gap", async () => {
    const { controller, prisma } = setup(null);
    const today = new Date();
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    (prisma.sale.findMany as jest.Mock).mockImplementation(({ where }: { where: { createdAt?: { gte?: Date } } }) =>
      where?.createdAt ? Promise.resolve([{ createdAt: twoDaysAgo, total: 500 }]) : Promise.resolve([]));
    const summary = await controller.summary();
    expect(summary.salesByDay).toHaveLength(14);
    const days = summary.salesByDay.map((row: { day: string }) => row.day);
    expect(days[days.length - 1]).toBe(key(today));
    expect(days).toHaveLength(new Set(days).size); // contiguous, no duplicates
    const bar = summary.salesByDay.find((row: { day: string }) => row.day === key(twoDaysAgo));
    expect(bar!.total).toBe(500);
    expect(summary.salesByDay[summary.salesByDay.length - 2].total).toBe(0);
  });
});

describe("Dashboard summary — low stock", () => {
  it("excludes bundles (their stock is always 0) and carries the unit", async () => {
    const { controller, prisma } = setup(null);
    (prisma.$queryRaw as jest.Mock).mockImplementation((query: unknown) => {
      const sql = String(query);
      if (sql.includes("stock <= minStock")) return Promise.resolve([{ id: "p1", name: "چای", sku: "T-1", unit: "بسته", stock: 2, minStock: 5 }]);
      return Promise.resolve([]);
    });
    const summary = await controller.summary();
    expect(summary.lowStock).toEqual([{ id: "p1", name: "چای", sku: "T-1", unit: "بسته", stock: 2, minStock: 5 }]);
    const lowStockSql = (prisma.$queryRaw as jest.Mock).mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("stock <= minStock"));
    expect(lowStockSql).toContain("isBundle = 0");
    expect(lowStockSql).toContain("unit");
  });
});
