import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, ArrowDown, ArrowDownLeft, ArrowDownUp, ArrowLeftRight, ArrowUp, ArrowUpRight, Banknote, Boxes, Check, ChevronDown, CirclePlus, ClipboardList, FileInput as FileInputIcon, FileText, FileDown, History, Image as ImageIcon, KeyRound, Lightbulb, MonitorPlay, Package, Pause, Percent, PackagePlus, Printer, ReceiptText, RefreshCw, Save, Search, ShieldCheck, ShoppingBag, ShoppingCart, Trash2, Truck, Undo2, UsersRound, Wallet, X } from "lucide-react";
import { del, enqueueOfflineSale, flushOfflineQueue, get, patch, post, put, readOfflineQueue, serverOrigin, setServerOrigin, type AuditEntry, type BackupExport, type CashSession, type Category, type Contact, type CustomerDetail, type CustomersReport, type DebtorsReport, type DiscountsReport, type ExpenseList, type InventoryReport, type Product, type ProductBatch, type ProductImportResult, type ProfitReport, type Purchase, type PurchaseList, type PurchasesReport, type PurchaseReturn, type Quote, type Sale, type SaleList, type SaleReturn, type ShopSettings, type Stocktake, type SuppliersReport, type SupplierDetail, type User, type ZReport } from "../lib/api";
import { applyCurrencyList, applyLocaleSettings, BASE_CURRENCIES, dateOnly, dateTime, dayLabel, fullDate, money, moneyPlain, percent, qty, t, timeOnly, type CurrencyRow } from "../i18n";
import { isoOf } from "../lib/calendar";
import { debtorsHtml, invoiceHtml, labelsHtml, printDebtReceipt, printHtml, purchaseReturnHtml, reportHtml, returnSlipHtml, saleReceiptHtml, printSaleReceipt, testQuickPrint, zReportHtml } from "../lib/print";
import { importTemplateHeader, mapImportRows, parseCsv, toCsv, type ImportRow } from "../lib/csv";
import { CLIPBOARD_SAVED, exportCsv as exportCsvFile, exportTablePdf, saveTextFile } from "../lib/export";
import { SectionHead } from "./SectionHead";
import { ExportMenu } from "./ExportMenu";
import { InstallmentsPanel, LicensePanel, ReorderPanel, SerialsPanel, ShareReceiptModal } from "./Round16";
import { ScannerPanel } from "./ScannerPanel";
import { DateField } from "./DatePicker";
import { Pagination } from "./Pagination";
import { openCustomerDisplay } from "./CustomerDisplay";
import { invoke } from "@tauri-apps/api/core";
import { scannerBeep, scannerSettings } from "../lib/scanner";
import { APP_VERSION, RELEASES_API } from "../lib/version";
import { useBrand } from "../lib/brand";
import JsBarcode from "jsbarcode";
import type { PageId } from "./Shell";

type Notify = (message: string, kind?: "success" | "error") => void;
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  // Esc مودال را می‌بندد (رفتار استاندارد دسکتاپ) — همان کلیک روی زمینه.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? "modal-wide" : ""}`}><header className="modal-head"><div><h2>{title}</h2><span>{t("اطلاعات در همین دستگاه ذخیره می‌شود")}</span></div><button className="icon-button" onClick={onClose}><X size={19}/></button></header>{children}</section></div>;
}
/** How many complete kits of a bundle can be assembled right now: the
 *  smallest free-component count divided by that kit's needs. Bundles never
 *  carry stock of their own — the server deducts the components at checkout —
 *  so every availability check on the client must use this number instead of
 *  the (meaningless) bundle.stock row. */
/** Serials a sale line must name: one per serialized unit — directly for a
 *  simple product, or summed over the kit's serialized components. */
function serializedNeed(product: Product, lineQuantity: number): number {
  if (product.isBundle) return (product.bundleComponents || []).filter((row) => row.component?.isSerialized).reduce((sum, row) => sum + row.quantity * lineQuantity, 0);
  return product.isSerialized ? Math.round(lineQuantity) : 0;
}

/** Pick serial/IMEI units from a clickable list — or scan into the search
 *  box — instead of typing them by hand. The chips are what the shelf (or the
 *  invoice, for returns) actually holds; the raw textarea stays as a manual
 *  fallback and keeps the comma/newline-separated contract the checkout
 *  payloads already use, so nothing else has to change. */
function SerialPicker({ label, need, available, value, onChange }: { label: string; need: number; available: string[]; value: string; onChange(next: string): void }) {
  const [search, setSearch] = useState("");
  const selected = value.split(/[\n,،\s]+/).filter(Boolean);
  const pick = (serial: string) => onChange(selected.includes(serial) ? selected.filter((row) => row !== serial).join("\n") : [...selected, serial].join("\n"));
  const candidates = available.filter((serial) => !selected.includes(serial) && (!search.trim() || serial.toLowerCase().includes(search.trim().toLowerCase())));
  const pickedHere = selected.filter((serial) => available.includes(serial)).length;
  return <div className="serial-picker">
    <div className="serial-picker-head"><span>{label} <b className="mono" dir="ltr">({pickedHere}/{need})</b></span>
      <input dir="ltr" value={search} placeholder={t("جستجو یا اسکن سریال…")} onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); const hit = available.includes(search.trim()) ? search.trim() : candidates.length === 1 ? candidates[0] : ""; if (hit) { pick(hit); setSearch(""); } }}/></div>
    <div className="serial-chips">
      {available.filter((serial) => selected.includes(serial)).map((serial) => <button type="button" key={serial} className="chip serial-chip active" onClick={() => pick(serial)} title={t("برداشتن از فهرست")} dir="ltr">{serial}<X size={11}/></button>)}
      {candidates.slice(0, 30).map((serial) => <button type="button" key={serial} className="chip serial-chip" onClick={() => pick(serial)} dir="ltr">{serial}</button>)}
    </div>
    {!available.length && <small className="muted">{t("سریالی برای انتخاب نیست؛ سریال را دستی وارد کنید.")}</small>}
    {candidates.length > 30 && <small className="muted">{t("برای دیدن بقیهٔ سریال‌ها، جستجو کنید.")}</small>}
    <textarea rows={1} dir="ltr" value={value} onChange={(event) => onChange(event.target.value)} placeholder={`IMEI-1, IMEI-2… (${need})`}/>
  </div>;
}

/** Serialized groups a line must name serials for: the product itself, or
 *  each serialized component of a kit. Shared by every picker site. */
function serialGroups(product: Product, lineQuantity: number): Array<{ key: string; label: string; need: number }> {
  if (!product.isBundle) return product.isSerialized ? [{ key: product.id, label: t("سریال/IMEI هر دستگاه"), need: Math.round(lineQuantity) }] : [];
  return (product.bundleComponents || []).filter((row) => row.component?.isSerialized).map((row) => ({ key: row.componentId, label: `${row.component?.name || "?"} × ${row.quantity * lineQuantity}`, need: Math.round(row.quantity * lineQuantity) }));
}

function buildableKits(product: Product): number {
  const rows = product.bundleComponents || [];
  if (!rows.length) return 0;
  return Math.floor(Math.min(...rows.map((row) => (((row.component?.stock ?? 0) - (row.component?.reserved ?? 0)) / (row.quantity || 1)))));
}

function Loading() { return <div className="loading"><RefreshCw size={18}/>{t("در حال بارگذاری اطلاعات…")}</div>; }
// Server errors arrive as Dari sentences — t() translates them when a matching
// entry exists and shows the original text otherwise.
function ErrorBox({ message }: { message: string }) {
  // Server 5xx replies append a short technical line (exception + route)
  // after a newline; it is shown in muted small text so a screenshot is
  // enough to pinpoint the failing request for support.
  const newline = message.indexOf("\n");
  const headline = newline === -1 ? message : message.slice(0, newline);
  const detail = newline === -1 ? "" : message.slice(newline + 1).trim();
  return <div className="error-box"><AlertTriangle size={17}/><span>{t(headline)}{detail && <small dir="ltr" className="block" style={{ marginTop: 3, opacity: 0.75, wordBreak: "break-word" }}>{detail}</small>}</span></div>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><div><Package size={22}/></div><b>{title}</b><span>{text}</span></div>; }
function Field({ label, children, full = false }: { label: string; children: ReactNode; full?: boolean }) { return <label className={`field ${full ? "full" : ""}`}><span>{label}</span>{children}</label>; }

/** Sortable table column: click toggles asc/desc; the arrow shows the live state. */
function SortTh({ label, active, dir, onClick }: { label: string; active: boolean; dir: "asc" | "desc"; onClick(): void }) {
  return <th><button type="button" className={`th-sort ${active ? "active" : ""}`} onClick={onClick} title={active ? (dir === "asc" ? t("صعودی") : t("نزولی")) : t("مرتب‌سازی")}>{label}{active ? (dir === "asc" ? <ArrowUp size={11}/> : <ArrowDown size={11}/>) : <ArrowDownUp size={11}/>}</button></th>;
}
const numberValue = (event: React.ChangeEvent<HTMLInputElement>) => Number(event.currentTarget.value || 0);


type Summary = { todaySales: number; todayCount: number; todayPurchases: number; todayReturns: number; creditOutstanding: number; stockValue: number; backroomValue?: number; productCount: number; lowStockCount: number; lowStock: Product[]; expiringCount: number; expiring: Array<{ id: string; name: string; sku: string; expiryDate: string; remainingQty?: number }>; recentSales: Sale[]; salesByDay?: Array<{ day: string; total: number }>; lastBackupAt?: string | null; overdueInstallments?: Array<{ id: string; seq: number; amount: number; dueDate: string; customer: { id: string; name: string; phone: string | null }; planId: string }>; overdueInstallmentsTotal?: number; openOrders?: Array<{ id: string; orderNo: string; createdAt: string; note: string | null; customer: { id: string; name: string; phone: string | null } | null; lines: Array<{ id: string; name: string; quantity: number; deliveredQty: number; unitPrice: number }> }>; openOrdersCount?: number };
export function DashboardPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { get<Summary>("/dashboard/summary").then(setData).catch((e) => setError(e.message)); }, []);
  if (!data && !error) return <Loading/>;
  // Nudge when no backup exists or the newest one is older than three days.
  const backupAgeDays = data?.lastBackupAt ? Math.floor((Date.now() - new Date(data.lastBackupAt).getTime()) / 86400000) : null;
  const backupStale = data != null && (backupAgeDays == null || backupAgeDays >= 3);
  return <div className="page-stack">
    {error && <ErrorBox message={error}/>}
    {backupStale && <div className="error-box cash-warning"><AlertTriangle size={16}/>{backupAgeDays == null ? t("هنوز هیچ نسخهٔ پشتیبان گرفته نشده است.") : t("آخرین نسخهٔ پشتیبان {days} روز پیش گرفته شده است.", { days: backupAgeDays })} <button className="text-button" style={{ marginInlineStart: 8 }} onClick={() => onNavigate("settings")}>{t("رفتن به تنظیمات")}</button></div>}
    <div className="welcome-row"><div><div className="eyebrow">{fullDate(new Date())}</div><h2>{t("به فروشگاه‌تان خوش آمدید")}</h2><p>{t("وضعیت فروش و موجودی امروز را از همین‌جا ببینید.")}</p></div><button className="primary-button" onClick={() => onNavigate("pos")}><ShoppingCart size={18}/>{t("آغاز فروش")}</button></div>
    {data?.salesByDay?.some((day) => day.total > 0) && <section className="surface chart-card"><SectionHead title={t("فروش ۱۴ روز اخیر")} subtitle={t("مجموع فروش هر روز — افغانی")}/>
      <div className="chart-bars">{data!.salesByDay!.map((day) => {
        const max = Math.max(...data!.salesByDay!.map((row) => row.total), 1);
        const height = Math.round((day.total / max) * 100);
        return <div className="chart-bar" key={day.day} title={`${dayLabel(day.day)} — ${money(day.total)}`}>
          <span className="chart-bar-value">{day.total > 0 ? moneyPlain(day.total) : ""}</span>
          <div className="chart-bar-fill" style={{ height: `${Math.max(day.total > 0 ? 6 : 0, height)}%` }}/>
          <small>{day.day.slice(5)}</small>
        </div>;
      })}</div>
    </section>}
    <div className="metric-grid">
      <Metric icon={Banknote} label={t("فروش امروز")} value={money(data?.todaySales ?? 0)} note={t("{count} فاکتور ثبت‌شده", { count: data?.todayCount ?? 0 })} tone="green" onClick={() => onNavigate("sales")}/>
      <Metric icon={Undo2} label={t("برگشتی امروز")} value={money(data?.todayReturns ?? 0)} note={t("بازپرداخت به مشتریان")} tone="amber" onClick={() => onNavigate("sales")}/>
      <Metric icon={Truck} label={t("خرید امروز")} value={money(data?.todayPurchases ?? 0)} note={t("ورود کالا به انبار")} tone="violet" onClick={() => onNavigate("purchases")}/>
      <Metric icon={Wallet} label={t("بدهی نسیه (کل)")} value={money(data?.creditOutstanding ?? 0)} note={t("ماندهٔ همهٔ مشتریان")} tone={data && data.creditOutstanding > 0 ? "amber" : "green"} onClick={() => onNavigate("customers")}/>
      <Metric icon={Package} label={t("ارزش انبار")} value={money(data?.stockValue ?? 0)} note={data?.backroomValue ? t("قفسهٔ فروش — پشتیبان: {value}", { value: money(data.backroomValue) }) : t("به قیمت خرید")} tone="blue" onClick={() => onNavigate("inventory")}/>
      <Metric icon={Boxes} label={t("کالاهای فعال")} value={String(data?.productCount ?? 0)} note={t("در فهرست فروش")} tone="violet" onClick={() => onNavigate("products")}/>
      <Metric icon={AlertTriangle} label={t("کالاهای کم‌موجود")} value={String(data?.lowStockCount ?? 0)} note={t("نیازمند بررسی")} tone="amber" onClick={() => { presetProductsStockFilter("low"); onNavigate("products"); }}/>
      <Metric icon={FileText} label={t("فاکتورهای امروز")} value={String(data?.todayCount ?? 0)} note={t("فروش‌های ثبت‌شده")} tone="blue" onClick={() => onNavigate("sales")}/>
    </div>
    <div className="dashboard-grid"><section className="surface"><SectionHead title={t("فروش‌های تازه")} subtitle={t("آخرین فاکتورهای ثبت‌شده")} action={<button className="text-button" onClick={() => onNavigate("sales")}>{t("مشاهده همه")}</button>}/>{data?.recentSales.length ? <div className="table-wrap"><table><thead><tr><th>{t("شماره فاکتور")}</th><th>{t("مشتری")}</th><th>{t("مبلغ")}</th><th>{t("زمان")}</th><th></th></tr></thead><tbody>{data.recentSales.map((sale) => <tr key={sale.id}><td className="mono">{sale.receiptNo}</td><td>{sale.customer?.name || t("مشتری گذری")}</td><td className="strong">{money(sale.total)}</td><td className="muted">{dateTime(sale.createdAt)}</td><td><span className="status-pill paid"><Check size={13}/>{t("ثبت شد")}</span></td></tr>)}</tbody></table></div> : <Empty title={t("هنوز فروشی ثبت نشده")} text={t("با ثبت اولین فروش، خلاصه آن در این بخش دیده می‌شود.")}/>}</section>
      {Boolean(data?.expiring?.length) && <section className="surface"><SectionHead title={t("انقضای کالا")} subtitle={t("کالاهایی که تاریخ انقضای آن‌ها نزدیک یا گذشته است")} action={<button className="icon-button" onClick={() => onNavigate("products")}><ChevronDown size={18}/></button>}/><div className="stock-alert-list">{data!.expiring!.map((item) => <div className="stock-alert" key={item.id}><div className="product-initial">{item.name.slice(0, 1)}</div><div className="grow"><b>{item.name}</b><span>{item.sku}</span></div><strong className={new Date(item.expiryDate).getTime() < Date.now() ? "stock-low" : ""}>{dateOnly(item.expiryDate)} · {Math.ceil((new Date(item.expiryDate).getTime() - Date.now()) / 86400000) < 0 ? t("منقضی") : t("{days} روز مانده", { days: Math.ceil((new Date(item.expiryDate).getTime() - Date.now()) / 86400000) })}{item.remainingQty != null ? ` · ${qty(item.remainingQty)} ${t("باقی‌مانده")}` : ""}</strong></div>)}</div></section>}
      <section className="surface"><SectionHead title={t("هشدار موجودی")} subtitle={t("کالاهایی که به حداقل موجودی رسیده‌اند")} action={<button className="icon-button" onClick={() => onNavigate("inventory")}><ChevronDown size={18}/></button>}/>{data?.lowStock.length ? <div className="stock-alert-list">{data.lowStock.map((product) => <div className="stock-alert" key={product.id}><div className="product-initial">{product.name.slice(0, 1)}</div><div className="grow"><b>{product.name}</b><span>{product.sku}</span></div><strong className="stock-low">{qty(product.stock)} <small>{product.unit}</small></strong></div>)}</div> : <Empty title={t("موجودی مناسب است")} text={t("فعلاً کالای کم‌موجودی ندارید.")}/>}</section></div>
    {Boolean(data?.overdueInstallments?.length) && <section className="surface"><SectionHead title={t("اقساط سررسیدشده")} subtitle={t("پرداخت‌نشده — با مشتری تماس بگیرید")} action={<button className="text-button" onClick={() => onNavigate("customers")}>{t("مشتریان")}</button>}/><div className="stock-alert-list">{data!.overdueInstallments!.map((inst) => <div className="stock-alert" key={inst.id}><div className="product-initial">{inst.customer.name.slice(0, 1)}</div><div className="grow"><b>{inst.customer.name}</b><span>{t("قسط {seq}", { seq: inst.seq })}{inst.customer.phone ? ` · ${inst.customer.phone}` : ""}</span></div><strong className="stock-low">{money(inst.amount)} · {dateOnly(inst.dueDate)}</strong></div>)}</div></section>}
    {Boolean(data?.openOrders?.length) && <section className="surface"><SectionHead title={t("سفارش‌های باز")} subtitle={t("موجودی رزروشده برای مشتری‌ها")} action={<button className="text-button" onClick={() => onNavigate("orders")}>{t("سفارش‌ها")}</button>}/><div className="stock-alert-list">{data!.openOrders!.map((order) => <div className="stock-alert" key={order.id}><div className="product-initial">{(order.customer?.name || "?").slice(0, 1)}</div><div className="grow"><b>{order.customer?.name || t("مشتری گذری")}</b><span>{order.lines.map((line) => `${line.name} × ${line.quantity - line.deliveredQty}`).join("، ")}</span></div><strong>{order.orderNo} · {dateOnly(order.createdAt)}</strong></div>)}</div></section>}
    <section className="quick-actions"><div><span className="eyebrow">{t("دسترسی سریع")}</span><h3>{t("کارهای روزانه")}</h3></div><button onClick={() => onNavigate("pos")}><ShoppingCart/><span><b>{t("ثبت فروش")}</b><small>{t("فاکتور جدید بسازید")}</small></span></button><button onClick={() => onNavigate("products")}><CirclePlus/><span><b>{t("افزودن کالا")}</b><small>{t("کالای تازه به فهرست")}</small></span></button><button onClick={() => onNavigate("cash")}><Banknote/><span><b>{t("وضعیت صندوق")}</b><small>{t("باز و بسته کردن صندوق")}</small></span></button><button onClick={() => onNavigate("customers")}><UsersRound/><span><b>{t("افزودن مشتری")}</b><small>{t("مدیریت مشتریان")}</small></span></button></section>
  </div>;
}
function Metric({ icon: Icon, label, value, note, tone, onClick }: { icon: typeof Banknote; label: string; value: string; note: string; tone: string; onClick?: () => void }) {
  // Clickable cards jump straight to their section — a shopkeeper reading
  // "۱۲ کالا کم‌موجود" wants the product list, not a dead number.
  return <article className={`metric-card ${onClick ? "metric-clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}><div className={`metric-icon ${tone}`}><Icon size={20}/></div><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

/** Lets the dashboard land the user on the products page with a preset
 *  stock filter (e.g. the low-stock card → only low-stock goods). */
function presetProductsStockFilter(value: "low" | "out"): void {
  try { sessionStorage.setItem("darpos-products-stock", value); } catch { /* storage unavailable */ }
}

type ProductForm = { sku: string; barcode: string; name: string; unit: string; isWeighted: boolean; isBundle: boolean; isSerialized: boolean; expiryDate: string; price: number; wholesalePrice: string; wholesaleMinQty: string; cost: number; stock: number; minStock: number; categoryId: string };
const blankProduct: ProductForm = { sku: "", barcode: "", name: "", unit: "عدد", isWeighted: false, isBundle: false, isSerialized: false, expiryDate: "", price: 0, wholesalePrice: "", wholesaleMinQty: "", cost: 0, stock: 0, minStock: 0, categoryId: "" };
const expiryDays = (date?: string | null): number | null => (date ? Math.ceil((new Date(date).getTime() - Date.now()) / 86400000) : null);
export function ProductsPage({ notify, user }: { notify: Notify; user: User }) {
  const [products, setProducts] = useState<Product[]>([]); const [categories, setCategories] = useState<Category[]>([]); const [query, setQuery] = useState(""); const [edit, setEdit] = useState<Product | null | false>(false); const [form, setForm] = useState<ProductForm>(blankProduct); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [archived, setArchived] = useState(false);
  const [showImport, setShowImport] = useState(false); const [importRows, setImportRows] = useState<ImportRow[]>([]); const [importSkipped, setImportSkipped] = useState(0); const [importBusy, setImportBusy] = useState(false); const [importResult, setImportResult] = useState<ProductImportResult | null>(null); const [importError, setImportError] = useState("");
  // Months of use: sort by stock/price (not just name) and jump straight to
  // low/out-of-stock goods. The dashboard's low-stock card presets this via
  // sessionStorage so the landing already shows the filtered list.
  const [sort, setSort] = useState<{ key: "name" | "sku" | "price" | "stock" | "expiry"; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "out">(() => { try { const preset = sessionStorage.getItem("darpos-products-stock"); if (preset === "low" || preset === "out") { sessionStorage.removeItem("darpos-products-stock"); return preset; } } catch { /* storage unavailable */ } return "all"; });
  const [categoryFilter, setCategoryFilter] = useState("");
  const [labelFor, setLabelFor] = useState<Product | null>(null); const [labelCount, setLabelCount] = useState(8); const [shop, setShop] = useState<ShopSettings>({});
  const [bundleFor, setBundleFor] = useState<Product | null>(null); const [bundleRows, setBundleRows] = useState<Array<{ componentId: string; quantity: number }>>([]); const [bundleBusy, setBundleBusy] = useState(false); const [bundleError, setBundleError] = useState("");
  // صفحه‌بندی سمت سرور: کل کاتالوگ‌های خیلی بزرگ یک‌جا بارگذاری نمی‌شوند.
  const [catalogTotal, setCatalogTotal] = useState(0); const [catalogHasMore, setCatalogHasMore] = useState(false); const [moreBusy, setMoreBusy] = useState(false);
  const setBundleFor2 = (product: Product) => { setBundleFor(product); setBundleError(""); setBundleRows((product.bundleComponents || []).map((row) => ({ componentId: row.componentId, quantity: row.quantity })).length ? (product.bundleComponents || []).map((row) => ({ componentId: row.componentId, quantity: row.quantity })) : [{ componentId: "", quantity: 1 }]); };
  const saveBundle = async (event: FormEvent) => {
    event.preventDefault();
    if (!bundleFor) return;
    const components = bundleRows.filter((row) => row.componentId && row.quantity > 0);
    if (!components.length) { setBundleError(t("حداقل یک جزء لازم است.")); return; }
    setBundleBusy(true); setBundleError("");
    try { await put(`/products/${bundleFor.id}/bundle`, { components }); setBundleFor(null); notify(t("اجزای بسته ذخیره شد.")); await load(); } catch (e) { setBundleError((e as Error).message); } finally { setBundleBusy(false); }
  };
  // NB: `search` defaults to the LIVE query — an in-place reload (edit,
  // archive, import) used to silently wipe an active search.
  const load = (showArchived = archived, search = query.trim(), skip = 0) => {
    const params = new URLSearchParams();
    if (showArchived) params.set("archived", "1");
    if (search) params.set("q", search);
    if (skip > 0) params.set("skip", String(skip));
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
    if (stockFilter !== "all") params.set("stock", stockFilter);
    if (categoryFilter) params.set("categoryId", categoryFilter);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return Promise.all([
      get<{ list: Product[]; total: number; hasMore: boolean }>(`/products/page${suffix}`),
      skip > 0 ? Promise.resolve(categories) : get<Category[]>("/categories"),
    ]).then(([page, cats]) => {
      setProducts((previous) => (skip > 0 ? [...previous, ...page.list] : page.list));
      setCatalogTotal(page.total); setCatalogHasMore(page.hasMore);
      if (skip === 0) setCategories(cats);
    }).catch((e) => setError(e.message));
  };
  /** صفحهٔ بعدی کالاها (جست‌وجو و وضعیت بایگانی همان قبلی می‌ماند). */
  const loadMore = async () => { setMoreBusy(true); try { await load(archived, query.trim(), products.length); } finally { setMoreBusy(false); } };
  // Filter changes reload at once; the search box debounces on its own.
  useEffect(() => { void load(archived, query.trim(), 0); }, [archived, sort, stockFilter, categoryFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  // Debounced server-side search: keeps thousands-of-row warehouses snappy.
  const searchMounted = useRef(false);
  useEffect(() => {
    if (!searchMounted.current) { searchMounted.current = true; return; } // mount already covered above
    const handle = window.setTimeout(() => { void load(archived, query.trim(), 0); }, 300);
    return () => window.clearTimeout(handle);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const shown = products; // filtered server-side (see the debounced search above)
  const openNew = () => { setForm(blankProduct); setEdit(null); };
  const openEdit = (product: Product) => { setForm({ sku: product.sku, barcode: product.barcode || "", name: product.name, unit: product.unit, isWeighted: Boolean(product.isWeighted), isBundle: Boolean(product.isBundle), isSerialized: Boolean(product.isSerialized), expiryDate: product.expiryDate ? product.expiryDate.slice(0, 10) : "", price: product.price, wholesalePrice: product.wholesalePrice != null ? String(product.wholesalePrice) : "", wholesaleMinQty: product.wholesaleMinQty != null ? String(product.wholesaleMinQty) : "", cost: product.cost, stock: product.stock, minStock: product.minStock, categoryId: product.categoryId || "" }); setEdit(product); };
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const body = { ...form, wholesalePrice: form.wholesalePrice === "" ? null : Number(form.wholesalePrice), wholesaleMinQty: form.wholesaleMinQty === "" ? null : Number(form.wholesaleMinQty), barcode: form.barcode || undefined, categoryId: form.categoryId || undefined, expiryDate: form.expiryDate || null, stock: edit ? undefined : form.stock }; if (edit) await patch(`/products/${edit.id}`, body); else await post("/products", body); notify(edit ? t("کالا ویرایش شد.") : t("کالا ثبت شد.")); setEdit(false); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const archive = async (product: Product) => { if (!window.confirm(t("کالای «{name}» از فهرست فروش پنهان شود؟", { name: product.name }))) return; try { await patch(`/products/${product.id}/archive`, {}); notify(t("کالا بایگانی شد.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const restore = async (product: Product) => { try { await patch(`/products/${product.id}/restore`, {}); notify(t("کالا به فهرست فروش بازگشت.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const readImportText = (text: string, fileName = "") => {
    setImportResult(null); setImportError(""); setImportRows([]); setImportSkipped(0);
    try {
      const mapped = mapImportRows(parseCsv(text));
      setImportRows(mapped.rows); setImportSkipped(mapped.skipped);
      if (!mapped.rows.length) setImportError(t("هیچ سطر معتبری در فایل پیدا نشد. از الگوی نمونه استفاده کنید."));
      else if (fileName) notify(t("«{name}» خوانده شد.", { name: fileName }));
    } catch { setImportError(t("خواندن فایل ممکن نشد. مطمئن شوید فایل CSV معتبر است.")); }
  };
  const pickImportFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => readImportText(String(reader.result || ""), file.name);
    reader.onerror = () => setImportError(t("خواندن فایل ممکن نشد."));
    reader.readAsText(file, "utf-8");
  };
  /** Months of use: on the desktop the OS file-picker does not always open
   *  inside the webview, so the same import also accepts a dragged file or
   *  text pasted straight from Excel. */
  const [importDrag, setImportDrag] = useState(false);
  const [importPaste, setImportPaste] = useState(false);
  const [importText, setImportText] = useState("");
  const applyImportPaste = () => { if (importText.trim()) readImportText(importText, t("متن چسبانده‌شده")); };
  const downloadTemplate = async () => {
    const rows = [importTemplateHeader(), ["روغن آفتابگردان", "G-1004", "1234567890", "120", "95", "24", "5", "عدد", "0", "2026-12-01", "خواربار"], ["شکر (کیلو)", "G-1005", "", "95", "70", "50", "10", "کیلوگرم", "1", "", "خواربار"]];
    try {
      const where = await saveTextFile("products-template.csv", toCsv(rows), "text/csv;charset=utf-8");
      if (where === CLIPBOARD_SAVED) notify(t("ذخیرهٔ فایل ممکن نشد؛ محتوای الگو در حافظه کپی شد — آن را در یک فایل متنی Paste کنید."));
      else if (where) notify(t("فایل ذخیره شد:") + " " + where);
    } catch (e) { setImportError((e as Error).message); }
  };
  const runImport = async () => {
    setImportBusy(true); setImportError("");
    try {
      const result = await post<ProductImportResult>("/products/import", { rows: importRows });
      setImportResult(result);
      notify(t("{created} کالا ساخته و {updated} کالا به‌روز شد.", { created: result.created, updated: result.updated }));
      await load();
    } catch (e) { setImportError((e as Error).message); } finally { setImportBusy(false); }
  };
  const printLabels = (product: Product) => {
    const code = product.barcode || product.sku;
    let barcodeMarkup = "";
    if (code) {
      try {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        JsBarcode(svg, code, { format: "CODE128", displayValue: false, margin: 0, height: 42, width: 1.5 });
        barcodeMarkup = svg.outerHTML;
      } catch { barcodeMarkup = ""; }
    }
    printHtml(labelsHtml(product, labelCount, barcodeMarkup, shop), { width: "auto", title: t("لیبل قیمت") });
  };
  return <div className="page-stack"><section className="surface"><SectionHead title={t("فهرست کالاها")} subtitle={t("{count} کالا {state} در سیستم ثبت شده است", { count: catalogTotal, state: archived ? t("بایگانی‌شده") : t("فعال") })} action={<div className="row-actions">{user.role === "ADMIN" && !archived && <button className="secondary-button" onClick={() => { setImportRows([]); setImportResult(null); setImportError(""); setShowImport(true); }}><FileInputIcon size={16}/>{t("ورود از فایل")}</button>}<button className="secondary-button" onClick={() => setArchived((value) => !value)}><Archive size={16}/> {archived ? t("بازگشت به کالاهای فعال") : t("بایگانی‌شده‌ها")}</button><button className="primary-button" onClick={openNew}><CirclePlus size={18}/>{t("کالای جدید")}</button></div>}/><div className="toolbar"><div className="search-box"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی نام، بارکد یا کد کالا…")}/></div><div className="toolbar-filters">{!archived && ([["all", t("همه")], ["low", t("کم‌موجود")], ["out", t("ناموجود")]] as const).map(([value, label]) => <button key={value} type="button" className={`chip ${stockFilter === value ? "active" : ""}`} onClick={() => setStockFilter(value)}>{label}</button>)}{categories.length > 0 && <select className="filter-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label={t("دسته‌بندی")}><option value="">{t("همهٔ دسته‌ها")}</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div><span className="toolbar-count">{catalogHasMore ? t("{shown} از {count} مورد", { shown: String(shown.length), count: String(catalogTotal) }) : `${shown.length} ${t("مورد")}`}</span></div>{error && <ErrorBox message={error}/>}<div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th>{(() => { const sortTh = (label: string, key: "name" | "sku" | "price" | "stock" | "expiry") => <SortTh key={key} label={label} active={sort.key === key} dir={sort.dir} onClick={() => setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" })}/>; return <>{sortTh(t("کالا"), "name")}{sortTh(t("کد کالا"), "sku")}<th>{t("دسته‌بندی")}</th>{sortTh(t("قیمت فروش"), "price")}{sortTh(t("موجودی"), "stock")}{sortTh(t("تاریخ انقضا"), "expiry")}<th>{t("وضعیت")}</th><th></th></>; })()}</tr></thead><tbody>{shown.map((p, idx) => { const days = expiryDays(p.expiryDate); return <tr key={p.id}><td className="muted mono">{idx + 1}</td><td><div className="cell-main"><span className="product-initial">{p.name.slice(0, 1)}</span><div><b>{p.name}</b><small>{p.barcode || p.unit}{p.isWeighted ? ` · ${t("وزنی")}` : ""}{p.isBundle ? ` · ${t("بسته (کیت)")}` : ""}{p.isSerialized ? ` · ${t("سریال‌دار")}` : ""}{(p.reserved || 0) > 0 ? ` · ${t("رزرو:")} ${qty(p.reserved || 0)}` : ""}</small></div></div></td><td className="mono">{p.sku}</td><td><span className="category-label">{p.category?.name || t("بدون دسته")}</span></td><td className="strong">{money(p.price)}{p.wholesalePrice != null && p.wholesaleMinQty != null && <small className="block muted">{t("عمده: {price} از {qty}", { price: money(p.wholesalePrice), qty: qty(p.wholesaleMinQty) })}</small>}</td><td><b className={(p.isBundle ? buildableKits(p) : p.stock) <= p.minStock ? "stock-low" : ""}>{qty(p.isBundle ? buildableKits(p) : p.stock)}</b> <small className="muted">{p.unit}</small></td><td className="muted">{p.expiryDate ? dateOnly(p.expiryDate) : "—"}</td><td><span className={`status-pill ${archived ? "neutral" : (p.isBundle ? buildableKits(p) : p.stock) <= p.minStock ? "warning" : "paid"}`}>{archived ? t("بایگانی") : (p.isBundle ? buildableKits(p) : p.stock) <= p.minStock ? t("کم‌موجود") : t("موجود")}</span>{days !== null && days <= 14 && <span className={`status-pill ${days < 0 ? "warning" : "neutral"}`}>{days < 0 ? t("منقضی") : t("{days} روز به انقضا", { days })}</span>}</td><td><div className="row-actions">{archived ? <button className="text-button" onClick={() => void restore(p)}><Undo2 size={14}/>{t("بازگردانی")}</button> : <><button className="text-button" onClick={() => openEdit(p)}>{t("ویرایش")}</button>{p.isBundle && user.role === "ADMIN" && <button className="text-button" onClick={() => setBundleFor2(p)}><PackagePlus size={14}/>{t("اجزای بسته")}</button>}<button className="text-button" onClick={() => { setLabelFor(p); setLabelCount(8); }}>{t("لیبل")}</button><button className="text-button danger-text" onClick={() => void archive(p)}>{t("بایگانی")}</button></>}</div></td></tr>; })}</tbody></table>{!shown.length && <Empty title={archived ? t("کالای بایگانی‌شده نیست") : t("کالایی پیدا نشد")} text={archived ? t("کالاهای بایگانی‌شده در اینجا فهرست می‌شوند.") : t("جست‌وجو را تغییر دهید یا کالای تازه اضافه کنید.")}/>}{catalogHasMore && <div className="load-more"><button className="secondary-button" disabled={moreBusy} onClick={() => void loadMore()}>{moreBusy ? t("در حال بارگذاری…") : t("نمایش کالاهای بیشتر")}</button><small className="muted">{t("{count} کالا بارگذاری شد", { count: products.length })}</small></div>}</div></section>
    {edit !== false && <Modal title={edit ? t("ویرایش کالا") : t("ثبت کالای جدید")} onClose={() => setEdit(false)}><form className="form-grid" onSubmit={save}><Field label={t("نام کالا")} full><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("مثلاً روغن آفتابگردان")}/></Field><Field label={t("کد کالا")}><input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="G-1004" dir="ltr"/></Field><Field label={t("بارکد")}><input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder={t("اسکن یا وارد کنید")} dir="ltr"/></Field><Field label={t("قیمت فروش (افغانی)")}><input required type="number" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: numberValue(e) })} dir="ltr"/></Field><Field label={t("قیمت عمده (اختیاری)")}><input type="number" min="0" value={form.wholesalePrice} onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })} placeholder={t("برای فروش عمده")} dir="ltr"/></Field><Field label={t("حداقل تعداد عمده")}><input type="number" min="0" step={form.isWeighted ? 0.001 : 1} value={form.wholesaleMinQty} onChange={(e) => setForm({ ...form, wholesaleMinQty: e.target.value })} placeholder={t("مثلاً 6")} dir="ltr"/></Field><Field label={t("قیمت خرید (افغانی)")}><input type="number" min="0" value={form.cost} onChange={(e) => setForm({ ...form, cost: numberValue(e) })} dir="ltr"/></Field><Field label={t("موجودی فعلی")}><input type="number" min="0" step={form.isWeighted ? 0.001 : 1} disabled={Boolean(edit)} value={form.stock} onChange={(e) => setForm({ ...form, stock: numberValue(e) })} dir="ltr"/></Field><Field label={t("حداقل موجودی")}><input type="number" min="0" step={form.isWeighted ? 0.001 : 1} value={form.minStock} onChange={(e) => setForm({ ...form, minStock: numberValue(e) })} dir="ltr"/></Field><Field label={t("واحد")}><input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={t("عدد، بسته، بوتل")}/></Field><Field label={t("نوع کالا")}><select value={form.isWeighted ? "weight" : form.isBundle ? "bundle" : form.isSerialized ? "serialized" : "piece"} onChange={(e) => setForm({ ...form, isWeighted: e.target.value === "weight", isBundle: e.target.value === "bundle", isSerialized: e.target.value === "serialized", unit: e.target.value === "weight" && form.unit === "عدد" ? "کیلوگرم" : form.unit })}><option value="piece">{t("شمارشی (عدد، بسته…)")}</option><option value="weight">{t("وزنی (کیلوگرم، با ترازو)")}</option><option value="serialized">{t("سریال‌دار (IMEI/سریال هر دستگاه)")}</option><option value="bundle">{t("بسته/کیت (اجزا از انبار کم می‌شوند)")}</option></select></Field><Field label={t("تاریخ انقضا (اختیاری)")}><DateField value={form.expiryDate || ""} onChange={(iso) => setForm({ ...form, expiryDate: iso })}/></Field><Field label={t("دسته‌بندی")}><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}><option value="">{t("بدون دسته")}</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>{error && <div className="form-error full">{error}</div>}<div className="form-actions full"><button type="button" className="secondary-button" onClick={() => setEdit(false)}>{t("انصراف")}</button><button className="primary-button" disabled={busy}>{busy ? t("در حال ذخیره…") : t("ذخیره کالا")}</button></div></form></Modal>}
    {showImport && <Modal title={t("ورود گروهی کالا از فایل")} wide onClose={() => setShowImport(false)}><div className="import-stack">
      <div className="hint-box">{t("فایل CSV را انتخاب کنید (در اکسسل «Save As → CSV UTF-8»). تطابق کالاها بر اساس بارکد، کد کالا و سپس نام انجام می‌شود؛ کالای موجود به‌روز شده و کالای تازه ساخته می‌شود.")}</div>
      <div className={`import-drop ${importDrag ? "drag" : ""}`} onDragOver={(event) => { event.preventDefault(); setImportDrag(true); }} onDragLeave={() => setImportDrag(false)} onDrop={(event) => { event.preventDefault(); setImportDrag(false); pickImportFile(event.dataTransfer.files?.[0]); }}><FileInputIcon size={22}/><div><b>{t("فایل CSV را اینجا رها کنید")}</b><small className="block muted">{t("یا با دکمهٔ زیر از پوشهٔ خود انتخاب کنید")}</small></div></div>
      <div className="row-actions"><label className="secondary-button import-file-button"><FileInputIcon size={16}/>{t("انتخاب فایل CSV")}<input type="file" accept=".csv,text/csv" hidden onChange={(event) => pickImportFile(event.target.files?.[0])}/></label><button type="button" className="text-button" onClick={() => setImportPaste((value) => !value)}>{t("چسباندن از اکسل")}</button><button type="button" className="text-button" onClick={() => void downloadTemplate()}>{t("دانلود الگوی نمونه")}</button></div>
      {importPaste && <div className="import-paste"><textarea rows={6} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={t("سلول‌ها را در اکسل کپی کنید و همین‌جا بچسبانید…")}/><button type="button" className="secondary-button" onClick={applyImportPaste}>{t("خواندن متن چسبانده‌شده")}</button></div>}
      {importError && <ErrorBox message={importError}/>}
      {importRows.length > 0 && !importResult && <div className="table-wrap"><table><thead><tr><th>{t("نام کالا")}</th><th>{t("بارکد")}</th><th>{t("قیمت فروش")}</th><th>{t("موجودی")}</th><th>{t("وزنی")}</th></tr></thead><tbody>{importRows.slice(0, 8).map((row, index) => <tr key={index}><td><b>{row.name}</b></td><td className="mono">{row.barcode || "—"}</td><td>{row.price ?? "—"}</td><td>{row.stock ?? "—"}</td><td>{row.isWeighted ? t("بله") : "—"}</td></tr>)}{importRows.length > 8 && <tr><td colSpan={5} className="muted">… {t("{count} سطر دیگر", { count: importRows.length - 8 })}</td></tr>}</tbody></table><div className="hint-box">{t("{count} سطر آمادهٔ ورود است.", { count: importRows.length })}{importSkipped > 0 ? ` ${t("{count} سطر ناقص نادیده گرفته شد.", { count: importSkipped })}` : ""}</div></div>}
      {importResult && <div className="hint-box">{t("نتیجه: {created} کالا ساخته شد، {updated} کالا به‌روز شد، {count} خطا.", { created: importResult.created, updated: importResult.updated, count: importResult.errors.length })}</div>}
      {importResult && importResult.errors.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("سطر")}</th><th>{t("خطا")}</th></tr></thead><tbody>{importResult.errors.slice(0, 10).map((item, index) => <tr key={index}><td className="mono">{item.row}</td><td>{item.message}</td></tr>)}</tbody></table></div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShowImport(false)}>{t("بستن")}</button><button className="primary-button" disabled={importBusy || !importRows.length || Boolean(importResult)} onClick={() => void runImport()}>{importBusy ? t("در حال ورود…") : t("شروع ورود")}</button></div>
    </div></Modal>}
    {bundleFor && <Modal title={t("اجزای بسته: {name}", { name: bundleFor.name })} onClose={() => setBundleFor(null)} wide>
      <form className="form-grid" onSubmit={saveBundle}>
        <div className="hint-box full">{t("با فروش این بسته، اجزای زیر از انبار کم می‌شوند؛ موجودی خود بسته ردیابی نمی‌شود.")}</div>
        {bundleRows.map((row, index) => <div className="bundle-row full" key={index}>
          <select value={row.componentId} onChange={(e) => setBundleRows(bundleRows.map((r, i) => i === index ? { ...r, componentId: e.target.value } : r))}><option value="">{t("انتخاب کالا…")}</option>{products.filter((p) => !p.isBundle && p.id !== bundleFor.id).map((p) => <option key={p.id} value={p.id}>{p.name} — {t("موجودی")}: {qty(p.stock)}</option>)}</select>
          <input type="number" min={products.find((p) => p.id === row.componentId)?.isWeighted ? 0.001 : 1} step={products.find((p) => p.id === row.componentId)?.isWeighted ? 0.001 : 1} dir="ltr" value={row.quantity} onChange={(e) => setBundleRows(bundleRows.map((r, i) => i === index ? { ...r, quantity: numberValue(e) } : r))}/>
          <button type="button" className="text-button danger-text" onClick={() => setBundleRows(bundleRows.length > 1 ? bundleRows.filter((_, i) => i !== index) : bundleRows)}><Trash2 size={15}/></button>
        </div>)}
        {bundleError && <div className="form-error full">{bundleError}</div>}
        <div className="form-actions full"><button type="button" className="secondary-button" onClick={() => setBundleRows([...bundleRows, { componentId: "", quantity: 1 }])}>{t("افزودن جزء")}</button><button className="primary-button" disabled={bundleBusy}>{bundleBusy ? t("در حال ذخیره…") : t("ذخیرهٔ اجزا")}</button></div>
      </form>
    </Modal>}
    {labelFor && <Modal title={t("چاپ لیبل قیمت")} onClose={() => setLabelFor(null)}><div className="form-grid single"><Field label={t("تعداد لیبل")}><input type="number" min="1" max="200" value={labelCount} onChange={(e) => setLabelCount(Math.min(200, Math.max(1, numberValue(e))))} dir="ltr"/></Field><div className="hint-box">{t("لیبل‌ها روی کاغذ A4 چاپ می‌شوند؛ نام کالا، بارکد و قیمت روی هر لیبل قرار می‌گیرد.")}{!labelFor.barcode ? ` ${t("این کالا بارکد ندارد؛ بدون بارکد چاپ می‌شود.")}` : ""}</div><div className="form-actions"><button className="secondary-button" onClick={() => setLabelFor(null)}>{t("انصراف")}</button><button className="primary-button" onClick={() => { printLabels(labelFor); setLabelFor(null); }}><Printer size={17}/>{t("چاپ")}</button></div></div></Modal>}
  </div>;
}


export function CategoriesPage({ notify }: { notify: Notify }) {
  const [categories, setCategories] = useState<Category[]>([]); const [name, setName] = useState(""); const [color, setColor] = useState("#7488a3"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => get<Category[]>("/categories").then(setCategories).catch((e) => setError(e.message)); useEffect(() => { void load(); }, []);
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await post("/categories", { name, color }); setName(""); notify(t("دسته‌بندی ثبت شد.")); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="split-layout"><section className="surface"><SectionHead title={t("دسته‌بندی‌ها")} subtitle={t("کالاها را برای دسترسی آسان گروه‌بندی کنید")}/>{error && <ErrorBox message={error}/>}<div className="category-grid">{categories.map((c) => <article className="category-card" key={c.id}><span style={{ background: c.color }}/><div><b>{c.name}</b><small>{c._count?.products ?? 0} {t("کالا")}</small></div></article>)}</div>{!categories.length && <Empty title={t("دسته‌ای ثبت نشده")} text={t("برای شروع یک دسته‌بندی بسازید.")}/>}</section><section className="surface"><SectionHead title={t("دسته تازه")} subtitle={t("نام و رنگ دسته را انتخاب کنید")}/><form className="form-grid single" onSubmit={save}><Field label={t("نام دسته")}><input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("مثلاً نوشیدنی")}/></Field><Field label={t("رنگ دسته")}><div className="color-picker"><input type="color" value={color} onChange={(e) => setColor(e.target.value)}/><span>{color}</span></div></Field><button className="primary-button" disabled={busy}><CirclePlus size={17}/>{t("افزودن دسته")}</button></form></section></div>;
}

export function ContactsPage({ kind, notify }: { kind: "customers" | "suppliers"; notify: Notify }) {
  const [contacts, setContacts] = useState<Contact[]>([]); const [query, setQuery] = useState(""); const [contactSort, setContactSort] = useState<{ key: "name" | "balance"; dir: "asc" | "desc" }>({ key: "name", dir: "asc" }); const [debtOnly, setDebtOnly] = useState(false); const [show, setShow] = useState(false); const [editing, setEditing] = useState<Contact | null>(null); const [form, setForm] = useState<{ name: string; phone: string; address: string; note: string; creditLimit: number; tier: "RETAIL" | "WHOLESALE" }>({ name: "", phone: "", address: "", note: "", creditLimit: 0, tier: "RETAIL" }); const [error, setError] = useState(""); const [account, setAccount] = useState<CustomerDetail | SupplierDetail | null>(null); const [payForm, setPayForm] = useState({ amount: 0, note: "", fromCash: false }); const [payBusy, setPayBusy] = useState(false); const [shop, setShop] = useState<ShopSettings>({}); const [walletForm, setWalletForm] = useState({ amount: 0, note: "", fromCash: false }); const [walletBusy, setWalletBusy] = useState(false); const title = kind === "customers" ? t("مشتریان") : t("تأمین‌کنندگان"); const endpoint = `/${kind}`;
  const load = () => get<Contact[]>(endpoint).then(setContacts).catch((e) => setError(e.message)); useEffect(() => { void load(); }, [endpoint]); useEffect(() => { get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const openAccount = (contact: Contact) => { setPayForm({ amount: 0, note: "", fromCash: false }); get<CustomerDetail | SupplierDetail>(`${endpoint}/${contact.id}`).then(setAccount).catch((e) => notify(e.message, "error")); };
  const submitPayment = async (event: FormEvent) => {
    event.preventDefault();
    if (!account) return;
    const contactId = "customer" in account ? account.customer.id : account.supplier.id;
    setPayBusy(true);
    try {
      await post(`${endpoint}/${contactId}/payments`, { amount: payForm.amount, note: payForm.note || undefined, ...(kind === "suppliers" && payForm.fromCash ? { fromCash: true } : {}) });
      notify(kind === "customers" ? t("پرداخت نسیه ثبت شد.") : t("پرداخت به تأمین‌کننده ثبت شد."));
      const fresh = await get<CustomerDetail | SupplierDetail>(`${endpoint}/${contactId}`);
      setAccount(fresh); setPayForm({ amount: 0, note: "", fromCash: false });
    } catch (e) { notify((e as Error).message, "error"); } finally { setPayBusy(false); }
  };
  const submitWalletCharge = async (event: FormEvent) => {
    event.preventDefault();
    if (!account || !("customer" in account)) return;
    setWalletBusy(true);
    try {
      await post(`/customers/${account.customer.id}/wallet/charge`, { amount: walletForm.amount, note: walletForm.note || undefined, fromCash: walletForm.fromCash || undefined });
      notify(t("کیف پول شارژ شد."));
      const fresh = await get<CustomerDetail>(`/customers/${account.customer.id}`);
      setAccount(fresh); setWalletForm({ amount: 0, note: "", fromCash: false });
    } catch (e) { notify((e as Error).message, "error"); } finally { setWalletBusy(false); }
  };
  // Months of use: chase debtors — filter to owing customers and sort by
  // outstanding balance (or name) instead of a fixed alphabetical list.
  const filtered = contacts
    .filter((c) => `${c.name} ${c.phone || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .filter((c) => !debtOnly || (c.balance || 0) > 0)
    .sort((a, b) => contactSort.key === "balance"
      ? (contactSort.dir === "asc" ? (a.balance || 0) - (b.balance || 0) : (b.balance || 0) - (a.balance || 0))
      : (contactSort.dir === "asc" ? a.name.localeCompare(b.name, "fa") : b.name.localeCompare(a.name, "fa")));
  const open = (contact?: Contact) => { setEditing(contact || null); setForm(contact ? { name: contact.name, phone: contact.phone || "", address: contact.address || "", note: contact.note || "", creditLimit: contact.creditLimit || 0, tier: contact.tier === "WHOLESALE" ? "WHOLESALE" : "RETAIL" } : { name: "", phone: "", address: "", note: "", creditLimit: 0, tier: "RETAIL" }); setShow(true); };
  const save = async (event: FormEvent) => { event.preventDefault(); setError(""); try { const payload = kind === "customers" ? { ...form, creditLimit: Math.max(0, Number(form.creditLimit) || 0) } : form; if (editing) await patch(`${endpoint}/${editing.id}`, payload); else await post(endpoint, payload); setShow(false); notify(t("{title} ذخیره شد.", { title })); await load(); } catch (e) { setError((e as Error).message); } };
  // Exports the rows on screen — search, "فقط بدهکار" and the column sort.
  const exportContacts = (kindOfExport: "csv" | "pdf") => {
    const header = [t("نام"), kind === "customers" ? t("بدهی نسیه") : t("بدهی"), t("سقف اعتبار"), t("کیف پول"), t("شماره تماس"), t("نشانی"), t("یادداشت")];
    const rows: Array<Array<string | number>> = filtered.map((c) => [c.name, c.balance || 0, c.creditLimit || 0, c.walletBalance || 0, c.phone || "", c.address || "", c.note || ""]);
    const filename = kind === "customers" ? "customers" : "suppliers";
    if (kindOfExport === "csv") { void exportCsvFile(`${filename}.csv`, [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title, subtitle: `${filtered.length} ${t("مورد")}${debtOnly ? ` · ${t("فقط بدهکار")}` : ""}`, columns: [{ label: t("نام") }, { label: kind === "customers" ? t("بدهی نسیه") : t("بدهی"), numeric: true }, { label: t("سقف اعتبار"), numeric: true }, { label: t("کیف پول"), numeric: true }, { label: t("شماره تماس"), numeric: true }, { label: t("نشانی") }, { label: t("یادداشت") }], rows, summary: [[t("جمع بدهی"), money(filtered.reduce((sum, c) => sum + (c.balance || 0), 0))]] }, shop.shopName);
  };
  return <div className="page-stack"><section className="surface"><SectionHead title={t("فهرست {title}", { title })} subtitle={t("{count} مورد ثبت شده", { count: contacts.length })} action={<button className="primary-button" onClick={() => open()}><CirclePlus size={18}/>{t("افزودن")} {kind === "customers" ? t("مشتری") : t("تأمین‌کننده")}</button>}/><div className="toolbar"><div className="search-box"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی نام یا شماره تماس…")}/></div><button type="button" className={`chip ${debtOnly ? "active" : ""}`} onClick={() => setDebtOnly((value) => !value)}>{t("فقط بدهکار")}</button><ExportMenu onExport={exportContacts} disabled={!filtered.length}/><span className="toolbar-count">{filtered.length} {t("مورد")}</span></div>{error && <ErrorBox message={error}/>}<div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th>{(() => { const contactSortTh = (label: string, key: "name" | "balance") => <SortTh key={key} label={label} active={contactSort.key === key} dir={contactSort.dir} onClick={() => setContactSort(contactSort.key === key ? { key, dir: contactSort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "balance" ? "desc" : "asc" })}/>; return <>{contactSortTh(t("نام"), "name")}{contactSortTh(kind === "customers" ? t("بدهی نسیه") : t("بدهی"), "balance")}<th>{t("شماره تماس")}</th><th>{t("نشانی")}</th><th>{t("یادداشت")}</th><th></th></>; })()}</tr></thead><tbody>{filtered.map((c, idx) => <tr key={c.id}><td className="muted mono">{idx + 1}</td><td><div className="cell-main"><span className="avatar pale">{c.name.slice(0, 1)}</span><b>{c.name}</b></div></td><td><b className={(c.balance || 0) > 0 ? "danger-text" : (c.balance || 0) < 0 ? "green-text" : "muted"}>{(c.balance || 0) > 0 ? money(c.balance!) : (c.balance || 0) < 0 ? `${t("بستانکار:")} ${money(Math.abs(c.balance!))}` : t("تسویه")}</b>{kind === "customers" && (c.creditLimit || 0) > 0 && <small className="block muted">{t("سقف اعتبار: {limit}", { limit: money(c.creditLimit!) })}</small>}{kind === "customers" && (c.walletBalance || 0) > 0 && <small className="block green-text">{t("کیف پول")}: {money(c.walletBalance!)}</small>}{kind === "customers" && c.tier === "WHOLESALE" && <small className="block muted">{t("مشتری عمده")}</small>}</td><td dir="ltr" className="text-right">{c.phone || "—"}</td><td>{c.address || "—"}</td><td className="muted">{c.note || "—"}</td><td><div className="row-actions"><button className="text-button" onClick={() => openAccount(c)}><Wallet size={14}/>{t("حساب")}</button><button className="text-button" onClick={() => open(c)}>{t("ویرایش")}</button></div></td></tr>)}</tbody></table>{!filtered.length && <Empty title={t("موردی پیدا نشد")} text={t("اطلاعات را بررسی کنید یا مورد تازه‌ای ثبت کنید.")}/>}</div></section>
    {show && <Modal title={`${editing ? t("ویرایش") : t("افزودن")} ${kind === "customers" ? t("مشتری") : t("تأمین‌کننده")}`} onClose={() => setShow(false)}><form className="form-grid" onSubmit={save}><Field label={t("نام")} full><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></Field><Field label={t("شماره تماس")}><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} dir="ltr"/></Field><Field label={t("نشانی")}><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}/></Field><Field label={t("یادداشت")} full><textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}/></Field>{kind === "customers" && <Field label={t("سقف اعتبار نسیه (افغانی)")}><input type="number" min="0" value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: numberValue(e) })} placeholder={t("۰ = بدون سقف")}/></Field>}{kind === "customers" && <Field label={t("گروه قیمت")}><select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value as "RETAIL" | "WHOLESALE" })}><option value="RETAIL">{t("خرده‌فروشی")}</option><option value="WHOLESALE">{t("عمده‌فروشی (قیمت عمده در هر تعداد)")}</option></select></Field>}{error && <div className="form-error full">{error}</div>}<div className="form-actions full"><button type="button" className="secondary-button" onClick={() => setShow(false)}>{t("انصراف")}</button><button className="primary-button">{t("ذخیره")}</button></div></form></Modal>}
    {account && <Modal title={"customer" in account ? t("حساب نسیهٔ {name}", { name: account.customer.name }) : t("حساب {name}", { name: account.supplier.name })} onClose={() => setAccount(null)}>
      {"customer" in account ? <>
        <div className="metric-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}><Metric icon={Wallet} label={t("مانده حساب")} value={account.balance >= 0 ? money(account.balance) : `${t("بستانکار")} ${money(Math.abs(account.balance))}`} note={account.balance > 0 ? t("نسیهٔ پرداخت‌نشده") : account.balance < 0 ? t("پیش‌پرداخت — به نفع شما") : t("تسویه")} tone={account.balance > 0 ? "amber" : "green"}/><Metric icon={ShoppingCart} label={t("فروش نسیه")} value={money(account.creditSales)} note={t("مجموع فاکتورهای نسیه")} tone="violet"/><Metric icon={Check} label={t("پرداخت‌شده")} value={money(account.creditReturns + account.paymentsTotal)} note={t("برگشتی + وصولی")} tone="blue"/><Metric icon={ShieldCheck} label={t("سقف اعتبار")} value={account.customer.creditLimit ? money(account.customer.creditLimit) : t("نامحدود")} note={account.customer.creditLimit && account.balance > account.customer.creditLimit ? t("از سقف گذشته است") : t("کنترل هنگام فروش نسیه")} tone={account.customer.creditLimit && account.balance > account.customer.creditLimit ? "amber" : "green"}/><Metric icon={Banknote} label={t("ماندهٔ کیف پول")} value={money(account.walletBalance || 0)} note={account.customer.tier === "WHOLESALE" ? t("مشتری عمده‌فروشی") : t("پیش‌پرداخت — قابل خرج در صندوق")} tone={(account.walletBalance || 0) > 0 ? "blue" : "green"}/></div>
        <form className="form-grid single" onSubmit={submitWalletCharge} style={{ marginTop: "0.5rem" }}><Field label={t("شارژ کیف پول (افغانی)")}><input required type="number" min="1" value={walletForm.amount} onChange={(e) => setWalletForm({ ...walletForm, amount: numberValue(e) })}/></Field><Field label={t("یادداشت")}><input value={walletForm.note} onChange={(e) => setWalletForm({ ...walletForm, note: e.target.value })} placeholder={t("اختیاری")}/></Field><label className="checkbox-row"><input type="checkbox" checked={walletForm.fromCash} onChange={(e) => setWalletForm({ ...walletForm, fromCash: e.target.checked })}/>{t("مبلغ از صندوق باز دریافت شود")}</label><div className="form-actions"><button className="primary-button" disabled={walletBusy || walletForm.amount <= 0}>{walletBusy ? t("در حال ثبت…") : t("شارژ کیف پول")}</button></div></form>
        {(account.walletTxns || []).length > 0 && <div className="table-wrap" style={{ marginTop: "0.5rem" }}><table><thead><tr><th>{t("نوع")}</th><th>{t("مبلغ")}</th><th>{t("یادداشت")}</th><th>{t("زمان")}</th></tr></thead><tbody>{account.walletTxns!.map((txn) => <tr key={txn.id}><td>{txn.type === "CHARGE" ? t("شارژ") : txn.type === "SALE" ? t("خرید از کیف پول") : t("برگشت به کیف پول")}</td><td className={txn.type === "SALE" ? "danger-text" : "green-text"}>{txn.type === "SALE" ? "−" : "+"}{money(txn.amount)}</td><td className="muted">{txn.note || "—"}</td><td className="muted">{dateTime(txn.createdAt)}</td></tr>)}</tbody></table></div>}
      </>
        : <div className="metric-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}><Metric icon={Wallet} label={t("مانده حساب")} value={account.balance >= 0 ? money(account.balance) : `${t("بستانکار")} ${money(Math.abs(account.balance))}`} note={account.balance > 0 ? t("خریدهای پرداخت‌نشده") : account.balance < 0 ? t("پرداختِ اضافه — به نفع شما") : t("تسویه")} tone={account.balance > 0 ? "amber" : "green"}/><Metric icon={Truck} label={t("جمع خریدها")} value={money(account.purchasesTotal)} note={t("از این تأمین‌کننده")} tone="violet"/><Metric icon={Check} label={t("پرداخت‌شده")} value={money(account.paidAtPurchase + account.paymentsTotal)} note={t("هنگام خرید + بعد از آن")} tone="blue"/></div>}
      <form className="form-grid single" onSubmit={submitPayment}><Field label={kind === "customers" ? t("ثبت پرداخت نسیه (افغانی)") : t("ثبت پرداخت به تأمین‌کننده (افغانی)")}><input required type="number" min="1" autoFocus value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: numberValue(e) })}/></Field><Field label={t("یادداشت")}><input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} placeholder={t("اختیاری")}/></Field>{kind === "customers" && payForm.amount > 0 && account.balance > 0 && payForm.amount > account.balance && <div className="hint-box">{t("این مبلغ از مانده بدهی ({amount}) بیشتر است؛ مازاد به‌عنوان اعتبار ثبت می‌شود.", { amount: money(account.balance) })}</div>}{kind === "suppliers" && <label className="checkbox-row"><input type="checkbox" checked={payForm.fromCash} onChange={(e) => setPayForm({ ...payForm, fromCash: e.target.checked })}/>{t("مبلغ از صندوق باز پرداخت شود (خروج نقد)")}</label>}<div className="form-actions">{kind === "customers" && <button type="button" className="secondary-button" onClick={() => void printDebtReceipt(account as CustomerDetail, shop)}><Printer size={16}/>{t("چاپ سند بدهی")}</button>}<button type="button" className="secondary-button" onClick={() => setAccount(null)}>{t("بستن")}</button><button className="primary-button" disabled={payBusy || payForm.amount <= 0}>{payBusy ? t("در حال ثبت…") : t("ثبت پرداخت")}</button></div></form>
      {account.payments.length ? <div className="table-wrap"><table><thead><tr><th>{t("مبلغ")}</th><th>{t("یادداشت")}</th><th>{t("ثبت‌کننده")}</th><th>{t("زمان")}</th></tr></thead><tbody>{account.payments.map((p) => <tr key={p.id}><td className="strong green-text">{money(p.amount)}</td><td className="muted">{p.note || "—"}</td><td>{p.user?.displayName || "—"}</td><td className="muted">{dateTime(p.createdAt)}</td></tr>)}</tbody></table></div> : <Empty title={t("پرداختی ثبت نشده")} text={kind === "customers" ? t("پرداخت‌های نسیهٔ این مشتری در اینجا دیده می‌شوند.") : t("پرداخت‌های این تأمین‌کننده در اینجا دیده می‌شوند.")}/>}
      {kind === "customers" && "customer" in account && <InstallmentsPanel customerId={account.customer.id} notify={notify}/>}
      {kind === "suppliers" && (account as SupplierDetail).recentPurchases.length > 0 && <div className="table-wrap" style={{ marginTop: "0.75rem" }}><table><thead><tr><th>{t("رسید خرید")}</th><th>{t("مبلغ")}</th><th>{t("پرداخت‌شده")}</th><th>{t("زمان")}</th></tr></thead><tbody>{(account as SupplierDetail).recentPurchases.map((purchase) => <tr key={purchase.id} className={purchase.voidedAt ? "voided-row" : ""}><td className="mono">{purchase.invoiceNo || "—"}{purchase.voidedAt && <span className="status-pill warning">{t("ابطال‌شده")}</span>}</td><td className="strong">{money(purchase.total)}</td><td>{money(purchase.paidAmount)}{purchase.paidAmount < purchase.total && <small className="block stock-low">{t("بدهی:")} {money(purchase.total - purchase.paidAmount)}</small>}</td><td className="muted">{dateTime(purchase.createdAt)}</td></tr>)}</tbody></table></div>}
    </Modal>}
  </div>;
}

