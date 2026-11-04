import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "../i18n";

/**
 * Numbered pagination for the server-paged lists (sales, purchases). The
 * server now answers `{ list, total }`, so the page count is real — no more
 * "load more" guessing on thousand-row ledgers.
 *
 * Page numbers are windowed (first, ellipsis, a run around the current page,
 * ellipsis, last) so the bar stays readable even with hundreds of pages.
 */
export function Pagination({ page, pageCount, shown, total, busy, onChange }: { page: number; pageCount: number; shown: number; total: number; busy?: boolean; onChange: (page: number) => void }) {
  if (pageCount <= 1) {
    // Single page: still worth telling the user how many rows matched.
    return <div className="pagination-bar"><span className="toolbar-count">{t("{count} مورد", { count: String(total) })}</span></div>;
  }
  const numbers: Array<number | "…"> = [];
  const push = (value: number | "…") => { if (numbers[numbers.length - 1] !== value) numbers.push(value); };
  // Windowing: never more than «1 … x-1 x x+1 … last» buttons, however many
  // hundreds of pages the ledger has. (The old formula always drew every
  // number from 1 up to `end` and could show 50+ buttons — plus a duplicated
  // leading 1 — on long ledgers.) Each ellipsis must actually hide ≥2 pages.
  if (pageCount <= 7) {
    for (let index = 1; index <= pageCount; index += 1) push(index);
  } else {
    const start = Math.max(2, page - 1);
    const end = Math.min(pageCount - 1, page + 1);
    push(1);
    if (start > 3) push("…");
    for (let index = start; index <= end; index += 1) push(index);
    if (end < pageCount - 2) push("…");
    push(pageCount);
  }
  return <div className="pagination-bar">
    <span className="toolbar-count">{t("{shown} از {count} مورد", { shown: String(shown), count: String(total) })}</span>
    <div className="pagination-pages">
      <button type="button" className="page-arrow" disabled={busy || page <= 1} onClick={() => onChange(page - 1)} aria-label={t("صفحهٔ قبل")}><ChevronRight size={15}/></button>
      {numbers.map((value, index) => value === "…"
        ? <span key={`gap-${index}`} className="page-gap">…</span>
        : <button key={value} type="button" className={`page-number ${value === page ? "active" : ""}`} disabled={busy} onClick={() => onChange(value)}>{value.toLocaleString("fa-AF")}</button>)}
      <button type="button" className="page-arrow" disabled={busy || page >= pageCount} onClick={() => onChange(page + 1)} aria-label={t("صفحهٔ بعد")}><ChevronLeft size={15}/></button>
    </div>
  </div>;
}
