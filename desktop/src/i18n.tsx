import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import "./i18n-dictionaries";

/**
 * Three UI languages: Dari (fa, right-to-left), Pashto (ps, right-to-left)
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

const dictionaries: Record<Lang, Record<string, string>> = {
  fa: {},
  ps: {},
  en: {},
};

/** Loads a dictionary (used by i18n-dictionaries.ts at module init). */
export function registerDictionary(which: Lang, entries: Record<string, string>): void {
  dictionaries[which] = entries;
}

/** Translates `key` (a Dari sentence) into the active language, interpolating `{param}` placeholders. */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = dictionaries[currentLang][key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

const localeOf = (which: Lang): string => (which === "fa" ? "fa-AF" : which === "ps" ? "ps-AF" : "en-US");
const activeLocale = () => localeOf(currentLang);

export const money = (value: number): string => `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value)} ${t("افغانی")}`;
export const moneyPlain = (value: number): string => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value);
export const qty = (value: number): string => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 3 }).format(value);
export const dateTime = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export const dateOnly = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));
export const dayLabel = (day: string): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(`${day}T00:00:00`));
export const todayLabel = (): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date());
export const fullDate = (value: string | Date): string => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "full" }).format(new Date(value));
export const percent = (value: number): string => `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value)}${currentLang === "en" ? "%" : "٪"}`;

/** Applies the language to the document (direction, lang, title) — called by the provider and at boot. */
export function applyDocumentLanguage(which: Lang): void {
  const root = document.documentElement;
  root.lang = which === "fa" ? "fa" : which === "ps" ? "ps" : "en";
  root.dir = which === "en" ? "ltr" : "rtl";
  document.title = t("روشن | فروش و مدیریت فروشگاه");
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
