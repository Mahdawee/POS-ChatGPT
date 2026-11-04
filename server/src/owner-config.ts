import { Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
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

/** سقف حجم فایل مالک — فایل بزرگ‌تر از این اصلاً خوانده نمی‌شود تا یک
 *  فایل تصادفیِ چندصد‌مگابایتی (مثلاً لوگو داخلش چسبانده باشند) حافظهٔ
 *  سرور را در هر رویداد تماشاگر پر نکند. */
const OWNER_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

/** کاراکترهای کنترلی (بجز خط نو) از مقدارها زدوده می‌شوند — نه در HTML
 *  به درستی نمایش داده می‌شوند، نه در رسید متنی، و فقط اذیت می‌سازند. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

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
    const trimmed = value.replace(CONTROL_CHARS, "").trim();
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
    this.cache = this.readFile() ?? {};
    try {
      // تماشای کل پوشه (نه خود فایل) تا جایگزینی فایل توسط ویرایشگرها
      // (که معمولاً save-then-rename است) هم گرفته شود. رویدادها debounce
      // می‌شوند چون یک ذخیره ممکن است چند رویداد پشت‌سرهم بدهد.
      this.watcher = watch(dirname(this.ownerConfigPath()), (_event, filename) => {
        if (filename && filename !== OWNER_CONFIG_FILE) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 250);
      });
      // رویداد «error» تماشگر اگر مدیریت نشود پروسس را می‌اندازد (مثلاً وقتی
      // پوشهٔ داده پاک/جابه‌جا شود)؛ فایل مالک هرگز نباید برنامه را بکشد.
      this.watcher.on("error", (error) => {
        console.warn(`owner-config: folder watcher stopped (${String(error)}) — values stay as loaded until restart`);
        this.watcher?.close();
        this.watcher = null;
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
    if (next === undefined) return; // فایل خراب/نصف‌نوشته — آخرین وضعیت سالم می‌ماند
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

  /** خواندن فایل مالک از دیسک.
   *
   * خروجی‌ها: مقدار معتبر = فایل تازه؛ {} = فایل نیست/خالی (مالک حذفش
   * کرده — تنظیمات پاک می‌شوند)؛ undefined = فایل هست ولی خواندنی نیست
   * (JSON خراب، نصف‌نوشته یا بزرگ‌تر از سقف) — آخرین کش سالم می‌ماند تا
   * نوسانِ ذخیرهٔ ادیتور برند برنامه را پرت نکند.
   */
  private readFile(): OwnerConfig | undefined {
    try {
      const { size } = statSync(this.ownerConfigPath());
      if (size > OWNER_CONFIG_MAX_BYTES) {
        console.warn(`owner-config: ${this.ownerConfigPath()} is ${size} bytes (over the ${OWNER_CONFIG_MAX_BYTES} limit) — ignored`);
        return undefined;
      }
      const parsed = parseOwnerConfig(readFileSync(this.ownerConfigPath(), "utf8"));
      if (parsed === null) {
        console.warn(`owner-config: ${this.ownerConfigPath()} is not valid JSON — ignored`);
        return undefined;
      }
      return parsed;
    } catch {
      // نبود فایل حالت عادی است؛ یعنی «مالک چیزی تعیین نکرده» (یا عمداً
      // حذفش کرده) — پاک شدن کامل، برخلاف خرابی، عملی آگاهانه است.
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
