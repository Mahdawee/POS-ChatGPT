import { invoke } from "@tauri-apps/api/core";
import { qrSvg } from "./qr";
import { dateTime, dayLabel, dir, fullDate, lang, money, moneyPlain, percent, t } from "../i18n";
import { getBrand } from "./brand";
import type { CustomerDetail, ProfitReport, Product, PurchaseReturn, Sale, SaleReturn, ShopSettings, ZReport } from "./api";

/** Escapes user data before it is embedded into the print document. */
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));

const payLabel = (method: string) => ({ CASH: t("نقدی"), MOBILE: t("موبایلی"), CREDIT: t("نسیه"), WALLET: t("کیف پول") } as Record<string, string>)[method] || method;

const baseStyles = (width: string, landscape = false) => `
  @page { margin: ${width === "auto" ? "12mm" : "2mm"}; ${width === "auto" ? `size: ${landscape ? "A4 landscape" : "A4"};` : ""} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { ${width === "auto" ? "" : `width: ${width};`} font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; line-height: 1.6; }
  .receipt-brand { font-size: 17px; font-weight: 800; text-align: center; letter-spacing: 2px; }
  .shop-logo { display: block; margin: 0 auto 2mm; max-height: 70px; max-width: 65%; }
  .shop-name { text-align: center; margin: 2px 0 0; font-weight: 600; }
  .receipt-divider { border-top: 1px dashed #000; margin: 6px 0; }
  .receipt-meta { display: flex; justify-content: space-between; gap: 10px; }
  .receipt-meta span { color: #333; }
  .receipt-item { display: flex; justify-content: space-between; gap: 10px; }
  .receipt-thanks { text-align: center; margin: 8px 0 0; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 14px 0 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #888; padding: 4px 6px; text-align: right; }
  th { background: #eee; }
  .num { text-align: left; direction: ltr; }
  .muted { color: #444; }
  .totals { display: flex; justify-content: space-between; font-weight: 700; margin-top: 6px; }
  .label-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
  .price-label { border: 1px dashed #888; padding: 2mm 1.5mm; text-align: center; overflow: hidden; }
  .price-label .label-name { font-size: 11px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .price-label .label-price { font-size: 13px; font-weight: 800; margin-top: 1mm; }
  .price-label svg { max-width: 100%; height: 11mm; }
  .receipt-qr { display: block; margin: 6px auto 0; width: 22mm; height: 22mm; }
  .qr-note { text-align: center; font-size: 10px; margin: 2px 0 0; }
  .invoice-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; }
  .invoice-party { font-size: 12px; line-height: 1.8; }
  .signature-row { display: flex; justify-content: space-around; margin-top: 18mm; }
  .signature-row div { border-top: 1px solid #000; padding: 4px 14px; font-size: 11px; }
`;

/**
 * Prints the given HTML through a hidden iframe. The document is fully
 * self-contained, so app styles can never blank or clip the printout, and the
 * width is fixed to thermal-receipt paper (works on normal printers too —
 * choose "Microsoft Print to PDF" in the dialog to save a PDF).
 */
export function printHtml(inner: string, options: { width?: string; title?: string; copies?: number; landscape?: boolean } = {}): void {
  const width = options.width || "72mm";
  const title = options.title || t("رسید فروش");
  const copies = Math.min(3, Math.max(1, Math.round(options.copies || 1)));
  // Receipt copies all live in ONE print document, separated by page
  // breaks: a single print dialog then emits the whole batch back-to-back
  // (thermal printers cannot duplicate a job themselves, and consecutive
  // dialogs are unreliable in WebView2).
  const body = Array.from({ length: copies }, () => inner).join('<div style="break-after:page;page-break-after:always;height:0"></div>');
  const html = `<!doctype html><html dir="${dir()}" lang="${lang()}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${baseStyles(width, options.landscape)}</style></head><body>${body}</body></html>`;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    const window = frame.contentWindow;
    if (!window) { frame.remove(); return; }
    window.addEventListener("afterprint", () => frame.remove(), { once: true });
    window.setTimeout(() => window.print(), 60);
    window.setTimeout(() => frame.remove(), 120000);
  };
  document.body.appendChild(frame);
  frame.srcdoc = html;
}

