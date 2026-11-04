import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { toCsv } from "./csv";
import { printHtml } from "./print";

/**
 * File exports for every list page (CSV) and printable A4 reports (PDF).
 *
 * In the browser a classic blob download works, but inside the desktop
 * webview the `download` attribute on a blob link is a no-op (WebView2/wry
 * do not run browser-style downloads), which used to make "دانلود الگوی
 * نمونه" and every CSV export silently do nothing. On the desktop the bytes
 * therefore go through the Rust `save_export_file` command, which writes the
 * file into the user's Downloads folder and returns the full path.
 */

const runningInTauri = (): boolean => typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

/** Unicode-safe base64 (UTF-8 bytes, not char codes) for the Rust side. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Saves text under the given file name. Returns the full path when the file
 * was written by the desktop shell, or "" when the browser handled the
 * download itself.
 */
export async function saveTextFile(filename: string, text: string, mime: string): Promise<string> {
  if (runningInTauri()) {
    try {
      return await invoke<string>("save_export_file", { filename, dataBase64: toBase64(text) });
    } catch (error) {
      throw new Error(t("ذخیرهٔ فایل ممکن نشد:") + " " + (error instanceof Error ? error.message : String(error)));
    }
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: mime }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  return "";
}

/**
 * Exports a table (header row first) as an Excel-friendly CSV (BOM + quoted
 * cells). On the desktop a notification with the saved path is expected from
 * the caller — pages pass their `notify` in.
 */
export async function exportCsv(filename: string, rows: string[][], notify?: (message: string) => void): Promise<void> {
  const where = await saveTextFile(filename, toCsv(rows), "text/csv;charset=utf-8");
  if (where && notify) notify(t("فایل ذخیره شد:") + " " + where);
}

export type PdfTableOptions = {
  title: string;
  /** Rendered under the title, e.g. the active date range or filter. */
  subtitle?: string;
  columns: Array<{ label: string; numeric?: boolean }>;
  rows: Array<Array<string | number>>;
  /** Footer lines rendered as label/value pairs after the table. */
  summary?: Array<[string, string]>;
  /** A4 landscape — defaults to portrait. Wide lists pass true. */
  landscape?: boolean;
};

const pdfEsc = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] as string));

/** Builds the self-contained A4 document for a table export. */
export function tablePdfHtml(options: PdfTableOptions, shopName?: string): string {
  const head = options.columns.map((column) => `<th${column.numeric ? ' class="num"' : ""}>${pdfEsc(column.label)}</th>`).join("");
  const body = options.rows
    .map((row) => `<tr>${row.map((cell, index) => `<td${options.columns[index]?.numeric ? ' class="num"' : ""}>${pdfEsc(cell)}</td>`).join("")}</tr>`)
    .join("");
  const summary = (options.summary || []).map(([label, value]) => `<tr class="summary"><td><b>${pdfEsc(label)}</b></td><td class="num"><b>${pdfEsc(value)}</b></td></tr>`).join("");
  return `
    <h1>${pdfEsc(shopName?.trim() || t("فروشگاه من"))} · ${pdfEsc(options.title)}</h1>
    <p class="muted">${pdfEsc(options.subtitle || "")}</p>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${summary ? `<tfoot>${summary}</tfoot>` : ""}</table>
    <p class="receipt-thanks muted">${pdfEsc(t("برای خروجی PDF، در پنجرهٔ چاپ گزینهٔ Microsoft Print to PDF را انتخاب کنید."))}</p>`;
}

/**
 * Opens the print dialog with a formatted A4 table. Choosing the
 * "Microsoft Print to PDF" printer (or macOS's Save as PDF) turns it into a
 * PDF file; a real printer prints it as a report. Wide tables (7+ columns)
 * automatically print landscape.
 */
export function exportTablePdf(options: PdfTableOptions, shopName?: string): void {
  printHtml(tablePdfHtml(options, shopName), { width: "auto", title: options.title, landscape: options.landscape || options.columns.length >= 7 });
}