/** A parked (held) POS order — client-side only, never sent to the server. */
type HeldOrder = { id: string; at: string; label: string; customerId: string; items: Array<{ productId: string; quantity: number }> };
const HELD_KEY = "darpos-held-orders";
function readHeldOrders(): HeldOrder[] {
  try { const raw = localStorage.getItem(HELD_KEY); const parsed = raw ? JSON.parse(raw) as HeldOrder[] : []; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function writeHeldOrders(orders: HeldOrder[]): void {
  try { localStorage.setItem(HELD_KEY, JSON.stringify(orders)); } catch { /* storage unavailable */ }
}

// ── POS favorites (per device) ──────────────────────────────────────────────
// How often each product was added to the cart on THIS register, persisted in
// localStorage: cashiers mostly sell the same goods every day, so a compact
// strip of the top items saves them the search. Deliberately local — each
// register builds its own list, deleted products drop out automatically.
const FAVORITES_KEY = "darpos-pos-favorites";
function readPosFavorites(): Record<string, number> {
  try { const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}") as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {}; } catch { return {}; }
}
function bumpPosFavorite(id: string): void {
  try {
    const counts = readPosFavorites();
    counts[id] = (counts[id] || 0) + 1;
    // Keep the map tiny: only the 40 most-added products are worth storing.
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Object.fromEntries(top)));
  } catch { /* storage unavailable */ }
}
function clearPosFavorites(): void {
  try { localStorage.removeItem(FAVORITES_KEY); } catch { /* storage unavailable */ }
}

