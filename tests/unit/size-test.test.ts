import { describe, expect, it } from 'vitest';
import { conditionsMet, money, turnoverWithin, twoYearStatus, type Tri } from '@uk/accounting';
import { createThresholdSetSchema, limitProblems } from '@uk/contracts';

/** V2-M5b (DEC-066): the rules of the size test, on every combination. */
const T: Tri[] = [true, false, null];

describe('two or more of three conditions', () => {
  it('is decided only when two known conditions settle it, on all 27 combinations', () => {
    for (const a of T) for (const b of T) for (const c of T) {
      const yes = [a, b, c].filter((x) => x === true).length, no = [a, b, c].filter((x) => x === false).length;
      expect(conditionsMet([a, b, c]), `${a} ${b} ${c}`).toBe(yes >= 2 ? true : no >= 2 ? false : null);
    }
    expect(conditionsMet([true, true, false])).toBe(true);
    expect(conditionsMet([true, false, null])).toBeNull();
    expect(conditionsMet([false, null, false])).toBe(false);
  });
});

describe('two consecutive years', () => {
  it('agreeing years decide; differing years carry the preceding status; an unknown side is unknown', () => {
    for (const met of T) for (const prior of T) for (const carried of T) {
      let asked = false;
      const r = twoYearStatus(met, prior, () => { asked = true; return carried; });
      if (met === null || prior === null) expect(r, `${met} ${prior}`).toEqual({ status: null, basis: null });
      else if (met === prior) expect(r).toEqual({ status: met, basis: 'BOTH_YEARS' });
      else expect(r).toEqual({ status: carried, basis: carried === null ? null : 'CARRIED_FORWARD' });
      expect(asked, 'the preceding status is read only when the years differ').toBe(met !== null && prior !== null && met !== prior);
    }
  });
  it('a first financial year takes its own result', () => {
    expect(twoYearStatus(true, null, () => false, true)).toEqual({ status: true, basis: 'FIRST_YEAR' });
    expect(twoYearStatus(false, true, () => true, true)).toEqual({ status: false, basis: 'FIRST_YEAR' });
    expect(twoYearStatus(null, null, () => true, true)).toEqual({ status: null, basis: null });
  });
});

describe('the turnover limit of a year that is not twelve months', () => {
  it('is compared exactly, in proportion of days, without rounding', () => {
    // 181 days of 365: the limit is 14,876.7123...
    expect(turnoverWithin(money('14876.71'), money('30000'), 181, 365)).toBe(true);
    expect(turnoverWithin(money('14876.72'), money('30000'), 181, 365)).toBe(false);
    // twelve months, leap year: the full limit
    expect(turnoverWithin(money('30000'), money('30000'), 366, 366)).toBe(true);
    expect(turnoverWithin(money('30000.01'), money('30000'), 366, 366)).toBe(false);
    // eighteen months (546 days): the limit grows to 44,876.71..., not to one and a half times
    expect(turnoverWithin(money('44876.71'), money('30000'), 546, 365)).toBe(true);
    expect(turnoverWithin(money('45000'), money('30000'), 546, 365)).toBe(false);
  });
});

describe('threshold set requests', () => {
  const base = { label: 'Synthetic', effectiveFrom: '2026-01-01', source: { url: 'https://example.test/limits', provision: 'Synthetic', retrievedOn: '2026-10-20' },
    limits: { MICRO: { turnover: '20000', balanceSheetTotal: '10000', employees: 3 }, SMALL: { turnover: '60000', balanceSheetTotal: '30000', employees: 10 }, MEDIUM: { turnover: '200000', balanceSheetTotal: '100000', employees: 50 } } };
  it('take nested positive limits and ordered dates', () => {
    expect(createThresholdSetSchema.safeParse(base).success).toBe(true);
    expect(limitProblems({ ...base.limits, SMALL: { ...base.limits.SMALL, employees: 2 } })).toEqual(['The micro employees limit is above the small one']);
    expect(createThresholdSetSchema.safeParse({ ...base, limits: { ...base.limits, MEDIUM: { ...base.limits.MEDIUM, turnover: '50000' } } }).success).toBe(false);
    expect(createThresholdSetSchema.safeParse({ ...base, limits: { ...base.limits, MICRO: { ...base.limits.MICRO, turnover: '0' } } }).success).toBe(false);
    expect(createThresholdSetSchema.safeParse({ ...base, effectiveTo: '2025-12-31' }).success).toBe(false);
    expect(createThresholdSetSchema.safeParse({ ...base, limits: { ...base.limits, LARGE: base.limits.MEDIUM } }).success).toBe(false);
  });
});
