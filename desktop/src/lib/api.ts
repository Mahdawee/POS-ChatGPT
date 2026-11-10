const BUNDLED_API = "http://127.0.0.1:4317/api";
const SERVER_KEY = "darpos-server-origin";

/**
 * Default API base for this context:
 *  • inside the Tauri desktop app → the bundled local server (127.0.0.1:4317);
 *  • in a normal browser (PWA on a phone or another computer) → the UI is
 *    served BY the API server, so the same origin is always correct and keeps
 *    working when the app is later hosted on a real server with HTTPS.
 */
function defaultApiBase(): string {
  if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return BUNDLED_API;
  return `${window.location.origin}/api`;
}

/** Base URL of the POS API — the bundled local server by default, or a LAN
 *  server when this machine runs as a network client (Settings → Network). */
export function apiBase(): string {
  try {
    const origin = localStorage.getItem(SERVER_KEY);
    if (origin) return `${origin.replace(/\/+$/, "")}/api`;
  } catch { /* storage unavailable */ }
  return defaultApiBase();
}

/**
 * آدرس بندانگشتی عکس کالا — عمومی و immutable-cache (نسخهٔ عکس در خود URL
 * است، پس عکس تازه هیچ‌وقت کش قدیمی را نمی‌بیند). فقط یک «عدد نسخه» به
 * دادهٔ کالا اضافه می‌شود؛ خود عکس جدا و فقط برای کاشی‌های دیده‌شده
 * (lazy) بارگذاری می‌شود تا کاتالوگ چند-هزارتایی سبز بماند.
 */
export function productImageUrl(product: { id: string; image?: { version: number } | null }): string | null {
  if (!product.image) return null;
  return `${apiBase()}/products/${product.id}/image?v=${product.image.version}`;
}

/** Points this machine at a LAN server (empty string restores local mode). */
export function setServerOrigin(origin: string): void {
  try {
    if (origin) localStorage.setItem(SERVER_KEY, origin.replace(/\/+$/, ""));
    else localStorage.removeItem(SERVER_KEY);
  } catch { /* storage unavailable */ }
}

export function serverOrigin(): string {
  try { return localStorage.getItem(SERVER_KEY) || ""; } catch { return ""; }
}

// اگر شبکه یا سرور پاسخ ندهد (اتصال نیمه‌گشوده که «معلق» می‌ماند)، برنامهٔ
// صندوق نباید برای همیشه روی «در حال ورود…» بماند. هر درخواست بعد از مهلت
// زیر قطع می‌شود؛ درخواست‌های بی‌خطر (GET و ورود/بازخوانی نشست) یک‌بار
// خودکار تکرار می‌شوند. درخواست‌های تغییردهنده (فروش، پرداخت، …) هرگز
// خودکار تکرار نمی‌شوند — خطر ثبت دوباره وجود دارد (تکرار دستی کاربر با
// کلید Idempotency سرور ایمن است).
const REQUEST_TIMEOUT_MS = 20000;

/** خطای «اتصال به سرور برقرار نشد» — هاردنینگ request() شکست شبکه را به
 *  TypeError خام رها نمی‌کند، بلکه به این کلاس می‌پیچد. صف آفلاین و صندوق
 *  فروش با همین کلاس تشخیص می‌دهند که فاکتور باید «پارک» شود و بعداً
 *  دوباره ارسال، نه اینکه مثل خطای سرور برای همیشه دور انداخته شود. */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

const isRetryable = (path: string, method?: string) =>
  !method || method === "GET" || path.endsWith("/auth/login") || path.endsWith("/auth/me");

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("darpos-token");
  const attemptFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${apiBase()}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
    } finally { window.clearTimeout(timer); }
  };
  let response: Response;
  try {
    response = await attemptFetch();
  } catch {
    if (!isRetryable(path, init.method)) throw new ConnectionError(t("ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی کنید."));
    try {
      response = await attemptFetch();
    } catch {
      throw new ConnectionError(t("ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی کنید."));
    }
  }
  if (response.status === 401 && !path.endsWith("/auth/login")) window.dispatchEvent(new CustomEvent("darpos:session-expired"));
  // 402 = unlicensed/expired/tampered: the app switches to the license screen.
  if (response.status === 402) {
    let detail: Record<string, unknown> = {};
    try { detail = await response.json(); } catch { /* body unreadable */ }
    window.dispatchEvent(new CustomEvent("darpos:license-required", { detail }));
  }
  if (!response.ok) {
    let message = t("درخواست انجام نشد.");
    try {
      const body = await response.json();
      message = Array.isArray(body.message) ? body.message.join(t("، ")) : body.message || message;
      // 5xx bodies carry a one-line technical `detail` (exception + route).
      // Keep it under the readable message so a cashier's screenshot already
      // tells support exactly which request failed and why.
      if (typeof body.detail === "string" && body.detail) message = `${message}\n${body.detail}`;
    } catch { /* keep a readable fallback */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  // Some routes answer 200 with an EMPTY body (e.g. /cash/current when the
  // drawer is closed — Nest sends nothing for a null return). Calling
  // response.json() on that throws "Unexpected end of JSON input", which used
  // to crash the cash page and the POS basket. An empty body now reads as
  // "no data" instead of an error.
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

import { t } from "../i18n";

export const get = <T,>(path: string) => request<T>(path);
export const post = <T,>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "POST", body: JSON.stringify(body), headers });
export const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T,>(path: string) => request<T>(path, { method: "DELETE" });

