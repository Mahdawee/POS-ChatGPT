const DEFAULT_API = "http://127.0.0.1:4317/api";
const SERVER_KEY = "darpos-server-origin";

/** Base URL of the POS API — the bundled local server by default, or a LAN
 *  server when this machine runs as a network client (Settings → Network). */
export function apiBase(): string {
  try {
    const origin = localStorage.getItem(SERVER_KEY);
    if (origin) return `${origin.replace(/\/+$/, "")}/api`;
  } catch { /* storage unavailable */ }
  return DEFAULT_API;
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

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("darpos-token");
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401 && !path.endsWith("/auth/login")) window.dispatchEvent(new CustomEvent("darpos:session-expired"));
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
  return response.json() as Promise<T>;
}

import { t } from "../i18n";

export const get = <T,>(path: string) => request<T>(path);
export const post = <T,>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "POST", body: JSON.stringify(body), headers });
export const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T,>(path: string) => request<T>(path, { method: "DELETE" });

export type User = { id: string; username: string; displayName: string; role: "ADMIN" | "CASHIER" };
export type Category = { id: string; name: string; color: string; _count?: { products: number } };
export type Product = { id: string; sku: string; barcode: string | null; name: string; unit: string; isWeighted?: boolean; expiryDate?: string | null; price: number; wholesalePrice?: number | null; wholesaleMinQty?: number | null; cost: number; stock: number; backstock?: number; minStock: number; categoryId: string | null; category?: Category | null; isActive?: boolean };
export type Contact = { id: string; name: string; phone: string | null; address: string | null; note: string | null; balance?: number; creditLimit?: number };
export type SaleItem = { id: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number; productId: string; discount?: number };
export type SaleReturnItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number };
export type SaleReturn = { id: string; returnNo: string; total: number; creditRelief?: number; cashAmount?: number; note: string | null; createdAt: string; user?: { displayName: string }; items?: SaleReturnItem[] };
export type Sale = { id: string; receiptNo: string; invoiceNo?: string | null; subtotal: number; discount: number; total: number; amountPaid: number; change: number; cashPart?: number; mobilePart?: number; creditPart?: number; paymentMethod: "CASH" | "MOBILE" | "CREDIT"; createdAt: string; customer?: Contact | null; user?: { displayName: string }; items: SaleItem[]; returns?: SaleReturn[] };
export type PurchaseItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number; expiryDate?: string | null };
export type Purchase = { id: string; invoiceNo: string | null; note: string | null; total: number; paidAmount: number; createdAt: string; supplier?: Contact | null; user?: { displayName: string }; items: PurchaseItem[] };
export type PurchaseReturnItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number };
export type PurchaseReturn = { id: string; returnNo: string; total: number; note: string | null; createdAt: string; supplier?: Contact | null; user?: { displayName: string }; purchase?: { invoiceNo: string | null } | null; items: PurchaseReturnItem[] };
export type Expense = { id: string; title: string; amount: number; category: string | null; note: string | null; fromCash: boolean; cashSessionId: string | null; createdAt: string; user?: { displayName: string } };
export type ExpenseList = { list: Expense[]; total: number };
export type CustomerPayment = { id: string; amount: number; note: string | null; createdAt: string; user?: { displayName: string } };
export type CustomerDetail = { customer: Contact; creditSales: number; creditReturns: number; paymentsTotal: number; balance: number; payments: CustomerPayment[]; recentSales: Sale[] };
export type SupplierPayment = CustomerPayment;
export type SupplierDetail = { supplier: Contact; purchasesTotal: number; paidAtPurchase: number; paymentsTotal: number; balance: number; payments: SupplierPayment[]; recentPurchases: Purchase[] };
export type ProfitReport = {
  from: string; to: string; revenue: number; refunds: number; netRevenue: number; cost: number; profit: number; margin: number;
  unknownCostRevenue: number; invoiceCount: number; purchasesTotal: number; expenses: number; netProfit: number;
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
export type ShopSettings = { shopName?: string; receiptFooter?: string; logo?: string; [key: string]: string | undefined };
export type CashSession = { id: string; status: "OPEN" | "CLOSED"; openingCash: number; expectedCash: number; cashSalesAmount?: number; countedCash: number | null; difference?: number; openedAt: string; closedAt: string | null; user?: { displayName: string }; movements?: { id: string; type: "IN" | "OUT"; amount: number; description: string }[] };
/** End-of-shift (Z) report returned when a cash session is closed. */
export type ZReport = {
  sessionId: string; cashier: string; openedAt: string; closedAt: string;
  openingCash: number; cashIn: number; cashOut: number; cashSales: number; mobileSales: number; creditSales: number;
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
    await post("sales", sale.payload, { "Idempotency-Key": sale.key });
    removeFromOfflineQueue(sale.key);
    return { ok: true, retry: false };
  } catch (error) {
    if (error instanceof TypeError) return { ok: false, retry: true };
    removeFromOfflineQueue(sale.key);
    return { ok: false, retry: false, message: error instanceof Error ? error.message : String(error) };
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
