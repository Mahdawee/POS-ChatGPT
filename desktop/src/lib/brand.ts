import { useSyncExternalStore } from "react";
import { apiBase } from "./api";
import { t } from "../i18n";

/** برند برنامه (نامش، فعلاً «روشن») از فایل مالک می‌آید — نه از کد.
 *
 * سرور owner.json را که مالک با ابزار بیرونی ویرایش می‌کند، بی‌درنگ
 * دوباره می‌خواند و این endpoint عمومی نام مؤثر را می‌دهد (قبل از ورود
 * هم در دسترس است چون صفحهٔ ورود نام برنامه را نشان می‌دهد). اگر فایل
 * نباشد یا سرور نگیرد، همان نام پیش‌فرضِ «روشن» می‌ماند.
 *
 * تغییر نام با بستن/باز کردن برنامه لازم نیست: هر ۶۰ ثانیه دوباره
 * خوانده می‌شود تا هویت تازهٔ تعیین‌شدهٔ مالک ظرف یک دقیقه همه‌جا
 * (نوار عنوان، منو، رسیدها، صفحهٔ ورود) دیده شود. */
export type Brand = { appName: string };

const DEFAULT_APP_NAME = "روشن";
const DEFAULT_BRAND: Brand = { appName: DEFAULT_APP_NAME };

let brand: Brand = DEFAULT_BRAND;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function getBrand(): Brand {
  return brand;
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** نام مؤثر برنامه را از سرور می‌گیرد؛ فقط وقتی واقعاً عوض شده باشد
 *  رندر مجدد را تحریک می‌کند. خطا بی‌صدا می‌ماند (برند پیش‌فرض معتبر است). */
export async function loadBrand(): Promise<void> {
  try {
    const response = await fetch(`${apiBase()}/owner-config`);
    if (!response.ok) return;
    const data = (await response.json()) as { appName?: unknown };
    const appName = typeof data.appName === "string" && data.appName.trim() ? data.appName.trim() : DEFAULT_APP_NAME;
    if (appName !== brand.appName) {
      brand = { appName };
      emit();
    }
  } catch { /* server not up yet — the default brand stays */ }
}

export function useBrand(): Brand {
  return useSyncExternalStore(subscribeBrand, getBrand);
}

/** علامت دوجانبی برند: هم عنوان تب مرورگر، هم عنوان پنجرهٔ اصلی
 *  برنامهٔ دسکتاپ (که وگرنه از tauri.conf.json ثابت می‌ماند). */
export async function applyBrandWindowTitle(appName: string): Promise<void> {
  const title = `${appName} | ${t("فروش و مدیریت فروشگاه")}`;
  document.title = title;
  if (typeof window !== "undefined" && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTitle(title);
    } catch { /* window API unavailable — the document title is already set */ }
  }
}
