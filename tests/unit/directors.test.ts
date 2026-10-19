import { describe, expect, it } from 'vitest';
import { dayEndStats, lineCategory, money, movementCategory } from '@uk/accounting';

/** V2-M4 rules (DEC-062): how a loan-account movement is categorised, and the day-end lowest balance and days overdrawn. Hand figures in the comments. */
const line = (o: Partial<Parameters<typeof lineCategory>[0]>) => lineCategory({ type: 'ASSET', subtype: 'CURRENT_ASSET_OTHER', controlKind: null, isLoanAccount: false, ...o });

describe('movement categories', () => {
  it('each other line has a category; a VAT line never decides it', () => {
    expect(line({ subtype: 'CURRENT_ASSET_BANK', controlKind: 'BANK' })).toBe('CASH_AND_BANK');
    expect(line({ subtype: 'CURRENT_ASSET_CASH', controlKind: 'CASH' })).toBe('CASH_AND_BANK');
    expect(line({ type: 'EQUITY', subtype: 'DIVIDENDS' })).toBe('DIVIDENDS');
    expect(line({ type: 'EXPENSE', subtype: 'OVERHEADS' })).toBe('EXPENSES');
    expect(line({ type: 'INCOME', subtype: 'OTHER_INCOME' })).toBe('INCOME');
    expect(line({ type: 'LIABILITY', subtype: 'CURRENT_LIABILITY_OTHER', isLoanAccount: true })).toBe('OTHER_LOAN_ACCOUNT');
    expect(line({ type: 'ASSET', subtype: 'FIXED_ASSET_TANGIBLE' })).toBe('OTHER');
    expect(line({ type: 'LIABILITY', subtype: 'CURRENT_LIABILITY_VAT', controlKind: 'VAT_CONTROL' })).toBeNull();
  });
  it('a journal takes the one category its other lines share, else MIXED; expenses paid with VAT stay EXPENSES', () => {
    expect(movementCategory(['EXPENSES', null])).toBe('EXPENSES');                  // Dr travel 300, Dr VAT 60 / Cr loan account 360
    expect(movementCategory(['EXPENSES', 'EXPENSES', null])).toBe('EXPENSES');
    expect(movementCategory(['INCOME', 'OTHER'])).toBe('MIXED');
    expect(movementCategory([null])).toBe('OTHER');
    expect(movementCategory([])).toBe('OTHER');
  });
});

describe('day-end statistics', () => {
  const m = (date: string, balance: number) => ({ date, balance: money(balance) });
  it('the lowest day-end balance, the first day it holds, and the days ending overdrawn', () => {
    // overdrawn at the end of 15.3 to 29.6: 17 + 30 + 31 + 29 = 107 days
    expect(dayEndStats(money(0), [m('2026-01-05', 1000), m('2026-03-15', -1500), m('2026-04-30', -1200), m('2026-06-30', 800)], '2026-01-01', '2026-12-31'))
      .toEqual({ lowest: money(-1500), lowestOn: '2026-03-15', daysOverdrawn: 107 });
  });
  it('an opening balance holds until the first movement; two movements on one day count at the day end', () => {
    // overdrawn from 1.1 to 9.1 (9 days) at -100; on 10.1 it goes to -300 and back to 50 the same day: the day ends at 50
    expect(dayEndStats(money(-100), [m('2026-01-10', -300), m('2026-01-10', 50)], '2026-01-01', '2026-01-31')).toEqual({ lowest: money(-100), lowestOn: '2026-01-01', daysOverdrawn: 9 });
  });
  it('no movement: the opening balance holds for the whole range; equal lows keep the first day', () => {
    expect(dayEndStats(money(-5), [], '2026-02-01', '2026-02-28')).toEqual({ lowest: money(-5), lowestOn: '2026-02-01', daysOverdrawn: 28 });
    expect(dayEndStats(money(10), [m('2026-02-05', 0), m('2026-02-10', 5), m('2026-02-20', 0)], '2026-02-01', '2026-02-28')).toEqual({ lowest: money(0), lowestOn: '2026-02-05', daysOverdrawn: 0 });
  });
});
