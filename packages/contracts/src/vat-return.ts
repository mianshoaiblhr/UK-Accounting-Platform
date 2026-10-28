import { z } from 'zod';

/**
 * V5-M1 (DEC-090): the VAT return. A return is one client's VAT period, tied to the M4b workpaper by a fingerprint (the SHA-256 of the
 * workpaper in canonical JSON, without its notice). Its events are append-only and each carries the fingerprint it was made on, so a step
 * lapses when the ledger changes. Review flags are raised from the workpaper and must be explained before review. The client's approval
 * freezes the return and locks the period against new VAT lines. NOTHING is filed here (V5-M2, fake adapter only; DEC-082, DEC-086).
 */
export const VAT_RETURN_EVENTS = ['PREPARED', 'FLAG_EXPLAINED', 'REVIEWED', 'CLIENT_APPROVED'] as const;
export type VatReturnEventKind = (typeof VAT_RETURN_EVENTS)[number];
export const VAT_RETURN_STATUSES = ['DRAFT', 'PREPARED', 'REVIEWED', 'APPROVED'] as const;
export type VatReturnStatus = (typeof VAT_RETURN_STATUSES)[number];

/** The kinds of review flag (DEC-090). A flag's key is its kind, plus the subject where there can be more than one. */
export const VAT_FLAG_KINDS = ['reconciliation_difference', 'superseded_rate', 'repayment', 'zero_return', 'late_posting'] as const;
export type VatFlagKind = (typeof VAT_FLAG_KINDS)[number];
const FLAG_KEY = /^(reconciliation_difference|repayment|zero_return|superseded_rate:[0-9a-f-]{36}|late_posting:[0-9a-f-]{36}:\d{1,5})$/;

/**
 * The status a return has from its events, given the live fingerprint (DEC-090): APPROVED once locked; REVIEWED while a review made on the
 * live fingerprint follows the latest live preparation; PREPARED while the latest preparation is on the live fingerprint; DRAFT otherwise.
 */
export function vatReturnStatus(a: { locked: boolean; fingerprint: string; events: { kind: string; fingerprint: string; seq: number }[] }): VatReturnStatus {
  if (a.locked) return 'APPROVED';
  const prepared = a.events.filter((e) => e.kind === 'PREPARED').at(-1);
  if (!prepared || prepared.fingerprint !== a.fingerprint) return 'DRAFT';
  const reviewed = a.events.filter((e) => e.kind === 'REVIEWED' && e.seq > prepared.seq && e.fingerprint === a.fingerprint).at(-1);
  return reviewed ? 'REVIEWED' : 'PREPARED';
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const note = z.string().trim().min(1).max(2000);

/** Opens the return for the VAT period that contains `date` (any day of the period; the period comes from the VAT settings). */
export const createVatReturnSchema = z.object({ date: isoDate }).strict();
export const vatReturnStepSchema = z.object({ note: note.optional() }).strict();
export const explainVatFlagSchema = z.object({ flagKey: z.string().regex(FLAG_KEY, 'Unknown flag key'), explanation: z.string().trim().min(10).max(2000) }).strict();
export const vatClientApprovalSchema = z.object({ approverContactId: z.string().uuid(), approvedOn: isoDate, evidenceDocumentId: z.string().uuid(), note: note.optional() }).strict();
export const vatReturnListQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).strict();

// ───────────── V5-M2 the filing record (DEC-091) ─────────────
/** How boxes 6 to 9 are presented on a filing: a verified rule decides which (DEC-021); none is built in. */
export const VAT_PRESENTATION_METHODS = ['TRUNCATE_PENCE', 'ROUND_TO_POUND'] as const;
export type VatPresentationMethod = (typeof VAT_PRESENTATION_METHODS)[number];
export const VAT_FILING_MODES = ['RECORDED', 'SIMULATED'] as const;
export type VatFilingMode = (typeof VAT_FILING_MODES)[number];

/**
 * A box amount (exact decimal string, e.g. "1234.56" or "-12.30") in whole pounds by the method: pence left out (towards zero), or rounded
 * half up (away from zero at .50). Works on the text, so no binary rounding enters a tax figure.
 */
export function presentWholePounds(amount: string, method: VatPresentationMethod): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not a decimal amount: ${amount}`);
  const [, sign, units, frac = ''] = m;
  let pounds = BigInt(units!);
  if (method === 'ROUND_TO_POUND' && frac.length && Number(frac[0]) >= 5) pounds += 1n;
  return pounds === 0n ? '0' : `${sign}${pounds}`;
}

const source = z.object({ url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//.test(u), 'An http(s) link'), provision: z.string().trim().min(3).max(300), retrievedOn: isoDate }).strict();
export const createVatPresentationRuleSchema = z.object({ method: z.enum(VAT_PRESENTATION_METHODS), effectiveFrom: isoDate, effectiveTo: isoDate.optional(), source }).strict()
  .refine((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const supersedeVatPresentationRuleSchema = z.object({ method: z.enum(VAT_PRESENTATION_METHODS), effectiveFrom: isoDate, effectiveTo: isoDate.optional(), source, reason: z.string().trim().min(10).max(1000) }).strict()
  .refine((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const verifyVatPresentationRuleSchema = z.object({ notes: z.string().trim().min(10).max(2000), evidenceDocumentId: z.string().uuid().optional() }).strict();
/** A filing made outside the platform: the date it was submitted, HMRC's receipt reference (form bundle number) and the receipt as evidence. */
export const recordVatFilingSchema = z.object({
  submittedOn: isoDate,
  receiptReference: z.string().trim().regex(/^\d{12}$/, "HMRC's form bundle number: 12 digits"),
  evidenceDocumentId: z.string().uuid(),
  declarationConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm that the return was submitted as approved' }) }),
  note: note.optional(),
}).strict();
export const simulateVatFilingSchema = z.object({ declarationConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm the declaration' }) }) }).strict();
