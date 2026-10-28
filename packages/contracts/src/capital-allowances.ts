import { z } from 'zod';

/**
 * V4-M3 (DEC-100): the capital allowances of one CT period, as a pure function over pennies (bigint). The rates and limits come from verified
 * rules; the additions and disposals from the fixed-asset register's tax fields; the openings from verified balances or the prior computation.
 */
export const CA_POOLS = ['MAIN', 'SPECIAL_RATE', 'SINGLE_ASSET'] as const;
export type CaPool = (typeof CA_POOLS)[number];
export interface CaAsset { assetId: string; number: number; description: string; category: string; cost: string }
export interface CaInput {
  /** Days in the period, and whether it is exactly 12 months (fraction 1). */
  days: number; twelveMonths: boolean;
  aiaLimit: string; mainRate: string; specialRate: string; smallPoolLimit: string;
  openings: { MAIN: string; SPECIAL_RATE: string; single: { assetId: string; amount: string }[] };
  additions: (CaAsset & { acquiredOn: string })[];
  disposals: (CaAsset & { disposedOn: string; proceeds: string })[];
}

const units = (s: string, places = 2) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i! + f.padEnd(places, '0').slice(0, places)); return neg ? -v : v; };
const pounds = (p: bigint) => { const neg = p < 0n, a = neg ? -p : p; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
/** num / den rounded half-up (both positive or num zero). */
const div = (num: bigint, den: bigint) => { const q = num / den; return (num % den) * 2n >= den ? q + 1n : q; };
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function computeCapitalAllowances(i: CaInput) {
  const d = BigInt(i.twelveMonths ? 365 : i.days);
  const scale = (p: bigint) => div(p * d, 365n);                               // pennies x fraction
  const wda = (p: bigint, ratePct: string) => div(p * units(ratePct, 4) * d, 100n * 10000n * 365n);   // pennies x rate% (to 4 places) x fraction
  const aiaAvailable = scale(units(i.aiaLimit));
  const smallLimit = scale(units(i.smallPoolLimit));

  // AIA in date order, then by asset number; any excess goes into the main pool
  let aiaLeft = aiaAvailable;
  const aiaClaims = [...i.additions].filter((a) => a.category === 'AIA').sort((a, b) => a.acquiredOn.localeCompare(b.acquiredOn) || a.number - b.number).map((a) => {
    const cost = units(a.cost), aia = min(cost, aiaLeft); aiaLeft -= aia;
    return { assetId: a.assetId, number: a.number, description: a.description, acquiredOn: a.acquiredOn, cost: pounds(cost), aia: pounds(aia), toMainPool: pounds(cost - aia), _excess: cost - aia, _aia: aia };
  });
  const poolOf = (category: string): CaPool | null => (category === 'AIA' || category === 'MAIN_POOL' ? 'MAIN' : category === 'SPECIAL_RATE_POOL' ? 'SPECIAL_RATE' : category === 'SINGLE_ASSET_POOL' ? 'SINGLE_ASSET' : null);
  type Acc = { pool: CaPool; assetId: string | null; opening: bigint; additions: bigint; disposals: bigint; disposed: boolean };
  const pools = new Map<string, Acc>();
  const get = (pool: CaPool, assetId: string | null = null) => { const k = `${pool}:${assetId ?? ''}`; if (!pools.has(k)) pools.set(k, { pool, assetId, opening: 0n, additions: 0n, disposals: 0n, disposed: false }); return pools.get(k)!; };
  get('MAIN').opening = units(i.openings.MAIN);
  get('SPECIAL_RATE').opening = units(i.openings.SPECIAL_RATE);
  for (const o of i.openings.single) get('SINGLE_ASSET', o.assetId).opening = units(o.amount);
  for (const c of aiaClaims) get('MAIN').additions += c._excess;
  for (const a of i.additions) {
    const pool = poolOf(a.category);
    if (a.category === 'AIA' || !pool) continue;
    get(pool, pool === 'SINGLE_ASSET' ? a.assetId : null).additions += units(a.cost);
  }
  const disposals = i.disposals.map((x) => {
    const pool = poolOf(x.category);
    const value = min(units(x.proceeds), units(x.cost));
    if (pool) { const p = get(pool, pool === 'SINGLE_ASSET' ? x.assetId : null); p.disposals += value; if (pool === 'SINGLE_ASSET') p.disposed = true; }
    return { assetId: x.assetId, number: x.number, description: x.description, disposedOn: x.disposedOn, pool, proceeds: pounds(units(x.proceeds)), cost: pounds(units(x.cost)), disposalValue: pounds(pool ? value : 0n) };
  });

  const out = [...pools.values()].sort((a, b) => CA_POOLS.indexOf(a.pool) - CA_POOLS.indexOf(b.pool) || (a.assetId ?? '').localeCompare(b.assetId ?? '')).map((p) => {
    const available = p.opening + p.additions - p.disposals;
    let w = 0n, ba = 0n, bc = 0n, small = false, closing = 0n;
    if (available < 0n) bc = -available;
    else if (p.pool === 'SINGLE_ASSET' && p.disposed) ba = available;
    else if (p.pool !== 'SINGLE_ASSET' && available > 0n && available <= smallLimit) { w = available; small = true; }
    else { w = wda(available, p.pool === 'SPECIAL_RATE' ? i.specialRate : i.mainRate); closing = available - w; }
    return { pool: p.pool, assetId: p.assetId, opening: pounds(p.opening), additions: pounds(p.additions), disposals: pounds(p.disposals), available: pounds(available),
      rate: p.pool === 'SPECIAL_RATE' ? i.specialRate : i.mainRate, writingDownAllowance: pounds(w), smallPool: small, balancingAllowance: pounds(ba), balancingCharge: pounds(bc), closing: pounds(closing),
      _w: w, _ba: ba, _bc: bc };
  });
  const sum = (f: (p: (typeof out)[number]) => bigint) => out.reduce((t, p) => t + f(p), 0n);
  const aiaTotal = aiaClaims.reduce((t, c) => t + c._aia, 0n), wdaTotal = sum((p) => p._w), baTotal = sum((p) => p._ba), bcTotal = sum((p) => p._bc);
  return {
    fraction: i.twelveMonths ? '1' : `${i.days}/365`,
    aia: { limit: pounds(units(i.aiaLimit)), available: pounds(aiaAvailable), claimed: pounds(aiaTotal), claims: aiaClaims.map(({ _excess, _aia, ...c }) => c) },
    smallPoolLimit: pounds(smallLimit),
    pools: out.map(({ _w, _ba, _bc, ...p }) => p),
    disposals,
    totals: { aia: pounds(aiaTotal), writingDownAllowances: pounds(wdaTotal), balancingAllowances: pounds(baTotal), allowances: pounds(aiaTotal + wdaTotal + baTotal), balancingCharges: pounds(bcTotal) },
  };
}
export type CapitalAllowances = ReturnType<typeof computeCapitalAllowances>;

const reason = z.string().trim().min(10).max(1000);
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount, e.g. 1250.00');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const createPoolOpeningSchema = z.object({ pool: z.enum(CA_POOLS), assetId: z.string().uuid().optional(), asOf: isoDate, amount, evidenceDocumentId: z.string().uuid(), reason }).strict()
  .refine((o) => (o.pool === 'SINGLE_ASSET') === (o.assetId !== undefined), { message: 'A single asset pool names its asset, and only it', path: ['assetId'] });
export const supersedePoolOpeningSchema = z.object({ amount, evidenceDocumentId: z.string().uuid(), reason }).strict();
export const verifyPoolOpeningSchema = z.object({ notes: z.string().trim().min(10).max(2000) }).strict();
export const storeCapitalAllowancesSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/).describe('The fingerprint of the computation as read, so a changed register is not stored unseen') }).strict();
export const poolOpeningListQuerySchema = z.object({ includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();
