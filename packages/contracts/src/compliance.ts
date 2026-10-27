import { z } from 'zod';
import { ruleSourceSchema } from './vat';

/**
 * V7-M1 compliance calendar contracts (DEC-088). Deadline rules are sourced, versioned organisation data verified by a second person before
 * use (the DEC-021 pattern); NO rule or date figure is built in here. Obligations are what a client must file or pay, with a status, an owner
 * and filing evidence. The platform files nothing (DEC-082, DEC-086).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const uuid = z.string().uuid();

/** Kinds a deadline rule can produce. OTHER is for manual and internal deadlines only; no rule produces it. */
export const RULE_KINDS = ['ACCOUNTS_FILING', 'CT_PAYMENT', 'CT_RETURN', 'CONFIRMATION_STATEMENT', 'VAT_RETURN'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const OBLIGATION_KINDS = [...RULE_KINDS, 'OTHER'] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];
export const OBLIGATION_KIND_NAMES: Record<ObligationKind, string> = {
  ACCOUNTS_FILING: 'Annual accounts to Companies House', CT_PAYMENT: 'Corporation Tax payment', CT_RETURN: 'Company Tax Return (CT600)',
  CONFIRMATION_STATEMENT: 'Confirmation statement', VAT_RETURN: 'VAT return', OTHER: 'Other deadline',
};
/** What each rule kind runs from (DEC-088). */
export const RULE_ANCHORS: Record<RuleKind, 'ACCOUNTING_PERIOD_END' | 'VAT_PERIOD_END' | 'CONFIRMATION_DATE'> = {
  ACCOUNTS_FILING: 'ACCOUNTING_PERIOD_END', CT_PAYMENT: 'ACCOUNTING_PERIOD_END', CT_RETURN: 'ACCOUNTING_PERIOD_END',
  CONFIRMATION_STATEMENT: 'CONFIRMATION_DATE', VAT_RETURN: 'VAT_PERIOD_END',
};
export const LEGAL_FORMS = ['LTD', 'LLP', 'SOLE_TRADER', 'PARTNERSHIP', 'CHARITY', 'OTHER'] as const;

export const OBLIGATION_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'WAITING_ON_CLIENT', 'READY', 'DONE', 'NOT_REQUIRED'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
/** Final statuses: an obligation in one of these is never overdue, and leaving one needs a reason. */
export const FINAL_STATUSES: readonly ObligationStatus[] = ['DONE', 'NOT_REQUIRED'];
/** Due windows for lists: `soon` is overdue plus the next 14 days (the practice's default view); the others are as named. */
export const DUE_WINDOWS = ['overdue', 'next14', 'soon', 'next90', 'open', 'all'] as const;
export type DueWindow = (typeof DUE_WINDOWS)[number];

/** How a due date is computed from its anchor (DEC-088): add `daysBeforeMonths` days, then `months` months, then `daysAfterMonths` days. */
export interface DueDateRule { daysBeforeMonths: number; months: number; daysAfterMonths: number; monthEndRule: boolean }

const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y: y!, m: m!, d: d! }; };
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const addDaysIso = (s: string, n: number) => { const { y, m, d } = parse(s); return iso(y, m, d + n); };

/** Adds whole months. A day past the end of the target month lands on its last day; with `monthEnd`, a month-end date stays a month end (s.443). */
export function addMonthsIso(s: string, months: number, monthEnd = false): string {
  const { y, m, d } = parse(s);
  const total = (m - 1) + months, ty = y + Math.floor(total / 12), tm = (total % 12 + 12) % 12 + 1;
  const end = lastDay(ty, tm);
  return iso(ty, tm, monthEnd && d === lastDay(y, m) ? end : Math.min(d, end));
}

export function dueDateFor(anchor: string, rule: DueDateRule): string {
  return addDaysIso(addMonthsIso(addDaysIso(anchor, rule.daysBeforeMonths), rule.months, rule.monthEndRule), rule.daysAfterMonths);
}

/** Whether an obligation is overdue on `today` (computed, never stored). */
export const isOverdue = (o: { dueDate: string; status: string }, today: string) => o.dueDate < today && !(FINAL_STATUSES as readonly string[]).includes(o.status);

