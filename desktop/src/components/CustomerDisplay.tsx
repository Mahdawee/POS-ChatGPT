import { useEffect, useState } from "react";
import { dir, t } from "../i18n";

/**
 * Second-window customer display (Settings → system → "customer display").
 * The POS broadcasts the live cart over a BroadcastChannel — same origin in
 * both WebView2 windows, so no IPC is involved — and this screen renders a
 * big, glanceable summary for the customer.
 */
export type DisplayState = {
  shop: string;
  customer: string;
  items: Array<{ name: string; quantity: number; lineTotal: number }>;
  total: number;
  count: number;
  at: string;
};

const CHANNEL = "darpos-display";

export function CustomerDisplay() {
  const [state, setState] = useState<DisplayState | null>(null);
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => setState(event.data as DisplayState);
    } catch { /* older runtimes: the window simply stays on the welcome card */ }
    return () => { channel?.close(); };
  }, []);
  const last = state?.items?.[state.items.length - 1];
  return <div className="customer-display" dir={dir()}>
    <header className="cd-head"><div className="brand-mark"> {t("رو")} </div><div><strong>{state?.shop || t("روشن")}</strong><small>{t("نمایشگر مشتری")}</small></div></header>
    {state && state.count > 0 ? <main className="cd-body">
      <div className="cd-last"><span>{t("آخرین قلم")}</span><b>{last?.name}</b><small>{last ? `${last.quantity} × ${last.lineTotal}` : ""}</small></div>
      <div className="cd-total"><span>{t("جمع فاکتور")}</span><b>{t("{amount} افغانی", { amount: new Intl.NumberFormat("fa-AF").format(state.total) })}</b></div>
      <div className="cd-count">{t("{count} قلم کالا", { count: state.count })}</div>
      {state.customer && <div className="cd-count">{state.customer}</div>}
    </main> : <main className="cd-body cd-idle">
      <h2>{t("به فروشگاه خوش آمدید")}</h2>
      <p>{t("از خرید شما سپاس‌گزاریم")}</p>
    </main>}
    <footer className="cd-foot">{t("داده‌های شما روی همین دستگاه نگهداری می‌شود")}</footer>
  </div>;
}

/** Opens the second window (called from Settings). Errors surface to the
 *  caller so the UI can explain and keep single-window mode working. */
export async function openCustomerDisplay(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("customer-display");
  if (existing) { await existing.setFocus(); return; }
  await new WebviewWindow("customer-display", {
    url: "index.html#customer-display",
    title: "ROSHAN",
    width: 900,
    height: 520,
    center: true,
    resizable: true,
  });
}
