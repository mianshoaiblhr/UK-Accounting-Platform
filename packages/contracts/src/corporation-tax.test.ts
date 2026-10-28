import { describe, expect, it } from 'vitest';
import { createCtRuleSchema, splitCtPeriods } from './corporation-tax';

describe('CT accounting periods from an accounts year (V4-M1, DEC-097)', () => {
  it('a year no longer than the maximum is one period', () => {
    expect(splitCtPeriods('2025-01-01', '2025-12-31', 12)).toEqual([{ start: '2025-01-01', end: '2025-12-31' }]);
    expect(splitCtPeriods('2025-04-06', '2025-10-31', 12)).toEqual([{ start: '2025-04-06', end: '2025-10-31' }]);
  });
  it('a longer year splits into the maximum from its start and the remainder', () => {
    expect(splitCtPeriods('2024-07-01', '2025-12-31', 12)).toEqual([{ start: '2024-07-01', end: '2025-06-30' }, { start: '2025-07-01', end: '2025-12-31' }]);
    expect(splitCtPeriods('2024-01-31', '2025-03-31', 12)).toEqual([{ start: '2024-01-31', end: '2025-01-30' }, { start: '2025-01-31', end: '2025-03-31' }]);
    expect(splitCtPeriods('2024-01-01', '2026-06-30', 12)).toHaveLength(3);
  });
  it('the maximum is the rule\'s figure, not a constant', () => {
    expect(splitCtPeriods('2025-01-01', '2025-12-31', 6)).toEqual([{ start: '2025-01-01', end: '2025-06-30' }, { start: '2025-07-01', end: '2025-12-31' }]);
  });
});

describe('the parameters of a CT rule are checked by kind', () => {
  const source = { url: 'https://example.invalid/x', provision: 'Synthetic', retrievedOn: '2026-01-01' };
  const rates = { mainRate: '25', smallProfitsRate: '19', lowerLimit: '50000', upperLimit: '250000', marginalReliefFraction: { numerator: 3, denominator: 200 } };
  it('accepts consistent rates and refuses inconsistent ones', () => {
    expect(createCtRuleSchema.safeParse({ kind: 'CT_RATES', effectiveFrom: '2023-04-01', parameters: rates, source }).success).toBe(true);
    expect(createCtRuleSchema.safeParse({ kind: 'CT_RATES', effectiveFrom: '2023-04-01', parameters: { ...rates, lowerLimit: '300000' }, source }).success).toBe(false);
    expect(createCtRuleSchema.safeParse({ kind: 'CT_RATES', effectiveFrom: '2023-04-01', parameters: { ...rates, smallProfitsRate: '30' }, source }).success).toBe(false);
    expect(createCtRuleSchema.safeParse({ kind: 'PERIOD_MAX_MONTHS', effectiveFrom: '2000-01-01', parameters: rates, source }).success).toBe(false);
    expect(createCtRuleSchema.safeParse({ kind: 'PERIOD_MAX_MONTHS', effectiveFrom: '2000-01-01', parameters: { months: 12 }, source }).success).toBe(true);
  });
});
