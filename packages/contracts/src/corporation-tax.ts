import { z } from 'zod';

/**
 * V4-M1 (DEC-097): Corporation Tax rules, the tax profile and CT accounting periods. Every rate, limit and the longest a CT accounting period may
 * run are data: a rule version with its source, UNVERIFIED until a different person verifies it (the DEC-021 pattern). Nothing of the tax law is
 * written here except the shape each kind of rule takes.
 */
export const CT_RULE_KINDS = ['CT_RATES', 'PERIOD_MAX_MONTHS', 'AIA_LIMIT', 'WDA_RATES', 'SMALL_POOL_LIMIT', 'CT600_FORM'] as const;
/** V4-M5 (DEC-102): the canonical CT600 fields (DEC-101), each of which the verified CT600_FORM rule may map to a box. */
const FY_FIELDS = ['financialYear', 'profit', 'rate', 'taxAtRate', 'marginalRelief'] as const;
export const CT600_FIELDS = [
  'turnover', 'tradingProfits', 'tradingLossesBroughtForwardUsed', 'netTradingProfits', 'nonTradingLoanRelationships', 'propertyIncome', 'chargeableGains',
  'lossCarriedBackFromLaterPeriod', 'taxableTotalProfits', 'associatedCompanies', ...FY_FIELDS.map((f) => `fy1.${f}`), ...FY_FIELDS.map((f) => `fy2.${f}`),
  'corporationTaxAtRates', 'marginalReliefTotal', 'corporationTaxChargeable', 'taxPayable', 'losses.tradingLossOfPeriod', 'losses.carriedBack', 'losses.carriedForward',
] as const;
export type CtRuleKind = (typeof CT_RULE_KINDS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'A percentage, e.g. 25 or 19.5').refine((v) => Number(v) <= 100, 'At most 100');
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount in pounds, e.g. 50000');

/** The parameters each kind of rule takes. */
export const CT_RULE_PARAMETERS = {
  CT_RATES: z.object({
    mainRate: percent, smallProfitsRate: percent, lowerLimit: amount, upperLimit: amount,
    marginalReliefFraction: z.object({ numerator: z.number().int().min(0).max(1000), denominator: z.number().int().min(1).max(100000) }).strict(),
  }).strict().refine((p) => Number(p.lowerLimit) < Number(p.upperLimit), { message: 'The lower limit is below the upper limit', path: ['upperLimit'] })
    .refine((p) => Number(p.smallProfitsRate) <= Number(p.mainRate), { message: 'The small profits rate is not above the main rate', path: ['smallProfitsRate'] }),
  PERIOD_MAX_MONTHS: z.object({ months: z.number().int().min(1).max(24) }).strict(),
  // V4-M3 (DEC-100): capital allowances
  AIA_LIMIT: z.object({ annualLimit: amount }).strict(),
  WDA_RATES: z.object({ mainRate: percent, specialRate: percent }).strict(),
  SMALL_POOL_LIMIT: z.object({ limit: amount }).strict(),
  // V4-M5 (DEC-102): the form's box for each canonical field
  CT600_FORM: z.object({ formVersion: z.string().trim().min(2).max(60), boxes: z.record(z.number().int().min(1).max(9999)) }).strict()
    .refine((p) => Object.keys(p.boxes).every((k) => (CT600_FIELDS as readonly string[]).includes(k)), { message: 'Every box maps a canonical CT600 field', path: ['boxes'] })
    .refine((p) => new Set(Object.values(p.boxes)).size === Object.values(p.boxes).length, { message: 'A box is used once', path: ['boxes'] }),
} as const satisfies Record<CtRuleKind, z.ZodTypeAny>;

const source = z.object({ url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//.test(u), 'An http(s) link'), provision: z.string().trim().min(3).max(300), retrievedOn: isoDate }).strict();
const withParameters = <T extends z.ZodTypeAny>(s: T) => s.superRefine((v: { kind: CtRuleKind; parameters: unknown; effectiveFrom: string; effectiveTo?: string }, ctx) => {
  const r = CT_RULE_PARAMETERS[v.kind].safeParse(v.parameters);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: ['parameters', ...i.path] });
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The end is on or after the start', path: ['effectiveTo'] });
});
export const createCtRuleSchema = withParameters(z.object({ kind: z.enum(CT_RULE_KINDS), effectiveFrom: isoDate, effectiveTo: isoDate.optional(), parameters: z.unknown(), source }).strict());
export const supersedeCtRuleSchema = withParameters(z.object({ kind: z.enum(CT_RULE_KINDS), effectiveFrom: isoDate, effectiveTo: isoDate.optional(), parameters: z.unknown(), source,
  reason: z.string().trim().min(10).max(1000) }).strict());
