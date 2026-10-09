import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V1-M2 through the public API: opening balances and control-account adjustments are REQUESTED, approved by a second person per the company's
 * policy, and only then posted by the PostingService. Real roles, tenants, documents and the feature flag.
 */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser, assignedOther: TestUser;
let company: { id: string }, otherCompany: { id: string };
let docs: { main: string; second: string; foreign: string; restricted: string };
const acc: Record<string, string> = {};
const base = (c = company.id) => `/companies/${c}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const lines = (amount: string, debit = '1100', credit = '3000') => [{ accountId: acc[debit], debit: amount, credit: '0' }, { accountId: acc[credit], debit: '0', credit: amount }];
const REASON = 'Brought forward from the prior accountant at takeover';
const ob = (over: object = {}) => ({ journalDate: '2025-01-01', description: 'Opening debtors', reason: REASON, lines: lines('500.00'), evidenceDocumentIds: [docs.main], ...over });
const adj = (over: object = {}) => ({ journalDate: '2026-03-31', description: 'Correct debtors control after import error', reason: 'Import duplicated one invoice; sub-ledger confirmed lower', lines: lines('120.00', '3000', '1100'), evidenceDocumentIds: [docs.main], ...over });
const tbDebtors = async () => {
  const tb = (await as(owner, 'get', `${base()}/reports/trial-balance?asOf=2026-12-31`)).body.rows.find((r: { code: string }) => r.code === '1100');
  return tb ? Number(tb.debit) - Number(tb.credit) : 0;
};
const resetPolicy = (mode = 'ALWAYS', threshold: string | null = null) => as(owner, 'put', `${base()}/ledger-policy`, { openingBalanceApproval: mode, controlAdjustmentApproval: mode, materialityThreshold: threshold, requestExpiryDays: 14, reason: 'Test set-up of the approval policy' });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Controls Client');
  otherCompany = await makeCompany(s, owner, 'Controls Other');
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  assignedOther = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [otherCompany.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  await as(owner, 'post', `${base()}/periods`, { startDate: '2026-01-01', endDate: '2026-12-31' });
  await as(owner, 'post', `${base()}/periods`, { startDate: '2025-01-01', endDate: '2025-12-31' });
  for (const a of (await as(owner, 'post', `${base()}/accounts/initialise`)).body.items) acc[a.code] = a.id;
  const doc = (name: string, companyId: string | null, vis = 'STANDARD', by = owner.userId) => adminSql(`INSERT INTO document(organisation_id,${companyId ? 'company_id,' : ''}name,visibility,created_by_user_id) VALUES ('${owner.organisationId}',${companyId ? `'${companyId}',` : ''}'${name}','${vis}','${by}') RETURNING id`).split('\n')[0]!;
  docs = { main: doc('prior-tb.pdf', company.id), second: doc('support.pdf', company.id), foreign: doc('other-co.pdf', otherCompany.id), restricted: doc('private.pdf', company.id, 'RESTRICTED', partner.userId) };
});
afterAll(() => s.stop());

describe('permissions: four new COMPANY permissions, by role', () => {
  // an empty body: a role that holds the permission passes the guard and fails validation (422); one that does not is refused first (403)
  const probe = (u: TestUser, path: string, method: 'post' | 'put' = 'post') => as(u, method, `${base()}${path}`, {}).then((r) => r.status);
  const cases: [string, () => TestUser, string, 'post' | 'put', boolean][] = [
    ['owner', () => owner, '/opening-balance-requests', 'post', true], ['admin', () => admin, '/opening-balance-requests', 'post', true], ['partner', () => partner, '/opening-balance-requests', 'post', true],
    ['manager', () => manager, '/opening-balance-requests', 'post', false], ['accountant', () => accountant, '/opening-balance-requests', 'post', false],
    ['bookkeeper', () => bookkeeper, '/opening-balance-requests', 'post', false], ['reviewer', () => reviewer, '/opening-balance-requests', 'post', false], ['client_viewer', () => viewer, '/opening-balance-requests', 'post', false],
    ['owner', () => owner, '/control-adjustment-requests', 'post', true], ['partner', () => partner, '/control-adjustment-requests', 'post', true], ['accountant', () => accountant, '/control-adjustment-requests', 'post', true],
    ['manager', () => manager, '/control-adjustment-requests', 'post', false], ['bookkeeper', () => bookkeeper, '/control-adjustment-requests', 'post', false], ['reviewer', () => reviewer, '/control-adjustment-requests', 'post', false],
    ['owner', () => owner, '/journal-requests/11111111-1111-4111-8111-111111111111/approve', 'post', true], ['partner', () => partner, '/journal-requests/11111111-1111-4111-8111-111111111111/approve', 'post', true],
    ['accountant', () => accountant, '/journal-requests/11111111-1111-4111-8111-111111111111/approve', 'post', false], ['manager', () => manager, '/journal-requests/11111111-1111-4111-8111-111111111111/reject', 'post', false],
    ['owner', () => owner, '/ledger-policy', 'put', true], ['admin', () => admin, '/ledger-policy', 'put', true], ['partner', () => partner, '/ledger-policy', 'put', true],
    ['accountant', () => accountant, '/ledger-policy', 'put', false], ['manager', () => manager, '/ledger-policy', 'put', false], ['bookkeeper', () => bookkeeper, '/ledger-policy', 'put', false],
  ];
  for (const [role, who, path, method, allowed] of cases) {
    it(`${role} ${allowed ? 'may' : 'may not'} ${method.toUpperCase()} ${path.replace(/[0-9a-f-]{36}/, '{id}')}`, async () => {
      const status = await probe(who(), path, method);
      if (allowed) expect([status, 'not 403']).not.toContain(403); else expect(status).toBe(403);
    });
  }
  it('reading requests and the policy needs ledger:read (accountant, bookkeeper, reviewer yes; client viewer no)', async () => {
    for (const u of [owner, accountant, bookkeeper, reviewer]) { expect((await as(u, 'get', `${base()}/journal-requests`)).status).toBe(200); expect((await as(u, 'get', `${base()}/ledger-policy`)).status).toBe(200); }
    expect((await as(viewer, 'get', `${base()}/journal-requests`)).status).toBe(403);
  });
  it('holding only journal:post is no longer enough for an opening balance (behaviour change by design)', async () => {
    expect((await as(accountant, 'post', `${base()}/opening-balance-requests`, ob())).status).toBe(403);
    expect((await as(accountant, 'post', `${base()}/journals`, { description: 'x', journalDate: '2025-01-01', source: 'OPENING_BALANCE', lines: lines('5') })).status).toBe(422);
  });
  it('permission is checked for the company in the path: a member assigned only to another company is refused, an outsider cannot see the organisation', async () => {
    // a company the member is not assigned to is hidden (404), exactly as for the other company-scoped routes
    expect((await as(assignedOther, 'post', `${base()}/control-adjustment-requests`, adj())).status).toBe(404);
    expect((await as(assignedOther, 'get', `${base()}/journal-requests`)).status).toBe(404);
    expect((await s.api().get(orgPath(owner, `${base()}/journal-requests`)).set(bearer(outsider.token))).status).toBe(404);
  });
});

describe('opening balance: request -> second-person approval -> posting', () => {
  let reqId: string;
  it('creates a pending request: validated like a journal but NOT posted; the trial balance and ledger ignore it', async () => {
    const before = await tbDebtors();
    const r = await as(owner, 'post', `${base()}/opening-balance-requests`, ob());
    expect(r.status).toBe(201);
    reqId = r.body.id;
    expect(r.body).toMatchObject({ kind: 'OPENING_BALANCE', status: 'PENDING', approvalRequired: true, selfApproved: false, total: '500.00', requestedByUserId: owner.userId, postedJournalId: null, journalDate: '2025-01-01' });
    expect(r.body.policySnapshot).toMatchObject({ openingBalanceApproval: 'ALWAYS', policyIsDefault: true });
    expect(await tbDebtors()).toBe(before);
    expect(adminSql(`SELECT count(*) FROM journal WHERE company_id='${company.id}' AND source_type='OPENING_BALANCE'`)).toBe('0');
    expect((await as(reviewer, 'get', `${base()}/journal-requests?status=PENDING`)).body.items.map((i: { id: string }) => i.id)).toContain(reqId);
  });
  it('the requester cannot approve their own request - in the service and in the database', async () => {
    const r = await as(owner, 'post', `${base()}/journal-requests/${reqId}/approve`, {});
    expect([r.status, r.body.code]).toEqual([403, 'self_approval_not_allowed']);
    expect(adminSql(`SELECT status FROM journal_request WHERE id='${reqId}'`)).toBe('PENDING');
    // below the service: the database refuses the status change and the journal even for the table owner
    expect(() => adminSql(`UPDATE journal_request SET status='APPROVED', decided_by_user_id=requested_by_user_id, decided_at=now(), posted_journal_id=gen_random_uuid() WHERE id='${reqId}'`)).toThrow();
  });
  it('a person without ledger:approve cannot approve (accountant), an AI/unknown request id is a 404', async () => {
    expect((await as(accountant, 'post', `${base()}/journal-requests/${reqId}/approve`, {})).status).toBe(403);
    expect((await as(partner, 'post', `${base()}/journal-requests/11111111-1111-4111-8111-111111111111/approve`, {})).status).toBe(404);
  });
  it('a different approver posts it: journal with number, source OPENING_BALANCE, requester/approver recorded, evidence linked, request APPROVED', async () => {
    const r = await as(partner, 'post', `${base()}/journal-requests/${reqId}/approve`, { comment: 'Agrees to the prior-period trial balance' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'APPROVED', decidedByUserId: partner.userId, postedJournalId: expect.any(String) });
    const j = (await as(owner, 'get', `${base()}/journals/${r.body.postedJournalId}`)).body;
    expect(j).toMatchObject({ sourceType: 'OPENING_BALANCE', sourceId: reqId, requestId: reqId, requestedByUserId: owner.userId, approvedByUserId: partner.userId, postedByUserId: partner.userId, total: '500.00' });
    expect(await tbDebtors()).toBe(500);
    expect(adminSql(`SELECT count(*) FROM evidence_link WHERE source_type='journal' AND source_id='${j.id}' AND target_type='document' AND target_id='${docs.main}' AND revoked_at IS NULL`)).toBe('1');
  });
  it('is audited end to end (requested, approved, posted) with reason, before/after and both people', async () => {
    const ev = (await as(owner, 'get', `/audit-events?entityType=journal_request&entityId=${reqId}`)).body.items;
    expect(ev.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['ledger.request_created', 'ledger.request_approved']));
    const created = ev.find((e: { action: string }) => e.action === 'ledger.request_created');
    expect(created).toMatchObject({ actorUserId: owner.userId, reason: REASON });
    const approved = ev.find((e: { action: string }) => e.action === 'ledger.request_approved');
    expect(approved).toMatchObject({ actorUserId: partner.userId, before: { status: 'PENDING' }, after: expect.objectContaining({ status: 'APPROVED' }) });
    const jid = (await as(owner, 'get', `${base()}/journal-requests/${reqId}`)).body.postedJournalId;
    const posted = (await as(owner, 'get', `/audit-events?entityType=journal&entityId=${jid}`)).body.items.find((e: { action: string }) => e.action === 'journal.posted');
    expect(posted.metadata).toMatchObject({ requestId: reqId, requestedBy: owner.userId, approvedBy: partner.userId, selfApproved: false });
  });
  it('a decided request is final: approve/reject/cancel again is a 409 and posts nothing twice', async () => {
    for (const action of ['approve', 'reject', 'cancel']) {
      const r = await as(action === 'cancel' ? owner : partner, 'post', `${base()}/journal-requests/${reqId}/${action}`, action === 'reject' ? { reason: 'too late' } : {});
      expect([r.status, r.body.code]).toEqual([409, 'request_not_pending']);
    }
    expect(adminSql(`SELECT count(*) FROM journal WHERE request_id='${reqId}'`)).toBe('1');
  });
  it('the approved opening balance is reversible, and the reversal links to it', async () => {
    const jid = (await as(owner, 'get', `${base()}/journal-requests/${reqId}`)).body.postedJournalId;
    const rev = await as(owner, 'post', `${base()}/journals/${jid}/reverse`, { reason: 'Opening balance was for the wrong entity', journalDate: '2026-01-02' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ sourceType: 'REVERSAL', reversesJournalId: jid });
    expect(await tbDebtors()).toBe(0);
    expect((await as(owner, 'get', `${base()}/journals/${jid}`)).body.reversedByJournalId).toBe(rev.body.id);
  });
});

describe('validation: nothing invalid ever becomes a pending request', () => {
  const post = (body: object, u = owner) => as(u, 'post', `${base()}/opening-balance-requests`, body);
  const code = async (body: object, u = owner) => { const r = await post(body, u); return [r.status, r.body.code ?? r.body.title] as const; };
  it('unbalanced, one line, zero, negative, foreign currency, unknown account, another company\'s account', async () => {
    expect((await code(ob({ lines: [{ accountId: acc['1100'], debit: '500', credit: '0' }, { accountId: acc['3000'], debit: '0', credit: '400' }] })))[1]).toBe('unbalanced_journal');
    expect((await post(ob({ lines: [{ accountId: acc['1100'], debit: '500', credit: '0' }] }))).status).toBe(422);
    expect((await post(ob({ lines: lines('0') }))).status).toBe(422);
    expect((await post(ob({ lines: lines('-5') }))).status).toBe(422);
    expect((await code(ob({ currency: 'USD' })))).toEqual([422, 'foreign_currency_not_supported']);
    expect((await code(ob({ lines: [{ accountId: '11111111-1111-4111-8111-111111111111', debit: '5', credit: '0' }, { accountId: acc['3000'], debit: '0', credit: '5' }] })))[1]).toBe('unknown_account');
    const other = (await as(owner, 'post', `/companies/${otherCompany.id}/accounts/initialise`)).body.items.find((a: { code: string }) => a.code === '3000').id;
    expect((await code(ob({ lines: [{ accountId: acc['1100'], debit: '5', credit: '0' }, { accountId: other, debit: '0', credit: '5' }] })))[1]).toBe('unknown_account');
  });
  it('wrong date for an opening balance, no period, closed period', async () => {
    expect((await code(ob({ journalDate: '2026-03-15' })))[1]).toBe('opening_balance_date_invalid');
    expect((await code(ob({ journalDate: '2031-01-01' })))[1]).toBe('no_period');
    const p = (await as(owner, 'get', `${base()}/periods`)).body.items?.find((x: { startDate: string }) => x.startDate === '2025-01-01');
    const pid = p?.id ?? adminSql(`SELECT id FROM accounting_period WHERE company_id='${company.id}' AND start_date='2025-01-01'`);
    expect((await as(owner, 'post', `${base()}/periods/${pid}/close`, {})).status).toBe(200);
    expect((await code(ob()))[1]).toBe('period_closed');
    expect((await as(owner, 'post', `${base()}/periods/${pid}/reopen`, { reason: 'Re-opened to enter the opening balances' })).status).toBe(200);
  });
  it('reason of at least 20 characters; evidence required when approval is needed; evidence must exist, belong to the company and be readable', async () => {
    expect((await post(ob({ reason: 'too short' }))).status).toBe(422);
    expect((await code(ob({ evidenceDocumentIds: [] })))[1]).toBe('evidence_required');
    expect((await code(ob({ evidenceDocumentIds: ['11111111-1111-4111-8111-111111111111'] })))[1]).toBe('invalid_evidence');
    expect((await code(ob({ evidenceDocumentIds: [docs.foreign] })))[1]).toBe('invalid_evidence');
    expect((await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ evidenceDocumentIds: [docs.restricted] }))).body.code).toBe('invalid_evidence');    // restricted to its creator: indistinguishable from missing
    expect((await post({ ...ob(), unknown: 1 })).status).toBe(422);
  });
  it('a control adjustment needs evidence, must touch a control account, and MANUAL journals are still refused on control accounts', async () => {
    const a = (body: object) => as(accountant, 'post', `${base()}/control-adjustment-requests`, body);
    expect((await a(adj({ evidenceDocumentIds: [] }))).body.code).toBe('evidence_required');
    expect((await a(adj({ lines: lines('50', '6100', '4000') }))).body.code).toBe('no_control_account');
    expect((await as(accountant, 'post', `${base()}/journals`, { journalDate: '2026-03-31', description: 'manual on control', lines: lines('10', '3000', '1100') })).body.code).toBe('control_account_restricted');
  });
  it('failed validation leaves no request behind', async () => {
    const before = adminSql(`SELECT count(*) FROM journal_request WHERE company_id='${company.id}'`);
    await post(ob({ lines: lines('0') })); await post(ob({ journalDate: '2026-03-15' }));
    expect(adminSql(`SELECT count(*) FROM journal_request WHERE company_id='${company.id}'`)).toBe(before);
  });
});

describe('control-account adjustment', () => {
  let id: string;
  it('an accountant requests, a partner approves; the adjustment posts to the control account with the evidence linked', async () => {
    await as(owner, 'put', `${base()}/ledger-policy`, { openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14, reason: 'Reset policy for the adjustment tests' });
    // some debtors to adjust: an approved opening balance
    const o = await as(owner, 'post', `${base()}/opening-balance-requests`, ob({ description: 'Opening debtors (2)' }));
    expect((await as(partner, 'post', `${base()}/journal-requests/${o.body.id}/approve`, {})).status).toBe(200);
    const before = await tbDebtors();
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ evidenceDocumentIds: [docs.main, docs.second] }));
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ kind: 'CONTROL_ADJUSTMENT', status: 'PENDING', requestedByUserId: accountant.userId });
    expect(await tbDebtors()).toBe(before);                                                              // pending: not a ledger entry
    expect((await as(accountant, 'post', `${base()}/journal-requests/${id}/approve`, {})).status).toBe(403);
    const ok = await as(partner, 'post', `${base()}/journal-requests/${id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(await tbDebtors()).toBe(before - 120);
    const j = (await as(owner, 'get', `${base()}/journals/${ok.body.postedJournalId}`)).body;
    expect(j).toMatchObject({ sourceType: 'CONTROL_ADJUSTMENT', requestId: id, requestedByUserId: accountant.userId, approvedByUserId: partner.userId });
    expect(adminSql(`SELECT count(*) FROM evidence_link WHERE source_type='journal' AND source_id='${j.id}' AND revoked_at IS NULL`)).toBe('2');
  });
  it('a period closed between request and approval refuses the approval and leaves the request pending', async () => {
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ journalDate: '2026-04-30', description: 'Adjustment to be blocked' }));
    expect(r.status).toBe(201);
    const pid = adminSql(`SELECT id FROM accounting_period WHERE company_id='${company.id}' AND start_date='2026-01-01'`);
    expect((await as(owner, 'post', `${base()}/periods/${pid}/close`, {})).status).toBe(200);
    const blocked = await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {});
    expect([blocked.status, blocked.body.code]).toEqual([422, 'period_closed']);
    expect(adminSql(`SELECT status FROM journal_request WHERE id='${r.body.id}'`)).toBe('PENDING');
    expect(adminSql(`SELECT count(*) FROM journal WHERE request_id='${r.body.id}'`)).toBe('0');
    expect((await as(owner, 'post', `${base()}/periods/${pid}/reopen`, { reason: 'Re-opened to continue the control tests' })).status).toBe(200);
    expect((await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {})).status).toBe(200);
  });
  it('an approved adjustment is corrected by a reversal, never edited', async () => {
    const jid = (await as(owner, 'get', `${base()}/journal-requests/${id}`)).body.postedJournalId;
    const rev = await as(accountant, 'post', `${base()}/journals/${jid}/reverse`, { reason: 'Adjustment was entered against the wrong control account', journalDate: '2026-05-01' });
    expect(rev.status).toBe(201);
    expect(rev.body.reversesJournalId).toBe(jid);
    expect(() => adminSql(`UPDATE journal SET description='tampered' WHERE id='${jid}'`)).toThrow();
  });
});

