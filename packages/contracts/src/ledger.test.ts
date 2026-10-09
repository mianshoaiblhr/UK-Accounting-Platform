import { describe, expect, it } from 'vitest';
import { ACCOUNT_SUBTYPES, CONTROL_KINDS, DEBIT_NORMAL, DEFAULT_CHART, JOURNAL_SOURCES, PERIOD_TRANSITIONS, REPORT_LINES, createAccountSchema, moneyString, postJournalSchema } from './ledger';
import { PERMISSIONS } from './permissions';

describe('default chart of accounts', () => {
  it('every template account is valid under the same schema the API uses', () => {
    for (const a of DEFAULT_CHART) {
      const r = createAccountSchema.safeParse({ code: a.code, name: a.name, type: a.type, subtype: a.subtype, isControl: !!a.control, controlKind: a.control ?? null, taxTreatment: a.tax ?? 'NOT_APPLICABLE', reportingMapping: a.mapping });
      expect(r.success, `${a.code} ${a.name}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });
  it('codes are unique and the structural accounts exist exactly once (receivables, payables, VAT, retained earnings, suspense)', () => {
    expect(new Set(DEFAULT_CHART.map((a) => a.code)).size).toBe(DEFAULT_CHART.length);
    for (const kind of ['TRADE_RECEIVABLES', 'TRADE_PAYABLES', 'VAT_CONTROL', 'RETAINED_EARNINGS', 'SUSPENSE'] as const) expect(DEFAULT_CHART.filter((a) => a.control === kind), kind).toHaveLength(1);
    expect(DEFAULT_CHART.filter((a) => a.system).map((a) => a.control).sort()).toEqual(['RETAINED_EARNINGS', 'SUSPENSE', 'TRADE_PAYABLES', 'TRADE_RECEIVABLES', 'VAT_CONTROL']);
  });
  it('every reporting line accepts at least one type and every type has a subtype list', () => {
    for (const [code, l] of Object.entries(REPORT_LINES)) expect(l.types.length, code).toBeGreaterThan(0);
    for (const t of Object.keys(ACCOUNT_SUBTYPES)) expect(ACCOUNT_SUBTYPES[t as keyof typeof ACCOUNT_SUBTYPES].length).toBeGreaterThan(0);
    expect(DEBIT_NORMAL).toEqual(['ASSET', 'EXPENSE']);
    expect(CONTROL_KINDS).toContain('SUSPENSE');
  });
});

describe('account schema rules', () => {
  const base = { code: '1234', name: 'Test', type: 'ASSET', subtype: 'CURRENT_ASSET_OTHER', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS' };
  it('control flag and kind go together; subtype and reporting line must fit the type', () => {
    expect(createAccountSchema.safeParse(base).success).toBe(true);
    expect(createAccountSchema.safeParse({ ...base, isControl: true }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, controlKind: 'BANK' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, isControl: true, controlKind: 'BANK' }).success).toBe(true);
    expect(createAccountSchema.safeParse({ ...base, subtype: 'SALES' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, reportingMapping: 'PL.TURNOVER' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, code: 'has space' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, activeFrom: '2026-02-01', activeTo: '2026-01-01' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});

describe('money strings and journal requests', () => {
  it('amounts are decimal strings: no numbers, no negatives, no exponents, bounded decimals', () => {
    for (const ok of ['0', '1', '1234.5', '1234.50', '0.0001', '999999999999999.99']) expect(moneyString.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['-1', '1e5', '1,000.00', '.5', '5.', 'abc', '', '1.00001', 100 as unknown as string]) expect(moneyString.safeParse(bad).success, String(bad)).toBe(false);
  });
  it('a journal request needs two lines, a date and a description, and only API sources', () => {
    const line = { accountId: '11111111-1111-4111-8111-111111111111', debit: '1', credit: '0' };
    const req = { journalDate: '2026-03-01', description: 'x', lines: [line, { ...line, debit: '0', credit: '1' }] };
    expect(postJournalSchema.safeParse(req).success).toBe(true);
    expect(postJournalSchema.safeParse({ ...req, lines: [line] }).success).toBe(false);
    expect(postJournalSchema.safeParse({ ...req, source: 'REVERSAL' }).success).toBe(false);
    expect(postJournalSchema.safeParse({ ...req, source: 'SALES_INVOICE' }).success).toBe(false);
    expect(postJournalSchema.safeParse({ ...req, journalDate: '2026-02-30' }).success).toBe(false);
    expect(postJournalSchema.safeParse({ ...req, currency: 'GBP' }).success).toBe(true);
    expect(postJournalSchema.safeParse({ ...req, currency: 'gbp' }).success).toBe(false);
  });
});

describe('registries that carry controls', () => {
  it('AI is never an allowed actor of any journal source (manifest control 10)', () => {
    for (const [name, s] of Object.entries(JOURNAL_SOURCES)) expect((s.actors as readonly string[]).includes('AI'), name).toBe(false);
  });
  it('manual journals cannot touch control accounts; every source names a real permission', () => {
    expect(JOURNAL_SOURCES.MANUAL!.controlAccounts).toBe(false);
    for (const s of Object.values(JOURNAL_SOURCES)) expect((PERMISSIONS as readonly string[]).includes(s.permission)).toBe(true);
  });
  it('period transitions form exactly the agreed graph and lock/unlock need the lock permission', () => {
    expect(Object.fromEntries(Object.entries(PERIOD_TRANSITIONS).map(([k, v]) => [k, `${v.from}>${v.to}`]))).toEqual({ close: 'OPEN>CLOSED', reopen: 'CLOSED>OPEN', lock: 'CLOSED>LOCKED', unlock: 'LOCKED>CLOSED' });
    expect(PERIOD_TRANSITIONS.lock.permission).toBe('period:lock');
    expect(PERIOD_TRANSITIONS.unlock.permission).toBe('period:lock');
    expect(PERIOD_TRANSITIONS.close.permission).toBe('period:manage');
  });
});
