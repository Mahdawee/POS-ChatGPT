import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CalendarClock, ClipboardList, Copy, Check, Mail, MessageCircle, PackageCheck, RefreshCw, Send, Smartphone, Trash2, X } from "lucide-react";
import { get, post, type Contact, type CustomerOrder, type InstallmentPlan, type LicenseStatus, type Product, type ReceiptText, type ReorderRow, type Sale, type SerialUnit } from "../lib/api";
import { dateOnly, dateTime, money, t } from "../i18n";
import { Modal } from "./Pages";

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
      <div className="license-logo">{t("رو")}</div>
      <h1>{t("روشن")} <small>{t("فروش و مدیریت فروشگاه")}</small></h1>
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
  const load = () => get<CustomerOrder[]>(`/orders?status=${status}`).then(setOrders).catch((e) => setError(e.message));
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
  const remaining = (order: CustomerOrder) => order.lines.reduce((sum, line) => sum + (line.quantity - line.deliveredQty), 0);
  return <div className="page-stack">
    <section className="surface">
      <div className="toolbar">
        <div className="search-box"><ClipboardList size={17}/><span>{t("سفارش‌های مشتری (رزرو موجودی)")}</span></div>
        <div className="grow"/>
        {(["OPEN", "FULFILLED", "CANCELLED"] as const).map((value) => <button key={value} className={`chip ${status === value ? "active" : ""}`} onClick={() => setStatus(value)}>{value === "OPEN" ? t("باز") : value === "FULFILLED" ? t("تحویل‌شده") : t("لغو‌شده")}</button>)}
        <button className="primary-button" onClick={() => setShow(true)}><ClipboardList size={17}/>{t("سفارش جدید")}</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>{t("شماره سفارش")}</th><th>{t("مشتری")}</th><th>{t("اقلام")}</th><th>{t("مانده تحویل")}</th><th>{t("یادداشت")}</th><th>{t("زمان ثبت")}</th><th></th></tr></thead>
        <tbody>{orders.map((order) => <tr key={order.id}>
          <td><b>{order.orderNo}</b></td>
          <td>{order.customer?.name || t("مشتری گذری")}</td>
          <td className="muted">{order.lines.map((line) => `${line.name} × ${line.quantity}`).join("، ")}</td>
          <td>{order.status === "OPEN" ? <b className={remaining(order) > 0 ? "danger-text" : "green-text"}>{remaining(order)}</b> : "—"}</td>
          <td className="muted">{order.note || "—"}</td>
          <td className="muted">{dateTime(order.createdAt)}</td>
          <td>{order.status === "OPEN" && <div className="row-actions"><button className="text-button" onClick={() => openDeliver(order)}><PackageCheck size={14}/>{t("تحویل")}</button><button className="text-button danger-text" onClick={() => void cancel(order)}><X size={14}/>{t("لغو")}</button></div>}</td>
        </tr>)}</tbody>
      </table>{!orders.length && <div className="empty"><b>{t("سفارشی نیست")}</b><span>{t("سفارش‌های رزروشدهٔ مشتری‌ها در اینجا دیده می‌شوند.")}</span></div>}</div>
    </section>
    {show && <Modal title={t("ثبت سفارش مشتری")} onClose={() => setShow(false)} wide>
      <form className="form-grid" onSubmit={createOrder}>
        <label className="field"><span>{t("مشتری")}</span><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">{t("مشتری گذری")}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field full"><span>{t("یادداشت")}</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("اختیاری")}/></label>
        {form.lines.map((line, index) => <div className="bundle-row" key={index}>
          <select value={line.productId} onChange={(e) => setForm({ ...form, lines: form.lines.map((row, i) => i === index ? { ...row, productId: e.target.value } : row) })}><option value="">{t("انتخاب کالا…")}</option>{products.filter((p) => !p.isBundle).map((p) => <option key={p.id} value={p.id}>{p.name} — {t("آزاد")}: {p.stock - (p.reserved || 0)}</option>)}</select>
          <input type="number" min="0.001" step="0.001" dir="ltr" value={line.quantity} onChange={(e) => setForm({ ...form, lines: form.lines.map((row, i) => i === index ? { ...row, quantity: numberValue(e) } : row) })}/>
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
            <label className="compact-field"><span>{t("این بار تحویل")}</span><input type="number" min="0" max={max} step="0.001" dir="ltr" value={value.quantity} onChange={(e) => setDeliveries({ ...deliveries, [line.id]: { ...value, quantity: Math.min(max, Math.max(0, numberValue(e))) } })}/></label>
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
      <thead><tr><th>{t("مبلغ پلن")}</th><th>{t("پرداخت‌شده")}</th><th>{t("وضعیت")}</th><th>{t("اقساط")}</th></tr></thead>
      <tbody>{plans.map((plan) => <tr key={plan.id}>
        <td><b>{money(plan.total)}</b>{plan.note && <small className="block muted">{plan.note}</small>}</td>
        <td>{money(plan.paidAmount)}</td>
        <td>{plan.status === "SETTLED" ? <b className="green-text">{t("تسویه")}</b> : <b className="amber-text">{t("باز")}</b>}</td>
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
        <label className="field"><span>{t("تاریخ اولین قسط")}</span><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })}/></label>
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
      <thead><tr><th>{t("کالا")}</th><th>{t("موجودی آزاد")}</th><th>{t("فروش ۳۰ روز")}</th><th>{t("روزهای باقی‌مانده")}</th><th>{t("پیشنهاد خرید")}</th><th>{t("آخرین تأمین‌کننده")}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.productId}>
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
  const [statusFilter, setStatusFilter] = useState<"IN_STOCK" | "SOLD">("IN_STOCK");
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
      {(["IN_STOCK", "SOLD"] as const).map((value) => <button key={value} className={`chip ${statusFilter === value ? "active" : ""}`} onClick={() => setStatusFilter(value)}>{statusLabel(value)}</button>)}
    </div>
    {productId && rows && (rows.length ? <div className="table-wrap"><table>
      <thead><tr><th>{t("سریال")}</th><th>{t("وضعیت")}</th><th>{t("یادداشت")}</th><th>{t("زمان ثبت")}</th></tr></thead>
      <tbody>{rows.map((unit) => <tr key={unit.id}><td dir="ltr" className="text-right"><b>{unit.serial}</b></td><td>{statusLabel(unit.status)}</td><td className="muted">{unit.note || "—"}</td><td className="muted">{dateTime(unit.createdAt)}</td></tr>)}</tbody>
    </table></div> : <div className="empty"><b>{t("سریالی نیست")}</b><span>{t("سریال‌ها هنگام ثبت خرید وارد می‌شوند.")}</span></div>)}
    {!serialized.length && <div className="empty"><b>{t("کالای سریال‌دار ندارید")}</b><span>{t("در صفحهٔ کالاها، گزینهٔ «سریال‌دار» را فعال کنید.")}</span></div>}
  </section>;
}
