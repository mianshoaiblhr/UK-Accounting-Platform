import { z } from 'zod';

/**
 * V1-M4b VAT foundation contracts (DEC-010, DEC-021, DEC-022, DEC-025; ADR-51). The platform ships NO VAT rate or rule figures: a firm enters its codes
 * and rates with their official source, and a different person holding `tax:rule-verify` verifies each rate version before it can be used.
 * Amounts and rates are decimal STRINGS. This is standard VAT accounting only; the scheme is a separate concept.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const uuid = z.string().uuid();

export const VAT_TREATMENTS = ['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];
export const VAT_DIRECTIONS = ['SALES', 'PURCHASES', 'BOTH'] as const;
export type VatDirection = (typeof VAT_DIRECTIONS)[number];
/** The VAT accounting scheme is NOT encoded in codes or rates (DEC-010). Only STANDARD is implemented; the others are registered and refused. */
export const VAT_SCHEMES: Record<string, { implemented: boolean; description: string }> = {
  STANDARD: { implemented: true, description: 'Standard (invoice-based) VAT accounting' },
  CASH: { implemented: false, description: 'Cash accounting scheme - deferred (DEC-010)' },
  FLAT_RATE: { implemented: false, description: 'Flat Rate Scheme - deferred (DEC-010)' },
};
export const VAT_SCHEME_CODES = Object.keys(VAT_SCHEMES) as [string, ...string[]];
/** Return boxes of the nine-box return. Which box a code's net and VAT amounts feed is part of each VERIFIED rate version. */
export const VAT_BOXES = [1, 2, 4, 6, 7, 8, 9] as const;
export const VAT_NET_BOXES = [6, 7, 8, 9] as const;
export const VAT_VAT_BOXES = [1, 2, 4] as const;
/** DEC-025: VAT is computed per line, rounded half-up to the currency's minor units (the rounding rule itself is UNVERIFIED against HMRC guidance). */
export const VAT_ROUNDING = 'PER_LINE_HALF_UP' as const;

/** A percentage with at most 4 decimals, 0 to 100, as a string. */
export const vatPercent = z.string().regex(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, 'A percentage from 0 to 100 with at most 4 decimals, as a string');

export const createTaxCodeSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, 'Upper-case letters, digits, _ and - (max 16)'),
  name: z.string().trim().min(1).max(120),
  treatment: z.enum(VAT_TREATMENTS), direction: z.enum(VAT_DIRECTIONS),
  /** Purchases only: the customer accounts for the supplier's VAT (output and input VAT of equal amounts). The applicable cases are verified per rate (DEC-021). */
  reverseCharge: z.boolean().default(false),
}).strict().refine((c) => !c.reverseCharge || c.direction === 'PURCHASES', { message: 'Reverse charge applies to purchases', path: ['reverseCharge'] })
  .refine((c) => !c.reverseCharge || ['STANDARD', 'REDUCED'].includes(c.treatment), { message: 'Reverse charge needs a standard or reduced treatment', path: ['reverseCharge'] });

/** Where the official source is: a URL, the instrument and provision, and when it was read. Every rate version carries one (DEC-021). */
export const ruleSourceSchema = z.object({
  url: z.string().trim().url().max(500),
  provision: z.string().trim().min(3).max(300),
  retrievedOn: isoDate,
}).strict();
const taxRateFields = {
  rate: vatPercent, effectiveFrom: isoDate, effectiveTo: isoDate.optional(),
  netBoxes: z.array(z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)])).max(2).default([]),
  vatBoxes: z.array(z.union([z.literal(1), z.literal(2), z.literal(4)])).max(2).default([]),
  source: ruleSourceSchema,
};
const datesInOrder = (r: { effectiveFrom: string; effectiveTo?: string }) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom;
export const createTaxRateSchema = z.object(taxRateFields).strict().refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] });
/** A change of rule: a complete new version plus why it changes. */
export const supersedeTaxRateSchema = z.object({ ...taxRateFields, reason: z.string().trim().min(10).max(1000) }).strict().refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] });
export const verifyTaxRateSchema = z.object({
  /** What was checked and against what. */
  notes: z.string().trim().min(10).max(1000),
  evidenceDocumentId: uuid.optional(),
}).strict();
export const vatSettingsSchema = z.object({
  registered: z.boolean(),
  vrn: z.string().trim().transform((v) => v.replace(/\s/g, '').toUpperCase()).pipe(z.string().regex(/^(GB)?([0-9]{9}|[0-9]{12})$/, 'A UK VAT registration number: 9 or 12 digits, optionally prefixed GB')).nullable().default(null),
  registeredFrom: isoDate.nullable().default(null),
  scheme: z.enum(VAT_SCHEME_CODES).default('STANDARD'),
  /** Return period length in months and the end of one period (the stagger). */
  periodMonths: z.union([z.literal(1), z.literal(3)]).default(3),
  anchorPeriodEnd: isoDate.nullable().default(null),
  outputAccountId: uuid.nullable().default(null), inputAccountId: uuid.nullable().default(null),
  reason: z.string().trim().min(10).max(1000),
}).strict().refine((s) => !s.registered || (s.vrn && s.registeredFrom && s.anchorPeriodEnd && s.outputAccountId && s.inputAccountId), {
  message: 'A registered company needs a VRN, a registration date, a period end and its output and input VAT accounts', path: ['registered'],
});
export const vatWorkpaperQuerySchema = z.object({ from: isoDate, to: isoDate }).strict().refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] });
export const taxCodeListQuerySchema = z.object({ includeRates: z.coerce.boolean().default(true) }).strict();