describe('reject, cancel and expiry leave the ledger untouched', () => {
  it('reject needs a reason and ledger:approve; the requester is not required to be different', async () => {
    const before = await tbDebtors();
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: 'To be rejected' }));
    expect((await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/reject`, {})).status).toBe(422);
    expect((await as(accountant, 'post', `${base()}/journal-requests/${r.body.id}/reject`, { reason: 'x' })).status).toBe(403);
    const rej = await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/reject`, { reason: 'Evidence does not support this adjustment' });
    expect(rej.body).toMatchObject({ status: 'REJECTED', decisionReason: 'Evidence does not support this adjustment', decidedByUserId: partner.userId, postedJournalId: null });
    expect(await tbDebtors()).toBe(before);
    const audit = (await as(owner, 'get', `/audit-events?entityType=journal_request&entityId=${r.body.id}`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toContain('ledger.request_rejected');
  });
  it('only the requester can cancel their own pending request', async () => {
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: 'To be cancelled' }));
    expect((await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/cancel`, {})).status).toBe(403);
    const c = await as(accountant, 'post', `${base()}/journal-requests/${r.body.id}/cancel`, { comment: 'Raised in error' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', decidedByUserId: accountant.userId, postedJournalId: null });
    expect((await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {})).body.code).toBe('request_not_pending');
  });
  it('an expired request cannot be approved (service and database), and is listed as expired', async () => {
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: 'Left too long' }));
    adminSql(`SET session_replication_role = replica; UPDATE journal_request SET requested_at = now() - interval '20 days', expires_at = now() - interval '6 days' WHERE id='${r.body.id}'`);
    const a = await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {});
    expect([a.status, a.body.code]).toEqual([409, 'request_expired']);
    expect((await as(owner, 'get', `${base()}/journal-requests/${r.body.id}`)).body).toMatchObject({ status: 'PENDING', effectiveStatus: 'EXPIRED' });
  });
});

describe('concurrency and notification', () => {
  const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 15000): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
  it('concurrent approvals of one request post exactly one journal (the others see it was decided)', async () => {
    await resetPolicy();
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: 'Concurrent approvals', lines: lines('33.00', '3000', '1100') }));
    const results = await Promise.all([partner, admin, owner, partner, admin].map((u) => as(u, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {})));
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status !== 200).every((x) => [409, 422].includes(x.status))).toBe(true);
    expect(adminSql(`SELECT count(*) FROM journal WHERE request_id='${r.body.id}'`)).toBe('1');
    expect(adminSql(`SELECT status FROM journal_request WHERE id='${r.body.id}'`)).toBe('APPROVED');
  });
  it('approve vs reject vs cancel at the same time: exactly one outcome, and a loser never leaves a journal behind', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: `Race ${i}`, lines: lines('21.00', '3000', '1100') }));
      const [a, rj, c] = await Promise.all([
        as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {}),
        as(admin, 'post', `${base()}/journal-requests/${r.body.id}/reject`, { reason: 'Racing rejection' }),
        as(accountant, 'post', `${base()}/journal-requests/${r.body.id}/cancel`, {}),
      ]);
      expect([a, rj, c].filter((x) => x.status === 200)).toHaveLength(1);
      const status = adminSql(`SELECT status FROM journal_request WHERE id='${r.body.id}'`);
      expect(adminSql(`SELECT count(*) FROM journal WHERE request_id='${r.body.id}'`)).toBe(status === 'APPROVED' ? '1' : '0');
    }
  });
  it('the requester is notified of the decision, without amounts', async () => {
    const r = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ description: 'Notify me', lines: lines('77.00', '3000', '1100') }));
    await as(partner, 'post', `${base()}/journal-requests/${r.body.id}/approve`, {});
    const n = await until(async () => (await as(accountant, 'get', '/notifications')).body.items.find((x: { entityId: string; type: string }) => x.entityId === r.body.id));
    expect(n).toMatchObject({ type: 'ledger.request_approved', entityType: 'journal_request' });
    expect(JSON.stringify(n)).not.toMatch(/77\.00/);
    // the approver is not notified of their own action
    expect((await as(partner, 'get', '/notifications')).body.items.find((x: { entityId: string }) => x.entityId === r.body.id)).toBeUndefined();
  });
});

describe('approval policy: threshold, defaults and audit', () => {
  const put = (body: object, u = owner, c = company.id) => as(u, 'put', `${base(c)}/ledger-policy`, body);
  const good = { openingBalanceApproval: 'ABOVE_THRESHOLD', controlAdjustmentApproval: 'ABOVE_THRESHOLD', materialityThreshold: '1000.00', requestExpiryDays: 14, reason: 'Board agreed materiality for second-person approval' };
  it('defaults to approval always with a 14-day expiry when nothing is configured', async () => {
    const p = await as(reviewer, 'get', `${base(otherCompany.id)}/ledger-policy`);
    expect(p.body).toMatchObject({ isDefault: true, openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14 });
  });
  it('changing the policy needs ledger:policy and a reason, and is validated; there is deliberately no "never approve" mode', async () => {
    expect((await put(good, accountant)).status).toBe(403);
    expect((await put({ ...good, reason: undefined })).status).toBe(422);
    expect((await put({ ...good, reason: 'short' })).status).toBe(422);
    expect((await put({ ...good, materialityThreshold: null })).status).toBe(422);
    expect((await put({ ...good, materialityThreshold: '0' })).status).toBe(422);
    expect((await put({ ...good, requestExpiryDays: 0 })).status).toBe(422);
    expect((await put({ ...good, requestExpiryDays: 91 })).status).toBe(422);
    expect((await put({ ...good, openingBalanceApproval: 'NEVER' })).status).toBe(422);
  });
  it('is audited with before/after and the reason', async () => {
    const before = (await as(owner, 'get', `${base()}/ledger-policy`)).body;
    const r = await put(good, partner);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isDefault: false, openingBalanceApproval: 'ABOVE_THRESHOLD', materialityThreshold: '1000.00', updatedByUserId: partner.userId });
    const ev = (await as(owner, 'get', `/audit-events?entityType=ledger_policy&entityId=${company.id}`)).body.items.filter((e: { action: string }) => e.action === 'ledger.policy_changed');
    const last = ev[0];
    expect(last).toMatchObject({ actorUserId: partner.userId, reason: good.reason, after: { openingBalanceApproval: 'ABOVE_THRESHOLD', materialityThreshold: '1000.00' } });
    expect(last.before).toMatchObject({ openingBalanceApproval: before.openingBalanceApproval });
  });
  it('threshold boundary: equal to the threshold is NOT above it (posts at once, self-approved); one penny above needs a second person', async () => {
    const equal = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ lines: lines('1000.00', '3000', '1100'), description: 'At threshold' }));
    expect(equal.body).toMatchObject({ status: 'APPROVED', approvalRequired: false, selfApproved: true, decidedByUserId: accountant.userId, requestedByUserId: accountant.userId, postedJournalId: expect.any(String) });
    const j = (await as(owner, 'get', `${base()}/journals/${equal.body.postedJournalId}`)).body;
    expect(j).toMatchObject({ sourceType: 'CONTROL_ADJUSTMENT', requestedByUserId: accountant.userId, approvedByUserId: accountant.userId });
    const above = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ lines: lines('1000.01', '3000', '1100'), description: 'Just above threshold' }));
    expect(above.body).toMatchObject({ status: 'PENDING', approvalRequired: true, selfApproved: false, postedJournalId: null });
    expect(above.body.policySnapshot).toMatchObject({ materialityThreshold: '1000.00', approvalRequired: true });
  });
  it('exemption never waives permission, reason or evidence (a control adjustment still needs a document; a bookkeeper still cannot ask)', async () => {
    expect((await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ evidenceDocumentIds: [], lines: lines('10.00', '3000', '1100') }))).body.code).toBe('evidence_required');
    expect((await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ reason: 'too short', lines: lines('10.00', '3000', '1100') }))).status).toBe(422);
    expect((await as(bookkeeper, 'post', `${base()}/control-adjustment-requests`, adj({ lines: lines('10.00', '3000', '1100') }))).status).toBe(403);
    // an exempt opening balance needs no second person and (when no approval is needed) no evidence
    const ok = await as(owner, 'post', `${base()}/opening-balance-requests`, ob({ lines: lines('999.99'), evidenceDocumentIds: [], description: 'Small opening balance' }));
    expect(ok.body).toMatchObject({ status: 'APPROVED', selfApproved: true });
  });
  it('the policy in force when a request was made is what applies to it: tightening later does not retroactively exempt, loosening does not exempt a pending one', async () => {
    const pending = await as(accountant, 'post', `${base()}/control-adjustment-requests`, adj({ lines: lines('2000.00', '3000', '1100'), description: 'Pending under threshold policy' }));
    expect(pending.body.status).toBe('PENDING');
    await resetPolicy();
    await put({ ...good, materialityThreshold: '1000000.00', reason: 'Loosened to test snapshot behaviour' });
    expect((await as(accountant, 'post', `${base()}/journal-requests/${pending.body.id}/approve`, {})).status).toBe(403);     // still needs a second person
    expect((await as(partner, 'post', `${base()}/journal-requests/${pending.body.id}/approve`, {})).status).toBe(200);
    await resetPolicy();
  });
});

describe('evidence graph', () => {
  it('a posted journal is an evidence end: its request documents are linked, and a person without ledger:read cannot link or read it', async () => {
    const o = await as(owner, 'post', `${base()}/opening-balance-requests`, ob({ description: 'Evidence graph opening' }));
    const done = await as(partner, 'post', `${base()}/journal-requests/${o.body.id}/approve`, {});
    const jid = done.body.postedJournalId;
    const links = await as(owner, 'get', `/evidence-links?entityType=journal&entityId=${jid}`);
    expect(links.status).toBe(200);
    expect(links.body.items.map((l: { targetId: string; kind: string }) => `${l.kind}:${l.targetId}`)).toContain(`SUPPORTS:${docs.main}`);
    expect((await as(viewer, 'get', `/evidence-links?entityType=journal&entityId=${jid}`)).status).toBe(403);
  });
});

describe('tenant and company isolation', () => {
  it('a request is invisible through another company\'s path and to another organisation; ids do not leak across tenants', async () => {
    const r = await as(owner, 'post', `${base()}/control-adjustment-requests`, adj({ lines: lines('15.00', '3000', '1100'), description: 'Isolation probe' }));
    expect(r.status).toBe(201);
    expect((await as(owner, 'get', `${base(otherCompany.id)}/journal-requests/${r.body.id}`)).status).toBe(404);
    expect((await as(partner, 'post', `${base(otherCompany.id)}/journal-requests/${r.body.id}/approve`, {})).status).toBe(404);
    expect((await as(owner, 'get', `${base(otherCompany.id)}/journal-requests`)).body.items.map((i: { id: string }) => i.id)).not.toContain(r.body.id);
    expect((await s.api().get(orgPath(outsider, `${base()}/journal-requests/${r.body.id}`)).set(bearer(outsider.token))).status).toBe(404);
    expect(adminSql(`SELECT count(*) FROM journal_request WHERE id='${r.body.id}' AND company_id='${company.id}'`)).toBe('1');
  });
  it('the whole feature sits behind bookkeeping.core (flag is on in the test stack; the route table is covered by feature-flags.test.ts)', async () => {
    expect((await as(owner, 'get', `${base()}/journal-requests`)).status).toBe(200);
  });
});
