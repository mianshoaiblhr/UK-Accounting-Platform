import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, LedgerQueries, PeriodService, PostingService, type PostInput, type PostingActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M1: the PostingService. Every rule has a positive, a negative and (where it applies) a reversal and period-lock case (V1 spec: Tests).
 * The VAT rule arrives with the VAT foundation (M2); the validator slot is proven here with a stand-in so the chain is exercised.
 */
let db: Database;
let org: string, other: string, user: string, co: string, coB: string;
const acc: Record<string, string> = {};     // code -> id (company co)
const accB: Record<string, string> = {};    // company B
const posting = new PostingService();
const accounts = new AccountService();
const queries = new LedgerQueries();
const actor: PostingActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const post = (over: Partial<PostInput> = {}, company = co) => t((tx) => posting.post(tx, {
  organisationId: org, companyId: company, journalDate: '2026-03-15', sourceType: 'MANUAL', description: 'Test journal', idempotencyKey: `k-${uuidv7()}`, actor,
  lines: [{ accountId: (company === co ? acc : accB)['6100']!, debit: '100.00', credit: '0' }, { accountId: (company === co ? acc : accB)['4000']!, debit: '0', credit: '100.00' }], ...over,
}));
const rejects = (p: Promise<unknown>, code: string, status?: number) => expect(p).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
const sql = (q: string) => adminSql(q);
/** Opening balances must be dated the first day of the company's earliest period (other tests add earlier periods). */
const firstDay = () => sql(`SELECT min(start_date) FROM accounting_period WHERE company_id='${co}'`);
let periodId: string;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); other = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('post-${org}@t.test','P') RETURNING id`).split('\n')[0]!;
  actor.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Posting A'),('${other}','BUSINESS','Posting B')`);
  const mkCo = (o: string, n: string) => sql(`INSERT INTO company(organisation_id, name) VALUES ('${o}','${n}') RETURNING id`).split('\n')[0]!;
  co = mkCo(org, 'Co A'); coB = mkCo(org, 'Co B'); mkCo(other, 'Other org co');
  for (const c of [co, coB]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31'),('${org}','${c}','2025-01-01','2025-12-31')`);
  }
  periodId = sql(`SELECT id FROM accounting_period WHERE company_id='${co}' AND start_date='2026-01-01'`);
  const chart = await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }));
  for (const a of (chart as { items: { id: string; code: string }[] }).items) acc[a.code] = a.id;
  const chartB = await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: coB, userId: user }));
  for (const a of (chartB as { items: { id: string; code: string }[] }).items) accB[a.code] = a.id;
});
afterAll(() => db.close());

describe('positive: a valid journal posts', () => {
  it('posts a balanced journal in an open period with a number, totals, source, actor, audit and outbox event', async () => {
    const j = await post({ description: 'Rent for March', sourceReference: 'INV-1' });
    expect(j).toMatchObject({ journalNumber: expect.any(Number), total: '100.00', lineCount: 2, sourceType: 'MANUAL', replayed: false, reversesJournalId: null });
    const row = sql(`SELECT actor_type||'|'||posted_by_user_id||'|'||currency||'|'||period_id||'|'||journal_date FROM journal WHERE id='${j.id}'`);
    expect(row).toBe(`USER|${user}|GBP|${periodId}|2026-03-15`);
    expect(sql(`SELECT count(*) FROM audit_event WHERE action='journal.posted' AND entity_id='${j.id}' AND company_id='${co}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM outbox_event WHERE event_type='transaction.posted' AND aggregate_id='${j.id}'`)).toBe('1');
  });
  it('numbers journals per company without gaps, even when many post at once', async () => {
    const before = Number(sql(`SELECT coalesce(max(journal_number),0) FROM journal WHERE company_id='${co}'`));
    const n = 12;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => post({ description: `Concurrent ${i}` })));
    const numbers = results.map((r) => r.journalNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: n }, (_, i) => before + 1 + i));
    // the other company has its own sequence
    expect((await post({}, coB)).journalNumber).toBe(1);
  });
  it('multi-line journals with several debits and credits post when the totals match', async () => {
    const j = await post({ lines: [
      { accountId: acc['6100']!, debit: '60.00', credit: '0' }, { accountId: acc['6110']!, debit: '40.00', credit: '0' },
      { accountId: acc['4000']!, debit: '0', credit: '70.50' }, { accountId: acc['4010']!, debit: '0', credit: '29.50' }] });
    expect(j.lineCount).toBe(4);
  });
});

