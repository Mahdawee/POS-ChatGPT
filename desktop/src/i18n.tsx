import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { english, pashto } from "./i18n-dictionaries";

/**
 * Three UI languages: Dari (fa, right-to-left), Pashto (ps, right-to-right)
 * and English (en, left-to-right). Dari strings are the source of truth and
 * double as dictionary keys, so `t("ذخیره")` returns the Pashto/English entry
 * when one exists and falls back to the Dari text itself otherwise — a missed
 * translation can never render a raw key.
 */
export type Lang = "fa" | "ps" | "en";
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: "fa", label: "دری" },
  { id: "ps", label: "پښتو" },
  { id: "en", label: "English" },
];

const STORAGE_KEY = "darpos-lang";

function readStoredLang(): Lang {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "fa" || value === "ps" || value === "en") return value;
  } catch { /* storage unavailable */ }
  return "fa";
}

/** Module-level current language so non-React modules (printing, CSV, …) can translate too. */
let currentLang: Lang = readStoredLang();
export const lang = (): Lang => currentLang;
export const dir = (): "rtl" | "ltr" => (currentLang === "en" ? "ltr" : "rtl");

// ── Locale settings (calendar / timezone / currency) ───────────────────────
// Shop-level display settings loaded from the server at login; module-level
// so date formatting helpers used outside React (printing, CSV) follow them.
export type CalendarId = "persian" | "islamic-umalqura" | "gregorian";
export type LocaleSettings = { calendar: CalendarId; timezone: string; currency: string };
let currentCalendar: CalendarId = "persian";
let currentTimezone = "";
let currentCurrency = "AFN";

/** ارزهای نمایش مبالغ. پیش‌فرض فقط افغانی و دلار؛ فهرست کامل از تنظیمات
 *  فروشگاه (کلید currencies) بارگذاری می‌شود و افغانی همیشه موجود است. */
export type CurrencyRow = { code: string; label: string };
export const BASE_CURRENCIES: CurrencyRow[] = [
  { code: "AFN", label: "افغانی" },
  { code: "USD", label: "دلار امریکا" },
];
let currencyList: CurrencyRow[] = BASE_CURRENCIES;
export const currencies = (): CurrencyRow[] => currencyList;
/** فهرست ارزها را از تنظیمات فروشگاه اعمال می‌کند؛ ارز پایهٔ فعلی اگر در
 *  فهرست نباشد به افغانی برمی‌گردد و افغانی هرگز حذف نمی‌شود. */
export function applyCurrencyList(rows: CurrencyRow[]): void {
  const valid = rows.filter((row) => row && typeof row.code === "string" && typeof row.label === "string" && row.label.trim().length > 0);
  currencyList = valid.some((row) => row.code === "AFN") ? valid : [{ code: "AFN", label: "افغانی" }, ...valid];
  if (!currencyList.some((row) => row.code === currentCurrency)) currentCurrency = "AFN";
}
export const currencyLabel = (code: string): string => currencyList.find((row) => row.code === code)?.label ?? code;

/** Applies shop display settings; unknown values fall back to the defaults. */
export function applyLocaleSettings(settings: Partial<LocaleSettings>): void {
  if (settings.calendar === "persian" || settings.calendar === "islamic-umalqura" || settings.calendar === "gregorian") currentCalendar = settings.calendar;
  if (typeof settings.timezone === "string") currentTimezone = settings.timezone;
  if (typeof settings.currency === "string" && currencyList.some((row) => row.code === settings.currency)) currentCurrency = settings.currency;
}
export const localeSettings = (): LocaleSettings => ({ calendar: currentCalendar, timezone: currentTimezone, currency: currentCurrency });

// Dictionaries are imported (not required at runtime via a registry call) so
// module initialization has no circular dependency.
const dictionaries: Record<Lang, Record<string, string>> = {
  fa: {},
  ps: pashto,
  en: english,
};

