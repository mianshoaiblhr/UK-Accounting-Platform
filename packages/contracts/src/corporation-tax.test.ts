import { describe, expect, it } from 'vitest';
import { CT_RULE_PARAMETERS, createCtAdjustmentRuleSchema, createCtAdjustmentSchema, createCtRuleSchema, ruleAdjustment, splitCtPeriods } from './corporation-tax';

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

describe('ruleAdjustment (DEC-099)', () => {
  it('adds back the share of an expense and deducts the share of income, rounding half away from zero', () => {
    expect(ruleAdjustment('1200.00', '0', '100')).toBe('1200.00');
    expect(ruleAdjustment('1000.00', '200.00', '50')).toBe('400.00');
    expect(ruleAdjustment('0', '750.00', '100')).toBe('-750.00');
    expect(ruleAdjustment('0.05', '0', '50')).toBe('0.03');
    expect(ruleAdjustment('0', '0.05', '50')).toBe('-0.03');
    expect(ruleAdjustment('333.33', '0', '33.33')).toBe('111.10');
    expect(ruleAdjustment('100', '100', '100')).toBe('0.00');
    expect(ruleAdjustment('1000', '0', '12.5', 0)).toBe('125');
  });
  it('checks rules and manual adjustments', () => {
    const base = { accountId: '00000000-0000-4000-8000-000000000001', category: 'ENTERTAINING', percentage: '100', effectiveFrom: '2026-01-01', reason: 'Client entertaining is disallowed' };
    expect(createCtAdjustmentRuleSchema.safeParse(base).success).toBe(true);
    expect(createCtAdjustmentRuleSchema.safeParse({ ...base, percentage: '0' }).success).toBe(false);
    expect(createCtAdjustmentRuleSchema.safeParse({ ...base, percentage: '100.01' }).success).toBe(false);
    expect(createCtAdjustmentRuleSchema.safeParse({ ...base, effectiveTo: '2025-12-31' }).success).toBe(false);
    const adj = { category: 'OTHER', direction: 'ADD', amount: '10.00', description: 'Fine paid', evidenceDocumentId: base.accountId };
    expect(createCtAdjustmentSchema.safeParse(adj).success).toBe(true);
    expect(createCtAdjustmentSchema.safeParse({ ...adj, amount: '0' }).success).toBe(false);
    expect(createCtAdjustmentSchema.safeParse({ ...adj, evidenceDocumentId: undefined }).success).toBe(false);
  });
});

describe('the CT600 box map (V4-M5, DEC-102)', () => {
  it('maps canonical fields only, each box once', () => {
    const P = CT_RULE_PARAMETERS.CT600_FORM;
    expect(P.safeParse({ formVersion: 'CT600 (synthetic)', boxes: { turnover: 145, taxableTotalProfits: 315, 'fy1.profit': 335 } }).success).toBe(true);
    expect(P.safeParse({ formVersion: 'CT600 (synthetic)', boxes: { notAField: 1 } }).success).toBe(false);
    expect(P.safeParse({ formVersion: 'CT600 (synthetic)', boxes: { turnover: 145, tradingProfits: 145 } }).success).toBe(false);
  });
});
