/**
 * ── پل اسکن با دوربین گوشی (دور ۵۳؛ از دور ۶۱ همیشگی شد) ──────────────────────────────────
 * گوشی روی WiFi همان شبکه، مستقیم به همین پروسهٔ سرور وصل می‌شود — بدون هیچ
 * تغییری در رفتار بارکدخوان‌های USB یا منطق بارکدهای برنامه:
 *
 *   گوشی ──(HTTP/HTTPS خودامضا روی 0.0.0.0:4318)── سرور
 *     GET  /            صفحهٔ اسکن (خودکفا، RTL دری)
 *     GET  /zxing.js    کتابخانهٔ اسکن بارکد ZXing
 *     POST /api/pair    {pin} یا {token} → {token}
 *     POST /api/scan    {token, code} → ثبت در بافر حافظه
 *
 *   دسکتاپ ──(API اصلی، زیر JWT مثل همهٔ مسیرها)── سرور
 *     GET /api/phone-scan/status   وضعیت پل (running/tls/port/lan)
 *     GET /api/phone-scan/pin      PIN جاری برای جفت‌کردن گوشی
 *     GET /api/phone-scan/pull     {scans, now} — دسکتاپ هر ~۷۰۰ms می‌گیرد
 *
 * امنیت: PIN تصادفیِ هر راه‌اندازی فقط روی صفحهٔ تنظیماتِ کاربرِ واردشده
 * دیده می‌شود؛ گوشی بعد از تأیید PIN یک token تصادفی می‌گیرد. TLS با
 * CA محلیِ ثابت (کش در dataDir) + برگِ امضاشده — گوشی فایل /ca.crt را
 * یک‌بار نصب می‌کند و بعدش صفحهٔ امن بدون هیچ هشدار مرورگری باز می‌شود
 * (مثل mkcert؛ با تغییر IP شبکه فقط برگ عوض می‌شود، نه CA). این پل
 * قابلیت همیشگی برنامه است؛ در صورت نیاز با PHONE_SCAN_DISABLE=1 یا حذف
 * PhoneScanModule از app.module.ts به‌کل خاموش می‌شود.
 */
import { Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit, Query } from "@nestjs/common";
import * as http from "node:http";
import * as https from "node:https";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLocalStorage } from "../storage";
import { SettingsController } from "../modules/settings.module";
import { PHONE_SCAN_HTML } from "./phone-scan-page";
import { PHONE_SCAN_ICON_PNG, PHONE_SCAN_MANIFEST } from "./phone-scan-icon";
import { ZXING_UMD_JS } from "./zxing-umd";

/**
 * تایپ محلی بستهٔ selfsigned — بسته با requireِ تأخیری (داخل certificate)
 * بار می‌شود، نه در سطح ماژول. اگر این بستهٔ اختیاری در runtime نباشد،
 * فقط پل گوشی به HTTP ساده برمی‌گردد و هرگز کل سرور از کار نمی‌افتد.
 * گزینهٔ ca (بستهٔ ۵+) گواهی برگ را با CA ما امضا می‌کند — مثل mkcert.
 */
interface SelfsignedLike {
  generate(attrs: Array<{ name: string; value: string }>, options: {
    notAfterDate?: Date;
    keySize?: number;
    algorithm?: string;
    /** CA محلی برای امضای برگ؛ نبودش یعنی خودامضا. */
    ca?: { key: string; cert: string };
    extensions?: Array<{ name: string } & Record<string, unknown>>;
  }): Promise<{ cert: string; private: string }>;
}

