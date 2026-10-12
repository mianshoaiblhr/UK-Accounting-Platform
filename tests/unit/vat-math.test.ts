import { describe, expect, it } from 'vitest';
import { money, vatInGross, vatOnNet, vatPeriodFor } from '@uk/accounting';
import { VAT_SCHEMES, createTaxCodeSchema, createTaxRateSchema, vatPercent, vatSettingsSchema, verifyTaxRateSchema } from '@uk/contracts';

/** V1-M4b VAT arithmetic and request rules. Rates here are SYNTHETIC (12.5 %, 7 %): the platform ships no real rate. */
describe('VAT arithmetic (per line, half-up; DEC-025)', () => {
  it('exclusive: round(net x r / 100); half-up at the boundary', () => {
    expect(vatOnNet(money('100.00'), money('12.5'), 2).toFixed(2)).toBe('12.50');
    expect(vatOnNet(money('0.04'), money('12.5'), 2).toFixed(2)).toBe('0.01');           // 0.005 -> 0.01, not 0.00
    expect(vatOnNet(money('0.03'), money('12.5'), 2).toFixed(2)).toBe('0.00');           // 0.00375 -> 0.00
    expect(vatOnNet(money('19.99'), money('7'), 2).toFixed(2)).toBe('1.40');             // 1.3993
    expect(vatOnNet(money('1000'), money('0'), 2).toFixed(2)).toBe('0.00');
  });
  it('inclusive: the VAT fraction r / (100 + r) of the gross; net + VAT always equals the gross', () => {
    expect(vatInGross(money('112.50'), money('12.5'), 2).toFixed(2)).toBe('12.50');
    expect(vatInGross(money('10.00'), money('12.5'), 2).toFixed(2)).toBe('1.11');        // 1.1111
    for (const g of ['0.01', '0.99', '10.00', '123.45', '99999.99']) {
      const v = vatInGross(money(g), money('7'), 2); const n = money(g).minus(v);
      expect(n.plus(v).toFixed(2)).toBe(money(g).toFixed(2));
      expect(v.lte(money(g))).toBe(true);
    }
  });
});

describe('VAT return periods (stagger)', () => {
  it('quarterly periods follow the anchor period end, across year ends and month lengths', () => {
    expect(vatPeriodFor('2026-03-15', '2026-03-31', 3)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(vatPeriodFor('2026-03-31', '2026-03-31', 3)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(vatPeriodFor('2026-04-01', '2026-03-31', 3)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(vatPeriodFor('2025-12-31', '2026-03-31', 3)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(vatPeriodFor('2027-02-28', '2026-05-31', 3)).toEqual({ from: '2026-12-01', to: '2027-02-28' });
    expect(vatPeriodFor('2028-02-29', '2026-05-31', 3)).toEqual({ from: '2027-12-01', to: '2028-02-29' });     // leap year
  });
  it('monthly periods are calendar months', () => {
    expect(vatPeriodFor('2026-02-10', '2026-01-31', 1)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(vatPeriodFor('2025-11-30', '2026-01-31', 1)).toEqual({ from: '2025-11-01', to: '2025-11-30' });
  });
});

describe('VAT request rules', () => {
  it('codes: reverse charge only for standard/reduced purchases; upper-case codes', () => {
    expect(createTaxCodeSchema.safeParse({ code: 'S1', name: 'Standard sales', treatment: 'STANDARD', direction: 'SALES' }).success).toBe(true);
    expect(createTaxCodeSchema.safeParse({ code: 'RC', name: 'RC', treatment: 'STANDARD', direction: 'SALES', reverseCharge: true }).success).toBe(false);
    expect(createTaxCodeSchema.safeParse({ code: 'RC', name: 'RC', treatment: 'EXEMPT', direction: 'PURCHASES', reverseCharge: true }).success).toBe(false);
    expect(createTaxCodeSchema.safeParse({ code: 'RC', name: 'RC', treatment: 'STANDARD', direction: 'PURCHASES', reverseCharge: true }).success).toBe(true);
    expect(createTaxCodeSchema.safeParse({ code: 'lower', name: 'x', treatment: 'ZERO', direction: 'BOTH' }).success).toBe(false);
  });
  it('rates: a percentage string 0-100 with 4 decimals, a source with URL/provision/date, dates in order', () => {
    for (const ok of ['0', '5', '12.5', '7.0000', '100']) expect(vatPercent.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['-1', '100.01', '101', '12.34567', 12.5]) expect(vatPercent.safeParse(bad).success, String(bad)).toBe(false);
    const r = { rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: { url: 'https://example.invalid/rule', provision: 'Synthetic Act s.1', retrievedOn: '2026-01-01' } };
    expect(createTaxRateSchema.safeParse(r).success).toBe(true);
    expect(createTaxRateSchema.safeParse({ ...r, source: { ...r.source, url: 'not a url' } }).success).toBe(false);
    expect(createTaxRateSchema.safeParse({ ...r, effectiveTo: '2025-12-31' }).success).toBe(false);
    expect(createTaxRateSchema.safeParse({ ...r, netBoxes: [1] }).success).toBe(false);
    expect(createTaxRateSchema.safeParse({ ...r, vatBoxes: [6] }).success).toBe(false);
    expect(verifyTaxRateSchema.safeParse({ notes: 'short' }).success).toBe(false);
  });
  it('settings: a registered company needs VRN, registration date, period end and VAT accounts; only STANDARD is implemented', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const ok = { registered: true, vrn: 'GB 123456789', registeredFrom: '2026-01-01', anchorPeriodEnd: '2026-03-31', outputAccountId: id, inputAccountId: id, reason: 'Registered from 1 January' };
    expect(vatSettingsSchema.parse(ok).vrn).toBe('GB123456789');
    expect(vatSettingsSchema.safeParse({ ...ok, vrn: null }).success).toBe(false);
    expect(vatSettingsSchema.safeParse({ ...ok, vrn: '12345' }).success).toBe(false);
    expect(vatSettingsSchema.safeParse({ registered: false, reason: 'Not registered yet here' }).success).toBe(true);
    expect(Object.entries(VAT_SCHEMES).filter(([, s]) => s.implemented).map(([k]) => k)).toEqual(['STANDARD']);
  });
});
