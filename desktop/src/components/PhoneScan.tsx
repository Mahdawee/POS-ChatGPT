import { useEffect, useState } from "react";
import { Copy, Smartphone, CircleAlert } from "lucide-react";
import { t, dateTime } from "../i18n";
import { apiBase, get } from "../lib/api";
import { qrSvg } from "../lib/qr";

/**
 * ── پل موقت اسکن با دوربین گوشی (دور ۵۳) ──────────────────────────────────
 * دو قطعهٔ کاملاً جدا از بارکدخوان‌های USB:
 *
 *  PhoneScanListener — در App رندر می‌شود (خروجی ندارد) و هر ~۰٫۷ ثانیه
 *    /phone-scan/pull را می‌خواند؛ هر کد تازه یا داخل فرم جست‌وجوی صفحهٔ
 *    صندوق تزریق می‌شود (دقیقاً مثل تایپ بارکدخوان سخت‌افزاری، بدون هیچ
 *    تغییری در منطق scan) یا — اگر صندوق باز نیست — به‌صورت پیام نشان
 *    داده می‌شود.
 *
 *  PhoneScanPanel — بخش «اسکن با گوشی» در تنظیمات ← بارکدخوان: وضعیت پل،
 *    PIN جفت‌کردن، نشانی‌های گوشی با QR و راهنمای اتصال.
 */

/** کلید localStorage برای روشن/خاموش‌کردن تزریق خودکار به فاکتور. */
const INJECT_KEY = "darpos:phone-scan-inject";

function phoneScanInjectEnabled(): boolean {
  try { return localStorage.getItem(INJECT_KEY) !== "0"; } catch { return true; }
}

/** رهاسازی یک بارکد در برنامه — مسیر دقیقاً همان بارکدخوان سخت‌افزاری است:
 *  مقدار در input جست‌وجوی صندوق نوشته و فرم submit می‌شود تا scan() خودِ
 *  برنامه (بارکد ترازو، تطبیق دقیق، بوق، افزودن) بدون هیچ تغییری اجرا شود. */
function deliverScan(code: string): void {
  if (phoneScanInjectEnabled()) {
    const form = document.querySelector<HTMLFormElement>("form.pos-search");
    const input = form?.querySelector<HTMLInputElement>("input");
    if (form && input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      window.setTimeout(() => form.requestSubmit(), 60);
      return;
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
  lan: string[];
  urls: string[];
  reason?: string;
}

const qrDataUri = (text: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(text))}`;

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

  // نشانی گوشی از وضعیت واقعی پل ساخته می‌شود (https یا http در حالت fallback)
  const scheme = status?.tls === false ? "http" : "https";
  const phoneUrl = status && status.running ? (status.lan.length ? `${scheme}://${status.lan[0]}:${status.port}` : null) : null;
  const allUrls = status && status.running ? status.urls : [];

  return <div className="phone-scan-panel">
    <div className="phone-scan-head">
      <Smartphone size={19}/>
      <div className="grow">
        <b>{t("اسکن موقت با دوربین گوشی")}</b>
        <small>{t("گوشی و کامپیوتر باید در یک WiFi باشند؛ نشانی زیر را در مرورگر گوشی باز کنید و با کد PIN جفت کنید.")}</small>
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
              <img src={qrDataUri(phoneUrl)} alt="QR" width={118} height={118}/>
              <small dir="ltr">{phoneUrl}</small>
            </div>
          : <div className="hint-box phone-scan-warn"><CircleAlert size={17}/>{t("این دستگاه به شبکهٔ محلی وصل نیست؛ برای اتصال گوشی، به WiFi همان شبکه بپیوندید.")}</div>}
      </div>

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
        <small>۱. {t("در ویندوز اگر هشدار فایروال ظاهر شد، اجازهٔ دسترسی Node.js در «شبکه‌های خصوصی» را بدهید.")}</small>
        {status.tls && <small>۲. {t("مرورگر گوشی هشدار امنیتی نشان می‌دهد؛ «پیشرفته» و سپس «ادامه به نشانی» را بزنید. فقط یک‌بار لازم است.")}</small>}
        <small>{status.tls ? "۳." : "۲."} {t("اگر دوربین زنده باز نشد، در همان صفحه از حالت «اسکن با عکس» استفاده کنید که روی هر گوشی کار می‌کند.")}</small>
      </div>

      <div className="phone-scan-last">
        <span>{t("آخرین کدهای فرستاده‌شده از گوشی")}</span>
        {codes.length
          ? <div className="phone-scan-codes">{codes.map((entry) => <div key={`${entry.at}-${entry.code}`}><code dir="ltr">{entry.code}</code><small>{dateTime(new Date(entry.at).toISOString())}</small></div>)}</div>
          : <small className="muted">{t("کدی هنوز از گوشی فرستاده نشده است.")}</small>}
      </div>
    </>}
  </div>;
}