export type User = { id: string; username: string; displayName: string; role: "ADMIN" | "CASHIER"; mustChangePassword?: boolean };
export type Category = { id: string; name: string; color: string; _count?: { products: number } };
export type Product = { id: string; sku: string; barcode: string | null; name: string; unit: string; isWeighted?: boolean; isBundle?: boolean; isSerialized?: boolean; reserved?: number; expiryDate?: string | null; price: number; wholesalePrice?: number | null; wholesaleMinQty?: number | null; cost: number; stock: number; backstock?: number; minStock: number; categoryId: string | null; category?: Category | null; isActive?: boolean; image?: { version: number } | null; bundleComponents?: Array<{ id: string; componentId: string; quantity: number; component?: { id: string; name: string; sku: string; unit: string; stock?: number; reserved?: number; isSerialized?: boolean } }>; serialUnits?: Array<{ id: string }> };
export type Contact = { id: string; name: string; code?: string | null; phone: string | null; address: string | null; note: string | null; balance?: number; creditLimit?: number; walletBalance?: number; tier?: "RETAIL" | "WHOLESALE" };
export type SaleItem = { id: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number; productId: string; discount?: number };
export type SaleReturnItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number };
export type SaleReturn = { id: string; returnNo: string; total: number; creditRelief?: number; cashAmount?: number; walletRefund?: number; note: string | null; createdAt: string; user?: { displayName: string }; items?: SaleReturnItem[] };
export type Sale = { id: string; receiptNo: string; invoiceNo?: string | null; subtotal: number; discount: number; total: number; amountPaid: number; change: number; cashPart?: number; mobilePart?: number; creditPart?: number; walletPart?: number; paymentMethod: "CASH" | "MOBILE" | "CREDIT" | "WALLET"; createdAt: string; customer?: Contact | null; user?: { displayName: string }; items: SaleItem[]; returns?: SaleReturn[]; voidedAt?: string | null; voidReason?: string | null; voidedBy?: string | null };
export type PurchaseItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number; expiryDate?: string | null };
export type Purchase = { id: string; invoiceNo: string | null; note: string | null; total: number; paidAmount: number; createdAt: string; supplier?: Contact | null; user?: { displayName: string }; items: PurchaseItem[]; voidedAt?: string | null; voidReason?: string | null; voidedBy?: string | null };
export type PurchaseReturnItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number };
export type PurchaseReturn = { id: string; returnNo: string; total: number; note: string | null; createdAt: string; supplier?: Contact | null; user?: { displayName: string }; purchase?: { invoiceNo: string | null } | null; items: PurchaseReturnItem[] };
export type Expense = { id: string; title: string; amount: number; category: string | null; note: string | null; fromCash: boolean; cashSessionId: string | null; createdAt: string; user?: { displayName: string } };
export type ExpenseList = { list: Expense[]; total: number };
export type SaleList = { list: Sale[]; total: number };
export type PurchaseList = { list: Purchase[]; total: number };
export type PurchasesReport = { from: string; to: string; invoiceCount: number; total: number; paid: number; outstanding: number; bySupplier: Array<{ name: string; total: number; count: number }>; byDay: Array<{ day: string; total: number }> };
export type DiscountsReport = { from: string; to: string; invoiceDiscount: number; lineDiscount: number; total: number; invoiceCount: number; byDay: Array<{ day: string; total: number }>; topProducts: Array<{ name: string; quantity: number; discount: number }> };
export type CustomersReport = { from: string; to: string; customerCount: number; total: number; credit: number; byCustomer: Array<{ name: string; phone: string | null; invoices: number; total: number; credit: number; wallet: number }> };
export type SuppliersReport = { from: string; to: string; supplierCount: number; total: number; paid: number; bySupplier: Array<{ name: string; phone: string | null; invoices: number; total: number; paid: number }> };
export type InventoryReport = { productCount: number; stockValue: number; backstockValue: number; totalValue: number; lowStockCount: number; outOfStockCount: number; expiringCount: number; expiringValue: number; byCategory: Array<{ name: string; count: number; value: number }> };
export type CustomerPayment = { id: string; amount: number; note: string | null; createdAt: string; user?: { displayName: string } };
export type WalletTxn = { id: string; type: "CHARGE" | "SALE" | "REFUND"; amount: number; note: string | null; saleId: string | null; createdAt: string };
export type CustomerDetail = { customer: Contact; creditSales: number; creditReturns: number; paymentsTotal: number; balance: number; payments: CustomerPayment[]; recentSales: Sale[]; walletTxns?: WalletTxn[]; walletBalance?: number };
export type Installment = { id: string; planId: string; seq: number; amount: number; dueDate: string; paidAt: string | null; paidAmount: number };
export type InstallmentPlan = { id: string; customerId: string; total: number; paidAmount: number; status: "OPEN" | "SETTLED" | "VOID"; note: string | null; saleId: string | null; createdAt: string; installments: Installment[]; customer?: { id: string; name: string; phone: string | null } };
export type CustomerOrderLine = { id: string; productId: string; name: string; sku: string; quantity: number; unitPrice: number; deliveredQty: number };
export type CustomerOrder = { id: string; orderNo: string; customerId: string | null; status: "OPEN" | "FULFILLED" | "CANCELLED"; note: string | null; createdAt: string; lines: CustomerOrderLine[]; customer?: { id: string; name: string; phone: string | null } | null };
export type ReorderRow = { productId: string; name: string; sku: string; unit: string; onHand: number; reserved: number; minStock: number; soldLast30: number; velocityPerDay: number; daysLeft: number | null; suggested: number; belowMin: boolean; lastSupplier: { id: string; name: string; phone: string | null } | null; estimatedCost: number };
export type SerialUnit = { id: string; productId: string; serial: string; status: "IN_STOCK" | "SOLD" | "RETURNED"; purchaseItemId: string | null; saleItemId: string | null; note: string | null; createdAt: string; updatedAt: string; product?: { id: string; name: string; sku: string } };
export type LicenseStatus = { ok: boolean; mode: "TRIAL" | "LICENSED"; reason: "NONE" | "TRIAL_NOT_STARTED" | "TRIAL_EXPIRED" | "LICENSE_EXPIRED" | "TAMPERED" | "MACHINE_MISMATCH"; plan: string | null; licenseId: string | null; customer: string | null; expiresAt: string | null; daysLeft: number | null; effectiveNow: string; trialStartedAt: string | null; trialDaysLeft: number | null; machineKey: string; features: string[] };
export type ReceiptText = { text: string; sale: { id: string; invoiceNo: string | null; receiptNo: string; total: number; customerPhone: string | null } };
export type SupplierPayment = CustomerPayment;
export type SupplierDetail = { supplier: Contact; purchasesTotal: number; paidAtPurchase: number; paymentsTotal: number; balance: number; payments: SupplierPayment[]; recentPurchases: Purchase[] };
export type ProfitReport = {
  from: string; to: string; revenue: number; refunds: number; netRevenue: number; cost: number; profit: number; margin: number;
  unknownCostRevenue: number; invoiceCount: number; purchasesTotal: number; expenses: number; netProfit: number;
  /** Server flags windows larger than the 50k-invoice report cap. */
  truncated?: boolean; trueInvoiceCount?: number;
  byDay: { day: string; revenue: number; profit: number }[];
  byUser?: { userId: string; cashier: string; revenue: number; profit: number; count: number }[];
  bySession?: { sessionId: string; cashier: string; openedAt: string; closedAt: string | null; revenue: number; count: number }[];
  topProducts: { productId: string; name: string; quantity: number; revenue: number; profit: number }[];
  byCategory: { category: string; revenue: number; profit: number; quantity: number }[];
  byHour: { hour: number; revenue: number; count: number }[];
  paymentMix: { method: string; total: number; count?: number }[];
  previous?: ProfitReport;
  comparison?: { revenue: number | null; netRevenue: number | null; profit: number | null; netProfit: number | null; invoiceCount: number | null };
};
export type AuditEntry = { id: string; actor: string | null; action: string; entity: string; entityId: string | null; detail: string | null; createdAt: string };
export type BackupExport = { filename: string; data: string };
export type DebtorsReport = {
  customers: { id: string; name: string; phone: string | null; balance: number; aging?: { d30: number; d60: number; older: number } }[];
  customersTotal: number;
  suppliers: { id: string; name: string; phone: string | null; balance: number }[];
  suppliersTotal: number;
};
export type ShopSettings = { shopName?: string; receiptFooter?: string; logo?: string; address?: string; phone?: string; [key: string]: string | undefined };
export type CashSession = { id: string; status: "OPEN" | "CLOSED"; openingCash: number; expectedCash: number; cashSalesAmount?: number; countedCash: number | null; difference?: number; openedAt: string; closedAt: string | null; user?: { displayName: string }; movements?: { id: string; type: "IN" | "OUT"; amount: number; description: string }[] };
/** End-of-shift (Z) report returned when a cash session is closed. */
export type ZReport = {
  sessionId: string; cashier: string; openedAt: string; closedAt: string;
  openingCash: number; cashIn: number; cashOut: number; cashSales: number; mobileSales: number; creditSales: number; walletSales: number; mobileRefunds?: number;
  invoiceCount: number; returnsTotal: number; expected: number; counted: number; difference: number;
};
export type ProductImportResult = { created: number; updated: number; errors: Array<{ row: number; message: string }> };

