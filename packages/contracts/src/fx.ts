import { z } from 'zod';
import { rateString } from './ledger';

/**
 * V1-M3 foreign-currency contracts (ADR-50, ADR-55; DEC-016..018): exchange-rate and revaluation request schemas and the registries the
 * accounting package reads. Rates and amounts are decimal STRINGS, never JSON numbers.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const ccy = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case');
const uuid = z.string().uuid();

export const RATE_KINDS = ['DAILY', 'PERIOD'] as const;
export type RateKind = (typeof RATE_KINDS)[number];
export const RATE_SOURCE_KINDS = ['MANUAL', 'IMPORT'] as const;
export const RATE_VERIFICATION = ['UNVERIFIED', 'VERIFIED'] as const;
/** DEC-016: a missing daily rate falls back to the latest earlier one within this many days, then the posting is refused. */
export const RATE_LOOKUP_WINDOW_DAYS = 7;
/** DEC-017: rates are stored to 8 decimal places and never rounded. */
export const RATE_DECIMALS = 8;
export const MANUAL_PUBLISHER = 'MANUAL';
export const MAX_RATE_IMPORT_BYTES = 1_000_000;
export const MAX_RATE_IMPORT_ROWS = 5000;
/** DEC-018: only monetary items are revalued (cash, bank, receivables, payables, accruals, other liabilities, long-term liabilities). */
export const MONETARY_SUBTYPES = ['CURRENT_ASSET_RECEIVABLE', 'CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH', 'CURRENT_LIABILITY_PAYABLE', 'CURRENT_LIABILITY_ACCRUAL', 'CURRENT_LIABILITY_OTHER', 'LONG_TERM_LIABILITY'] as const;

export const createExchangeRateSchema = z.object({
  fromCurrency: ccy, toCurrency: ccy.optional(), kind: z.enum(RATE_KINDS).default('DAILY'),
  validFrom: isoDate, validTo: isoDate.optional(), rate: rateString,
  /** Where the number came from. Mandatory: an unexplained rate is not evidence. */
  source: z.string().trim().min(3).max(500),
}).strict().superRefine((b, c) => {
  if (b.kind === 'DAILY' && b.validTo && b.validTo !== b.validFrom) c.addIssue({ code: 'custom', path: ['validTo'], message: 'A DAILY rate applies on one date' });
  if (b.kind === 'PERIOD' && (!b.validTo || b.validTo < b.validFrom)) c.addIssue({ code: 'custom', path: ['validTo'], message: 'A PERIOD rate needs validTo on or after validFrom' });
  if (b.toCurrency && b.toCurrency === b.fromCurrency) c.addIssue({ code: 'custom', path: ['toCurrency'], message: 'from and to currencies differ' });
});
export const supersedeExchangeRateSchema = z.object({ rate: rateString, source: z.string().trim().min(3).max(500), reason: z.string().trim().min(20).max(1000) }).strict();
export const verifyExchangeRateSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
export const importExchangeRatesSchema = z.object({
  publisher: z.string().trim().min(1).max(100), series: z.string().trim().min(1).max(100).optional(), sourceUrl: z.string().trim().url().max(500).optional(),
  /** When the file was obtained from the publisher. */
  retrievedAt: z.string().datetime(), toCurrency: ccy.optional(), kind: z.enum(RATE_KINDS).default('DAILY'),
  /** Header `from,to,valid_from,valid_to,rate`; `to` and `valid_to` may be blank (company currency / the same day). */
  csv: z.string().min(1).max(MAX_RATE_IMPORT_BYTES),
}).strict();
export const rateListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(100).optional(),
  from: ccy.optional(), asOf: isoDate.optional(), includeSuperseded: z.coerce.boolean().default(false),
}).strict();
export const fxSettingsSchema = z.object({
  roundingAccountId: uuid.nullable(), realisedAccountId: uuid.nullable(), unrealisedAccountId: uuid.nullable(),
  /** Currency code -> the series this company uses for it. `publisher: "MANUAL"` means manual rates only. */
  defaultSeries: z.record(ccy, z.object({ publisher: z.string().trim().min(1).max(100), series: z.string().trim().min(1).max(100).nullable().default(null) }).strict()).default({}),
  reason: z.string().trim().min(20).max(1000),
}).strict();
export const revaluationSchema = z.object({
  /** Currency -> rate id to use as the closing rate. Omitted currencies are looked up for the period end date. */
  rates: z.record(ccy, uuid).default({}),
}).strict();
export const revaluationRunListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(100).optional(), periodId: uuid.optional() }).strict();