/** Translates `key` (a Dari sentence) into the active language, interpolating `{param}` placeholders. */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = dictionaries[currentLang][key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

const localeOf = (which: Lang): string => (which === "fa" ? "fa-AF" : which === "ps" ? "ps-AF" : "en-US");
const activeLocale = () => localeOf(currentLang);
/** Intl calendar tag for the active shop calendar (Dari default: Solar Hijri). */
const activeCalendar = (): string => (currentCalendar === "islamic-umalqura" ? "islamic-umalqura" : currentCalendar === "gregorian" ? "gregory" : "persian");
const dateOptions = (): { calendar: string; timeZone?: string } => {
  const options: { calendar: string; timeZone?: string } = { calendar: activeCalendar() };
  if (currentTimezone) options.timeZone = currentTimezone;
  return options;
};

export const money = (value: number): string => `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value)} ${t(currencyLabel(currentCurrency))}`;
export const moneyPlain = (value: number): string => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value);
export const qty = (value: number): string => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 3 }).format(value);
// کمیتِ «ماشین‌خوان»: ارقام لاتین و نقطهٔ اعشار — برای خانه‌های CSV که باید
// دوباره واردسازی شوند (جداشکنندهٔ اعشار فارسی «٫» در toNumber پارس نمی‌شود).
export const qtyPlain = (value: number): string => String(Math.round((Number(value) || 0) * 1000) / 1000);
// زمان‌ها در کل برنامه ۱۲ساعته‌اند (ق.ظ/ب.ظ، AM/PM) — درخواست مالک؛
// hour12 صریحاً گذاشته شده تا هیچ زبانی به ساعت ۲۴نگاره‌ای برنگردد.
export const dateTime = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short", hour12: true, ...dateOptions() }).format(new Date(value));
export const timeOnly = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { hour: "2-digit", minute: "2-digit", hour12: true, ...dateOptions() }).format(new Date(value));
export const dateOnly = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", ...dateOptions() }).format(new Date(value));
export const dayLabel = (day: string): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", ...dateOptions() }).format(new Date(`${day}T00:00:00`));
export const todayLabel = (): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", ...dateOptions() }).format(new Date());
export const fullDate = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "full", ...dateOptions() }).format(new Date(value));
export const percent = (value: number): string => `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value)}${currentLang === "en" ? "%" : "٪"}`;

/** نام پلن لایسنس به زبان فعال. */
export function licensePlanLabel(plan: string | null): string {
  switch (plan) {
    case "MONTHLY": return t("ماهانه");
    case "YEARLY": return t("سالانه");
    case "CUSTOM": return t("دلخواه");
    case "LIFETIME": return t("ابدی");
    default: return plan || "";
  }
}

/** Applies the language to the document (direction, lang) — called by the provider and at boot.
 *  The window/tab TITLE is deliberately not touched here: it belongs to the
 *  owner-controlled brand (lib/brand.ts), which re-applies it on every
 *  language or brand change. */
export function applyDocumentLanguage(which: Lang): void {
  const root = document.documentElement;
  root.lang = which === "fa" ? "fa" : which === "ps" ? "ps" : "en";
  root.dir = which === "en" ? "ltr" : "rtl";
}

type LanguageContextValue = { lang: Lang; dir: "rtl" | "ltr"; setLang: (which: Lang) => void };
const LanguageContext = createContext<LanguageContextValue>({ lang: currentLang, dir: dir(), setLang: () => undefined });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Lang>(currentLang);
  const setLang = (which: Lang) => {
    currentLang = which;
    try { localStorage.setItem(STORAGE_KEY, which); } catch { /* storage unavailable */ }
    setActive(which);
    applyDocumentLanguage(which);
  };
  useEffect(() => { applyDocumentLanguage(active); }, [active]);
  return <LanguageContext.Provider value={{ lang: active, dir: active === "en" ? "ltr" : "rtl", setLang }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = (): LanguageContextValue => useContext(LanguageContext);
