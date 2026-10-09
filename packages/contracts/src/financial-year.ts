/**
 * Financial year-end arithmetic (specification §3 "financial year-end"). Pure, date-only (UTC), no I/O.
 * A year-end is a month/day pair. 29 February means "the last day of February": 28 Feb in non-leap years.
 */
export interface YearEnd { month: number; day: number }

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // February allows 29 here (leap-year-safe pair)
export const isValidYearEnd = (ye: YearEnd): boolean =>
  Number.isInteger(ye.month) && Number.isInteger(ye.day) && ye.month >= 1 && ye.month <= 12 && ye.day >= 1 && ye.day <= DAYS[ye.month - 1]!;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** The year-end date falling in calendar year `year` (ISO yyyy-mm-dd). */
export function yearEndInYear(ye: YearEnd, year: number): string {
  if (!isValidYearEnd(ye)) throw new Error('Invalid year end');
  const day = ye.month === 2 && ye.day === 29 && !isLeap(year) ? 28 : ye.day;
  return iso(utc(year, ye.month, day));
}

const addDays = (isoDate: string, n: number) => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** First year-end date on or after `from` (ISO). */
export function nextYearEndOnOrAfter(ye: YearEnd, from: string): string {
  const y = Number(from.slice(0, 4));
  for (const year of [y, y + 1]) { const c = yearEndInYear(ye, year); if (c >= from) return c; }
  throw new Error('unreachable');
}

/**
 * The accounting period that follows `lastPeriodEnd` (or, for the first period, starts at `incorporationDate`):
 * it starts the day after the previous period ended and runs to the next year-end on or after that start. Irregular
 * (short or long first/last) periods therefore resolve themselves to the company's year-end rhythm.
 */
export function nextAccountingPeriod(ye: YearEnd, a: { lastPeriodEnd?: string | null; incorporationDate?: string | null }): { startDate: string; endDate: string } | null {
  const start = a.lastPeriodEnd ? addDays(a.lastPeriodEnd, 1) : a.incorporationDate ?? null;
  if (!start) return null;
  return { startDate: start, endDate: nextYearEndOnOrAfter(ye, start) };
}
