import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { dateOnly, localeSettings, t, useLanguage } from "../i18n";
import { buildMonth, isoOf, shiftMonth, weekdayHeaders } from "../lib/calendar";

/**
 * تقویمِ انتخاب تاریخ — هم‌زبان با تقویم فروشگاه (شمسی/قمری/میلادی).
 *
 * The native `<input type="date">` always pops a Gregorian calendar, which
 * reads wrong for a shop running on the Solar Hijri or Umm al-Qura calendar.
 * This field shows dates exactly like the rest of the app (same Intl
 * formatting) and opens a month grid in the shop's own calendar. The value
 * stays a plain "YYYY-MM-DD" (Gregorian) string, so every existing filter and
 * form keeps working unchanged.
 */
export function DateField({ value, onChange, placeholder, disabled, title, compact, clearable = true }: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  compact?: boolean;
  clearable?: boolean;
}) {
  const { lang } = useLanguage();
  const locale = lang === "fa" ? "fa-AF" : lang === "ps" ? "ps-AF" : "en-US";
  const rtl = lang !== "en";
  const calendarId = localeSettings().calendar;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The month shown in the popover; jumps to the selected/today month on open.
  const [focus, setFocus] = useState<Date>(new Date());

  useEffect(() => {
    if (!open) return;
    const selected = value ? new Date(`${value}T00:00:00`) : new Date();
    if (!Number.isNaN(selected.getTime())) setFocus(selected);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onPointerDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const grid = useMemo(() => buildMonth(calendarId, locale, focus), [calendarId, locale, focus]);
  const headers = useMemo(() => weekdayHeaders(calendarId, locale), [calendarId, locale]);
  const todayIso = isoOf(new Date());
  const label = value ? dateOnly(`${value}T00:00:00`) : (placeholder || t("انتخاب تاریخ"));
  const prev = rtl ? <ChevronRight size={16}/> : <ChevronLeft size={16}/>;
  const next = rtl ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>;
  const prevYear = rtl ? <ChevronsRight size={13}/> : <ChevronsLeft size={13}/>;
  const nextYear = rtl ? <ChevronsLeft size={13}/> : <ChevronsRight size={13}/>;
  const yearDigits = new Intl.NumberFormat(locale).format(grid.year);

  return <div className={`dp-root${compact ? " dp-compact" : ""}`} ref={rootRef} dir={rtl ? "rtl" : "ltr"}>
    <button type="button" className="dp-field" disabled={disabled} title={title || label} onClick={() => setOpen((was) => !was)} aria-haspopup="dialog" aria-expanded={open}>
      <CalendarDays size={15}/>
      <span className={value ? "" : "dp-empty"}>{label}</span>
      {clearable && value && <span className="dp-clear" role="button" tabIndex={-1} title={t("پاک کردن")} onClick={(event) => { event.stopPropagation(); onChange(""); }}><X size={13}/></span>}
    </button>
    {open && <div className="dp-popover" role="dialog">
      <div className="dp-head">
        <button type="button" className="dp-nav" title={t("ماه قبل")} onClick={() => setFocus((current) => shiftMonth(calendarId, current, -1))}>{prev}</button>
        <div className="dp-title">
          <span className="dp-month-name">{grid.monthLabel}</span>
          <span className="dp-year-row">
            <button type="button" className="dp-nav small" title={t("سال قبل")} onClick={() => setFocus((current) => shiftMonth(calendarId, current, -12))}>{prevYear}</button>
            <b>{yearDigits}</b>
            <button type="button" className="dp-nav small" title={t("سال بعد")} onClick={() => setFocus((current) => shiftMonth(calendarId, current, 12))}>{nextYear}</button>
          </span>
        </div>
        <button type="button" className="dp-nav" title={t("ماه بعد")} onClick={() => setFocus((current) => shiftMonth(calendarId, current, 1))}>{next}</button>
      </div>
      <div className="dp-grid" role="grid">
        {headers.map((name) => <span key={name} className="dp-weekday">{name}</span>)}
        {grid.days.map((day, index) => day
          ? <button type="button" key={day.iso} className={`dp-day${day.iso === todayIso ? " today" : ""}${day.iso === value ? " selected" : ""}`} onClick={() => { onChange(day.iso); setOpen(false); }}>{new Intl.NumberFormat(locale).format(day.day)}</button>
          : <span key={`blank-${index}`} className="dp-day blank"/>)}
      </div>
      <div className="dp-foot">
        <button type="button" className="dp-foot-btn" onClick={() => { const iso = isoOf(new Date()); setFocus(new Date()); onChange(iso); setOpen(false); }}><Check size={13}/>{t("امروز")}</button>
        <span className="dp-hint">{t("تقویم فروشگاه")}</span>
      </div>
    </div>}
  </div>;
}