// ───────────── Requests ─────────────
const ruleFields = {
  kind: z.enum(RULE_KINDS),
  legalForms: z.array(z.enum(LEGAL_FORMS)).min(1).max(LEGAL_FORMS.length).transform((a) => [...new Set(a)].sort()),
  daysBeforeMonths: z.number().int().min(0).max(31).default(0),
  months: z.number().int().min(0).max(24),
  daysAfterMonths: z.number().int().min(0).max(60).default(0),
  monthEndRule: z.boolean().default(false),
  effectiveFrom: isoDate, effectiveTo: isoDate.optional(),
  source: ruleSourceSchema,
};
const datesInOrder = (r: { effectiveFrom: string; effectiveTo?: string }) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom;
const hasOffset = (r: { daysBeforeMonths: number; months: number; daysAfterMonths: number }) => r.daysBeforeMonths + r.months + r.daysAfterMonths > 0;
export const createDeadlineRuleSchema = z.object(ruleFields).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] })
  .refine(hasOffset, { message: 'A deadline must fall after its anchor', path: ['months'] });
export const supersedeDeadlineRuleSchema = z.object({ ...ruleFields, reason: z.string().trim().min(10).max(1000) }).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] })
  .refine(hasOffset, { message: 'A deadline must fall after its anchor', path: ['months'] });
export const verifyDeadlineRuleSchema = z.object({
  /** What was checked and against what. */
  notes: z.string().trim().min(10).max(1000),
  evidenceDocumentId: uuid.optional(),
}).strict();

export const complianceProfileSchema = z.object({
  /** The confirmation date (the end of the review period) the next confirmation statement is made up to. */
  confirmationDate: isoDate.nullable(),
  reason: z.string().trim().min(10).max(1000),
}).strict();

export const generateObligationsSchema = z.object({
  /** Anchors from this date (default: one year before `through`). */
  from: isoDate.optional(),
  through: isoDate,
}).strict().refine((g) => !g.from || g.from <= g.through, { message: 'through cannot precede from', path: ['through'] })
  .refine((g) => !g.from || Number(g.through.slice(0, 4)) - Number(g.from.slice(0, 4)) <= 10, { message: 'Generate at most ten years at a time', path: ['from'] });

export const createObligationSchema = z.object({
  kind: z.enum(OBLIGATION_KINDS),
  title: z.string().trim().min(1).max(200).optional(),
  periodStart: isoDate.optional(), periodEnd: isoDate.optional(),
  dueDate: isoDate,
  assigneeUserId: uuid.nullable().default(null),
  /** Why this deadline is entered by hand (an internal deadline, a first-accounts date, an extension). */
  reason: z.string().trim().min(10).max(1000),
}).strict().refine((o) => o.kind !== 'OTHER' || !!o.title, { message: 'An internal deadline needs a title', path: ['title'] })
  .refine((o) => !o.periodStart || !o.periodEnd || o.periodStart <= o.periodEnd, { message: 'periodEnd cannot precede periodStart', path: ['periodEnd'] });

export const updateObligationSchema = z.object({
  /** The version the change was made against (optimistic concurrency). */
  version: z.number().int().min(1),
  status: z.enum(OBLIGATION_STATUSES).optional(),
  assigneeUserId: uuid.nullable().optional(),
  dueDate: isoDate.optional(),
  doneOn: isoDate.optional(),
  doneReference: z.string().trim().min(1).max(200).nullable().optional(),
  evidenceDocumentId: uuid.nullable().optional(),
  reason: z.string().trim().min(10).max(1000).optional(),
}).strict().refine((u) => Object.keys(u).some((k) => k !== 'version' && k !== 'reason'), { message: 'Nothing to change', path: ['version'] });

export const obligationListQuerySchema = z.object({
  status: z.enum(OBLIGATION_STATUSES).optional(),
  kind: z.enum(OBLIGATION_KINDS).optional(),
  due: z.enum(DUE_WINDOWS).default('soon'),
  companyId: uuid.optional(),
  assignee: z.union([z.literal('me'), uuid]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(200).optional(),
}).strict();
export const companyObligationQuerySchema = z.object({
  due: z.enum(DUE_WINDOWS).default('all'),
  status: z.enum(OBLIGATION_STATUSES).optional(),
  kind: z.enum(OBLIGATION_KINDS).optional(),
}).strict();
