import { describe, expect, it } from 'vitest';
import { isValidYearEnd, nextAccountingPeriod, nextYearEndOnOrAfter, yearEndInYear } from './financial-year';

describe('year-end validity', () => {
  it('accepts real month/day pairs, including 29 February, and rejects impossible ones', () => {
    for (const ye of [{ month: 3, day: 31 }, { month: 12, day: 31 }, { month: 2, day: 29 }, { month: 4, day: 5 }]) expect(isValidYearEnd(ye)).toBe(true);
    for (const ye of [{ month: 2, day: 30 }, { month: 4, day: 31 }, { month: 13, day: 1 }, { month: 0, day: 1 }, { month: 1, day: 0 }, { month: 1.5, day: 1 }]) expect(isValidYearEnd(ye)).toBe(false);
  });
});
describe('yearEndInYear', () => {
  it('29 February means the last day of February', () => {
    expect(yearEndInYear({ month: 2, day: 29 }, 2024)).toBe('2024-02-29');
    expect(yearEndInYear({ month: 2, day: 29 }, 2025)).toBe('2025-02-28');
    expect(yearEndInYear({ month: 2, day: 29 }, 1900)).toBe('1900-02-28'); // not a leap year
    expect(yearEndInYear({ month: 2, day: 29 }, 2000)).toBe('2000-02-29'); // divisible by 400
  });
  it('rejects invalid year-ends', () => { expect(() => yearEndInYear({ month: 2, day: 30 }, 2024)).toThrow(); });
});
describe('nextYearEndOnOrAfter', () => {
  const ye = { month: 3, day: 31 };
  it('is inclusive of the start date and rolls into the next year', () => {
    expect(nextYearEndOnOrAfter(ye, '2025-03-31')).toBe('2025-03-31');
    expect(nextYearEndOnOrAfter(ye, '2025-04-01')).toBe('2026-03-31');
    expect(nextYearEndOnOrAfter(ye, '2025-01-15')).toBe('2025-03-31');
    expect(nextYearEndOnOrAfter({ month: 12, day: 31 }, '2025-12-31')).toBe('2025-12-31');
  });
});
describe('nextAccountingPeriod', () => {
  const ye = { month: 3, day: 31 };
  it('follows the previous period end exactly (no gap, no overlap)', () => {
    expect(nextAccountingPeriod(ye, { lastPeriodEnd: '2025-03-31' })).toEqual({ startDate: '2025-04-01', endDate: '2026-03-31' });
    expect(nextAccountingPeriod({ month: 2, day: 29 }, { lastPeriodEnd: '2024-02-29' })).toEqual({ startDate: '2024-03-01', endDate: '2025-02-28' });
    expect(nextAccountingPeriod({ month: 2, day: 29 }, { lastPeriodEnd: '2027-02-28' })).toEqual({ startDate: '2027-03-01', endDate: '2028-02-29' });
  });
  it('the first period starts at incorporation and ends at the first year-end on or after it (short first period)', () => {
    expect(nextAccountingPeriod(ye, { incorporationDate: '2025-09-10' })).toEqual({ startDate: '2025-09-10', endDate: '2026-03-31' });
    expect(nextAccountingPeriod(ye, { incorporationDate: '2025-04-01' })).toEqual({ startDate: '2025-04-01', endDate: '2026-03-31' });
  });
  it('a previous period that did not end on the year-end resolves to the next year-end', () => {
    expect(nextAccountingPeriod(ye, { lastPeriodEnd: '2025-09-29' })).toEqual({ startDate: '2025-09-30', endDate: '2026-03-31' });
  });
  it('needs something to start from', () => { expect(nextAccountingPeriod(ye, {})).toBeNull(); });
  it('works across the year boundary for a 31 December year-end', () => {
    expect(nextAccountingPeriod({ month: 12, day: 31 }, { lastPeriodEnd: '2025-12-31' })).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
  });
});
