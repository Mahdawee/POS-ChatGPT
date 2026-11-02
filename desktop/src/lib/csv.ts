import { t } from "../i18n";

/** Parses CSV text (Excel-compatible: quotes, BOM, , ; or tab separators). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const newline = clean.indexOf("\n");
  const firstLine = clean.slice(0, newline === -1 ? clean.length : newline);
  const counts: Array<{ delimiter: string; count: number }> = [
    { delimiter: ",", count: (firstLine.match(/,/g) || []).length },
    { delimiter: ";", count: (firstLine.match(/;/g) || []).length },
    { delimiter: "\t", count: (firstLine.match(/\t/g) || []).length },
  ];
  counts.sort((a, b) => b.count - a.count);
  const delimiter = counts[0].count > 0 ? counts[0].delimiter : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** Serializes rows into CSV text (with BOM so Excel opens UTF-8 correctly). */
export function toCsv(rows: string[][]): string {
  return `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell ?? "").split('"').join('""')}"`).join(",")).join("\r\n")}`;
}

/** Localized template header for the product import file. */
export function importTemplateHeader(): string[] {
  return [t("نام کالا"), t("کد کالا"), t("بارکد"), t("قیمت فروش"), t("قیمت خرید"), t("موجودی"), t("حداقل موجودی"), t("واحد"), t("وزنی"), t("تاریخ انقضا"), t("دسته‌بندی")];
}

const HEADER_ALIASES: Record<string, string> = {
  "نام کالا": "name", name: "name", "نوم": "name",
  "کد کالا": "sku", sku: "sku", code: "sku",
  "بارکد": "barcode", barcode: "barcode",
  "قیمت فروش": "price", price: "price",
  "قیمت خرید": "cost", cost: "cost",
  "موجودی": "stock", stock: "stock",
  "حداقل موجودی": "minStock", minstock: "minStock",
  "واحد": "unit", unit: "unit",
  "وزنی": "isWeighted", weighted: "isWeighted",
  "تاریخ انقضا": "expiryDate", expiry: "expiryDate", expirydate: "expiryDate",
  "دسته‌بندی": "category", category: "category",
};

const toLatinDigits = (value: string): string => value.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
const toNumber = (value: string): number | undefined => {
  const cleaned = toLatinDigits(String(value)).replace(/[,\s]/g, "");
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const toWeighted = (value: string): boolean | undefined => {
  const lowered = toLatinDigits(value).trim().toLowerCase();
  if (["1", "true", "yes", "بله", "هو", "وزنی"].includes(lowered)) return true;
  if (["0", "false", "no", "نه", ""].includes(lowered)) return false;
  return undefined;
};

export type ImportRow = {
  name: string; sku?: string; barcode?: string; price?: number; cost?: number;
  stock?: number; minStock?: number; unit?: string; isWeighted?: boolean;
  expiryDate?: string; category?: string;
};

/** Maps a parsed CSV (header row + data rows) onto import payload rows. */
export function mapImportRows(grid: string[][]): { rows: ImportRow[]; skipped: number } {
  if (!grid.length) return { rows: [], skipped: 0 };
  const header = grid[0].map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] || HEADER_ALIASES[cell.trim()] || "");
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const line of grid.slice(1)) {
    if (!line.some((cell) => cell.trim())) continue;
    const record: Record<string, string> = {};
    header.forEach((field, index) => { if (field) record[field] = (line[index] ?? "").trim(); });
    if (!record.name) { skipped += 1; continue; }
    const row: ImportRow = { name: record.name };
    if (record.sku) row.sku = record.sku;
    if (record.barcode) row.barcode = record.barcode;
    const price = toNumber(record.price); if (price !== undefined) row.price = Math.round(price);
    const cost = toNumber(record.cost); if (cost !== undefined) row.cost = Math.round(cost);
    const stock = toNumber(record.stock); if (stock !== undefined) row.stock = Math.round(stock * 1000) / 1000;
    const minStock = toNumber(record.minStock); if (minStock !== undefined) row.minStock = Math.round(minStock * 1000) / 1000;
    if (record.unit) row.unit = record.unit;
    const weighted = toWeighted(record.isWeighted); if (weighted !== undefined) row.isWeighted = weighted;
    if (record.expiryDate) {
      const normalized = toLatinDigits(record.expiryDate).trim();
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) {
        const [y, m, d] = normalized.split("-").map(Number);
        row.expiryDate = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    if (record.category) row.category = record.category;
    rows.push(row);
  }
  return { rows, skipped };
}
