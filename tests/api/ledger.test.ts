import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M1 through the public API: chart of accounts, journals, ledger, trial balance and period controls, with real roles, tenants and the feature flag. */
let s: Stack;
let owner: TestUser, partner: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string }, assignedOnly: TestUser, otherCompany: { id: string };
const acc: Record<string, string> = {};
const GHOST = '11111111-1111-4111-8111-111111111111';
const base = (c = company.id) => `/companies/${c}`;
const as = (u: TestUser, m: 'get' | 'post' | 'patch' | 'put' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const journal = (lines: [string, string, string][], over: object = {}) => ({ journalDate: '2026-03-15', description: 'API journal', lines: lines.map(([code, debit, credit]) => ({ accountId: acc[code]!, debit, credit })), ...over });
const rent = (amount = '100.00', over: object = {}) => journal([['6100', amount, '0'], ['4000', '0', amount]], over);
let periodId: string;

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Ledger Client');
  otherCompany = await makeCompany(s, owner, 'Ledger Other');
  partner = await addMember(s, owner, 'partner');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  assignedOnly = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [otherCompany.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  periodId = (await as(owner, 'post', `${base()}/periods`, { startDate: '2026-01-01', endDate: '2026-12-31' })).body.id;
  await as(owner, 'post', `${base()}/periods`, { startDate: '2025-01-01', endDate: '2025-12-31' });
});
afterAll(() => s.stop());

describe('chart of accounts', () => {
  it('is empty at first; the default UK chart initialises once and is read-only for people who may only read', async () => {
    expect((await as(owner, 'get', `${base()}/accounts`)).body.items).toEqual([]);
    expect((await as(bookkeeper, 'post', `${base()}/accounts/initialise`)).status).toBe(403);    // bookkeeper: account:read only
    const init = await as(accountant, 'post', `${base()}/accounts/initialise`);
    expect(init.status).toBe(201);
    expect(init.body.items.length).toBeGreaterThan(50);
    for (const a of init.body.items) acc[a.code] = a.id;
    expect((await as(accountant, 'post', `${base()}/accounts/initialise`)).body.code).toBe('chart_not_empty');
    const ar = init.body.items.find((a: { code: string }) => a.code === '1100');
    expect(ar).toMatchObject({ type: 'ASSET', isControl: true, controlKind: 'TRADE_RECEIVABLES', normalBalance: 'DEBIT', isSystem: true, reportingMappingVersion: 1 });
    expect((await as(bookkeeper, 'get', `${base()}/accounts`)).status).toBe(200);
    expect((await as(viewer, 'get', `${base()}/accounts`)).status).toBe(403);
  });
  it('creates, validates and updates accounts', async () => {
    const mk = (over: object) => as(accountant, 'post', `${base()}/accounts`, { code: '6999', name: 'Training', type: 'EXPENSE', subtype: 'OVERHEADS', reportingMapping: 'PL.ADMIN_EXPENSES', taxTreatment: 'VATABLE', ...over });
    const ok = await mk({});
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ code: '6999', normalBalance: 'DEBIT', isControl: false });
    expect((await mk({})).body.code).toBe('account_code_exists');
    expect((await mk({ code: '6998', subtype: 'SALES' })).status).toBe(422);                               // subtype of another type
    expect((await mk({ code: '6997', reportingMapping: 'PL.TURNOVER' })).status).toBe(422);               // reporting line for another type
    expect((await mk({ code: '6996', reportingMapping: 'PL.NOPE' })).status).toBe(422);
    expect((await mk({ code: '6995', isControl: true })).status).toBe(422);                               // control needs a kind
    expect((await mk({ code: 'bad code!' })).status).toBe(422);
    expect((await mk({ code: '6994', activeFrom: '2026-05-01', activeTo: '2026-01-01' })).status).toBe(422);
    expect((await mk({ code: '6993', extra: 1 })).status).toBe(422);
    const upd = await as(accountant, 'patch', `${base()}/accounts/${ok.body.id}`, { name: 'Staff training' });
    expect(upd.body.name).toBe('Staff training');
    expect((await as(accountant, 'patch', `${base()}/accounts/${ok.body.id}`, { reportingMapping: 'PL.OTHER_EXPENSES' })).body.code).toBe('reason_required');
    const re = await as(accountant, 'patch', `${base()}/accounts/${ok.body.id}`, { reportingMapping: 'PL.OTHER_EXPENSES', reason: 'reclassified after review' });
    expect(re.body.reportingMapping).toBe('PL.OTHER_EXPENSES');
    const audit = (await as(owner, 'get', `/audit-events?entityType=account&entityId=${ok.body.id}`)).body.items;
    expect(audit.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['account.created', 'account.updated']));
    expect(audit.find((e: { action: string; reason: string | null }) => e.action === 'account.updated' && e.reason)).toMatchObject({ reason: 'reclassified after review', before: { reportingMapping: 'PL.ADMIN_EXPENSES' }, after: { reportingMapping: 'PL.OTHER_EXPENSES' } });
    expect((await as(bookkeeper, 'patch', `${base()}/accounts/${ok.body.id}`, { name: 'x' })).status).toBe(403);
  });
});