export function PosPage({ notify, user, active = true }: { notify: Notify; user: User; active?: boolean }) {
  const [products, setProducts] = useState<Product[]>([]); const [customers, setCustomers] = useState<Contact[]>([]); const [cash, setCash] = useState<CashSession | null>(null); const [query, setQuery] = useState(""); const [cart, setCart] = useState<Record<string, number>>({}); const [customerId, setCustomerId] = useState(""); const [payment, setPayment] = useState<"CASH" | "MOBILE" | "CREDIT" | "MIXED" | "WALLET">("CASH");
  const [serials, setSerials] = useState<Record<string, string>>({}); const [serialOptions, setSerialOptions] = useState<Record<string, string[]>>({}); const fetchedSerials = useRef<Set<string>>(new Set()); const [discount, setDiscount] = useState(0); const [discountPercent, setDiscountPercent] = useState(0); const [lineDiscounts, setLineDiscounts] = useState<Record<string, number>>({}); const [discountLine, setDiscountLine] = useState<string | null>(null); const [paid, setPaid] = useState(0); const [splitCash, setSplitCash] = useState(0); const [splitMobile, setSplitMobile] = useState(0); const [error, setError] = useState(""); const [saving, setSaving] = useState(false); const [receipt, setReceipt] = useState<Sale | null>(null); const [shop, setShop] = useState<ShopSettings>({}); const [pendingOverride, setPendingOverride] = useState<Record<string, unknown> | null>(null); const [offlineCount, setOfflineCount] = useState(() => readOfflineQueue().length);
  const [showHeld, setShowHeld] = useState(false); const [held, setHeld] = useState<HeldOrder[]>(readHeldOrders);
  const [favorites, setFavorites] = useState<Record<string, number>>(readPosFavorites);
  const searchRef = useRef<HTMLInputElement>(null); const paidRef = useRef<HTMLInputElement>(null); const lastSaleRef = useRef<Sale | null>(null);
  /** Effective unit price: wholesale-tier customers always buy wholesale;
   *  otherwise wholesale applies once the line reaches the minimum. */
  const selectedCustomer = customers.find((c) => c.id === customerId);
  const isWholesaleTier = selectedCustomer?.tier === "WHOLESALE";
  const unitPriceFor = (product: Product, quantity: number): number => (product.wholesalePrice != null && (isWholesaleTier || (product.wholesaleMinQty != null && quantity >= product.wholesaleMinQty)) ? product.wholesalePrice : product.price);
  /** Stock a walk-in can actually sell: open pre-orders reserve the rest. */
  const freeStock = (product: Product): number => product.isBundle ? buildableKits(product) : product.stock - (product.reserved || 0);
  const lineGross = (product: Product, quantity: number): number => Math.round(unitPriceFor(product, quantity) * quantity);
  const lineTotalOf = (product: Product, quantity: number): number => Math.max(0, lineGross(product, quantity) - Math.min(lineDiscounts[product.id] || 0, lineGross(product, quantity)));
  // Shop settings (incl. the logo data-URL and print options) are fetched
  // once per mount — re-downloading them after every checkout only added
  // latency to the next sale.
  const load = () => Promise.all([get<Product[]>("/products"), get<Contact[]>("/customers"), get<CashSession | null>("/cash/current")]).then(([p, c, s]) => { setProducts(p); setCustomers(c); setCash(s); }).catch((e) => setError(e.message));
  useEffect(() => { get<ShopSettings>("/settings").then(setShop).catch((e) => setError(e.message)); }, []);
  // صفحه در حافظه می‌ماند، پس موجودی/مشتری‌ها باید با هر بازگشت تازه شوند:
  // قیمت و موجودی آزاد در صفحه‌های دیگر (خرید، مرجوعی، سفارش…) عوض می‌شود.
  useEffect(() => { if (active) void load(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // فوکوس جست‌وجو با هر بازگشت به صندوق (مثل قبل که با mount تازه می‌افتاد).
  useEffect(() => { if (active) searchRef.current?.focus(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const cartItems = useMemo(() => Object.entries(cart).map(([id, quantity]) => { const product = products.find((p) => p.id === id)!; return { product, quantity }; }).filter((line) => line.product), [cart, products]);
  // In-stock serials for the pickers, fetched once per product (or kit
  // component) while the basket needs them.
  useEffect(() => {
    const ids = new Set<string>();
    for (const { product, quantity: lineQty } of cartItems) for (const group of serialGroups(product, lineQty)) ids.add(group.key);
    const missing = [...ids].filter((id) => !fetchedSerials.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => fetchedSerials.current.add(id));
    let alive = true;
    Promise.all(missing.map((id) => get<Array<{ serial: string }>>(`/inventory/serials?productId=${id}&status=IN_STOCK`)))
      .then((lists) => { if (!alive) return; setSerialOptions((previous) => { const next = { ...previous }; missing.forEach((id, index) => { next[id] = lists[index].map((row) => row.serial); }); return next; }); })
      .catch(() => { if (alive) missing.forEach((id) => fetchedSerials.current.delete(id)); });
    return () => { alive = false; };
  }, [cartItems]);
  const subtotal = cartItems.reduce((sum, line) => sum + lineTotalOf(line.product, line.quantity), 0);
  // Percentage and flat discounts never stack; the percentage wins the tie.
  const flatDiscount = discountPercent > 0 ? Math.min(subtotal, Math.round((subtotal * discountPercent) / 100)) : Math.min(discount, subtotal);
  const total = Math.max(0, subtotal - flatDiscount);
  const mixedRemainder = Math.max(0, total - splitCash - splitMobile);
  useEffect(() => { if (payment === "CASH" || payment === "MOBILE") { if (payment !== "CASH") setPaid(total); else if (paid === 0 || paid < total) setPaid(total); } }, [total, payment]);
  // A shrinking total clamps the mixed parts so the invoice never
  // over-collects (the checkout button double-checks the sum).
  useEffect(() => { if (payment === "MIXED") { setSplitCash((current) => Math.min(current, total)); setSplitMobile((current) => Math.min(current, Math.max(0, total))); } }, [payment, total]);
  // Register keyboard shortcuts: F1 search, F4 park, F6 received amount,
  // F9 reprint the last receipt. F2 (POS itself) lives in App.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active) return; // صفحه در حافظه است ولی دیده نمی‌شود
      if (event.key === "F1") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (event.key === "F4") { event.preventDefault(); if (cartItems.length) { parkOrder(); } }
      else if (event.key === "F6") { event.preventDefault(); if (payment === "CASH" || payment === "MOBILE") paidRef.current?.focus(); }
      else if (event.key === "F9") { event.preventDefault(); if (lastSaleRef.current) void printSaleReceipt(lastSaleRef.current, shop); }
      else if (event.altKey && /^[1-9]$/.test(event.key)) { event.preventDefault(); const quick = filtered[Number(event.key) - 1]; if (quick && freeStock(quick) > 0) add(quick); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const filtered = products.filter((p) => `${p.name} ${p.sku} ${p.barcode || ""}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  // The favorites strip shows this register's most-added items, but only
  // while the search box is empty so it never competes with search results.
  const favoriteItems = query.trim() ? [] : Object.entries(favorites)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => products.find((p) => p.id === id))
    .filter((p): p is Product => Boolean(p))
    .slice(0, 8);
  // Customer display (second window): every cart change is broadcast; the
  // display window re-renders from these snapshots without any IPC.
  useEffect(() => {
    try {
      const channel = new BroadcastChannel("darpos-display");
      channel.postMessage({ shop: shop.shopName || "", customer: customers.find((c) => c.id === customerId)?.name || "", items: cartItems.map(({ product, quantity }) => ({ name: product.name, quantity, lineTotal: lineTotalOf(product, quantity) })), total, count: cartItems.length, at: new Date().toISOString() });
      channel.close();
    } catch { /* display window not supported */ }
  }, [cartItems, total, customerId, shop, customers]);
  const add = (product: Product, amount = 1) => { setError(""); bumpPosFavorite(product.id); setFavorites(readPosFavorites()); setCart((previous) => { const current = previous[product.id] || 0; if (current + amount > freeStock(product)) { setError(t("موجودی {name} بیشتر از {stock} نیست.", { name: product.name, stock: qty(freeStock(product)) })); return previous; } return { ...previous, [product.id]: current + amount }; }); setPaid(total); };
  /** Exact quantity entry for weighted goods (e.g. 1.25 kg). */
  const setExact = (id: string, value: number) => setCart((previous) => {
    const rounded = Math.round(value * 1000) / 1000;
    if (!(rounded > 0)) { const copy = { ...previous }; delete copy[id]; return copy; }
    const product = products.find((p) => p.id === id);
    if (product && rounded > freeStock(product)) { setError(t("موجودی {name} کافی نیست.", { name: product.name })); return previous; }
    return { ...previous, [id]: rounded };
  });
  const scan = (event: FormEvent) => {
    event.preventDefault();
    const code = query.trim();
    // Scale (weight) barcodes: 2 + 5-digit PLU + 5-digit grams + check digit.
    // Matching relies on the product SKU holding the scale's PLU code.
    if (/^2\d{12}$/.test(code)) {
      const plu = code.slice(1, 6);
      const weight = Number(code.slice(6, 11)) / 1000;
      const scaled = products.find((p) => p.sku === plu);
      if (scaled && weight > 0) { scannerBeep((cart[scaled.id] || 0) + weight <= scaled.stock); add(scaled, Math.round(weight * 1000) / 1000); setQuery(""); return; }
    }
    const exact = products.find((p) => p.barcode === code || p.sku.toLowerCase() === code.toLowerCase());
    if (exact) { scannerBeep((cart[exact.id] || 0) + 1 <= exact.stock); add(exact); setQuery(""); }
    else if (code) { scannerBeep(false); setError(t("کالایی با این بارکد یا کد پیدا نشد.")); }
  };
  const quantity = (id: string, change: number) => setCart((previous) => { const next = (previous[id] || 0) + change; if (next <= 0) { const copy = { ...previous }; delete copy[id]; return copy; } const product = products.find((p) => p.id === id); if (product && next > freeStock(product)) { setError(t("موجودی {name} کافی نیست.", { name: product.name })); return previous; } return { ...previous, [id]: next }; });
  const parkOrder = () => {
    if (!cartItems.length) return;
    const order: HeldOrder = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      label: customerId ? customers.find((c) => c.id === customerId)?.name || "" : "",
      customerId,
      items: cartItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
    };
    const next = [order, ...held].slice(0, 20);
    setHeld(next); writeHeldOrders(next);
    setCart({}); setDiscount(0); setDiscountPercent(0); setLineDiscounts({}); setSerials({}); setCustomerId(""); setPaid(0); setSplitCash(0); setSplitMobile(0);
    notify(t("فاکتور معلق شد (F4 برای معلق‌کردن)."));
  };
  const resumeOrder = (order: HeldOrder) => {
    const restored: Record<string, number> = {};
    let missing = 0;
    for (const item of order.items) {
      const product = products.find((p) => p.id === item.productId);
      if (!product) { missing += 1; continue; }
      restored[item.productId] = (restored[item.productId] || 0) + item.quantity;
    }
    setCart(restored); setCustomerId(order.customerId || ""); setPaid(0);
    const next = held.filter((entry) => entry.id !== order.id);
    setHeld(next); writeHeldOrders(next); setShowHeld(false);
    if (missing) notify(t("{count} قلم از این فاکتور دیگر موجود نیست و اضافه نشد.", { count: missing }), "error");
  };
  const dropHeld = (order: HeldOrder) => {
    const next = held.filter((entry) => entry.id !== order.id);
    setHeld(next); writeHeldOrders(next);
  };
  /** Adds every line of the customer's previous invoice (stock permitting). */
  const repeatLastPurchase = async () => {
    if (!customerId) return;
    try {
      const last = await get<Sale>(`/sales/customer/${customerId}/last`);
      let added = 0;
      let skipped = 0;
      for (const item of last.items) {
        const product = products.find((p) => p.id === item.productId);
        if (!product) { skipped += 1; continue; }
        const current = cart[product.id] || 0;
        if (current + item.quantity > freeStock(product)) { skipped += 1; continue; }
        setCart((previous) => ({ ...previous, [product.id]: (previous[product.id] || 0) + item.quantity }));
        added += 1;
      }
      notify(added || skipped ? t("{added} قلم از آخرین خرید افزوده شد؛ {skipped} قلم به‌خاطر نبود موجودی جا ماند.", { added, skipped }) : t("آخرین خرید این مشتری خالی بود."), added ? "success" : "error");
    } catch (e) { notify((e as Error).message, "error"); }
  };
  const resetAfterSale = () => { setCart({}); setDiscount(0); setDiscountPercent(0); setLineDiscounts({}); setDiscountLine(null); setCustomerId(""); setPaid(0); setSplitCash(0); setSplitMobile(0); setSerials({}); /* shelf lists are stale now — the picked units are SOLD */ fetchedSerials.current.clear(); setSerialOptions({}); };
  /** Runs one checkout attempt. Network failures park the basket in the
   *  offline queue; a credit-limit rejection asks an admin to confirm. */
  const doCheckout = async (payload: Record<string, unknown>) => {
    setSaving(true); setError("");
    try {
      const sale = await post<Sale>("/sales", payload, { "Idempotency-Key": crypto.randomUUID() });
      setReceipt(sale); lastSaleRef.current = sale; resetAfterSale(); await load();
      notify(t("فروش با موفقیت ثبت شد.")); scannerBeep();
      if (shop.autoPrintReceipt === "1") void printSaleReceipt(sale, shop);
    } catch (e) {
      if (e instanceof TypeError) {
        // Server unreachable: park the basket; the retry loop (30s) or the
        // manual button will post it with the same idempotency key later.
        const label = `${cartItems.length} ${t("قلم")} · ${money(total)}${customerId ? ` · ${customers.find((c) => c.id === customerId)?.name || ""}` : ""}`;
        enqueueOfflineSale(label, total, payload);
        setOfflineCount(readOfflineQueue().length);
        resetAfterSale();
        setError(t("ارتباط با سرور برقرار نشد؛ فاکتور در صف آفلاین ذخیره شد و خودکار دوباره ارسال می‌شود."));
      } else {
        const message = (e as Error).message;
        if (message.includes("سقف اعتبار") && user.role === "ADMIN" && !payload.overrideCreditLimit) setPendingOverride(payload);
        else setError(message);
      }
    } finally { setSaving(false); }
  };
  const checkout = () => {
    if (!cartItems.length) return;
    if (flatDiscount > subtotal) { setError(t("تخفیف نمی‌تواند بیشتر از جمع فاکتور باشد.")); return; }
    if (payment === "MIXED" && mixedRemainder > 0 && !customerId) { setError(t("برای بخش نسیهٔ پرداخت ترکیبی، ابتدا مشتری را انتخاب کنید.")); return; }
    if (payment === "WALLET" && !customerId) { setError(t("برای پرداخت از کیف پول، ابتدا مشتری را انتخاب کنید.")); return; }
    if (payment === "WALLET" && (selectedCustomer?.walletBalance ?? 0) < total) { setError(t("ماندهٔ کیف پول مشتری برای این فاکتور کافی نیست.")); return; }
    // Serialized products (and kits with serialized components) must name
    // every unit handed over (IMEI/serial).
    for (const { product, quantity: lineQty } of cartItems) {
      const need = serializedNeed(product, lineQty);
      if (!need) continue;
      const entered = (serials[product.id] || "").split(/[\n,،\s]+/).filter(Boolean);
      if (entered.length !== need) {
        setError(product.isBundle
          ? t("برای «{name}» سریال/IMEI اجزای سریال‌دار را وارد کنید ({count} مورد).", { name: product.name, count: String(need) })
          : t("برای «{name}» سریال/IMEI هر دستگاه را وارد کنید ({count} مورد).", { name: product.name, count: String(need) }));
        return;
      }
    }
    const items = cartItems.map(({ product, quantity: lineQty }) => ({ productId: product.id, quantity: lineQty, discount: Math.min(lineDiscounts[product.id] || 0, lineGross(product, lineQty)) || undefined, ...(serializedNeed(product, lineQty) > 0 ? { serials: (serials[product.id] || "").split(/[\n,،\s]+/).filter(Boolean) } : {}) }));
    const invoiceDiscount = discountPercent > 0 ? { discountPercent } : { discount };
    const payload: Record<string, unknown> =
      payment === "MIXED" ? { items, customerId: customerId || undefined, paymentMethod: "CREDIT", splitCash, splitMobile, ...invoiceDiscount }
      : payment === "WALLET" ? { items, customerId, paymentMethod: "WALLET", ...invoiceDiscount }
      : payment === "CREDIT" ? { items, customerId: customerId || undefined, paymentMethod: "CREDIT", amountPaid: 0, ...invoiceDiscount }
      : { items, customerId: customerId || undefined, paymentMethod: payment, amountPaid: paid, ...invoiceDiscount };
    void doCheckout(payload);
  };
  // Offline queue: retry parked baskets every 30s and whenever the POS opens.
  // Rejections (4xx) drop the entry with a warning — the server already saw it.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (!readOfflineQueue().length) return;
      const synced = await flushOfflineQueue((result) => {
        if (stopped) return;
        if (result.ok) notify(t("یک فاکتور آفلاین با موفقیت ثبت شد."), "success");
        else if (!result.retry && result.message) notify(t("یک فاکتور آفلاین رد شد: {message}", { message: result.message }), "error");
      });
      if (stopped) return;
      setOfflineCount(readOfflineQueue().length);
      if (synced) void load();
    };
    void tick();
    const timer = setInterval(() => void tick(), 30000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const retryOfflineNow = async () => {
    const synced = await flushOfflineQueue((result) => {
      if (result.ok) notify(t("یک فاکتور آفلاین با موفقیت ثبت شد."), "success");
      else if (!result.retry && result.message) notify(t("یک فاکتور آفلاین رد شد: {message}", { message: result.message }), "error");
    });
    setOfflineCount(readOfflineQueue().length);
    if (synced) { void load(); notify(t("{count} فاکتور آفلاین ثبت شد.", { count: synced }), "success"); }
    else if (readOfflineQueue().length) setError(t("سرور هنوز در دسترس نیست؛ فاکتورها در صف آفلاین باقی می‌مانند."));
  };
  return <div className="pos-layout">
    <section className="pos-products surface"><div className="pos-title"><div><h2>{t("انتخاب کالا")}</h2><p>{t("بارکد را اسکن یا نام کالا را جست‌وجو کنید.")}</p></div><span className="live-status"><i/>{t("آماده")}</span></div><form className="search-box pos-search" onSubmit={scan}><Search size={19}/><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Tab" && !e.shiftKey && query.trim() && scannerSettings().endKey !== "enter") { e.preventDefault(); void scan(e as unknown as FormEvent); } }} placeholder={t("نام کالا، بارکد یا بارکد ترازو…")} ref={searchRef}/><kbd>F1</kbd></form>{error && <ErrorBox message={error}/>}{favoriteItems.length > 0 && <div className="pos-favorites"><div className="pos-favorites-head"><small>{t("کالاهای پرتکرار این دستگاه")}</small><button type="button" className="text-button" onClick={() => { clearPosFavorites(); setFavorites({}); }} title={t("فهرست پرتکرارها بر اساس فروش همین دستگاه ساخته می‌شود.")}>{t("پاک‌کردن")}</button></div><div className="pos-favorites-grid">{favoriteItems.map((p) => <button type="button" key={p.id} className={`pos-favorite ${p.stock <= 0 ? "disabled" : ""}`} disabled={p.stock <= 0} onClick={() => add(p)}><span className="pos-favorite-art" style={{ background: p.category?.color || "#8494a5" }}>{p.name.slice(0, 1)}</span><span className="pos-favorite-name">{p.name}</span><b>{money(p.price)}</b></button>)}</div></div>}<div className="pos-product-grid">{filtered.map((p, index) => <button key={p.id} className={`pos-product ${freeStock(p) <= 0 ? "disabled" : ""}`} disabled={freeStock(p) <= 0} onClick={() => add(p)} title={p.isBundle ? t("بسته — تعداد قابل‌ساخت از اجزا") : undefined}>{index < 9 && <span className="pos-quick-badge" title={t("افزودن با Alt + {number}", { number: index + 1 })}>{index + 1}</span>}<div className="pos-product-art" style={{ background: p.category?.color || "#8494a5" }}>{p.name.slice(0, 1)}</div><span className="pos-product-name">{p.name}</span><span className="pos-product-bottom"><b>{money(p.price)}</b><small className={freeStock(p) <= p.minStock ? "stock-low" : ""}>{qty(freeStock(p))} {p.unit}</small></span></button>)}{!filtered.length && <Empty title={t("کالایی پیدا نشد")} text={t("نام یا بارکد دیگری را جست‌وجو کنید.")}/>}</div></section>
    <aside className="cart-panel surface"><div className="cart-heading"><div><h2>{t("فاکتور فروش")}</h2><p>{cartItems.reduce((n, line) => n + line.quantity, 0)} {t("قلم کالا")}</p></div><div className="row-actions">{offlineCount > 0 && <button className="text-button amber-text" onClick={() => void retryOfflineNow()} title={t("ارسال دوبارهٔ فاکتورهای ذخیره‌شدهٔ آفلاین")}><RefreshCw size={14}/>{t("صف آفلاین")} ({offlineCount})</button>}{held.length > 0 && <button className="text-button" onClick={() => setShowHeld(true)}><Pause size={14}/>{t("معلق‌ها")} ({held.length})</button>}<button className="text-button" onClick={parkOrder} disabled={!cartItems.length} title="F4"><Pause size={14}/>{t("معلق")}</button><button className="text-button danger-text" onClick={() => setCart({})}>{t("پاک‌کردن")}</button></div></div><div className="cart-lines">{cartItems.length ? cartItems.map(({ product, quantity: lineQty }) => <article className="cart-line" key={product.id} style={{ flexWrap: "wrap" }}><div className="cart-line-title"><b>{product.name}</b><small>{money(unitPriceFor(product, lineQty))} / {product.unit}{unitPriceFor(product, lineQty) === product.wholesalePrice && product.wholesalePrice != null ? ` · ${t("قیمت عمده")}` : ""}</small></div><div className="quantity-control"><button onClick={() => quantity(product.id, -1)}>−</button>{product.isWeighted ? <input className="qty-input" type="number" dir="ltr" min="0.001" step="0.001" value={lineQty} onChange={(e) => setExact(product.id, Number(e.target.value) || 0)} title={t("مقدار (کیلوگرم)")} aria-label={t("مقدار (کیلوگرم)")}/> : <b>{lineQty}</b>}<button onClick={() => quantity(product.id, 1)}>+</button></div><strong>{money(lineTotalOf(product, lineQty))}</strong><button type="button" className={`text-button ${lineDiscounts[product.id] ? "" : "muted"}`} style={{ padding: 2 }} title={t("تخفیف این قلم")} onClick={() => setDiscountLine((current) => (current === product.id ? null : product.id))}><Percent size={14}/>{lineDiscounts[product.id] ? ` −${money(lineDiscounts[product.id])}` : ""}</button>{discountLine === product.id && <div className="discount-line" style={{ flexBasis: "100%" }}><span>{t("تخفیف این قلم (افغانی)")}</span><input type="number" min="0" max={lineGross(product, lineQty)} value={lineDiscounts[product.id] || 0} onChange={(e) => { const next = Math.max(0, numberValue(e)); setLineDiscounts((previous) => ({ ...previous, [product.id]: next })); }}/></div>}{serializedNeed(product, lineQty) > 0 && <div className="discount-line serial-line" style={{ flexBasis: "100%" }}>{serialGroups(product, lineQty).map((group) => <SerialPicker key={group.key} label={group.label} need={group.need} available={serialOptions[group.key] || []} value={serials[product.id] || ""} onChange={(next) => setSerials((previous) => ({ ...previous, [product.id]: next }))}/>)}</div>}{product.isBundle && <small className="block muted" style={{ flexBasis: "100%" }}>{t("بسته — اجزای آن از انبار کم می‌شود")} {(product.bundleComponents || []).map((row) => `${row.component?.name || "?"} × ${row.quantity}`).join(" + ")}</small>}</article>) : <div className="cart-empty"><div><ShoppingBag size={24}/></div><b>{t("فاکتور خالی است")}</b><span>{t("برای افزودن کالا روی آن بزنید.")}</span></div>}</div>
      <div className="cart-options"><label className="compact-field"><span>{t("مشتری")}</span><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">{t("مشتری گذری")}</option>{customers.filter((c) => c.name !== "مشتری گذری").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{customerId && <button type="button" className="secondary-button" title={t("افزودن همهٔ اقلام آخرین فاکتور این مشتری")} onClick={() => void repeatLastPurchase()}><History size={16}/>{t("تکرار آخرین خرید")}</button>}{customerId && selectedCustomer && <span className={`chip ${isWholesaleTier ? "active" : ""}`} title={t("گروه قیمت مشتری")}>{isWholesaleTier ? t("قیمت عمده") : t("قیمت خرده‌فروشی")}</span>}{customerId && selectedCustomer && <span className="chip" title={t("ماندهٔ کیف پول مشتری")}>{t("کیف پول")}: {money(selectedCustomer.walletBalance || 0)}</span>}<label className="compact-field"><span>{t("روش پرداخت")}</span><select value={payment} onChange={(e) => { const next = e.target.value as typeof payment; setPayment(next); if (next === "MIXED") { setSplitCash(total); setSplitMobile(0); } }}><option value="CASH">{t("نقدی")}</option><option value="MOBILE">{t("پرداخت موبایلی")}</option><option value="MIXED">{t("ترکیبی (نقد + موبایل + نسیه)")}</option><option value="CREDIT">{t("قرض / نسیه")}</option>{customerId && <option value="WALLET">{t("کیف پول مشتری")}</option>}</select></label>{payment !== "MIXED" && <div className="discount-line"><span>{t("تخفیف (افغانی)")}</span><input type="number" min="0" max={subtotal} value={discount} disabled={discountPercent > 0} onChange={(e) => setDiscount(numberValue(e))}/></div>}{payment !== "MIXED" && <div className="discount-line"><span>{t("تخفیف درصدی (٪)")}</span><input type="number" min="0" max="100" value={discountPercent} onChange={(e) => { const value = numberValue(e); setDiscountPercent(value); if (value > 0) setDiscount(0); }}/></div>}{payment === "MIXED" ? <>
        <div className="discount-line"><span>{t("بخش نقدی")}</span><input type="number" min="0" max={total} value={splitCash} onChange={(e) => setSplitCash(Math.max(0, Math.min(numberValue(e), total)))}/></div>
        <div className="discount-line"><span>{t("بخش موبایلی")}</span><input type="number" min="0" max={Math.max(0, total - splitCash)} value={splitMobile} onChange={(e) => setSplitMobile(Math.max(0, Math.min(numberValue(e), Math.max(0, total - splitCash))))}/></div>
        <div className="discount-line"><span>{t("تخفیف (افغانی)")}</span><input type="number" min="0" max={subtotal} value={discount} onChange={(e) => setDiscount(numberValue(e))}/></div>
      </> : payment !== "CREDIT" && <div className="discount-line"><span>{payment === "CASH" ? t("مبلغ دریافتی") : t("مبلغ پرداخت‌شده")}</span><input type="number" min={payment === "CASH" ? total : 0} value={paid} onChange={(e) => setPaid(numberValue(e))} ref={paidRef}/></div>}</div>
      <div className="cart-totals"><div><span>{t("جمع کالاها")}</span><b>{money(subtotal)}</b></div>{flatDiscount > 0 && <div><span>{discountPercent > 0 ? t("تخفیف ({percent}٪)", { percent: discountPercent }) : t("تخفیف")}</span><b className="danger-text">− {money(flatDiscount)}</b></div>}<div className="grand-total"><span>{t("مبلغ نهایی")}</span><strong>{money(total)}</strong></div>{payment === "CASH" && paid > total && <div><span>{t("باقی‌پول مشتری")}</span><b>{money(paid - total)}</b></div>}{payment === "MIXED" && <div><span>{t("نقد + موبایل")}</span><b>{money(Math.min(total, splitCash + splitMobile))}</b></div>}{payment === "MIXED" && mixedRemainder > 0 && <div><span>{t("باقی‌مانده نسیه")}</span><b className="danger-text">{money(mixedRemainder)}</b></div>}</div>
      {!cash && <div className="error-box cash-warning"><AlertTriangle size={16}/>{t("صندوق باز نیست؛ برای فروش نقدی ابتدا صندوق را باز کنید.")}</div>}<button className="checkout-button" disabled={!cartItems.length || saving || (payment === "CASH" && !cash) || (payment === "MIXED" && splitCash > 0 && !cash) || ((payment === "CASH" || payment === "MOBILE") && paid < total) || (payment === "MIXED" && splitCash + splitMobile > total) || (payment === "WALLET" && (!customerId || (selectedCustomer?.walletBalance ?? 0) < total))} onClick={() => checkout()}><Check size={19}/>{saving ? t("در حال ثبت فروش…") : t("ثبت فروش")}<span>{money(total)}</span></button><div className="cart-footnote"><ShieldCheck size={14}/>{t("ثبت فروش و کاهش موجودی باهم ذخیره می‌شوند.")}</div><div className="cart-footnote pos-shortcuts"><kbd>F1</kbd> {t("جستجو")} · <kbd>F4</kbd> {t("معلق")} · <kbd>F6</kbd> {t("مبلغ دریافتی")} · <kbd>F9</kbd> {t("چاپ آخرین رسید")}</div>
    </aside>
    {showHeld && <Modal title={t("فاکتورهای معلق")} onClose={() => setShowHeld(false)}>{held.length ? <div className="hold-list">{held.map((order) => <div className="hold-row" key={order.id}><div className="grow"><b>{order.label || t("بدون نام")}</b><small>{dateTime(order.at)} · {order.items.reduce((n, item) => n + item.quantity, 0)} {t("قلم کالا")}</small></div><button className="text-button" onClick={() => resumeOrder(order)}><Check size={14}/>{t("ادامه")}</button><button className="text-button danger-text" onClick={() => dropHeld(order)}><Trash2 size={14}/>{t("حذف")}</button></div>)}</div> : <Empty title={t("فاکتور معلقی نیست")} text={t("با کلید F4 فاکتور جاری را معلق کنید تا بعداً ادامه دهید.")}/>}</Modal>}
    {pendingOverride && <Modal title={t("عبور از سقف اعتبار مشتری")} onClose={() => setPendingOverride(null)}><div className="form-note"><AlertTriangle size={16}/>{t("این فاکتور ماندهٔ نسیهٔ مشتری را از سقف اعتبارش بیشتر می‌کند. به‌عنوان مدیر می‌توانید با تأیید، فروش را ثبت کنید.")}</div><div className="form-actions"><button className="secondary-button" onClick={() => setPendingOverride(null)}>{t("انصراف")}</button><button className="primary-button" onClick={() => { const payload = pendingOverride; setPendingOverride(null); void doCheckout({ ...payload, overrideCreditLimit: true }); }}><Check size={16}/>{t("تأیید و ثبت فروش")}</button></div></Modal>}
    {receipt && <Modal title={t("فروش ثبت شد")} onClose={() => setReceipt(null)}><div className="receipt-print"><div className="receipt-brand">{shop.shopName?.trim() || t("فروشگاه من")}</div><div className="receipt-divider"/><div className="receipt-meta"><span>{t("شماره فاکتور")}</span><b>{receipt.invoiceNo || receipt.receiptNo}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(receipt.createdAt)}</b></div><div className="receipt-meta"><span>{t("مشتری")}</span><b>{receipt.customer?.name || "مشتری گذری"}</b></div><div className="receipt-divider"/>{receipt.items.map((item) => <div className="receipt-item" key={item.id}><span>{item.name} × {item.quantity}</span><b>{money(item.lineTotal)}</b></div>)}<div className="receipt-divider"/><div className="receipt-meta"><span>{t("جمع کل")}</span><strong>{money(receipt.total)}</strong></div>{receipt.discount > 0 && <div className="receipt-meta"><span>{t("تخفیف")}</span><b>{money(receipt.discount)}</b></div>}{(receipt.cashPart || 0) + (receipt.mobilePart || 0) + (receipt.creditPart || 0) + (receipt.walletPart || 0) > 0 && <div className="receipt-meta"><span>{t("پرداخت")}</span><b>{receipt.cashPart ? `${t("نقدی")} ${money(receipt.cashPart)}` : ""}{receipt.cashPart && (receipt.mobilePart || receipt.walletPart) ? " + " : ""}{receipt.mobilePart ? `${t("موبایلی")} ${money(receipt.mobilePart)}` : ""}{receipt.mobilePart && receipt.walletPart ? " + " : ""}{receipt.walletPart ? `${t("کیف پول")} ${money(receipt.walletPart)}` : ""}{receipt.creditPart ? `${receipt.cashPart || receipt.mobilePart || receipt.walletPart ? " + " : ""}${t("نسیه")} ${money(receipt.creditPart)}` : ""}</b></div>}<p className="receipt-thanks">{shop.receiptFooter?.trim() || t("از خرید شما سپاس‌گزاریم")}</p></div><div className="form-actions"><button className="secondary-button" onClick={() => setReceipt(null)}>{t("بستن")}</button><button className="primary-button" onClick={() => void printSaleReceipt(receipt, shop)}><Printer size={17}/>{t("چاپ رسید")}</button></div></Modal>}
  </div>;
}

type InventoryMovement = { id: string; type: string; quantity: number; stockAfter: number; reference: string | null; note: string | null; createdAt: string; product: { name: string; sku: string; unit: string } };
export function InventoryPage({ notify }: { notify: Notify }) {
  const [view, setView] = useState<"movements" | "batches" | "stocktakes">("movements");
  const [movements, setMovements] = useState<InventoryMovement[]>([]); const [products, setProducts] = useState<Product[]>([]); const [batches, setBatches] = useState<ProductBatch[]>([]); const [stocktakes, setStocktakes] = useState<Stocktake[]>([]);
  const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const [show, setShow] = useState(false); const [form, setForm] = useState({ productId: "", quantity: 1, direction: "IN", note: "" });
  const [showTransfer, setShowTransfer] = useState(false); const [transfer, setTransfer] = useState({ productId: "", quantity: 1, direction: "TO_BACKROOM" });
  const [showCount, setShowCount] = useState(false); const [count, setCount] = useState<{ name: string; note: string; apply: boolean; counted: Record<string, number> }>({ name: "", note: "", apply: false, counted: {} }); const [countQuery, setCountQuery] = useState("");
  const load = () => {
    const loaders: Array<Promise<unknown>> = [get<InventoryMovement[]>("/inventory/movements"), get<Product[]>("/products")];
    if (view === "batches") loaders.push(get<ProductBatch[]>("/inventory/batches"));
    if (view === "stocktakes") loaders.push(get<Stocktake[]>("/stocktakes?skip=0&take=50"));
    return Promise.all(loaders).then((results) => {
      setMovements(results[0] as InventoryMovement[]); setProducts(results[1] as Product[]);
      if (results[2] !== undefined) setBatches(results[2] as ProductBatch[]);
      if (results[3] !== undefined) setStocktakes(results[3] as Stocktake[]);
      setForm((old) => (old.productId ? old : { ...old, productId: (results[1] as Product[])[0]?.id || "" }));
    }).catch((e) => setError(e.message));
  };
  useEffect(() => { void load(); }, [view]);
  const filtered = movements.filter((m) => `${m.product.name} ${m.product.sku} ${m.reference || ""}`.toLowerCase().includes(query.toLowerCase()));
  const exportInventory = (kindOfExport: "csv" | "pdf") => {
    if (view === "batches") {
      const header = [t("کالا"), t("کد کالا"), t("تاریخ انقضا"), t("مقدار باقی‌مانده"), t("مقدار اولیه")];
      const rows: Array<Array<string | number>> = batches.map((b) => [b.product?.name || "—", b.product?.sku || "", dateOnly(b.expiryDate), b.remainingQty, b.initialQty]);
      if (kindOfExport === "csv") { void exportCsvFile("expiry-batches.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
      exportTablePdf({ title: t("دسته‌های انقضا"), subtitle: `${batches.length} ${t("دسته")}`, columns: [{ label: t("کالا") }, { label: t("کد کالا"), numeric: true }, { label: t("تاریخ انقضا") }, { label: t("مقدار باقی‌مانده"), numeric: true }, { label: t("مقدار اولیه"), numeric: true }], rows });
      return;
    }
    if (view === "stocktakes") {
      const header = [t("نام / توضیح"), t("وضعیت"), t("اقلام"), t("شمارنده"), t("زمان")];
      const rows: Array<Array<string | number>> = stocktakes.map((entry) => [entry.name || entry.id.slice(0, 8), entry.status === "APPLIED" ? t("اعمال‌شده") : entry.status === "OPEN" ? t("باز") : t("ابطال‌شده"), entry._count?.lines ?? 0, entry.user?.displayName || "—", dateTime(entry.createdAt)]);
      if (kindOfExport === "csv") { void exportCsvFile("stocktakes.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
      exportTablePdf({ title: t("شمارش‌ها"), subtitle: `${stocktakes.length} ${t("شمارش")}`, columns: [{ label: t("نام / توضیح") }, { label: t("وضعیت") }, { label: t("اقلام"), numeric: true }, { label: t("شمارنده") }, { label: t("زمان") }], rows });
      return;
    }
    const header = [t("کالا"), t("کد کالا"), t("نوع گردش"), t("تعداد"), t("موجودی پس از عملیات"), t("مرجع / توضیح"), t("زمان")];
    const rows: Array<Array<string | number>> = filtered.map((m) => [m.product.name, m.product.sku, movementLabel(m.type), m.quantity, m.stockAfter, m.reference || m.note || "", dateTime(m.createdAt)]);
    if (kindOfExport === "csv") { void exportCsvFile("stock-movements.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("گردش موجودی"), subtitle: `${filtered.length} ${t("گردش")}`, columns: [{ label: t("کالا") }, { label: t("کد کالا"), numeric: true }, { label: t("نوع گردش") }, { label: t("تعداد"), numeric: true }, { label: t("موجودی پس از عملیات"), numeric: true }, { label: t("مرجع / توضیح") }, { label: t("زمان") }], rows, landscape: true });
  };
  const save = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await post("/inventory/adjust", { productId: form.productId, quantity: form.direction === "IN" ? Math.abs(form.quantity) : -Math.abs(form.quantity), note: form.note || undefined }); setShow(false); notify(t("موجودی انبار تعدیل شد.")); await load(); } catch (e) { setError((e as Error).message); } };
  const saveTransfer = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await post("/inventory/transfer", transfer); setShowTransfer(false); notify(t("انتقال بین قفسهٔ فروش و انبار پشتیبان ثبت شد.")); await load(); } catch (e) { setError((e as Error).message); } };
  const countLines = Object.entries(count.counted).filter(([, value]) => value > 0);
  const saveCount = async (event: FormEvent) => { event.preventDefault(); setError(""); if (!countLines.length) { setError(t("دست‌کم یک کالا را بشمارید.")); return; } try { await post("/stocktakes", { name: count.name || undefined, note: count.note || undefined, apply: count.apply, lines: countLines.map(([productId, counted]) => ({ productId, counted })) }); setShowCount(false); setCount({ name: "", note: "", apply: false, counted: {} }); setView("stocktakes"); notify(count.apply ? t("شمارش ثبت و اعمال شد.") : t("شمارش ذخیره شد؛ بعداً می‌توانید اعمالش کنید.")); await load(); } catch (e) { setError((e as Error).message); } };
  const applyStocktake = async (record: Stocktake) => { if (!window.confirm(t("موجودی کالاها با مقادیر شمرشده جایگزین می‌شود. ادامه می‌دهید؟"))) return; try { await post(`/stocktakes/${record.id}/apply`, {}); notify(t("شمارش اعمال شد.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const voidStocktake = async (record: Stocktake) => { if (!window.confirm(t("این شمارش ابطال شود؟ موجودی تغییری نمی‌کند."))) return; try { await post(`/stocktakes/${record.id}/void`, {}); notify(t("شمارش ابطال شد.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const countFiltered = products.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(countQuery.toLowerCase())).slice(0, 150);
  return <div className="page-stack"><div className="metric-grid inventory-metrics"><Metric icon={Boxes} label={t("تعداد کالاها")} value={String(products.length)} note={t("کالاهای فعال")} tone="blue"/><Metric icon={Package} label={t("قفسهٔ فروش")} value={qty(products.reduce((n, p) => n + p.stock, 0))} note={t("جمع موجودی قابل فروش")} tone="green"/><Metric icon={Archive} label={t("انبار پشتیبان")} value={qty(products.reduce((n, p) => n + (p.backstock || 0), 0))} note={t("جمع موجودی پشتیبان")} tone="violet"/><Metric icon={AlertTriangle} label={t("زیر حداقل موجودی")} value={String(products.filter((p) => p.stock <= p.minStock).length)} note={t("نیازمند سفارش یا بررسی")} tone="amber"/></div>
    <section className="surface"><SectionHead title={t("موجودی انبار")} subtitle={t("گردش، دسته‌های انقضا و شمارش")} action={<div className="row-actions"><button className="secondary-button" onClick={() => { setShowTransfer(true); setTransfer({ productId: products[0]?.id || "", quantity: 1, direction: "TO_BACKROOM" }); }}><ArrowLeftRight size={17}/>{t("انتقال انبار پشتیبان")}</button><button className="secondary-button" onClick={() => { setShowCount(true); setCount({ name: "", note: "", apply: false, counted: {} }); setCountQuery(""); }}><ClipboardList size={17}/>{t("شمارش انبار")}</button><button className="primary-button" onClick={() => setShow(true)}><ArrowDownUp size={17}/>{t("تعدیل موجودی")}</button></div>}/>
      <div className="toolbar"><div className="segmented"><button className={view === "movements" ? "active" : ""} onClick={() => setView("movements")}>{t("گردش موجودی")}</button><button className={view === "batches" ? "active" : ""} onClick={() => setView("batches")}>{t("دسته‌های انقضا")}</button><button className={view === "stocktakes" ? "active" : ""} onClick={() => setView("stocktakes")}>{t("شمارش‌ها")}</button></div>{view === "movements" && <div className="search-box"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی کالا یا شماره فاکتور…")}/></div>}<ExportMenu onExport={exportInventory} disabled={view === "movements" ? !filtered.length : view === "batches" ? !batches.length : !stocktakes.length}/><span className="toolbar-count">{view === "movements" ? `${filtered.length} ${t("گردش")}` : view === "batches" ? `${batches.length} ${t("دسته")}` : `${stocktakes.length} ${t("شمارش")}`}</span></div>
      {error && <ErrorBox message={error}/>}
      {view === "movements" && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("نوع گردش")}</th><th>{t("تعداد")}</th><th>{t("موجودی پس از عملیات")}</th><th>{t("مرجع / توضیح")}</th><th>{t("زمان")}</th></tr></thead><tbody>{filtered.map((m, idx) => <tr key={m.id}><td className="muted mono">{idx + 1}</td><td><b>{m.product.name}</b><small className="block muted">{m.product.sku}</small></td><td><span className={`status-pill ${m.quantity >= 0 ? "paid" : "warning"}`}>{movementLabel(m.type)}</span></td><td className={m.quantity < 0 ? "danger-text" : "green-text"}>{m.quantity > 0 ? "+" : ""}{qty(m.quantity)} {m.product.unit}</td><td>{qty(m.stockAfter)} {m.product.unit}</td><td className="muted">{m.reference || m.note || "—"}</td><td className="muted">{dateTime(m.createdAt)}</td></tr>)}</tbody></table>{!filtered.length && <Empty title={t("گردشی ثبت نشده")} text={t("ورود و خروج کالاها پس از ثبت نمایش داده می‌شود.")}/>}</div>}
      {view === "batches" && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("تاریخ انقضا")}</th><th>{t("مقدار باقی‌مانده")}</th><th>{t("مقدار اولیه")}</th><th>{t("وضعیت")}</th></tr></thead><tbody>{batches.map((b, idx) => { const days = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / 86400000); return <tr key={b.id}><td className="muted mono">{idx + 1}</td><td><b>{b.product?.name || "—"}</b><small className="block muted">{b.product?.sku}</small></td><td>{dateOnly(b.expiryDate)}</td><td>{qty(b.remainingQty)} {b.product?.unit || ""}</td><td className="muted">{qty(b.initialQty)}</td><td><span className={`status-pill ${days < 0 ? "unpaid" : days <= 14 ? "warning" : "paid"}`}>{days < 0 ? t("منقضی") : days <= 14 ? t("{days} روز مانده", { days }) : t("سالم")}</span></td></tr>; })}</tbody></table>{!batches.length && <Empty title={t("دسته‌ای ثبت نشده")} text={t("خریدهایی که تاریخ انقضای جدا داشته باشند، به‌صورت دسته دنبال می‌شوند.")}/>}</div>}
      {view === "stocktakes" && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("نام / توضیح")}</th><th>{t("وضعیت")}</th><th>{t("اقلام")}</th><th>{t("شمارنده")}</th><th>{t("زمان")}</th><th></th></tr></thead><tbody>{stocktakes.map((s, idx) => <tr key={s.id}><td className="muted mono">{idx + 1}</td><td><b>{s.name || s.id.slice(0, 8)}</b>{s.note && <small className="block muted">{s.note}</small>}</td><td><span className={`status-pill ${s.status === "APPLIED" ? "paid" : s.status === "OPEN" ? "warning" : "unpaid"}`}>{s.status === "APPLIED" ? t("اعمال‌شده") : s.status === "OPEN" ? t("باز") : t("ابطال‌شده")}</span></td><td>{s._count?.lines ?? "—"}</td><td>{s.user?.displayName || "—"}</td><td className="muted">{dateTime(s.createdAt)}</td><td>{s.status === "OPEN" && <div className="row-actions"><button className="text-button" onClick={() => void applyStocktake(s)}><Check size={14}/>{t("اعمال")}</button><button className="text-button danger-text" onClick={() => void voidStocktake(s)}><X size={14}/>{t("ابطال")}</button></div>}</td></tr>)}</tbody></table>{!stocktakes.length && <Empty title={t("شمارشی ثبت نشده")} text={t("با دکمهٔ «شمارش انبار» یک شمارش جدید ثبت کنید.")}/>}{stocktakes.length >= 50 && <div className="load-more"><button className="secondary-button" onClick={() => { get<Stocktake[]>(`/stocktakes?skip=${stocktakes.length}&take=50`).then((rows) => setStocktakes((current) => [...current, ...rows])).catch((e) => setError(e.message)); }}>{t("نمایش شمارش‌های بیشتر")}</button></div>}</div>}
    </section>
    {show && <Modal title={t("تعدیل موجودی")} onClose={() => setShow(false)}><form className="form-grid single" onSubmit={save}><Field label={t("کالا")}><select required value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}><option value="">{t("انتخاب کالا")}</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} — {qty(p.stock)} {p.unit}</option>)}</select></Field><Field label={t("نوع عملیات")}><select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="IN">{t("افزایش موجودی")}</option><option value="OUT">{t("کاهش موجودی")}</option></select></Field><Field label={t("تعداد")}><input type="number" required min="1" value={Math.abs(form.quantity)} onChange={(e) => setForm({ ...form, quantity: numberValue(e) })}/></Field><Field label={t("یادداشت")}><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("دلیل تعدیل")}/></Field>{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShow(false)}>{t("انصراف")}</button><button className="primary-button">{t("ثبت تعدیل")}</button></div></form></Modal>}
    {showTransfer && <Modal title={t("انتقال انبار پشتیبان")} onClose={() => setShowTransfer(false)}><form className="form-grid single" onSubmit={saveTransfer}><Field label={t("کالا")}><select required value={transfer.productId} onChange={(e) => setTransfer({ ...transfer, productId: e.target.value })}>{products.map((p) => <option key={p.id} value={p.id}>{p.name} — {t("قفسه")}: {qty(p.stock)} / {t("پشتیبان")}: {qty(p.backstock || 0)}</option>)}</select></Field><Field label={t("جهت انتقال")}><select value={transfer.direction} onChange={(e) => setTransfer({ ...transfer, direction: e.target.value })}><option value="TO_BACKROOM">{t("از قفسهٔ فروش به انبار پشتیبان")}</option><option value="TO_SALES">{t("از انبار پشتیبان به قفسهٔ فروش")}</option></select></Field><Field label={t("تعداد")}><input type="number" required min={products.find((p) => p.id === transfer.productId)?.isWeighted ? 0.001 : 1} step={products.find((p) => p.id === transfer.productId)?.isWeighted ? 0.001 : 1} value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: numberValue(e) })}/></Field><div className="form-note"><Lightbulb size={15}/>{t("جمع موجودی تغییر نمی‌کند؛ فقط جای آن جابه‌جا می‌شود و در گردش ثبت می‌شود.")}</div>{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShowTransfer(false)}>{t("انصراف")}</button><button className="primary-button">{t("ثبت انتقال")}</button></div></form></Modal>}
    {showCount && <Modal title={t("شمارش انبار")} onClose={() => setShowCount(false)} wide><form className="form-grid single" onSubmit={saveCount}><div className="form-grid two"><Field label={t("نام شمارش")}><input value={count.name} onChange={(e) => setCount({ ...count, name: e.target.value })} placeholder={t("مثلاً شمارش پایان هفته")}/></Field><Field label={t("یادداشت")}><input value={count.note} onChange={(e) => setCount({ ...count, note: e.target.value })}/></Field></div><div className="toolbar"><div className="search-box"><Search size={17}/><input value={countQuery} onChange={(e) => setCountQuery(e.target.value)} placeholder={t("جست‌وجوی کالا برای شمارش…")}/></div><span className="muted">{t("{count} قلم شمرده شد", { count: countLines.length })}</span></div><div className="table-wrap count-sheet"><table><thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("موجودی سیستم")}</th><th>{t("مقدار شمرده‌شده")}</th><th>{t("اختلاف")}</th></tr></thead><tbody>{countFiltered.map((p, idx) => { const counted = count.counted[p.id]; const diff = counted == null ? null : counted - p.stock; return <tr key={p.id}><td className="muted mono">{idx + 1}</td><td><b>{p.name}</b><small className="block muted">{p.sku}</small></td><td>{qty(p.stock)} {p.unit}</td><td><input type="number" min="0" step={p.isWeighted ? 0.001 : 1} value={counted ?? ""} placeholder="—" onChange={(e) => { const value = e.target.value === "" ? undefined : Number(e.target.value); setCount((old) => { const countedNext = { ...old.counted }; if (value == null || Number.isNaN(value)) delete countedNext[p.id]; else countedNext[p.id] = value; return { ...old, counted: countedNext }; }); }}/></td><td className={diff == null ? "muted" : diff === 0 ? "green-text" : "danger-text"}>{diff == null ? "—" : diff > 0 ? `+${qty(diff)}` : qty(diff)}</td></tr>; })}</tbody></table></div><label className="checkbox-row"><input type="checkbox" checked={count.apply} onChange={(e) => setCount({ ...count, apply: e.target.checked })}/>{t("بعد از ذخیره، تفاوت‌ها فوراً روی موجودی اعمال شود")}</label>{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShowCount(false)}>{t("انصراف")}</button><button className="primary-button">{t("ذخیرهٔ شمارش")}</button></div></form></Modal>}
    <ReorderPanel/>
    <SerialsPanel products={products}/>
  </div>;
}
function movementLabel(type: string) { return ({ SALE: t("فروش"), PURCHASE: t("خرید"), ADJUSTMENT_IN: t("ورود دستی"), ADJUSTMENT_OUT: t("خروج دستی"), SALE_RETURN: t("برگشت فروش") } as Record<string, string>)[type] || type; }

type PurchaseLine = { productId: string; quantity: number; unitCost: number; expiryDate?: string; serials?: string };
export function PurchasesPage({ notify, user }: { notify: Notify; user: User }) {
  const brand = useBrand();
  const [purchases, setPurchases] = useState<Purchase[]>([]); const [totalRows, setTotalRows] = useState(0); const [page, setPage] = useState(1); const [pageBusy, setPageBusy] = useState(false); const [products, setProducts] = useState<Product[]>([]); const [suppliers, setSuppliers] = useState<Contact[]>([]); const [query, setQuery] = useState(""); const [show, setShow] = useState(false); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [viewing, setViewing] = useState<Purchase | null>(null);
  const [voiding, setVoiding] = useState<Purchase | null>(null); const [voidReason, setVoidReason] = useState(""); const [voidBusy, setVoidBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false); const [suggested, setSuggested] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<"purchases" | "returns">("purchases"); const [returns, setReturns] = useState<PurchaseReturn[]>([]);
  const [returningPurchase, setReturningPurchase] = useState<Purchase | null>(null); const [returnLines, setReturnLines] = useState<Record<string, number>>({}); const [returnSerials, setReturnSerials] = useState<Record<string, string>>({}); const [returnSerialOptions, setReturnSerialOptions] = useState<Record<string, string[]>>({}); const [returnNote, setReturnNote] = useState(""); const [returnBusy, setReturnBusy] = useState(false);
  const [returnReceipt, setReturnReceipt] = useState<PurchaseReturn | null>(null); const [shop, setShop] = useState<ShopSettings>({});
  const [form, setForm] = useState({ supplierId: "", invoiceNo: "", note: "" }); const [lines, setLines] = useState<PurchaseLine[]>([]); const [paid, setPaid] = useState(0); const [paidTouched, setPaidTouched] = useState(false);
  const [range, setRange] = useState({ from: "", to: "" }); const [supplierFilter, setSupplierFilter] = useState("");
  const [sort, setSort] = useState<{ key: "createdAt" | "total" | "invoiceNo" | "supplier"; dir: "asc" | "desc" }>({ key: "createdAt", dir: "desc" });
  const PAGE = 50; // matches the server default page size for /purchases
  const loadMoreBusy = useRef(false);
  const appliedSearch = useRef("");
  // جست‌وجو و صفحه‌بندی سروری — سرور «q» را روی شماره رسید/تأمین‌کننده/ثبت‌کننده
  // می‌گیرد و {list,total} برمی‌گرداند.
  const purchaseParams = (ordering = sort, targetPage = 1, search = appliedSearch.current) => { const params = new URLSearchParams(); if (range.from) params.set("from", range.from); if (range.to) params.set("to", range.to); if (search) params.set("q", search); params.set("sort", ordering.key); params.set("dir", ordering.dir); params.set("skip", String((targetPage - 1) * PAGE)); params.set("take", String(PAGE)); return params.toString(); };
  const load = () => Promise.all([get<PurchaseList>(`/purchases?${purchaseParams()}`), get<Product[]>("/products"), get<Contact[]>("/suppliers"), get<PurchaseReturn[]>(`/purchases/returns?take=${PAGE}`)]).then(([list, productList, supplierList, returnList]) => { setPurchases(list.list); setTotalRows(list.total); setPage(1); setProducts(productList); setSuppliers(supplierList); setReturns(returnList); }).catch((e) => setError(e.message));
  /** Re-runs the receipt window with new date/sort parameters (server-side,
   *  so the order stays honest across pages). */
  const applyPurchaseFilter = (from: string, to: string, ordering = sort) => {
    setRange({ from, to });
    const params = new URLSearchParams(); if (from) params.set("from", from); if (to) params.set("to", to); if (appliedSearch.current) params.set("q", appliedSearch.current); params.set("sort", ordering.key); params.set("dir", ordering.dir); params.set("skip", "0"); params.set("take", String(PAGE));
    get<PurchaseList>(`/purchases?${params.toString()}`).then((result) => { setPurchases(result.list); setTotalRows(result.total); setPage(1); }).catch((e) => setError(e.message));
  };
  const goToPage = (target: number) => { setPageBusy(true); get<PurchaseList>(`/purchases?${purchaseParams(sort, target)}`).then((result) => { setPurchases(result.list); setTotalRows(result.total); setPage(target); }).catch((e) => setError(e.message)).finally(() => setPageBusy(false)); };
  const reload = () => { get<PurchaseList>(`/purchases?${purchaseParams(sort, page)}`).then((result) => { setPurchases(result.list); setTotalRows(result.total); }).catch((e) => setError(e.message)); };
  // جست‌وجوی زنده با تأخیر؛ پاک‌کردن جعبه هم فهرست را برمی‌گرداند.
  useEffect(() => { const timer = setTimeout(() => { const next = query.trim(); if (next === appliedSearch.current) return; appliedSearch.current = next; get<PurchaseList>(`/purchases?${purchaseParams(sort, 1, next)}`).then((result) => { setPurchases(result.list); setTotalRows(result.total); setPage(1); }).catch((e) => setError(e.message)); }, 350); return () => clearTimeout(timer); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const applySort = (key: "createdAt" | "total" | "invoiceNo" | "supplier") => { const next = sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" as const : "asc" as const } : { key, dir: key === "createdAt" ? "desc" as const : "asc" as const }; setSort(next); applyPurchaseFilter(range.from, range.to, next); };
  /** ابطال رسید خرید: کالاها از انبار کم می‌شوند، دسته‌ها و سریال‌ها ابطال
   *  می‌شوند و دلیل در سابقه می‌ماند — رسید حذف نمی‌شود. */
  const submitVoid = async (event: FormEvent) => {
    event.preventDefault();
    if (!voiding) return;
    const reason = voidReason.trim();
    if (reason.length < 3) { notify(t("دلیل ابطال را بنویسید (حداقل ۳ نویسه)."), "error"); return; }
    setVoidBusy(true);
    try {
      await post(`/purchases/${voiding.id}/void`, { reason });
      notify(t("رسید خرید ابطال شد؛ موجودی انبار اصلاح شد."));
      setVoiding(null); setVoidReason(""); setViewing(null);
      reload();
    } catch (e) { notify((e as Error).message, "error"); } finally { setVoidBusy(false); }
  };
  /** خروجی همهٔ رسیدهای همین فیلتر — نه فقط صفحهٔ جاری (سقف سرور ۳۰۰). */
  const fetchAllPurchases = async (): Promise<Purchase[]> => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (appliedSearch.current) params.set("q", appliedSearch.current);
    params.set("sort", sort.key); params.set("dir", sort.dir);
    const all: Purchase[] = [];
    for (let skip = 0; ; skip += 300) {
      params.set("skip", String(skip)); params.set("take", "300");
      const page = await get<PurchaseList>(`/purchases?${params.toString()}`);
      all.push(...page.list);
      if (!page.list.length || all.length >= page.total) break;
    }
    return supplierFilter ? all.filter((p) => p.supplier?.id === supplierFilter) : all;
  };
  const exportPurchases = async (kind: "csv" | "pdf") => {
    if (tab === "returns") {
      const header = [t("شماره برگشت خرید"), t("تأمین‌کننده"), t("تعداد اقلام"), t("مبلغ"), t("ثبت‌کننده"), t("زمان")];
      const rows: Array<Array<string | number>> = returns.map((record) => [record.returnNo, record.supplier?.name || "—", (record.items || []).reduce((n, item) => n + item.quantity, 0), record.total, record.user?.displayName || "—", dateTime(record.createdAt)]);
      if (kind === "csv") { void exportCsvFile("purchase-returns.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
      exportTablePdf({ title: t("برگشت خریدها"), subtitle: `${returns.length} ${t("برگشت")}`, columns: [{ label: t("شماره برگشت خرید"), numeric: true }, { label: t("تأمین‌کننده") }, { label: t("تعداد اقلام"), numeric: true }, { label: t("مبلغ"), numeric: true }, { label: t("ثبت‌کننده") }, { label: t("زمان") }], rows, summary: [[t("جمع"), money(returns.reduce((sum, record) => sum + record.total, 0))]] }, shop.shopName);
      return;
    }
    let purchases: Purchase[];
    try { purchases = await fetchAllPurchases(); } catch (e) { notify((e as Error).message, "error"); return; }
    if (!purchases.length) { notify(t("رسیدی برای خروجی نیست."), "error"); return; }
    const header = [t("رسید خرید"), t("تأمین‌کننده"), t("تعداد اقلام"), t("مبلغ کل"), t("پرداخت‌شده"), t("بدهی"), t("ثبت‌کننده"), t("زمان"), t("وضعیت")];
    const rows: Array<Array<string | number>> = purchases.map((purchase) => [purchase.invoiceNo || t("خرید {date}", { date: dateOnly(purchase.createdAt) }), purchase.supplier?.name || "—", purchase.items.reduce((n, item) => n + item.quantity, 0), purchase.total, purchase.paidAmount, Math.max(0, purchase.total - purchase.paidAmount), purchase.user?.displayName || "—", dateTime(purchase.createdAt), purchase.voidedAt ? t("ابطال‌شده") : t("معتبر")]);
    const stamp = `${range.from || "all"}_${range.to || isoOf(new Date())}`;
    if (kind === "csv") { void exportCsvFile(`purchases-${stamp}.csv`, [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("خرید و ورود کالا"), subtitle: `${t("بازه")}: ${range.from ? dayLabel(range.from) : t("همه")} — ${range.to ? dayLabel(range.to) : t("همه")} · ${purchases.length} ${t("رسید")}`, columns: [{ label: t("رسید خرید"), numeric: true }, { label: t("تأمین‌کننده") }, { label: t("تعداد اقلام"), numeric: true }, { label: t("مبلغ کل"), numeric: true }, { label: t("پرداخت‌شده"), numeric: true }, { label: t("بدهی"), numeric: true }, { label: t("ثبت‌کننده") }, { label: t("زمان") }], rows, summary: [[t("جمع"), money(purchases.filter((p) => !p.voidedAt).reduce((sum, p) => sum + p.total, 0))]], landscape: true }, shop.shopName);
  };
  const loadMore = () => {
    if (loadMoreBusy.current) return;
    loadMoreBusy.current = true;
    get<PurchaseReturn[]>(`/purchases/returns?skip=${returns.length}&take=${PAGE}`)
      .then((more) => setReturns((current) => [...current, ...more]))
      .catch((e) => setError(e.message))
      .finally(() => { loadMoreBusy.current = false; });
  };
  useEffect(() => { void load(); get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const filtered = purchases.filter((p) => !supplierFilter || p.supplier?.id === supplierFilter);
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  const effectivePaid = Math.min(paidTouched ? paid : total, total);
  const addLine = () => { const first = products.find((p) => !p.isBundle); if (!first) return; setLines([...lines, { productId: first.id, quantity: 1, unitCost: first.cost }]); };
  const updateLine = (index: number, changes: Partial<PurchaseLine>) => setLines(lines.map((line, i) => (i === index ? { ...line, ...changes } : line)));
  const removeLine = (index: number) => setLines(lines.filter((_, i) => i !== index));
  const lowStockItems = products.filter((p) => !p.isBundle && p.stock <= p.minStock);
  const openSuggestions = () => {
    const defaults: Record<string, number> = {};
    for (const product of lowStockItems) defaults[product.id] = Math.max(1, Math.ceil((product.minStock * 2 - product.stock) * 10) / 10);
    setSuggested(defaults);
    setSuggesting(true);
  };
  const applySuggestions = () => {
    const picked = Object.entries(suggested).filter(([, quantity]) => quantity > 0);
    if (!picked.length) { setSuggesting(false); return; }
    setLines(picked.map(([productId, quantity]) => { const product = products.find((p) => p.id === productId); return { productId, quantity, unitCost: product?.cost ?? 0 }; }));
    setPaid(0); setPaidTouched(false);
    setSuggesting(false);
    setShow(true);
  };
  const startReturn = (purchase: Purchase) => { setViewing(null); setReturningPurchase(purchase); setReturnLines({}); setReturnSerials({}); setReturnNote(""); };
  // In-stock serials of the purchase's serialized goods, so the return form
  // can offer the shelf's units for picking.
  useEffect(() => {
    if (!returningPurchase) return;
    const ids = [...new Set(returningPurchase.items.map((item) => item.productId))].filter((id) => products.find((p) => p.id === id)?.isSerialized);
    if (!ids.length) { setReturnSerialOptions({}); return; }
    let alive = true;
    Promise.all(ids.map((id) => get<Array<{ serial: string }>>(`/inventory/serials?productId=${id}&status=IN_STOCK`)))
      .then((lists) => { if (alive) setReturnSerialOptions(Object.fromEntries(ids.map((id, index) => [id, lists[index].map((row) => row.serial)]))); })
      .catch(() => { if (alive) setReturnSerialOptions({}); });
    return () => { alive = false; };
  }, [returningPurchase, products]);
  const submitPurchaseReturn = async (event: FormEvent) => {
    event.preventDefault();
    if (!returningPurchase) return;
    const items = returningPurchase.items
      .map((item) => ({ productId: item.productId, quantity: returnLines[item.productId] || 0, serials: (returnSerials[item.productId] || "").split(/[\n,،\s]+/).filter(Boolean) }))
      .filter((line) => line.quantity > 0);
    if (!items.length) return;
    setReturnBusy(true);
    try {
      const record = await post<PurchaseReturn>("/purchases/returns", { purchaseId: returningPurchase.id, items, note: returnNote || undefined });
      notify(t("برگشت خرید ثبت شد."));
      setReturningPurchase(null); setReturnReceipt(record); await load();
    } catch (e) { notify((e as Error).message, "error"); } finally { setReturnBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    const merged = new Map<string, { quantity: number; unitCost: number; expiryDate?: string; serials?: string[] }>();
    for (const line of lines) {
      const serialList = (line.serials || "").split(/[\n,،\s]+/).filter(Boolean);
      const current = merged.get(line.productId);
      merged.set(line.productId, { quantity: (current?.quantity || 0) + line.quantity, unitCost: line.unitCost, expiryDate: line.expiryDate ?? current?.expiryDate, serials: (current?.serials || []).concat(serialList) });
    }
    const items = [...merged.entries()].map(([productId, data]) => ({ productId, ...data }));
    try {
      await post("/purchases", { items, supplierId: form.supplierId || undefined, invoiceNo: form.invoiceNo || undefined, note: form.note || undefined, paidAmount: effectivePaid });
      notify(t("خرید ثبت و موجودی انبار به‌روز شد."));
      setShow(false); setLines([]); setPaid(0); setPaidTouched(false); setForm({ supplierId: "", invoiceNo: "", note: "" }); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="page-stack"><section className="surface"><SectionHead title={t("خرید و ورود کالا")} subtitle={t("رسید خرید از تأمین‌کننده و افزایش خودکار موجودی")} action={<div className="row-actions">{lowStockItems.length > 0 && <button className="secondary-button" onClick={openSuggestions}><Lightbulb size={16}/>{t("پیشنهاد سفارش")}</button>}<button className="primary-button" disabled={!products.length} onClick={() => { setLines([]); setPaid(0); setPaidTouched(false); setShow(true); }}><Truck size={17}/>{t("خرید جدید")}</button></div>}/><div className="toolbar"><div className="segmented"><button type="button" className={tab === "purchases" ? "active" : ""} onClick={() => setTab("purchases")}>{t("رسیدهای خرید")}</button><button type="button" className={tab === "returns" ? "active" : ""} onClick={() => setTab("returns")}>{t("برگشت خریدها")}</button></div><div className="search-box"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی شماره رسید یا تأمین‌کننده…")}/></div>{tab === "purchases" && <><select className="filter-select" value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} aria-label={t("تأمین‌کننده")}><option value="">{t("همهٔ تأمین‌کننده‌ها")}</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyPurchaseFilter(iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyPurchaseFilter(range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyPurchaseFilter(isoOf(new Date()), isoOf(new Date()))}>{t("امروز")}</button><button className="text-button" onClick={() => applyPurchaseFilter(isoOf(new Date(Date.now() - 29 * 86400000)), isoOf(new Date()))}>{t("۳۰ روز")}</button>{(range.from || range.to || supplierFilter) && <button className="text-button danger-text" onClick={() => { setSupplierFilter(""); applyPurchaseFilter("", ""); }}>{t("حذف فیلتر")}</button>}</>}<ExportMenu onExport={exportPurchases} disabled={tab === "purchases" ? !filtered.length : !returns.length}/><span className="toolbar-count">{tab === "purchases" ? `${totalRows} ${t("رسید")}` : `${returns.length} ${t("برگشت")}`}</span></div>{error && <ErrorBox message={error}/>}
    {tab === "purchases" && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><SortTh label={t("رسید خرید")} active={sort.key === "invoiceNo"} dir={sort.dir} onClick={() => applySort("invoiceNo")}/><SortTh label={t("تأمین‌کننده")} active={sort.key === "supplier"} dir={sort.dir} onClick={() => applySort("supplier")}/><th>{t("اقلام")}</th><SortTh label={t("مبلغ کل")} active={sort.key === "total"} dir={sort.dir} onClick={() => applySort("total")}/><th>{t("پرداخت‌شده")}</th><th>{t("ثبت‌کننده")}</th><SortTh label={t("زمان")} active={sort.key === "createdAt"} dir={sort.dir} onClick={() => applySort("createdAt")}/><th></th></tr></thead><tbody>{filtered.map((purchase, idx) => <tr key={purchase.id} className={purchase.voidedAt ? "voided-row" : ""}><td className="muted mono">{(page - 1) * PAGE + idx + 1}</td><td className="mono" title={t("خرید {date}", { date: dateOnly(purchase.createdAt) })}>{purchase.invoiceNo || dateOnly(purchase.createdAt)}{purchase.voidedAt && <span className="status-pill warning">{t("ابطال‌شده")}</span>}</td><td>{purchase.supplier?.name || "—"}</td><td title={purchase.items.map((item) => `${item.name} × ${item.quantity}`).join(t("، "))}>{purchase.items.reduce((n, item) => n + item.quantity, 0)} {t("قلم")}</td><td className="strong">{money(purchase.total)}</td><td>{money(purchase.paidAmount)}{purchase.paidAmount < purchase.total && <small className="block stock-low">{t("بدهی:")} {money(purchase.total - purchase.paidAmount)}</small>}</td><td>{purchase.user?.displayName || "—"}</td><td className="muted">{dateTime(purchase.createdAt)}</td><td><button className="text-button" onClick={() => setViewing(purchase)}>{t("مشاهده")}</button></td></tr>)}</tbody></table>{!filtered.length && <Empty title={t("رسید خریدی ثبت نشده")} text={t("با ثبت خرید، کالاها به موجودی انبار اضافه و قیمت خرید به‌روز می‌شود.")}/>}</div>}
    {tab === "purchases" && <Pagination page={page} pageCount={Math.max(1, Math.ceil(totalRows / PAGE))} shown={filtered.length} total={totalRows} busy={pageBusy} onChange={goToPage}/>}
    {tab === "returns" && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("شماره برگشت خرید")}</th><th>{t("تأمین‌کننده")}</th><th>{t("اقلام")}</th><th>{t("مبلغ")}</th><th>{t("ثبت‌کننده")}</th><th>{t("زمان")}</th><th></th></tr></thead><tbody>{returns.map((record, idx) => <tr key={record.id}><td className="muted mono">{idx + 1}</td><td className="mono">{record.returnNo}</td><td>{record.supplier?.name || "—"}</td><td title={(record.items || []).map((item) => `${item.name} × ${item.quantity}`).join(t("، "))}>{(record.items || []).reduce((n, item) => n + item.quantity, 0)} {t("قلم")}</td><td className="strong">{money(record.total)}</td><td>{record.user?.displayName || "—"}</td><td className="muted">{dateTime(record.createdAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => setReturnReceipt(record)}>{t("مشاهده")}</button><button className="text-button" onClick={() => printHtml(purchaseReturnHtml(record, shop))}><Printer size={14}/>{t("چاپ")}</button></div></td></tr>)}</tbody></table>{!returns.length && <Empty title={t("برگشت خریدی ثبت نشده")} text={t("از جزئیات یک رسید خرید، کالای برگشتی به تأمین‌کننده را ثبت کنید.")}/>}</div>}
    {tab === "returns" && returns.length >= PAGE && <div className="load-more"><button className="secondary-button" onClick={() => loadMore()}>{t("نمایش برگشت‌های بیشتر")}</button><small className="muted">{t("{count} برگشت بارگذاری شد", { count: returns.length })}</small></div>}</section>
    {show && <Modal title={lines.length ? t("رسید خرید") : t("ثبت خرید جدید")} wide onClose={() => setShow(false)}><form onSubmit={save}>
      <div className="form-grid"><Field label={t("تأمین‌کننده (اختیاری)")}><select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}><option value="">{t("بدون تأمین‌کننده")}</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label={t("شماره رسید تأمین‌کننده (اختیاری)")}><input value={form.invoiceNo} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} placeholder={t("مثلاً INV-1201")} dir="ltr"/></Field><Field label={t("یادداشت")} full><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("اختیاری")}/></Field></div>
      <div className="table-wrap" style={{ marginTop: "0.75rem" }}><table><thead><tr><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("قیمت خرید واحد")}</th><th>{t("تاریخ انقضای این محموله")}</th><th>{t("جمع")}</th><th></th></tr></thead><tbody>{lines.map((line, index) => { return <tr key={index}><td><select value={line.productId} onChange={(e) => { const picked = products.find((p) => p.id === e.target.value); updateLine(index, { productId: e.target.value, unitCost: picked ? picked.cost : line.unitCost }); }} style={{ minWidth: "10rem" }}>{products.filter((p) => !p.isBundle).map((p) => <option key={p.id} value={p.id}>{p.name} — {p.sku}</option>)}</select></td><td><input type="number" min={products.find((p) => p.id === line.productId)?.isWeighted ? 0.001 : 1} step={products.find((p) => p.id === line.productId)?.isWeighted ? 0.001 : 1} required value={line.quantity} onChange={(e) => updateLine(index, { quantity: Math.max(0.001, Number(e.target.value) || 0.001) })} style={{ width: "5rem" }} dir="ltr"/></td><td><input type="number" min="0" required value={line.unitCost} onChange={(e) => updateLine(index, { unitCost: Math.max(0, Number(e.target.value) || 0) })} style={{ width: "7rem" }} dir="ltr"/></td><td><DateField compact value={line.expiryDate || ""} onChange={(iso) => updateLine(index, { expiryDate: iso || undefined })} title={t("اگر این محموله تاریخ انقضای خودش را دارد، آن را وارد کنید")}/>{products.find((p) => p.id === line.productId)?.isSerialized && <textarea rows={2} dir="ltr" placeholder={t("سریال/IMEI هر دستگاه — هر خط یک عدد")} value={line.serials || ""} onChange={(e) => updateLine(index, { serials: e.target.value })} style={{ width: "12rem", marginTop: 4 }}/>}</td><td className="strong">{money(line.quantity * line.unitCost)}</td><td><button type="button" className="icon-button" onClick={() => removeLine(index)} title={t("حذف قلم")}><X size={16}/></button></td></tr>; })}{!lines.length && <tr><td colSpan={6} className="muted">{t("قلمی اضافه نشده است.")}</td></tr>}</tbody></table></div>
      <div className="form-actions" style={{ justifyContent: "space-between" }}><button type="button" className="secondary-button" onClick={addLine}><CirclePlus size={16}/>{t("افزودن قلم")}</button><span>{t("جمع کل:")}<b>{money(total)}</b></span></div>
      <div className="form-grid"><Field label={t("پرداخت‌شده هنگام خرید (افغانی)")}><div className="row-actions"><input required type="number" min="0" max={total} value={effectivePaid} onChange={(e) => { setPaidTouched(true); setPaid(Math.min(total, Math.max(0, Number(e.target.value) || 0))); }} style={{ width: "9rem" }} dir="ltr"/><button type="button" className="text-button" onClick={() => { setPaidTouched(true); setPaid(total); }}>{t("کامل")}</button><button type="button" className="text-button danger-text" onClick={() => { setPaidTouched(true); setPaid(0); }}>{t("نسیه")}</button></div></Field>{effectivePaid < total && <Field label={t("بدهی به تأمین‌کننده")}><div className="hint-box" style={{ margin: 0 }}>{t("مانده:")}<b>{money(total - effectivePaid)}</b>{t("در حساب تأمین‌کننده ثبت می‌شود.")}</div></Field>}</div>
      <div className="hint-box"><ShieldCheck size={17}/>{t("با ثبت خرید، موجودی انبار افزایش می‌یابد، گردش «خرید» ثبت می‌شود و قیمت خرید کالاها به‌روز می‌گردد.")}</div>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShow(false)}>{t("انصراف")}</button><button className="primary-button" disabled={busy || !lines.length}>{busy ? t("در حال ثبت…") : t("ثبت خرید")}</button></div>
    </form></Modal>}
    {suggesting && <Modal title={t("سفارش خرید پیشنهادی")} wide onClose={() => setSuggesting(false)}><div className="hint-box">{t("کالاهای زیر به حداقل موجودی رسیده‌اند. مقدار پیشنهادی را تنظیم کنید تا رسید خرید به‌صورت خودکار پر شود.")}</div><div className="table-wrap" style={{ marginTop: "0.75rem" }}><table><thead><tr><th>{t("کالا")}</th><th>{t("موجودی")}</th><th>{t("حداقل")}</th><th>{t("مقدار پیشنهادی")}</th></tr></thead><tbody>{lowStockItems.map((product) => <tr key={product.id}><td><b>{product.name}</b><small className="block muted">{product.sku}</small></td><td className={product.stock <= 0 ? "danger-text" : ""}>{qty(product.stock)} {product.unit}</td><td>{qty(product.minStock)}</td><td><input type="number" min="0" step={product.isWeighted ? 0.001 : 1} value={suggested[product.id] ?? 0} onChange={(e) => setSuggested({ ...suggested, [product.id]: Math.max(0, Number(e.target.value) || 0) })} style={{ width: "6rem" }} dir="ltr"/></td></tr>)}</tbody></table></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setSuggesting(false)}>{t("انصراف")}</button><button className="primary-button" onClick={applySuggestions}><Truck size={16}/>{t("ساخت رسید خرید")}</button></div></Modal>}
    {viewing && <Modal title={viewing.invoiceNo ? t("رسید خرید {no}", { no: viewing.invoiceNo }) : t("رسید خرید")} onClose={() => setViewing(null)}>{viewing.voidedAt && <div className="hint-box void-banner"><AlertTriangle size={17}/><div><b>{t("این رسید ابطال شده است.")}</b><span>{t("دلیل: {reason} — ابطال‌کننده: {by} — زمان: {at}", { reason: viewing.voidReason || "—", by: viewing.voidedBy || "—", at: dateTime(viewing.voidedAt) })}</span><span>{t("کالاها در زمان ابطال از موجودی انبار کم شده‌اند؛ سابقهٔ رسید حفظ می‌شود.")}</span></div></div>}<div className="receipt-meta"><span>{t("تأمین‌کننده")}</span><b>{viewing.supplier?.name || "—"}</b></div><div className="receipt-meta"><span>{t("ثبت‌کننده")}</span><b>{viewing.user?.displayName || "—"}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(viewing.createdAt)}</b></div>{viewing.note && <div className="receipt-meta"><span>{t("یادداشت")}</span><b>{viewing.note}</b></div>}<div className="table-wrap" style={{ marginTop: "0.75rem" }}><table><thead><tr><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("قیمت خرید واحد")}</th><th>{t("جمع")}</th></tr></thead><tbody>{viewing.items.map((item) => <tr key={item.id}><td><b>{item.name}</b><small className="block muted">{item.sku}</small></td><td>{item.quantity}</td><td>{money(item.unitCost)}</td><td className="strong">{money(item.lineTotal)}</td></tr>)}</tbody></table></div><div className="form-actions"><span>{t("جمع کل:")}<b>{money(viewing.total)}</b>{viewing.paidAmount < viewing.total && <small className="block stock-low">{t("پرداخت‌شده:")} {money(viewing.paidAmount)} · {t("بدهی:")} {money(viewing.total - viewing.paidAmount)}</small>}</span>{user.role === "ADMIN" && !viewing.voidedAt && <button className="danger-button" onClick={() => { setVoiding(viewing); setVoidReason(""); }}><X size={16}/>{t("ابطال رسید")}</button>}{!viewing.voidedAt && <button className="danger-button" onClick={() => startReturn(viewing)}><Undo2 size={16}/>{t("برگشت خرید")}</button>}<button className="secondary-button" onClick={() => setViewing(null)}>{t("بستن")}</button></div></Modal>}
    {voiding && <Modal title={t("ابطال رسید خرید {no}", { no: voiding.invoiceNo || dateOnly(voiding.createdAt) })} onClose={() => { setVoiding(null); setVoidReason(""); }}><form className="form-grid single" onSubmit={submitVoid}>
      <div className="hint-box void-banner"><AlertTriangle size={17}/><div><b>{t("ابطال، رسید را حذف نمی‌کند.")}</b><span>{t("کالاها به همان اندازه از موجودی انبار کم می‌شوند، دسته‌های انقضا و سریال‌های همین رسید ابطال می‌شوند و دلیل در سابقه ثبت می‌ماند. اگر کالاها فروخته یا مصرف شده باشند، ابطال ممکن نیست. این عمل بازگشت‌پذیر نیست.")}</span></div></div>
      <Field label={t("دلیل ابطال (الزامی)")}><textarea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t("مثلاً: رسید به‌اشتباه دو بار ثبت شد")} required minLength={3} maxLength={300}/></Field>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setVoiding(null); setVoidReason(""); }}>{t("انصراف")}</button><button className="danger-button" disabled={voidBusy || voidReason.trim().length < 3}>{voidBusy ? t("در حال ابطال…") : t("ابطال قطعی رسید")}</button></div>
    </form></Modal>}
    {returningPurchase && <Modal title={t("برگشت خرید — رسید {no}", { no: returningPurchase.invoiceNo || dateOnly(returningPurchase.createdAt) })} onClose={() => setReturningPurchase(null)} wide><form onSubmit={submitPurchaseReturn}>
      <div className="hint-box return-guide"><Undo2 size={17}/><div><b>{t("چند عدد از هر کالا به تأمین‌کننده برمی‌گردد؟")}</b><span>{t("تعداد برگشتی هر کالا را با دکمه‌های − و + یا تایپ عدد مشخص کنید؛ «۰» یعنی آن کالا برگشت نمی‌شود. کالا از انبار خارج می‌شود و مبلغ آن در حساب تأمین‌کننده تسویه می‌گردد؛ نقد صندوق تغییر نمی‌کند.")}</span></div></div>
      <div className="return-lines" style={{ marginTop: "0.75rem" }}>{returningPurchase.items.map((item) => {
        const value = returnLines[item.productId] || 0;
        const setQty = (next: number) => setReturnLines({ ...returnLines, [item.productId]: Math.min(item.quantity, Math.max(0, Math.round(next * 1000) / 1000)) });
        return <div className={`return-line ${value > 0 ? "" : "quiet"}`} key={item.id}>
          <div className="return-line-info"><b>{item.name}</b><small className="muted">{item.sku}</small><small className="muted">{t("خریده‌شده: {bought} · قیمت خرید واحد: {price}", { bought: qty(item.quantity), price: money(item.unitCost) })}</small></div>
          <div className="qty-stepper" dir="ltr">
            <button type="button" onClick={() => setQty(value - 1)} disabled={value <= 0} aria-label={t("کم کردن")}>−</button>
            <input type="number" min="0" max={item.quantity} step={item.quantity % 1 !== 0 ? 0.001 : 1} value={value} onChange={(e) => setQty(Number(e.target.value) || 0)} dir="ltr" aria-label={t("تعداد برگشتی")}/>
            <button type="button" onClick={() => setQty(value + 1)} disabled={value >= item.quantity} aria-label={t("زیاد کردن")}>+</button>
            <button type="button" className="chip" onClick={() => setQty(item.quantity)}>{t("همه")}</button>
          </div>
          <b className="return-line-refund" dir="ltr">{moneyPlain(Math.round(item.unitCost * value))}</b>
          {products.find((p) => p.id === item.productId)?.isSerialized && value > 0 && <div className="return-serials"><SerialPicker label={t("سریال/IMEI دستگاه‌های برگشتی")} need={Math.round(value)} available={returnSerialOptions[item.productId] || []} value={returnSerials[item.productId] || ""} onChange={(next) => setReturnSerials({ ...returnSerials, [item.productId]: next })}/></div>}
        </div>;
      })}</div>
      <div className="form-grid single" style={{ marginTop: "0.75rem" }}><Field label={t("یادداشت برگشت (اختیاری)")}><input value={returnNote} onChange={(e) => setReturnNote(e.target.value)} placeholder={t("مثلاً کالا معیوب بود")}/></Field></div>
      <div className="return-summary"><span>{t("{count} عدد از {lines} قلم کالا", { count: qty(Object.values(returnLines).reduce((sum, quantity) => sum + quantity, 0)), lines: String(Object.values(returnLines).filter((quantity) => quantity > 0).length) })}</span><b>{t("ارزش کل برگشتی:")} {money(Object.entries(returnLines).reduce((sum, [productId, quantity]) => { const item = returningPurchase.items.find((row) => row.productId === productId); return sum + (item ? Math.round(item.unitCost * quantity) : 0); }, 0))}</b></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setReturningPurchase(null)}>{t("انصراف")}</button><button className="danger-button" disabled={returnBusy || Object.values(returnLines).every((quantity) => !quantity)}>{returnBusy ? t("در حال ثبت…") : t("ثبت برگشت خرید")}</button></div>
    </form></Modal>}
    {returnReceipt && <Modal title={t("برگشت خرید ثبت شد")} onClose={() => setReturnReceipt(null)}><div className="receipt-print"><div className="receipt-brand">{brand.appName}</div><p>{shop.shopName?.trim() || t("فروشگاه من")}</p><div className="receipt-divider"/><div className="receipt-meta"><span>{t("شماره برگشت خرید")}</span><b>{returnReceipt.returnNo}</b></div><div className="receipt-meta"><span>{t("تأمین‌کننده")}</span><b>{returnReceipt.supplier?.name || "—"}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(returnReceipt.createdAt)}</b></div><div className="receipt-divider"/>{(returnReceipt.items || []).map((item) => <div className="receipt-item" key={item.id}><span>{item.name} × {item.quantity}</span><b>{money(item.lineTotal)}</b></div>)}<div className="receipt-divider"/><div className="receipt-meta"><span>{t("مبلغ برگشت خرید")}</span><strong>{money(returnReceipt.total)}</strong></div>{returnReceipt.note && <div className="receipt-meta"><span>{t("یادداشت")}</span><b>{returnReceipt.note}</b></div>}<p className="receipt-thanks">{t("این برگشت در حساب تأمین‌کننده ثبت شد.")}</p></div><div className="form-actions"><button className="secondary-button" onClick={() => setReturnReceipt(null)}>{t("بستن")}</button><button className="primary-button" onClick={() => printHtml(purchaseReturnHtml(returnReceipt, shop))}><Printer size={17}/>{t("چاپ رسید برگشت خرید")}</button></div></Modal>}
  </div>;
}

export function SalesPage({ notify, user }: { notify: Notify; user: User }) {
  const brand = useBrand();
  const [sales, setSales] = useState<Sale[]>([]); const [totalRows, setTotalRows] = useState(0); const [page, setPage] = useState(1); const [pageBusy, setPageBusy] = useState(false); const [query, setQuery] = useState(""); const [selected, setSelected] = useState<Sale | null>(null); const [error, setError] = useState(""); const [range, setRange] = useState({ from: "", to: "" }); const [shop, setShop] = useState<ShopSettings>({});
  const [voiding, setVoiding] = useState<Sale | null>(null); const [voidReason, setVoidReason] = useState(""); const [voidBusy, setVoidBusy] = useState(false);
  const [returning, setReturning] = useState<Sale | null>(null); const [returnDetail, setReturnDetail] = useState<Sale | null>(null); const [returnSerials, setReturnSerials] = useState<Record<string, string>>({}); const [returnSerialUnits, setReturnSerialUnits] = useState<Array<{ serial: string; productId: string; saleItemId: string | null }>>([]); const [returnProducts, setReturnProducts] = useState<Product[]>([]); const [returnLines, setReturnLines] = useState<Record<string, number>>({}); const [returnNote, setReturnNote] = useState(""); const [returnBusy, setReturnBusy] = useState(false); const [returnReceipt, setReturnReceipt] = useState<{ sale: Sale; record: SaleReturn } | null>(null);
  const [view, setView] = useState<"sales" | "quotes">("sales");
  const [method, setMethod] = useState<"" | "CASH" | "MOBILE" | "CREDIT" | "WALLET">("");
  const [sort, setSort] = useState<{ key: "createdAt" | "total" | "receiptNo" | "customer"; dir: "asc" | "desc" }>({ key: "createdAt", dir: "desc" });
  const [sharing, setSharing] = useState<Sale | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [showQuote, setShowQuote] = useState(false); const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteForm, setQuoteForm] = useState<{ customerId: string; note: string; lines: Record<string, number> }>({ customerId: "", note: "", lines: {} });
  const [quoteProducts, setQuoteProducts] = useState<Product[]>([]); const [quoteCustomers, setQuoteCustomers] = useState<Contact[]>([]);
  const [quotePick, setQuotePick] = useState({ productId: "", quantity: 1 });
  const [viewingQuote, setViewingQuote] = useState<Quote | null>(null);
  const [converting, setConverting] = useState<Quote | null>(null); const [convertSerials, setConvertSerials] = useState<Record<string, string>>({}); const [convertSerialOptions, setConvertSerialOptions] = useState<Record<string, string[]>>({}); const [convertBusy, setConvertBusy] = useState(false);
  const PAGE = 50;
  // جست‌وجو و صفحه‌بندی سروری: دفتر فروش هزار ردیفی یک‌جا نمی‌آید؛ سرور
  // «q» را روی شماره فاکتور/فاکتور رسمی/مشتری/صندوقدار می‌گیرد و
  // {list,total} برمی‌گرداند تا شمارهٔ صفحه‌ها واقعی باشد.
  const load = (targetPage = 1, search = query.trim(), from = range.from, to = range.to, payment: string = method, ordering = sort) => {
    const params = new URLSearchParams(); if (from) params.set("from", from); if (to) params.set("to", to); if (payment) params.set("method", payment); if (search) params.set("q", search); params.set("sort", ordering.key); params.set("dir", ordering.dir); params.set("skip", String((targetPage - 1) * PAGE)); params.set("take", String(PAGE));
    return get<SaleList>(`/sales?${params.toString()}`).then((result) => { setSales(result.list); setTotalRows(result.total); setPage(targetPage); });
  };
  const applySearch = (search: string) => { appliedSearch.current = search; load(1, search).catch((e) => setError(e.message)); };
  // جست‌وجوی زنده با تأخیر — همان الگوی فهرست کالاها. پاک‌کردن جعبهٔ
  // جست‌وجو هم باید فهرست را برگرداند، حتی وقتی فقط یک صفحه هست.
  const appliedSearch = useRef("");
  useEffect(() => { const timer = setTimeout(() => { const next = query.trim(); if (next !== appliedSearch.current) applySearch(next); }, 350); return () => clearTimeout(timer); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Column sort for the history table — the server re-runs the window so the
   *  order is honest even when only the first page is loaded. */
  const applySort = (key: "createdAt" | "total" | "receiptNo" | "customer") => { const next = sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" as const : "asc" as const } : { key, dir: key === "createdAt" ? "desc" as const : "asc" as const }; setSort(next); load(1, query.trim(), range.from, range.to, method, next).catch((e) => setError(e.message)); };
  /** Months of use: reconcile نقدی/نسیه days without scrolling the whole ledger. */
  const applyMethod = (next: "" | "CASH" | "MOBILE" | "CREDIT" | "WALLET") => { setMethod(next); load(1, query.trim(), range.from, range.to, next).catch((e) => setError(e.message)); };
  useEffect(() => { load(1, "").catch((e) => setError(e.message)); get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const applyRange = (from: string, to: string) => { setRange({ from, to }); load(1, query.trim(), from, to).catch((e) => setError(e.message)); };
  const goToPage = (target: number) => { setPageBusy(true); load(target).catch((e) => setError(e.message)).finally(() => setPageBusy(false)); };
  const reload = () => { load(page).catch((e) => setError(e.message)); };
  // ردیف‌های ابطال‌شده دیده می‌شوند (سابقه پاک نمی‌شود) ولی جمع‌ها و
  // صادرات‌ها فقط فاکتورهای معتبر را می‌شمارند.
  const filtered = sales;
  const liveRows = sales.filter((sale) => !sale.voidedAt);
  const totalSum = liveRows.reduce((sum, sale) => sum + sale.total, 0);
  /** ابطال فاکتور: سابقه می‌ماند، موجودی/کیف پول/صندوق برمی‌گردد و دلیل ثبت می‌شود. */
  const submitVoid = async (event: FormEvent) => {
    event.preventDefault();
    if (!voiding) return;
    const reason = voidReason.trim();
    if (reason.length < 3) { notify(t("دلیل ابطال را بنویسید (حداقل ۳ نویسه)."), "error"); return; }
    setVoidBusy(true);
    try {
      await post(`/sales/${voiding.id}/void`, { reason });
      notify(t("فاکتور {no} ابطال شد؛ موجودی و حساب‌ها اصلاح شد.", { no: voiding.receiptNo }));
      setVoiding(null); setVoidReason(""); setSelected(null);
      reload();
    } catch (e) { notify((e as Error).message, "error"); } finally { setVoidBusy(false); }
  };
  const returnedQty = (sale: Sale | null, productId: string) => (sale?.returns || []).flatMap((record) => record.items || []).filter((item) => item.productId === productId).reduce((count, item) => count + item.quantity, 0);
  const openDetail = (sale: Sale) => { get<Sale>(`/sales/${sale.id}`).then(setSelected).catch(() => undefined); };
  const openReturn = (sale: Sale) => { setReturning(sale); setReturnDetail(null); setReturnLines({}); setReturnSerials({}); setReturnSerialUnits([]); setReturnNote(""); get<Sale>(`/sales/${sale.id}`).then(setReturnDetail).catch((e) => notify(e.message, "error")); get<Product[]>("/products").then(setReturnProducts).catch(() => undefined); get<Array<{ serial: string; productId: string; saleItemId: string | null }>>(`/inventory/serials?saleId=${sale.id}&status=SOLD`).then(setReturnSerialUnits).catch(() => setReturnSerialUnits([])); };
  const refundEstimate = returnDetail
    // Same rule as the server: undiscounted line prices, but never more than
    // what is still refundable of the amount the customer actually paid.
    ? Math.min(
        Object.entries(returnLines).reduce((sum, [productId, quantity]) => { const item = returnDetail.items.find((line) => line.productId === productId); return sum + (item ? item.unitPrice * quantity : 0); }, 0),
        Math.max(0, returnDetail.total - (returnDetail.returns || []).reduce((sum, record) => sum + record.total, 0)),
      )
    : 0;
  const submitReturn = async (event: FormEvent) => {
    event.preventDefault();
    if (!returning) return;
    const items = Object.entries(returnLines).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity, serials: (returnSerials[productId] || "").split(/[\n,،\s]+/).filter(Boolean) }));
    if (!items.length) { notify(t("حداقل یک قلم را برای برگشت انتخاب کنید."), "error"); return; }
    // Serialized products (and kits with serialized components) must name
    // every unit coming back — same rule as the POS.
    for (const item of returnDetail?.items || []) {
      const product = returnProducts.find((row) => row.id === item.productId);
      const need = product ? serializedNeed(product, returnLines[item.productId] || 0) : 0;
      if (!need) continue;
      const entered = (returnSerials[item.productId] || "").split(/[\n,،\s]+/).filter(Boolean);
      if (entered.length !== need) {
        notify(product!.isBundle
          ? t("برای «{name}» سریال/IMEI اجزای سریال‌دار را وارد کنید ({count} مورد).", { name: item.name, count: String(need) })
          : t("برای «{name}» سریال/IMEI هر دستگاه را وارد کنید ({count} مورد).", { name: item.name, count: String(need) }), "error");
        return;
      }
    }
    setReturnBusy(true);
    try {
      const record = await post<SaleReturn>(`/sales/${returning.id}/return`, { items, note: returnNote || undefined });
      notify(t("برگشتی {no} ثبت شد؛ مبلغ برگشتی: {total}.", { no: record.returnNo, total: money(record.total) }));
      setReturning(null); setReturnDetail(null);
      setSelected(null); // only one printable receipt on screen at a time
      setReturnReceipt({ sale: { ...returning, returns: [...(returning.returns || []), record] }, record });
      reload();
    } catch (e) { notify((e as Error).message, "error"); } finally { setReturnBusy(false); }
  };
  /** خروجی باید «همهٔ» ردیف‌های همین فیلتر را داشته باشد، نه فقط صفحهٔ
   *  جاری — سرور تا ۳۰۰ ردیف در هر پاس می‌دهد، پس صفحه‌به‌صفحه می‌آید. */
  const fetchAllSales = async (): Promise<Sale[]> => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (method) params.set("method", method);
    if (query.trim()) params.set("q", query.trim());
    params.set("sort", sort.key); params.set("dir", sort.dir);
    params.set("take", "300");
    const pageUrl = (skip: number) => { const p = new URLSearchParams(params); p.set("skip", String(skip)); return `/sales?${p.toString()}`; };
    // Page 1 tells us the total; the rest load in small parallel waves
    // instead of one-by-one — a 25k-invoice ledger used to crawl through
    // 80+ sequential round trips before the file dialog appeared.
    const first = await get<SaleList>(pageUrl(0));
    const all: Sale[] = [...first.list];
    const pageCount = Math.ceil(first.total / 300);
    const WAVE = 4;
    for (let startPage = 1; startPage < pageCount; startPage += WAVE) {
      const pages: number[] = [];
      for (let p2 = startPage; p2 < Math.min(startPage + WAVE, pageCount); p2++) pages.push(p2);
      // A failed page must fail the whole export loudly (same as before) —
      // a silently partial accounting file is worse than an error toast.
      const chunks = await Promise.all(pages.map((p2) => get<SaleList>(pageUrl(p2 * 300)).then((page) => page.list)));
      for (const chunk of chunks) all.push(...chunk);
    }
    return all;
  };
  // Export builders: every row matching the current filters and sort.
  const exportHeader = () => [t("شماره فاکتور"), t("زمان"), t("مشتری"), t("صندوقدار"), t("پرداخت"), t("تعداد اقلام"), t("مبلغ"), t("تخفیف"), t("برگشتی"), t("وضعیت")];
  const exportRowsOf = (rows: Sale[]): Array<Array<string | number>> => rows.map((sale) => [
    sale.receiptNo, dateTime(sale.createdAt), sale.customer?.name || t("مشتری گذری"), sale.user?.displayName || "", payLabel(sale.paymentMethod),
    sale.items.reduce((count, item) => count + item.quantity, 0), sale.total, sale.discount,
    (sale.returns || []).reduce((sum, record) => sum + record.total, 0),
    sale.voidedAt ? t("ابطال‌شده") : t("معتبر"),
  ]);
  const exportSales = async (kind: "csv" | "pdf") => {
    let rows: Sale[];
    try { rows = await fetchAllSales(); } catch (e) { notify((e as Error).message, "error"); return; }
    if (!rows.length) { notify(t("فاکتوری برای خروجی نیست."), "error"); return; }
    const exportRows = exportRowsOf(rows);
    const stamp = `${range.from || "all"}_${range.to || isoOf(new Date())}`;
    if (kind === "csv") {
      void exportCsvFile(`sales-${stamp}.csv`, [exportHeader(), ...exportRows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error"));
      return;
    }
    exportTablePdf({
      title: t("فروش‌های ثبت‌شده"),
      subtitle: `${t("بازه")}: ${range.from ? dayLabel(range.from) : t("همه")} — ${range.to ? dayLabel(range.to) : t("همه")} · ${method ? payLabel(method) : t("همهٔ روش‌ها")} · ${rows.length} ${t("فاکتور")}`,
      columns: [{ label: t("شماره فاکتور"), numeric: true }, { label: t("زمان") }, { label: t("مشتری") }, { label: t("صندوقدار") }, { label: t("پرداخت") }, { label: t("تعداد اقلام"), numeric: true }, { label: t("مبلغ"), numeric: true }, { label: t("تخفیف"), numeric: true }, { label: t("برگشتی"), numeric: true }],
      rows: exportRows,
      summary: [[t("جمع"), money(rows.filter((sale) => !sale.voidedAt).reduce((sum, sale) => sum + sale.total, 0))]],
      landscape: true,
    }, shop.shopName);
  };
  const exportQuotes = (kind: "csv" | "pdf") => {
    const header = [t("شماره"), t("مشتری"), t("تعداد اقلام"), t("مبلغ"), t("وضعیت"), t("زمان")];
    const rows: Array<Array<string | number>> = quotes.map((quote) => [quote.quoteNo, quote.customer?.name || t("بدون مشتری"), quote._count?.items ?? quote.items?.length ?? 0, quote.total, quote.status === "OPEN" ? t("باز") : quote.status === "CONVERTED" ? t("تبدیل‌شده") : t("ابطال‌شده"), dateTime(quote.createdAt)]);
    if (kind === "csv") { void exportCsvFile("quotes.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("پیش‌فاکتورها"), subtitle: `${quotes.length} ${t("پیش‌فاکتور")}`, columns: [{ label: t("شماره"), numeric: true }, { label: t("مشتری") }, { label: t("تعداد اقلام"), numeric: true }, { label: t("مبلغ"), numeric: true }, { label: t("وضعیت") }, { label: t("زمان") }], rows }, shop.shopName);
  };
  const loadQuotes = (skip = 0) => get<Quote[]>(`/quotes?skip=${skip}&take=100`).then((rows) => setQuotes((current) => skip === 0 ? rows : [...current, ...rows])).catch((e) => setError(e.message));
  useEffect(() => { if (view === "quotes" && !quotes.length) void loadQuotes(); }, [view]);
  const openQuoteForm = () => { setShowQuote(true); setQuoteForm({ customerId: "", note: "", lines: {} }); setQuotePick({ productId: "", quantity: 1 }); Promise.all([get<Product[]>("/products"), get<Contact[]>("/customers")]).then(([p, c]) => { setQuoteProducts(p); setQuoteCustomers(c); }).catch((e) => notify(e.message, "error")); };
  const quoteLines = Object.entries(quoteForm.lines).map(([productId, quantity]) => ({ product: quoteProducts.find((p) => p.id === productId), quantity })).filter((line) => line.product);
  // دور ۳۵ — باگ «بیش از دو کالا اضافه نمی‌شد»: select بدون گزینهٔ خالی،
  // بعد از هر افزودن مقدار React را به "" برمی‌گرداند ولی همان کالای قبلی
  // را نشان می‌داد؛ انتخاب همان کالا رویداد change نمی‌داد و دکمهٔ افزودن
  // بی‌صدا کاری نمی‌کرد. حالا گزینهٔ «انتخاب کالا…» + دکمهٔ غیرفعال تا
  // حالت همیشه صادق باشد، و Enter هم قلم را اضافه می‌کند نه فرم را.
  const quotePickRef = useRef<HTMLSelectElement>(null);
  const addQuoteLine = () => {
    if (!quotePick.productId || !(quotePick.quantity > 0)) return;
    setQuoteForm((old) => ({ ...old, lines: { ...old.lines, [quotePick.productId]: (old.lines[quotePick.productId] || 0) + quotePick.quantity } }));
    setQuotePick({ productId: "", quantity: 1 });
    quotePickRef.current?.focus();
  };
  const quoteTotal = quoteLines.reduce((sum, line) => sum + Math.round((line.product!.wholesalePrice != null && line.product!.wholesaleMinQty != null && line.quantity >= line.product!.wholesaleMinQty ? line.product!.wholesalePrice : line.product!.price) * line.quantity), 0);
  const saveQuote = async (event: FormEvent) => {
    event.preventDefault();
    if (!quoteLines.length) { notify(t("حداقل یک کالا به پیش‌فاکتور اضافه کنید."), "error"); return; }
    setQuoteBusy(true);
    try {
      await post("/quotes", { customerId: quoteForm.customerId || undefined, note: quoteForm.note || undefined, items: quoteLines.map(({ product, quantity }) => ({ productId: product!.id, quantity })) });
      setShowQuote(false); notify(t("پیش‌فاکتور ذخیره شد."));
      void loadQuotes();
    } catch (e) { notify((e as Error).message, "error"); } finally { setQuoteBusy(false); }
  };
  const convertQuote = async (quote: Quote) => {
    setConvertBusy(true);
    try {
      // Serialized lines (and kits with serialized components) name their
      // units at conversion time — when the devices actually change hands.
      const detail = await get<Quote>(`/quotes/${quote.id}`);
      const products = await get<Product[]>("/products");
      setQuoteProducts(products);
      const needs = (detail.items || []).filter((item) => { const product = products.find((row) => row.id === item.productId); return product ? serializedNeed(product, item.quantity) > 0 : false; });
      if (!needs.length) {
        if (!window.confirm(t("این پیش‌فاکتور به فروش واقعی تبدیل شود؟ موجودی کالاها بررسی و کسر می‌شود."))) return;
        await post(`/quotes/${quote.id}/convert`, { items: [] });
        notify(t("پیش‌فاکتور به فروش تبدیل شد.")); void loadQuotes();
      } else { setConverting(detail); setConvertSerials({}); setConvertSerialOptions({}); }
    } catch (e) { notify((e as Error).message, "error"); } finally { setConvertBusy(false); }
  };
  // In-stock serials for the conversion pickers — fetched when the modal
  // opens and the quote's products are loaded.
  useEffect(() => {
    if (!converting) return;
    const ids = new Set<string>();
    for (const item of converting.items || []) {
      const product = quoteProducts.find((row) => row.id === item.productId);
      if (product) for (const group of serialGroups(product, item.quantity)) ids.add(group.key);
    }
    if (!ids.size) { setConvertSerialOptions({}); return; }
    let alive = true;
    Promise.all([...ids].map((id) => get<Array<{ serial: string }>>(`/inventory/serials?productId=${id}&status=IN_STOCK`)))
      .then((lists) => { if (alive) setConvertSerialOptions(Object.fromEntries([...ids].map((id, index) => [id, lists[index].map((row) => row.serial)]))); })
      .catch(() => { if (alive) setConvertSerialOptions({}); });
    return () => { alive = false; };
  }, [converting, quoteProducts]);
  const submitConvert = async (event: FormEvent) => {
    event.preventDefault();
    if (!converting) return;
    for (const item of converting.items || []) {
      const product = quoteProducts.find((row) => row.id === item.productId);
      const need = product ? serializedNeed(product, item.quantity) : 0;
      if (!need) continue;
      const entered = (convertSerials[item.id] || "").split(/[\n,،\s]+/).filter(Boolean);
      if (entered.length !== need) {
        notify(product!.isBundle
          ? t("برای «{name}» سریال/IMEI اجزای سریال‌دار را وارد کنید ({count} مورد).", { name: item.name, count: String(need) })
          : t("برای «{name}» سریال/IMEI هر دستگاه را وارد کنید ({count} مورد).", { name: item.name, count: String(need) }), "error");
        return;
      }
    }
    setConvertBusy(true);
    try {
      await post(`/quotes/${converting.id}/convert`, { items: (converting.items || []).map((item) => ({ itemId: item.id, serials: (convertSerials[item.id] || "").split(/[\n,،\s]+/).filter(Boolean) })) });
      notify(t("پیش‌فاکتور به فروش تبدیل شد.")); setConverting(null); setConvertSerialOptions({}); void loadQuotes();
    } catch (e) { notify((e as Error).message, "error"); } finally { setConvertBusy(false); }
  };
  /** دیدن اقلام پیش‌فاکتور ذخیره‌شده — تبدیل‌شده و ابطال‌شده هم قابل مرور باشند. */
  const openQuoteDetail = (quote: Quote) => { setViewingQuote(quote); get<Quote>(`/quotes/${quote.id}`).then(setViewingQuote).catch((e) => notify(e.message, "error")); };
  const voidQuote = async (quote: Quote) => {
    if (!window.confirm(t("این پیش‌فاکتور ابطال شود؟"))) return;
    try { await post(`/quotes/${quote.id}/void`, {}); notify(t("پیش‌فاکتور ابطال شد.")); void loadQuotes(); }
    catch (e) { notify((e as Error).message, "error"); }
  };
  return <div className="page-stack"><div className="toolbar" style={{ marginBottom: 0 }}><div className="segmented"><button className={view === "sales" ? "active" : ""} onClick={() => setView("sales")}>{t("فروش‌ها")}</button><button className={view === "quotes" ? "active" : ""} onClick={() => setView("quotes")}>{t("پیش‌فاکتورها")}</button></div>{view === "quotes" && <button className="primary-button" onClick={openQuoteForm}><CirclePlus size={16}/>{t("پیش‌فاکتور جدید")}</button>}</div>
    {view === "sales" && <section className="surface"><SectionHead title={t("فروش‌های ثبت‌شده")} subtitle={t("فاکتورها با فیلتر تاریخ و امکان برگشت کالا")}/><div className="toolbar"><div className="search-box"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی شماره فاکتور یا مشتری…")}/></div><div className="toolbar-filters">{(["", "CASH", "MOBILE", "CREDIT", "WALLET"] as const).map((value) => <button key={value || "all"} type="button" className={`chip ${method === value ? "active" : ""}`} onClick={() => applyMethod(value)}>{value ? payLabelRaw(value) : t("همه")}</button>)}</div><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyRange(iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyRange(range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyRange(isoOf(new Date()), isoOf(new Date()))}>{t("امروز")}</button><button className="text-button" onClick={() => applyRange(isoOf(new Date(Date.now() - 6 * 86400000)), isoOf(new Date()))}>{t("۷ روز اخیر")}</button>{(range.from || range.to) && <button className="text-button danger-text" onClick={() => applyRange("", "")}>{t("حذف فیلتر")}</button>}<ExportMenu onExport={exportSales} disabled={!filtered.length}/><span className="toolbar-count">{totalRows} {t("فاکتور")} · {t("جمع معتبرها")} {money(totalSum)}</span></div>{error && <ErrorBox message={error}/>}<div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><SortTh label={t("شماره فاکتور")} active={sort.key === "receiptNo"} dir={sort.dir} onClick={() => applySort("receiptNo")}/><SortTh label={t("مشتری")} active={sort.key === "customer"} dir={sort.dir} onClick={() => applySort("customer")}/><th>{t("صندوقدار")}</th><th>{t("اقلام")}</th><th>{t("پرداخت")}</th><SortTh label={t("مبلغ")} active={sort.key === "total"} dir={sort.dir} onClick={() => applySort("total")}/><SortTh label={t("زمان")} active={sort.key === "createdAt"} dir={sort.dir} onClick={() => applySort("createdAt")}/><th></th></tr></thead><tbody>{filtered.map((sale, idx) => <tr key={sale.id} className={sale.voidedAt ? "voided-row" : ""}><td className="muted mono">{(page - 1) * PAGE + idx + 1}</td><td className="mono">{sale.receiptNo}{sale.voidedAt ? <span className="status-pill warning">{t("ابطال‌شده")}</span> : (sale.returns?.length || 0) > 0 && <small className="block stock-low">{t("برگشتی دارد")}</small>}</td><td>{sale.customer?.name || t("مشتری گذری")}</td><td>{sale.user?.displayName || "—"}</td><td>{sale.items.reduce((n, i) => n + i.quantity, 0)} {t("قلم")}</td><td><span className="category-label">{payLabel(sale.paymentMethod)}</span></td><td className="strong">{money(sale.total)}</td><td className="muted">{dateTime(sale.createdAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => openDetail(sale)}>{t("جزئیات")}</button>{!sale.voidedAt && <><button className="text-button" onClick={() => setSharing(sale)}><ReceiptText size={14}/>{t("ارسال")}</button><button className="text-button" onClick={() => void openReturn(sale)}><Undo2 size={14}/>{t("برگشت")}</button></>}</div></td></tr>)}</tbody></table>{!filtered.length && <Empty title={t("فاکتوری برای نمایش نیست")} text={t("فروش‌های ثبت‌شده در اینجا دیده می‌شوند.")}/>}</div><Pagination page={page} pageCount={Math.max(1, Math.ceil(totalRows / PAGE))} shown={filtered.length} total={totalRows} busy={pageBusy} onChange={goToPage}/></section>}
    {view === "quotes" && <section className="surface"><SectionHead title={t("پیش‌فاکتورها")} subtitle={t("پیشنهاد قیمت برای مشتری — با تأیید او به فروش تبدیل می‌شود")}/><div className="toolbar"><span className="toolbar-count">{quotes.length} {t("پیش‌فاکتور")}</span><ExportMenu onExport={exportQuotes} disabled={!quotes.length}/></div>{error && <ErrorBox message={error}/>}<div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("مشتری")}</th><th>{t("اقلام")}</th><th>{t("مبلغ")}</th><th>{t("وضعیت")}</th><th>{t("زمان")}</th><th></th></tr></thead><tbody>{quotes.map((quote) => <tr key={quote.id}><td className="mono">{quote.quoteNo}</td><td>{quote.customer?.name || t("بدون مشتری")}</td><td>{quote._count?.items ?? quote.items?.length ?? "—"}</td><td className="strong">{money(quote.total)}</td><td><span className={`status-pill ${quote.status === "OPEN" ? "warning" : quote.status === "CONVERTED" ? "paid" : "unpaid"}`}>{quote.status === "OPEN" ? t("باز") : quote.status === "CONVERTED" ? t("تبدیل‌شده") : t("ابطال‌شده")}</span></td><td className="muted">{dateTime(quote.createdAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => openQuoteDetail(quote)}>{t("مشاهده")}</button>{quote.status === "OPEN" && <><button className="text-button" onClick={() => void convertQuote(quote)}><Check size={14}/>{t("تبدیل به فروش")}</button><button className="text-button danger-text" onClick={() => void voidQuote(quote)}><X size={14}/>{t("ابطال")}</button></>}</div></td></tr>)}</tbody></table>{!quotes.length && <Empty title={t("پیش‌فاکتوری نیست")} text={t("با دکمهٔ «پیش‌فاکتور جدید» یک پیشنهاد قیمت بسازید.")}/>}</div>{quotes.length >= 100 && <div className="load-more"><button className="secondary-button" onClick={() => void loadQuotes(quotes.length)}>{t("نمایش پیش‌فاکتورهای بیشتر")}</button><small className="muted">{t("{count} پیش‌فاکتور بارگذاری شد", { count: String(quotes.length) })}</small></div>}</section>}
    {showQuote && <Modal title={t("پیش‌فاکتور جدید")} onClose={() => setShowQuote(false)}><form className="form-grid single" onSubmit={saveQuote}><Field label={t("مشتری (اختیاری)")}><select value={quoteForm.customerId} onChange={(e) => setQuoteForm({ ...quoteForm, customerId: e.target.value })}><option value="">{t("بدون مشتری")}</option>{quoteCustomers.filter((c) => c.name !== "مشتری گذری").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label={t("افزودن کالا")}><div className="row-actions"><select ref={quotePickRef} value={quotePick.productId} onChange={(e) => setQuotePick({ ...quotePick, productId: e.target.value })} style={{ flex: 1 }}><option value="">{t("انتخاب کالا…")}</option>{quoteProducts.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}</option>)}</select><input type="number" min={quoteProducts.find((p) => p.id === quotePick.productId)?.isWeighted ? 0.001 : 1} step={quoteProducts.find((p) => p.id === quotePick.productId)?.isWeighted ? 0.001 : 1} value={quotePick.quantity} onChange={(e) => setQuotePick({ ...quotePick, quantity: numberValue(e) })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addQuoteLine(); } }} style={{ width: "5rem" }} dir="ltr"/><button type="button" className="secondary-button" disabled={!quotePick.productId || !(quotePick.quantity > 0)} onClick={addQuoteLine}><CirclePlus size={15}/>{t("افزودن")}</button></div></Field>{quoteLines.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("قیمت")}</th><th></th></tr></thead><tbody>{quoteLines.map(({ product, quantity }) => <tr key={product!.id}><td><b>{product!.name}</b></td><td>{qty(quantity)} {product!.unit}</td><td className="strong">{money(Math.round((product!.wholesalePrice != null && product!.wholesaleMinQty != null && quantity >= product!.wholesaleMinQty ? product!.wholesalePrice : product!.price) * quantity))}</td><td><button type="button" className="text-button danger-text" onClick={() => setQuoteForm((old) => { const lines = { ...old.lines }; delete lines[product!.id]; return { ...old, lines }; })}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div>}<div className="cart-totals" style={{ marginTop: 8 }}><div className="grand-total"><span>{t("مبلغ پیش‌فاکتور")}</span><strong>{money(quoteTotal)}</strong></div></div><Field label={t("یادداشت")}><input value={quoteForm.note} onChange={(e) => setQuoteForm({ ...quoteForm, note: e.target.value })}/></Field><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShowQuote(false)}>{t("انصراف")}</button><button className="primary-button" disabled={quoteBusy || !quoteLines.length}>{quoteBusy ? t("در حال ذخیره…") : t("ذخیرهٔ پیش‌فاکتور")}</button></div></form></Modal>}
    {viewingQuote && <Modal title={t("پیش‌فاکتور {no}", { no: viewingQuote.quoteNo })} onClose={() => setViewingQuote(null)}><div className="receipt-meta"><span>{t("مشتری")}</span><b>{viewingQuote.customer?.name || t("بدون مشتری")}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(viewingQuote.createdAt)}</b></div><div className="receipt-meta"><span>{t("وضعیت")}</span><b>{viewingQuote.status === "OPEN" ? t("باز") : viewingQuote.status === "CONVERTED" ? t("تبدیل‌شده") : t("ابطال‌شده")}</b></div>{viewingQuote.note && <div className="receipt-meta"><span>{t("یادداشت")}</span><b>{viewingQuote.note}</b></div>}<div className="table-wrap" style={{ marginTop: "0.75rem" }}><table><thead><tr><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("قیمت واحد")}</th><th>{t("جمع")}</th></tr></thead><tbody>{(viewingQuote.items || []).map((item) => <tr key={item.id}><td><b>{item.name}</b><small className="block muted">{item.sku}</small></td><td>{qty(item.quantity)}</td><td>{money(item.unitPrice)}</td><td className="strong">{money(item.lineTotal)}</td></tr>)}</tbody></table></div><div className="form-actions"><span>{t("مبلغ پیش‌فاکتور:")}<b>{money(viewingQuote.total)}</b></span><button className="secondary-button" onClick={() => setViewingQuote(null)}>{t("بستن")}</button></div></Modal>}
    {converting && <Modal title={t("تبدیل به فروش — {no}", { no: converting.quoteNo })} onClose={() => setConverting(null)}><form className="form-grid single" onSubmit={submitConvert}>
      <p className="muted" style={{ margin: 0 }}>{t("برای اقلام سریال‌دار، شمارهٔ سریال/IMEI دستگاه‌هایی را که تحویل می‌دهید وارد کنید.")}</p>
      <div className="table-wrap"><table><thead><tr><th>{t("کالا")}</th><th>{t("تعداد")}</th><th></th></tr></thead><tbody>{(converting.items || []).map((item) => { const product = quoteProducts.find((row) => row.id === item.productId); const need = product ? serializedNeed(product, item.quantity) : 0; return <tr key={item.id}><td><b>{item.name}</b>{product?.isBundle && <small className="block muted">{t("بسته — اجزای آن از انبار کم می‌شود")} {(product.bundleComponents || []).map((row) => `${row.component?.name || "?"} × ${row.quantity}`).join(" + ")}</small>}</td><td>{qty(item.quantity)}</td><td style={{ minWidth: "14rem" }}>{need > 0 && <div className="return-serials">{serialGroups(product!, item.quantity).map((group) => <SerialPicker key={group.key} label={group.label} need={group.need} available={convertSerialOptions[group.key] || []} value={convertSerials[item.id] || ""} onChange={(next) => setConvertSerials({ ...convertSerials, [item.id]: next })}/>)}</div>}</td></tr>; })}</tbody></table></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setConverting(null)}>{t("انصراف")}</button><button className="primary-button" disabled={convertBusy}>{convertBusy ? t("در حال ذخیره…") : t("تبدیل به فروش")}</button></div>
    </form></Modal>}
    {selected && <Modal title={t("جزئیات فاکتور")} onClose={() => setSelected(null)}><div className="receipt-print"><div className="receipt-brand">{brand.appName}</div><p>{shop.shopName?.trim() || t("فروشگاه من")}</p><div className="receipt-divider"/><div className="receipt-meta"><span>{t("شماره فاکتور")}</span><b>{selected.receiptNo}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(selected.createdAt)}</b></div><div className="receipt-meta"><span>{t("مشتری")}</span><b>{selected.customer?.name || "مشتری گذری"}</b></div><div className="receipt-divider"/>{selected.items.map((item) => <div className="receipt-item" key={item.id}><span>{item.name} × {item.quantity}</span><b>{money(item.lineTotal)}</b></div>)}<div className="receipt-divider"/><div className="receipt-meta"><span>{t("جمع کل")}</span><strong>{money(selected.total)}</strong></div>{selected.discount > 0 && <div className="receipt-meta"><span>{t("تخفیف")}</span><b>{money(selected.discount)}</b></div>}<div className="receipt-meta"><span>{t("روش پرداخت")}</span><b>{payLabel(selected.paymentMethod)}</b></div></div>{selected.voidedAt && <div className="hint-box void-banner"><AlertTriangle size={17}/><div><b>{t("این فاکتور ابطال شده است.")}</b><span>{t("دلیل: {reason} — ابطال‌کننده: {by} — زمان: {at}", { reason: selected.voidReason || "—", by: selected.voidedBy || "—", at: dateTime(selected.voidedAt) })}</span><span>{t("موجودی کالاها، کیف پول مشتری و صندوق در زمان ابطال اصلاح شده‌اند؛ سابقهٔ فاکتور حفظ می‌شود.")}</span></div></div>}
{(selected.returns?.length || 0) > 0 && <div className="hint-box">{t("برگشتی‌های این فاکتور:")} {selected.returns!.reduce((n, r) => n + r.total, 0) > 0 ? money(selected.returns!.reduce((n, r) => n + r.total, 0)) : ""} ({selected.returns!.map((r) => r.returnNo).join(t("، "))})</div>}<div className="form-actions">{user.role === "ADMIN" && !selected.voidedAt && <button className="danger-button" onClick={() => { setVoiding(selected); setVoidReason(""); }}><X size={17}/>{t("ابطال فاکتور")}</button>}{!selected.voidedAt && <button className="secondary-button" onClick={() => { setSelected(null); void openReturn(selected); }}><Undo2 size={17}/>{t("برگشت کالا")}</button>}<button className="secondary-button" onClick={() => setSelected(null)}>{t("بستن")}</button><button className="secondary-button" onClick={() => printHtml(invoiceHtml(selected, shop), { width: "auto", title: t("فاکتور فروش") })}><FileText size={17}/>{t("فاکتور A4")}</button><button className="primary-button" onClick={() => printHtml(saleReceiptHtml(selected, shop))}><Printer size={17}/>{t("چاپ فاکتور")}</button></div></Modal>}
    {voiding && <Modal title={t("ابطال فاکتور {no}", { no: voiding.receiptNo })} onClose={() => { setVoiding(null); setVoidReason(""); }}><form className="form-grid single" onSubmit={submitVoid}>
      <div className="hint-box void-banner"><AlertTriangle size={17}/><div><b>{t("ابطال، فاکتور را حذف نمی‌کند.")}</b><span>{t("کالاها به موجودی برمی‌گردند، پرداخت کیف پول به مشتری برگشت داده می‌شود، بخش نقدی از صندوقِ باز کسر می‌شود و دلیل ابطال در سابقه ثبت می‌ماند. این عمل بازگشت‌پذیر نیست.")}</span></div></div>
      <Field label={t("دلیل ابطال (الزامی)")}><textarea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t("مثلاً: فاکتور به‌اشتباه برای مشتری دیگری صادر شد")} required minLength={3} maxLength={300}/></Field>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setVoiding(null); setVoidReason(""); }}>{t("انصراف")}</button><button className="danger-button" disabled={voidBusy || voidReason.trim().length < 3}>{voidBusy ? t("در حال ابطال…") : t("ابطال قطعی فاکتور")}</button></div>
    </form></Modal>}
    {returning && <Modal title={t("برگشت کالا — فاکتور {no}", { no: returning.receiptNo })} onClose={() => setReturning(null)} wide><form onSubmit={submitReturn}>
      <div className="hint-box return-guide"><Undo2 size={17}/><div><b>{t("چند عدد از هر کالا را مشتری برمی‌گرداند؟")}</b><span>{t("برای هر کالا تعداد برگشتی را با دکمه‌های − و + یا تایپ عدد مشخص کنید؛ «۰» یعنی آن کالا برگشت نمی‌شود. کالاهای برگشتی دوباره به انبار اضافه می‌شوند. برگشت همهٔ اقلام = مبلغ نهایی فاکتور (با تخفیف)؛ برگشت جزئی = به قیمت همان کالا.")}</span></div></div>
      {!returnDetail && <Loading/>}
      {returnDetail && <div className="return-lines">{returnDetail.items.map((item) => {
        const previous = returnedQty(returnDetail, item.productId);
        const remaining = item.quantity - previous;
        const value = returnLines[item.productId] || 0;
        const setQty = (next: number) => setReturnLines({ ...returnLines, [item.productId]: Math.min(remaining, Math.max(0, Math.round(next * 1000) / 1000)) });
        return <div className={`return-line ${remaining <= 0 ? "spent" : ""}`} key={item.id}>
          <div className="return-line-info"><b>{item.name}</b><small className="muted">{item.sku}</small><small className="muted">{t("خریده‌شده: {bought} · برگشتی قبلی: {back} · قیمت واحد: {price}", { bought: qty(item.quantity), back: qty(previous), price: money(item.unitPrice) })}</small></div>
          {remaining <= 0 ? <span className="status-pill neutral">{t("همه برگشت داده شده")}</span> : <>
            <div className="qty-stepper" dir="ltr">
              <button type="button" onClick={() => setQty(value - 1)} disabled={value <= 0} aria-label={t("کم کردن")}>−</button>
              <input type="number" min="0" max={remaining} step={remaining % 1 !== 0 ? 0.001 : 1} value={value} onChange={(e) => setQty(Number(e.target.value) || 0)} dir="ltr" aria-label={t("تعداد برگشتی")}/>
              <button type="button" onClick={() => setQty(value + 1)} disabled={value >= remaining} aria-label={t("زیاد کردن")}>+</button>
              <button type="button" className="chip" onClick={() => setQty(remaining)}>{t("همه")}</button>
            </div>
            <b className="return-line-refund" title={t("مبلغ برگشتی همین کالا")} dir="ltr">{moneyPlain(Math.round(item.unitPrice * value))}</b>
          {(() => { const product = returnProducts.find((row) => row.id === item.productId); const need = product ? serializedNeed(product, value) : 0; if (!need) return null; const lineUnits = returnSerialUnits.filter((unit) => unit.saleItemId === item.id); return <div className="return-serials">{serialGroups(product!, value).map((group) => <SerialPicker key={group.key} label={group.label} need={group.need} available={group.key === product!.id ? lineUnits.map((unit) => unit.serial) : lineUnits.filter((unit) => unit.productId === group.key).map((unit) => unit.serial)} value={returnSerials[item.productId] || ""} onChange={(next) => setReturnSerials({ ...returnSerials, [item.productId]: next })}/>)}</div>; })()}
          </>}
        </div>;
      })}</div>}
      {returnDetail && <div className="return-summary">
        <span>{t("{count} عدد از {lines} قلم کالا", { count: qty(Object.values(returnLines).reduce((sum, quantity) => sum + quantity, 0)), lines: String(Object.values(returnLines).filter((quantity) => quantity > 0).length) })}</span>
        <b>{t("مبلغ برگشتی به مشتری:")} {money(refundEstimate)}</b>
        <small className="muted">{returning.paymentMethod === "CASH" ? t("بخش نقدی از صندوق باز کسر می‌شود.") : returning.paymentMethod === "CREDIT" ? t("به همان اندازه از بدهی مشتری کم می‌شود.") : returning.paymentMethod === "WALLET" ? t("مبلغ به کیف پول مشتری برمی‌گردد.") : t("به‌صورت حسابی ثبت می‌شود؛ نقد صندوق تغییر نمی‌کند.")}</small>
      </div>}
      {returnDetail && <div className="form-grid single" style={{ marginTop: "0.75rem" }}><Field label={t("یادداشت برگشت (اختیاری)")}><input value={returnNote} onChange={(e) => setReturnNote(e.target.value)} placeholder={t("مثلاً کالا معیوب بود")}/></Field></div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setReturning(null)}>{t("انصراف")}</button><button className="danger-button" disabled={returnBusy || !returnDetail || Object.values(returnLines).every((quantity) => !quantity)}>{returnBusy ? t("در حال ثبت…") : t("ثبت برگشت")}</button></div>
    </form></Modal>}
    {sharing && <ShareReceiptModal sale={sharing} onClose={() => setSharing(null)}/>}
    {returnReceipt && <Modal title={t("برگشت ثبت شد")} onClose={() => setReturnReceipt(null)}><div className="receipt-print"><div className="receipt-brand">{brand.appName}</div><p>{shop.shopName?.trim() || t("فروشگاه من")}</p><div className="receipt-divider"/><div className="receipt-meta"><span>{t("شماره برگشتی")}</span><b>{returnReceipt.record.returnNo}</b></div><div className="receipt-meta"><span>{t("فاکتور اصلی")}</span><b>{returnReceipt.sale.receiptNo}</b></div><div className="receipt-meta"><span>{t("زمان")}</span><b>{dateTime(returnReceipt.record.createdAt)}</b></div><div className="receipt-divider"/>{(returnReceipt.record.items || []).map((item) => <div className="receipt-item" key={item.id}><span>{item.name} × {item.quantity}</span><b>{money(item.lineTotal)}</b></div>)}<div className="receipt-divider"/><div className="receipt-meta"><span>{t("مبلغ برگشتی")}</span><strong>{money(returnReceipt.record.total)}</strong></div>{returnReceipt.record.note && <div className="receipt-meta"><span>{t("یادداشت")}</span><b>{returnReceipt.record.note}</b></div>}<p className="receipt-thanks">{shop.receiptFooter?.trim() || t("از خرید شما سپاس‌گزاریم")}</p></div><div className="form-actions"><button className="secondary-button" onClick={() => setReturnReceipt(null)}>{t("بستن")}</button><button className="primary-button" onClick={() => printHtml(returnSlipHtml(returnReceipt.sale, returnReceipt.record, shop))}><Printer size={17}/>{t("چاپ رسید برگشتی")}</button></div></Modal>}
  </div>;
}
function payLabel(method: Sale["paymentMethod"]): string { return payLabelRaw(method); }
function payLabelRaw(method: string) { return ({ CASH: t("نقدی"), MOBILE: t("موبایلی"), CREDIT: t("نسیه"), WALLET: t("کیف پول") } as Record<string, string>)[method] || method; }
/** "+۱۲٪" / "−۸٪" / "—" for period-comparison deltas. */
function deltaLabel(delta: number | null | undefined): string {
  if (delta == null) return "—";
  return `${delta > 0 ? "▲" : delta < 0 ? "▼" : ""}${Math.abs(delta)}٪`;
}

type ReportTab = "profit" | "debtors" | "purchases" | "discounts" | "inventory" | "customers" | "suppliers";
export function ReportsPage({ notify }: { notify: Notify }) {
  const today = isoOf(new Date());
  const [shop, setShop] = useState<ShopSettings>({});
  useEffect(() => { get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const monthAgo = isoOf(new Date(Date.now() - 29 * 86400000));
  const [range, setRange] = useState({ from: monthAgo, to: today });
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [debtors, setDebtors] = useState<DebtorsReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  // مرکز گزارش‌ها: هر گزارش یک سربرگ مستقل با خروجی خودش دارد.
  const [tab, setTab] = useState<ReportTab>("profit");
  const [purchasesReport, setPurchasesReport] = useState<PurchasesReport | null>(null);
  const [discountsReport, setDiscountsReport] = useState<DiscountsReport | null>(null);
  const [customersReport, setCustomersReport] = useState<CustomersReport | null>(null);
  const [suppliersReport, setSuppliersReport] = useState<SuppliersReport | null>(null);
  const [inventoryReport, setInventoryReport] = useState<InventoryReport | null>(null);
  const apply = (from: string, to: string, withCompare = compare) => {
    setRange({ from, to }); setError(""); setBusy(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (withCompare) params.set("compare", "1");
    get<ProfitReport>(`/reports/profit?${params.toString()}`).then(setReport).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  /** گزارش‌های بازه‌ای تازه (خرید/تخفیف/مشتری/تأمین‌کننده) — همهٔ آن‌ها
   *  فاکتورهای ابطال‌شده را کنار می‌گذارند. */
  const applyTopic = (which: ReportTab, from = range.from, to = range.to) => {
    setRange({ from, to }); setError(""); setBusy(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const query = `?${params.toString()}`;
    const fail = (e: Error) => setError(e.message);
    const done = () => setBusy(false);
    if (which === "purchases") get<PurchasesReport>(`/reports/purchases${query}`).then(setPurchasesReport).catch(fail).finally(done);
    else if (which === "discounts") get<DiscountsReport>(`/reports/discounts${query}`).then(setDiscountsReport).catch(fail).finally(done);
    else if (which === "customers") get<CustomersReport>(`/reports/customers${query}`).then(setCustomersReport).catch(fail).finally(done);
    else if (which === "suppliers") get<SuppliersReport>(`/reports/suppliers${query}`).then(setSuppliersReport).catch(fail).finally(done);
  };
  // رفتن به یک سربرگ: گزارشِ هنوز‌بارگذاری‌نشده با بازهٔ جاری می‌آید.
  useEffect(() => {
    if (tab === "profit" && !report) apply(range.from, range.to);
    if (tab === "purchases" && !purchasesReport) applyTopic("purchases");
    if (tab === "discounts" && !discountsReport) applyTopic("discounts");
    if (tab === "customers" && !customersReport) applyTopic("customers");
    if (tab === "suppliers" && !suppliersReport) applyTopic("suppliers");
    if (tab === "inventory" && !inventoryReport) get<InventoryReport>("/reports/inventory").then(setInventoryReport).catch((e) => setError(e.message));
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportProfitCsv = () => {
    if (!report) return;
    const rows: string[][] = [
      [t("بازه"), `${report.from?.slice(0, 10) || ""} — ${report.to?.slice(0, 10) || ""}`],
      [t("درآمد ناخالص"), String(report.revenue)], [t("بازپرداخت‌ها"), String(report.refunds)], [t("درآمد خالص"), String(report.netRevenue)],
      [t("بهای کالای فروخته‌شده"), String(report.cost)], [t("سود ناخالص"), String(report.profit)], [t("هزینه‌های دوره"), String(report.expenses)],
      [t("سود خالص"), String(report.netProfit)], [t("حاشیهٔ سود"), percent(report.margin * 100)], [t("خرید دوره"), String(report.purchasesTotal)], [t("تعداد فاکتور"), String(report.invoiceCount)],
      [], [t("فروش و سود روزانه")], [t("روز"), t("فروش خالص"), t("سود")],
      ...report.byDay.map((row) => [row.day, String(row.revenue), String(row.profit)]),
    ];
    const stamp = `${report.from?.slice(0, 10) || "all"}_${report.to?.slice(0, 10) || "all"}`;
    void exportCsvFile(`profit-${stamp}.csv`, rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  const exportDebtorsCsv = () => {
    if (!debtors) return;
    const rows: string[][] = [[t("نوع"), t("نام"), t("شماره تماس"), t("بدهی")]];
    for (const customer of debtors.customers) rows.push([t("مشتری"), customer.name, customer.phone || "", String(customer.balance)]);
    for (const supplier of debtors.suppliers) rows.push([t("تأمین‌کننده"), supplier.name, supplier.phone || "", String(supplier.balance)]);
    rows.push([], [t("جمع بدهی مشتریان"), String(debtors.customersTotal)], [t("جمع بدهی به تأمین‌کنندگان"), String(debtors.suppliersTotal)]);
    void exportCsvFile("debtors.csv", rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  useEffect(() => { apply(monthAgo, today); }, []);
  useEffect(() => { get<DebtorsReport>("/reports/debtors").then(setDebtors).catch(() => undefined); }, []);
  const exportPurchasesReportCsv = () => {
    if (!purchasesReport) return;
    const rows: string[][] = [[t("بازه"), `${purchasesReport.from.slice(0, 10)} — ${purchasesReport.to.slice(0, 10)}`], [t("تعداد رسید"), String(purchasesReport.invoiceCount)], [t("جمع خرید"), String(purchasesReport.total)], [t("پرداخت‌شده"), String(purchasesReport.paid)], [t("مانده"), String(purchasesReport.outstanding)], [], [t("خرید به تفکیک تأمین‌کننده")], [t("تأمین‌کننده"), t("تعداد رسید"), t("جمع")], ...purchasesReport.bySupplier.map((row) => [row.name, String(row.count), String(row.total)]), [], [t("خرید روزانه")], [t("روز"), t("جمع")], ...purchasesReport.byDay.map((row) => [row.day, String(row.total)])];
    void exportCsvFile(`purchases-report-${purchasesReport.from.slice(0, 10)}_${purchasesReport.to.slice(0, 10)}.csv`, rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  const exportDiscountsCsv = () => {
    if (!discountsReport) return;
    const rows: string[][] = [[t("بازه"), `${discountsReport.from.slice(0, 10)} — ${discountsReport.to.slice(0, 10)}`], [t("تخفیف فاکتور"), String(discountsReport.invoiceDiscount)], [t("تخفیف قلم"), String(discountsReport.lineDiscount)], [t("جمع تخفیف"), String(discountsReport.total)], [t("فاکتورهای دارای تخفیف"), String(discountsReport.invoiceCount)], [], [t("تخفیف روزانه")], [t("روز"), t("جمع")], ...discountsReport.byDay.map((row) => [row.day, String(row.total)]), [], [t("بیشترین تخفیف روی کالاها")], [t("کالا"), t("تعداد"), t("تخفیف")], ...discountsReport.topProducts.map((row) => [row.name, String(row.quantity), String(row.discount)])];
    void exportCsvFile(`discounts-${discountsReport.from.slice(0, 10)}_${discountsReport.to.slice(0, 10)}.csv`, rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  const exportCustomersReportCsv = () => {
    if (!customersReport) return;
    const rows: string[][] = [[t("بازه"), `${customersReport.from.slice(0, 10)} — ${customersReport.to.slice(0, 10)}`], [t("مشتریان"), String(customersReport.customerCount)], [t("جمع خرید"), String(customersReport.total)], [t("جمع نسیه"), String(customersReport.credit)], [], [t("مشتری"), t("تماس"), t("فاکتور"), t("جمع خرید"), t("نسیه"), t("کیف پول")], ...customersReport.byCustomer.map((row) => [row.name, row.phone || "", String(row.invoices), String(row.total), String(row.credit), String(row.wallet)])];
    void exportCsvFile(`customers-report-${customersReport.from.slice(0, 10)}_${customersReport.to.slice(0, 10)}.csv`, rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  const exportSuppliersReportCsv = () => {
    if (!suppliersReport) return;
    const rows: string[][] = [[t("بازه"), `${suppliersReport.from.slice(0, 10)} — ${suppliersReport.to.slice(0, 10)}`], [t("تأمین‌کنندگان"), String(suppliersReport.supplierCount)], [t("جمع خرید"), String(suppliersReport.total)], [t("پرداخت‌شده"), String(suppliersReport.paid)], [], [t("تأمین‌کننده"), t("تماس"), t("رسید"), t("جمع خرید"), t("پرداخت‌شده")], ...suppliersReport.bySupplier.map((row) => [row.name, row.phone || "", String(row.invoices), String(row.total), String(row.paid)])];
    void exportCsvFile(`suppliers-report-${suppliersReport.from.slice(0, 10)}_${suppliersReport.to.slice(0, 10)}.csv`, rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  const exportInventoryCsv = () => {
    if (!inventoryReport) return;
    const rows: string[][] = [[t("تعداد کالا"), String(inventoryReport.productCount)], [t("ارزش موجودی قفسه"), String(inventoryReport.stockValue)], [t("ارزش انبار پشتی"), String(inventoryReport.backstockValue)], [t("ارزش کل"), String(inventoryReport.totalValue)], [t("کم‌موجود"), String(inventoryReport.lowStockCount)], [t("ناموجود"), String(inventoryReport.outOfStockCount)], [t("در حال انقضا"), String(inventoryReport.expiringCount)], [t("ارزش در حال انقضا"), String(inventoryReport.expiringValue)], [], [t("دسته‌بندی"), t("تعداد کالا"), t("ارزش")], ...inventoryReport.byCategory.map((row) => [row.name, String(row.count), String(row.value)])];
    void exportCsvFile("inventory-report.csv", rows, notify).catch((e) => notify((e as Error).message, "error"));
  };
  return <div className="page-stack">
    <section className="surface"><SectionHead title={t("مرکز گزارش‌ها")} subtitle={t("هر گزارش بازه و خروجی خودش را دارد؛ فاکتورهای ابطال‌شده در هیچ گزارشی حساب نمی‌شوند.")}/><div className="toolbar" style={{ flexWrap: "wrap" }}><div className="segmented" style={{ flexWrap: "wrap" }}>{([["profit", t("سود و فروش")], ["debtors", t("بدهی‌داران")], ["purchases", t("خریدها")], ["discounts", t("تخفیف‌ها")], ["inventory", t("موجودی انبار")], ["customers", t("مشتریان")], ["suppliers", t("تأمین‌کنندگان")]] as const).map(([value, label]) => <button key={value} type="button" className={tab === value ? "active" : ""} onClick={() => { setTab(value); setError(""); }}>{label}</button>)}</div>{busy && <span className="toolbar-count">{t("در حال محاسبه…")}</span>}</div></section>
    {tab === "profit" && <section className="surface"><SectionHead title={t("گزارش سود و فروش")} subtitle={t("سود ناخالص، پرفروش‌ترین کالاها و تفکیک روش پرداخت")} action={report ? <div className="row-actions"><button className="secondary-button" onClick={() => printHtml(reportHtml(report, shop), { width: "auto", title: t("گزارش سود و فروش") })}><Printer size={16}/>{t("چاپ گزارش")}</button><button className="secondary-button" onClick={() => { printHtml(reportHtml(report, shop), { width: "auto", title: t("گزارش سود و فروش") }); notify(t("برای ساخت فایل PDF، در پنجرهٔ چاپ چاپگر «Microsoft Print to PDF» را انتخاب کنید.")); }}><FileDown size={16}/>{t("خروجی PDF")}</button><button className="secondary-button" onClick={exportProfitCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/><div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => apply(iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => apply(range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => apply(today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => apply(isoOf(new Date(Date.now() - 6 * 86400000)), today)}>{t("۷ روز")}</button><button className="text-button" onClick={() => apply(monthAgo, today)}>{t("۳۰ روز")}</button><label className="checkbox-row" style={{ margin: 0 }}><input type="checkbox" checked={compare} onChange={(e) => { setCompare(e.target.checked); apply(range.from, range.to, e.target.checked); }} title={t("مقایسه با دورهٔ هم‌طول قبل")}/>{t("مقایسه با دورهٔ قبل")}</label>{busy && <span className="toolbar-count">{t("در حال محاسبه…")}</span>}</div>{error && <ErrorBox message={error}/>}
      {!report && !error && <Loading/>}
      {report?.truncated && <div className="hint-box"><AlertTriangle size={17}/>{t("بازهٔ انتخابی از سقف گزارش (۵۰٬۰۰۰ فاکتور) بزرگ‌تر است — این گزارش فقط {shown} فاکتور از {total} فاکتورِ بازه را پوشش می‌دهد. برای نتیجهٔ کامل، بازه را به سال‌های کوچک‌تر بشکنید.", { shown: report.invoiceCount.toLocaleString("fa-AF"), total: (report.trueInvoiceCount ?? report.invoiceCount).toLocaleString("fa-AF") })}</div>}
      {report?.comparison && <div className="hint-box"><ArrowDownUp size={17}/>{t("نسبت به دورهٔ هم‌طول قبل — درآمد: {revenue} · سود ناخالص: {profit} · سود خالص: {netProfit} · فاکتورها: {invoices}", {
        revenue: deltaLabel(report.comparison.revenue),
        profit: deltaLabel(report.comparison.profit),
        netProfit: deltaLabel(report.comparison.netProfit),
        invoices: deltaLabel(report.comparison.invoiceCount),
      })}</div>}
      {report && <div className="metric-grid">
        <Metric icon={Banknote} label={t("درآمد ناخالص")} value={money(report.revenue)} note={report.truncated ? t("{shown} از {count} فاکتور", { shown: report.invoiceCount.toLocaleString("fa-AF"), count: (report.trueInvoiceCount ?? report.invoiceCount).toLocaleString("fa-AF") }) : t("{count} فاکتور", { count: report.invoiceCount })} tone="blue"/>
        <Metric icon={Undo2} label={t("بازپرداخت‌ها")} value={money(report.refunds)} note={t("برگشتی‌های دوره")} tone="amber"/>
        <Metric icon={ShoppingCart} label={t("درآمد خالص")} value={money(report.netRevenue)} note={t("پس از کسر برگشتی")} tone="violet"/>
        <Metric icon={Package} label={t("بهای کالای فروخته‌شده")} value={money(report.cost)} note={t("به قیمت خرید")} tone="blue"/>
        <Metric icon={Banknote} label={t("سود ناخالص")} value={money(report.profit)} note={t("درآمد خالص − بهای کالا")} tone="green"/>
        <Metric icon={ReceiptText} label={t("هزینه‌های دوره")} value={money(report.expenses)} note={t("دخل و خرج فروشگاه")} tone="amber"/>
        <Metric icon={Check} label={t("سود خالص")} value={money(report.netProfit)} note={t("سود ناخالص − هزینه‌ها")} tone={report.netProfit >= 0 ? "green" : "amber"}/>
        <Metric icon={Check} label={t("حاشیهٔ سود")} value={percent(report.margin * 100)} note={t("سود به ازای هر فروش")} tone={report.profit >= 0 ? "green" : "amber"}/>
        <Metric icon={Truck} label={t("خرید دوره")} value={money(report.purchasesTotal)} note={t("رسیدهای خرید ثبت‌شده")} tone="violet"/>
        <Metric icon={Wallet} label={t("تفکیک پرداخت")} value={money(report.paymentMix.reduce((sum, mix) => sum + mix.total, 0))} note={report.paymentMix.map((mix) => `${payLabelRaw(mix.method)} ${money(mix.total)}`).join(" · ") || "—"} tone="amber"/>
      </div>}
      {report && report.unknownCostRevenue > 0 && <div className="hint-box"><AlertTriangle size={17}/> {t("برای فروش‌هایی که پیش از نسخهٔ ۰.۳ ثبت شده‌اند بهای خرید در فاکتور ذخیره نشده است؛ سود این فروش‌ها ({amount}) بیش‌برآورد می‌شود. گزارش‌های تازه دقیق هستند.", { amount: money(report.unknownCostRevenue) })}</div>}
    </section>}
    {tab === "profit" && report && <div className="dashboard-grid">
      <section className="surface"><SectionHead title={t("فروش بر اساس دسته‌بندی")} subtitle={t("سهم هر دسته از فروش دوره")}/>{report.byCategory.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("دسته‌بندی")}</th><th>{t("تعداد")}</th><th>{t("فروش")}</th><th>{t("سود")}</th></tr></thead><tbody>{report.byCategory.map((row, idx) => <tr key={row.category}><td className="muted mono">{idx + 1}</td><td><b>{row.category}</b></td><td>{qty(row.quantity)}</td><td className="strong">{money(row.revenue)}</td><td>{money(row.profit)}</td></tr>)}</tbody></table></div>}{!report.byCategory.length && <Empty title={t("داده‌ای نیست")} text={t("کالاهای فروخته‌شده دسته‌بندی ندارند.")}/>}</section>
      <section className="surface"><SectionHead title={t("ساعت‌های پرکار")}/>{report.byHour.length > 0 && <div className="chart-bars hour-bars">{report.byHour.map((row) => {
        const max = Math.max(...report.byHour.map((entry) => entry.revenue), 1);
        return <div className="chart-bar" key={row.hour} title={`${row.hour}:00 — ${money(row.revenue)} (${row.count})`}>
          <span className="chart-bar-value">{row.revenue > 0 ? moneyPlain(row.revenue) : ""}</span>
          <div className="chart-bar-fill" style={{ height: `${Math.max(row.revenue > 0 ? 6 : 0, Math.round((row.revenue / max) * 100))}%` }}/>
          <small>{String(row.hour).padStart(2, "0")}</small>
        </div>;
      })}</div>}{!report.byHour.length && <Empty title={t("داده‌ای نیست")} text={t("در این بازه فروشی ثبت نشده است.")}/>}</section>
      <section className="surface"><SectionHead title={t("فروش و سود روزانه")} subtitle={t("روندهای بازهٔ انتخابی")}/><div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("روز")}</th><th>{t("فروش خالص")}</th><th>{t("سود")}</th></tr></thead><tbody>{[...report.byDay].reverse().map((row, idx) => <tr key={row.day}><td className="muted mono">{idx + 1}</td><td>{dayLabel(row.day)}</td><td className="strong">{money(row.revenue)}</td><td className={row.profit >= 0 ? "green-text" : "danger-text"}>{money(row.profit)}</td></tr>)}</tbody></table>{!report.byDay.length && <Empty title={t("فروشی در این بازه نیست")} text={t("بازهٔ دیگری را انتخاب کنید.")}/>}</div></section>
      {Boolean(report.byUser?.length) && <section className="surface"><SectionHead title={t("فروش به تفکیک صندوقدار")} subtitle={t("درآمد و سود هر کاربر در این بازه")}/><div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("صندوقدار")}</th><th>{t("فاکتور")}</th><th>{t("درآمد")}</th><th>{t("سود")}</th></tr></thead><tbody>{report.byUser!.map((row, idx) => <tr key={row.userId}><td className="muted mono">{idx + 1}</td><td><b>{row.cashier}</b></td><td>{row.count}</td><td className="strong">{money(row.revenue)}</td><td className="green-text">{money(row.profit)}</td></tr>)}</tbody></table></div></section>}
      {Boolean(report.bySession?.length) && <section className="surface"><SectionHead title={t("فروش به تفکیک شیفت صندوق")} subtitle={t("هر شیفت چقدر فروخت")}/><div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("شیفت")}</th><th>{t("صندوقدار")}</th><th>{t("فاکتور")}</th><th>{t("درآمد")}</th></tr></thead><tbody>{report.bySession!.map((row, idx) => <tr key={row.sessionId}><td className="muted mono">{idx + 1}</td><td className="mono" title={row.sessionId}>{dateTime(row.openedAt)}{row.closedAt ? ` → ${timeOnly(row.closedAt)}` : ` · ${t("باز")}`}</td><td>{row.cashier}</td><td>{row.count}</td><td className="strong">{money(row.revenue)}</td></tr>)}</tbody></table></div></section>}
      <section className="surface"><SectionHead title={t("پرفروش‌ترین کالاها")} subtitle={t("به ترتیب مبلغ فروش")}/><div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("فروش")}</th><th>{t("سود")}</th></tr></thead><tbody>{report.topProducts.map((product, idx) => <tr key={product.productId}><td className="muted mono">{idx + 1}</td><td><b>{product.name}</b></td><td>{product.quantity}</td><td className="strong">{money(product.revenue)}</td><td className="green-text">{money(product.profit)}</td></tr>)}</tbody></table>{!report.topProducts.length && <Empty title={t("کالایی فروخته نشده")} text={t("پس از ثبت فروش، پرفروش‌ها در اینجا دیده می‌شوند.")}/>}</div></section>
    </div>}
    {tab === "debtors" && (!debtors ? <section className="surface"><Loading/></section> : <section className="surface"><SectionHead title={t("بدهی‌داران و بدهی‌ها")} subtitle={t("ماندهٔ مشتریان: {customers} · بدهی به تأمین‌کنندگان: {suppliers}", { customers: money(debtors.customersTotal), suppliers: money(debtors.suppliersTotal) })} action={<div className="row-actions"><button className="secondary-button" onClick={() => printHtml(debtorsHtml(debtors, shop), { width: "auto", title: t("گزارش بدهی‌ها") })}><Printer size={16}/>{t("چاپ")}</button><button className="secondary-button" onClick={exportDebtorsCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div>}/><div className="dashboard-grid">
      <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("مشتری بدهکار")}</th><th>{t("تماس")}</th><th>{t("مانده")}</th><th title={t("نسیه‌های ۰ تا ۳۰ روز")}>۰–۳۰</th><th title={t("نسیه‌های ۳۱ تا ۶۰ روز")}>۳۱–۶۰</th><th title={t("نسیه‌های بیشتر از ۶۰ روز")}>+۶۰</th></tr></thead><tbody>{debtors.customers.map((customer, idx) => <tr key={customer.id}><td className="muted mono">{idx + 1}</td><td><b>{customer.name}</b></td><td dir="ltr" className="text-right">{customer.phone || "—"}</td><td className="strong danger-text">{money(customer.balance)}</td><td className="muted">{customer.aging?.d30 ? money(customer.aging.d30) : "—"}</td><td className="muted">{customer.aging?.d60 ? money(customer.aging.d60) : "—"}</td><td className={customer.aging?.older ? "danger-text" : "muted"}>{customer.aging?.older ? money(customer.aging.older) : "—"}</td></tr>)}</tbody></table>{!debtors.customers.length && <Empty title={t("بدهکاری نیست")} text={t("همهٔ مشتریان تسویه‌اند.")}/>}</div>
      <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("تأمین‌کننده")}</th><th>{t("تماس")}</th><th>{t("مانده")}</th></tr></thead><tbody>{debtors.suppliers.map((supplier, idx) => <tr key={supplier.id}><td className="muted mono">{idx + 1}</td><td><b>{supplier.name}</b></td><td dir="ltr" className="text-right">{supplier.phone || "—"}</td><td className="strong danger-text">{money(supplier.balance)}</td></tr>)}</tbody></table>{!debtors.suppliers.length && <Empty title={t("بدهی نیست")} text={t("به تأمین‌کننده‌ای بدهی ندارید.")}/>}</div>
    </div></section>)}
    {tab === "purchases" && <section className="surface"><SectionHead title={t("گزارش خریدها")} subtitle={t("جمع خرید، پرداخت‌شده و مانده به تفکیک تأمین‌کننده و روز")} action={purchasesReport ? <div className="row-actions"><button className="secondary-button" onClick={exportPurchasesReportCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/><div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyTopic("purchases", iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyTopic("purchases", range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyTopic("purchases", today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => applyTopic("purchases", monthAgo, today)}>{t("۳۰ روز")}</button></div>{error && <ErrorBox message={error}/>}{!purchasesReport && !error && <Loading/>}
      {purchasesReport && <div className="metric-grid">
        <Metric icon={Truck} label={t("جمع خرید دوره")} value={money(purchasesReport.total)} note={t("{count} رسید", { count: String(purchasesReport.invoiceCount) })} tone="violet"/>
        <Metric icon={Wallet} label={t("پرداخت‌شده")} value={money(purchasesReport.paid)} note={t("در زمان خرید و پس از آن")} tone="green"/>
        <Metric icon={Banknote} label={t("مانده به تأمین‌کنندگان")} value={money(purchasesReport.outstanding)} note={t("رسیدهای نسیه")} tone="amber"/>
      </div>}
      {purchasesReport && <div className="dashboard-grid">
        <section className="surface"><SectionHead title={t("خرید به تفکیک تأمین‌کننده")}/>{purchasesReport.bySupplier.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("تأمین‌کننده")}</th><th>{t("رسید")}</th><th>{t("جمع خرید")}</th></tr></thead><tbody>{purchasesReport.bySupplier.map((row, idx) => <tr key={row.name}><td className="muted mono">{idx + 1}</td><td><b>{row.name}</b></td><td>{row.count}</td><td className="strong">{money(row.total)}</td></tr>)}</tbody></table></div>}{!purchasesReport.bySupplier.length && <Empty title={t("داده‌ای نیست")} text={t("در این بازه خریدی ثبت نشده است.")}/>}</section>
        <section className="surface"><SectionHead title={t("خرید روزانه")}/>{purchasesReport.byDay.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("روز")}</th><th>{t("جمع خرید")}</th></tr></thead><tbody>{[...purchasesReport.byDay].reverse().map((row, idx) => <tr key={row.day}><td className="muted mono">{idx + 1}</td><td>{dayLabel(row.day)}</td><td className="strong">{money(row.total)}</td></tr>)}</tbody></table></div>}{!purchasesReport.byDay.length && <Empty title={t("داده‌ای نیست")} text={t("در این بازه خریدی ثبت نشده است.")}/>}</section>
      </div>}
    </section>}
    {tab === "discounts" && <section className="surface"><SectionHead title={t("گزارش تخفیف‌ها")} subtitle={t("تخفیف فاکتور و تخفیف قلم، به تفکیک روز و کالا")} action={discountsReport ? <div className="row-actions"><button className="secondary-button" onClick={exportDiscountsCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/><div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyTopic("discounts", iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyTopic("discounts", range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyTopic("discounts", today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => applyTopic("discounts", monthAgo, today)}>{t("۳۰ روز")}</button></div>{error && <ErrorBox message={error}/>}{!discountsReport && !error && <Loading/>}
      {discountsReport && <div className="metric-grid">
        <Metric icon={Percent} label={t("جمع تخفیف‌ها")} value={money(discountsReport.total)} note={t("{count} فاکتور دارای تخفیف", { count: String(discountsReport.invoiceCount) })} tone="amber"/>
        <Metric icon={ReceiptText} label={t("تخفیف روی فاکتور")} value={money(discountsReport.invoiceDiscount)} note={t("تخفیف نهایی کل فاکتور")} tone="blue"/>
        <Metric icon={ShoppingBag} label={t("تخفیف روی اقلام")} value={money(discountsReport.lineDiscount)} note={t("تخفیف قلم‌به‌قلم")} tone="violet"/>
      </div>}
      {discountsReport && <div className="dashboard-grid">
        <section className="surface"><SectionHead title={t("تخفیف روزانه")}/>{discountsReport.byDay.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("روز")}</th><th>{t("جمع تخفیف")}</th></tr></thead><tbody>{[...discountsReport.byDay].reverse().map((row, idx) => <tr key={row.day}><td className="muted mono">{idx + 1}</td><td>{dayLabel(row.day)}</td><td className="strong">{money(row.total)}</td></tr>)}</tbody></table></div>}{!discountsReport.byDay.length && <Empty title={t("تخفیفی ثبت نشده")} text={t("در این بازه تخفیفی داده نشده است.")}/>}</section>
        <section className="surface"><SectionHead title={t("بیشترین تخفیف روی کالاها")}/>{discountsReport.topProducts.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("کالا")}</th><th>{t("تعداد")}</th><th>{t("تخفیف")}</th></tr></thead><tbody>{discountsReport.topProducts.map((row, idx) => <tr key={row.name}><td className="muted mono">{idx + 1}</td><td><b>{row.name}</b></td><td>{qty(row.quantity)}</td><td className="strong">{money(row.discount)}</td></tr>)}</tbody></table></div>}{!discountsReport.topProducts.length && <Empty title={t("تخفیفی ثبت نشده")} text={t("در این بازه تخفیفی داده نشده است.")}/>}</section>
      </div>}
    </section>}
    {tab === "inventory" && <section className="surface"><SectionHead title={t("گزارش موجودی انبار")} subtitle={t("ارزش خرید موجودی، کم‌موجودها و کالاهای در حال انقضا")} action={inventoryReport ? <div className="row-actions"><button className="secondary-button" onClick={exportInventoryCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/>{error && <ErrorBox message={error}/>}{!inventoryReport && !error && <Loading/>}
      {inventoryReport && <div className="metric-grid">
        <Metric icon={Boxes} label={t("ارزش کل انبار")} value={money(inventoryReport.totalValue)} note={t("قفسه + انبار پشتی، به قیمت خرید")} tone="green"/>
        <Metric icon={Package} label={t("ارزش قفسه")} value={money(inventoryReport.stockValue)} note={t("{count} کالا", { count: String(inventoryReport.productCount) })} tone="blue"/>
        <Metric icon={Archive} label={t("ارزش انبار پشتی")} value={money(inventoryReport.backstockValue)} note={t("موجودی پشت فروشگاه")} tone="violet"/>
      </div>}
      {inventoryReport && <div className="metric-grid">
        <Metric icon={AlertTriangle} label={t("کم‌موجود")} value={String(inventoryReport.lowStockCount)} note={t("زیر حداقل موجودی")} tone="amber"/>
        <Metric icon={X} label={t("ناموجود")} value={String(inventoryReport.outOfStockCount)} note={t("موجودی صفر")} tone="amber"/>
        <Metric icon={History} label={t("در حال انقضا")} value={String(inventoryReport.expiringCount)} note={t("ارزش: {value} — تا ۱۴ روز آینده", { value: money(inventoryReport.expiringValue) })} tone="amber"/>
      </div>}
      {inventoryReport && inventoryReport.byCategory.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("دسته‌بندی")}</th><th>{t("تعداد کالا")}</th><th>{t("ارزش (قفسه + پشتی)")}</th></tr></thead><tbody>{inventoryReport.byCategory.map((row, idx) => <tr key={row.name}><td className="muted mono">{idx + 1}</td><td><b>{row.name}</b></td><td>{row.count}</td><td className="strong">{money(row.value)}</td></tr>)}</tbody></table></div>}
    </section>}
    {tab === "customers" && <section className="surface"><SectionHead title={t("گزارش مشتریان")} subtitle={t("خرید، نسیه و کیف پول به تفکیک مشتری در بازهٔ انتخابی")} action={customersReport ? <div className="row-actions"><button className="secondary-button" onClick={exportCustomersReportCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/><div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyTopic("customers", iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyTopic("customers", range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyTopic("customers", today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => applyTopic("customers", monthAgo, today)}>{t("۳۰ روز")}</button></div>{error && <ErrorBox message={error}/>}{!customersReport && !error && <Loading/>}
      {customersReport && <div className="metric-grid">
        <Metric icon={UsersRound} label={t("مشتریان این بازه")} value={String(customersReport.customerCount)} note={t("مشتریان با حداقل یک خرید")} tone="blue"/>
        <Metric icon={ShoppingCart} label={t("جمع خرید مشتریان")} value={money(customersReport.total)} note={t("فاکتورهای معتبر")} tone="green"/>
        <Metric icon={Banknote} label={t("جمع نسیه")} value={money(customersReport.credit)} note={t("بخش نسیهٔ همین فاکتورها")} tone="amber"/>
      </div>}
      {customersReport && customersReport.byCustomer.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("مشتری")}</th><th>{t("تماس")}</th><th>{t("فاکتور")}</th><th>{t("جمع خرید")}</th><th>{t("نسیه")}</th><th>{t("کیف پول")}</th></tr></thead><tbody>{customersReport.byCustomer.map((row, idx) => <tr key={row.name + (row.phone || "")}><td className="muted mono">{idx + 1}</td><td><b>{row.name}</b></td><td dir="ltr" className="text-right">{row.phone || "—"}</td><td>{row.invoices}</td><td className="strong">{money(row.total)}</td><td>{row.credit > 0 ? money(row.credit) : "—"}</td><td>{row.wallet > 0 ? money(row.wallet) : "—"}</td></tr>)}</tbody></table></div>}
      {customersReport && !customersReport.byCustomer.length && <Empty title={t("داده‌ای نیست")} text={t("در این بازه مشتریِ شناخته‌شده‌ای خرید نکرده است.")}/>}
    </section>}
    {tab === "suppliers" && <section className="surface"><SectionHead title={t("گزارش تأمین‌کنندگان")} subtitle={t("خرید و پرداخت به تفکیک تأمین‌کننده در بازهٔ انتخابی")} action={suppliersReport ? <div className="row-actions"><button className="secondary-button" onClick={exportSuppliersReportCsv}><FileText size={16}/>{t("خروجی CSV")}</button></div> : undefined}/><div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyTopic("suppliers", iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyTopic("suppliers", range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyTopic("suppliers", today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => applyTopic("suppliers", monthAgo, today)}>{t("۳۰ روز")}</button></div>{error && <ErrorBox message={error}/>}{!suppliersReport && !error && <Loading/>}
      {suppliersReport && <div className="metric-grid">
        <Metric icon={Truck} label={t("تأمین‌کنندگان این بازه")} value={String(suppliersReport.supplierCount)} note={t("تأمین‌کنندگان با حداقل یک رسید")} tone="violet"/>
        <Metric icon={ShoppingBag} label={t("جمع خرید")} value={money(suppliersReport.total)} note={t("رسیدهای معتبر")} tone="blue"/>
        <Metric icon={Wallet} label={t("پرداخت‌شده")} value={money(suppliersReport.paid)} note={t("مانده: {amount}", { amount: money(Math.max(0, suppliersReport.total - suppliersReport.paid)) })} tone="green"/>
      </div>}
      {suppliersReport && suppliersReport.bySupplier.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("تأمین‌کننده")}</th><th>{t("تماس")}</th><th>{t("رسید")}</th><th>{t("جمع خرید")}</th><th>{t("پرداخت‌شده")}</th></tr></thead><tbody>{suppliersReport.bySupplier.map((row, idx) => <tr key={row.name + (row.phone || "")}><td className="muted mono">{idx + 1}</td><td><b>{row.name}</b></td><td dir="ltr" className="text-right">{row.phone || "—"}</td><td>{row.invoices}</td><td className="strong">{money(row.total)}</td><td>{money(row.paid)}</td></tr>)}</tbody></table></div>}
      {suppliersReport && !suppliersReport.bySupplier.length && <Empty title={t("داده‌ای نیست")} text={t("در این بازه از تأمین‌کننده‌ای خرید ثبت نشده است.")}/>}
    </section>}
  </div>;
}

export function CashPage({ notify }: { notify: Notify }) {
  const [current, setCurrent] = useState<CashSession | null>(null); const [sessions, setSessions] = useState<CashSession[]>([]); const [show, setShow] = useState<"open" | "movement" | "close" | null>(null); const [form, setForm] = useState({ amount: 0, type: "IN", description: "", note: "" }); const [error, setError] = useState(""); const [saving, setSaving] = useState(false); const [zReport, setZReport] = useState<ZReport | null>(null); const [shop, setShop] = useState<ShopSettings>({});
  const load = () => Promise.all([get<CashSession | null>("/cash/current"), get<CashSession[]>("/cash/sessions")]).then(([c, s]) => { setCurrent(c); setSessions(s); }).catch((e) => setError(e.message)); useEffect(() => { void load(); }, []); useEffect(() => { get<ShopSettings>("/settings").then(setShop).catch(() => undefined); }, []);
  const save = async (event: FormEvent) => { event.preventDefault(); setError(""); setSaving(true); try { if (show === "open") await post("/cash/open", { openingCash: form.amount, note: form.note }); if (show === "movement") await post("/cash/movement", { amount: form.amount, type: form.type, description: form.description }); if (show === "close") { const result = await post<{ difference: number; z?: ZReport }>("/cash/close", { countedCash: form.amount, note: form.note }); notify(t("صندوق بسته شد. اختلاف: {difference}.", { difference: money(result.difference) }), result.difference === 0 ? "success" : "error"); if (result.z) setZReport(result.z); } else notify(show === "open" ? t("صندوق باز شد.") : t("گردش صندوق ثبت شد.")); setShow(null); setForm({ amount: 0, type: "IN", description: "", note: "" }); await load(); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } };
  const exportSessions = (kindOfExport: "csv" | "pdf") => {
    const header = [t("شروع"), t("صندوقدار"), t("نقد آغازین"), t("مورد انتظار"), t("نقد شمارش‌شده"), t("اختلاف"), t("وضعیت")];
    const rows: Array<Array<string | number>> = sessions.map((session) => [dateTime(session.openedAt), session.user?.displayName || "—", session.openingCash, session.expectedCash || 0, session.countedCash ?? "—", session.countedCash === null ? "—" : (session.countedCash ?? 0) - (session.expectedCash || 0), session.status === "OPEN" ? t("باز") : t("بسته")]);
    if (kindOfExport === "csv") { void exportCsvFile("cash-sessions.csv", [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("سوابق صندوق"), subtitle: `${sessions.length} ${t("نوبت کاری")}`, columns: [{ label: t("شروع") }, { label: t("صندوقدار") }, { label: t("نقد آغازین"), numeric: true }, { label: t("مورد انتظار"), numeric: true }, { label: t("نقد شمارش‌شده"), numeric: true }, { label: t("اختلاف"), numeric: true }, { label: t("وضعیت") }], rows }, shop.shopName);
  };
  return <div className="page-stack"><section className={`cash-hero ${current ? "is-open" : "is-closed"}`}><div className="cash-hero-icon"><Banknote size={24}/></div><div className="grow"><span className="eyebrow">{t("وضعیت نوبت کاری")}</span><h2>{current ? t("صندوق باز است") : t("صندوق بسته است")}</h2><p>{current ? t("شروع: {time} · {user}", { time: dateTime(current.openedAt), user: current.user?.displayName || t("کاربر") }) : t("برای ثبت فروش نقدی ابتدا صندوق را باز کنید.")}</p></div><span className={`status-pill ${current ? "paid" : "warning"}`}>{current ? t("فعال") : t("بسته")}</span></section>
    {error && <ErrorBox message={error}/>}<div className="metric-grid cash-metrics"><Metric icon={Banknote} label={t("نقد آغازین")} value={money(current?.openingCash ?? 0)} note={t("در ابتدای نوبت کاری")} tone="blue"/><Metric icon={ShoppingCart} label={t("فروش نقدی")} value={money(current?.cashSalesAmount ?? 0)} note={t("فاکتورهای پرداخت‌شده نقدی")} tone="green"/><Metric icon={ArrowUpRight} label={t("مبلغ مورد انتظار")} value={money(current?.expectedCash ?? 0)} note={t("نقد صندوق در پایان نوبت")} tone="violet"/><Metric icon={FileText} label={t("نوبت‌های کاری")} value={String(sessions.length)} note={t("سوابق صندوق")} tone="amber"/></div>
    <section className="surface"><SectionHead title={t("عملیات صندوق")} subtitle={t("ورودی‌ها و خروجی‌های نقدی را ثبت کنید")} action={current ? <><button className="secondary-button" onClick={() => setShow("movement")}><ArrowDownUp size={16}/>{t("ورود / خروج")}</button><button className="danger-button" onClick={() => { setForm({ amount: current.expectedCash, type: "IN", description: "", note: "" }); setShow("close"); }}>{t("بستن صندوق")}</button></> : <button className="primary-button" onClick={() => { setForm({ amount: 0, type: "IN", description: "", note: "" }); setShow("open"); }}><CirclePlus size={17}/>{t("باز کردن صندوق")}</button>}/>{current?.movements?.length ? <div className="movement-list">{current.movements.map((movement) => <div className="movement-row" key={movement.id}><div className={`movement-icon ${movement.type.toLowerCase()}`}>{movement.type === "IN" ? <ArrowDownLeft size={17}/> : <ArrowUpRight size={17}/>}</div><div className="grow"><b>{movement.description}</b><small>{movement.type === "IN" ? t("ورودی نقدی") : t("خروجی نقدی")}</small></div><strong className={movement.type === "IN" ? "green-text" : "danger-text"}>{movement.type === "IN" ? "+" : "−"}{money(movement.amount)}</strong></div>)}</div> : <Empty title={t("گردش دستی ثبت نشده")} text={t("هزینه‌ها و ورودی‌های متفرقه صندوق را می‌توانید ثبت کنید.")}/>}</section>
    <section className="surface"><SectionHead title={t("سوابق صندوق")} subtitle={t("آخرین نوبت‌های کاری")}/><div className="toolbar"><ExportMenu onExport={exportSessions} disabled={!sessions.length}/><span className="toolbar-count">{sessions.length} {t("نوبت کاری")}</span></div><div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("شروع")}</th><th>{t("صندوقدار")}</th><th>{t("نقد آغازین")}</th><th>{t("مورد انتظار")}</th><th>{t("نقد شمارش‌شده")}</th><th>{t("وضعیت")}</th></tr></thead><tbody>{sessions.map((session, idx) => <tr key={session.id}><td className="muted mono">{idx + 1}</td><td>{dateTime(session.openedAt)}</td><td>{session.user?.displayName || "—"}</td><td>{money(session.openingCash)}</td><td>{money(session.expectedCash || 0)}</td><td>{session.countedCash === null ? "—" : money(session.countedCash)}</td><td><span className={`status-pill ${session.status === "OPEN" ? "paid" : "neutral"}`}>{session.status === "OPEN" ? t("باز") : t("بسته")}</span></td></tr>)}</tbody></table>{!sessions.length && <Empty title={t("سابقه‌ای نیست")} text={t("با بازکردن صندوق، نوبت کاری ثبت می‌شود.")}/>}</div></section>
    {show && <Modal title={show === "open" ? t("باز کردن صندوق") : show === "close" ? t("بستن صندوق") : t("ثبت گردش نقدی")} onClose={() => setShow(null)}><form className="form-grid single" onSubmit={save}><Field label={show === "open" ? t("نقد آغازین (افغانی)") : show === "close" ? t("مبلغ شمارش‌شده (افغانی)") : t("مبلغ (افغانی)")}><input required type="number" min="0" autoFocus value={form.amount} onChange={(e) => setForm({ ...form, amount: numberValue(e) })}/></Field>{show === "movement" && <><Field label={t("نوع گردش")}><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="IN">{t("ورودی")}</option><option value="OUT">{t("خروجی")}</option></select></Field><Field label={t("شرح")}><input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("مثلاً هزینه حمل‌ونقل")}/></Field></>}{show !== "movement" && <Field label={t("یادداشت")}><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}/></Field>}{show === "close" && current && <div className="hint-box">{t("مبلغ مورد انتظار: {amount} · اختلاف پس از بستن نشان داده می‌شود.", { amount: money(current.expectedCash) })}</div>}{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShow(null)}>{t("انصراف")}</button><button className={show === "close" ? "danger-button" : "primary-button"} disabled={saving}>{saving ? t("در حال ثبت…") : show === "close" ? t("بستن و ثبت شمارش") : t("ذخیره")}</button></div></form></Modal>}
    {zReport && <Modal title={t("گزارش پایان نوبت (Z)")} onClose={() => setZReport(null)}><div className="z-grid">
      <Metric icon={Banknote} label={t("فروش نقدی")} value={money(zReport.cashSales)} note={t("در این نوبت کاری")} tone="green"/>
      <Metric icon={ShoppingCart} label={t("پرداخت موبایلی")} value={money(zReport.mobileSales)} note={t("در این نوبت کاری")} tone="violet"/>
      <Metric icon={Wallet} label={t("فروش نسیه")} value={money(zReport.creditSales)} note={t("در این نوبت کاری")} tone="amber"/>
      <Metric icon={FileText} label={t("تعداد فاکتور")} value={String(zReport.invoiceCount)} note={t("فاکتورهای این نوبت")} tone="blue"/>
      <Metric icon={Undo2} label={t("برگشتی‌ها")} value={money(zReport.returnsTotal)} note={t("بازپرداخت به مشتریان")} tone="amber"/>
      <Metric icon={ArrowUpRight} label={t("مبلغ مورد انتظار")} value={money(zReport.expected)} note={t("نقد آغازین + فروش نقدی + ورودی − خروجی")} tone="violet"/>
      <Metric icon={Check} label={t("نقد شمارش‌شده")} value={money(zReport.counted)} note={t("مقداری که شمردید")} tone="blue"/>
      <Metric icon={zReport.difference === 0 ? Check : AlertTriangle} label={t("اختلاف صندوق")} value={money(zReport.difference)} note={zReport.difference === 0 ? t("تسویه کامل") : t("اختلاف را بررسی کنید")} tone={zReport.difference === 0 ? "green" : "amber"}/>
    </div><div className="form-actions"><button className="secondary-button" onClick={() => setZReport(null)}>{t("بستن")}</button><button className="primary-button" onClick={() => printHtml(zReportHtml(zReport, shop), { title: t("گزارش پایان نوبت (Z)") })}><Printer size={17}/>{t("چاپ گزارش نوبت")}</button></div></Modal>}
  </div>;
}

type ManagedUser = User & { isActive: boolean; createdAt: string };
export function ExpensesPage({ notify, user: _user }: { notify: Notify; user: User }) {
  const today = isoOf(new Date());
  const monthAgo = isoOf(new Date(Date.now() - 29 * 86400000));
  const [range, setRange] = useState({ from: monthAgo, to: today });
  const [data, setData] = useState<ExpenseList | null>(null);
  const [cash, setCash] = useState<CashSession | null>(null);
  const [form, setForm] = useState({ title: "", category: "", amount: 0, note: "", fromCash: true });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = (from = range.from, to = range.to) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    get<ExpenseList>(`/expenses?${params.toString()}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { load(range.from, range.to); get<CashSession | null>("/cash/current").then(setCash).catch(() => undefined); }, []);
  const applyRange = (from: string, to: string) => { setRange({ from, to }); load(from, to); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      await post("/expenses", { title: form.title, amount: form.amount, category: form.category || undefined, note: form.note || undefined, fromCash: form.fromCash });
      notify(t("هزینه ثبت شد."));
      setForm({ title: "", category: form.category, amount: 0, note: "", fromCash: form.fromCash });
      load(); get<CashSession | null>("/cash/current").then(setCash).catch(() => undefined);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm(t("این هزینه حذف شود؟"))) return;
    try { await del(`/expenses/${id}`); notify(t("هزینه حذف شد.")); load(); } catch (e) { notify((e as Error).message, "error"); }
  };
  const exportExpenses = (kindOfExport: "csv" | "pdf") => {
    const header = [t("عنوان"), t("دسته"), t("مبلغ"), t("پرداخت"), t("ثبت‌کننده"), t("زمان")];
    const rows: Array<Array<string | number>> = (data?.list || []).map((expense) => [expense.title, expense.category || t("متفرقه"), expense.amount, expense.fromCash ? t("از صندوق") : t("خارج از صندوق"), expense.user?.displayName || "—", dateTime(expense.createdAt)]);
    const stamp = `${range.from || "all"}_${range.to || isoOf(new Date())}`;
    if (kindOfExport === "csv") { void exportCsvFile(`expenses-${stamp}.csv`, [header, ...rows.map((row) => row.map((cell) => String(cell)))], notify).catch((e) => notify((e as Error).message, "error")); return; }
    exportTablePdf({ title: t("دخل و خرج فروشگاه"), subtitle: `${t("بازه")}: ${range.from ? dayLabel(range.from) : t("همه")} — ${range.to ? dayLabel(range.to) : t("همه")} · ${data?.list.length ?? 0} ${t("مورد")}`, columns: [{ label: t("عنوان") }, { label: t("دسته") }, { label: t("مبلغ"), numeric: true }, { label: t("پرداخت") }, { label: t("ثبت‌کننده") }, { label: t("زمان") }], rows, summary: [[t("جمع بازه"), money(data?.total || 0)]] });
  };
  return <div className="page-stack">
    <section className="surface"><SectionHead title={t("دخل و خرج فروشگاه")} subtitle={t("هزینه‌های جاری فروشگاه و اثر آن‌ها بر سود خالص")} action={data ? <div className="metric-chip"><ReceiptText size={16}/>{t("جمع بازه:")} <b>{money(data.total)}</b></div> : undefined}/>
      <div className="toolbar"><div className="date-filter"><DateField value={range.from} onChange={(iso) => applyRange(iso, range.to)} title={t("از تاریخ")}/><DateField value={range.to} onChange={(iso) => applyRange(range.from, iso)} title={t("تا تاریخ")}/></div><button className="text-button" onClick={() => applyRange(today, today)}>{t("امروز")}</button><button className="text-button" onClick={() => applyRange(monthAgo, today)}>{t("۳۰ روز")}</button><button className="text-button" onClick={() => applyRange("", "")}>{t("همه")}</button><ExportMenu onExport={exportExpenses} disabled={!data?.list.length}/><span className="toolbar-count">{data?.list.length ?? 0} {t("مورد")}</span></div>
      {error && <ErrorBox message={error}/>}
      {!data && !error && <Loading/>}
      {data && <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("عنوان")}</th><th>{t("دسته")}</th><th>{t("مبلغ")}</th><th>{t("پرداخت")}</th><th>{t("ثبت‌کننده")}</th><th>{t("زمان")}</th><th></th></tr></thead><tbody>{data.list.map((expense, idx) => <tr key={expense.id}><td className="muted mono">{idx + 1}</td><td><b>{expense.title}</b>{expense.note && <small className="block muted">{expense.note}</small>}</td><td><span className="category-label">{expense.category || t("متفرقه")}</span></td><td className="strong danger-text">{money(expense.amount)}</td><td>{expense.fromCash ? <span className="status-pill paid">{t("از صندوق")}</span> : <span className="status-pill neutral">{t("خارج از صندوق")}</span>}</td><td>{expense.user?.displayName || "—"}</td><td className="muted">{dateTime(expense.createdAt)}</td><td><button className="text-button danger-text" onClick={() => void remove(expense.id)}><Trash2 size={14}/>{t("حذف")}</button></td></tr>)}</tbody></table>{!data.list.length && <Empty title={t("هزینه‌ای ثبت نشده")} text={t("کرایه، برق، ترابری و سایر هزینه‌های فروشگاه را اینجا ثبت کنید.")}/>}</div>}
    </section>
    <section className="surface"><SectionHead title={t("ثبت هزینهٔ جدید")} subtitle={t("هزینه‌های پرداخت‌شده از صندوق، هنگام بستن صندوق در گزارش Z دیده می‌شوند.")}/>
      <form className="form-grid" onSubmit={submit}>
        <Field label={t("عنوان هزینه")}><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("مثلاً کرایهٔ ماه")} autoFocus/></Field>
        <Field label={t("دسته (اختیاری)")}><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={t("کرایه، برق، ترابری…")} list="expense-categories"/><datalist id="expense-categories"><option value={t("کرایه")}/><option value={t("برق")}/><option value={t("ترابری")}/><option value={t("بسته‌بندی")}/><option value={t("متفرقه")}/></datalist></Field>
        <Field label={t("مبلغ (افغانی)")}><input required type="number" min="1" value={form.amount || ""} onChange={(e) => setForm({ ...form, amount: numberValue(e) })} dir="ltr"/></Field>
        <Field label={t("یادداشت (اختیاری)")}><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("اختیاری")}/></Field>
        <Field label={t("نحوهٔ پرداخت")}><label className="check-line"><input type="checkbox" checked={form.fromCash} disabled={!cash} onChange={(e) => setForm({ ...form, fromCash: e.target.checked })}/>{t("از صندوق پرداخت شود")}</label>{!cash && <small className="block stock-low">{t("صندوق بسته است؛ هزینه فقط به‌صورت حسابداری ثبت می‌شود.")}</small>}</Field>
        {error && <div className="form-error full">{error}</div>}
        <div className="form-actions full"><button className="primary-button" disabled={busy || !form.title || form.amount <= 0}><ReceiptText size={17}/>{busy ? t("در حال ثبت…") : t("ثبت هزینه")}</button></div>
      </form>
    </section>
  </div>;
}

export function UsersPage({ notify }: { notify: Notify }) {
  const [users, setUsers] = useState<ManagedUser[]>([]); const [show, setShow] = useState(false); const [error, setError] = useState(""); const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "CASHIER" }); const [resetting, setResetting] = useState<ManagedUser | null>(null); const [newPassword, setNewPassword] = useState("");
  const load = () => get<ManagedUser[]>("/users").then(setUsers).catch((e) => setError(e.message)); useEffect(() => { void load(); }, []);
  const save = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await post("/users", form); setShow(false); setForm({ username: "", displayName: "", password: "", role: "CASHIER" }); notify(t("کاربر ساخته شد.")); await load(); } catch (e) { setError((e as Error).message); } };
  const deactivate = async (user: ManagedUser) => { if (!window.confirm(t("دسترسی «{name}» بسته شود؟", { name: user.displayName }))) return; try { await patch(`/users/${user.id}/deactivate`, {}); notify(t("دسترسی کاربر بسته شد.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const activate = async (user: ManagedUser) => { try { await patch(`/users/${user.id}/activate`, {}); notify(t("دسترسی کاربر باز شد.")); await load(); } catch (e) { notify((e as Error).message, "error"); } };
  const submitReset = async (event: FormEvent) => { event.preventDefault(); if (!resetting) return; try { await patch(`/users/${resetting.id}/reset-password`, { newPassword }); notify(t("گذرواژهٔ «{name}» بازنشانی شد.", { name: resetting.displayName })); setResetting(null); setNewPassword(""); } catch (e) { notify((e as Error).message, "error"); } };
  return <div className="page-stack"><section className="surface"><SectionHead title={t("کاربران فروشگاه")} subtitle={t("برای هر فرد نام کاربری جداگانه بسازید")} action={<button className="primary-button" onClick={() => setShow(true)}><CirclePlus size={17}/>{t("کاربر جدید")}</button>}/>{error && <ErrorBox message={error}/>}<div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("کاربر")}</th><th>{t("نام ورود")}</th><th>{t("نقش")}</th><th>{t("وضعیت")}</th><th>{t("ساخته‌شده")}</th><th></th></tr></thead><tbody>{users.map((user, idx) => <tr key={user.id}><td className="muted mono">{idx + 1}</td><td><div className="cell-main"><span className="avatar pale">{user.displayName.slice(0, 1)}</span><b>{user.displayName}</b></div></td><td className="mono">{user.username}</td><td><span className="category-label">{user.role === "ADMIN" ? t("مدیر") : t("صندوقدار")}</span></td><td><span className={`status-pill ${user.isActive ? "paid" : "neutral"}`}>{user.isActive ? t("فعال") : t("بسته")}</span></td><td>{dateOnly(user.createdAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => { setResetting(user); setNewPassword(""); }}><KeyRound size={14}/>{t("بازنشانی گذرواژه")}</button>{user.isActive ? <button className="text-button danger-text" onClick={() => void deactivate(user)}>{t("بستن دسترسی")}</button> : <button className="text-button" onClick={() => void activate(user)}><Undo2 size={14}/>{t("بازکردن دسترسی")}</button>}</div></td></tr>)}</tbody></table>{!users.length && <Empty title={t("کاربری ثبت نشده")} text={t("یک حساب کاربری برای مدیر یا صندوقدار بسازید.")}/>}</div></section>
    <div className="hint-box"><ShieldCheck size={17}/>{t("گذرواژه‌ها به‌صورت رمزگذاری‌شده نگهداری می‌شوند و ورود به سامانه فقط از همین دستگاه انجام می‌شود.")}</div>
    {show && <Modal title={t("ساخت کاربر")} onClose={() => setShow(false)}><form className="form-grid single" onSubmit={save}><Field label={t("نام نمایشی")}><input required autoFocus value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })}/></Field><Field label={t("نام کاربری")}><input required minLength={3} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} dir="ltr"/></Field><Field label={t("گذرواژه (حداقل ۸ نویسه)")}><input required minLength={8} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} dir="ltr"/></Field><Field label={t("نقش")}><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="CASHIER">{t("صندوقدار")}</option><option value="ADMIN">{t("مدیر")}</option></select></Field>{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShow(false)}>{t("انصراف")}</button><button className="primary-button">{t("ذخیره کاربر")}</button></div></form></Modal>}
    {resetting && <Modal title={t("بازنشانی گذرواژهٔ {name}", { name: resetting.displayName })} onClose={() => setResetting(null)}><form className="form-grid single" onSubmit={submitReset}><Field label={t("گذرواژه تازه (حداقل ۸ نویسه)")}><input required minLength={8} type="password" autoFocus value={newPassword} onChange={(e) => setNewPassword(e.target.value)} dir="ltr"/></Field><div className="hint-box"><ShieldCheck size={17}/>{t("پس از بازنشانی، کاربر با گذرواژهٔ تازه وارد می‌شود؛ گذرواژهٔ فعلی لازم نیست.")}</div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setResetting(null)}>{t("انصراف")}</button><button className="primary-button">{t("بازنشانی گذرواژه")}</button></div></form></Modal>}
  </div>;
}

