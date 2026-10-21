import { describe, expect, it } from 'vitest';
import { unexplainedVatDifference } from '@uk/accounting';
import { YEAR_END_STEP_DEPENDS, signOffYearEndStepSchema, yearEndStepStates, type StepControl } from '@uk/contracts';

/** V2-M6b (DEC-069, amended by DEC-070 in V2-M6c): the state rules of the workflow, and the VAT difference the workpaper does not explain. */
const all = (c: StepControl | null): Record<number, StepControl | null> => Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i + 1, c]));

describe('step states', () => {
  it('nothing signed off: step 1 is the only one not blocked', () => {
    const { state, current } = yearEndStepStates(all('READY'), {});
    expect(Object.values(state)).toEqual(['TODO', ...Array(13).fill('BLOCKED')]);
    expect(current).toBe(1);
  });
  it('step 1 done opens 2 to 9 in any order; 10 waits for all of them; 11 for 10', () => {
    let st = yearEndStepStates(all('READY'), { 1: true }).state;
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((n) => st[n])).toEqual(Array(8).fill('TODO'));
    expect([st[10], st[11]]).toEqual(['BLOCKED', 'BLOCKED']);
    st = yearEndStepStates(all('READY'), { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true }).state;
    expect(st[10]).toBe('BLOCKED');
    st = yearEndStepStates(all('READY'), { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true, 9: true }).state;
    expect([st[10], st[11]]).toEqual(['TODO', 'BLOCKED']);
  });
  it('step 12 waits for every one of steps 1 to 11 (DEC-070); 13 for 12; 14 for 13', () => {
    const first11 = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, true]));
    expect(yearEndStepStates(all('READY'), first11).state[12]).toBe('TODO');
    for (let n = 1; n <= 11; n++) expect(yearEndStepStates({ ...all('READY'), [n]: 'ATTENTION' }, first11).state[12], `step ${n} lapsed`).toBe('BLOCKED');
    expect(yearEndStepStates(all('READY'), { ...first11, 12: true }).state[13]).toBe('TODO');
    const done = yearEndStepStates(all('READY'), { ...first11, 12: true, 13: true, 14: true });
    expect([done.state[14], done.current]).toEqual(['DONE', null]);
  });
  it('a control that is not ready gives ATTENTION when unblocked, LAPSED when signed off; NOT_APPLICABLE counts as ready', () => {
    const c = { ...all('READY'), 1: 'ATTENTION' as const, 8: 'NOT_APPLICABLE' as const };
    expect(yearEndStepStates(c, {}).state[1]).toBe('ATTENTION');
    const st = yearEndStepStates(c, { 1: true, 8: true });
    expect([st.state[1], st.state[8], st.state[2], st.current]).toEqual(['LAPSED', 'DONE', 'BLOCKED', 1]);
  });
  it('on 2,000 random combinations every state follows DEC-069 and DEC-070 exactly', () => {
    let seed = 7; const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    for (let i = 0; i < 2000; i++) {
      const controls: Record<number, StepControl | null> = {}, signed: Record<number, boolean> = {};
      for (let n = 1; n <= 14; n++) { controls[n] = pick<StepControl>(n >= 12 ? ['READY', 'ATTENTION'] : ['READY', 'ATTENTION', 'NOT_APPLICABLE']); signed[n] = r() < 0.5; }
      const { state, current } = yearEndStepStates(controls, signed);
      const ok = (n: number) => controls[n] === 'READY' || controls[n] === 'NOT_APPLICABLE';
      for (let n = 1; n <= 14; n++) {
        const expected = signed[n] ? (ok(n) ? 'DONE' : 'LAPSED') : YEAR_END_STEP_DEPENDS[n]!.some((d) => state[d] !== 'DONE') ? 'BLOCKED' : ok(n) ? 'TODO' : 'ATTENTION';
        expect(state[n], `case ${i} step ${n}`).toBe(expected);
      }
      expect(current).toBe(Object.entries(state).find(([, v]) => v !== 'DONE') ? Number(Object.entries(state).find(([, v]) => v !== 'DONE')![0]) : null);
    }
  });
});

describe('the VAT difference', () => {
  it('subtracts explanations on the account side and adds back VAT lines dated outside the period', () => {
    expect(unexplainedVatDifference({ difference: '0.00', explainedBy: [] }).toFixed(2)).toBe('0.00');
    expect(unexplainedVatDifference({ difference: '-500.00', explainedBy: [{ amount: '-500.00', reason: 'Posting to a VAT account without a VAT code (for example a payment to HMRC or an adjustment)' }] }).toFixed(2)).toBe('0.00');
    expect(unexplainedVatDifference({ difference: '-20.00', explainedBy: [{ amount: '20.00', reason: 'Tax point in the period but journal dated outside it' }] }).toFixed(2)).toBe('0.00');
    expect(unexplainedVatDifference({ difference: '35.00', explainedBy: [{ amount: '30.00', reason: 'Tax point outside the period of the journal date' }] }).toFixed(2)).toBe('5.00');
  });
  it('requests name the step 1 to 14', () => {
    expect(signOffYearEndStepSchema.safeParse({ yearStart: '2026-01-01', step: 15 }).success).toBe(false);
    expect(signOffYearEndStepSchema.safeParse({ yearStart: '2026-01-01', step: 1 }).success).toBe(true);
  });
});
