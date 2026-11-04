import { Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { PrismaService } from "./prisma.service";
import { databaseFilePath } from "./storage";
import { Public } from "./auth";

/** فایل owner.json — «شناسنامهٔ مالک برنامه».
 *
 * این فایل بیرون از دیتابیس (در پوشهٔ داده‌های برنامه، کنار pos.db)
 * زندگی می‌کند، پس برخلاف تنظیمات معمولی، با «صفر کردن داده‌ها» یا
 * برگرداندن پشتیبان پاک نمی‌شود و هویت برنامه را مالک آن کنترل می‌کند:
 * با ابزار گرافیکی بیرونی (خارج از پروژه) ویرایش می‌شود و سرور بی‌درنگ
 * (fs.watch) آن را دوباره می‌خواند. مقادیر این فایل بر تنظیمات داخل
 * برنامه مقدم است؛ کلید خالی/حذف‌شده یعنی «از تنظیمات خود برنامه
 * استفاده کن». */
export const OWNER_CONFIG_FILE = "owner.json";

export type OwnerConfigKey = "appName" | "shopName" | "address" | "phone" | "receiptFooter" | "logo";
export type OwnerConfig = Partial<Record<OwnerConfigKey, string>>;

/** کلیدهای مجاز و بیشینهٔ طول مجاز هرکدام (لوگو data-URL است و بلندتر). */
const FIELD_LIMITS: Record<OwnerConfigKey, number> = {
  appName: 40,
  shopName: 80,
  address: 160,
  phone: 40,
  receiptFooter: 200,
  logo: 400_000,
};

/** نام پیش‌فرض برنامه تا وقتی مالک چیز دیگری تعیین نکرده باشد. */
export const DEFAULT_APP_NAME = "روشن";

/** مقدار خوانده‌شده از فایل را پاک‌سازی می‌کند: فقط کلیدهای شناخته‌شده،
 *  فقط رشتهٔ ناتهی، بریده‌شده تا سقف طول. خروجی نامعتبر (مثلاً JSON
 *  خراب یا آرایه) → null تا صاحب قبلی کش دست‌نخورده بماند. */
export function parseOwnerConfig(raw: string): OwnerConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const clean: OwnerConfig = {};
  for (const key of Object.keys(FIELD_LIMITS) as OwnerConfigKey[]) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) clean[key] = trimmed.slice(0, FIELD_LIMITS[key]);
  }
  return clean;
}

@Injectable()
export class OwnerConfigService implements OnModuleInit, OnModuleDestroy {
  private cache: OwnerConfig = {};
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** مسیر مطلق فایل مالک — همان پوشه‌ای که pos.db در آن است. */
  ownerConfigPath(): string {
    return join(dirname(databaseFilePath()), OWNER_CONFIG_FILE);
  }

  onModuleInit(): void {
    this.cache = this.readFile();
    try {
      // تماشای کل پوشه (نه خود فایل) تا جایگزینی فایل توسط ویرایشگرها
      // (که معمولاً save-then-rename است) هم گرفته شود. رویدادها debounce
      // می‌شوند چون یک ذخیره ممکن است چند رویداد پشت‌سرهم بدهد.
      this.watcher = watch(dirname(this.ownerConfigPath()), (_event, filename) => {
        if (filename && filename !== OWNER_CONFIG_FILE) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 250);
      });
    } catch (error) {
      // نبودِ تماشگر نباید برنامه را از کار بیندازد؛ فقط تغییرات زنده
      // از کار می‌افتند و تا ری‌استرت بعدی مقدار بوت‌شده می‌ماند.
      console.warn(`owner-config: could not watch the data folder (${String(error)})`);
    }
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  /** خواندن مجدد فایل؛ اگر واقعاً چیزی عوض شده بود، رویداد Audit ثبت
   *  می‌شود تا تغییر هویت برنامه ردپایی در سابقه بگذارد. */
  reload(): void {
    const next = this.readFile();
    const changed = (Object.keys(FIELD_LIMITS) as OwnerConfigKey[]).filter(
      (key) => (next[key] ?? "") !== (this.cache[key] ?? ""),
    );
    const removed = (Object.keys(FIELD_LIMITS) as OwnerConfigKey[]).filter(
      (key) => this.cache[key] && !next[key],
    );
    this.cache = next;
    if (changed.length || removed.length) {
      const detail = JSON.stringify({ changed, removed });
      this.prisma.auditLog
        .create({ data: { action: "OWNER_CONFIG_UPDATE", entity: "OwnerConfig", entityId: OWNER_CONFIG_FILE, detail } })
        .catch(() => undefined);
    }
  }

  /** مقدار فعلی فایل مالک (فقط کلیدهای معتبر و پرشده). */
  readOwnerConfig(): OwnerConfig {
    return this.cache;
  }

  /** نام مؤثر برنامه: فایل مالک یا پیش‌فرض «روشن». */
  effectiveAppName(): string {
    return this.cache.appName || DEFAULT_APP_NAME;
  }

  private readFile(): OwnerConfig {
    try {
      const parsed = parseOwnerConfig(readFileSync(this.ownerConfigPath(), "utf8"));
      if (parsed === null) {
        console.warn(`owner-config: ${this.ownerConfigPath()} is not valid JSON — ignored`);
        return {};
      }
      return parsed;
    } catch {
      // نبود فایل حالت عادی است؛ یعنی «مالک چیزی تعیین نکرده».
      return {};
    }
  }
}

@Controller("owner-config")
export class OwnerConfigController {
  constructor(private readonly ownerConfig: OwnerConfigService) {}

  /** نام برنامه برای صفحهٔ ورود/قفل — نیازی به ورود ندارد و چیز دیگری
   *  لو نمی‌دهد (نشانی فایل، مسیر دیسک و… هرگز اینجا برنمی‌گردد). */
  @Public()
  @Get()
  get() {
    return { appName: this.ownerConfig.effectiveAppName() };
  }
}

@Module({
  controllers: [OwnerConfigController],
  providers: [OwnerConfigService],
  exports: [OwnerConfigService],
})
export class OwnerConfigModule {}