// Payment QR (Settings → receipts): rendered once and cached per text, since
// the setting rarely changes between receipts. Inline SVG keeps it crisp at
// any print size and needs no async canvas round-trip.
let qrCache = new Map<string, string>();
function paymentQrSvg(shop: ShopSettings): string {
  const text = shop.paymentQr?.trim();
  if (!text) return "";
  const cached = qrCache.get(text);
  if (cached) return cached;
  try {
    const svg = qrSvg(text);
    if (qrCache.size > 8) qrCache = new Map();
    qrCache.set(text, svg);
    return svg;
  } catch { return ""; }
}

/**
 * Plain-text receipt (about 40 columns) for the dialog-free quick print. Kept
 * ASCII-numeral and simple on purpose: the spooler's Out-Printer renders it
 * with the printer driver's default font, which varies between thermal
 * models — anything fancier belongs to the HTML (dialog) mode.
 */
export function textReceipt(sale: Sale, shop: ShopSettings): string {
  const line = (left: string, right: string) => `${left}${" ".repeat(Math.max(1, 40 - left.length - right.length))}${right}`;
  const rows: string[] = [];
  rows.push(shop.shopName?.trim() || t("فروشگاه"));
  // نشانی و تلفن فروشگاه اگر مالک/تنظیمات تعیین کرده باشد، زیر نام می‌آیند.
  const contact = [shop.address?.trim(), shop.phone?.trim()].filter(Boolean).join(" · ");
  if (contact) rows.push(contact);
  rows.push("=".repeat(40));
  rows.push(line(t("رسید فروش"), sale.receiptNo));
  // زمان روی رسید متنی هم ۱۲ساعته است (ساعت ۲۴نگاره‌ای فقط ابهام می‌سازد)؛
  // ارقام لاتین می‌مانند چون فونت پیش‌فرض چاپگرهای حرارتی ارقام دری را ندارد.
  rows.push(line(t("زمان"), new Date(sale.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", hour12: true })));
  rows.push(line(t("مشتری"), sale.customer?.name || t("مشتری گذری")));
  rows.push("-".repeat(40));
  for (const item of sale.items) rows.push(line(`${item.name} x${item.quantity}`, moneyPlain(item.lineTotal)));
  rows.push("-".repeat(40));
  rows.push(line(t("جمع کل"), moneyPlain(sale.total)));
  if (sale.discount > 0) rows.push(line(t("تخفیف"), moneyPlain(sale.discount)));
  rows.push(line(t("روش پرداخت"), payLabel(sale.paymentMethod)));
  if (sale.paymentMethod === "CASH" && sale.change > 0) rows.push(line(t("باقی‌پول مشتری"), moneyPlain(sale.change)));
  rows.push("-".repeat(40));
  rows.push(shop.receiptFooter?.trim() || t("از خرید شما سپاس‌گزاریم"));
  return rows.join("\r\n");
}

/** Formal A4 wholesale invoice with letterhead, item table and signatures. */
export function invoiceHtml(sale: Sale, shop: ShopSettings): string {
  const rows = sale.items.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${esc(item.name)}</td><td class="num">${item.quantity}</td><td class="num">${money(item.unitPrice)}</td><td class="num">${money(item.lineTotal)}</td></tr>`).join("");
  return `
    <div class="invoice-head">
      <div>${shop.printLogo === "0" ? "" : shop.logo?.trim() ? `<img class="shop-logo" style="margin:0" src="${esc(shop.logo)}" alt=""/>` : ""}<div class="receipt-brand">${esc(shop.shopName?.trim() || t("فروشگاه من"))}</div>${[shop.address?.trim(), shop.phone?.trim()].filter(Boolean).join(" · ") ? `<div style="font-size:11px;color:#444;">${esc([shop.address?.trim(), shop.phone?.trim()].filter(Boolean).join(" · "))}</div>` : ""}</div>
      <div class="invoice-party">
        <div><b>${esc(t("فاکتور فروش"))}</b></div>
        <div>${esc(t("شماره فاکتور"))}: <span class="num">${esc(sale.receiptNo)}</span></div>
        <div>${esc(t("زمان"))}: ${esc(dateTime(sale.createdAt))}</div>
        <div>${esc(t("مشتری"))}: ${esc(sale.customer?.name || t("مشتری گذری"))}</div>
        ${sale.customer?.phone ? `<div>${esc(t("شماره تماس"))}: <span class="num">${esc(sale.customer.phone)}</span></div>` : ""}
      </div>
    </div>
    <table style="margin-top:6mm"><thead><tr><th>#</th><th>${esc(t("کالا"))}</th><th>${esc(t("تعداد"))}</th><th>${esc(t("قیمت واحد"))}</th><th>${esc(t("مبلغ"))}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals" style="margin-top:4mm"><span>${esc(t("جمع کل"))}</span><span class="num">${money(sale.total)}</span></div>
    ${sale.discount > 0 ? `<div class="totals"><span>${esc(t("تخفیف"))}</span><span class="num">${money(sale.discount)}</span></div>` : ""}
    <div class="totals"><span>${esc(t("روش پرداخت"))}</span><span class="num">${esc(payLabel(sale.paymentMethod))}</span></div>
    <div class="signature-row"><div>${esc(t("امضای فروشنده"))}</div><div>${esc(t("امضای خریدار"))}</div></div>`;
}

/**
 * Prints a sale receipt honouring the print mode from Settings:
 * - "quick": plain text straight to the (default or named) printer with no
 *   dialog, via the Tauri quick_print command (Windows spooler).
 * - anything else: the normal HTML print dialog (with logo/QR/copies).
 * If the quick path fails (e.g. non-Windows, missing printer), we fall back
 * to the dialog and surface a notice through the darpos:print-fallback event.
 */
export function printSaleReceipt(sale: Sale, shop: ShopSettings, options: { copies?: number; forceDialog?: boolean } = {}): void {
  if (shop.printMode === "quick" && !options.forceDialog) {
    void invoke("quick_print", { printer: shop.quickPrinter || "", text: textReceipt(sale, shop) })
      .catch((error: unknown) => {
        console.error("quick print failed, falling back to the print dialog", error);
        window.dispatchEvent(new CustomEvent("darpos:print-fallback"));
        printSaleReceipt(sale, shop, { ...options, forceDialog: true });
      });
    return;
  }
  const svg = paymentQrSvg(shop);
  const qrHtml = svg ? `${svg}<p class="qr-note">${esc(t("پرداخت با اسکن QR"))}</p>` : "";
  printHtml(saleReceiptHtml(sale, shop, qrHtml), { copies: options.copies ?? (Number(shop.receiptCopies) || 1) });
}

/** Debt statement with the optional payment QR appended. */
export function printDebtReceipt(detail: CustomerDetail, shop: ShopSettings): void {
  const svg = paymentQrSvg(shop);
  printHtml(debtReceiptHtml(detail, shop, svg ? `${svg}<p class="qr-note">${esc(t("پرداخت با اسکن QR"))}</p>` : ""));
}

/** Smoke-tests the quick-print channel from the Settings page. */
export async function testQuickPrint(shop: ShopSettings): Promise<void> {
  await invoke("quick_print", { printer: shop.quickPrinter || "", text: [getBrand().appName + " — " + t("آزمون چاپ سریع"), "=".repeat(40), t("اگر این متن را می‌خوانید، چاپ سریع فعال است."), new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", hour12: true })].join("\r\n") });
}

/** Shop header shared by every printed document: logo (if configured) + name. */
function shopHeader(shop: ShopSettings): string {
  // The "printLogo" setting (saved from Settings) can turn the logo off for
  // receipts even when one is configured for the screen.
  const logo = shop.printLogo === "0" ? undefined : shop.logo?.trim();
  // The brand line is the shop's own configured name — no hardcoded brand.
  // Address/phone (when the owner file or in-app settings provide them) ride
  // along on every printed document, right under the name.
  const contact = [shop.address?.trim(), shop.phone?.trim()].filter(Boolean).join(" · ");
  return `${logo ? `<img class="shop-logo" src="${esc(logo)}" alt=""/>` : ""}<div class="receipt-brand">${esc(shop.shopName?.trim() || t("فروشگاه من"))}</div>${contact ? `<div style="font-size:10px;color:#444;">${esc(contact)}</div>` : ""}`;
}

/** receipt body shared by sale receipts and return slips */
function receiptShell(shop: ShopSettings, metaRows: Array<[string, string]>, items: string[], totals: Array<[string, string, boolean?]>, footer?: string): string {
  return `
    ${shopHeader(shop)}
    <div class="receipt-divider"></div>
    ${metaRows.map(([label, value]) => `<div class="receipt-meta"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    <div class="receipt-divider"></div>
    ${items.join("\n")}
    <div class="receipt-divider"></div>
    ${totals.map(([label, value, strong]) => `<div class="receipt-meta${strong ? " totals" : ""}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    <p class="receipt-thanks">${esc(footer?.trim() || shop.receiptFooter?.trim() || t("از خرید شما سپاس‌گزاریم"))}</p>`;
}

export function saleReceiptHtml(sale: Sale, shop: ShopSettings, qrHtml = ""): string {
  const meta: Array<[string, string]> = [
    [t("شماره فاکتور"), sale.receiptNo],
    [t("زمان"), dateTime(sale.createdAt)],
    [t("مشتری"), sale.customer?.name || t("مشتری گذری")],
  ];
  const items = sale.items.map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [[t("جمع کل"), money(sale.total), true]];
  if (sale.discount > 0) totals.push([t("تخفیف"), money(sale.discount)]);
  totals.push([t("روش پرداخت"), payLabel(sale.paymentMethod)]);
  if (sale.paymentMethod === "CASH" && sale.change > 0) totals.push([t("باقی‌پول مشتری"), money(sale.change)]);
  return receiptShell(shop, meta, items, totals) + qrHtml;
}

export function returnSlipHtml(sale: Sale, record: SaleReturn, shop: ShopSettings): string {
  const meta: Array<[string, string]> = [
    [t("شماره برگشتی"), record.returnNo],
    [t("فاکتور اصلی"), sale.receiptNo],
    [t("زمان"), dateTime(record.createdAt)],
  ];
  const items = (record.items || []).map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [[t("مبلغ برگشتی"), money(record.total), true]];
  // Refund channels, so money sent back over mobile money stays visible.
  if (record.cashAmount) totals.push([t("بازپرداخت نقدی"), money(record.cashAmount)]);
  if (record.walletRefund) totals.push([t("بازپرداخت به کیف پول"), money(record.walletRefund)]);
  const mobilePart = Math.max(0, record.total - (record.cashAmount || 0) - (record.walletRefund || 0));
  if (mobilePart > 0) totals.push([t("بازپرداخت موبایلی"), money(mobilePart)]);
  if (record.note) totals.push([t("یادداشت"), record.note]);
  return receiptShell(shop, meta, items, totals, t("برگشت کالا با این رسید ثبت شد"));
}

/** End-of-shift Z report for thermal printers: the full cash reconciliation. */
export function zReportHtml(z: ZReport, shop: ShopSettings): string {
  const rows: Array<[string, string, boolean?]> = [
    [t("صندوقدار"), z.cashier],
    [t("شروع نوبت"), dateTime(z.openedAt)],
    [t("پایان نوبت"), dateTime(z.closedAt)],
    [t("نقد آغازین"), money(z.openingCash)],
    [t("فروش نقدی"), money(z.cashSales)],
    [t("پرداخت موبایلی"), money(z.mobileSales)],
    [t("فروش نسیه"), money(z.creditSales)],
    [t("فروش کیف پول"), money(z.walletSales || 0)],
    [t("تعداد فاکتور"), String(z.invoiceCount)],
    [t("برگشتی‌ها"), money(z.returnsTotal)],
    ...(z.mobileRefunds ? [[t("برگشت موبایلی"), money(z.mobileRefunds)]] as Array<[string, string, boolean?]> : []),
    [t("ورودی نقدی دستی"), money(z.cashIn)],
    [t("خروجی نقدی دستی"), money(z.cashOut)],
    [t("مبلغ مورد انتظار"), money(z.expected), true],
    [t("نقد شمارش‌شده"), money(z.counted), true],
    [t("اختلاف صندوق"), money(z.difference), true],
  ];
  return receiptShell(shop, [[t("گزارش"), t("گزارش پایان نوبت (Z)")]], [], rows, z.difference === 0 ? t("نوبت کاری بدون اختلاف بسته شد.") : t("اختلاف صندوق را بررسی کنید."));
}

/** A4 sheet of price labels; `barcodeSvg` is a pre-rendered CODE128 SVG string. */
export function labelsHtml(product: Product, count: number, barcodeSvg: string, shop: ShopSettings): string {
  const label = `<div class="price-label"><div class="label-name">${esc(product.name)}</div>${barcodeSvg}<div class="label-price">${money(product.price)}</div><div class="muted" style="font-size:9px">${esc(shop.shopName?.trim() || t("فروشگاه من"))}</div></div>`;
  return `<h1>${esc(t("لیبل قیمت"))} — ${esc(product.name)}</h1><div class="label-grid">${label.repeat(Math.max(1, Math.min(200, count)))}</div>`;
}

export function purchaseReturnHtml(record: PurchaseReturn, shop: ShopSettings): string {
  const meta: Array<[string, string]> = [
    [t("شماره برگشت خرید"), record.returnNo],
    [t("رسید خرید"), record.purchase?.invoiceNo || "—"],
    [t("تأمین‌کننده"), record.supplier?.name || "—"],
    [t("زمان"), dateTime(record.createdAt)],
  ];
  const items = (record.items || []).map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [
    [t("مبلغ برگشت خرید"), money(record.total), true],
    [t("ثبت در حساب"), t("تأمین‌کننده")],
  ];
  if (record.note) totals.push([t("یادداشت"), record.note]);
  return receiptShell(shop, meta, items, totals, t("این برگشت در حساب تأمین‌کننده ثبت شد."));
}

export function debtReceiptHtml(detail: CustomerDetail, shop: ShopSettings, qrHtml = ""): string {
  const meta: Array<[string, string]> = [
    [t("سند بدهی"), `DEBT-${detail.customer.id.slice(-6).toUpperCase()}`],
    [t("زمان"), dateTime(new Date())],
    [t("مشتری"), detail.customer.name],
  ];
  if (detail.customer.phone) meta.push([t("شماره تماس"), detail.customer.phone]);
  const items = detail.recentSales
    .filter((sale) => sale.paymentMethod === "CREDIT")
    .slice(0, 8)
    .map((sale) => `<div class="receipt-item"><span>${esc(sale.receiptNo)} · ${dayLabel(sale.createdAt)}</span><b>${money(sale.total)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [
    [t("مانده بدهی"), money(detail.balance), true],
    [t("فروش نسیه"), money(detail.creditSales)],
    [t("برگشتی + وصولی"), money(detail.creditReturns + detail.paymentsTotal)],
  ];
  return receiptShell(shop, meta, items, totals, t("لطفاً مانده بدهی خود را در اولین فرصت تسویه کنید.")) + qrHtml;
}

export function reportHtml(report: ProfitReport, shop: ShopSettings = {}): string {
  return `
    <h1>${esc(shop.shopName?.trim() || t("فروشگاه من"))} · ${esc(t("گزارش سود و فروش"))}</h1>
    <p class="muted">${esc(t("بازه"))}: ${esc(report.from ? `${dayLabel(report.from.slice(0, 10))} — ${dayLabel(report.to.slice(0, 10))}` : "")}</p>
    <h2>${esc(t("خلاصهٔ دوره"))}</h2>
    <table>
      <tr><td>${esc(t("درآمد ناخالص"))}</td><td class="num">${money(report.revenue)}</td><td>${esc(t("بازپرداخت‌ها"))}</td><td class="num">${money(report.refunds)}</td></tr>
      <tr><td>${esc(t("درآمد خالص"))}</td><td class="num">${money(report.netRevenue)}</td><td>${esc(t("بهای کالا"))}</td><td class="num">${money(report.cost)}</td></tr>
      <tr><td><b>${esc(t("سود ناخالص"))}</b></td><td class="num"><b>${money(report.profit)}</b></td><td>${esc(t("حاشیهٔ سود"))}</td><td class="num">${esc(percent(report.margin * 100))}</td></tr>
      <tr><td>${esc(t("خرید دوره"))}</td><td class="num">${money(report.purchasesTotal)}</td><td>${esc(t("تعداد فاکتور"))}</td><td class="num">${report.invoiceCount}</td></tr>
    </table>
    <h2>${esc(t("فروش و سود روزانه"))}</h2>
    <table><thead><tr><th>${esc(t("روز"))}</th><th>${esc(t("فروش خالص"))}</th><th>${esc(t("سود"))}</th></tr></thead>
      <tbody>${[...report.byDay].reverse().map((row) => `<tr><td>${esc(dayLabel(row.day))}</td><td class="num">${money(row.revenue)}</td><td class="num">${money(row.profit)}</td></tr>`).join("")}</tbody></table>
    <h2>${esc(t("پرفروش‌ترین کالاها"))}</h2>
    <table><thead><tr><th>${esc(t("کالا"))}</th><th>${esc(t("تعداد"))}</th><th>${esc(t("فروش"))}</th><th>${esc(t("سود"))}</th></tr></thead>
      <tbody>${report.topProducts.map((product) => `<tr><td>${esc(product.name)}</td><td class="num">${product.quantity}</td><td class="num">${money(product.revenue)}</td><td class="num">${money(product.profit)}</td></tr>`).join("")}</tbody></table>
    <p class="receipt-thanks muted">${esc(t("برای خروجی PDF، در پنجرهٔ چاپ گزینهٔ Microsoft Print to PDF را انتخاب کنید."))}</p>`;
}

export function debtorsHtml(data: { customers: Array<{ id: string; name: string; phone: string | null; balance: number }>; customersTotal: number; suppliers: Array<{ id: string; name: string; phone: string | null; balance: number }>; suppliersTotal: number }, shop: ShopSettings = {}): string {
  const row = (item: { name: string; phone: string | null; balance: number }) => `<tr><td>${esc(item.name)}</td><td class="num">${esc(item.phone || "—")}</td><td class="num">${money(item.balance)}</td></tr>`;
  return `
    <h1>${esc(shop.shopName?.trim() || t("فروشگاه من"))} · ${esc(t("گزارش بدهی‌ها"))}</h1>
    <p class="muted">${esc(fullDate(new Date()))}</p>
    <h2>${esc(t("مشتریان بدهکار (نسیه)"))} — ${esc(t("جمع"))}: ${money(data.customersTotal)}</h2>
    <table><thead><tr><th>${esc(t("نام"))}</th><th>${esc(t("تماس"))}</th><th>${esc(t("مانده"))}</th></tr></thead>
      <tbody>${data.customers.length ? data.customers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc(t("بدهکاری ثبت نشده است."))}</td></tr>`}</tbody></table>
    <h2>${esc(t("بدهی به تأمین‌کنندگان"))} — ${esc(t("جمع"))}: ${money(data.suppliersTotal)}</h2>
    <table><thead><tr><th>${esc(t("نام"))}</th><th>${esc(t("تماس"))}</th><th>${esc(t("مانده"))}</th></tr></thead>
      <tbody>${data.suppliers.length ? data.suppliers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc(t("بدهی ثبت نشده است."))}</td></tr>`}</tbody></table>`;
}
