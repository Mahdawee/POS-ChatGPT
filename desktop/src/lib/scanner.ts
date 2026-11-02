/**
 * Barcode / QR scanner support. The readers commonly sold in Afghanistan
 * (Honeywell Voyager, Zebra DS2208, Sunlux, Netum, Tera, and the generic
 * "X-9 / Y-990" guns) all work as USB HID keyboards: they type the code and
 * a terminator (Enter or Tab). No driver is needed — the app only has to
 * listen for fast keystroke bursts, which is what this module standardizes.
 */
import { t } from "../i18n";

export type ScannerSettings = { beep: boolean; endKey: "enter" | "tab" | "both" };
const SETTINGS_KEY = "darpos-scanner";
const LAST_TEST_KEY = "darpos-scanner-last";

export type ScannerTest = { value: string; at: string; ms: number; terminator: "enter" | "tab" | "none" };

export function scannerSettings(): ScannerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<ScannerSettings> : {};
    return { beep: parsed.beep !== false, endKey: parsed.endKey === "enter" || parsed.endKey === "tab" ? parsed.endKey : "both" };
  } catch { return { beep: true, endKey: "both" }; }
}

export function saveScannerSettings(settings: ScannerSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

export function lastScannerTest(): ScannerTest | null {
  try {
    const raw = localStorage.getItem(LAST_TEST_KEY);
    const parsed = raw ? JSON.parse(raw) as ScannerTest : null;
    return parsed && typeof parsed.value === "string" ? parsed : null;
  } catch { return null; }
}

export function rememberScannerTest(test: ScannerTest): void {
  try { localStorage.setItem(LAST_TEST_KEY, JSON.stringify(test)); } catch { /* storage unavailable */ }
}

/** Short confirmation beep after a successful scan (WebAudio, no assets). */
export function beep(ok = true): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = ok ? 1180 : 320;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (ok ? 0.07 : 0.18));
    oscillator.onended = () => { void context.close(); };
  } catch { /* audio unavailable */ }
}

/** Rough classification of a scanned value, for the settings test panel. */
export function classifyBarcode(code: string): string {
  if (/^2\d{12}$/.test(code)) return t("بارکد ترازوی وزنی");
  if (/^\d{13}$/.test(code)) return t("بارکد جهانی EAN-13");
  if (/^\d{12}$/.test(code)) return t("بارکد UPC-A");
  if (/^\d{8}$/.test(code)) return t("بارکد EAN-8");
  if (/^POS-/.test(code)) return t("شمارهٔ رسید داخلی");
  if (/^(PRet|RET)-/.test(code)) return t("شمارهٔ برگشتی داخلی");
  if (/^https?:\/\//.test(code) || code.length > 43 || /\s/.test(code)) return t("کد QR (دوبعدی)");
  if (/^[A-Za-z0-9\-_.:/]+$/.test(code)) return t("بارکد CODE128");
  return t("نامشخص");
}

/** Readers commonly available in Afghan markets — all USB keyboard mode. */
export const SCANNER_DEVICES: Array<{ name: string; kind: string; note: string }> = [
  { name: "Honeywell Voyager 1200g / 1250g", kind: "1D (بارکد خطی)", note: "بی‌دریور، USB" },
  { name: "Honeywell Voyager 1470g", kind: "2D (بارکد + QR)", note: "بی‌دریور، USB" },
  { name: "Zebra DS2208 / DS2278", kind: "2D (بارکد + QR)", note: "بی‌دریور، USB" },
  { name: "Sunlux / X-9 / Y-990", kind: "1D (بارکد خطی)", note: "ارزان و رایج، USB" },
  { name: "Netum NS-BS10 / Tera", kind: "1D / 2D", note: "بی‌دریور، USB" },
];