describe('journals', () => {
  it('posts a balanced manual journal and shows it with lines, source, actor and number', async () => {
    const r = await as(accountant, 'post', `${base()}/journals`, rent('250.50', { reference: 'INV-2026-001' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ journalNumber: 1, sourceType: 'MANUAL', sourceReference: 'INV-2026-001', total: '250.50', lineCount: 2, actorType: 'USER', postedByUserId: accountant.userId, currency: 'GBP', reversesJournalId: null, reversedByJournalId: null, replayed: false });
    expect(r.body.lines).toEqual([
      expect.objectContaining({ lineNo: 1, accountCode: '6100', debit: '250.50', credit: '0.00' }), expect.objectContaining({ lineNo: 2, accountCode: '4000', debit: '0.00', credit: '250.50' })]);
    expect((await as(owner, 'get', `${base()}/journals/${r.body.id}`)).body.id).toBe(r.body.id);
    const list = await as(reviewer, 'get', `${base()}/journals`);
    expect(list.body.items.map((j: { id: string }) => j.id)).toContain(r.body.id);
  });
  it('money is a decimal string: JSON numbers, negatives, too many decimals and unbalanced journals are refused', async () => {
    const post = (b: object) => as(accountant, 'post', `${base()}/journals`, b);
    expect((await post({ ...rent(), lines: [{ accountId: acc['6100'], debit: 100, credit: 0 }, { accountId: acc['4000'], debit: 0, credit: 100 }] })).status).toBe(422);
    expect((await post(rent('-5'))).status).toBe(422);
    expect((await post(rent('10.001'))).body.code).toBe('invalid_amount');
    expect((await post(journal([['6100', '10', '0'], ['4000', '0', '9']]))).body.code).toBe('unbalanced_journal');
    expect((await post(journal([['6100', '10', '0']]))).status).toBe(422);
    expect((await post(rent('10', { source: 'SALES_INVOICE' }))).status).toBe(422);                       // not an API source
    expect((await post(rent('10', { journalDate: '2031-01-01' }))).body.code).toBe('no_period');
    expect((await post(journal([['1100', '10', '0'], ['4000', '0', '10']]))).body.code).toBe('control_account_restricted');
    expect((await post({ ...rent(), unknownField: 1 })).status).toBe(422);
  });
  it('opening balances are the only manual source allowed onto control accounts, and only dated at the very start of record keeping', async () => {
    const lines = [{ accountId: acc['1100'], debit: '500.00', credit: '0' }, { accountId: acc['3000'], debit: '0', credit: '500.00' }];
    const ob = { description: 'Opening debtors', source: 'OPENING_BALANCE', lines };
    expect((await as(accountant, 'post', `${base()}/journals`, { ...ob, journalDate: '2026-03-15' })).body.code).toBe('opening_balance_date_invalid');
    const ok = await as(accountant, 'post', `${base()}/journals`, { ...ob, journalDate: '2025-01-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.sourceType).toBe('OPENING_BALANCE');
    expect((await as(bookkeeper, 'post', `${base()}/journals`, { ...ob, journalDate: '2025-01-01' })).status).toBe(403);
  });
  it('a journal is idempotent by key: the same request twice posts once', async () => {
    const body = rent('12.00', { idempotencyKey: 'api-idem-key-0001' });
    const a = await as(accountant, 'post', `${base()}/journals`, body);
    const b = await as(accountant, 'post', `${base()}/journals`, body);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.replayed).toBe(true);
    expect((await as(accountant, 'post', `${base()}/journals`, { ...body, description: 'different' })).body.code).toBe('idempotency_conflict');
  });
  it('who may post: accountant and partner yes; bookkeeper, reviewer and client viewer no (403); audit records the denial', async () => {
    for (const u of [bookkeeper, reviewer, viewer]) expect((await as(u, 'post', `${base()}/journals`, rent('1.00'))).status).toBe(403);
    expect((await as(partner, 'post', `${base()}/journals`, rent('1.00'))).status).toBe(201);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='access.denied' AND actor_user_id='${bookkeeper.userId}' AND metadata::text LIKE '%journal:post%'`)).not.toBe('0');
  });
  it('company scope: a member assigned to another company cannot see or post here (404), and an outsider cannot touch the organisation', async () => {
    expect((await as(assignedOnly, 'get', `${base()}/journals`)).status).toBe(404);
    expect((await as(assignedOnly, 'post', `${base()}/journals`, rent('1.00'))).status).toBe(404);
    expect((await as(assignedOnly, 'get', `${base()}/accounts`)).status).toBe(404);
    expect((await s.api().get(orgPath(owner, `${base()}/journals`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await as(owner, 'get', `${base()}/journals/${GHOST}`)).status).toBe(404);
  });
  it('posted journals cannot be changed through the API: there is no update or delete route', async () => {
    const j = (await as(accountant, 'post', `${base()}/journals`, rent('3.00'))).body;
    for (const m of ['patch', 'put', 'delete'] as const) expect([404, 405]).toContain((await as(owner, m, `${base()}/journals/${j.id}`, { description: 'x' })).status);
    expect((await as(owner, 'get', `${base()}/journals/${j.id}`)).body.description).toBe('API journal');
  });
});

describe('reversal', () => {
  it('reverses once with a linked mirror journal; both sides show the link; the second attempt and reversing a reversal are refused', async () => {
    const orig = (await as(accountant, 'post', `${base()}/journals`, rent('77.00', { description: 'Wrong period' }))).body;
    const rev = await as(accountant, 'post', `${base()}/journals/${orig.id}/reverse`, { reason: 'Posted to the wrong account', journalDate: '2026-03-20' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ sourceType: 'REVERSAL', sourceId: orig.id, reversesJournalId: orig.id, total: '77.00', reverses: { journalId: orig.id } });
    expect(rev.body.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['6100', '0.00', '77.00'], ['4000', '77.00', '0.00']]);
    expect((await as(owner, 'get', `${base()}/journals/${orig.id}`)).body.reversedByJournalId).toBe(rev.body.id);
    expect((await as(accountant, 'post', `${base()}/journals/${orig.id}/reverse`, { reason: 'again' })).body.code).toBe('already_reversed');
    expect((await as(accountant, 'post', `${base()}/journals/${rev.body.id}/reverse`, { reason: 'undo' })).body.code).toBe('cannot_reverse_reversal');
    expect((await as(accountant, 'post', `${base()}/journals/${orig.id}/reverse`, {})).status).toBe(422);           // reason mandatory
    expect((await as(bookkeeper, 'post', `${base()}/journals/${orig.id}/reverse`, { reason: 'x' })).status).toBe(403);
  });
});

describe('general ledger and trial balance (read the ledger only)', () => {
  it('the trial balance balances and each row drills down to the ledger lines and the journal', async () => {
    const tb = (await as(reviewer, 'get', `${base()}/reports/trial-balance?asOf=2026-12-31`)).body;
    expect(tb).toMatchObject({ balanced: true, currency: 'GBP', asOf: '2026-12-31' });
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const row = tb.rows.find((r: { code: string }) => r.code === '6100');
    expect(Number(row.debit)).toBeGreaterThan(0);
    const gl = await as(reviewer, 'get', `${base()}/ledger?accountId=${row.drilldown.accountId}&to=${row.drilldown.to}&limit=100`);
    expect(gl.status).toBe(200);
    const last = gl.body.items[gl.body.items.length - 1];
    expect(Number(last.balance)).toBeCloseTo(Number(row.debit) - Number(row.credit), 2);
    const j = (await as(reviewer, 'get', `${base()}/journals/${last.journalId}`)).body;
    expect(j.lines.some((l: { accountCode: string }) => l.accountCode === '6100')).toBe(true);
  });
  it('the figures are the sum of the journal lines (an independent SQL check) and a period report carries its movement', async () => {
    const tb = (await as(owner, 'get', `${base()}/reports/trial-balance?periodId=${periodId}`)).body;
    expect(tb.period).toMatchObject({ id: periodId, startDate: '2026-01-01', endDate: '2026-12-31' });
    // independent check straight from the lines: the debit column is the sum of the accounts whose net balance is a debit
    const sqlDebit = adminSql(`SELECT coalesce(sum(GREATEST(d - c, 0)), 0) FROM (SELECT sum(debit) d, sum(credit) c FROM journal_line WHERE company_id='${company.id}' AND account_id IN (SELECT account_id FROM journal_line l JOIN journal j ON j.id=l.journal_id WHERE l.company_id='${company.id}' AND j.journal_date <= '2026-12-31') GROUP BY account_id) x`);
    expect(Number(tb.totalDebit)).toBeCloseTo(Number(sqlDebit), 2);
    expect(tb.rows[0]).toHaveProperty('movementDebit');
    expect((await as(owner, 'get', `${base()}/reports/trial-balance?periodId=${periodId}&asOf=2026-01-01`)).status).toBe(422);
    expect((await as(owner, 'get', `${base()}/reports/trial-balance?periodId=${GHOST}`)).status).toBe(404);
  });
  it('general ledger paging and validation', async () => {
    const id = acc['6100'];
    const p1 = (await as(owner, 'get', `${base()}/ledger?accountId=${id}&limit=2`)).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await as(owner, 'get', `${base()}/ledger?accountId=${id}&limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).body;
    expect(p2.items[0].journalId + p2.items[0].lineNo).not.toBe(p1.items[0].journalId + p1.items[0].lineNo);
    expect((await as(owner, 'get', `${base()}/ledger?accountId=${id}&cursor=garbage`)).status).toBe(422);
    expect((await as(owner, 'get', `${base()}/ledger`)).status).toBe(422);
    expect((await as(owner, 'get', `${base()}/ledger?accountId=${GHOST}`)).status).toBe(404);
  });
});

describe('period controls', () => {
  it('close stops posting, lock needs period:lock, unlock/reopen need reasons, and every step is audited', async () => {
    const pid = (await as(owner, 'get', `${base()}/periods`)).body.items.find((p: { startDate: string }) => p.startDate.startsWith('2025')).id;
    await as(accountant, 'post', `${base()}/journals`, rent('5.00', { journalDate: '2025-06-01' }));
    expect((await as(accountant, 'post', `${base()}/periods/${pid}/close`, {})).body.status).toBe('CLOSED');
    expect((await as(accountant, 'post', `${base()}/journals`, rent('5.00', { journalDate: '2025-06-02' }))).body.code).toBe('period_closed');
    expect((await as(accountant, 'post', `${base()}/periods/${pid}/lock`, { reason: 'signed off' })).status).toBe(403);     // accountant lacks period:lock
    expect((await as(partner, 'post', `${base()}/periods/${pid}/lock`, {})).body.code).toBe('reason_required');
    const locked = await as(partner, 'post', `${base()}/periods/${pid}/lock`, { reason: 'Accounts approved by the partner' });
    expect(locked.body).toMatchObject({ status: 'LOCKED', statusReason: 'Accounts approved by the partner', statusChangedByUserId: partner.userId });
    expect((await as(accountant, 'post', `${base()}/journals`, rent('5.00', { journalDate: '2025-06-02' }))).body.code).toBe('period_locked');
    expect((await as(accountant, 'post', `${base()}/periods/${pid}/reopen`, { reason: 'x' })).body.code).toBe('invalid_period_state');   // must unlock first
    expect((await as(partner, 'post', `${base()}/periods/${pid}/unlock`, { reason: 'Late adjustment' })).body.status).toBe('CLOSED');
    expect((await as(accountant, 'post', `${base()}/periods/${pid}/reopen`, { reason: 'Late adjustment' })).body.status).toBe('OPEN');
    expect((await as(accountant, 'post', `${base()}/journals`, rent('5.00', { journalDate: '2025-06-02' }))).status).toBe(201);
    const actions = (await as(owner, 'get', `/audit-events?entityType=accounting_period&entityId=${pid}&limit=50`)).body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['period.closed', 'period.locked', 'period.unlocked', 'period.reopened']));
    expect((await as(bookkeeper, 'post', `${base()}/periods/${pid}/close`, {})).status).toBe(403);
    expect((await as(owner, 'post', `${base()}/periods/${GHOST}/close`, {})).status).toBe(404);
  });
});

describe('feature flag and contract', () => {
  it('the whole ledger API is behind bookkeeping.core: switched off for the organisation it is a clear 403', async () => {
    await as(owner, 'put', '/feature-flags/bookkeeping.core', { enabled: false, reason: 'test switch-off' });
    for (const [m, p] of [['get', `${base()}/accounts`], ['get', `${base()}/journals`], ['get', `${base()}/reports/trial-balance`], ['post', `${base()}/periods/${GHOST}/close`]] as const) {
      const r = await as(owner, m, p, m === 'post' ? {} : undefined);
      expect([r.status, r.body.code]).toEqual([403, 'feature_disabled']);
    }
    await as(owner, 'delete', '/feature-flags/bookkeeping.core?reason=restored');
    expect((await as(owner, 'get', `${base()}/accounts`)).status).toBe(200);
  });
  it('a client-supplied actor is ignored: the poster is always the signed-in user', async () => {
    const r = await as(accountant, 'post', `${base()}/journals`, { ...rent('2.00'), postedByUserId: partner.userId });
    expect(r.status).toBe(422);                                                                          // strict schema
    const ok = await as(accountant, 'post', `${base()}/journals`, rent('2.00'));
    expect(ok.body.postedByUserId).toBe(accountant.userId);
  });
});