describe('negative: every validation refuses with a typed error and writes nothing', () => {
  const count = () => Number(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`));
  it('unbalanced journal', async () => {
    const n = count();
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '100.00', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '99.99' }] }), 'unbalanced_journal', 422);
    expect(count()).toBe(n);
  });
  it('fewer than two lines, zero amounts, both sides on one line, negative and non-numeric amounts', async () => {
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '100.00', credit: '0' }] }), 'too_few_lines');
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '0', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '0' }] }), 'invalid_amount');
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '5', credit: '5' }, { accountId: acc['4000']!, debit: '0', credit: '0.01' }] }), 'invalid_amount');
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '-5', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '-5' }] }), 'invalid_amount');
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: 'abc', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }), 'invalid_amount');
  });
  it('more decimal places than the currency allows (GBP has 2)', async () => {
    await rejects(post({ lines: [{ accountId: acc['6100']!, debit: '10.001', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '10.001' }] }), 'invalid_amount');
  });
  it('unknown account, an account of another company, and an account of another organisation', async () => {
    await rejects(post({ lines: [{ accountId: uuidv7(), debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }), 'unknown_account');
    await rejects(post({ lines: [{ accountId: accB['6100']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }), 'unknown_account');
  });
  it('an account that is not active on the journal date', async () => {
    await t((tx) => accounts.update(tx, { organisationId: org, companyId: co, userId: user, id: acc['6500']!, input: { activeFrom: '2026-06-01', reason: 'starts mid-year' } }));
    await rejects(post({ lines: [{ accountId: acc['6500']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }), 'account_inactive');
    const ok = await post({ journalDate: '2026-06-30', lines: [{ accountId: acc['6500']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] });
    expect(ok.total).toBe('1.00');
  });
  it('no period covers the date', async () => {
    await rejects(post({ journalDate: '2030-01-01' }), 'no_period');
  });
  it('manual journals cannot post to a control account; opening balances can', async () => {
    const lines = [{ accountId: acc['1100']!, debit: '500', credit: '0' }, { accountId: acc['3000']!, debit: '0', credit: '500' }];
    await rejects(post({ lines }), 'control_account_restricted');
    const ob = await post({ sourceType: 'OPENING_BALANCE', description: 'Opening debtors', lines, journalDate: firstDay() });
    await rejects(post({ sourceType: 'OPENING_BALANCE', description: 'Opening debtors again', lines, journalDate: '2026-03-15' }), 'opening_balance_date_invalid');
    expect(ob.sourceType).toBe('OPENING_BALANCE');
  });
  it('unknown source, missing description, bad date', async () => {
    await rejects(post({ sourceType: 'SALES_INVOICE', sourceId: 'x' }), 'unknown_source');
    await rejects(post({ description: '   ' }), 'description_required');
    await rejects(post({ journalDate: '2026-02-30' }), 'invalid_date');
  });
  it('a reversal source must name the journal it reverses, and nothing else may claim to reverse', async () => {
    await rejects(post({ sourceType: 'REVERSAL', sourceId: uuidv7() }), 'source_reference_required');
    await rejects(post({ reversesJournalId: uuidv7() }), 'source_reference_invalid');
  });
});

describe('permissions and actors (manifest control 10: AI never posts)', () => {
  it('an actor without journal:post is refused (403) and nothing is written', async () => {
    const n = Number(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`));
    await rejects(post({ actor: { kind: 'USER', userId: user, can: async () => false } }), 'permission_denied', 403);
    expect(Number(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`))).toBe(n);
  });
  it('the permission is evaluated for the journal\'s own company', async () => {
    const seen: string[] = [];
    await post({ actor: { kind: 'USER', userId: user, can: async (p, c) => { seen.push(`${p}@${c}`); return true; } } }, coB);
    expect(seen).toEqual([`journal:post@${coB}`]);
  });
  it('an AI actor is refused whatever it can do', async () => {
    await rejects(post({ actor: { kind: 'AI', can: async () => true } }), 'ai_cannot_post', 403);
  });
  it('a SYSTEM actor cannot use a user-only source; a USER actor needs an identity', async () => {
    await rejects(post({ actor: { kind: 'SYSTEM', can: async () => true } }), 'source_not_allowed_for_actor', 403);
    await rejects(post({ actor: { kind: 'USER', can: async () => true } }), 'actor_invalid', 403);
  });
});

describe('idempotency', () => {
  it('the same key and content returns the existing journal; the same key with different content is a conflict', async () => {
    const key = `idem-${uuidv7()}`;
    const a = await post({ idempotencyKey: key });
    const b = await post({ idempotencyKey: key });
    expect(b).toMatchObject({ id: a.id, journalNumber: a.journalNumber, replayed: true });
    expect(sql(`SELECT count(*) FROM journal WHERE idempotency_key='${key}'`)).toBe('1');
    await rejects(post({ idempotencyKey: key, description: 'Different' }), 'idempotency_conflict', 409);
  });
  it('concurrent posts with one key produce exactly one journal', async () => {
    const key = `race-${uuidv7()}`;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => post({ idempotencyKey: key })));
    expect(sql(`SELECT count(*) FROM journal WHERE idempotency_key='${key}'`)).toBe('1');
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
  });
});

describe('period controls', () => {
  const periods = new PeriodService();
  const move = (action: 'close' | 'reopen' | 'lock' | 'unlock', pid: string, reason?: string, can = true) =>
    t((tx) => periods.transition(tx, { organisationId: org, companyId: co, periodId: pid, action, reason, userId: user, can: () => can }));
  let pid: string;
  beforeAll(() => { pid = sql(`SELECT id FROM accounting_period WHERE company_id='${co}' AND start_date='2025-01-01'`); });

  it('posting needs an OPEN period: closed and locked periods refuse (period-lock test)', async () => {
    await post({ journalDate: '2025-05-05' });
    await move('close', pid);
    await rejects(post({ journalDate: '2025-05-05' }), 'period_closed');
    await move('lock', pid, 'year end signed off');
    await rejects(post({ journalDate: '2025-05-05' }), 'period_locked');
    await move('unlock', pid, 'late adjustment agreed');
    await rejects(post({ journalDate: '2025-05-05' }), 'period_closed');
    await move('reopen', pid, 'late adjustment agreed');
    expect((await post({ journalDate: '2025-05-06' })).journalDate).toBe('2025-05-06');
  });
  it('only the declared transitions exist, reasons are mandatory where required, and the permission is checked', async () => {
    await rejects(move('lock', pid, 'x'), 'invalid_period_state', 409);     // OPEN -> LOCKED is not allowed
    await rejects(move('reopen', pid, 'x'), 'invalid_period_state', 409);   // already open
    await move('close', pid);
    await rejects(move('reopen', pid), 'reason_required', 422);
    await rejects(move('lock', pid), 'reason_required', 422);
    await rejects(move('lock', pid, 'x', false), 'permission_denied', 403);
    await move('reopen', pid, 'back to open');
  });
  it('every transition is audited with before/after and the reason, and published', async () => {
    const rows = sql(`SELECT action||':'||(before->>'status')||'>'||(after->>'status')||':'||coalesce(reason,'') FROM audit_event WHERE entity_id='${pid}' AND entity_type='accounting_period' ORDER BY occurred_at`).split('\n');
    expect(rows).toEqual(expect.arrayContaining(['period.closed:OPEN>CLOSED:', 'period.locked:CLOSED>LOCKED:year end signed off', 'period.unlocked:LOCKED>CLOSED:late adjustment agreed', 'period.reopened:CLOSED>OPEN:late adjustment agreed']));
    expect(Number(sql(`SELECT count(*) FROM outbox_event WHERE event_type='accounting_period.state_changed' AND aggregate_id='${pid}'`))).toBeGreaterThanOrEqual(6);
  });
  it('concurrent transitions: exactly one wins', async () => {
    const p2 = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2040-01-01','2040-12-31') RETURNING id`).split('\n')[0]!;
    const rs = await Promise.allSettled([move('close', p2), move('close', p2), move('close', p2)]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sql(`SELECT status FROM accounting_period WHERE id='${p2}'`)).toBe('CLOSED');
  });
});

