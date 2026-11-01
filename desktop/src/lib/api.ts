export const API = "http://127.0.0.1:4317/api";

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("darpos-token");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401 && !path.endsWith("/auth/login")) window.dispatchEvent(new CustomEvent("darpos:session-expired"));
  if (!response.ok) {
    let message = "درخواست انجام نشد.";
    try {
      const body = await response.json();
      message = Array.isArray(body.message) ? body.message.join("، ") : body.message || message;
    } catch { /* keep a readable fallback */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const get = <T,>(path: string) => request<T>(path);
export const post = <T,>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "POST", body: JSON.stringify(body), headers });
export const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export type User = { id: string; username: string; displayName: string; role: "ADMIN" | "CASHIER" };
export type Category = { id: string; name: string; color: string; _count?: { products: number } };
export type Product = { id: string; sku: string; barcode: string | null; name: string; unit: string; price: number; cost: number; stock: number; minStock: number; categoryId: string | null; category?: Category | null; isActive?: boolean };
export type Contact = { id: string; name: string; phone: string | null; address: string | null; note: string | null };
export type SaleItem = { id: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number; productId: string };
export type SaleReturnItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitPrice: number; lineTotal: number };
export type SaleReturn = { id: string; returnNo: string; total: number; note: string | null; createdAt: string; user?: { displayName: string }; items: SaleReturnItem[] };
export type Sale = { id: string; receiptNo: string; subtotal: number; discount: number; total: number; amountPaid: number; change: number; paymentMethod: "CASH" | "MOBILE" | "CREDIT"; createdAt: string; customer?: Contact | null; user?: { displayName: string }; items: SaleItem[]; returns?: SaleReturn[] };
export type PurchaseItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitCost: number; lineTotal: number };
export type Purchase = { id: string; invoiceNo: string | null; note: string | null; total: number; createdAt: string; supplier?: Contact | null; user?: { displayName: string }; items: PurchaseItem[] };
export type CustomerPayment = { id: string; amount: number; note: string | null; createdAt: string; user?: { displayName: string } };
export type CustomerDetail = { customer: Contact; creditSales: number; creditReturns: number; paymentsTotal: number; balance: number; payments: CustomerPayment[]; recentSales: Sale[] };
export type ShopSettings = { shopName?: string; receiptFooter?: string; [key: string]: string | undefined };
export type CashSession = { id: string; status: "OPEN" | "CLOSED"; openingCash: number; expectedCash: number; cashSalesAmount?: number; countedCash: number | null; difference?: number; openedAt: string; closedAt: string | null; user?: { displayName: string }; movements?: { id: string; type: "IN" | "OUT"; amount: number; description: string }[] };

export const money = (value: number) => `${new Intl.NumberFormat("fa-AF", { maximumFractionDigits: 0 }).format(value)} افغانی`;
export const shortMoney = (value: number) => new Intl.NumberFormat("fa-AF", { maximumFractionDigits: 0 }).format(value);
export const dateTime = (value: string | Date) => new Intl.DateTimeFormat("fa-AF", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export const dateOnly = (value: string | Date) => new Intl.DateTimeFormat("fa-AF", { dateStyle: "medium" }).format(new Date(value));
