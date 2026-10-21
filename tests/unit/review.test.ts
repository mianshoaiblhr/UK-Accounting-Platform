import { describe, expect, it } from 'vitest';
import { canonicalFigures, flagState } from '@uk/accounting';
import { setReviewSettingsSchema, FLAG_KEY } from '@uk/contracts';

/** V2-M6a (DEC-068): the state of a flag from its responses, and the request shapes. */
const F = { account: '1110', balance: '-150.00' };
const r = (action: string, by = 'a', figures: object = F) => ({ action, byUserId: by, figures });

describe('flag state', () => {
  it('follows explain, sign off and reopen, oldest first', () => {
    expect(flagState([], F)).toEqual({ state: 'OPEN', changed: false, explainedBy: null });
    expect(flagState([r('EXPLAIN')], F)).toEqual({ state: 'EXPLAINED', changed: false, explainedBy: 'a' });
    expect(flagState([r('EXPLAIN'), r('SIGN_OFF', 'b')], F).state).toBe('SIGNED_OFF');
    expect(flagState([r('EXPLAIN'), r('SIGN_OFF', 'b'), r('REOPEN', 'b')], F)).toEqual({ state: 'OPEN', changed: false, explainedBy: null });
    expect(flagState([r('EXPLAIN'), r('REOPEN', 'b'), r('EXPLAIN', 'c')], F)).toEqual({ state: 'EXPLAINED', changed: false, explainedBy: 'c' });
    expect(flagState([r('SIGN_OFF', 'b')], F).state).toBe('OPEN');                     // a sign-off without an explanation means nothing
  });
  it('an explanation or sign-off lapses when the figures change, whatever the key order', () => {
    expect(flagState([r('EXPLAIN'), r('SIGN_OFF', 'b')], { account: '1110', balance: '-200.00' })).toEqual({ state: 'OPEN', changed: true, explainedBy: null });
    expect(flagState([r('EXPLAIN', 'a', { balance: '-150.00', account: '1110' })], F).state).toBe('EXPLAINED');
    expect(canonicalFigures({ b: 1, a: { d: 2, c: [3, 1] } })).toBe(canonicalFigures({ a: { c: [3, 1], d: 2 }, b: 1 }));
    expect(canonicalFigures({ flags: ['X', 'Y'] })).not.toBe(canonicalFigures({ flags: ['Y', 'X'] }));
  });
});

describe('requests', () => {
  it('settings are positive amounts, a percentage and 30, 60 or 90 days; flag keys have the control, a type and an id', () => {
    expect(setReviewSettingsSchema.safeParse({ unexplainedAmount: '1000', materialPercent: '12.5', oldItemDays: 60, reason: 'Firm policy' }).success).toBe(true);
    expect(setReviewSettingsSchema.safeParse({ oldItemDays: 45, reason: 'Firm policy' }).success).toBe(false);
    expect(setReviewSettingsSchema.safeParse({ materialAmount: '0', reason: 'Firm policy' }).success).toBe(false);
    expect(setReviewSettingsSchema.safeParse({ materialAmount: '-5', reason: 'Firm policy' }).success).toBe(false);
    expect(FLAG_KEY.test('RC-05:customer:0f3b9a2e-0000-4000-8000-000000000001:GBP')).toBe(true);
    expect(FLAG_KEY.test('RC-10:account:x')).toBe(false);
    expect(FLAG_KEY.test('RC-01:journal:')).toBe(false);
  });
});
