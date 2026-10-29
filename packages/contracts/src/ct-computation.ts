import { z } from 'zod';

/**
 * V4-M4 (DEC-101): the Corporation Tax computation of one CT period as a pure function over pennies (bigint). Every rate, limit and fraction
 * comes from verified CT_RATES rules, one per financial year the period falls in; the adjusted profit, allowances and losses from V4-M2, V4-M3
 * and the neighbouring periods' approved computations.
 */
export interface CtRates { ruleId: string; mainRate: string; smallProfitsRate: string; lowerLimit: string; upperLimit: string; marginalReliefFraction: { numerator: number; denominator: number } }
export interface CtComputationInput {
  startDate: string; endDate: string; days: number; twelveMonths: boolean; associatedCompanies: number;
  adjustedProfit: string; allowances: string; balancingCharges: string;
  lossesBroughtForward: string; lossCarriedBackFromFollowing: string; carryBack: string;
  /** The rates of each financial year part, keyed by the financial year (the calendar year it starts in). */
  rates: Record<number, CtRates>;
}

const units = (s: string, places = 2) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i! + f.padEnd(places, '0').slice(0, places)); return neg ? -v : v; };
const pounds = (p: bigint) => { const neg = p < 0n, a = neg ? -p : p; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
const div = (num: bigint, den: bigint) => { const q = num / den; return (num % den) * 2n >= den ? q + 1n : q; };   // half-up, non-negative
const max0 = (a: bigint) => (a > 0n ? a : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** The financial-year parts of a period: FY n runs 1 April n to 31 March n+1. */
export function financialYearParts(start: string, end: string): { financialYear: number; from: string; to: string; days: number }[] {
  const out: { financialYear: number; from: string; to: string; days: number }[] = [];
  let s = start;
  while (s <= end) {
    const d = day(s), fy = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const fyEnd = `${fy + 1}-03-31`, e = fyEnd < end ? fyEnd : end;
    out.push({ financialYear: fy, from: s, to: e, days: Math.round((day(e).getTime() - day(s).getTime()) / 86_400_000) + 1 });
    const n = day(e); n.setUTCDate(n.getUTCDate() + 1); s = iso(n);
  }
  return out;
}

export function computeCorporationTax(i: CtComputationInput) {
  const adjusted = units(i.adjustedProfit), allowances = units(i.allowances), charges = units(i.balancingCharges);
  const beforeLosses = adjusted - allowances + charges;
  const tradingProfit = max0(beforeLosses), tradingLoss = max0(-beforeLosses);
  const bf = units(i.lossesBroughtForward), bfUsed = min(bf, tradingProfit);
  const profitsBeforeCarryBack = tradingProfit - bfUsed;
  const carriedBackIn = min(units(i.lossCarriedBackFromFollowing), profitsBeforeCarryBack);
  const ttp = profitsBeforeCarryBack - carriedBackIn;
  const carryBack = units(i.carryBack);
  if (carryBack < 0n || carryBack > tradingLoss) throw new Error('A carry-back claim is at most the period\'s trading loss');
  const lossesCarriedForward = bf - bfUsed + tradingLoss - carryBack;

  const parts = financialYearParts(i.startDate, i.endDate);
  const period = BigInt(i.days), share = BigInt(i.associatedCompanies + 1);
  let left = ttp;
  const years = parts.map((p, k) => {
    const r = i.rates[p.financialYear];
    if (!r) throw new Error(`No rates for financial year ${p.financialYear}`);
    const profit = k < parts.length - 1 ? div(ttp * BigInt(p.days), period) : left;
    left -= profit;
    // limits: annual x (days of the part / days of the period when 12 months, else / 365) / (1 + associated companies)
    const base = i.twelveMonths ? period : 365n;
    const limit = (annual: string) => div(units(annual) * BigInt(p.days), base * share);
    const lower = limit(r.lowerLimit), upper = limit(r.upperLimit);
    const pct = (rate: string) => div(profit * units(rate, 4), 1_000_000n);
    let basis: 'SMALL_PROFITS_RATE' | 'MAIN_RATE' | 'MARGINAL_RELIEF', gross: bigint, relief = 0n;
    if (profit <= lower) { basis = 'SMALL_PROFITS_RATE'; gross = pct(r.smallProfitsRate); }
    else if (profit >= upper) { basis = 'MAIN_RATE'; gross = pct(r.mainRate); }
    else { basis = 'MARGINAL_RELIEF'; gross = pct(r.mainRate); relief = div(BigInt(r.marginalReliefFraction.numerator) * (upper - profit), BigInt(r.marginalReliefFraction.denominator)); }
    return { financialYear: p.financialYear, from: p.from, to: p.to, days: p.days, ruleId: r.ruleId, profit: pounds(profit), lowerLimit: pounds(lower), upperLimit: pounds(upper), basis,
      rate: basis === 'SMALL_PROFITS_RATE' ? r.smallProfitsRate : r.mainRate, taxAtRate: pounds(gross), marginalRelief: pounds(relief), tax: pounds(gross - relief), _tax: gross - relief };
  });
  const corporationTax = years.reduce((t, y) => t + y._tax, 0n);
  return {
    adjustedProfit: pounds(adjusted), allowances: pounds(allowances), balancingCharges: pounds(charges),
    tradingProfit: pounds(tradingProfit), tradingLoss: pounds(tradingLoss), lossesBroughtForward: pounds(bf), lossesBroughtForwardUsed: pounds(bfUsed),
    profitsBeforeCarryBack: pounds(profitsBeforeCarryBack), lossCarriedBackFromFollowing: pounds(carriedBackIn), taxableTotalProfits: pounds(ttp),
    carryBack: pounds(carryBack), lossesCarriedForward: pounds(lossesCarriedForward), associatedCompanies: i.associatedCompanies,
    financialYears: years.map(({ _tax, ...y }) => y), corporationTax: pounds(corporationTax),
  };
}
export type CtComputationResult = ReturnType<typeof computeCorporationTax>;

const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount, e.g. 1250.00');
export const ctComputationQuerySchema = z.object({ carryBack: amount.optional() }).strict();
export const prepareCtComputationSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), carryBack: amount.optional() }).strict();
export const approveCtComputationSchema = z.object({ notes: z.string().trim().min(10).max(2000) }).strict();
export const createLossOpeningSchema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount, evidenceDocumentId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) }).strict();
export const supersedeLossOpeningSchema = z.object({ amount, evidenceDocumentId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) }).strict();
export const verifyLossOpeningSchema = z.object({ notes: z.string().trim().min(10).max(2000) }).strict();
