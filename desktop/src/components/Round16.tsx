import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CalendarClock, ClipboardList, Copy, Check, Mail, MessageCircle, PackageCheck, RefreshCw, Send, Smartphone, Trash2, X } from "lucide-react";
import { get, post, type Contact, type CustomerOrder, type InstallmentPlan, type LicenseStatus, type Product, type ReceiptText, type ReorderRow, type Sale, type SerialUnit } from "../lib/api";
import { dateOnly, dateTime, licensePlanLabel, money, qty, qtyPlain, t } from "../i18n";
import { useBrand } from "../lib/brand";
import { DateField } from "./DatePicker";
import { Modal } from "./Pages";
import { ExportMenu } from "./ExportMenu";
import { exportCsv as exportCsvFile, exportTablePdf } from "../lib/export";
import { SectionHead } from "./SectionHead";

export type Notify = (text: string, kind?: "success" | "error") => void;

const numberValue = (event: { target: { value: string } }): number => Number(event.target.value) || 0;

/** علائم وضعیت لایسنس به فارسی. */
function licenseReasonText(status: LicenseStatus): string {
  switch (status.reason) {
    case "TRIAL_NOT_STARTED": return t("برای استفاده، لایسنس فعال کنید یا دورهٔ آزمایشی ۱۴ روزه را از همین صفحه شروع کنید.");
    case "TRIAL_EXPIRED": return t("دورهٔ آزمایشی ۱۴ روزه به پایان رسیده است. برای ادامهٔ کار، لایسنس فعال کنید.");
    case "LICENSE_EXPIRED": return t("مدت لایسنس به پایان رسیده است. برای ادامه، لایسنس جدید فعال کنید.");
    case "TAMPERED": return t("تاریخ سیستم دستکاری شده است. ساعت دستگاه را درست کنید و لایسنس معتبر فعال کنید.");
    case "MACHINE_MISMATCH": return t("این لایسنس برای دستگاه دیگری صادر شده است.");
    default: return t("برای ادامهٔ کار، لایسنس فعال کنید.");
  }
}

/**
 * صفحهٔ لایسنس — قبل از ورود نشان داده می‌شود: وضعیت (آزمایشی/لایسنس‌دار)،
 * کلید دستگاه برای ارسال به فروشنده، و محل چسباندن بلوک لایسنس.
 */
export function LicenseScreen({ onActivated }: { onActivated: () => void }) {
  return <div className="license-screen"><LicenseCard onActivated={onActivated}/></div>;
}

/**
 * کارت فعال‌سازی لایسنس — هم در صفحهٔ لایسنس (قبل از ورود) و هم داخل برنامه
 * (از بنر «نسخهٔ آزمایشی») نشان داده می‌شود: کلید دستگاه آمادهٔ کپی برای
 * فرستادن به فروشنده، و جای چسباندن بلوک لایسنس خریداری‌شده.
 */
export function LicenseCard({ onActivated }: { onActivated: () => void }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [licenseText, setLicenseText] = useState("");
  const [busy, setBusy] = useState(false);
  const [startingTrial, setStartingTrial] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const brand = useBrand();
  useEffect(() => { get<LicenseStatus>("/license/status").then(setStatus).catch((e) => setError(e.message)); }, []);
  const activate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await post("/license/activate", { licenseText });
      onActivated();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const startTrial = async () => {
    setStartingTrial(true); setError("");
    try {
      await post("/license/trial-start", {});
      onActivated();
    } catch (e) { setError((e as Error).message); } finally { setStartingTrial(false); }
  };
  const copyKey = async () => {
    try { await navigator.clipboard.writeText(status?.machineKey || ""); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ }
  };
  const trialNotStarted = status != null && !status.ok && status.reason === "TRIAL_NOT_STARTED";
  return <form className="license-card" onSubmit={activate}>
      <div className="license-logo">{brand.appName.trim().slice(0, 2)}</div>
      <h1>{brand.appName} <small>{t("فروش و مدیریت فروشگاه")}</small></h1>
      {status?.ok && status.mode === "TRIAL" && <div className="hint-box">{t("شما در دورهٔ آزمایشی هستید — {days} روز باقی مانده.", { days: String(status.trialDaysLeft ?? 0) })}</div>}
      {status && !status.ok && <div className="error-box"><AlertTriangle size={16}/>{licenseReasonText(status)}</div>}
      {status?.mode === "LICENSED" && status.ok && <div className="hint-box green">{t("لایسنس فعال است — {plan} · {days} روز باقی مانده", { plan: String(status.plan), days: status.daysLeft == null ? t("ابدی") : String(status.daysLeft) })}</div>}
      <div className="machine-key">
        <span>{t("کلید دستگاه (برای خرید لایسنس، این کد را برای فروشنده بفرستید)")}</span>
        <div><b dir="ltr">{status?.machineKey || "…"}</b><button type="button" className="text-button" onClick={() => void copyKey()}>{copied ? <Check size={15}/> : <Copy size={15}/>}{copied ? t("کپی شد") : t("کپی")}</button></div>
      </div>
      <label className="field full"><span>{t("بلوک لایسنس را اینجا بچسبانید")}</span>
        <textarea rows={6} dir="ltr" value={licenseText} onChange={(e) => setLicenseText(e.target.value)} placeholder={"-----DARPOS LICENSE-----\n…\n-----END DARPOS LICENSE-----"} required />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}><RefreshCw size={16}/>{t("بررسی دوباره")}</button>
        {trialNotStarted && <button type="button" className="primary-button" disabled={startingTrial} onClick={() => void startTrial()}><CalendarClock size={16}/>{startingTrial ? t("در حال شروع…") : t("شروع دورهٔ آزمایشی ۱۴ روزه")}</button>}
        <button className="primary-button" disabled={busy || licenseText.trim().length < 30}><Send size={16}/>{busy ? t("در حال فعال‌سازی…") : t("فعال‌سازی لایسنس")}</button>
      </div>
      <p className="muted small">{t("پرداخت هزینهٔ لایسنس به فروشنده؛ بعد از دریافت بلوک لایسنس، آن را همین‌جا بچسبانید. لایسنس فقط روی همین دستگاه کار می‌کند.")}</p>
    </form>;
}

