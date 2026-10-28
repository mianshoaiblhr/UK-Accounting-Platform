import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCapitalAllowances, createPoolOpeningSchema, type CaInput } from './capital-allowances';

/** V4-M3 (DEC-100): the arithmetic against the hand-worked golden of two periods (tests/golden/v4-m3-capital-allowances.json). */
const G = JSON.parse(readFileSync(resolve(__dirname, '../../../tests/golden/v4-m3-capital-allowances.json'), 'utf8'));
const asset = (k: string) => { const a = G.assets.find((x: { key: string }) => x.key === k); return { assetId: k, number: G.assets.indexOf(a) + 1, description: a.description, category: a.category, cost: a.cost, acquiredOn: a.acquiredOn }; };
const inPeriod = (d: string, y: { yearStart: string; yearEnd: string }) => d >= y.yearStart && d <= y.yearEnd;
const input = (n: number, openings: CaInput['openings']): CaInput => {
  const y = G.years[n];
  return { days: n === 0 ? 365 : 182, twelveMonths: n === 0, ...G.rules, openings,
    additions: G.assets.filter((a: { acquiredOn: string }) => inPeriod(a.acquiredOn, y)).map((a: { key: string }) => asset(a.key)),
    disposals: G.disposals.filter((x: { disposedOn: string }) => inPeriod(x.disposedOn, y)).map((x: { asset: string; disposedOn: string; proceeds: string }) => ({ ...asset(x.asset), disposedOn: x.disposedOn, proceeds: x.proceeds })) };
};
const shape = (r: ReturnType<typeof computeCapitalAllowances>) => ({
  fraction: r.fraction, aia: { available: r.aia.available, claims: r.aia.claims.map((c) => [c.assetId, c.aia, c.toMainPool]) },
  pools: r.pools.map((p) => [p.pool, p.assetId, p.opening, p.additions, p.disposals, p.writingDownAllowance, p.balancingAllowance, p.balancingCharge, p.closing]), totals: r.totals,
});

describe('capital allowances (V4-M3, DEC-100)', () => {
  let first: ReturnType<typeof computeCapitalAllowances>;
  it('a 12-month period: AIA in date order with the excess to the main pool, pools, a disposal capped at cost, a single asset pool closed with a balancing allowance', () => {
    first = computeCapitalAllowances(input(0, { MAIN: G.openings.MAIN, SPECIAL_RATE: G.openings.SPECIAL_RATE, single: G.openings.single.map((s: { asset: string; amount: string }) => ({ assetId: s.asset, amount: s.amount })) }));
    expect(shape(first)).toEqual(G.expected[0]);
    expect(first.disposals.find((d) => d.assetId === 'D1')).toMatchObject({ pool: 'MAIN', disposalValue: '2500.00' });
  });
  it('a 182-day period opens from the first: a pro-rata AIA, a small pool, a balancing charge', () => {
    const open = (pool: string, assetId: string | null = null) => first.pools.find((p) => p.pool === pool && p.assetId === assetId && p.closing !== '0.00')?.closing ?? '0.00';
    const r = computeCapitalAllowances(input(1, { MAIN: open('MAIN'), SPECIAL_RATE: open('SPECIAL_RATE'), single: [{ assetId: 'A5', amount: open('SINGLE_ASSET', 'A5') }] }));
    expect(shape(r)).toEqual(G.expected[1]);
    expect(r.pools.find((p) => p.pool === 'SPECIAL_RATE')!.smallPool).toBe(true);
    expect(r.smallPoolLimit).toBe('498.63');
  });
  it('a negative pool is a balancing charge; nothing is claimed on an empty pool', () => {
    const r = computeCapitalAllowances({ days: 365, twelveMonths: true, aiaLimit: '0', mainRate: '18', specialRate: '6', smallPoolLimit: '0', openings: { MAIN: '100.00', SPECIAL_RATE: '0', single: [] },
      additions: [], disposals: [{ assetId: 'x', number: 1, description: 'x', category: 'MAIN_POOL', cost: '500.00', proceeds: '400.00', disposedOn: '2027-01-02' }] });
    expect(r.pools.map((p) => [p.pool, p.writingDownAllowance, p.balancingCharge, p.closing])).toEqual([['MAIN', '0.00', '300.00', '0.00'], ['SPECIAL_RATE', '0.00', '0.00', '0.00']]);
    expect(r.totals.balancingCharges).toBe('300.00');
  });
  it('an opening names its asset exactly when it is a single asset pool', () => {
    const o = { pool: 'MAIN', asOf: '2026-12-31', amount: '1.00', evidenceDocumentId: '00000000-0000-4000-8000-000000000001', reason: 'From the last computation' };
    expect(createPoolOpeningSchema.safeParse(o).success).toBe(true);
    expect(createPoolOpeningSchema.safeParse({ ...o, assetId: o.evidenceDocumentId }).success).toBe(false);
    expect(createPoolOpeningSchema.safeParse({ ...o, pool: 'SINGLE_ASSET' }).success).toBe(false);
  });
});