export type ProductBatch = { id: string; productId: string; expiryDate: string; initialQty: number; remainingQty: number; product?: { name: string; sku: string; unit: string } };
export type StocktakeLine = { id: string; productId: string; expected: number; counted: number; diff: number; product?: { name: string; sku: string; unit: string } };
export type Stocktake = { id: string; name: string | null; note: string | null; status: "OPEN" | "APPLIED" | "VOID"; createdAt: string; appliedAt: string | null; user?: { displayName: string }; lines?: StocktakeLine[]; _count?: { lines: number } };
export type QuoteItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number };
export type Quote = { id: string; quoteNo: string; note: string | null; total: number; status: "OPEN" | "CONVERTED" | "VOID"; createdAt: string; convertedAt: string | null; customer?: Contact | null; items?: QuoteItem[]; _count?: { items: number } };

// ── Offline sale queue ──────────────────────────────────────────────────────
// When the API is unreachable (fetch throws TypeError), completed baskets are
// parked in localStorage with a random idempotency key and retried every 30s
// and on demand. 4xx replies delete the entry with a warning — the server
// saw and rejected it (e.g. insufficient stock), so retrying is pointless.
const QUEUE_KEY = "darpos-offline-sales";
export type OfflineSale = { key: string; savedAt: number; total: number; label: string; payload: Record<string, unknown> };