/**
 * پنجرهٔ فعال‌سازی داخل برنامه — از بنر «نسخهٔ آزمایشی» بالای صفحه باز
 * می‌شود؛ مشتری کلید دستگاه را کپی می‌کند، برای فروشنده می‌فرستد و پس از
 * خرید، بلوک لایسنس را همین‌جا می‌چسباند. با فعال‌سازی، بنر برای همیشه
 * (تا پایان اعتبار لایسنس) ناپدید می‌شود.
 */
export function ActivationModal({ onClose, onActivated, notify }: { onClose: () => void; onActivated: () => void; notify: Notify }) {
  return <Modal title={t("فعال‌سازی لایسنس")} onClose={onClose} wide>
    <LicenseCard onActivated={() => { onActivated(); notify(t("لایسنس فعال شد؛ از خرید شما سپاس‌گزاریم!")); }}/>
  </Modal>;
}

/**
 * تب «لایسنس» در تنظیمات — وضعیت کامل لایسنس همین دستگاه: نوع پلن، مشتری،
 * تاریخ انقضا و روزهای باقی‌مانده، کلید دستگاه و دکمه‌های فعال‌سازی/تمدید
 * و لغو. صندوقدار قبل از همه در بنر بالای برنامه از نزدیک‌شدن انقضا خبر
 * دار می‌شود؛ این صفحه جزئیات کامل را نشان می‌دهد.
 */