/** برچسب فارسی کلیدهایی که فایل مالک می‌تواند قفل کند — برای بنر صفحهٔ
 *  تنظیمات، تا کاربر به‌جای «ذخیره نشدن» علت واقعی را ببیند. */
const OWNER_LOCKED_LABELS: Record<string, string> = {
  shopName: "نام فروشگاه",
  receiptFooter: "پایین فاکتور",
  logo: "لوگوی رسید",
  address: "نشانی",
  phone: "تلفن",
};

export function SettingsPage({ notify }: { notify: Notify }) {
  const [settings, setSettings] = useState<Record<string, string>>({}); const [shopName, setShopName] = useState(""); const [footer, setFooter] = useState(""); const [currency, setCurrency] = useState("AFN"); const [calendar, setCalendar] = useState<"persian" | "islamic-umalqura" | "gregorian">("persian"); const [timezone, setTimezone] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [backupPath, setBackupPath] = useState(""); const [backupDir, setBackupDir] = useState(""); const [backupDirBusy, setBackupDirBusy] = useState(false); const [backupSchedule, setBackupSchedule] = useState({ enabled: false, hour: 2, retentionDays: 0 }); const [backupScheduleBusy, setBackupScheduleBusy] = useState(false); const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "" });
  // کلیدهایی که فایل مالک (owner.json) مقدار داده و بر این فرم مقدم‌اند؛
  // ذخیرهٔ فرم برایشان بی‌اثر می‌ماند، پس به کاربر علتش نشان داده می‌شود.
  const [ownerLocked, setOwnerLocked] = useState<string[]>([]);
  // فهرست ارزهای فروشگاه: افغانی همیشه اول و غیرقابل حذف؛ بقیه اضافه/حذف شدنی.
  const [currencyRows, setCurrencyRows] = useState<CurrencyRow[]>(BASE_CURRENCIES);
  const [newCurrency, setNewCurrency] = useState({ code: "", label: "" });
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  // بازنشانی کامل داده‌ها و ساخت دیتای نمونه (تنظیمات → سیستم).
  const [dataBusy, setDataBusy] = useState<"" | "reset" | "sample">("");
  const [networkMode, setNetworkMode] = useState<"local" | "server" | "client">("local"); const [clientUrl, setClientUrl] = useState(""); const [networkBusy, setNetworkBusy] = useState(false);
  // وضعیت زندهٔ سرور (حالت اجرا + نشانی‌های شبکه) و نتیجهٔ آزمایش اتصال مشتری.
  const [netInfo, setNetInfo] = useState<{ mode: string; lan: string[] } | null>(null);
  const [connTest, setConnTest] = useState<{ state: "idle" | "busy" | "ok" | "fail"; message?: string }>({ state: "idle" });
  const [update, setUpdate] = useState<{ state: "idle" | "checking" | "latest" | "available" | "error"; version?: string; url?: string; assetUrl?: string; message?: string }>({ state: "idle" });
  // نصب نیمه‌خودکار: دانلود نصب‌کننده از Rust و سپس اجرای آن.
  const [updateBusy, setUpdateBusy] = useState(false);
  const [tab, setTab] = useState<"store" | "print" | "scanner" | "network" | "system" | "license">("store");
  const [printForm, setPrintForm] = useState({ copies: 1, autoPrint: false, printLogo: true, mode: "dialog" as "dialog" | "quick", printer: "", qr: "" });
  const [printBusy, setPrintBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [diag, setDiag] = useState<{ logPath: string; logSize: number; errors: Array<{ code: string; text: string }> } | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const loadDiagnostics = async () => {
    setDiagBusy(true); setError("");
    try { setDiag(await get<{ logPath: string; logSize: number; errors: Array<{ code: string; text: string }> }>("/settings/diagnostics")); }
    catch (e) { setError((e as Error).message); }
    finally { setDiagBusy(false); }
  };
  const inTauri = typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  useEffect(() => { get<Record<string, string>>("/settings").then((data) => {
    // فهرست ارزها اول بارگذاری می‌شود تا «ارز پایه» با فهرست درست مقایسه شود.
    let rows: CurrencyRow[] = BASE_CURRENCIES;
    try { const parsed = data.currencies ? JSON.parse(data.currencies) : null; if (Array.isArray(parsed) && parsed.length) rows = parsed as CurrencyRow[]; } catch { /* keep defaults */ }
    if (!rows.some((row) => row.code === "AFN")) rows = [{ code: "AFN", label: "افغانی" }, ...rows];
    setCurrencyRows(rows);
    setSettings(data); setShopName(data.shopName || ""); setFooter(data.receiptFooter || "");
    const locked = (data as { ownerLocked?: unknown }).ownerLocked;
    setOwnerLocked(Array.isArray(locked) ? locked.filter((key): key is string => typeof key === "string") : []);
    // ارز پایهٔ ذخیره‌شده اگر در فهرست نباشد (مثلاً ارز حذف‌شده)، به افغانی برمی‌گردد.
    setCurrency(rows.some((row) => row.code === data.currency) ? (data.currency || "AFN") : "AFN");
    setCalendar(data.calendar === "islamic-umalqura" || data.calendar === "gregorian" ? data.calendar : "persian"); setTimezone(data.timezone || ""); setBackupSchedule({ enabled: data.backupScheduleEnabled === "1", hour: Math.min(23, Math.max(0, Number(data.backupHour) || 0)), retentionDays: Math.min(3650, Math.max(0, Number(data.backupRetentionDays) || 0)) }); setPrintForm({ copies: Math.min(3, Math.max(1, Number(data.receiptCopies) || 1)), autoPrint: data.autoPrintReceipt === "1", printLogo: data.printLogo !== "0", mode: data.printMode === "quick" ? "quick" : "dialog", printer: data.quickPrinter || "", qr: data.paymentQr || "" }); setBackupDir(data.backupDir || ""); }).catch((e) => setError(e.message)); }, []);
  const savePrintSettings = async () => {
    setPrintBusy(true); setError("");
    try {
      await Promise.all([
        { key: "receiptCopies", value: String(printForm.copies) },
        { key: "autoPrintReceipt", value: printForm.autoPrint ? "1" : "0" },
        { key: "printLogo", value: printForm.printLogo ? "1" : "0" },
        { key: "printMode", value: printForm.mode },
        { key: "quickPrinter", value: printForm.printer },
        { key: "paymentQr", value: printForm.qr },
      ].map((setting) => put("/settings", setting)));
      setSettings({ ...settings, receiptCopies: String(printForm.copies), autoPrintReceipt: printForm.autoPrint ? "1" : "0", printLogo: printForm.printLogo ? "1" : "0", printMode: printForm.mode, quickPrinter: printForm.printer, paymentQr: printForm.qr });
      notify(t("تنظیمات چاپ ذخیره شد."));
    } catch (e) { setError((e as Error).message); } finally { setPrintBusy(false); }
  };
  useEffect(() => {
    setClientUrl(serverOrigin());
    setNetworkMode(serverOrigin() ? "client" : "local");
    // حالت ذخیره‌شده از فایل network-mode بازیابی می‌شود تا انتخاب کاربر بعد
    // از باز‌وبسته کردن برنامه فراموش نشود؛ حالت «سرور شبکه» تا ری‌استارت
    // در پاسخ سلامت سرور هم دیده نمی‌شود، پس فقط سرور زنده کافی نیست.
    if (!serverOrigin() && inTauri) {
      invoke<string>("get_network_mode")
        .then((saved) => { if (saved === "server" || saved === "local") setNetworkMode(saved); })
        .catch(() => undefined);
    }
  }, []);
  // با باز شدن تب شبکه، وضعیت زندهٔ سرور محلی خوانده می‌شود: «server» یعنی
  // سرور واقعاً روی شبکهٔ محلی گوش می‌دهد و نشانی‌های آن برای مشتری‌ها هست.
  useEffect(() => {
    if (tab !== "network") return;
    get<{ ok: boolean; mode: string; lan: string[] }>("/auth/health").then((health) => setNetInfo({ mode: health.mode, lan: health.lan || [] })).catch(() => setNetInfo(null));
  }, [tab]);
  // وضعیت زندهٔ سرور برای ردیف «حالت اجرا» در تب‌های فروشگاه و سیستم هم
  // لازم است، نه فقط هنگام باز شدن تب شبکه.
  useEffect(() => {
    get<{ ok: boolean; mode: string; lan: string[] }>("/auth/health").then((health) => setNetInfo({ mode: health.mode, lan: health.lan || [] })).catch(() => setNetInfo(null));
  }, []);
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await Promise.all([{ key: "shopName", value: shopName }, { key: "receiptFooter", value: footer }, { key: "currency", value: currency }, { key: "calendar", value: calendar }, { key: "timezone", value: timezone }].map((setting) => put("/settings", setting)));
      setSettings({ ...settings, shopName, receiptFooter: footer, currency, calendar, timezone });
      applyLocaleSettings({ calendar, timezone, currency });
      notify(t("تنظیمات ذخیره شد."));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  /** فهرست ارزهای فروشگاه را در تنظیمات ذخیره و در نمایش برنامه اعمال می‌کند. */
  const saveCurrencyList = async (rows: CurrencyRow[]) => {
    setCurrencyBusy(true); setError("");
    try {
      await put("/settings", { key: "currencies", value: JSON.stringify(rows) });
      setCurrencyRows(rows);
      applyCurrencyList(rows);
      // اگر ارز پایهٔ فعلی از فهرست خارج شد، پایه به افغانی برمی‌گردد.
      if (!rows.some((row) => row.code === currency)) {
        await put("/settings", { key: "currency", value: "AFN" });
        setCurrency("AFN");
        setSettings({ ...settings, currency: "AFN" });
        applyLocaleSettings({ currency: "AFN" });
      }
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setCurrencyBusy(false); }
  };
  const addCurrency = async (event: FormEvent) => {
    event.preventDefault();
    const code = newCurrency.code.trim().toUpperCase();
    const label = newCurrency.label.trim();
    if (!/^[A-Z]{2,6}$/.test(code)) { setError(t("کد ارز باید ۲ تا ۶ حرف لاتین بزرگ باشد (مثلاً EUR).")); return; }
    if (!label) { setError(t("نام ارز را بنویسید (مثلاً یورو).")); return; }
    if (currencyRows.some((row) => row.code === code)) { setError(t("این کد ارز قبلاً در فهرست هست.")); return; }
    if (await saveCurrencyList([...currencyRows, { code, label }])) {
      setNewCurrency({ code: "", label: "" });
      notify(t("ارز «{code}» به فهرست اضافه شد.", { code }));
    }
  };
  const removeCurrency = async (row: CurrencyRow) => {
    if (row.code === "AFN" || row.code === currency) return;
    if (!window.confirm(t("ارز «{code}» از فهرست حذف شود؟", { code: row.code }))) return;
    if (await saveCurrencyList(currencyRows.filter((item) => item.code !== row.code))) notify(t("ارز «{code}» حذف شد.", { code: row.code }));
  };
  const saveBackupSchedule = async () => {
    setBackupScheduleBusy(true); setError("");
    try {
      await Promise.all([
        { key: "backupScheduleEnabled", value: backupSchedule.enabled ? "1" : "0" },
        { key: "backupHour", value: String(backupSchedule.hour) },
        { key: "backupRetentionDays", value: String(backupSchedule.retentionDays) },
      ].map((setting) => put("/settings", setting)));
      notify(backupSchedule.enabled ? t("بکاپ خودکار فعال شد.") : t("بکاپ خودکار خاموش شد."));
    } catch (e) { setError((e as Error).message); } finally { setBackupScheduleBusy(false); }
  };;
  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    setLogoBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      // Downscale to a compact data URL so it fits a setting row and prints fast.
      const image = new Image();
      image.onload = () => {
        try {
          const maxHeight = 96;
          const scale = Math.min(1, maxHeight / image.height);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("canvas");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/png");
          put("/settings", { key: "logo", value: dataUrl }).then(() => { setSettings({ ...settings, logo: dataUrl }); notify(t("لوگو ذخیره شد و روی رسیدها چاپ می‌شود.")); }).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLogoBusy(false));
        } catch { setLogoBusy(false); setError(t("پردازش تصویر ممکن نشد.")); }
      };
      image.onerror = () => { setLogoBusy(false); setError(t("فایل تصویر معتبر نیست.")); };
      image.src = String(reader.result || "");
    };
    reader.onerror = () => { setLogoBusy(false); setError(t("خواندن فایل ممکن نشد.")); };
    reader.readAsDataURL(file);
  };
  const removeLogo = async () => { try { await put("/settings", { key: "logo", value: "" }); setSettings({ ...settings, logo: "" }); notify(t("لوگو حذف شد.")); } catch (e) { setError((e as Error).message); } };
  // در حالت توسعه (npm run dev) سرور API فرمان جدای npm است؛ پس پیام
  // ری‌استارت باید هر دو را شامل شود. در نسخهٔ نصبی همان «بستن برنامه» کافی است.
  const devRestartHint = import.meta.env.DEV
    ? t("در حالت توسعه: فرمان npm run dev را کاملاً ببندید (Ctrl+C) و دوباره اجرا کنید تا حالت شبکه اعمال شود.")
    : t("برنامه را کاملاً ببندید و دوباره باز کنید.");
  const applyNetwork = async () => {
    setNetworkBusy(true); setError("");
    try {
      if (networkMode === "client" && !/^https?:\/\/.+/.test(clientUrl.trim())) throw new Error(t("نشانی سرور را به شکل http://192.168.1.10:4317 وارد کنید."));
      const mode = networkMode === "client" ? clientUrl.trim() : networkMode;
      setServerOrigin(networkMode === "client" ? clientUrl.trim() : "");
      if (inTauri) await invoke("set_network_mode", { mode });
      if (networkMode === "client") {
        // حالت مشتری بلافاصله اعمال می‌شود؛ بارگذاری دوبارهٔ برنامه کافی است.
        notify(t("حالت مشتری شبکه ذخیره شد؛ برنامه دوباره بارگذاری می‌شود…"));
        window.setTimeout(() => window.location.reload(), 900);
      } else if (networkMode === "server") {
        notify(t("حالت سرور شبکه ذخیره شد. {hint}", { hint: devRestartHint }));
      } else {
        notify(t("حالت تک‌کامپیوتر ذخیره شد. {hint}", { hint: devRestartHint }));
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setNetworkBusy(false); }
  };
  /** آزمایش اتصال به سرور شبکه پیش از ذخیرهٔ حالت مشتری. */
  const testConnection = async () => {
    const url = clientUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(url)) { setConnTest({ state: "fail", message: t("نشانی سرور را به شکل http://192.168.1.10:4317 وارد کنید.") }); return; }
    setConnTest({ state: "busy" });
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 6000);
      const response = await fetch(`${url}/api/auth/health`, { signal: controller.signal });
      window.clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { ok?: boolean };
      if (!body.ok) throw new Error(t("سرور پاسخ داد اما سلامت آن تایید نشد."));
      setConnTest({ state: "ok" });
    } catch (e) {
      setConnTest({ state: "fail", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const checkUpdate = async () => {
    setUpdate({ state: "checking" });
    try {
      const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json() as { tag_name?: string; html_url?: string; assets?: Array<{ name: string; browser_download_url: string }> };
      const remote = (release.tag_name || "").replace(/^v/, "");
      // نسخهٔ ویندوزی به‌صورت فایل نصب exe عرضه می‌شود؛ blockmap مربوط به
      // به‌روزرسان خودکار است که استفاده نمی‌کنیم. بیلد x64 رایج‌ترین است.
      const asset = (release.assets || []).find((file) => file.name.toLowerCase().includes("x64") && file.name.toLowerCase().endsWith(".exe"))
        || (release.assets || []).find((file) => file.name.toLowerCase().endsWith(".exe") && !file.name.toLowerCase().endsWith(".blockmap"));
      if (remote && remote !== APP_VERSION) setUpdate({ state: "available", version: remote, url: release.html_url, assetUrl: asset?.browser_download_url });
      else setUpdate({ state: "latest" });
    } catch (e) { setUpdate({ state: "error", message: e instanceof Error ? e.message : String(e) }); }
  };
  const openReleasePage = async (url: string) => {
    if (inTauri) { try { await invoke("open_url", { url }); return; } catch { /* fall through */ } }
    window.open(url, "_blank", "noopener");
  };
  // به‌روزرسانی نیمه‌خودکار: دانلود نصب‌کننده با Rust (تنها راه دانلود — CSP
  // فقط api.github.com را باز می‌گذارد)، سپس با تأیید کاربر اجرای نصب‌کننده
  // و بستن برنامه تا فایل‌های در حال اجرا جایگزین شوند.
  const downloadAndInstall = async () => {
    if (!update.assetUrl || !inTauri) { void openReleasePage(update.url || "https://github.com/Mahdawee/POS-ChatGPT/releases"); return; }
    setUpdateBusy(true);
    try {
      const path = await invoke<string>("download_update", { url: update.assetUrl, version: update.version || "" });
      notify(t("نصب‌کننده در پوشهٔ Downloads ذخیره شد."));
      if (window.confirm(t("برنامه بسته می‌شود و نصب‌کنندهٔ نسخهٔ {version} اجرا می‌شود. ادامه می‌دهید؟", { version: update.version || "" }))) await invoke("install_update", { path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      notify(t("دانلود ممکن نشد؛ فایل نصب را از صفحهٔ گیت‌هاب بگیرید."), "error");
    } finally { setUpdateBusy(false); }
  };
  const backup = async () => { setError(""); try { const result = await post<{ path: string }>("/settings/backup", {}); setBackupPath(result.path); notify(t("نسخه پشتیبان ساخته شد.")); } catch (e) { setError((e as Error).message); } };
  const saveBackupDir = async () => { setBackupDirBusy(true); setError(""); try { await put("/settings", { key: "backupDir", value: backupDir.trim() }); notify(backupDir.trim() ? t("پوشهٔ نسخهٔ پشتیبان ذخیره شد؛ از همین حالا در آن ذخیره می‌شود.") : t("پوشهٔ سفارشی پاک شد؛ پوشهٔ پیش‌فرض برنامه استفاده می‌شود.")); } catch (e) { setError((e as Error).message); } finally { setBackupDirBusy(false); } };
  /** Portable snapshot: the API returns the whole SQLite file as base64; the
   *  Tauri command writes it into Documents/DarPOS-Backups for USB transfer. */
  const exportBackup = async () => {
    setExportBusy(true); setError("");
    try {
      const snapshot = await get<BackupExport>("/settings/backup/export");
      const path = await invoke<string>("save_backup_file", { filename: snapshot.filename, dataBase64: snapshot.data });
      setBackupPath(path);
      notify(t("فایل بکاپ قابل حمل ساخته شد."));
    } catch (e) { setError((e as Error).message); } finally { setExportBusy(false); }
  };
  /** Replaces the live database with a chosen .db file (safety copy first). */
  const restoreBackup = async (file: File | undefined) => {
    if (!file) return;
    if (!window.confirm(t("دیتابیس فعلی با فایل «{name}» جایگزین شود؟ پیش از تغییر، نسخهٔ امن گرفته می‌شود.", { name: file.name }))) return;
    setRestoreBusy(true); setError("");
    try {
      const data = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(data);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      await post("/settings/backup/restore", { data: btoa(binary) });
      notify(t("بازیابی انجام شد؛ برنامه را ببندید و دوباره باز کنید."), "success");
    } catch (e) { setError((e as Error).message); } finally { setRestoreBusy(false); }
  };
  /** بازنشانی کامل: همهٔ داده‌های تجاری پاک می‌شود (کاربرها، تنظیمات و
   *  لایسنس می‌مانند). دو تأیید پشت‌سرهم + یادآوری بکاپ — برگشت‌پذیر نیست. */
  const resetAllData = async () => {
    if (!window.confirm(t("همهٔ داده‌های فروشگاه (کالاها، مشتری‌ها و تأمین‌کنندگان، فروش‌ها و برگشتی‌ها، خریدها، سفارش‌ها، پیش‌فاکتورها، اقساط، هزینه‌ها، صندوق و لاگ فعالیت) پاک شود؟ کاربرها، تنظیمات و لایسنس می‌مانند. این عمل برگشت‌پذیر نیست — اگر دادهٔ مهم دارید ابتدا نسخهٔ پشتیبان بگیرید."))) return;
    if (!window.confirm(t("برای اطمینان دوباره می‌پرسم: واقعاً همهٔ داده‌ها صفر شود؟"))) return;
    setDataBusy("reset"); setError("");
    try {
      const result = await post<{ removed: { sales: number; products: number; purchases: number; contacts: number } }>("/settings/data/reset", { confirm: "RESET" });
      notify(t("همهٔ داده‌ها پاک شد ({sales} فروش، {purchases} خرید، {products} کالا). برنامه از صفر آماده است.", { sales: String(result.removed.sales), purchases: String(result.removed.purchases), products: String(result.removed.products) }));
    } catch (e) { setError((e as Error).message); } finally { setDataBusy(""); }
  };
  /** دیتای نمونهٔ همه‌جانبه: هر قابلیت برنامه را پوشش می‌دهد تا همهٔ
   *  صفحه‌ها قابل تست باشند. فقط روی فروشگاه خالی کار می‌کند. */
  const seedSampleData = async () => {
    if (!window.confirm(t("دیتای نمونهٔ آزمایشی ساخته شود؟ کالاها، مشتری‌ها، خریدها، فروش‌های ۳۰ روز اخیر با همهٔ روش‌های پرداخت، برگشتی، ابطال، پیش‌فاکتور، سفارش، اقساط، هزینه و گردش صندوق ساخته می‌شوند. هر داده‌ای که مانده باشد، ابتدا به‌طور کامل پاک می‌شود."))) return;
    setDataBusy("sample"); setError("");
    try {
      const result = await post<{ created: { sales: number; products: number; customers: number; orders: number; quotes: number; installmentPlans: number } }>("/settings/data/sample", {});
      notify(t("دیتای نمونه ساخته شد: {products} کالا، {sales} فروش، {orders} سفارش، {quotes} پیش‌فاکتور و {plans} پلن قسط. کاربر نمونهٔ صندوقدار: samim با گذرواژه 12345678", { products: String(result.created.products), sales: String(result.created.sales), orders: String(result.created.orders), quotes: String(result.created.quotes), plans: String(result.created.installmentPlans) }));
    } catch (e) { setError((e as Error).message); } finally { setDataBusy(""); }
  };
  const changePassword = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await post("/auth/change-password", passwords); setPasswords({ currentPassword: "", newPassword: "" }); notify(t("گذرواژه تغییر کرد.")); } catch (e) { setError((e as Error).message); } };
  return <div className="page-stack settings-page">
    <div className="segmented settings-tabs">
      <button type="button" className={tab === "store" ? "active" : ""} onClick={() => setTab("store")}>{t("فروشگاه")}</button>
      <button type="button" className={tab === "print" ? "active" : ""} onClick={() => setTab("print")}>{t("رسید و چاپ")}</button>
      <button type="button" className={tab === "scanner" ? "active" : ""} onClick={() => setTab("scanner")}>{t("بارکدخوان / QR")}</button>
      {inTauri && <button type="button" className={tab === "network" ? "active" : ""} onClick={() => setTab("network")}>{t("شبکه")}</button>}
      <button type="button" className={tab === "system" ? "active" : ""} onClick={() => setTab("system")}>{t("سیستم")}</button>
      <button type="button" className={tab === "license" ? "active" : ""} onClick={() => setTab("license")}>{t("لایسنس")}</button>
    </div>
    {tab === "store" && <div className="settings-grid"><div className="page-stack"><section className="surface"><SectionHead title={t("تنظیمات فروشگاه")} subtitle={t("مشخصات روی فاکتور و صفحه اصلی")}/>{ownerLocked.length > 0 && <div className="hint-box"><b>{t("برخی تنظیمات فروشگاه توسط فایل مالک قفل شده‌اند")}</b><span>{t("این تنظیمات ({items}) مالک برنامه در فایل owner.json تعیین کرده و بر این صفحه مقدم است؛ برای تغییرشان ابزار مالک را به‌روز کنید.", { items: ownerLocked.map((key) => t(OWNER_LOCKED_LABELS[key] || key)).join("، ") })}</span></div>}<form className="form-grid single" onSubmit={saveSettings}><Field label={t("نام فروشگاه")}><input required value={shopName} onChange={(e) => setShopName(e.target.value)}/></Field><Field label={t("ارز پایه")}><select value={currency} onChange={(e) => setCurrency(e.target.value)}>{currencyRows.map((row) => <option key={row.code} value={row.code}>{t(row.label)} ({row.code})</option>)}</select></Field><Field label={t("تقویم نمایش تاریخ‌ها")}><select value={calendar} onChange={(e) => setCalendar(e.target.value as typeof calendar)}><option value="persian">{t("هجری شمسی (پیش‌فرض)")}</option><option value="islamic-umalqura">{t("هجری قمری")}</option><option value="gregorian">{t("میلادی")}</option></select></Field><Field label={t("منطقهٔ زمانی")}><input list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={t("خالی = زمان همین دستگاه")} dir="ltr"/><datalist id="tz-list">{["Asia/Kabul", "Asia/Tehran", "Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "Asia/Tashkent", "Asia/Almaty", "Asia/Dushanbe", "Europe/Istanbul", "UTC"].map((zone) => <option key={zone} value={zone}/>)}</datalist></Field><Field label={t("پایین فاکتور")}><textarea rows={3} value={footer} onChange={(e) => setFooter(e.target.value)}/></Field><Field label={t("لوگوی رسید")}><div className="row-actions"><label className="secondary-button import-file-button"><ImageIcon size={16}/>{logoBusy ? t("در حال ذخیره…") : t("انتخاب تصویر")}<input type="file" accept="image/*" hidden onChange={(e) => pickLogo(e.target.files?.[0])}/></label>{settings.logo && <button type="button" className="text-button danger-text" onClick={() => void removeLogo()}>{t("حذف لوگو")}</button>}</div>{settings.logo && <img src={settings.logo} alt="logo" className="logo-preview"/>}</Field>{error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? t("در حال ذخیره…") : t("ذخیره تنظیمات")}</button></form></section><section className="surface"><SectionHead title={t("مدیریت ارزها")} subtitle={t("افغانی ارز اصلی است و حذف نمی‌شود؛ ارزهای دیگر را اضافه یا حذف کنید")}/><div className="currency-list">{currencyRows.map((row) => <div className="currency-row" key={row.code}><b dir="ltr">{row.code}</b><span>{t(row.label)}</span>{row.code === "AFN" ? <span className="status-pill paid">{t("ارز اصلی")}</span> : row.code === currency ? <span className="status-pill warning" title={t("ابتدا ارز پایه را در تنظیمات فروشگاه عوض کنید.")}>{t("ارز پایهٔ فعلی")}</span> : null}<div className="grow"/>{row.code !== "AFN" && row.code !== currency && <button type="button" className="text-button danger-text" disabled={currencyBusy} onClick={() => void removeCurrency(row)}><Trash2 size={14}/>{t("حذف")}</button>}</div>)}</div><form className="form-grid two" onSubmit={addCurrency}><Field label={t("کد ارز (لاتین بزرگ، مثلاً EUR)")}><input required maxLength={6} dir="ltr" value={newCurrency.code} onChange={(e) => setNewCurrency({ ...newCurrency, code: e.target.value.toUpperCase() })} placeholder="EUR"/></Field><Field label={t("نام ارز (مثلاً یورو)")}><input required maxLength={30} value={newCurrency.label} onChange={(e) => setNewCurrency({ ...newCurrency, label: e.target.value })} placeholder={t("مثلاً یورو")}/></Field><div className="form-actions full"><button className="secondary-button" disabled={currencyBusy}><CirclePlus size={15}/>{currencyBusy ? t("در حال ذخیره…") : t("افزودن ارز")}</button></div></form><div className="hint-box" style={{ marginTop: 11 }}>{t("«ارز پایه» واحد نمایش همهٔ مبالغ برنامه و فاکتورهاست. ارزهای اضافه‌شده در فهرست انتخاب ارز پایه ظاهر می‌شوند؛ حداکثر ۱۲ ارز.")}</div></section><section className="surface"><SectionHead title={t("تغییر گذرواژه")} subtitle={t("گذرواژه پیش‌فرض را پس از ورود عوض کنید")}/><form className="form-grid single" onSubmit={changePassword}><Field label={t("گذرواژه فعلی")}><input type="password" required value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} dir="ltr"/></Field><Field label={t("گذرواژه تازه (حداقل ۸ نویسه)")}><input type="password" required minLength={8} value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} dir="ltr"/></Field><button className="secondary-button">{t("تغییر گذرواژه")}</button></form></section></div><div className="page-stack"><section className="surface local-info"><div className="offline large-offline"><span/><div><b>{t("ذخیره‌سازی محلی فعال است")}</b><small>{t("پایگاه‌داده روی همین دستگاه قرار دارد.")}</small></div></div><div className="info-row"><span>{t("حالت اجرا")}</span><b>{serverOrigin() ? t("مشتری شبکه") : netInfo?.mode === "server" ? t("سرور شبکه") : t("تک‌کامپیوتر")}</b></div><div className="info-row"><span>{t("دیتابیس")}</span><b>{t("SQLite محلی")}</b></div><div className="info-row"><span>{t("ارز تنظیم‌شده")}</span><b>{currency}</b></div></section></div></div>}
    {tab === "print" && <div className="settings-grid"><div className="page-stack"><section className="surface"><SectionHead title={t("تنظیمات چاپ و رسید")} subtitle={t("رفتار چاپ پس از ثبت فروش")}/><div className="form-grid single">
      <Field label={t("روش چاپ")}>
        <div className="radio-stack">
          <label className="check-line"><input type="radio" name="print-mode" checked={printForm.mode === "dialog"} onChange={() => setPrintForm({ ...printForm, mode: "dialog" })}/>{t("با پنجرهٔ چاپ (کامل: لوگو، فونت و QR)")}</label>
          <label className="check-line"><input type="radio" name="print-mode" checked={printForm.mode === "quick"} onChange={() => setPrintForm({ ...printForm, mode: "quick" })}/>{t("چاپ سریع بدون پنجره (متن ساده، برای سرعت)")}</label>
        </div>
      </Field>
      {printForm.mode === "quick" && <>
        <Field label={t("نام چاپگر (خالی = چاپگر پیش‌فرض)")}><input value={printForm.printer} onChange={(e) => setPrintForm({ ...printForm, printer: e.target.value })} placeholder="Xprinter XP-58" dir="ltr"/></Field>
        <div className="hint-box">{t("چاپ سریع متن سادهٔ رسید را مستقیم به چاپگر می‌فرستد. اگر چاپگر حروف دری را پشتیبانی نکرد یا چاپ نشد، برنامه خودکار پنجرهٔ چاپ را باز می‌کند.")}</div>
        <button className="secondary-button" disabled={testBusy} onClick={() => { setTestBusy(true); void testQuickPrint({ quickPrinter: printForm.printer }).then(() => notify(t("آزمون چاپ سریع ارسال شد؛ اگر چاپ نشد نام چاپگر را بررسی کنید."))).catch((e) => notify((e as Error).message, "error")).finally(() => setTestBusy(false)); }}>{testBusy ? t("در حال ارسال…") : t("آزمون چاپ سریع")}</button>
      </>}
      <Field label={t("تعداد نسخهٔ چاپ رسید")}><select value={printForm.copies} onChange={(e) => setPrintForm({ ...printForm, copies: Number(e.target.value) })}><option value={1}>{t("یک نسخه")}</option><option value={2}>{t("دو نسخه")}</option><option value={3}>{t("سه نسخه")}</option></select></Field>
      <label className="check-line"><input type="checkbox" checked={printForm.autoPrint} onChange={(e) => setPrintForm({ ...printForm, autoPrint: e.target.checked })}/>{t("چاپ خودکار رسید پس از ثبت فروش")}</label>
      <label className="check-line"><input type="checkbox" checked={printForm.printLogo} onChange={(e) => setPrintForm({ ...printForm, printLogo: e.target.checked })}/>{t("چاپ لوگو روی رسید")}</label>
      <Field label={t("متن یا لینک QR پرداخت (خالی = بدون QR)")}><input value={printForm.qr} onChange={(e) => setPrintForm({ ...printForm, qr: e.target.value })} placeholder="HesabPay / M-Paisa …" dir="ltr"/></Field>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={printBusy} onClick={() => void savePrintSettings()}>{printBusy ? t("در حال ذخیره…") : t("ذخیره تنظیمات چاپ")}</button>
    </div></section></div><div className="page-stack"><section className="surface"><SectionHead title={t("راهنمای چاپگر")} subtitle={t("چاپگر حرارتی یا معمولی")}/><div className="hint-box">{t("رسیدها با عرض ۷۲ میلی‌متر چاپ می‌شوند (مناسب کاغذ حرارتی ۸۰ میلی‌متری). برای خروجی PDF، در پنجرهٔ چاپ گزینهٔ «Microsoft Print to PDF» را انتخاب کنید.")}</div></section></div></div>}
    {tab === "scanner" && <section className="surface"><SectionHead title={t("بارکدخوان و اسکنر QR")} subtitle={t("آزمون اتصال و تنظیم رفتار اسکن")}/><ScannerPanel/></section>}
    {tab === "network" && <><section className="surface"><SectionHead title={t("شبکهٔ محلی")} subtitle={t("چند کامپیوتر در فروشگاه؛ یک دستگاه سرور و بقیه مشتری")}/>
      <div className="form-grid single">
        <Field label={t("حالت اجرا")}><select value={networkMode} onChange={(e) => { setNetworkMode(e.target.value as typeof networkMode); setConnTest({ state: "idle" }); }}><option value="local">{t("تک‌کامپیوتر (پیش‌فرض)")}</option><option value="server">{t("سرور شبکه (میزبان دیتابیس)")}</option><option value="client">{t("مشتری شبکه (اتصال به سرور)")}</option></select></Field>
        {networkMode === "server" && <div className="hint-box"><b className="block" style={{ marginBottom: 4 }}>{t("این دستگاه میزبان دیتابیس فروشگاه می‌شود.")}</b>{t("برنامه را کاملاً ببندید و دوباره باز کنید؛ سپس در ویندوز اجازهٔ دسترسی فایروال برای برنامه بدهید (پورت ۴۳۱۷). راهنمای کامل در فایل network-guide.md همراه برنامه است.")}{import.meta.env.DEV && <b className="block" style={{ marginTop: 6 }}>{t("در حالت توسعه: فرمان npm run dev را کاملاً ببندید (Ctrl+C) و دوباره اجرا کنید تا حالت شبکه اعمال شود.")}</b>}</div>}
        {networkMode === "server" && (netInfo?.mode === "server"
          ? <div className="hint-box green"><b className="block">{t("سرور شبکه فعال است — دستگاه‌های دیگر می‌توانند وصل شوند:")}</b><span className="network-urls">{netInfo.lan.length ? netInfo.lan.map((ip) => <code key={ip} dir="ltr">{`http://${ip}:4317`}</code>) : <span>{t("نشانی شبکه پیدا نشد؛ اتصال شبکهٔ دستگاه را بررسی کنید.")}</span>}</span></div>
          : netInfo && <div className="hint-box">{t("وضعیت فعلی این دستگاه: تک‌کامپیوتر. تا برنامه را باز و بسته نکنید، حالت سرور اعمال نمی‌شود و دستگاه‌های دیگر نمی‌توانند وصل شوند.")}{import.meta.env.DEV && <b className="block" style={{ marginTop: 6 }}>{t("در حالت توسعه: فرمان npm run dev را کاملاً ببندید (Ctrl+C) و دوباره اجرا کنید تا حالت شبکه اعمال شود.")}</b>}</div>)}
        {networkMode === "client" && <Field label={t("نشانی سرور (از صفحهٔ شبکهٔ دستگاه سرور بردارید)")}><input value={clientUrl} onChange={(e) => { setClientUrl(e.target.value); setConnTest({ state: "idle" }); }} placeholder="http://192.168.1.10:4317" dir="ltr"/></Field>}
        {networkMode === "client" && <div className="row-actions">
          <button type="button" className="secondary-button" disabled={connTest.state === "busy"} onClick={() => void testConnection()}>{connTest.state === "busy" ? t("در حال آزمایش…") : t("آزمایش اتصال")}</button>
          {connTest.state === "ok" && <span className="green-text"><Check size={14}/>{t("اتصال برقرار شد — سرور در دسترس است.")}</span>}
          {connTest.state === "fail" && <span className="danger-text">{t("اتصال ممکن نشد:")}{connTest.message ? ` ${connTest.message}` : ""}</span>}
        </div>}
        {networkMode === "client" && <div className="hint-box">{t("روی دستگاه سرور، برنامه را در حالت «سرور شبکه» اجرا کنید و نشانی سبزرنگ آن را همین‌جا وارد کنید. دیتابیس و لایسنس روی دستگاه سرور نگهداری می‌شود؛ این دستگاه فقط به آن وصل می‌شود.")}</div>}
        {networkMode === "local" && <div className="hint-box">{t("هر دستگاه دیتابیس و لایسنس جداگانهٔ خود را دارد. برای اشتراک یک دیتابیس بین چند کامپیوتر، یک دستگاه را «سرور شبکه» و بقیه را «مشتری شبکه» کنید.")}</div>}
        <button className="primary-button" disabled={networkBusy} onClick={() => void applyNetwork()}>{networkBusy ? t("در حال ذخیره…") : t("ذخیره حالت شبکه")}</button>
      </div></section></>}
    {tab === "system" && <div className="settings-grid"><div className="page-stack"><section className="surface"><SectionHead title={t("به‌روزرسانی برنامه")} subtitle={t("بررسی نسخهٔ تازه از گیت‌هاب")}/><div className="form-grid single"><div className="update-row"><span className="muted">{t("نسخهٔ نصب‌شده:")}</span><b dir="ltr">{APP_VERSION}</b><button className="secondary-button" onClick={() => void checkUpdate()} disabled={update.state === "checking"}><RefreshCw size={16} className={update.state === "checking" ? "spin" : ""}/>{update.state === "checking" ? t("در حال بررسی…") : t("بررسی به‌روزرسانی")}</button></div>{update.state === "latest" && <div className="hint-box">{t("شما آخرین نسخه را دارید.")}</div>}{update.state === "available" && <div className="hint-box">{t("نسخهٔ {version} موجود است.", { version: update.version || "" })} {update.assetUrl && inTauri ? <button className="primary-button" disabled={updateBusy} onClick={() => void downloadAndInstall()}>{updateBusy ? t("در حال دانلود…") : t("دانلود و نصب")}</button> : <button className="text-button" onClick={() => void openReleasePage(update.url || "https://github.com/Mahdawee/POS-ChatGPT/releases")}>{t("دانلود")}</button>} {!updateBusy && <small className="muted">{update.assetUrl && inTauri ? t("نصب‌کننده در پوشهٔ Downloads ذخیره و اجرا می‌شود؛ برنامه بسته خواهد شد.") : t("فایل نصب را از صفحهٔ انتشار گیت‌هاب بگیرید.")}</small>}</div>}{update.state === "error" && <div className="hint-box">{t("بررسی به‌روزرسانی ممکن نشد.")} <small dir="ltr">{update.message}</small></div>}</div></section><section className="surface local-info"><div className="offline large-offline"><span/><div><b>{t("ذخیره‌سازی محلی فعال است")}</b><small>{t("پایگاه‌داده روی همین دستگاه قرار دارد.")}</small></div></div><div className="info-row"><span>{t("حالت اجرا")}</span><b>{serverOrigin() ? t("مشتری شبکه") : netInfo?.mode === "server" ? t("سرور شبکه") : t("تک‌کامپیوتر")}</b></div><div className="info-row"><span>{t("دیتابیس")}</span><b>{t("SQLite محلی")}</b></div><div className="info-row"><span>{t("ارز تنظیم‌شده")}</span><b>{currency}</b></div></section><section className="surface"><SectionHead title={t("خطاهای اخیر سرور")} subtitle={t("برای پشتیبانی — جزئیات خطاهای ثبت‌شده در api.log")}/><div className="form-grid single"><button className="secondary-button" onClick={() => void loadDiagnostics()} disabled={diagBusy}>{diagBusy ? t("در حال خواندن…") : t("نمایش خطاهای اخیر")}</button>{diag && <><div className="hint-box">{diag.errors.length ? t("{count} خطای اخیر پیدا شد؛ برای ارسال به پشتیبانی کپی کنید.", { count: diag.errors.length }) : t("خطایی ثبت نشده است.")}<small dir="ltr" className="block" style={{ marginTop: 4, opacity: 0.7 }}>{diag.logPath}</small></div>{diag.errors.length > 0 && <button className="secondary-button" onClick={() => { void navigator.clipboard.writeText(diag.errors.map((e) => e.text).join("\n\n")).then(() => notify(t("جزئیات خطاها کپی شد."))); }}>{t("کپی جزئیات برای پشتیبانی")}</button>}{diag.errors.map((e) => <details key={e.code + e.text.slice(0, 24)} className="diag-block"><summary dir="ltr">{e.code}</summary><pre dir="ltr">{e.text}</pre></details>)}</>}</div></section></div><div className="page-stack"><section className="surface backup-card"><div className="backup-icon"><ShieldCheck size={22}/></div><span className="eyebrow">{t("حفاظت از داده‌ها")}</span><h2>{t("نسخه پشتیبان")}</h2><p>{t("یک نسخه سالم از دیتابیس محلی بسازید. فایل پشتیبان در پوشه امن برنامه ذخیره می‌شود.")}</p><button className="primary-button" onClick={() => void backup()}><Archive size={17}/>{t("ساخت نسخه پشتیبان")}</button>{backupPath && <div className="hint-box path-box">{t("ذخیره شد:")}<br/><code dir="ltr">{backupPath}</code></div>}<div className="backup-extra"><label className="field" style={{ margin: 0 }}><span>{t("پوشهٔ ذخیرهٔ نسخه‌های پشتیبان (اختیاری)")}</span><input value={backupDir} onChange={(e) => setBackupDir(e.target.value)} placeholder={t("مثلاً D:\\Backups یا /media/usb")} dir="ltr"/></label><button className="secondary-button" disabled={backupDirBusy} onClick={() => void saveBackupDir()} style={{ marginTop: 6 }}>{backupDirBusy ? t("در حال ذخیره…") : t("ذخیرهٔ پوشه")}</button><small className="muted">{t("خالی یعنی پوشهٔ پیش‌فرض برنامه. اگر پوشه در دسترس نباشد، به‌طور خودکار به پوشهٔ پیش‌فرض برمی‌گردد.")}</small></div><div className="backup-extra"><button className="secondary-button" disabled={exportBusy} onClick={() => void exportBackup()}><Save size={16}/>{exportBusy ? t("در حال ساخت…") : t("خروجی فایل بکاپ (قابل حمل)")}</button><small className="muted">{t("در پوشهٔ Documents/DarPOS-Backups ذخیره می‌شود؛ برای فلش یا کامپیوتر دیگر قابل استفاده است.")}</small></div><div className="backup-extra"><label className="secondary-button import-file-button"><RefreshCw size={16}/>{restoreBusy ? t("در حال بازیابی…") : t("بازیابی از فایل بکاپ")}<input type="file" accept=".db" hidden disabled={restoreBusy} onChange={(e) => void restoreBackup(e.target.files?.[0])}/></label><small className="muted">{t("دیتابیس فعلی با فایل انتخاب‌شده جایگزین می‌شود؛ پیش از تغییر، خودکار نسخهٔ امن گرفته می‌شود. پس از بازیابی، برنامه را ببندید و دوباره باز کنید.")}</small></div><div className="backup-extra"><label className="checkbox-row"><input type="checkbox" checked={backupSchedule.enabled} onChange={(e) => setBackupSchedule({ ...backupSchedule, enabled: e.target.checked })}/>{t("بکاپ خودکار روزانه")}</label><div className="form-grid two" style={{ marginTop: 6 }}><label className="field" style={{ margin: 0 }}><span>{t("ساعت بکاپ")}</span><div className="row" style={{ gap: 6 }}>{/* ساعت ۱۲ساعته (ق.ظ/ب.ظ) — هماهنگ با نمایش زمان کل برنامه؛ مقدار ذخیره‌شده همان ساعت ۰–۲۳ سیستم است. */}<select dir="ltr" value={String((backupSchedule.hour % 12) || 12)} onChange={(e) => { const h12 = Math.min(12, Math.max(1, Number(e.target.value) || 1)); setBackupSchedule({ ...backupSchedule, hour: h12 % 12 + (backupSchedule.hour >= 12 ? 12 : 0) }); }}>{Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={String(h)}>{h}</option>)}</select><select value={backupSchedule.hour >= 12 ? "pm" : "am"} onChange={(e) => { const pm = e.target.value === "pm"; setBackupSchedule({ ...backupSchedule, hour: ((backupSchedule.hour % 12) || 12) % 12 + (pm ? 12 : 0) }); }}><option value="am">{t("قبل از ظهر")}</option><option value="pm">{t("بعد از ظهر")}</option></select></div></label><label className="field" style={{ margin: 0 }}><span>{t("نگهداری بکاپ‌های خودکار (روز)")}</span><input type="number" min="0" max="3650" dir="ltr" value={backupSchedule.retentionDays} onChange={(e) => setBackupSchedule({ ...backupSchedule, retentionDays: Math.min(3650, Math.max(0, Number(e.target.value) || 0)) })}/></label></div><button className="secondary-button" disabled={backupScheduleBusy} onClick={() => void saveBackupSchedule()} style={{ marginTop: 6 }}>{backupScheduleBusy ? t("در حال ذخیره…") : t("ذخیرهٔ تنظیم بکاپ خودکار")}</button><small className="muted">{t("وقتی برنامه باز باشد، هر روز در ساعت تعیین‌شده یک بکاپ خودکار گرفته می‌شود. «۰ روز» یعنی فقط ۱۰ بکاپ اخیر نگه داشته شود.")}</small></div><div className="backup-extra"><button className="secondary-button" onClick={() => void openCustomerDisplay().then(() => notify(t("نمایشگر مشتری باز شد."))).catch((e) => notify(t("نمایشگر مشتری باز نشد:") + " " + (e as Error).message, "error"))}><MonitorPlay size={16}/>{t("نمایشگر مشتری (صفحهٔ دوم)")}</button><small className="muted">{t("پنجره‌ای جدا برای دیدن مشتری: جمع فاکتور زنده را بزرگ نشان می‌دهد.")}</small></div></section><section className="surface"><SectionHead title={t("داده‌های نمونه و بازنشانی")} subtitle={t("برای تست کامل برنامه — از صفر شروع کنید یا مغازهٔ نمونه بسازید")}/><div className="form-grid single"><div className="form-note"><Lightbulb size={16}/>{t("«بازنشانی» همهٔ داده‌های تجاری را صفر می‌کند (کاربرها، تنظیمات و لایسنس می‌ماند) و «دیتای نمونه» یک مغازهٔ آزمایشی کامل می‌سازد: کالای وزنی، سریال‌دار (IMEI)، بسته، قیمت عمده، انقضای نزدیک، کم‌موجود، همهٔ روش‌های پرداخت، برگشتی‌ها، ابطال، سفارش رزروشده، اقساط با قسط سررسیدگذشته، هزینه‌ها و گردش صندوق — با تاریخ‌های ۳۰ روز اخیر تا گزارش‌ها و نمودارها هم داده داشته باشند.")}</div><div className="form-actions" style={{ justifyContent: "flex-start" }}><button type="button" className="danger-button" disabled={!!dataBusy} onClick={() => void resetAllData()}><Trash2 size={16}/>{dataBusy === "reset" ? t("در حال پاک‌کردن…") : t("پاک‌کردن همهٔ داده‌ها")}</button><button type="button" className="primary-button" disabled={!!dataBusy} onClick={() => void seedSampleData()}><PackagePlus size={16}/>{dataBusy === "sample" ? t("در حال ساخت…") : t("ساخت دیتای نمونه")}</button></div><small className="muted">{t("دیتای نمونه فقط روی فروشگاه خالی ساخته می‌شود؛ ترتیب پیشنهادی: اول «پاک‌کردن»، بعد «دیتای نمونه». کاربر نمونهٔ صندوقدار: samim با گذرواژهٔ 12345678 (مدیر همان حساب فعلی شماست).")}</small></div></section></div></div>}
    {tab === "license" && <LicensePanel notify={notify}/>}
  </div>;
}

/** لاگ فعالیت — چه کسی، چه کاری، کِی (فقط مدیر). */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true); setError("");
    const params = new URLSearchParams({ take: "200" });
    if (actor.trim()) params.set("actor", actor.trim());
    if (action) params.set("action", action);
    Promise.all([get<AuditEntry[]>(`/audit?${params.toString()}`), get<string[]>("/audit/actions")])
      .then(([list, names]) => { setEntries(list); setActions(names); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, []);
  const actionLabel = (name: string) => ({
    LOGIN: t("ورود"), CHECKOUT: t("ثبت فروش"), SALE_RETURN: t("برگشت فروش"), CLOSE_CASH: t("بستن صندوق"), OPEN_CASH: t("بازکردن صندوق"),
    CASH_IN: t("ورودی نقدی"), CASH_OUT: t("خروجی نقدی"), CREATE_BACKUP: t("ساخت بکاپ"), EXPORT_BACKUP: t("خروجی بکاپ"), RESTORE_BACKUP: t("بازیابی بکاپ"),
    IMPORT_PRODUCTS: t("ورود گروهی کالا"), CHANGE_PASSWORD: t("تغییر گذرواژه"), UPDATE_SETTING: t("تغییر تنظیمات"),
    VOID_SALE: t("ابطال فاکتور فروش"), VOID_PURCHASE: t("ابطال رسید خرید"), CREATE_PURCHASE: t("ثبت خرید"),
    PURCHASE_RETURN: t("برگشت خرید"), QUOTE_CREATE: t("ساخت پیش‌فاکتور"), QUOTE_CONVERT: t("تبدیل پیش‌فاکتور"), QUOTE_VOID: t("ابطال پیش‌فاکتور"),
    CUSTOMER_PAYMENT: t("دریافت از مشتری"), SUPPLIER_PAYMENT: t("پرداخت به تأمین‌کننده"), WALLET_CHARGE: t("شارژ کیف پول"),
    CREATE_EXPENSE: t("ثبت هزینه"), DELETE_EXPENSE: t("حذف هزینه"), ADJUST_STOCK: t("اصلاح موجودی"), TRANSFER_STOCK: t("انتقال انبار"),
    STOCKTAKE: t("شمارش انبار"), STOCKTAKE_APPLY: t("اعمال شمارش"), STOCKTAKE_VOID: t("ابطال شمارش"),
    CREATE_ORDER: t("ثبت سفارش"), DELIVER_ORDER: t("تحویل سفارش"), CANCEL_ORDER: t("لغو سفارش"),
    CREATE_INSTALLMENT_PLAN: t("ساخت پلن قسط"), PAY_INSTALLMENT: t("پرداخت قسط"), SET_BUNDLE: t("اجزای بسته"),
    ACTIVATE_USER: t("بازکردن دسترسی"), DEACTIVATE_USER: t("بستن دسترسی"), RESET_PASSWORD: t("بازنشانی گذرواژه"),
    SCHEDULED_BACKUP: t("بکاپ خودکار"), BACKUP_FAILED: t("شکست بکاپ"),
  } as Record<string, string>)[name] || name;
  return <div className="page-stack">
    <section className="surface"><SectionHead title={t("لاگ فعالیت")} subtitle={t("آخرین کارهای انجام‌شده در برنامه — برای پیگیری و اعتماد")}/>
      <div className="toolbar">
        <div className="search-box"><Search size={17}/><input value={actor} onChange={(e) => setActor(e.target.value)} placeholder={t("نام کاربر…")}/></div>
        <select value={action} onChange={(e) => setAction(e.target.value)}><option value="">{t("همهٔ کارها")}</option>{actions.map((name) => <option key={name} value={name}>{actionLabel(name)}</option>)}</select>
        <button className="secondary-button" onClick={load} disabled={busy}><RefreshCw size={16} className={busy ? "spin" : ""}/>{t("تازه‌سازی")}</button>
        <span className="toolbar-count">{entries.length} {t("مورد")}</span>
      </div>
      {error && <ErrorBox message={error}/>}
      <div className="table-wrap"><table><thead><tr><th>{t("شماره")}</th><th>{t("زمان")}</th><th>{t("کاربر")}</th><th>{t("کار")}</th><th>{t("موضوع")}</th><th>{t("جزئیات")}</th></tr></thead>
        <tbody>{entries.map((entry, idx) => <tr key={entry.id}><td className="muted mono">{idx + 1}</td>
          <td className="muted">{dateTime(entry.createdAt)}</td>
          <td><b>{entry.actor || "—"}</b></td>
          <td><span className="category-label">{actionLabel(entry.action)}</span></td>
          <td>{entry.entity}{entry.entityId ? <small className="block muted mono">{entry.entityId}</small> : ""}</td>
          <td className="muted">{entry.detail || "—"}</td>
        </tr>)}</tbody></table>
        {!entries.length && <Empty title={t("فعالیتی ثبت نشده")} text={t("کارهای انجام‌شده پس از این نمایش داده می‌شوند.")}/>}
      </div>
    </section>
  </div>;
}