export function readOfflineQueue(): OfflineSale[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as OfflineSale[]; } catch { return []; }
}
function writeOfflineQueue(queue: OfflineSale[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* storage full/unavailable */ }
}
export function enqueueOfflineSale(label: string, total: number, payload: Record<string, unknown>): OfflineSale {
  const sale: OfflineSale = { key: `off-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, savedAt: Date.now(), label, total, payload };
  writeOfflineQueue([...readOfflineQueue(), sale]);
  return sale;
}
export function removeFromOfflineQueue(key: string): void {
  writeOfflineQueue(readOfflineQueue().filter((sale) => sale.key !== key));
}
/** Posts one parked sale. Resolves {ok:true} on success, {ok:false,retry:true}
 *  when the server is still unreachable, {ok:false,retry:false} when the
 *  server rejected it for good. */
export async function replayOfflineSale(sale: OfflineSale): Promise<{ ok: boolean; retry: boolean; message?: string }> {
  try {
    // مسیر باید با «/» شروع شود — apiBase() خودش با «/api» تمام می‌شود و
    // بدون اسلش، درخواست به «/apisales» می‌رفت: پخش صف همیشه 404 می‌خورد و
    // فاکتور پارک‌شده به‌اشتباه «رد شده» حذف می‌شد (شکار E2E دور ۸۰).
    await post("/sales", sale.payload, { "Idempotency-Key": sale.key });
    removeFromOfflineQueue(sale.key);
    return { ok: true, retry: false };
  } catch (error) {
    // سرور هنوز در دسترس نیست → در صف بماند. (TypeError خام برای اطمینان
    // می‌ماند؛ مسیر اصلی بعد از هاردنینگ request() همان ConnectionError است.)
    if (error instanceof ConnectionError || error instanceof TypeError) return { ok: false, retry: true };
    const message = error instanceof Error ? error.message : String(error);
    // «صندوق بسته است» برای صف آفلاین خطایی گذراست، نه دائمی: فروش نقدیِ
    // پارک‌شدهٔ روزِ بسته‌شده باید در صف بماند تا صندوق بعدی باز شود و ثبت
    // شود؛ قبلاً ۴۰۰ آن را «ردشده» فرض می‌کردیم و فاکتور برای همیشه گم می‌شد.
    if (message.includes("صندوق بسته است")) return { ok: false, retry: true, message };
    removeFromOfflineQueue(sale.key);
    return { ok: false, retry: false, message };
  }
}
/** Retries every parked sale; resolves when the queue settles (empty or all
 *  remaining entries are permanent rejections already reported). */
export async function flushOfflineQueue(onProgress?: (result: { ok: boolean; retry: boolean; message?: string }) => void): Promise<number> {
  let synced = 0;
  for (const sale of readOfflineQueue()) {
    const result = await replayOfflineSale(sale);
    onProgress?.(result);
    if (result.ok) synced += 1;
    if (result.retry) break; // server still down; stop and keep the rest
  }
  return synced;
}