export function LicensePanel({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActivate, setShowActivate] = useState(false);
  const [error, setError] = useState("");
  const load = () => get<LicenseStatus>("/license/status").then(setStatus).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const deactivate = async () => {
    if (!window.confirm(t("لایسنس لغو شود؟ برنامه قفل می‌شود تا لایسنس تازه فعال کنید یا (اگر مانده باشد) دورهٔ آزمایشی را شروع کنید."))) return;
    setBusy(true);
    try { await post("/license/deactivate", {}); notify(t("لایسنس لغو شد.")); await load(); }
    catch (e) { notify((e as Error).message, "error"); } finally { setBusy(false); }
  };
  const trial = status?.mode === "TRIAL";
  const days = trial ? (status?.trialDaysLeft ?? 0) : status?.daysLeft;
  const trialUsed = trial ? Math.max(0, Math.min(100, Math.round(((14 - (status?.trialDaysLeft ?? 0)) / 14) * 100))) : 0;
  return <div className="settings-grid">
    <div className="page-stack">
      <section className="surface">
        <SectionHead title={t("وضعیت لایسنس")} subtitle={t("نوع لایسنس، اعتبار و روزهای باقی‌ماندهٔ همین دستگاه")} action={<button className="secondary-button" onClick={() => void load()} disabled={busy}><RefreshCw size={16}/>{t("بررسی دوباره")}</button>}/>
        {error && <div className="error-box"><AlertTriangle size={16}/>{error}</div>}
        {status && <>
          <div className={`license-status-card ${status.ok ? "ok" : "bad"}`}>
            <div className="license-status-icon">{status.ok ? <PackageCheck size={22}/> : <AlertTriangle size={22}/>}</div>
            <div className="grow">
              <b>{status.ok ? (trial ? t("دورهٔ آزمایشی فعال است") : t("لایسنس فعال است")) : licenseReasonText(status)}</b>
              <span>{trial
                ? t("شما در دورهٔ آزمایشی ۱۴ روزه هستید؛ پس از آن برای ادامهٔ کار لایسنس لازم است.")
                : status.ok
                  ? t("پلن {plan} برای «{customer}» فعال است.", { plan: licensePlanLabel(status.plan), customer: status.customer || t("مشتری") })
                  : t("برای بازگشایی برنامه، لایسنس معتبر همین دستگاه را فعال کنید.")}</span>
            </div>
            {!trial && status.plan && <span className="status-pill paid">{licensePlanLabel(status.plan)}</span>}
          </div>
          <div className="info-row"><span>{t("نوع استفاده")}</span><b>{trial ? t("دورهٔ آزمایشی (۱۴ روزه)") : t("لایسنس")}</b></div>
          {!trial && status.customer && <div className="info-row"><span>{t("نام مشتری")}</span><b>{status.customer}</b></div>}
          {!trial && status.licenseId && <div className="info-row"><span>{t("شناسهٔ لایسنس")}</span><b dir="ltr" className="mono">{status.licenseId.slice(0, 8)}…</b></div>}
          {trial && status.trialStartedAt && <div className="info-row"><span>{t("شروع دورهٔ آزمایشی")}</span><b>{dateOnly(status.trialStartedAt)}</b></div>}
          <div className="info-row"><span>{t("اعتبار تا")}</span><b>{trial ? t("{days} روز بعد", { days: String(days ?? 0) }) : status.expiresAt ? dateOnly(status.expiresAt) : t("ابدی (بدون انقضا)")}</b></div>
          {days != null && <div className="info-row"><span>{t("روزهای باقی‌مانده")}</span><b className={days <= 7 ? "stock-low" : ""}>{t("{days} روز", { days: String(days) })}</b></div>}
          {trial && <div className="license-progress" title={t("مصرف‌شدهٔ دورهٔ آزمایشی")}><span style={{ width: `${trialUsed}%` }}/></div>}
          <div className="info-row"><span>{t("کلید دستگاه")}</span><div className="row-actions"><b dir="ltr" className="mono">{status.machineKey}</b><button className="text-button" onClick={() => { void navigator.clipboard.writeText(status.machineKey).then(() => notify(t("کلید دستگاه کپی شد."))); }}><ClipboardList size={14}/>{t("کپی")}</button></div></div>
          <div className="form-actions">
            <button className="primary-button" onClick={() => setShowActivate(true)}><Send size={16}/>{trial || !status.ok ? t("فعال‌سازی لایسنس") : t("تمدید لایسنس")}</button>
            {!trial && status.ok && <button className="danger-button" onClick={() => void deactivate()} disabled={busy}>{t("لغو لایسنس")}</button>}
          </div>
        </>}
        {!status && !error && <div className="loading"><RefreshCw className="spin" size={18}/>{t("در حال خواندن وضعیت…")}</div>}
      </section>
      <section className="surface">
        <SectionHead title={t("راهنمای لایسنس")} subtitle={t("چطور تمدید کنیم؟")}/>
        <div className="hint-box">{t("لایسنس فقط روی همین دستگاه کار می‌کند و تاریخ سیستم را نمی‌توان برای طولانی‌کردن آن عقب برد. برای تمدید: کلید دستگاه را بالا کپی و برای فروشنده بفرستید؛ پس از پرداخت، بلوک لایسنس تازه را در همین صفحه بچسبانید. لایسنس تازه بلافاصله فعال می‌شود و روزهای باقی‌ماندهٔ لایسنس قبلی از دست می‌رود، پس بهتر است نزدیک انقضا تمدید کنید.")}</div>
      </section>
    </div>
    <div className="page-stack">
      <section className="surface local-info">
        <div className="offline large-offline"><span/><div><b>{t("محافظت از برنامه")}</b><small>{t("امضای دیجیتال + قفل به دستگاه")}</small></div></div>
        <div className="info-row"><span>{t("امضا")}</span><b>{t("Ed25519")}</b></div>
        <div className="info-row"><span>{t("قفل دستگاه")}</span><b>{t("فعال")}</b></div>
        <div className="info-row"><span>{t("ضد جابه‌جایی ساعت")}</span><b>{t("فعال (۲۴ ساعت تلورانس)")}</b></div>
        <div className="info-row"><span>{t("سنجهٔ زمان")}</span><b title={t("بزرگ‌ترین تاریخی که برنامه دیده است")}>{status ? dateOnly(status.effectiveNow) : "—"}</b></div>
      </section>
    </div>
    {showActivate && <Modal title={trial || !status?.ok ? t("فعال‌سازی لایسنس") : t("تمدید لایسنس")} onClose={() => setShowActivate(false)} wide>
      <LicenseCard onActivated={() => { setShowActivate(false); notify(t("لایسنس فعال شد؛ از خرید شما سپاس‌گزاریم!")); void load(); }}/>
    </Modal>}
  </div>;
}

