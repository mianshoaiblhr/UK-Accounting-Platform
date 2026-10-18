import { Prisma } from '@uk/db';
import { ZERO, money, type Money } from './money';

/**
 * V2-M2 depreciation arithmetic (DEC-058; v2-plan 4.2). Pure and exact: no floating point, no rounding until the cumulative amount due at a date is
 * rounded half-up to the currency's minor units. A charge is always "cumulative due now - already charged", so rounding never drifts and the
 * residual value is reached exactly. Dates are ISO days (UTC).
 */
export type Method = 'STRAIGHT_LINE' | 'REDUCING_BALANCE';
export type Convention = 'DAILY' | 'MONTHLY';
export interface Basis {
  effectiveFrom: string;
  /** Carrying amount at the start of the basis (cost, or cost less accumulated depreciation). */
  carryingAmount: Money;
  /** Accumulated depreciation before the basis (take-on amount, or what was charged under earlier bases). */
  accumulatedBefore: Money;
  method: Method;
  lifeMonths: number | null;
  ratePercent: Money | null;
  residual: Money;
  convention: Convention;
}

const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => isoDay(toTime(d) + n * DAY);
/** Calendar months later, clamped to the month's last day (31 January + 1 month = 28/29 February). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + n, yy = y + Math.floor(total / 12), mm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return isoDay(Date.UTC(yy, mm, Math.min(day, last)));
}
/** Days from a to b, counting both (0 when b is before a). */
export const daysInclusive = (a: string, b: string) => Math.max(0, Math.round((toTime(b) - toTime(a)) / DAY) + 1);
const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
const lastDayOfMonth = (y: number, m: number) => isoDay(Date.UTC(y, m + 1, 0));

/**
 * MONTHLY convention: the months counted at `d` from the basis month. The basis month counts in full; a month counts once `d` reaches its last day.
 * At a disposal the disposal month never counts (only the months before it).
 */
export function monthsCounted(from: string, d: string, disposal = false): number {
  if (d < from) return 0;
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [dy, dm] = d.split('-').map(Number) as [number, number];
  const span = (dy - fy) * 12 + (dm - fm);              // whole months from the basis month to the month of d
  if (disposal) return Math.max(0, span);
  return lastDayOfMonth(dy, dm - 1) === d ? span + 1 : span;
}

/** Depreciation due since the start of the basis, at `d` (unrounded). Never more than the carrying amount less the residual. */
export function dueSinceBasis(b: Basis, d: string, o: { disposal?: boolean } = {}): Money {
  if (d < b.effectiveFrom) return ZERO;
  const cap = Prisma.Decimal.max(ZERO, b.carryingAmount.minus(b.residual));
  if (b.method === 'STRAIGHT_LINE') {
    const life = b.lifeMonths!;
    let frac: Money;
    if (b.convention === 'DAILY') {
      const lifeDays = daysBetween(b.effectiveFrom, addMonths(b.effectiveFrom, life));
      frac = money(Math.min(daysInclusive(b.effectiveFrom, d), lifeDays)).div(lifeDays);
    } else {
      frac = money(Math.min(monthsCounted(b.effectiveFrom, d, o.disposal), life)).div(life);
    }
    return cap.mul(frac);
  }
  // reducing balance: whole asset years n and the fraction f of the current one; the carrying amount never falls below the residual
  const r = b.ratePercent!.div(100);
  let n: number, f: Money;
  if (b.convention === 'DAILY') {
    const next = addDays(d, 1);
    n = 0;
    while (addMonths(b.effectiveFrom, 12 * (n + 1)) <= next) n++;
    const ys = addMonths(b.effectiveFrom, 12 * n), ye = addMonths(b.effectiveFrom, 12 * (n + 1));
    f = money(daysBetween(ys, next)).div(daysBetween(ys, ye));
  } else {
    const m = monthsCounted(b.effectiveFrom, d, o.disposal);
    n = Math.floor(m / 12);
    f = money(m % 12).div(12);
  }
  const carrying = b.carryingAmount.mul(money(1).minus(r).pow(n)).mul(money(1).minus(r.mul(f)));
  return Prisma.Decimal.min(cap, b.carryingAmount.minus(Prisma.Decimal.max(carrying, b.residual)));
}

/** Accumulated depreciation that should stand at `d` under the basis, rounded half-up to the currency's minor units. */
export const accumulatedDue = (b: Basis, d: string, minor: number, o: { disposal?: boolean } = {}) =>
  b.accumulatedBefore.plus(dueSinceBasis(b, d, o)).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);
