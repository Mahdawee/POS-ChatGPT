import { useEffect, useRef, useState } from "react";
import { Copy, Smartphone, CircleAlert, CircleCheck } from "lucide-react";
import { t, dateTime } from "../i18n";
import { apiBase, get } from "../lib/api";
import { qrCreate } from "../lib/vendor/qr-core";

/** نسخهٔ بصری پنل — اگر این متن را در تنظیمات نمی‌بینید، برنامهٔ در حال
 *  اجرا قدیمی است و باید دوباره ساخته شود (تشخیص قطعی build کهنه). */
const PHONE_SCAN_PANEL_VERSION = "9"; // همیشگی + بارکد از گوشی به فرم ثبت کالا
/** رندر QR روی canvas — مطمئن‌ترین راه نمایش در هر WebView: بدون <img>،
 *  بدون data-URI و بدون SVG؛ پیکسل‌ها مستقیم با جاوااسکریپت نقش می‌شوند
 *  و ماتریسِ همان موتور QR رسیدهای چاپی (تأییدشده در عمل) است. */
function QrCanvas({ text, target }: { text: string; target: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      const qr = qrCreate(text, "M");
      const margin = 4; // ناحیهٔ ساکت — استاندارد QR
      const total = qr.size + margin * 2;
      const scale = Math.max(4, Math.round(target / total));
      const px = total * scale;
      canvas.width = px;
      canvas.height = px;
      canvas.style.width = `${px}px`;
      canvas.style.height = `${px}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = "#000";
      for (let row = 0; row < qr.size; row++) {
        for (let col = 0; col < qr.size; col++) {
          if (qr.get(row, col) === 1) ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
        }
      }
    } catch { /* متن پشتیبانی‌نشده — نشانی متنی زیر کادر باقی است */ }
  }, [text, target]);
  return <canvas ref={ref}/>;
}

/**
 * ── پل اسکن با دوربین گوشی (دور ۵۳؛ از دور ۶۱ همیشگی شد) ──────────────────
 * دو قطعهٔ کاملاً جدا از بارکدخوان‌های USB:
 *
 *  PhoneScanListener — در App رندر می‌شود (خروجی ندارد) و هر ~۰٫۷ ثانیه
 *    /phone-scan/pull را می‌خواند؛ هر کد تازه اول به فیلد بارکدِ فرمِ بازِ
 *    کالا می‌رسد (ثبت کالا با اسکن گوشی)، بعد به فرم جست‌وجوی صندوق
 *    (دقیقاً مثل تایپ بارکدخوان سخت‌افزاری) و در پایان به‌صورت پیام.
 *
 *  PhoneScanPanel — بخش «اسکن با گوشی» در تنظیمات ← بارکدخوان: وضعیت پل،
 *    PIN جفت‌کردن، نشانی‌های گوشی با QR و راهنمای اتصال.
 */

/** کلید localStorage برای روشن/خاموش‌کردن تزریق خودکار به فاکتور. */
const INJECT_KEY = "darpos:phone-scan-inject";

function phoneScanInjectEnabled(): boolean {
  try { return localStorage.getItem(INJECT_KEY) !== "0"; } catch { return true; }
}

/** رهاسازی یک بارکد در برنامه — مقصد اول فیلد بارکدِ فرمِ بازِ کالاست
 *  (ثبت/ویرایش کالا: اسکن کن، فیلد همان لحظه پر می‌شود)؛ بعد فرم جست‌وجوی
 *  صندوق که مقدار در آن نوشته و submit می‌شود تا scan() خودِ برنامه
 *  (بارکد ترازو، تطبیق دقیق، بوق، افزودن) بدون هیچ تغییری اجرا شود. */
function deliverScan(code: string): void {
  // فرم کالا باز است → بارکد مستقیم در فیلد بارکد همان فرم می‌نشیند؛
  // بارکدخوان USB هم همین‌جا تایپ می‌کند (وقتی فیلد فعال باشد).
  const productBarcode = document.querySelector<HTMLInputElement>('input[data-scan-target="product-barcode"]');
  if (productBarcode) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(productBarcode, code);
    productBarcode.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (phoneScanInjectEnabled()) {
    const form = document.querySelector<HTMLFormElement>("form.pos-search");
    // صندوقِ «نصب‌مانده» در DOM مخفی می‌ماند وقتی کاربر روی صفحهٔ دیگری
    // است؛ تزریق به جعبهٔ جست‌وجوی پنهان یعنی افزودنِ بی‌سروصدا به سبد —
    // فقط وقتی صندوق واقعاً دیدنی است تزریق می‌کنیم.
    if (form && !form.closest("[hidden]")) {
      const input = form.querySelector<HTMLInputElement>("input");
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, code);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        window.setTimeout(() => form.requestSubmit(), 60);
        return;
      }
    }
  }
  // صفحهٔ صندوق باز نیست (یا تزریق خاموش است) → فقط اطلاع می‌دهیم
  window.dispatchEvent(new CustomEvent("darpos:phone-scan-notify", { detail: { code } }));
}

export function PhoneScanListener({ active }: { active: boolean }): null {
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const wait = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });
    const poll = async (): Promise<void> => {
      // فقط اسکن‌های بعد از باز شدن برنامه — گذشتهٔ بافر دوباره پخش نشود
      let after = Date.now();
      while (!stopped) {
        try {
          const token = localStorage.getItem("darpos-token");
          const response = await fetch(`${apiBase()}/phone-scan/pull?after=${after}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
          // 401/404/402: بدون ورود، سرور قدیمی (بدون این مسیر) یا بدون لایسنس —
          // بی‌سروصدا و کم‌تر تکرار می‌کنیم تا خواستهٔ جانبی برنامه پیش نرود
          if (response.status === 401 || response.status === 402 || response.status === 404) { await wait(3000); continue; }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json() as { scans: Array<{ code: string; at: number }>; now: number };
          after = data.now;
          for (const entry of data.scans) deliverScan(entry.code);
        } catch { /* سرور موقتاً در دسترس نیست؛ چرخه ادامه می‌یابد */ }
        await wait(700);
      }
    };
    void poll();
    return () => { stopped = true; };
  }, [active]);
  return null;
}