/** سفارش/رزرو مشتری — فهرست، ثبت، تحویل و لغو. */
export function OrdersPage({ notify }: { notify: Notify }) {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [status, setStatus] = useState<"OPEN" | "FULFILLED" | "CANCELLED">("OPEN");
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [form, setForm] = useState<{ customerId: string; note: string; lines: Array<{ productId: string; quantity: number }> }>({ customerId: "", note: "", lines: [{ productId: "", quantity: 1 }] });
  const [delivering, setDelivering] = useState<CustomerOrder | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, { quantity: number; serials: string }>>({});
  const [payment, setPayment] = useState<"CASH" | "CREDIT" | "MOBILE" | "WALLET">("CASH");
  const [busy, setBusy] = useState(false);
  const load = (skip = 0) => get<CustomerOrder[]>(`/orders?status=${status}&skip=${skip}&take=100`).then((rows) => setOrders((current) => skip === 0 ? rows : [...current, ...rows])).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, [status]);
  useEffect(() => { get<Product[]>("/products").then(setProducts).catch(() => undefined); get<Contact[]>("/customers").then(setCustomers).catch(() => undefined); }, []);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const createOrder = async (event: FormEvent) => {
    event.preventDefault();
    const items = form.lines.filter((line) => line.productId && line.quantity > 0);
    if (!items.length) { setError(t("حداقل یک قلم کالا لازم است.")); return; }
    setBusy(true);
    try {
      await post("/orders", { items, customerId: form.customerId || undefined, note: form.note || undefined });
      setShow(false); setForm({ customerId: "", note: "", lines: [{ productId: "", quantity: 1 }] }); notify(t("سفارش ثبت و موجودی رزرو شد.")); void load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const openDeliver = (order: CustomerOrder) => {
    setDelivering(order);
    setDeliveries(Object.fromEntries(order.lines.map((line) => [line.id, { quantity: line.quantity - line.deliveredQty, serials: "" }])));
    setPayment("CASH");
  };
  const deliver = async (event: FormEvent) => {
    event.preventDefault();
    if (!delivering) return;
    setBusy(true);
    try {
      const payload = Object.entries(deliveries)
        .filter(([, value]) => value.quantity > 0)
        .map(([lineId, value]) => ({ lineId, quantity: value.quantity, serials: value.serials.trim() ? value.serials.split(/[\n,،\s]+/).filter(Boolean) : undefined }));
      if (!payload.length) throw new Error(t("مقدار تحویل را مشخص کنید."));
      await post(`/orders/${delivering.id}/deliver`, { deliveries: payload, paymentMethod: payment });
      setDelivering(null); notify(t("تحویل ثبت شد و فاکتور صادر شد.")); void load();
    } catch (e) { notify((e as Error).message, "error"); } finally { setBusy(false); }
  };
  const cancel = async (order: CustomerOrder) => {
    if (!window.confirm(t("این سفارش لغو شود؟ موجودی رزروشده آزاد می‌شود."))) return;
    try { await post(`/orders/${order.id}/cancel`, {}); notify(t("سفارش لغو شد.")); void load(); } catch (e) { notify((e as Error).message, "error"); }
  };
  const remaining = (order: CustomerOrder) => Math.round(order.lines.reduce((sum, line) => sum + line.quantity - line.deliveredQty, 0) * 1000) / 1000;
  // Exports the orders currently listed for the picked status.
  const exportOrders = (kindOfExport: "csv" | "pdf") => {
    const header = [t("شماره سفارش"), t("مشتری"), t("تعداد اقلام"), t("مانده تحویل"), t("یادداشت"), t("زمان ثبت")];
    const rows: Array<Array<string | number>> = orders.map((order) => [
      order.orderNo,
      order.customer?.name || t("بدون مشتری"),
      qtyPlain(order.lines.reduce((count, line) => count + line.quantity, 0)),
      qtyPlain(Math.max(0, order.lines.reduce((remaining, line) => remaining + Math.max(0, line.quantity - line.deliveredQty), 0))),
      order.note || "",
      dateTime(order.createdAt),
    ]);
    if (kindOfExport === "csv") { void exportCsvFile("customer-orders.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("سفارش‌های مشتری"), subtitle: `${status === "OPEN" ? t("باز") : status === "FULFILLED" ? t("تحویل‌شده") : t("لغو‌شده")} · ${orders.length} ${t("سفارش")}`, columns: [{ label: t("شماره سفارش"), numeric: true }, { label: t("مشتری") }, { label: t("تعداد اقلام"), numeric: true }, { label: t("مانده تحویل"), numeric: true }, { label: t("یادداشت") }, { label: t("زمان ثبت") }], rows });
  };
  return <div className="page-stack">
    <section className="surface">
      <div className="toolbar">
        <div className="search-box"><ClipboardList size={17}/><span>{t("سفارش‌های مشتری (رزرو موجودی)")}</span></div>
        {(["OPEN", "FULFILLED", "CANCELLED"] as const).map((value) => <button key={value} className={`chip ${status === value ? "active" : ""}`} onClick={() => setStatus(value)}>{value === "OPEN" ? t("باز") : value === "FULFILLED" ? t("تحویل‌شده") : t("لغو‌شده")}</button>)}
        <ExportMenu onExport={exportOrders} disabled={!orders.length}/>
        <span className="toolbar-count">{orders.length} {t("سفارش")}</span>
        <button className="primary-button" onClick={() => setShow(true)}><ClipboardList size={17}/>{t("سفارش جدید")}</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>{t("شماره")}</th><th>{t("شماره سفارش")}</th><th>{t("مشتری")}</th><th>{t("اقلام")}</th><th>{t("مانده تحویل")}</th><th>{t("یادداشت")}</th><th>{t("زمان ثبت")}</th><th></th></tr></thead>
        <tbody>{orders.map((order, idx) => <tr key={order.id}><td className="muted mono">{idx + 1}</td>
          <td><b>{order.orderNo}</b></td>
          <td>{order.customer?.name || t("مشتری گذری")}</td>
          <td className="muted">{order.lines.map((line) => `${line.name} × ${qty(line.quantity)}`).join("، ")}</td>
          <td>{order.status === "OPEN" ? <b className={remaining(order) > 0 ? "danger-text" : "green-text"}>{qty(remaining(order))}</b> : "—"}</td>
          <td className="muted">{order.note || "—"}</td>
          <td className="muted">{dateTime(order.createdAt)}</td>
          <td>{order.status === "OPEN" && <div className="row-actions"><button className="text-button" onClick={() => openDeliver(order)}><PackageCheck size={14}/>{t("تحویل")}</button><button className="text-button danger-text" onClick={() => void cancel(order)}><X size={14}/>{t("لغو")}</button></div>}</td>
        </tr>)}</tbody>
      </table>{!orders.length && <div className="empty"><b>{t("سفارشی نیست")}</b><span>{t("سفارش‌های رزروشدهٔ مشتری‌ها در اینجا دیده می‌شوند.")}</span></div>}{orders.length >= 100 && <div className="load-more"><button className="secondary-button" onClick={() => void load(orders.length)}>{t("نمایش سفارش‌های بیشتر")}</button><small className="muted">{t("{count} سفارش بارگذاری شد", { count: String(orders.length) })}</small></div>}</div>
    </section>
    {show && <Modal title={t("ثبت سفارش مشتری")} onClose={() => setShow(false)} wide>
      <form className="form-grid" onSubmit={createOrder}>
        <label className="field"><span>{t("مشتری")}</span><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">{t("مشتری گذری")}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field full"><span>{t("یادداشت")}</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("اختیاری")}/></label>
        {form.lines.map((line, index) => <div className="bundle-row full" key={index}>
          <select value={line.productId} onChange={(e) => setForm({ ...form, lines: form.lines.map((row, i) => i === index ? { ...row, productId: e.target.value } : row) })}><option value="">{t("انتخاب کالا…")}</option>{products.filter((p) => !p.isBundle).map((p) => <option key={p.id} value={p.id}>{p.name} — {t("آزاد")}: {p.stock - (p.reserved || 0)}</option>)}</select>
          <input type="number" min={products.find((p) => p.id === line.productId)?.isWeighted ? 0.001 : 1} step={products.find((p) => p.id === line.productId)?.isWeighted ? 0.001 : 1} dir="ltr" value={line.quantity} onChange={(e) => setForm({ ...form, lines: form.lines.map((row, i) => i === index ? { ...row, quantity: numberValue(e) } : row) })}/>
          <button type="button" className="text-button danger-text" onClick={() => setForm({ ...form, lines: form.lines.length > 1 ? form.lines.filter((_, i) => i !== index) : form.lines })}><Trash2 size={15}/></button>
        </div>)}
        <div className="form-actions full">
          <button type="button" className="secondary-button" onClick={() => setForm({ ...form, lines: [...form.lines, { productId: "", quantity: 1 }] })}>{t("افزودن قلم")}</button>
          <button className="primary-button" disabled={busy}>{busy ? t("در حال ثبت…") : t("ثبت سفارش")}</button>
        </div>
        <div className="hint-box full">{t("موجودی سفارش‌شده «رزرو» می‌شود و فروش حضوری به آن دسترسی ندارد؛ قیمت نهایی هنگام تحویل و مطابق قیمت روز محاسبه می‌شود.")}</div>
      </form>
    </Modal>}
    {delivering && <Modal title={t("تحویل سفارش {no}", { no: delivering.orderNo })} onClose={() => setDelivering(null)} wide>
      <form className="form-grid" onSubmit={deliver}>
        {delivering.lines.map((line) => {
          const max = line.quantity - line.deliveredQty;
          const product = products.find((p) => p.id === line.productId);
          const value = deliveries[line.id] || { quantity: max, serials: "" };
          return <div className="order-deliver-line full" key={line.id}>
            <b>{line.name}</b>
            <span className="muted">{t("سفارش: {qty} · تحویل‌شده: {done}", { qty: String(line.quantity), done: String(line.deliveredQty) })}</span>
            <label className="compact-field"><span>{t("این بار تحویل")}</span><input type="number" min="0" max={max} step={product?.isWeighted ? 0.001 : 1} dir="ltr" value={value.quantity} onChange={(e) => setDeliveries({ ...deliveries, [line.id]: { ...value, quantity: Math.min(max, Math.max(0, numberValue(e))) } })}/></label>
            {product?.isSerialized && value.quantity > 0 && <label className="compact-field full"><span>{t("سریال/IMEI هر دستگاه (هر خط یک عدد)")}</span><textarea rows={Math.max(2, Math.ceil(value.quantity))} dir="ltr" value={value.serials} onChange={(e) => setDeliveries({ ...deliveries, [line.id]: { ...value, serials: e.target.value } })}/></label>}
          </div>;
        })}
        <label className="field"><span>{t("روش پرداخت")}</span><select value={payment} onChange={(e) => setPayment(e.target.value as typeof payment)}><option value="CASH">{t("نقدی")}</option><option value="MOBILE">{t("پرداخت موبایلی")}</option><option value="WALLET">{t("کیف پول")}</option><option value="CREDIT">{t("قرض / نسیه")}</option></select></label>
        <div className="form-actions full"><button type="button" className="secondary-button" onClick={() => setDelivering(null)}>{t("انصراف")}</button><button className="primary-button" disabled={busy}><Check size={16}/>{busy ? t("در حال ثبت…") : t("تحویل و صدور فاکتور")}</button></div>
      </form>
    </Modal>}
  </div>;
}

/** ارسال دیجیتال فاکتور: کپی متن، وایل، پیامک، ایمیل. */
export function ShareReceiptModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const [data, setData] = useState<ReceiptText | null>(null);
  const [phone, setPhone] = useState(sale.customer?.phone || "");
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { get<ReceiptText>(`/sales/${sale.id}/receipt`).then(setData).catch((e) => setError(e.message)); }, [sale.id]);
  const text = data?.text || "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2500); } catch { setError(t("کپی ممکن نشد؛ متن را دستی انتخاب و کپی کنید.")); }
  };
  const whatsapp = () => { window.open(`https://wa.me/${phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(text)}`, "_blank"); };
  const sms = () => { window.open(`sms:${phone.replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(text.slice(0, 400))}`, "_blank"); };
  const mail = () => { window.open(`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(t("فاکتور شمارهٔ {no}", { no: sale.invoiceNo || sale.receiptNo }))}&body=${encodeURIComponent(text)}`, "_blank"); };
  return <Modal title={t("ارسال فاکتور به مشتری")} onClose={onClose} wide>
    {error && <div className="error-box">{error}</div>}
    {data ? <>
      <pre className="receipt-text" dir="auto">{text}</pre>
      <div className="form-grid single">
        <label className="field"><span>{t("شماره تماس مشتری (برای وایل/پیامک)")}</span><input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xxxxxxxxx"/></label>
        <label className="field"><span>{t("نشانی ایمیل (اختیاری)")}</span><input dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)}/></label>
      </div>
      <div className="form-actions">
        <button className="secondary-button" onClick={() => void copy()}>{copied ? <Check size={16}/> : <Copy size={16}/>}{copied ? t("کپی شد") : t("کپی متن")}</button>
        <button className="secondary-button" onClick={whatsapp} disabled={!phone}><MessageCircle size={16}/>{t("ارسال با واتس‌اپ")}</button>
        <button className="secondary-button" onClick={sms} disabled={!phone}><Smartphone size={16}/>{t("ارسال با پیامک")}</button>
        <button className="secondary-button" onClick={mail}><Mail size={16}/>{t("ارسال با ایمیل")}</button>
      </div>
      <p className="muted small">{t("متن فاکتور ساده و سبک است تا در هر پیام‌رسانی خوانا بماند.")}</p>
    </> : <div className="loading"><RefreshCw size={16}/>{t("در حال آماده‌سازی متن فاکتور…")}</div>}
  </Modal>;
}

