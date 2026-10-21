import { z } from 'zod';

/**
 * V2-M6a (DEC-068): review flags and the review checklist. The nine controls of the V2 specification are raised live from the ledger, the
 * registers and the documents; the firm's settings are versioned data, never legal values; each flag is explained by a preparer and signed off
 * by a second person holding accounts:review.
 */
export const REVIEW_CONTROLS = {
  'RC-01': 'Unexplained movements', 'RC-02': 'Material changes', 'RC-03': 'Unusual balances', 'RC-04': 'Negative balances', 'RC-05': 'Old receivables and payables',
  'RC-06': 'Director loan movements', 'RC-07': 'Suspense', 'RC-08': 'Unreconciled bank', 'RC-09': 'Missing supporting evidence',
} as const;
export type ReviewControl = keyof typeof REVIEW_CONTROLS;
export const REVIEW_CONTROL_CODES = Object.keys(REVIEW_CONTROLS) as ReviewControl[];
export const REVIEW_ACTIONS = ['EXPLAIN', 'SIGN_OFF', 'REOPEN'] as const;
export const OLD_ITEM_DAYS = [30, 60, 90] as const;
/** The flag key: control, subject type, subject id (v2-plan 5h). */
export const FLAG_KEY = /^RC-0[1-9]:[a-z_]+:[A-Za-z0-9_.:-]{1,200}$/;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A positive amount').refine((s) => Number(s) > 0, 'Must be more than zero');
/** A change of the firm's review settings; a setting left out (or null) is not set, and its controls are not evaluated. */
export const setReviewSettingsSchema = z.object({
  unexplainedAmount: amount.nullable().optional(),
  materialAmount: amount.nullable().optional(),
  materialPercent: z.string().trim().regex(/^\d{1,5}(\.\d{1,2})?$/, 'A percentage such as 20 or 12.5').nullable().optional(),
  oldItemDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).nullable().optional(),
  evidenceAmount: amount.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const reviewChecklistQuerySchema = z.object({ yearStart: isoDate }).strict();
const flagKey = z.string().regex(FLAG_KEY, 'A flag key from the checklist');
export const explainReviewFlagSchema = z.object({ yearStart: isoDate, flagKey, note: z.string().trim().min(3).max(2000) }).strict();
export const signOffReviewFlagSchema = z.object({ yearStart: isoDate, flagKey, note: z.string().trim().min(3).max(2000).optional() }).strict();
export const reopenReviewFlagSchema = z.object({ yearStart: isoDate, flagKey, note: z.string().trim().min(3).max(2000) }).strict();
