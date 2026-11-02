import { dateTime, money, type ProfitReport, type Sale, type SaleReturn, type ShopSettings } from "./api";

/** Escapes user data before it is embedded into the print document. */
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));

const payLabel = (method: string) => ({ CASH: "نقدی", MOBILE: "موبایلی", CREDIT: "نسیه" } as Record<string, string>)[method] || method;

const baseStyles = (width: string) => `
  @page { margin: ${width === "auto" ? "12mm" : "2mm"}; ${width === "auto" ? "size: A4;" : ""} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { ${width === "auto" ? "" : `width: ${width};`} font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: ${width === "auto" ? "12px" : "12px"}; line-height: 1.6; }
  .receipt-brand { font-size: 17px; font-weight: 800; text-align: center; letter-spacing: 2px; }
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
`;

/**
 * Prints the given HTML through a hidden iframe. The document is fully
 * self-contained, so app styles can never blank or clip the printout, and the
 * width is fixed to thermal-receipt paper (works on normal printers too —
 * choose "Microsoft Print to PDF" in the dialog to save a PDF).
 */
export function printHtml(inner: string, options: { width?: string; title?: string } = {}): void {
  const width = options.width || "72mm";
  const title = options.title || "رسید فروش";
  const html = `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${baseStyles(width)}</style></head><body>${inner}</body></html>`;
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

/** receipt body shared by sale receipts and return slips */
function receiptShell(shop: ShopSettings, metaRows: Array<[string, string]>, items: string[], totals: Array<[string, string, boolean?]>, footer?: string): string {
  return `
    <div class="receipt-brand">ROSHAN</div>
    <p class="shop-name">${esc(shop.shopName?.trim() || "فروشگاه من")}</p>
    <div class="receipt-divider"></div>
    ${metaRows.map(([label, value]) => `<div class="receipt-meta"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    <div class="receipt-divider"></div>
    ${items.join("\n")}
    <div class="receipt-divider"></div>
    ${totals.map(([label, value, strong]) => `<div class="receipt-meta${strong ? " totals" : ""}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    <p class="receipt-thanks">${esc(footer?.trim() || shop.receiptFooter?.trim() || "از خرید شما سپاس‌گزاریم")}</p>`;
}

export function saleReceiptHtml(sale: Sale, shop: ShopSettings): string {
  const meta: Array<[string, string]> = [
    ["شماره فاکتور", sale.receiptNo],
    ["زمان", dateTime(sale.createdAt)],
    ["مشتری", sale.customer?.name || "مشتری گذری"],
  ];
  const items = sale.items.map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [["جمع کل", money(sale.total), true]];
  if (sale.discount > 0) totals.push(["تخفیف", money(sale.discount)]);
  totals.push(["روش پرداخت", payLabel(sale.paymentMethod)]);
  if (sale.paymentMethod === "CASH" && sale.change > 0) totals.push(["باقی‌پول مشتری", money(sale.change)]);
  return receiptShell(shop, meta, items, totals);
}

export function returnSlipHtml(sale: Sale, record: SaleReturn, shop: ShopSettings): string {
  const meta: Array<[string, string]> = [
    ["شماره برگشتی", record.returnNo],
    ["فاکتور اصلی", sale.receiptNo],
    ["زمان", dateTime(record.createdAt)],
  ];
  const items = (record.items || []).map((item) => `<div class="receipt-item"><span>${esc(item.name)} × ${item.quantity}</span><b>${money(item.lineTotal)}</b></div>`);
  const totals: Array<[string, string, boolean?]> = [["مبلغ برگشتی", money(record.total), true]];
  if (record.note) totals.push(["یادداشت", record.note]);
  return receiptShell(shop, meta, items, totals, "برگشت کالا با این رسید ثبت شد");
}

const dayLabel = (day: string) => new Intl.DateTimeFormat("fa-AF", { dateStyle: "medium" }).format(new Date(`${day}T00:00:00`));

export function reportHtml(report: ProfitReport): string {
  return `
    <h1>ROSHAN · ${esc("گزارش سود و فروش")}</h1>
    <p class="muted">${esc("فروشگاه")}: ${esc(report.from ? `${dayLabel(report.from.slice(0, 10))} — ${dayLabel(report.to.slice(0, 10))}` : "")}</p>
    <h2>${esc("خلاصهٔ دوره")}</h2>
    <table>
      <tr><td>${esc("درآمد ناخالص")}</td><td class="num">${money(report.revenue)}</td><td>${esc("بازپرداخت‌ها")}</td><td class="num">${money(report.refunds)}</td></tr>
      <tr><td>${esc("درآمد خالص")}</td><td class="num">${money(report.netRevenue)}</td><td>${esc("بهای کالا")}</td><td class="num">${money(report.cost)}</td></tr>
      <tr><td><b>${esc("سود ناخالص")}</b></td><td class="num"><b>${money(report.profit)}</b></td><td>${esc("حاشیهٔ سود")}</td><td class="num">${esc(`${Math.round(report.margin * 100)}٪`)}</td></tr>
      <tr><td>${esc("خرید دوره")}</td><td class="num">${money(report.purchasesTotal)}</td><td>${esc("تعداد فاکتور")}</td><td class="num">${report.invoiceCount}</td></tr>
    </table>
    <h2>${esc("فروش و سود روزانه")}</h2>
    <table><thead><tr><th>${esc("روز")}</th><th>${esc("فروش خالص")}</th><th>${esc("سود")}</th></tr></thead>
      <tbody>${[...report.byDay].reverse().map((row) => `<tr><td>${esc(dayLabel(row.day))}</td><td class="num">${money(row.revenue)}</td><td class="num">${money(row.profit)}</td></tr>`).join("")}</tbody></table>
    <h2>${esc("پرفروش‌ترین کالاها")}</h2>
    <table><thead><tr><th>${esc("کالا")}</th><th>${esc("تعداد")}</th><th>${esc("فروش")}</th><th>${esc("سود")}</th></tr></thead>
      <tbody>${report.topProducts.map((product) => `<tr><td>${esc(product.name)}</td><td class="num">${product.quantity}</td><td class="num">${money(product.revenue)}</td><td class="num">${money(product.profit)}</td></tr>`).join("")}</tbody></table>
    <p class="receipt-thanks muted">${esc("برای خروجی PDF، در پنجرهٔ چاپ گزینهٔ Microsoft Print to PDF را انتخاب کنید.")}</p>`;
}

export function debtorsHtml(data: { customers: Array<{ id: string; name: string; phone: string | null; balance: number }>; customersTotal: number; suppliers: Array<{ id: string; name: string; phone: string | null; balance: number }>; suppliersTotal: number }): string {
  const row = (item: { name: string; phone: string | null; balance: number }) => `<tr><td>${esc(item.name)}</td><td class="num">${esc(item.phone || "—")}</td><td class="num">${money(item.balance)}</td></tr>`;
  return `
    <h1>ROSHAN · ${esc("گزارش بدهی‌ها")}</h1>
    <p class="muted">${esc(new Intl.DateTimeFormat("fa-AF", { dateStyle: "full" }).format(new Date()))}</p>
    <h2>${esc("مشتریان بدهکار (نسیه)")} — ${esc("جمع")}: ${money(data.customersTotal)}</h2>
    <table><thead><tr><th>${esc("نام")}</th><th>${esc("تماس")}</th><th>${esc("مانده")}</th></tr></thead>
      <tbody>${data.customers.length ? data.customers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc("بدهکاری ثبت نشده است.")}</td></tr>`}</tbody></table>
    <h2>${esc("بدهی به تأمین‌کنندگان")} — ${esc("جمع")}: ${money(data.suppliersTotal)}</h2>
    <table><thead><tr><th>${esc("نام")}</th><th>${esc("تماس")}</th><th>${esc("مانده")}</th></tr></thead>
      <tbody>${data.suppliers.length ? data.suppliers.map(row).join("") : `<tr><td colspan="3" class="muted">${esc("بدهی ثبت نشده است.")}</td></tr>`}</tbody></table>`;
}
