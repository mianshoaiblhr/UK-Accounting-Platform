import { z } from 'zod';

/** V2-M3a year-end adjustments (DEC-059): accruals, accrued income, prepayments, deferred income, release runs and provisions. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A decimal string such as "1234.50"').refine((s) => Number(s) > 0, 'Above zero');
const reason = z.string().trim().min(3).max(500);

export const YEAR_END_ITEM_KINDS = ['ACCRUAL', 'ACCRUED_INCOME', 'PREPAYMENT', 'DEFERRED_INCOME'] as const;
export type YearEndItemKind = (typeof YEAR_END_ITEM_KINDS)[number];
export const PROVISION_MOVEMENT_KINDS = ['MADE', 'USED', 'RELEASED'] as const;

const common = {
  description: z.string().trim().min(1).max(300), amount, plAccountId: uuid, balanceAccountId: uuid,
  basis: z.string().trim().min(3).max(1000).optional(),
  evidenceDocumentIds: z.array(uuid).max(20).default([]).transform((a) => [...new Set(a)]),
};
export const createYearEndItemSchema = z.discriminatedUnion('kind', [
  /** At a date (normally a period end); reversed on the next day, which must fall in an open period. */
  z.object({ kind: z.literal('ACCRUAL'), date: isoDate, ...common }).strict(),
  z.object({ kind: z.literal('ACCRUED_INCOME'), date: isoDate, ...common }).strict(),
  /** Released over [periodStart, periodEnd]. POSTED reclassifies from the P&L account at `date`; LINKED names the journal that already put it on the balance account. */
  z.object({ kind: z.literal('PREPAYMENT'), date: isoDate, periodStart: isoDate, periodEnd: isoDate, convention: z.enum(['DAILY', 'MONTHLY']).default('MONTHLY'),
    setup: z.discriminatedUnion('kind', [z.object({ kind: z.literal('POSTED') }).strict(), z.object({ kind: z.literal('LINKED'), journalId: uuid }).strict()]), ...common }).strict(),
  z.object({ kind: z.literal('DEFERRED_INCOME'), date: isoDate, periodStart: isoDate, periodEnd: isoDate, convention: z.enum(['DAILY', 'MONTHLY']).default('MONTHLY'),
    setup: z.discriminatedUnion('kind', [z.object({ kind: z.literal('POSTED') }).strict(), z.object({ kind: z.literal('LINKED'), journalId: uuid }).strict()]), ...common }).strict(),
]).refine((i) => !('periodEnd' in i) || i.periodEnd >= i.periodStart, { message: 'periodEnd cannot precede periodStart', path: ['periodEnd'] });
export const yearEndItemListQuerySchema = z.object({ kind: z.enum(YEAR_END_ITEM_KINDS).optional(), status: z.enum(['ACTIVE', 'CANCELLED']).optional() }).strict();
export const cancelYearEndItemSchema = z.object({ reason }).strict();
export const releaseRunSchema = z.object({ asAt: isoDate }).strict();
export const releasePreviewQuerySchema = z.object({ asAt: isoDate }).strict();
export const reverseReleaseRunSchema = z.object({ reason }).strict();
export const createProvisionSchema = z.object({
  name: z.string().trim().min(1).max(200), accountId: uuid, expenseAccountId: uuid, basis: z.string().trim().min(3).max(1000),
  evidenceDocumentIds: z.array(uuid).max(20).default([]).transform((a) => [...new Set(a)]),
}).strict();
export const provisionMovementSchema = z.object({ kind: z.enum(PROVISION_MOVEMENT_KINDS), date: isoDate, amount, offsetAccountId: uuid.optional(), reason }).strict()
  .refine((m) => (m.kind === 'USED') === (m.offsetAccountId !== undefined), { message: 'A use names the account the actual cost went to (offsetAccountId); other movements do not', path: ['offsetAccountId'] });
export const reverseProvisionMovementSchema = z.object({ reason }).strict();
export const provisionReportQuerySchema = z.object({ from: isoDate, to: isoDate }).strict().refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] });
export const yearEndRegisterQuerySchema = z.object({ asAt: isoDate }).strict();
