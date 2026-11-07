import { useState } from "react";
import { ChevronDown, FileDown, FileText, Printer } from "lucide-react";
import { t } from "../i18n";

/** One tidy "خروجی" button per toolbar that unfolds into CSV / PDF — every
 *  list page exports exactly the rows it is currently showing (search,
 *  filters and sorting included). CSV goes through the shared export helper
 *  (browser download, or the desktop shell's Downloads folder); PDF opens
 *  the print dialog with a formatted A4 table. */
export function ExportMenu({ onExport, disabled = false }: { onExport(kind: "csv" | "pdf"): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="export-menu">
    <button type="button" className="secondary-button export-button" disabled={disabled} onClick={() => setOpen((value) => !value)}><FileDown size={16}/>{t("خروجی")}<ChevronDown size={14} className={open ? "flip" : ""}/></button>
    {open && <>
      <div className="export-backdrop" onClick={() => setOpen(false)}/>
      <div className="export-popover" role="menu">
        <button type="button" role="menuitem" onClick={() => { setOpen(false); onExport("csv"); }}><FileText size={15}/>{t("فایل CSV (اکسل)")}</button>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); onExport("pdf"); }}><Printer size={15}/>{t("PDF / چاپ")}</button>
      </div>
    </>}
  </div>;
}
