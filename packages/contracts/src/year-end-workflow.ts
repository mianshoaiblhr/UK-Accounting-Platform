import { z } from 'zod';

/**
 * V2-M6b (DEC-069): the year-end workflow of the V2 specification, 14 steps. Each step's status is read from an existing control; a preparer
 * signs a step off when its control is ready and the steps it depends on are done. Steps 12 to 14 arrive with V2-M6c.
 */
export const YEAR_END_STEPS = [
  'Lock/confirm period', 'Bank reconciliation', 'Receivables review', 'Payables review', 'Fixed asset review', 'Accrual/prepayment review', 'Director balances',
  'VAT reconciliation', 'Suspense clearance', 'Review adjustments', 'Generate accounts', 'Partner review', 'Client approval', 'Filing-ready package',
] as const;
/** The steps each step depends on (DEC-069): step 1 first; 2 to 9 in any order after it; 10 after 1 to 9; 11, 12, 13 and 14 in turn. */
export const YEAR_END_STEP_DEPENDS: Record<number, number[]> = {
  1: [], 2: [1], 3: [1], 4: [1], 5: [1], 6: [1], 7: [1], 8: [1], 9: [1], 10: [1, 2, 3, 4, 5, 6, 7, 8, 9], 11: [10], 12: [11], 13: [12], 14: [13],
};
/** Steps not yet available (V2-M6c). */
export const YEAR_END_LATER_STEPS = [12, 13, 14];
export type StepControl = 'READY' | 'ATTENTION' | 'NOT_APPLICABLE';
export type StepState = 'LATER' | 'DONE' | 'LAPSED' | 'BLOCKED' | 'TODO' | 'ATTENTION';

/** The state of every step from its control and whether it is signed off (DEC-069; pure, unit-tested). */
export function yearEndStepStates(controls: Record<number, StepControl | null>, signedOff: Record<number, boolean>, later: readonly number[] = YEAR_END_LATER_STEPS) {
  const ready = (n: number) => controls[n] === 'READY' || controls[n] === 'NOT_APPLICABLE';
  const state: Record<number, StepState> = {};
  for (let n = 1; n <= 14; n++) if (later.includes(n)) state[n] = 'LATER'; else if (signedOff[n]) state[n] = ready(n) ? 'DONE' : 'LAPSED';
  for (let n = 1; n <= 14; n++) if (!state[n]) state[n] = YEAR_END_STEP_DEPENDS[n]!.some((d) => state[d] !== 'DONE') ? 'BLOCKED' : ready(n) ? 'TODO' : 'ATTENTION';
  let current: number | null = null;
  for (let n = 1; n <= 14; n++) if (state[n] !== 'DONE') { current = n; break; }
  return { state, current };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
export const yearEndWorkflowQuerySchema = z.object({ yearStart: isoDate }).strict();
const step = z.number().int().min(1).max(14);
export const signOffYearEndStepSchema = z.object({ yearStart: isoDate, step, note: z.string().trim().min(3).max(2000).optional() }).strict();
export const reopenYearEndStepSchema = z.object({ yearStart: isoDate, step, note: z.string().trim().min(3).max(2000) }).strict();
