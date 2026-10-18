import { describe, expect, it } from 'vitest';
import { accumulatedDue, addMonths, daysInclusive, dueSinceBasis, money, monthsCounted, type Basis } from '@uk/accounting';

/** V2-M2 depreciation arithmetic (DEC-058; v2-plan 4.2): exact, cumulative, rounded once. Hand figures in the comments. */
const B = (o: Partial<Basis>): Basis => ({ effectiveFrom: '2026-01-01', carryingAmount: money(1200), accumulatedBefore: money(0), method: 'STRAIGHT_LINE', lifeMonths: 12, ratePercent: null, residual: money(0), convention: 'MONTHLY', ...o });
const at = (b: Basis, d: string, disposal = false) => accumulatedDue(b, d, 2, { disposal }).toFixed(2);

describe('calendar helpers', () => {
  it('months clamp to the month end; days count both ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
    expect(daysInclusive('2026-01-01', '2026-01-01')).toBe(1);
    expect(daysInclusive('2026-01-02', '2026-01-01')).toBe(0);
  });
  it('MONTHLY counts the basis month in full and a month once its last day is reached; never the disposal month', () => {
    expect(monthsCounted('2026-03-15', '2026-03-30')).toBe(0);
    expect(monthsCounted('2026-03-15', '2026-03-31')).toBe(1);
    expect(monthsCounted('2026-03-15', '2026-06-30')).toBe(4);
    expect(monthsCounted('2026-03-15', '2026-06-29')).toBe(3);
    expect(monthsCounted('2026-03-15', '2026-06-30', true)).toBe(3);
    expect(monthsCounted('2026-03-15', '2026-03-31', true)).toBe(0);
  });
});

describe('straight line', () => {
  it('MONTHLY: 100.00 a month, never beyond the depreciable amount, and exactly to the residual', () => {
    const b = B({ residual: money(120) });                     // (1,200 - 120) / 12 = 90.00 a month
    expect(at(b, '2026-01-31')).toBe('90.00');
    expect(at(b, '2026-12-31')).toBe('1080.00');
    expect(at(b, '2030-12-31')).toBe('1080.00');
  });
  it('DAILY: days in use over the days of the life; rounding never drifts (cumulative, rounded once)', () => {
    const b = B({ convention: 'DAILY', carryingAmount: money(1000), lifeMonths: 36 });   // 1,000 over 1,096 days (2026-2028; 2028 is a leap year)
    expect(at(b, '2026-01-01')).toBe('0.91');                  // 1,000 / 1,096 = 0.9124
    expect(at(b, '2026-01-02')).toBe('1.82');                  // 2 days = 1.8248
    expect(at(b, '2026-12-31')).toBe('333.03');                // 365 / 1,096 = 333.0292
    expect(at(b, '2028-12-31')).toBe('1000.00');
  });
  it('a basis after a change of estimate carries what was charged before it', () => {
    const b = B({ effectiveFrom: '2027-01-01', carryingAmount: money(2600), accumulatedBefore: money(1000), lifeMonths: 13 });
    expect(at(b, '2026-12-31')).toBe('1000.00');
    expect(at(b, '2027-01-31')).toBe('1200.00');
    expect(at(b, '2028-01-31')).toBe('3600.00');
  });
});

describe('reducing balance', () => {
  const rb = (o: Partial<Basis> = {}) => B({ method: 'REDUCING_BALANCE', lifeMonths: null, ratePercent: money(25), carryingAmount: money(12000), residual: money(1000), convention: 'DAILY', effectiveFrom: '2026-07-01', ...o });
  it('DAILY within the first asset year, and at its anniversary', () => {
    expect(at(rb(), '2026-12-31')).toBe('1512.33');            // 12,000 x 0.25 x 184/365
    expect(at(rb(), '2027-06-30')).toBe('3000.00');            // one whole year: 12,000 x 0.25
    expect(at(rb(), '2028-06-30')).toBe('5250.00');            // 12,000 - 12,000 x 0.75^2 = 5,250
  });
  it('a leap asset year has 366 days', () => {
    const b = rb({ effectiveFrom: '2027-07-01' });               // 1.7.2027-30.6.2028 includes 29.2.2028
    expect(dueSinceBasis(b, '2028-02-29').toFixed(4)).toBe(money(12000).mul(0.25).mul(244).div(366).toFixed(4));
  });
  it('MONTHLY uses months / 12; the carrying amount never falls below the residual', () => {
    const b = rb({ convention: 'MONTHLY', residual: money(9500) });
    expect(at(b, '2026-12-31')).toBe('1500.00');               // 6 months: 12,000 x 0.25 x 6/12
    expect(at(b, '2027-12-31')).toBe('2500.00');               // capped: 12,000 - 9,500
  });
});
