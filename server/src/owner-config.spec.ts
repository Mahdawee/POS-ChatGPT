import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APP_NAME, OwnerConfigController, OwnerConfigService, parseOwnerConfig } from "./owner-config";
import { SettingsController } from "./modules/settings.module";

/** پوشهٔ دادهٔ آزمایشی با DATABASE_URL اشاره‌کننده به آن — سرویس مالک
 *  فایل owner.json را در همان پوشهٔ pos.db جست‌وجو می‌کند. */
function dataDirWith(ownerJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "owner-config-"));
  if (ownerJson !== null) writeFileSync(join(dir, "owner.json"), ownerJson, "utf8");
  process.env.DATABASE_URL = `file:${join(dir, "pos.db")}`;
  return dir;
}

function makeService(ownerJson: string | null): { service: OwnerConfigService; prisma: { auditLog: { create: jest.Mock } }; dir: string } {
  const dir = dataDirWith(ownerJson);
  const prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
  const service = new OwnerConfigService(prisma as never);
  return { service, prisma, dir };
}

describe("Owner config — the owner.json file", () => {
  afterEach(() => { process.env.DATABASE_URL = ""; });

  it("parses only the known string keys, trims them and drops the rest", () => {
    const parsed = parseOwnerConfig(JSON.stringify({
      appName: "  فروشگاه نوری  ", shopName: "نوری مارکت", phone: "0790123456",
      address: "کابل، شهر نو", evil: { nested: true }, logo: 42,
    }));
    expect(parsed).toEqual({ appName: "فروشگاه نوری", shopName: "نوری مارکت", phone: "0790123456", address: "کابل، شهر نو" });
  });

  it("returns null for broken JSON so the previous cache survives a half-written file", () => {
    expect(parseOwnerConfig("{ not json")).toBeNull();
    expect(parseOwnerConfig("[]")).toBeNull();
    expect(parseOwnerConfig('"just a string"')).toBeNull();
  });

  it("loads the file at boot and falls back to the default app name when it is absent", () => {
    const { service } = makeService(null);
    service.onModuleInit();
    expect(service.readOwnerConfig()).toEqual({});
    expect(service.effectiveAppName()).toBe(DEFAULT_APP_NAME);
    service.onModuleDestroy();
  });

  it("exposes the owner's app name through the public endpoint shape", () => {
    const { service } = makeService(JSON.stringify({ appName: "نوری" }));
    service.onModuleInit();
    const controller = new OwnerConfigController(service);
    expect(controller.get()).toEqual({ appName: "نوری" });
    service.onModuleDestroy();
  });

  it("picks up file edits via reload() and writes an audit entry only when something changed", async () => {
    const { service, prisma, dir } = makeService(JSON.stringify({ appName: "نوری" }));
    service.onModuleInit();
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ appName: "نوری", shopName: "نوری مارکت" }), "utf8");
    service.reload();
    await Promise.resolve(); // let the fire-and-forget audit promise settle
    expect(service.readOwnerConfig()).toEqual({ appName: "نوری", shopName: "نوری مارکت" });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "OWNER_CONFIG_UPDATE", entity: "OwnerConfig", entityId: "owner.json" }),
    }));
    // یک reload بی‌تغییر نباید رویداد تکراری بسازد.
    service.reload();
    await Promise.resolve();
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a corrupted file instead of crashing the boot", () => {
    const { service } = makeService("{ half-written");
    service.onModuleInit();
    expect(service.readOwnerConfig()).toEqual({});
    expect(service.effectiveAppName()).toBe(DEFAULT_APP_NAME);
    service.onModuleDestroy();
  });
});

describe("Settings — owner file overrides the in-app shop settings", () => {
  afterEach(() => { process.env.DATABASE_URL = ""; });

  async function getSettings(ownerJson: string | null) {
    const { service } = makeService(ownerJson);
    service.onModuleInit();
    const prisma = {
      setting: { findMany: jest.fn().mockResolvedValue([{ key: "shopName", value: "دکان قدیمی" }, { key: "receiptFooter", value: "خداحافظ" }]) },
    };
    const controller = new SettingsController(prisma as never, { reset: jest.fn(), seed: jest.fn() } as never, service);
    const settings = await controller.get();
    service.onModuleDestroy();
    return settings;
  }

  it("owner values win and the locked keys are reported to the client", async () => {
    const settings = await getSettings(JSON.stringify({ shopName: "نوری مارکت", phone: "0790123456" }));
    expect(settings).toMatchObject({ shopName: "نوری مارکت", phone: "0790123456", receiptFooter: "خداحافظ", ownerLocked: ["shopName", "phone"] });
  });

  it("without an owner file the stored settings flow through untouched", async () => {
    const settings = await getSettings(null);
    expect(settings).toEqual({ shopName: "دکان قدیمی", receiptFooter: "خداحافظ" });
  });
});
