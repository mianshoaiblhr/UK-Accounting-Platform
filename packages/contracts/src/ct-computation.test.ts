import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCorporationTax, financialYearParts, type CtComputationInput } from './ct-computation';

/** V4-M4 (DEC-101): the arithmetic against the hand-worked golden (tests/golden/v4-m4-computation.json) and edge cases. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../../../tests/golden/v4-m4-computation.json'), 'utf8'));
const rates = (fys: number[]) => Object.fromEntries(fys.map((fy) => [fy, { ruleId: 'r', ...G.rates }]));
const fy = (r: ReturnType<typeof computeCorporationTax>) => r.financialYears.map((y) => [y.financialYear, y.days, y.profit, y.lowerLimit, y.upperLimit, y.basis, y.taxAtRate, y.marginalRelief, y.tax]);
const A: CtComputationInput = { startDate: '2027-01-01', endDate: '2027-12-31', days: 365, twelveMonths: true, associatedCompanies: 0, adjustedProfit: '150000.00', allowances: '20000.00',
  balancingCharges: '0', lossesBroughtForward: '10000.00', lossCarriedBackFromFollowing: '0', carryBack: '0', rates: rates([2026, 2027]) };

describe('the Corporation Tax computation (V4-M4, DEC-101)', () => {
  it('splits a period into financial years by days', () => {
    expect(financialYearParts('2027-01-01', '2027-12-31')).toEqual([{ financialYear: 2026, from: '2027-01-01', to: '2027-03-31', days: 90 }, { financialYear: 2027, from: '2027-04-01', to: '2027-12-31', days: 275 }]);
    expect(financialYearParts('2027-04-01', '2028-03-31')).toEqual([{ financialYear: 2027, from: '2027-04-01', to: '2028-03-31', days: 366 }]);
  });
  it('a profitable period across two financial years: losses brought forward, marginal relief in each part (golden A1)', () => {
    const r = computeCorporationTax(A);
    expect(r).toMatchObject({ ...G.expected.A1, financialYears: expect.anything() });
    expect(fy(r)).toEqual(G.expected.A1.financialYears);
  });
  it('a short loss period carries its loss back (golden B), and the earlier period deducts it (golden A2)', () => {
    const b = computeCorporationTax({ startDate: '2028-01-01', endDate: '2028-06-30', days: 182, twelveMonths: false, associatedCompanies: 0, adjustedProfit: '-30000.00', allowances: '8177.53',
      balancingCharges: '0', lossesBroughtForward: '0', lossCarriedBackFromFollowing: '0', carryBack: '38177.53', rates: rates([2027, 2028]) });
    expect(b).toMatchObject({ ...G.expected.B, financialYears: expect.anything() });
    expect(fy(b)).toEqual(G.expected.B.financialYears);
    const a2 = computeCorporationTax({ ...A, lossCarriedBackFromFollowing: '38177.53' });
    expect(a2).toMatchObject({ ...G.expected.A2, financialYears: expect.anything() });
    expect(fy(a2)).toEqual(G.expected.A2.financialYears);
    expect(() => computeCorporationTax({ ...A, carryBack: '1.00' })).toThrow(/at most the period's trading loss/);
  });
  it('associated companies divide the limits; profits at or under the lower limit use the small profits rate; above the upper, the main rate', () => {
    const one = (adjusted: string, associated: number) => computeCorporationTax({ ...A, startDate: '2027-04-01', endDate: '2028-03-31', days: 366, adjustedProfit: adjusted, allowances: '0', lossesBroughtForward: '0', associatedCompanies: associated, rates: rates([2027]) });
    expect(one('50000.00', 0).financialYears[0]).toMatchObject({ basis: 'SMALL_PROFITS_RATE', tax: '9500.00' });
    expect(one('50000.00', 1).financialYears[0]).toMatchObject({ lowerLimit: '25000.00', upperLimit: '125000.00', basis: 'MARGINAL_RELIEF', taxAtRate: '12500.00', marginalRelief: '1125.00', tax: '11375.00' });
    expect(one('250000.00', 0).financialYears[0]).toMatchObject({ basis: 'MAIN_RATE', tax: '62500.00' });
    expect(one('0', 0).corporationTax).toBe('0.00');
  });
  it('a trading loss with nothing carried back is carried forward with unused losses brought forward', () => {
    const r = computeCorporationTax({ ...A, adjustedProfit: '1000.00', allowances: '6000.00', lossesBroughtForward: '2500.00' });
    expect(r).toMatchObject({ tradingLoss: '5000.00', lossesBroughtForwardUsed: '0.00', taxableTotalProfits: '0.00', lossesCarriedForward: '7500.00', corporationTax: '0.00' });
  });
});
