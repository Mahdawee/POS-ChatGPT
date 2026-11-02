import { dateTime, dayLabel, dir, fullDate, lang, money, percent, t } from "../i18n";
import type { ProfitReport, Product, Sale, SaleReturn, ShopSettings, ZReport } from "./api";

/** Escapes user data before it is embedded into the print document. */
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));

const payLabel = (method: string) => ({ CASH: t("نقدی"), MOBILE: t("موبایلی"), CREDIT: t("نسیه") } as Record<string, string>)[method] || method;

const baseStyles = (width: string) => `
  @page { margin: ${width === "auto" ? "12mm" : "2mm"}; ${width === "auto" ? "size: A4;" : ""} }
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
`;

/**
 * Prints the given HTML through a hidden iframe. The document is fully
 * self-contained, so app styles can never blank or clip the printout, and the
 * width is fixed to thermal-receipt paper (works on normal printers too —
 * choose "Microsoft Print to PDF" in the dialog to save a PDF).
 */
export function printHtml(inner: string, options: { width?: string; title?: string } = {}): void {
  const width = options.width || "72mm";
  const title = options.title || t("رسید فروش");
  const html = `<!doctype html><html dir="${dir()}" lang="${lang()}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${baseStyles(width)}</style></head><body>${inner}</body></html>`;
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

/** Shop header shared by every printed document: logo (if configured) + name. */
function shopHeader(shop: ShopSettings): string {
  const logo = shop.logo?.trim();
  return `${logo ? `<img class="shop-logo" src="${esc(logo)}" alt=""/>` : ""}<div class="receipt-brand">ROSHAN</div><p class="shop-name">${esc(shop.shopName?.trim() || t("فروشگاه من"))}</p>`;
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

export function saleReceiptHtml(sale: Sale, shop: ShopSettings): string {
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
  return receiptShell(shop, meta, items, totals);
}

export function returnSlipHtml(sale: Sale, record: SaleReturn, shop: ShopSettings): string {
  const meta: Array<[string, string]> = [
    [t("شماره برگشتی"), record.returnNo],
    [t("فاکتور اصلی"), sale.receiptNo],
    [t("زمان"), dateTime(record.createdAt)],
  ];
  const items = (record.items || []).map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [[t("مبلغ برگشتی"), money(record.total), true]];
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
    [t("تعداد فاکتور"), String(z.invoiceCount)],
    [t("برگشتی‌ها"), money(z.returnsTotal)],
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

export function reportHtml(report: ProfitReport): string {
  return `
    <h1>ROSHAN · ${esc(t("گزارش سود و فروش"))}</h1>
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

export function debtorsHtml(data: { customers: Array<{ id: string; name: string; phone: string | null; balance: number }>; customersTotal: number; suppliers: Array<{ id: string; name: string; phone: string | null; balance: number }>; suppliersTotal: number }): string {
  const row = (item: { name: string; phone: string | null; balance: number }) => `<tr><td>${esc(item.name)}</td><td class="num">${esc(item.phone || "—")}</td><td class="num">${money(item.balance)}</td></tr>`;
  return `
    <h1>ROSHAN · ${esc(t("گزارش بدهی‌ها"))}</h1>
    <p class="muted">${esc(fullDate(new Date()))}</p>
    <h2>${esc(t("مشتریان بدهکار (نسیه)"))} — ${esc(t("جمع"))}: ${money(data.customersTotal)}</h2>
    <table><thead><tr><th>${esc(t("نام"))}</th><th>${esc(t("تماس"))}</th><th>${esc(t("مانده"))}</th></tr></thead>
      <tbody>${data.customers.length ? data.customers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc(t("بدهکاری ثبت نشده است."))}</td></tr>`}</tbody></table>
    <h2>${esc(t("بدهی به تأمین‌کنندگان"))} — ${esc(t("جمع"))}: ${money(data.suppliersTotal)}</h2>
    <table><thead><tr><th>${esc(t("نام"))}</th><th>${esc(t("تماس"))}</th><th>${esc(t("مانده"))}</th></tr></thead>
      <tbody>${data.suppliers.length ? data.suppliers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc(t("بدهی ثبت نشده است."))}</td></tr>`}</tbody></table>`;
}