/** پیش‌فرض‌های پل — با متغیرهای محیطی قابل تغییر. */
const DEFAULT_PORT = Number(process.env.PHONE_SCAN_PORT || 4318);
/** یک کد تکراری در این بازه به‌عنوان «همان اسکن قبلی» نادیده گرفته می‌شود. */
const DEDUPE_MS = 1500;
/** بافر حلقوی کدهای دریافتی — دسکتاپ با pull آخرین‌ها را می‌خواند. */
const MAX_SCANS = 100;
/** سقف بدنهٔ JSON درخواست‌های گوشی (کد بارکد هرچه باشد زیر این می‌ماند). */
const MAX_BODY_BYTES = 10 * 1024;
/** هر دستگاه (صندوق) یک نشست اسکن مستقل دارد — نشست‌های بی‌کار بعد از این
 *  مدت حذف می‌شوند (دسکتاپِ روشن هر ~۰٫۷ ثانیه pull می‌زند و زنده می‌ماند). */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** سقف نشست‌های هم‌زمان — بیشتر از این تعداد صندوق در یک فروشگاه بعید است؛
 *  قدیمی‌ترین لمس‌شده کنار می‌رود تا حافظهٔ بی‌پایان رشد نکند. */
const MAX_SESSIONS = 30;

export interface PhoneScanStartOptions {
  /** پورت گوش؛ 0 یعنی پورت تصادفی آزاد (در تست‌ها). */
  port?: number;
  /** HTTPS با گواهی خودامضا (پیش‌فرض) یا HTTP ساده برای تست. */
  tls?: boolean;
  /** پوشهٔ داده برای کش گواهی — پیش‌فرض dataDir برنامه. */
  dataDir?: string;
  /** لاگ؛ پیش‌فرض console.log، در تست‌ها خاموش. */
  log?: (message: string) => void;
}

export interface PhoneScanStatus {
  running: boolean;
  tls: boolean;
  port: number | null;
  /** پورت همدم HTTP ساده — همیشه بدون هشدار گواهی باز می‌شود (وقتی TLS روشن است). */
  httpPort?: number | null;
  /** نشانی‌های IPv4 این دستگاه در شبکهٔ محلی — دسکتاپ از آن‌ها URL گوشی می‌سازد. */
  lan: string[];
  /** وقتی روشن نیست: آخرین دلیل، برای نمایش راهنما در پنل تنظیمات. */
  reason?: string;
  /** خودتشخیص زندهٔ اتصال گوشی: آیا اصلاً به پل رسیده، صفحه باز کرده، PIN زده؟ */
  phone?: PhoneScanStats;
}

/** شمارنده‌های تشخیصی — فقط برای راهنمایی کاربر در پنل تنظیمات. */
export interface PhoneScanStats {
  /** آخرین اتصال TCP از هر دستگاهی (حتی بدون باز شدن صفحه). */
  lastSeen: number | null;
  /** تعداد درخواست‌های HTTP رسیده (صفحه باز شده باشد ≥ ۱). */
  requests: number;
  lastRequestAt: number | null;
  /** آخرین جفت‌شدن موفق گوشی با PIN/token. */
  pairedAt: number | null;
}

export interface PhoneScanEntry {
  code: string;
  at: number;
}

/** نشست اسکنِ یک دستگاه (صندوق) — هر دستگاه PIN، توکن و بافر خودش را
 *  دارد تا در فروشگاه چندصندوقی، اسکنِ گوشیِ هر صندوق‌دار فقط به همان
 *  دستگاه برسد و به دستگاه‌های دیگر پخش نشود. کلید نشست، شناسهٔ پایدار
 *  دستگاه است که UI در localStorage نگه می‌دارد (خالی = حالت قدیمی). */
interface ScanSession {
  pin: string;
  token: string;
  scans: PhoneScanEntry[];
  lastAtByCode: Map<string, number>;
  /** آخرین جفت‌شدن موفق گوشی با همین نشست — برای «جفت شده» در پنل همان دستگاه. */
  pairedAt: number | null;
  lastTouch: number;
}

@Injectable()
export class PhoneScanBridge implements OnModuleInit, OnModuleDestroy {
  private server: http.Server | https.Server | null = null;
  /** همدم HTTP ساده — همان صفحه را بدون هشدار گواهی سرو می‌کند. */
  private plainServer: http.Server | null = null;
  private plainPort: number | null = null;
  private tlsEnabled = true;
  private actualPort: number | null = null;
  /** PEM گواهی CA محلی — گوشی با دانلود و نصب /ca.crt دیگر هیچ هشداری نمی‌بیند. */
  private caCert = "";
  private sessions = new Map<string, ScanSession>();
  private disposed = false;
  private lastError = "";
  private stats: PhoneScanStats = { lastSeen: null, requests: 0, lastRequestAt: null, pairedAt: null };