export const verifyCtRuleSchema = z.object({ notes: z.string().trim().min(10).max(2000), evidenceDocumentId: z.string().uuid().optional() }).strict();
export const ctRuleListQuerySchema = z.object({ kind: z.enum(CT_RULE_KINDS).optional(), includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();

/** The company's Unique Taxpayer Reference: 10 digits, checked for its form only. */
export const taxProfileSchema = z.object({ utr: z.string().trim().regex(/^\d{10}$/, 'A UTR: 10 digits').nullable(), reason: z.string().trim().min(10).max(1000) }).strict();
export const deriveCtPeriodsSchema = z.object({ yearStart: isoDate }).strict();
export const associatedCompaniesSchema = z.object({ associatedCompanies: z.number().int().min(0).max(10000), reason: z.string().trim().min(10).max(1000) }).strict();

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The day before the same day `months` months later (a month-end start keeps to month ends: 31 Jan + 1 month - 1 day = 27/28 Feb). */
export function endAfterMonths(start: string, months: number): string {
  const d = day(start), y = d.getUTCFullYear(), m = d.getUTCMonth() + months, dd = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(y, m, Math.min(dd, last)));
  next.setUTCDate(next.getUTCDate() - 1);
  return iso(next);
}

/**
 * The CT accounting periods of an accounts year (DEC-097): one period when the year is no longer than `maxMonths`; otherwise consecutive periods
 * of `maxMonths` months from the year's start, and the remainder. `maxMonths` is the verified rule's figure, never a constant here.
 */
export function splitCtPeriods(start: string, end: string, maxMonths: number): { start: string; end: string }[] {
  if (end < start) throw new Error('The year ends before it starts');
  const out: { start: string; end: string }[] = [];
  let s = start;
  while (s <= end) {
    const cap = endAfterMonths(s, maxMonths);
    const e = cap < end ? cap : end;
    out.push({ start: s, end: e });
    const n = day(e); n.setUTCDate(n.getUTCDate() + 1); s = iso(n);
  }
  return out;
}

// ───── V4-M2 (DEC-099): tax adjustments ─────
export const CT_ADJUSTMENT_CATEGORIES = ['DISALLOWABLE', 'DEPRECIATION', 'ENTERTAINING', 'PROVISION', 'LEGAL_PROFESSIONAL', 'NON_TAXABLE_INCOME', 'OTHER'] as const;
export type CtAdjustmentCategory = (typeof CT_ADJUSTMENT_CATEGORIES)[number];
const reason = z.string().trim().min(10).max(1000);
const rulePercent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percentage, e.g. 100 or 50').refine((v) => Number(v) > 0 && Number(v) <= 100, 'Above 0 and at most 100');
const ruleFields = {
  category: z.enum(CT_ADJUSTMENT_CATEGORIES), percentage: rulePercent, effectiveFrom: isoDate, effectiveTo: isoDate.optional(),
  provision: z.string().trim().min(3).max(300).optional().describe('The provision relied on, e.g. CTA 2009 s 1298'), reason,
};
const datesInOrder = (v: { effectiveFrom: string; effectiveTo?: string }) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom;
export const createCtAdjustmentRuleSchema = z.object({ accountId: z.string().uuid(), ...ruleFields }).strict().refine(datesInOrder, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const supersedeCtAdjustmentRuleSchema = z.object(ruleFields).strict().refine(datesInOrder, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const verifyCtAdjustmentRuleSchema = z.object({ notes: z.string().trim().min(10).max(2000) }).strict();
export const ctAdjustmentRuleListQuerySchema = z.object({ accountId: z.string().uuid().optional(), includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();
export const createCtAdjustmentSchema = z.object({
  category: z.enum(CT_ADJUSTMENT_CATEGORIES), direction: z.enum(['ADD', 'DEDUCT']),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount, e.g. 1250.00').refine((v) => Number(v) > 0, 'Above 0'),
  description: z.string().trim().min(5).max(500), evidenceDocumentId: z.string().uuid(),
}).strict();
export const withdrawCtAdjustmentSchema = z.object({ reason }).strict();

/** The adjustment an account rule makes: (debits - credits) x percentage / 100, half-up to `minor` places; positive is added to profit. */
export function ruleAdjustment(debits: string, credits: string, percentage: string, minor = 2): string {
  const scale = 10n ** BigInt(minor);
  const toUnits = (s: string, places: number) => { const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i! + f.padEnd(places, '0').slice(0, places)); return s.startsWith('-') ? -v : v; };
  const net = toUnits(debits, minor) - toUnits(credits, minor);             // minor units
  const pct = toUnits(percentage, 2);                                       // hundredths of a percent
  const num = net * pct, den = 10000n;                                      // net x pct / 100 / 100
  const q = num / den, r = num % den;
  const rounded = (r < 0n ? -r : r) * 2n >= den ? q + (num < 0n ? -1n : 1n) : q;   // half away from zero
  const neg = rounded < 0n, abs = neg ? -rounded : rounded;
  const whole = abs / scale, frac = (abs % scale).toString().padStart(minor, '0');
  return `${neg ? '-' : ''}${whole}${minor ? `.${frac}` : ''}`;
}

// ───── V4-M5 (DEC-102): the CT return ─────
export const CT_RETURN_STATUSES = ['DRAFT', 'VALIDATED', 'AUTHORISED', 'SUBMITTED', 'ACCEPTED', 'REJECTED'] as const;
const ctNote = z.string().trim().min(1).max(2000);
export const createCtReturnSchema = z.object({ computationId: z.string().uuid() }).strict();
export const ctReturnStepSchema = z.object({ note: ctNote.optional() }).strict();
export const authoriseCtReturnSchema = z.object({ directorContactId: z.string().uuid(), declaredOn: isoDate, evidenceDocumentId: z.string().uuid(), note: ctNote.optional() }).strict();
export const recordCtReturnSchema = z.object({ reference: z.string().trim().min(3).max(60), acceptedOn: isoDate, evidenceDocumentId: z.string().uuid(), note: ctNote.optional() }).strict();
/** The keys a CT-COMP taxonomy version maps (FACT entries): `ct.<canonical field>`. */
export const CT_IXBRL_KEYS = CT600_FIELDS.map((f) => `ct.${f}`);
