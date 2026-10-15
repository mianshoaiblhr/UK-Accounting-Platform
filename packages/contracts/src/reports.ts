import { z } from 'zod';

/** V1-M8 reports (DEC-043..045): query shapes of the statements, the FX report and the alert list. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const flag = z.enum(['true', 'false']).optional().transform((v) => v === 'true');

export const profitAndLossQuerySchema = z.object({ from: isoDate, to: isoDate, compareFrom: isoDate.optional(), compareTo: isoDate.optional(), includeEmpty: flag }).strict()
  .refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] })
  .refine((q) => (q.compareFrom === undefined) === (q.compareTo === undefined), { message: 'Give both compareFrom and compareTo', path: ['compareTo'] })
  .refine((q) => !q.compareFrom || !q.compareTo || q.compareTo >= q.compareFrom, { message: 'compareTo cannot precede compareFrom', path: ['compareTo'] });
export const balanceSheetQuerySchema = z.object({ asOf: isoDate, compareAsOf: isoDate.optional(), includeEmpty: flag }).strict();
export const fxReportQuerySchema = z.object({ from: isoDate, to: isoDate }).strict().refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] });
export const alertQuerySchema = z.object({
  asOf: isoDate.optional(),
  draftDays: z.coerce.number().int().min(1).max(365).optional(),
  unmatchedDays: z.coerce.number().int().min(1).max(365).optional(),
}).strict();
