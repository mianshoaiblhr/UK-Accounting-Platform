import { z } from 'zod';

/**
 * V4-M1 (DEC-097): Corporation Tax rules, the tax profile and CT accounting periods. Every rate, limit and the longest a CT accounting period may
 * run are data: a rule version with its source, UNVERIFIED until a different person verifies it (the DEC-021 pattern). Nothing of the tax law is
 * written here except the shape each kind of rule takes.
 */
export const CT_RULE_KINDS = ['CT_RATES', 'PERIOD_MAX_MONTHS'] as const;
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
function endAfterMonths(start: string, months: number): string {
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