  /** در تست‌ها (NODE_ENV=test) و با PHONE_SCAN_DISABLE=1 پل خودکار روشن نمی‌شود. */
  async onModuleInit(): Promise<void> {
    if (process.env.PHONE_SCAN_DISABLE === "1") { this.lastError = "PHONE_SCAN_DISABLE=1"; return; }
    if (process.env.NODE_ENV === "test") return;
    // شروع پل کاملاً جدا از بوت اصلی: کمی بعد از راه‌اندازی، بدون انتظار و
    // بدون آنکه هیچ خطایی به سرور اصلی برسد — این قابلیت اختیاری
    // است و هرگز نباید بالا آمدن برنامه را معطل کند یا ببندد. اگر روشن
    // نشد (مثلاً پورت موقتاً اشغال است) هر ۲۰ ثانیه خودکار دوباره تلاش
    // می‌شود تا پنل تنظیمات همیشه دلیل وضعیت را داشته باشد.
    const attemptStart = (attempt: number): void => {
      if (this.disposed || this.server) return;
      void this.start().then(() => { this.lastError = ""; }).catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (!this.disposed) {
          if (attempt === 1 || attempt % 6 === 0) console.warn(`[phone-scan] موقت: پل گوشی روشن نشد (تلاش ${attempt}) — ${this.lastError}؛ تلاش مجدد خودکار ادامه می‌یابد.`);
          const retry = setTimeout(() => attemptStart(attempt + 1), 20000);
          retry.unref?.();
        }
      });
    };
    const timer = setTimeout(() => attemptStart(1), 800);
    timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  /** PIN جاری — فقط از طریق /api/phone-scan/pin برای کاربر واردشده. */
  get currentPin(): string {
    return this.sessionFor("").pin;
  }

  /** PIN نشستِ یک دستگاه مشخص (شناسهٔ پایدار UI؛ خالی = حالت قدیمی). */
  sessionPin(clientId: string): string {
    return this.sessionFor(clientId).pin;
  }

  status(clientId?: string): PhoneScanStatus {
    const phone = clientId !== undefined
      ? { ...this.stats, pairedAt: this.sessionFor(clientId).pairedAt }
      : { ...this.stats };
    return {
      running: Boolean(this.server),
      tls: this.tlsEnabled,
      port: this.actualPort,
      httpPort: this.plainPort,
      lan: SettingsController.lanAddresses(),
      reason: this.server ? undefined : this.lastError || "not-started",
      phone,
    };
  }

  /** کدهای جدیدتر از `after` — دسکتاپ مهر زمانیِ پاسخ قبلی را پاس می‌کند. */
  pull(after: number, clientId = ""): { scans: PhoneScanEntry[]; now: number } {
    const session = this.sessionFor(clientId);
    const from = Number.isFinite(after) ? after : 0;
    return { scans: session.scans.filter((entry) => entry.at > from), now: Date.now() };
  }

  async start(options: PhoneScanStartOptions = {}): Promise<void> {
    if (this.server) return;
    this.tlsEnabled = options.tls ?? true;
    const wantedPort = options.port ?? DEFAULT_PORT;
    this.sessions.clear();
    const log = options.log ?? ((message: string) => console.log(`[phone-scan] ${message}`));
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => this.handleRequest(req, res);
    let server: http.Server | https.Server;
    if (this.tlsEnabled) {
      try {
        server = https.createServer(await this.certificate(options.dataDir), handler);
      } catch (error) {
        // گواهی ممکن نشد (بستهٔ selfsigned در runtime نیست، webcrypto قدیمی،
        // دسترسی به دیسک و…). به‌جای از کار انداختن پل، با HTTP ساده ادامه
        // می‌دهیم — حالت «اسکن با عکس» و «ورود دستی» گوشی همچنان کار می‌کند.
        this.tlsEnabled = false;
        log(`گواهی HTTPS ساخته نشد (${error instanceof Error ? error.message : String(error)}) — ادامه با HTTP ساده؛ اسکن عکس گوشی کار می‌کند.`);
        server = http.createServer(handler);
      }
    } else {
      server = http.createServer(handler);
    }
    // خطای listen: اگر پورت پیش‌فرض اشغال باشد (مثلاً یک نمونهٔ دیگر یا
    // برنامهٔ دیگری روی 4318)، تا پنج پورت بعدی خودکار امتحان می‌شود؛
    // پورتِ صریحاً خواسته‌شده (تست‌ها) جابه‌جا نمی‌شود.
    const listenOnce = (onPort: number): Promise<void> => new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(onPort, "0.0.0.0", () => {
        server.removeListener("error", onError);
        // خطاهای بعدیِ سوکت فقط لاگ می‌شوند تا یک اتصال خراب گوشی سرور را نیندازد
        server.on("error", (error) => log(`خطای اتصال گوشی: ${error.message}`));
        resolve();
      });
    });
    const maxBump = options.port === undefined ? 5 : 0;
    let bound = false;
    for (let bump = 0; bump <= maxBump && !bound; bump++) {
      const candidate = wantedPort + bump;
      try {
        await listenOnce(candidate);
        bound = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" || bump === maxBump) throw error;
        log(`پورت ${candidate} اشغال است؛ پورت بعدی امتحان می‌شود…`);
      }
    }
    const address = server.address();
    this.actualPort = typeof address === "object" && address ? address.port : wantedPort;
    this.server = server;
    // هر اتصال TCP (حتی نیمه‌کاره/ردشده به‌خاطر گواهی) برای خودتشخیص ثبت
    // می‌شود تا پنل بگوید گوشی اصلاً به سرور رسیده یا نه (فایروال/WiFi).
    server.on("connection", () => { this.stats.lastSeen = Date.now(); });
    log(`پل اسکن گوشی فعال شد روی ${this.tlsEnabled ? "https" : "http"}://0.0.0.0:${this.actualPort} (PIN هر دستگاه در تنظیمات همان دستگاه نمایش داده می‌شود)`);
    // همدم HTTP ساده: نشانی‌ای که همیشه بدون هشدار گواهی مرورگر باز می‌شود.
    // جفت‌کردن و «اسکن با عکس» آنجا کامل کار می‌کند و خودِ صفحه راهنمای
    // فعال‌سازی یک‌بارهٔ دوربین زنده (نشانی امن) را نشان می‌دهد. شکستن این
    // سرور هرگز پل اصلی را نمی‌بندد — فقط نشانی ساده در دسترس نمی‌ماند.
    if (this.tlsEnabled) {
      const wantedPlain = Number(process.env.PHONE_SCAN_HTTP_PORT || (this.actualPort + 1));
      const plain = http.createServer(handler);
      // خطای این سرور اختیاری هرگز پروسه را نمی‌اندازد و پل اصلی را نمی‌بندد
      plain.on("error", () => undefined);
      plain.on("connection", () => { this.stats.lastSeen = Date.now(); });
      // فوراً ثبت می‌شود تا stop() حتی وسط راه‌اندازی بتواند همان را ببندد
      this.plainServer = plain;
      // تا settle شدن همدم صبر می‌کنیم (چند میلی‌ثانیه) تا status بلافاصله
      // پورت ساده را گزارش کند؛ سقف ۳ ثانیه فقط بیمهٔ حالت‌های غیرعادی است.
      await new Promise<void>((resolvePlain) => {
        let listening = false;
        // شمارهٔ نسل تلاش: callback دیرهنگامِ listen ناموفق قبلی می‌تواند
        // بعد از موفقیت تلاش بعدی اجرا شود — فقط آخرین نسل حق ثبت دارد.
        let attempt = 0;
        const timer = setTimeout(resolvePlain, 3000);
        timer.unref?.();
        const done = (): void => { clearTimeout(timer); resolvePlain(); };
        const tryPlain = (onPort: number, left: number): void => {
          attempt += 1;
          const mine = attempt;
          plain.once("error", (error: Error) => {
            if (listening || mine !== attempt) return; // خطای دیرهنگام — نادیده
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EADDRINUSE" && left > 0) {
              log(`پورت سادهٔ ${onPort} اشغال است؛ پورت بعدی امتحان می‌شود…`);
              tryPlain(onPort + 1, left - 1);
            } else {
              if (this.plainServer === plain) { this.plainServer = null; this.plainPort = null; }
              log(`پل سادهٔ HTTP روی پورت ${onPort} باز نشد (${code || "خطا"}) — فقط نشانی امن در دسترس است.`);
              done();
            }
          });
          plain.listen(onPort, "0.0.0.0", () => {
            if (mine !== attempt) return; // callback تلاش قدیمی — دیرهنگام
            if (this.plainServer !== plain) { done(); return; } // همین حالا stop شده است
            listening = true;
            this.plainPort = onPort;
            log(`نشانی سادهٔ گوشی (بدون هشدار گواهی): http://0.0.0.0:${onPort}`);
            done();
          });
        };
        tryPlain(wantedPlain, 4);
      });
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    this.caCert = "";
    const plain = this.plainServer;
    this.plainServer = null;
    this.plainPort = null;
    const closeOne = async (target: http.Server | https.Server | null): Promise<void> => {
      if (!target) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
        try {
          // اتصال‌های بازِ نگه‌داشته‌شده (keep-alive گوشی) بسته می‌شوند تا close برگردد.
          (target as http.Server).closeAllConnections?.();
          target.close(() => resolve());
        } catch {
          // سرور هنوز listening نشده بود — چیزی برای بستن نیست
          resolve();
        }
      });
    };
    await Promise.all([closeOne(server), closeOne(plain)]);
  }

  /** گواهی خودامضا با SAN شامل localhost و IPهای فعلی شبکه؛ در dataDir
   *  کش می‌شود تا پذیرشِ یک‌بارهٔ کاربر در مرورگر گوشی با ری‌استارت‌ها باطل نشود.
   *  بستهٔ selfsigned همین‌جا و با require تأخیری بار می‌شود تا نبودنش هرگز
   *  اجرای کل برنامه را متوقف نکند (فقط همین پل به HTTP برمی‌گردد). */
  /** گواهی HTTPS مثل mkcert: یک «CA محلی» که گوشی یک‌بار نصبش می‌کند و
   *  بعدش صفحهٔ امن بدون هیچ هشدار مرورگری باز می‌شود؛ برگِ سرور با همان
   *  CA امضا می‌شود و با تغییر IP شبکه فقط برگ عوض می‌شود (نه CA) تا اعتمادِ
   *  نصب‌شده در گوشی برای همیشه معتبر بماند. هر دو در dataDir کش می‌شوند.
   *  بستهٔ selfsigned همین‌جا و با require تأخیری بار می‌شود تا نبودنش هرگز
   *  اجرای کل برنامه را متوقف نکند (فقط همین پل به HTTP برمی‌گردد). */
  private async certificate(dataDir?: string): Promise<{ key: string; cert: string }> {
    const dir = dataDir ?? configureLocalStorage();
    // require تأخیری: خطای «Cannot find module» اینجا ظاهر می‌شود، نه هنگام
    // بارگذاری ماژول — و توسط start() به fallback HTTP تبدیل می‌شود.
    const selfsigned = require("selfsigned") as SelfsignedLike;
    // ۱) CA محلی — فقط یک‌بار ساخته و برای همیشه کش می‌شود؛ نصبِ یک‌بارهٔ
    //    آن در گوشی (فایل /ca.crt) مثل نصب یک اپ کوچک است و ماندگار است.
    const caFile = join(dir, "phone-scan-ca.json");
    let caCert = "";
    let caKey = "";
    try {
      const cached = JSON.parse(readFileSync(caFile, "utf8")) as { cert?: string; private?: string };
      if (cached.cert && cached.private) { caCert = cached.cert; caKey = cached.private; }
    } catch { /* هنوز CAای نیست — در ادامه ساخته می‌شود */ }
    if (!caCert) {
      const ca = await selfsigned.generate([{ name: "commonName", value: "Dar POS Local CA" }], {
        // ده سال اعتبار — CA هرگز نباید عوض شود تا اعتماد گوشی باطل نشود
        notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true, critical: true },
          { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
        ],
      });
      caCert = ca.cert;
      caKey = ca.private;
      try { writeFileSync(caFile, JSON.stringify({ cert: caCert, private: caKey }), { mode: 0o600 }); } catch { /* بدون کش ادامه */ }
    }
    this.caCert = caCert;
    // ۲) برگِ سرور با SANِ امروز (localhost + IPهای شبکه)؛ امضاشده با همان
    //    CA. اگر IPها عوض شده باشند برگ تازه ساخته می‌شود — زنجیره همچنان
    //    معتبر است چون CA همان مانده و SAN جدید IP تازه را پوشش می‌دهد.
    const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
    ];
    for (const ip of SettingsController.lanAddresses()) altNames.push({ type: 7, ip });
    const leafFile = join(dir, "phone-scan-leaf.json");
    try {
      const cached = JSON.parse(readFileSync(leafFile, "utf8")) as { cert?: string; private?: string; altNames?: typeof altNames };
      if (cached.cert && cached.private && JSON.stringify(cached.altNames) === JSON.stringify(altNames)) return { key: cached.private, cert: cached.cert };
    } catch { /* هنوز برگی نیست — در ادامه ساخته می‌شود */ }
    const leaf = await selfsigned.generate([{ name: "commonName", value: "Dar POS Phone Scan" }], {
      // حدود دو سال و نیم — بازهٔ استاندارد برگ‌های محلی
      notAfterDate: new Date(Date.now() + 825 * 24 * 60 * 60 * 1000),
      keySize: 2048,
      algorithm: "sha256",
      ca: { key: caKey, cert: caCert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "subjectAltName", altNames },
      ],
    });
    try {
      writeFileSync(leafFile, JSON.stringify({ cert: leaf.cert, private: leaf.private, altNames }), { mode: 0o600 });
    } catch { /* اگر نوشتن نشد، فقط بدون کش ادامه می‌دهیم */ }
    return { key: leaf.private, cert: leaf.cert };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // شمارش برای خودتشخیص پنل: هر درخواست یعنی صفحه‌ای روی گوشی باز شده
    this.stats.requests += 1;
    this.stats.lastRequestAt = Date.now();
    const path = (req.url || "/").split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      // پورت نشانی امن در صفحه جایگذاری می‌شود تا دکمهٔ «فعال‌سازی دوربین
      // زنده» بداند به کجا برود؛ وقتی TLS نیست، 0 یعنی دکمه مخفی بماند.
      const html = PHONE_SCAN_HTML.replace(/__HTTPS_PORT__/g, String(this.tlsEnabled ? this.actualPort : 0));
      this.send(res, 200, html, "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && path === "/zxing.js") {
      this.send(res, 200, ZXING_UMD_JS, "application/javascript; charset=utf-8", "public, max-age=86400");
      return;
    }
    // «افزودن به صفحهٔ اصلی» (A2HS): آیکون و مانیفست روی هر دو مبدأ
    // (HTTPS و HTTP ساده) سرو می‌شوند تا نصب از هر نشانی‌ای ممکن باشد.
    if (req.method === "GET" && path === "/icon.png") {
      this.send(res, 200, PHONE_SCAN_ICON_PNG, "image/png", "public, max-age=86400");
      return;
    }
    if (req.method === "GET" && (path === "/manifest.webmanifest" || path === "/manifest.json")) {
      this.send(res, 200, PHONE_SCAN_MANIFEST, "application/manifest+json; charset=utf-8", "public, max-age=3600");
      return;
    }
    // گواهی CA محلی برای نصبِ یک‌باره در گوشی (مثل mkcert) — اندروید فایل را
    // با نصب‌کنندهٔ گواهی باز می‌کند و iOS پروفایل نصب می‌کند. بعد از آن
    // صفحهٔ امن (اسکن زنده) بدون هیچ هشدار مرورگری باز می‌شود.
    if (req.method === "GET" && (path === "/ca.crt" || path === "/ca.pem" || path === "/darpos-ca.crt")) {
      if (!this.caCert) { this.send(res, 404, "CA not available", "text/plain; charset=utf-8"); return; }
      this.send(res, 200, this.caCert, "application/x-x509-ca-cert", "public, max-age=3600");
      return;
    }
    if (req.method === "POST" && path === "/api/pair") {
      this.readJson(req, res, (body) => {
        const { pin, token } = body as { pin?: unknown; token?: unknown };
        // ادامهٔ جفت‌شدن با token قبلی (بعد از ری‌استارت سرور یا بازگشت به صفحه).
        if (typeof token === "string") {
          const session = this.sessionByToken(token);
          if (session) {
            session.pairedAt = Date.now();
            this.stats.pairedAt = Date.now();
            this.send(res, 200, JSON.stringify({ token: session.token }), "application/json");
            return;
          }
        }
        // جفت‌شدن با PIN → گوشی به نشست همان دستگاهی وصل می‌شود که این PIN را
        // نشان می‌دهد (در فروشگاه چندصندوقی هر دستگاه PIN خودش را دارد).
        if (typeof pin === "string") {
          const session = this.sessionByPin(pin);
          if (session) {
            session.token = randomBytes(16).toString("hex");
            session.pairedAt = Date.now();
            this.stats.pairedAt = Date.now();
            this.send(res, 200, JSON.stringify({ token: session.token }), "application/json");
            return;
          }
        }
        this.send(res, 403, JSON.stringify({ error: "PIN درست نیست." }), "application/json");
      });
      return;
    }
    if (req.method === "POST" && path === "/api/scan") {
      this.readJson(req, res, (body) => {
        const { token, code } = body as { token?: unknown; code?: unknown };
        const session = typeof token === "string" ? this.sessionByToken(token) : undefined;
        if (!session) {
          this.send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");
          return;
        }
        if (typeof code !== "string" || !code.trim() || code.trim().length > 256) {
          this.send(res, 400, JSON.stringify({ error: "bad code" }), "application/json");
          return;
        }
        const value = code.trim();
        const now = Date.now();
        const last = session.lastAtByCode.get(value) || 0;
        if (now - last <= DEDUPE_MS) {
          this.send(res, 200, JSON.stringify({ ok: true, duplicate: true }), "application/json");
          return;
        }
        session.lastAtByCode.set(value, now);
        if (session.lastAtByCode.size > 500) {
          for (const [cached, at] of session.lastAtByCode) if (now - at > DEDUPE_MS) session.lastAtByCode.delete(cached);
        }
        session.scans.push({ code: value, at: now });
        if (session.scans.length > MAX_SCANS) session.scans.splice(0, session.scans.length - MAX_SCANS);
        this.send(res, 200, JSON.stringify({ ok: true }), "application/json");
      });
      return;
    }
    this.send(res, 404, "not found", "text/plain; charset=utf-8");
  }

  /** نشست یک دستگاه را می‌سازد یا برمی‌گرداند — کلید، شناسهٔ پایدار UI است. */
  private sessionFor(clientId: string): ScanSession {
    const key = (clientId || "").slice(0, 64);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastTouch = Date.now();
      return existing;
    }
    this.pruneSessions();
    // PIN یکتا بین نشست‌های زنده — دو صندوق نباید PIN یکسان ببینند.
    let pin = "";
    for (let attempt = 0; attempt < 40 && !pin; attempt++) {
      const candidate = String(randomInt(1000, 10000));
      let clash = false;
      for (const session of this.sessions.values()) {
        if (session.pin === candidate) { clash = true; break; }
      }
      if (!clash) pin = candidate;
    }
    if (!pin) pin = String(randomInt(1000, 10000)); // عملاً رخ نمی‌دهد
    // سقف نشست‌ها: قدیمی‌ترین لمس‌شده کنار می‌رود.
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key2, session] of this.sessions) {
        if (session.lastTouch < oldestAt) { oldestAt = session.lastTouch; oldestKey = key2; }
      }
      if (oldestKey !== null) this.sessions.delete(oldestKey);
    }
    const session: ScanSession = { pin, token: randomBytes(16).toString("hex"), scans: [], lastAtByCode: new Map(), pairedAt: null, lastTouch: Date.now() };
    this.sessions.set(key, session);
    return session;
  }

  private sessionByPin(pin: string): ScanSession | undefined {
    this.pruneSessions();
    for (const session of this.sessions.values()) {
      if (session.pin === pin) { session.lastTouch = Date.now(); return session; }
    }
    return undefined;
  }

  private sessionByToken(token: string): ScanSession | undefined {
    this.pruneSessions();
    for (const session of this.sessions.values()) {
      if (session.token === token) { session.lastTouch = Date.now(); return session; }
    }
    return undefined;
  }

  /** نشست‌های بی‌کار را حذف می‌کند — دسکتاپِ روشن با pull منظم زنده می‌ماند. */
  private pruneSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastTouch > SESSION_TTL_MS) this.sessions.delete(key);
    }
  }

  private send(res: http.ServerResponse, status: number, body: string | Buffer, contentType: string, cacheControl = "no-store"): void {
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": cacheControl });
    res.end(body);
  }

  /** JSON دستی با سقف حجم — بدون وابستگی به express این پل سبک می‌ماند. */
  private readJson(req: http.IncomingMessage, res: http.ServerResponse, next: (body: unknown) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let answered = false;
    req.on("data", (chunk: Buffer) => {
      if (answered) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // پاسخ ۴۱۳ بلافاصله می‌رود و بقیهٔ بدنه دور ریخته می‌شود (سوکت
        // نابود نمی‌شود تا گوشی/کلاینت پاسخ را واقعاً دریافت کند).
        answered = true;
        this.send(res, 413, JSON.stringify({ error: "payload too large" }), "application/json");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (answered) return;
      try {
        next(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        this.send(res, 400, JSON.stringify({ error: "bad json" }), "application/json");
      }
    });
    req.on("error", () => { /* اتصال نیمه‌کاره — چیزی برای پاسخ دادن نیست */ });
  }
}