/** بخش اقساط مشتری — در حساب مشتری نشان داده می‌شود. */
export function InstallmentsPanel({ customerId, notify }: { customerId: string; notify: Notify }) {
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ total: 0, installmentCount: 3, intervalDays: 30, startDate: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => get<InstallmentPlan[]>(`/installments?customerId=${customerId}`).then(setPlans).catch(() => undefined);
  useEffect(() => { void load(); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await post("/installments", { customerId, total: form.total, installmentCount: form.installmentCount, intervalDays: form.intervalDays, startDate: form.startDate || undefined, note: form.note || undefined });
      setShow(false); setForm({ total: 0, installmentCount: 3, intervalDays: 30, startDate: "", note: "" }); notify(t("پلن قسط ثبت شد.")); void load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const pay = async (plan: InstallmentPlan, installmentId: string) => {
    const open = plan.installments.find((inst) => inst.id === installmentId);
    if (!open) return;
    if (!window.confirm(t("پرداخت قسط {seq} به مبلغ {amount} ثبت شود؟", { seq: String(open.seq), amount: money(open.amount - open.paidAmount) }))) return;
    try { await post(`/installments/${installmentId}/pay`, { amount: open.amount - open.paidAmount, fromCash: true }); notify(t("قسط پرداخت شد.")); void load(); } catch (e) { notify((e as Error).message, "error"); }
  };
  return <section className="surface" style={{ marginTop: "0.75rem" }}>
    <div className="toolbar"><CalendarClock size={17}/><b>{t("اقساط")}</b><div className="grow"/><button className="primary-button" onClick={() => setShow(true)}>{t("پلن قسط جدید")}</button></div>
    {plans.length ? <div className="table-wrap"><table>
      <thead><tr><th>{t("شماره")}</th><th>{t("مبلغ پلن")}</th><th>{t("پرداخت‌شده")}</th><th>{t("وضعیت")}</th><th>{t("اقساط")}</th></tr></thead>
      <tbody>{plans.map((plan, idx) => <tr key={plan.id}><td className="muted mono">{idx + 1}</td>
        <td><b>{money(plan.total)}</b>{plan.note && <small className="block muted">{plan.note}</small>}</td>
        <td>{money(plan.paidAmount)}</td>
        <td>{plan.status === "SETTLED" ? <b className="green-text">{t("تسویه")}</b> : plan.status === "VOID" ? <b className="muted" style={{ textDecoration: "line-through" }}>{t("ابطال‌شده")}</b> : <b className="amber-text">{t("باز")}</b>}</td>
        <td><div className="installment-chips">{plan.installments.map((inst) => {
          const overdue = !inst.paidAt && new Date(inst.dueDate) < new Date();
          return <button key={inst.id} className={`chip ${inst.paidAt ? "done" : overdue ? "overdue" : ""}`} title={`${t("سررسید")}: ${dateOnly(inst.dueDate)}`} onClick={() => !inst.paidAt && plan.status === "OPEN" && void pay(plan, inst.id)}>
            {inst.seq} · {money(inst.amount - inst.paidAmount)}{inst.paidAt ? " ✓" : overdue ? " !" : ""}
          </button>;
        })}</div></td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><b>{t("قسطی ثبت نشده")}</b><span>{t("برای این مشتری می‌توانید بدهی را به اقساط تاریخ‌دار تقسیم کنید.")}</span></div>}
    {show && <Modal title={t("پلن قسط جدید")} onClose={() => setShow(false)}>
      <form className="form-grid" onSubmit={create}>
        <label className="field"><span>{t("مبلغ کل بدهی (افغانی)")}</span><input required type="number" min="1" dir="ltr" value={form.total} onChange={(e) => setForm({ ...form, total: numberValue(e) })}/></label>
        <label className="field"><span>{t("تعداد اقساط")}</span><input required type="number" min="2" max="60" dir="ltr" value={form.installmentCount} onChange={(e) => setForm({ ...form, installmentCount: numberValue(e) })}/></label>
        <label className="field"><span>{t("فاصلهٔ اقساط (روز)")}</span><input type="number" min="1" max="365" dir="ltr" value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: numberValue(e) || 30 })}/></label>
        <label className="field"><span>{t("تاریخ اولین قسط")}</span><DateField value={form.startDate || ""} onChange={(iso) => setForm({ ...form, startDate: iso })}/></label>
        <label className="field full"><span>{t("یادداشت")}</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("اختیاری")}/></label>
        {error && <div className="form-error full">{error}</div>}
        <div className="form-actions full"><button type="button" className="secondary-button" onClick={() => setShow(false)}>{t("انصراف")}</button><button className="primary-button" disabled={busy || form.total <= 0}>{busy ? t("در حال ثبت…") : t("ثبت پلن")}</button></div>
      </form>
    </Modal>}
  </section>;
}

