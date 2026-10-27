import { describe, expect, it } from 'vitest';
import { addMonthsIso, createDeadlineRuleSchema, createObligationSchema, dueDateFor, isOverdue, updateObligationSchema } from './compliance';

/** DEC-088: the due-date arithmetic. The rule figures used here are test inputs, not the platform's rules (none are built in). */
const rule = (r: Partial<{ daysBeforeMonths: number; months: number; daysAfterMonths: number; monthEndRule: boolean }>) =>
  ({ daysBeforeMonths: 0, months: 0, daysAfterMonths: 0, monthEndRule: false, ...r });

describe('addMonthsIso', () => {
  it('adds months within and across years', () => {
    expect(addMonthsIso('2025-01-15', 9)).toBe('2025-10-15');
    expect(addMonthsIso('2025-06-15', 9)).toBe('2026-03-15');
    expect(addMonthsIso('2025-12-15', 24)).toBe('2027-12-15');
  });
  it('lands on the last day when the target month is shorter', () => {
    expect(addMonthsIso('2025-05-31', 9)).toBe('2026-02-28');
    expect(addMonthsIso('2023-05-31', 9)).toBe('2024-02-29');
    expect(addMonthsIso('2025-08-31', 1)).toBe('2025-09-30');
  });
  it('keeps a month end a month end only under the month-end rule', () => {
    expect(addMonthsIso('2025-02-28', 9)).toBe('2025-11-28');
    expect(addMonthsIso('2025-02-28', 9, true)).toBe('2025-11-30');
    expect(addMonthsIso('2023-02-28', 12, true)).toBe('2024-02-29');
    expect(addMonthsIso('2024-02-29', 12, true)).toBe('2025-02-28');
    expect(addMonthsIso('2025-06-15', 9, true)).toBe('2026-03-15');
  });
});

describe('dueDateFor', () => {
  it('months with the month-end rule (an accounts-filing shape)', () => {
    const r = rule({ months: 9, monthEndRule: true });
    expect(dueDateFor('2025-12-31', r)).toBe('2026-09-30');
    expect(dueDateFor('2026-06-30', r)).toBe('2027-03-31');
    expect(dueDateFor('2025-04-05', r)).toBe('2026-01-05');
  });
  it('days are added before the months, then after (a payment shape: the day after the period, then months)', () => {
    const r = rule({ daysBeforeMonths: 1, months: 9 });
    expect(dueDateFor('2025-12-31', r)).toBe('2026-10-01');
    expect(dueDateFor('2025-06-30', r)).toBe('2026-04-01');
    expect(dueDateFor('2025-03-31', r)).toBe('2026-01-01');
  });
  it('months then days (a return-period shape)', () => {
    const r = rule({ months: 1, daysAfterMonths: 7, monthEndRule: true });
    expect(dueDateFor('2026-09-30', r)).toBe('2026-11-07');
    expect(dueDateFor('2026-01-31', r)).toBe('2026-03-07');
    expect(dueDateFor('2026-02-28', r)).toBe('2026-04-07');
    expect(dueDateFor('2026-12-31', r)).toBe('2027-02-07');
  });
  it('days only', () => expect(dueDateFor('2026-10-20', rule({ daysAfterMonths: 14 }))).toBe('2026-11-03'));
});

describe('isOverdue', () => {
  it('is past the due date and not final', () => {
    expect(isOverdue({ dueDate: '2026-10-26', status: 'IN_PROGRESS' }, '2026-10-27')).toBe(true);
    expect(isOverdue({ dueDate: '2026-10-27', status: 'NOT_STARTED' }, '2026-10-27')).toBe(false);
    expect(isOverdue({ dueDate: '2026-10-01', status: 'DONE' }, '2026-10-27')).toBe(false);
    expect(isOverdue({ dueDate: '2026-10-01', status: 'NOT_REQUIRED' }, '2026-10-27')).toBe(false);
  });
});

describe('request schemas', () => {
  const src = { url: 'https://example.test/rule', provision: 'Test provision', retrievedOn: '2026-10-27' };
  it('a rule needs an offset, ordered dates, and keeps legal forms unique and sorted', () => {
    expect(createDeadlineRuleSchema.safeParse({ kind: 'VAT_RETURN', legalForms: ['LTD'], months: 0, effectiveFrom: '2020-01-01', source: src }).success).toBe(false);
    expect(createDeadlineRuleSchema.safeParse({ kind: 'VAT_RETURN', legalForms: ['LTD'], months: 1, effectiveFrom: '2020-01-01', effectiveTo: '2019-01-01', source: src }).success).toBe(false);
    const ok = createDeadlineRuleSchema.parse({ kind: 'VAT_RETURN', legalForms: ['SOLE_TRADER', 'LTD', 'LTD'], months: 1, daysAfterMonths: 7, effectiveFrom: '2020-01-01', source: src });
    expect(ok.legalForms).toEqual(['LTD', 'SOLE_TRADER']);
    expect(ok).toMatchObject({ daysBeforeMonths: 0, monthEndRule: false });
  });
  it('an internal deadline needs a title; a manual deadline needs a reason', () => {
    expect(createObligationSchema.safeParse({ kind: 'OTHER', dueDate: '2026-11-01', reason: 'Internal review deadline' }).success).toBe(false);
    expect(createObligationSchema.safeParse({ kind: 'OTHER', title: 'Partner review', dueDate: '2026-11-01' }).success).toBe(false);
    expect(createObligationSchema.safeParse({ kind: 'OTHER', title: 'Partner review', dueDate: '2026-11-01', reason: 'Internal review deadline' }).success).toBe(true);
  });
  it('an update must change something', () => {
    expect(updateObligationSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateObligationSchema.safeParse({ version: 1, reason: 'Nothing else changes here' }).success).toBe(false);
    expect(updateObligationSchema.safeParse({ version: 1, status: 'IN_PROGRESS' }).success).toBe(true);
  });
});
