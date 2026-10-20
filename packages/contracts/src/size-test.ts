import { z } from 'zod';
import { ruleSourceSchema } from './vat';

/**
 * V2-M5b (DEC-066): the size test. Company-law size thresholds are organisation data in effective-dated threshold sets, each with a source,
 * UNVERIFIED until a second person holding `accounts:rule-verify` verifies it (DEC-052). No threshold is defined here or anywhere in the code.
 */
export const SIZE_CLASSES = ['MICRO', 'SMALL', 'MEDIUM'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];
/** The values of the earliest framework year's facts about the preceding year (v2-plan 5f.2 step 4). */
export const PRIOR_MET_VALUES = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE'] as const;
export const PRIOR_STATUS_VALUES = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'FIRST_YEAR'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
/** A positive amount with up to 4 decimals and 12 integer digits. */
const amount = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A positive amount such as 632000.00').refine((s) => Number(s) > 0, 'Must be more than zero');
const employees = z.number().int().min(1).max(10000000);
const classLimits = z.object({ turnover: amount, balanceSheetTotal: amount, employees }).strict();
export const thresholdLimitsSchema = z.object({ MICRO: classLimits, SMALL: classLimits, MEDIUM: classLimits }).strict();
export type ThresholdLimits = z.infer<typeof thresholdLimitsSchema>;

/** Nested limits (micro <= small <= medium for every measure); the database repeats the rule. Returns the problems. */
export function limitProblems(l: ThresholdLimits): string[] {
  const p: string[] = [];
  for (const m of ['turnover', 'balanceSheetTotal', 'employees'] as const)
    for (const [a, b] of [['MICRO', 'SMALL'], ['SMALL', 'MEDIUM']] as const)
      if (Number(l[a][m]) > Number(l[b][m])) p.push(`The ${a.toLowerCase()} ${m} limit is above the ${b.toLowerCase()} one`);
  return p;
}
const datesInOrder = (r: { effectiveFrom?: string; effectiveTo?: string | null }) => !r.effectiveTo || !r.effectiveFrom || r.effectiveTo >= r.effectiveFrom;
const setFields = {
  label: z.string().trim().min(1).max(100),
  /** The financial years governed, by the date a year begins; both inclusive, open-ended without effectiveTo. */
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  /** For the first year it governs, the preceding year is tested against this set too (a transitional rule, read from the instrument). */
  priorYearOnFirst: z.boolean().default(false),
  limits: thresholdLimitsSchema,
  source: ruleSourceSchema,
  notes: z.string().trim().max(5000).nullable().optional(),
};
const nested = (v: { limits?: ThresholdLimits }) => !v.limits || limitProblems(v.limits).length === 0;
export const createThresholdSetSchema = z.object(setFields).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] })
  .refine(nested, { message: 'Limits are nested: micro <= small <= medium for each measure', path: ['limits'] });
export const updateThresholdSetSchema = z.object({
  label: setFields.label.optional(), effectiveFrom: isoDate.optional(), effectiveTo: setFields.effectiveTo, priorYearOnFirst: z.boolean().optional(),
  limits: thresholdLimitsSchema.optional(), source: ruleSourceSchema.optional(), notes: setFields.notes,
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change').refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] })
  .refine(nested, { message: 'Limits are nested: micro <= small <= medium for each measure', path: ['limits'] });
/** A change to a verified set: the new set in full and why. The old set is marked SUPERSEDED. */
export const supersedeThresholdSetSchema = z.object({ ...setFields, reason: z.string().trim().min(10).max(1000) }).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] })
  .refine(nested, { message: 'Limits are nested: micro <= small <= medium for each measure', path: ['limits'] });
export const verifyThresholdSetSchema = z.object({ /** What was checked and against what. */ notes: z.string().trim().min(10).max(1000) }).strict();
export const sizeTestQuerySchema = z.object({ yearStart: isoDate }).strict();