/** پیشنهاد سفارش خرید — سرعت فروش ۳۰ روز اخیر. */
export function ReorderPanel() {
  const [rows, setRows] = useState<ReorderRow[] | null>(null);
  useEffect(() => { get<ReorderRow[]>("/inventory/reorder").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <section className="surface" style={{ marginTop: "0.75rem" }}><div className="loading"><RefreshCw size={16}/>{t("در حال محاسبهٔ پیشنهاد خرید…")}</div></section>;
  return <section className="surface" style={{ marginTop: "0.75rem" }}>
    <div className="toolbar"><PackageCheck size={17}/><b>{t("پیشنهاد سفارش خرید")}</b><small className="muted">{t("بر پایهٔ فروش ۳۰ روز اخیر و ۱۴ روز پوشش آینده")}</small></div>
    {rows.length ? <div className="table-wrap"><table>
      <thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("موجودی آزاد")}</th><th>{t("فروش ۳۰ روز")}</th><th>{t("روزهای باقی‌مانده")}</th><th>{t("پیشنهاد خرید")}</th><th>{t("آخرین تأمین‌کننده")}</th></tr></thead>
      <tbody>{rows.map((row, idx) => <tr key={row.productId}><td className="muted mono">{idx + 1}</td>
        <td><b>{row.name}</b>{row.belowMin && <small className="block danger-text">{t("زیر نقطهٔ سفارش")}</small>}</td>
        <td>{row.onHand} {row.unit}{row.reserved > 0 && <small className="block muted">({row.reserved} {t("رزرو")})</small>}</td>
        <td>{row.soldLast30}</td>
        <td>{row.daysLeft == null ? "—" : row.daysLeft}</td>
        <td><b>{row.suggested} {row.unit}</b>{row.estimatedCost > 0 && <small className="block muted">≈ {money(row.estimatedCost)}</small>}</td>
        <td>{row.lastSupplier?.name || "—"}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><b>{t("پیشنهادی نیست")}</b><span>{t("موجودی همهٔ کالاها برای ۱۴ روز آینده کافی به نظر می‌رسد.")}</span></div>}
  </section>;
}

/** جدول دستگاه‌های سریال‌دار (IMEI) با وضعیت هرکدام. */
export function SerialsPanel({ products }: { products: Product[] }) {
  const [productId, setProductId] = useState("");
  const [rows, setRows] = useState<SerialUnit[] | null>(null);
  // Returned units re-enter sellable stock (status IN_STOCK with a «برگشت …»
  // note), so there is no permanently-stranded RETURNED state to filter by.
  const [statusFilter, setStatusFilter] = useState<"IN_STOCK" | "SOLD" | "RETURNED">("IN_STOCK");
  const serialized = products.filter((p) => p.isSerialized);
  useEffect(() => {
    if (!productId) { setRows(null); return; }
    get<SerialUnit[]>(`/inventory/serials?productId=${productId}&status=${statusFilter}`).then(setRows).catch(() => setRows([]));
  }, [productId, statusFilter]);
  const statusLabel = (status: string) => ({ IN_STOCK: t("موجود"), SOLD: t("فروخته‌شده"), RETURNED: t("برگشتی") } as Record<string, string>)[status] || status;
  return <section className="surface" style={{ marginTop: "0.75rem" }}>
    <div className="toolbar"><Smartphone size={17}/><b>{t("سریال / IMEI")}</b>
      <select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">{t("انتخاب کالا…")}</option>{serialized.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <div className="grow"/>
      {(["IN_STOCK", "SOLD", "RETURNED"] as const).map((value) => <button key={value} className={`chip ${statusFilter === value ? "active" : ""}`} onClick={() => setStatusFilter(value)}>{statusLabel(value)}</button>)}
    </div>
    {productId && rows && (rows.length ? <div className="table-wrap"><table>
      <thead><tr><th>{t("شماره")}</th><th>{t("سریال")}</th><th>{t("وضعیت")}</th><th>{t("یادداشت")}</th><th>{t("زمان ثبت")}</th></tr></thead>
      <tbody>{rows.map((unit, idx) => <tr key={unit.id}><td className="muted mono">{idx + 1}</td><td dir="ltr" className="text-right"><b>{unit.serial}</b></td><td>{statusLabel(unit.status)}</td><td className="muted">{unit.note || "—"}</td><td className="muted">{dateTime(unit.createdAt)}</td></tr>)}</tbody>
    </table></div> : <div className="empty"><b>{t("سریالی نیست")}</b><span>{t("سریال‌ها هنگام ثبت خرید وارد می‌شوند.")}</span></div>)}
    {!serialized.length && <div className="empty"><b>{t("کالای سریال‌دار ندارید")}</b><span>{t("در صفحهٔ کالاها، گزینهٔ «سریال‌دار» را فعال کنید.")}</span></div>}
  </section>;
}