/** مسیرهای دسکتاپ — زیر پیشوند /api سرور اصلی؛ LocalAuthGuard جهانی مثل
 *  بقیهٔ مسیرها JWT می‌خواهد، پس PIN فقط برای کاربرِ واردشده فاش می‌شود.
 *  پارامتر client شناسهٔ پایدار دستگاه است: هر صندوق نشست، PIN و بافر
 *  اسکنِ خودش را دارد تا اسکنِ گوشی هر صندوق‌دار فقط به همان دستگاه برسد. */
@Controller("phone-scan")
export class PhoneScanController {
  constructor(private readonly bridge: PhoneScanBridge) {}

  @Get("status")
  status(@Query("client") client?: string): PhoneScanStatus & { urls: string[] } {
    const info = this.bridge.status(client || "");
    const scheme = info.tls ? "https" : "http";
    const urls = [`127.0.0.1`, ...info.lan].map((host) => `${scheme}://${host}:${info.port}`);
    // نشانی ساده (HTTP) — فقط برای LAN؛ 127.0.0.1 برای گوشی بی‌معناست
    if (info.httpPort) urls.push(...info.lan.map((host) => `http://${host}:${info.httpPort}`));
    return {
      ...info,
      urls,
    };
  }

  @Get("pin")
  pin(@Query("client") client?: string): { pin: string } {
    return { pin: this.bridge.sessionPin(client || "") };
  }

  @Get("pull")
  pull(@Query("after") after?: string, @Query("client") client?: string): { scans: PhoneScanEntry[]; now: number } {
    const parsed = Number(after);
    return this.bridge.pull(Number.isFinite(parsed) ? parsed : 0, client || "");
  }
}

@Module({
  controllers: [PhoneScanController],
  providers: [PhoneScanBridge],
  exports: [PhoneScanBridge],
})
export class PhoneScanModule {}