interface PhoneScanStatusInfo {
  running: boolean;
  tls: boolean;
  port: number | null;
  /** پورت همدم HTTP ساده — همیشه بدون هشدار گواهی باز می‌شود. */
  httpPort?: number | null;
  lan: string[];
  urls: string[];
  reason?: string;
  phone?: { lastSeen: number | null; requests: number; lastRequestAt: number | null; pairedAt: number | null };
}

export function PhoneScanPanel() {
  const [status, setStatus] = useState<PhoneScanStatusInfo | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pin, setPin] = useState("");
  const [inject, setInject] = useState<boolean>(phoneScanInjectEnabled);
  const [codes, setCodes] = useState<Array<{ code: string; at: number }>>([]);
  const [copied, setCopied] = useState("");

  // وضعیت پل و PIN تازه بمانند (PIN با هر ری‌استارت سرور عوض می‌شود)
  useEffect(() => {
    let stopped = false;
    const load = async (): Promise<void> => {
      try {
        const info = await get<PhoneScanStatusInfo>("/phone-scan/status");
        if (stopped) return;
        setStatus(info);
        setUnreachable(false);
        if (info.running) {
          const pinData = await get<{ pin: string }>("/phone-scan/pin");
          if (!stopped) setPin(pinData.pin);
        } else {
          setPin("");
        }
      } catch {
        // مسیر /phone-scan/status در سرور نیست یا سرور در دسترس نیست —
        // معمولاً یعنی یک نمونهٔ قدیمی از سرور در پس‌زمینه در حال اجراست.
        if (!stopped) { setStatus(null); setPin(""); setUnreachable(true); }
      } finally {
        if (!stopped) setLoaded(true);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  // فید آخرین کدهای فرستاده‌شده از گوشی
  useEffect(() => {
    let stopped = false;
    let after = Date.now();
    const poll = async (): Promise<void> => {
      try {
        const data = await get<{ scans: Array<{ code: string; at: number }>; now: number }>(`/phone-scan/pull?after=${after}`);
        if (stopped) return;
        after = data.now;
        if (data.scans.length) setCodes((previous) => [...data.scans.slice().reverse(), ...previous].slice(0, 8));
      } catch { /* پنل نمایشی است؛ خطا بی‌صدا می‌ماند */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setCopied(text); window.setTimeout(() => setCopied(""), 1500); } catch { /* کلیپ‌بورد در دسترس نیست */ }
  };

  // نشانیِ داخل QR: ترجیحاً نشانی سادهٔ HTTP (همیشه بدون هشدار گواهی باز
  // می‌شود و اسکن عکس همان‌جا کار می‌کند)؛ PIN هم در انتهای نشانی می‌آید تا
  // گوشی بدون تایپ، خودکار جفت شود. اگر همدم ساده نبود، همان نشانی امن.
  const qrPort = status?.httpPort ?? status?.port ?? null;
  const qrScheme = status?.httpPort || status?.tls === false ? "http" : "https";
  const phoneUrl = status && status.running && status.lan.length && qrPort
    ? `${qrScheme}://${status.lan[0]}:${qrPort}/${pin ? `#${pin}` : ""}`
    : null;
  const allUrls = status && status.running ? status.urls : [];

  // خودتشخیص زندهٔ اتصال گوشی — دقیقاً می‌گوید کاربر کجای راه گیر کرده است
  const seen = Boolean(status?.phone?.lastSeen);
  const opened = Boolean((status?.phone?.requests ?? 0) > 0);
  const paired = Boolean(status?.phone?.pairedAt);

  return <div className="phone-scan-panel">
    <div className="phone-scan-head">
      <Smartphone size={19}/>
      <div className="grow">
        <b>{t("اسکن با دوربین گوشی")}</b>
        <small>{t("گوشی و کامپیوتر باید در یک WiFi باشند؛ بارکد زیر را با دوربین گوشی اسکن کنید تا بدون تایپ، خودکار وصل شود.")}</small>
      </div>
      {status && <span className={`phone-scan-badge ${status.running ? "ok" : ""}`}>{status.running ? t("فعال") : t("غیرفعال")}</span>}
    </div>

    {!loaded && <div className="hint-box phone-scan-warn"><CircleAlert size={17}/>{t("در حال بررسی وضعیت پل گوشی…")}</div>}

    {loaded && unreachable && <div className="error-box phone-scan-warn">
      <CircleAlert size={17}/>
      <div>
        <b>{t("بخش اسکن گوشی در این نسخهٔ سرور موجود نیست — یا برنامهٔ در حال اجرا قدیمی است یا یک نمونهٔ قدیمی سرور در پس‌زمینه مانده است.")}</b>
        <div className="phone-scan-steps" style={{ marginTop: 6 }}>
          <small>۱. {t("برنامه را کاملاً ببندید؛ در Task Manager هر پروسهٔ node.exe باقی‌مانده را پایان دهید و برنامه را دوباره باز کنید.")}</small>
          <small>۲. {t("اگر به‌تازگی کد جدید گرفته‌اید، یک بار برنامه را دوباره بسازید تا این بخش اضافه شود.")}</small>
        </div>
      </div>
    </div>}

    {loaded && !unreachable && status && !status.running && <div className="error-box phone-scan-warn">
      <CircleAlert size={17}/>
      <div>
        <b>{t("پل گوشی روشن نشده؛ خودکار دوباره تلاش می‌شود.")}</b>
        {status.reason && status.reason !== "not-started" && <small>{t("گزارش سرور: {reason}", { reason: status.reason })}</small>}
        <small>{t("برنامه را کاملاً ببندید؛ در Task Manager هر پروسهٔ node.exe باقی‌مانده را پایان دهید و برنامه را دوباره باز کنید.")}</small>
      </div>
    </div>}

    {status && status.running && <>
      <div className="phone-scan-grid">
        <div className="phone-scan-pin">
          <span>{t("کد PIN")}</span>
          <b dir="ltr">{pin || "…"}</b>
          <small>{t("در صفحهٔ گوشی وارد کنید.")}</small>
        </div>
        {phoneUrl
          ? <div className="phone-scan-qr" title={t("بارکد را با دوربین گوشی بخوانید")}>
              <QrCanvas text={phoneUrl} target={200}/>
              <small dir="ltr">{phoneUrl}</small>
            </div>
          : <div className="hint-box phone-scan-warn"><CircleAlert size={17}/>{t("این دستگاه به شبکهٔ محلی وصل نیست؛ برای اتصال گوشی، به WiFi همان شبکه بپیوندید.")}</div>}
      </div>

      {status.phone && !paired && !seen && <div className="error-box phone-scan-warn">
        <CircleAlert size={17}/>
        <div>
          <b>{t("هنوز هیچ گوشی‌ای به سرور نرسیده است.")}</b>
          <small>{t("بارکد را با گوشی اسکن کنید یا نشانی را در مرورگر گوشی باز کنید. اگر باز نشد: هر دو دستگاه باید در یک WiFi باشند و فایروال ویندوز باید اجازهٔ دسترسی Node.js را بدهد (Windows Security ← Firewall ← Allow an app to pass through Firewall).")}</small>
        </div>
      </div>}

      {status.phone && !paired && seen && !opened && <div className="hint-box phone-scan-warn">
        <CircleAlert size={17}/>
        <small>{t("گوشی به سرور رسیده ولی صفحه باز نشده — نشانی ساده (http) همیشه بدون هشدار باز می‌شود؛ اگر نشانی امن (https) را باز کرده‌اید، یک‌بار گواهی برنامه را طبق راهنمای همان صفحه در گوشی نصب کنید تا بدون هشدار باز شود.")}</small>
      </div>}

      {status.phone && !paired && opened && <div className="hint-box phone-scan-warn">
        <CircleAlert size={17}/>
        <small>{t("صفحهٔ گوشی باز شده؛ فقط کد PIN را در گوشی وارد کنید یا همین بارکد را با گوشی اسکن کنید تا خودکار وارد شود.")}</small>
      </div>}

      {status.phone && paired && <div className="hint-box phone-scan-ok">
        <CircleCheck size={17}/>
        <small>{t("گوشی جفت شده است — کد اسکن‌شده همان لحظه به صندوق می‌رسد.")}</small>
      </div>}

      <div className="phone-scan-urls">
        {allUrls.map((url) => <button type="button" key={url} className="text-button" dir="ltr" onClick={() => { void copy(url); }}>
          <Copy size={14}/>{url}{copied === url ? ` · ${t("کپی شد")}` : ""}
        </button>)}
      </div>

      <label className="check-line">
        <input type="checkbox" checked={inject} onChange={(e) => { setInject(e.target.checked); try { localStorage.setItem(INJECT_KEY, e.target.checked ? "1" : "0"); } catch { /* ذخیره نشد؛ حالت پیش‌فرض روشن می‌ماند */ } }}/>
        {t("افزودن خودکار کالای اسکن‌شده به فاکتور صندوق")}
      </label>

      <div className="phone-scan-steps">
        <span>{t("راهنمای اتصال:")}</span>
        <small>۱. {t("بارکد را با دوربین گوشی اسکن کنید — صفحهٔ اسکن خودکار باز و جفت می‌شود و «اسکن با عکس» همان‌جا کار می‌کند.")}</small>
        {status.tls && <small>۲. {t("اسکن با عکس بدون هیچ تنظیمی کار می‌کند. برای اسکن زنده، در همان صفحهٔ گوشی «دانلود گواهی امنیتی» را یک‌بار بزنید و فایل را در تنظیمات گوشی نصب کنید (مثل نصب یک اپ کوچک) — بعد از آن اسکن زنده بدون هیچ هشدار امنیتی باز می‌شود.")}</small>}
        <small>{status.tls ? "۳." : "۲."} {t("در ویندوز اگر هشدار فایروال ظاهر شد، اجازهٔ دسترسی Node.js در «شبکه‌های خصوصی» را بدهید.")}</small>
      </div>

      <div className="phone-scan-last">
        <span>{t("آخرین کدهای فرستاده‌شده از گوشی")}</span>
        {codes.length
          ? <div className="phone-scan-codes">{codes.map((entry) => <div key={`${entry.at}-${entry.code}`}><code dir="ltr">{entry.code}</code><small>{dateTime(new Date(entry.at).toISOString())}</small></div>)}</div>
          : <small className="muted">{t("کدی هنوز از گوشی فرستاده نشده است.")}</small>}
      </div>
    </>}

    {/* نشانگر نسخه — اگر این خط را نمی‌بینید یعنی برنامهٔ در حال اجرا قدیمی
        است و کد QR جدید (رندر canvas) داخلش نیست؛ دوباره build بگیرید. */}
    <div className="phone-scan-version"><small className="muted">{t("نسخهٔ پل گوشی: {v}", { v: PHONE_SCAN_PANEL_VERSION })}</small></div>
  </div>;
}
