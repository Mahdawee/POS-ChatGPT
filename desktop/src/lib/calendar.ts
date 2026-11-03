import { localeSettings, type CalendarId } from "../i18n";

/**
 * Calendar math for the date picker. The app's date formatting already goes
 * through Intl with the shop's calendar (persian / islamic-umalqura /
 * gregorian); this module adds the reverse direction — building a month grid
 * in ANY of those calendars and turning a picked (y, m, d) back into a real
 * JavaScript Date — using Intl itself as the single source of truth, so the
 * picker can never drift from the dates the rest of the app prints.
 *
 * Numeric parts are read through an "en" locale (Latin digits, no era noise);
 * display names (month/weekday) go through the active UI locale.
 */

export type CalendarParts = { y: number; m: number; d: number };

const MS_DAY = 86400000;

/** Unicode calendar tag for an Intl locale string. */
export const calendarTag = (id: CalendarId): string =>
  id === "islamic-umalqura" ? "islamic-umalqura" : id === "gregorian" ? "gregory" : "persian";

/** Average year/month lengths — only used to ESTIMATE before refining. */
const averages = (id: CalendarId): { year: number; month: number } =>
  id === "islamic-umalqura" ? { year: 354.367, month: 29.53 } : { year: 365.2425, month: 30.44 };

// Intl formatters are expensive to construct; the picker asks the same
// questions many times per render, so cache one per shape.
const numericCache = new Map<string, Intl.DateTimeFormat>();
const numericFormatter = (id: CalendarId): Intl.DateTimeFormat => {
  const tag = calendarTag(id);
  let formatter = numericCache.get(tag);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(`en-u-ca-${tag}`, { year: "numeric", month: "numeric", day: "numeric" });
    numericCache.set(tag, formatter);
  }
  return formatter;
};
const nameCache = new Map<string, Intl.DateTimeFormat>();
const nameFormatter = (id: CalendarId, locale: string, what: "month" | "weekday"): Intl.DateTimeFormat => {
  const key = `${calendarTag(id)}|${locale}|${what}`;
  let formatter = nameCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { calendar: calendarTag(id), [what]: what === "month" ? "long" : "short" });
    nameCache.set(key, formatter);
  }
  return formatter;
};

/** (y, m, d) of a Date in the given calendar. Month is 1-based. */
export function partsOf(date: Date, id: CalendarId): CalendarParts {
  const parts = { y: 0, m: 0, d: 0 };
  for (const part of numericFormatter(id).formatToParts(date)) {
    if (part.type === "year" && !parts.y) parts.y = Number(part.value);
    else if (part.type === "month" && !parts.m) parts.m = Number(part.value);
    else if (part.type === "day" && !parts.d) parts.d = Number(part.value);
  }
  return parts;
}

const compareParts = (a: CalendarParts, b: CalendarParts): number =>
  a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d;

/**
 * Converts a calendar date (y, m, d) to a Gregorian Date at local midnight.
 * Estimates the target with average month/year lengths, then walks day by day
 * until Intl reports an exact match — a handful of iterations even for dates
 * years away. Returns null for impossible dates (e.g. day 31 of a 30-day
 * month); the picker simply never offers such days.
 */
export function toGregorian(target: CalendarParts, id: CalendarId): Date | null {
  const { year: avgYear, month: avgMonth } = averages(id);
  const anchor = new Date();
  const anchorParts = partsOf(anchor, id);
  const dayNumber = (p: CalendarParts): number => p.y * avgYear + p.m * avgMonth + p.d;
  let cursor = new Date(anchor.getTime() + Math.round((dayNumber(target) - dayNumber(anchorParts)) * MS_DAY));
  for (let step = 0; step < 120; step += 1) {
    const parts = partsOf(cursor, id);
    if (compareParts(parts, target) === 0) {
      const midnight = new Date(cursor);
      midnight.setHours(0, 0, 0, 0);
      return midnight;
    }
    cursor = new Date(cursor.getTime() + (compareParts(target, parts) > 0 ? MS_DAY : -MS_DAY));
  }
  return null;
}

/** Localized long month names (index 1..12) of one calendar year. */
export function monthNames(id: CalendarId, locale: string, year: number): string[] {
  const formatter = nameFormatter(id, locale, "month");
  const names: string[] = ["", ""];
  for (let month = 1; month <= 12; month += 1) {
    const date = toGregorian({ y: year, m: month, d: 15 }, id);
    names[month] = date ? formatter.format(date) : String(month);
  }
  return names;
}

/**
 * Weekday header for the grid: seven short names starting at the locale's own
 * first day of week (Saturday for fa/ps, Sunday for en).
 */
export function weekdayHeaders(id: CalendarId, locale: string): string[] {
  const formatter = nameFormatter(id, locale, "weekday");
  // 2026-01-03 is a Saturday, 2026-01-04 a Sunday.
  const first = locale.startsWith("en") ? new Date(2026, 0, 4) : new Date(2026, 0, 3);
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(first.getFullYear(), first.getMonth(), first.getDate() + index)));
}

/** 0-based column of a Date in the week grid (0 = first day shown). */
export function weekColumn(date: Date, locale: string): number {
  const dow = date.getDay(); // 0=Sun … 6=Sat
  return locale.startsWith("en") ? dow : (dow + 1) % 7;
}

export type MonthGrid = {
  /** Calendar year/month the grid shows. */
  year: number;
  month: number;
  /** Localized "month year" heading. */
  monthLabel: string;
  /** Day cells in order; null = blank filler. Always padded to full weeks. */
  days: Array<{ iso: string; day: number } | null>;
  monthNames: string[];
};

export const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Builds one month of the given calendar around "focus" (any Date in it). */
export function buildMonth(id: CalendarId, locale: string, focus: Date): MonthGrid {
  const { y, m } = partsOf(focus, id);
  const names = monthNames(id, locale, y);
  const digits = new Intl.NumberFormat(locale);
  const first = toGregorian({ y, m, d: 1 }, id) ?? focus;
  const days: MonthGrid["days"] = Array.from({ length: weekColumn(first, locale) }, () => null);
  const cursor = new Date(first);
  for (let guard = 0; guard < 32; guard += 1) {
    const parts = partsOf(cursor, id);
    if (parts.y !== y || parts.m !== m) break;
    days.push({ iso: isoOf(cursor), day: parts.d });
    cursor.setDate(cursor.getDate() + 1);
  }
  while (days.length % 7 !== 0) days.push(null);
  return { year: y, month: m, monthLabel: `${names[m]} ${digits.format(y)}`, days, monthNames: names };
}

/** Shifts the focus to the first day of a calendar month ± whole months. */
export function shiftMonth(id: CalendarId, focus: Date, delta: number): Date {
  const { y, m } = partsOf(focus, id);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1; // 1..12 for any sign of total
  return toGregorian({ y: year, m: month, d: 1 }, id) ?? focus;
}

/** The shop calendar straight from the applied locale settings. */
export const shopCalendar = (): CalendarId => localeSettings().calendar;
