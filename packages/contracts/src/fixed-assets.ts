import { z } from 'zod';

/** V2-M2 fixed assets (DEC-058): request shapes of classes, assets, changes of estimate, disposals, depreciation runs and the register. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A decimal string such as "1234.50"');
const percent = z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, 'A percentage below 100 such as "25" or "12.5"');
const reason = z.string().trim().min(3).max(500);

export const DEPRECIATION_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE'] as const;
export const DEPRECIATION_CONVENTIONS = ['DAILY', 'MONTHLY'] as const;
export const ASSET_TAX_CATEGORIES = ['AIA', 'MAIN_POOL', 'SPECIAL_RATE_POOL', 'SINGLE_ASSET_POOL', 'NOT_QUALIFYING', 'UNDECIDED'] as const;
export const ASSET_STATUSES = ['ACTIVE', 'DISPOSED', 'VOID'] as const;

const methodFields = { method: z.enum(DEPRECIATION_METHODS), lifeMonths: z.number().int().min(1).max(1200).optional(), ratePercent: percent.optional() };
/** Straight line takes a life in months, reducing balance an annual rate; never both. */
const methodShape = (m: { method?: string; lifeMonths?: number; ratePercent?: string }) =>
  m.method === undefined ? m.lifeMonths === undefined && m.ratePercent === undefined
    : m.method === 'STRAIGHT_LINE' ? m.lifeMonths !== undefined && m.ratePercent === undefined
      : m.ratePercent !== undefined && Number(m.ratePercent) > 0 && m.lifeMonths === undefined;
const methodMessage = { message: 'Straight line needs lifeMonths (and no ratePercent); reducing balance needs ratePercent above 0 (and no lifeMonths)', path: ['method'] };

export const createAssetClassSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Upper-case code such as OFFICE'), name: z.string().trim().min(1).max(200),
  costAccountId: uuid, depreciationAccountId: uuid, expenseAccountId: uuid, disposalAccountId: uuid,
  ...methodFields, residualPercent: percent.default('0'), convention: z.enum(DEPRECIATION_CONVENTIONS).default('MONTHLY'),
}).strict().refine(methodShape, methodMessage);
/** New defaults apply to assets added afterwards; existing assets change only by a change of estimate. */
export const updateAssetClassSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), method: z.enum(DEPRECIATION_METHODS).optional(), lifeMonths: z.number().int().min(1).max(1200).optional(), ratePercent: percent.optional(),
  residualPercent: percent.optional(), convention: z.enum(DEPRECIATION_CONVENTIONS).optional(), reason,
}).strict().refine(methodShape, methodMessage);

const additionSchema = z.discriminatedUnion('kind', [
  /** The register posts Dr cost / Cr this non-control account. */
  z.object({ kind: z.literal('POSTED'), offsetAccountId: uuid }).strict(),
  /** The cost is already in the ledger (a supplier bill, a cash payment, a journal) that debits the class's cost account. */
  z.object({ kind: z.literal('LINKED'), journalId: uuid }).strict(),
  /** Brought in with its accumulated depreciation at the take-on date; optionally linked to the journal that carries the balances. */
  z.object({ kind: z.literal('TAKE_ON'), takeOnDate: isoDate, accumulatedDepreciation: amount, journalId: uuid.optional() }).strict(),
]);
const taxSchema = z.object({ category: z.enum(ASSET_TAX_CATEGORIES), cost: amount.nullable().optional() }).strict();
export const addAssetSchema = z.object({
  classId: uuid, description: z.string().trim().min(1).max(300), acquiredOn: isoDate, inUseFrom: isoDate.optional(), cost: amount,
  addition: additionSchema,
  /** Overrides of the class defaults. For a take-on, lifeMonths is the life remaining after the take-on date. */
  method: z.enum(DEPRECIATION_METHODS).optional(), lifeMonths: z.number().int().min(1).max(1200).optional(), ratePercent: percent.optional(),
  residual: amount.optional(), convention: z.enum(DEPRECIATION_CONVENTIONS).optional(),
  tax: taxSchema.default({ category: 'UNDECIDED' }),
}).strict()
  .refine((a) => a.method === undefined || methodShape(a), methodMessage)
  .refine((a) => !a.inUseFrom || a.inUseFrom >= a.acquiredOn, { message: 'inUseFrom cannot precede acquiredOn', path: ['inUseFrom'] })
  .refine((a) => Number(a.cost) > 0, { message: 'cost must be above zero', path: ['cost'] });
/** A change of estimate: prospective from the day after the last charge (FRS 102 s.10). */
export const changeEstimateSchema = z.object({
  method: z.enum(DEPRECIATION_METHODS).optional(), lifeMonths: z.number().int().min(1).max(1200).optional(), ratePercent: percent.optional(),
  residual: amount.optional(), convention: z.enum(DEPRECIATION_CONVENTIONS).optional(), reason,
}).strict().refine((e) => e.method !== undefined || e.lifeMonths !== undefined || e.ratePercent !== undefined || e.residual !== undefined || e.convention !== undefined, 'Nothing to change');
export const changeAssetTaxSchema = z.object({ category: z.enum(ASSET_TAX_CATEGORIES), cost: amount.nullable().optional(), reason }).strict();
export const disposeAssetSchema = z.object({
  disposedOn: isoDate,
  proceeds: amount.default('0'),
  /** Where the proceeds are posted (a non-control account). Omitted with proceeds above zero: they were already recorded on the class's disposal account (for example by a cash receipt) and are only counted. */
  proceedsAccountId: uuid.optional(),
  reason,
}).strict().refine((d) => !d.proceedsAccountId || Number(d.proceeds) > 0, { message: 'A proceeds account needs proceeds above zero', path: ['proceedsAccountId'] });
export const reverseAssetEventSchema = z.object({ reason }).strict();
export const depreciationRunSchema = z.object({ asAt: isoDate }).strict();
export const depreciationPreviewQuerySchema = z.object({ asAt: isoDate }).strict();
export const assetRegisterQuerySchema = z.object({ asAt: isoDate }).strict();
export const assetListQuerySchema = z.object({ status: z.enum(ASSET_STATUSES).optional(), classId: uuid.optional() }).strict();