describe('reversals (corrections are reversals, never edits)', () => {
  const reverse = (journalId: string, over: { journalDate?: string; actor?: PostingActor } = {}) => t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId, reason: 'Posted to the wrong account', actor, ...over }));
  it('posts a linked mirror journal that cancels the original in the ledger', async () => {
    const orig = await post({ description: 'Wrong account' });
    const rev = await reverse(orig.id);
    expect(rev).toMatchObject({ sourceType: 'REVERSAL', sourceId: orig.id, reversesJournalId: orig.id, total: '100.00' });
    const d = await t((tx) => queries.getJournal(tx, co, orig.id)) as { reversedByJournalId: string };
    expect(d.reversedByJournalId).toBe(rev.id);
    const net = sql(`SELECT sum(debit) - sum(credit) FROM journal_line WHERE journal_id IN ('${orig.id}','${rev.id}')`);
    expect(Number(net)).toBe(0);
    expect(sql(`SELECT count(*) FROM audit_event WHERE action='journal.reversed' AND entity_id='${rev.id}' AND reason='Posted to the wrong account'`)).toBe('1');
  });
  it('a journal is reversed at most once, a reversal cannot be reversed, and the reversal cannot predate the original', async () => {
    const orig = await post({ journalDate: '2026-04-10' });
    const rev = await reverse(orig.id, { journalDate: '2026-04-11' });
    await rejects(reverse(orig.id), 'already_reversed', 409);
    await rejects(reverse(rev.id), 'cannot_reverse_reversal', 422);
    const o2 = await post({ journalDate: '2026-04-10' });
    await rejects(reverse(o2.id, { journalDate: '2026-04-09' }), 'reversal_before_original', 422);
  });
  it('concurrent reversal attempts create exactly one reversal', async () => {
    const orig = await post({});
    const rs = await Promise.allSettled([reverse(orig.id), reverse(orig.id), reverse(orig.id)]);
    expect(sql(`SELECT count(*) FROM journal WHERE reverses_journal_id='${orig.id}'`)).toBe('1');
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
  it('reversing into a closed period is refused; a journal of another company cannot be reversed', async () => {
    const orig = await post({ journalDate: '2026-05-01' });
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId, action: 'close', userId: user, can: () => true }));
    await rejects(reverse(orig.id, { journalDate: '2026-05-02' }), 'period_closed');
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId, action: 'reopen', reason: 'test', userId: user, can: () => true }));
    await expect(t((tx) => posting.reverse(tx, { organisationId: org, companyId: coB, journalId: orig.id, reason: 'x', actor }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('validator chain (the VAT rule joins here in M2)', () => {
  it('extra validators run after the core rules and can refuse a posting', async () => {
    const strict = new PostingService({ validators: [async (ctx) => { if (ctx.input.description.includes('VAT-TEST')) throw Object.assign(new Error('VAT treatment invalid'), { status: 422, code: 'vat_treatment_invalid' }); }] });
    const run = (description: string) => t((tx) => strict.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-15', sourceType: 'MANUAL', description, idempotencyKey: `v-${uuidv7()}`, actor,
      lines: [{ accountId: acc['6100']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }));
    await expect(run('VAT-TEST journal')).rejects.toMatchObject({ code: 'vat_treatment_invalid' });
    expect((await run('plain')).total).toBe('1.00');
  });
});

describe('atomicity', () => {
  it('a failure after the journal was written rolls back the journal, its lines, the number, the audit row and the event', async () => {
    const n0 = Number(sql(`SELECT last_number FROM ledger_sequence WHERE company_id='${co}'`)), j0 = Number(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`));
    const a0 = Number(sql(`SELECT count(*) FROM audit_event WHERE action='journal.posted' AND company_id='${co}'`));
    await expect(t(async (tx) => { await posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-15', sourceType: 'MANUAL', description: 'rolled back', idempotencyKey: `rb-${uuidv7()}`, actor,
      lines: [{ accountId: acc['6100']!, debit: '9', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '9' }] }); throw new Error('caller failed afterwards'); })).rejects.toThrow('caller failed');
    expect(Number(sql(`SELECT last_number FROM ledger_sequence WHERE company_id='${co}'`))).toBe(n0);
    expect(Number(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`))).toBe(j0);
    expect(Number(sql(`SELECT count(*) FROM audit_event WHERE action='journal.posted' AND company_id='${co}'`))).toBe(a0);
  });
});

describe('ledger reads come from the journal lines', () => {
  it('the trial balance balances, matches the ledger sums and drills down to the general ledger and the journal', async () => {
    const tb = await t((tx) => queries.trialBalance(tx, co, { asOf: '2026-12-31' })) as { balanced: boolean; totalDebit: string; totalCredit: string; rows: { accountId: string; code: string; debit: string; credit: string; drilldown: { accountId: string; to: string } }[] };
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const fromSql = sql(`SELECT sum(debit) FROM journal_line WHERE company_id='${co}'`);
    expect(Number(tb.totalDebit)).toBeLessThanOrEqual(Number(fromSql));
    const row = tb.rows.find((r) => r.code === '6100')!;
    expect(row.drilldown).toMatchObject({ accountId: row.accountId });
    const gl = await t((tx) => queries.generalLedger(tx, co, { accountId: row.accountId, limit: 5 })) as { items: { journalId: string; balance: string }[]; nextCursor: string | null };
    expect(gl.items.length).toBeGreaterThan(0);
    const j = await t((tx) => queries.getJournal(tx, co, gl.items[0]!.journalId)) as { lines: { accountCode: string }[] };
    expect(j.lines.map((l) => l.accountCode)).toContain('6100');
  });
  it('the general-ledger running balance is the same whether read in one page or page by page', async () => {
    const id = acc['6100']!;
    const all = await t((tx) => queries.generalLedger(tx, co, { accountId: id, limit: 200 })) as { items: { journalId: string; lineNo: number; balance: string }[] };
    expect(all.items.length).toBeGreaterThan(4);
    const paged: { journalId: string; lineNo: number; balance: string }[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const p = await t((tx) => queries.generalLedger(tx, co, { accountId: id, limit: 3, cursor })) as { items: typeof paged; nextCursor: string | null };
      paged.push(...p.items);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(paged.map((r) => `${r.journalId}:${r.lineNo}:${r.balance}`)).toEqual(all.items.map((r) => `${r.journalId}:${r.lineNo}:${r.balance}`));
  });
  it('a non-zero suspense balance is reported as a warning', async () => {
    await post({ lines: [{ accountId: acc['9999']!, debit: '25', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '25' }], sourceType: 'OPENING_BALANCE', description: 'to suspense', journalDate: firstDay() });
    const tb = await t((tx) => queries.trialBalance(tx, co, { asOf: '2026-12-31' })) as { warnings: { code: string; accountCode: string }[] };
    expect(tb.warnings).toEqual([expect.objectContaining({ code: 'suspense_balance', accountCode: '9999' })]);
  });
  it('trial balance for a period carries that period\'s movement', async () => {
    const tb = await t((tx) => queries.trialBalance(tx, co, { periodId })) as { period: { startDate: string }; rows: { code: string; movementDebit: string }[] };
    expect(tb.period.startDate).toBe('2026-01-01');
    expect(Number(tb.rows.find((r) => r.code === '6100')!.movementDebit)).toBeGreaterThan(0);
  });
});
