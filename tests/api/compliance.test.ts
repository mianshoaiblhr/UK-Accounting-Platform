import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, type Stack, type TestUser } from '../helpers/stack';

/**
 * V7-M1 through the public API (DEC-088): deadline rules verified by a second person, generation from a client's periods, VAT settings and
 * confirmation date, versioned updates, the practice-wide views over the clients a person may read, permissions and tenancy.
 * Every rule here is a SYNTHETIC fixture with a synthetic source; nothing asserts the law.
 */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let assigned: TestUser;
let company: { id: string }, other: { id: string }, trader: { id: string };
const acc: Record<string, string> = {};
const GHOST = '11111111-1111-4111-8111-111111111111';
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const c = (p: string, id = company.id) => `/companies/${id}/compliance${p}`;
const SOURCE = { url: 'https://example.invalid/synthetic-deadline', provision: 'Synthetic Filing Act 2026 s.1 (test fixture)', retrievedOn: '2026-01-01' };
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const rule = (o: object) => ({ kind: 'ACCOUNTS_FILING', legalForms: ['LTD'], months: 9, monthEndRule: true, effectiveFrom: '2000-01-01', source: SOURCE, ...o });

beforeAll(async () => {
  s = await startStack({ FEATURE_FLAG_DEFAULTS: 'bookkeeping.core=true,practice.management=true' });
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Calendar Client Ltd');
  other = await makeCompany(s, owner, 'Second Client Ltd');
  trader = await makeCompany(s, owner, 'Sole Trader Client');
  expect((await as(owner, 'patch', `/companies/${trader.id}`, { legalForm: 'SOLE_TRADER' })).status).toBe(200);
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  assigned = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [company.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [start, end] of [['2024-01-01', '2024-12-31'], ['2025-01-01', '2025-12-31']]) {
    expect((await as(owner, 'post', `/companies/${company.id}/periods`, { startDate: start, endDate: end })).status).toBe(201);
    expect((await as(owner, 'post', `/companies/${trader.id}/periods`, { startDate: start, endDate: end })).status).toBe(201);
  }
  for (const a of (await as(owner, 'post', `/companies/${company.id}/accounts/initialise`)).body.items) acc[a.code] = a.id;
  const vat = await as(owner, 'put', `/companies/${company.id}/vat-settings`, { registered: true, vrn: 'GB123456789', registeredFrom: '2025-02-01', anchorPeriodEnd: '2025-03-31',
    outputAccountId: acc['2200'], inputAccountId: acc['2200'], reason: 'Registered from 1 February (synthetic)' });
  expect(vat.status).toBe(200);
});
afterAll(() => s.stop());

describe('permissions (DEC-088)', () => {
  it('rules: owner and admin manage and verify; nobody else', async () => {
    for (const u of [partner, manager, accountant, bookkeeper, reviewer, viewer]) {
      expect((await as(u, 'post', '/compliance/deadline-rules', rule({}))).status).toBe(403);
      expect((await as(u, 'post', `/compliance/deadline-rules/${GHOST}/verify`, { notes: 'Checked against the source' })).status).toBe(403);
    }
    for (const u of [owner, admin]) expect((await as(u, 'post', `/compliance/deadline-rules/${GHOST}/verify`, { notes: 'Checked against the source' })).status).toBe(404);
  });
  it('obligations: partner, manager, accountant manage; bookkeeper and reviewer read; a client viewer cannot read; another organisation cannot see the client', async () => {
    for (const u of [partner, manager, accountant]) expect((await as(u, 'post', c('/obligations'), {})).status).toBe(422);
    for (const u of [bookkeeper, reviewer]) {
      expect((await as(u, 'get', c('/obligations'))).status).toBe(200);
      expect((await as(u, 'post', c('/obligations'), {})).status).toBe(403);
    }
    expect((await as(viewer, 'get', c('/obligations'))).status).toBe(403);
    expect((await as(viewer, 'get', '/compliance/obligations')).status).toBe(403);
    expect((await s.api().get(orgPath(owner, c('/obligations'))).set(bearer(outsider.token))).status).toBe(404);
  });
});

describe('deadline rules (the DEC-021 pattern)', () => {
  let first: string, second: string;
  it('an owner adds a sourced rule; it starts UNVERIFIED; a bad source or a zero offset is refused', async () => {
    const r = await as(owner, 'post', '/compliance/deadline-rules', rule({ effectiveTo: '2025-06-30' }));
    expect(r.status).toBe(201);
    first = r.body.id;
    expect(r.body).toMatchObject({ kind: 'ACCOUNTS_FILING', legalForms: ['LTD'], months: 9, monthEndRule: true, verificationStatus: 'UNVERIFIED', enteredByUserId: owner.userId, source: SOURCE });
    expect((await as(owner, 'post', '/compliance/deadline-rules', rule({ source: { ...SOURCE, url: 'nope' } }))).status).toBe(422);
    expect((await as(owner, 'post', '/compliance/deadline-rules', rule({ months: 0 }))).status).toBe(422);
  });
  it('an overlapping current version of the same kind for a shared legal form is refused; another legal form is not', async () => {
    const o = await as(admin, 'post', '/compliance/deadline-rules', rule({ effectiveFrom: '2025-01-01', legalForms: ['LTD', 'LLP'] }));
    expect([o.status, o.body.code]).toEqual([409, 'deadline_rule_overlap']);
    expect((await as(admin, 'post', '/compliance/deadline-rules', rule({ legalForms: ['LLP'] }))).status).toBe(201);
  });
  it('the person who entered a rule cannot verify it; a different holder can, once', async () => {
    const self = await as(owner, 'post', `/compliance/deadline-rules/${first}/verify`, { notes: 'Checked against the synthetic source' });
    expect([self.status, self.body.code]).toEqual([403, 'self_verification_not_allowed']);
    const v = await as(admin, 'post', `/compliance/deadline-rules/${first}/verify`, { notes: 'Checked against the synthetic source' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: admin.userId });
    expect((await as(admin, 'post', `/compliance/deadline-rules/${first}/verify`, { notes: 'Checked against the synthetic source' })).body.code).toBe('already_verified');
  });
  it('a change is a new UNVERIFIED version; the old one cannot be verified or superseded again', async () => {
    const n = await as(owner, 'post', '/compliance/deadline-rules', rule({ effectiveFrom: '2025-07-01' }));
    expect(n.status).toBe(201);
    const sup = await as(owner, 'post', `/compliance/deadline-rules/${n.body.id}/supersede`, rule({ effectiveFrom: '2025-07-01', reason: 'Corrected the month-end treatment' }));
    expect(sup.status).toBe(201);
    second = sup.body.id;
    expect(sup.body.verificationStatus).toBe('UNVERIFIED');
    expect((await as(admin, 'post', `/compliance/deadline-rules/${n.body.id}/verify`, { notes: 'Checked against the synthetic source' })).body.code).toBe('deadline_rule_superseded');
    expect((await as(owner, 'post', `/compliance/deadline-rules/${n.body.id}/supersede`, rule({ effectiveFrom: '2025-07-01', reason: 'Another correction of it' }))).body.code).toBe('deadline_rule_superseded');
    const list = (await as(reviewer, 'get', '/compliance/deadline-rules')).body.items.map((r: { id: string }) => r.id);
    expect(list).toContain(second);
    expect(list).not.toContain(n.body.id);
    expect((await as(reviewer, 'get', '/compliance/deadline-rules?includeSuperseded=true')).body.items.map((r: { id: string }) => r.id)).toContain(n.body.id);
  });
  it('the database keeps a version immutable and verification one-way', () => {
    expect(() => adminSql(`UPDATE deadline_rule SET months = 3 WHERE id = '${first}'`)).toThrow(/immutable/);
    expect(() => adminSql(`UPDATE deadline_rule SET verification_status = 'UNVERIFIED', verified_by_user_id = NULL, verified_at = NULL WHERE id = '${first}'`)).toThrow(/verified once/);
    expect(() => adminSql(`DELETE FROM deadline_rule WHERE id = '${first}'`)).toThrow(/not permitted/);
  });
  it('generation uses only verified versions and reports what it skipped; once verified, it creates; a rerun creates nothing new', async () => {
    for (const r of [rule({ kind: 'CT_PAYMENT', daysBeforeMonths: 1, months: 9, monthEndRule: false }), rule({ kind: 'CT_RETURN', months: 12 }),
      rule({ kind: 'VAT_RETURN', legalForms: ['LTD', 'SOLE_TRADER'], months: 1, daysAfterMonths: 7 }), rule({ kind: 'CONFIRMATION_STATEMENT', months: 0, monthEndRule: false, daysAfterMonths: 14 })]) {
      const added = await as(owner, 'post', '/compliance/deadline-rules', r);
      expect(added.status).toBe(201);
      if (r.kind !== 'CT_RETURN') expect((await as(admin, 'post', `/compliance/deadline-rules/${added.body.id}/verify`, { notes: 'Checked against the synthetic source' })).status).toBe(200);
    }
    const g = await as(accountant, 'post', c('/generate'), { from: '2024-01-01', through: '2025-12-31' });
    expect(g.status).toBe(200);
    const made = g.body.created.map((o: { kind: string; periodEnd: string; dueDate: string }) => `${o.kind} ${o.periodEnd} ${o.dueDate}`);
    expect(made).toEqual(expect.arrayContaining([
      'ACCOUNTS_FILING 2024-12-31 2025-09-30',            // the first (verified) version governs 2024
      'CT_PAYMENT 2024-12-31 2025-10-01', 'CT_PAYMENT 2025-12-31 2026-10-01',
      'VAT_RETURN 2025-03-31 2025-05-07', 'VAT_RETURN 2025-06-30 2025-08-07', 'VAT_RETURN 2025-09-30 2025-11-07', 'VAT_RETURN 2025-12-31 2026-02-07',
    ]));
    expect(g.body.created.find((o: { kind: string; periodEnd: string }) => o.kind === 'VAT_RETURN' && o.periodEnd === '2025-03-31').periodStart).toBe('2025-02-01');
    expect(g.body.skipped).toEqual(expect.arrayContaining([
      { kind: 'ACCOUNTS_FILING', anchor: '2025-12-31', reason: 'rule_unverified' },      // the superseding version is not verified yet
      { kind: 'CT_RETURN', anchor: '2024-12-31', reason: 'rule_unverified' },
    ]));
    expect(g.body.notApplicable).toEqual([expect.objectContaining({ kind: 'CONFIRMATION_STATEMENT' })]);
    expect(made).toHaveLength(7);
    const again = await as(accountant, 'post', c('/generate'), { from: '2024-01-01', through: '2025-12-31' });
    expect(again.body.created).toEqual([]);
    expect(again.body.existing).toBe(7);
  });
  it('after verifying the remaining rules and setting a confirmation date, the rest is created', async () => {
    expect((await as(admin, 'post', `/compliance/deadline-rules/${second}/verify`, { notes: 'Checked against the synthetic source' })).status).toBe(200);
    const ct = (await as(reviewer, 'get', '/compliance/deadline-rules')).body.items.find((r: { kind: string }) => r.kind === 'CT_RETURN');
    expect((await as(admin, 'post', `/compliance/deadline-rules/${ct.id}/verify`, { notes: 'Checked against the synthetic source' })).status).toBe(200);
    expect((await as(bookkeeper, 'put', c('/profile'), { confirmationDate: '2025-05-20', reason: 'From the last confirmation statement' })).status).toBe(403);
    expect((await as(manager, 'put', c('/profile'), { confirmationDate: '2025-05-20', reason: 'From the last confirmation statement' })).body.confirmationDate).toBe('2025-05-20');
    const g = await as(accountant, 'post', c('/generate'), { from: '2024-01-01', through: '2025-12-31' });
    expect(g.body.created.map((o: { kind: string; periodEnd: string; dueDate: string }) => `${o.kind} ${o.periodEnd} ${o.dueDate}`).sort()).toEqual([
      'ACCOUNTS_FILING 2025-12-31 2026-09-30', 'CONFIRMATION_STATEMENT 2024-05-20 2024-06-03', 'CONFIRMATION_STATEMENT 2025-05-20 2025-06-03',
      'CT_RETURN 2024-12-31 2025-12-31', 'CT_RETURN 2025-12-31 2026-12-31',
    ]);
    expect(g.body.skipped).toEqual([]);
  });
  it('a sole trader gets only what applies to its legal form', async () => {
    const g = await as(accountant, 'post', c('/generate', trader.id), { from: '2024-01-01', through: '2025-12-31' });
    expect(g.body.created).toEqual([]);
    expect(g.body.notApplicable.map((n: { kind: string }) => n.kind).sort()).toEqual(['ACCOUNTS_FILING', 'CONFIRMATION_STATEMENT', 'CT_PAYMENT', 'CT_RETURN', 'VAT_RETURN']);
  });
});

describe('obligations: manual entries and versioned updates', () => {
  let id: string, version: number;
  const today = ukToday();
  it('an internal deadline needs a title and a reason; the owner must be a member', async () => {
    expect((await as(accountant, 'post', c('/obligations'), { kind: 'OTHER', dueDate: shift(today, 3), reason: 'Partner review before filing' })).status).toBe(422);
    expect((await as(accountant, 'post', c('/obligations'), { kind: 'OTHER', title: 'Partner review', dueDate: shift(today, 3), reason: 'Partner review before filing', assigneeUserId: outsider.userId })).body.code).toBe('invalid_assignee');
    const r = await as(accountant, 'post', c('/obligations'), { kind: 'OTHER', title: 'Partner review', dueDate: shift(today, 3), reason: 'Partner review before filing', assigneeUserId: manager.userId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ source: 'MANUAL', status: 'NOT_STARTED', overdue: false, version: 1, assigneeUserId: manager.userId });
    id = r.body.id;
    version = r.body.version;
  });
  it('a stale version is refused; DONE needs its date (not in the future); a reference belongs to DONE', async () => {
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version: version + 5, status: 'IN_PROGRESS' })).body.code).toBe('stale_version');
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'DONE' })).body.code).toBe('done_on_required');
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'DONE', doneOn: shift(today, 2) })).body.code).toBe('done_on_future');
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'IN_PROGRESS', doneReference: 'X1' })).body.code).toBe('not_done');
    const w = await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'WAITING_ON_CLIENT' });
    expect(w.body).toMatchObject({ status: 'WAITING_ON_CLIENT', version: 2 });
    const d = await as(manager, 'patch', c(`/obligations/${id}`), { version: 2, status: 'DONE', doneOn: today, doneReference: 'Signed off by the partner' });
    expect(d.body).toMatchObject({ status: 'DONE', doneOn: today, doneReference: 'Signed off by the partner', version: 3 });
    version = 3;
  });
  it('reopening, NOT_REQUIRED and moving a due date need a reason; reopening clears the done details', async () => {
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'IN_PROGRESS' })).body.code).toBe('reason_required');
    const re = await as(manager, 'patch', c(`/obligations/${id}`), { version, status: 'IN_PROGRESS', reason: 'Signed off in error; review again' });
    expect(re.body).toMatchObject({ status: 'IN_PROGRESS', doneOn: null, doneReference: null, statusReason: 'Signed off in error; review again', version: 4 });
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version: 4, dueDate: shift(today, 10) })).body.code).toBe('reason_required');
    expect((await as(manager, 'patch', c(`/obligations/${id}`), { version: 4, status: 'NOT_REQUIRED' })).body.code).toBe('reason_required');
    const nr = await as(manager, 'patch', c(`/obligations/${id}`), { version: 4, status: 'NOT_REQUIRED', reason: 'The partner reviews this client at year end only' });
    expect(nr.body).toMatchObject({ status: 'NOT_REQUIRED', version: 5 });
  });
  it('evidence must be a readable document of the same client', async () => {
    const theirs = await uploadDoc(s, owner, { companyId: other.id });
    const ok = await as(manager, 'post', c('/obligations'), { kind: 'CONFIRMATION_STATEMENT', dueDate: shift(today, -5), reason: 'Filed late; recorded by hand' });
    const bad = await as(manager, 'patch', c(`/obligations/${ok.body.id}`), { version: 1, status: 'DONE', doneOn: today, evidenceDocumentId: theirs.documentId });
    expect(bad.body.code).toBe('invalid_evidence');
    const mine = await uploadDoc(s, owner, { companyId: company.id });
    const good = await as(manager, 'patch', c(`/obligations/${ok.body.id}`), { version: 1, status: 'DONE', doneOn: today, evidenceDocumentId: mine.documentId });
    expect(good.body).toMatchObject({ evidenceDocumentId: mine.documentId, overdue: false });
  });
  it('the database fixes what an obligation is, demands a version step and refuses deletion', () => {
    expect(() => adminSql(`UPDATE compliance_obligation SET kind = 'VAT_RETURN', version = version + 1 WHERE id = '${id}'`)).toThrow(/cannot change/);
    expect(() => adminSql(`UPDATE compliance_obligation SET status = 'READY', status_reason = NULL WHERE id = '${id}'`)).toThrow(/advance its version/);
    expect(() => adminSql(`DELETE FROM compliance_obligation WHERE id = '${id}'`)).toThrow(/not permitted/);
  });
  it('every change is audited with its reason', async () => {
    const actions = adminSql(`SELECT string_agg(action || ':' || coalesce(reason, ''), '|' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${id}'`);
    expect(actions).toContain('compliance.obligation_created:Partner review before filing');
    expect(actions).toContain('compliance.obligation_updated:Signed off in error; review again');
    expect(actions).toContain('compliance.obligation_updated:The partner reviews this client at year end only');
  });
});

describe('practice-wide views: only the clients a person may read', () => {
  const today = ukToday();
  beforeAll(async () => {
    await as(owner, 'post', c('/obligations', other.id), { kind: 'OTHER', title: 'Second client overdue', dueDate: shift(today, -2), reason: 'Internal deadline for the test' });
    await as(owner, 'post', c('/obligations', other.id), { kind: 'OTHER', title: 'Second client later', dueDate: shift(today, 60), reason: 'Internal deadline for the test' });
    const w = await as(owner, 'post', c('/obligations'), { kind: 'OTHER', title: 'Waiting soon', dueDate: shift(today, 5), reason: 'Internal deadline for the test' });
    await as(owner, 'patch', c(`/obligations/${w.body.id}`), { version: 1, status: 'WAITING_ON_CLIENT' });
  });
  it('the owner sees both clients with names; an assigned accountant sees only their client; an outsider sees nothing', async () => {
    const all = await as(owner, 'get', '/compliance/obligations?due=all&limit=200');
    expect(new Set(all.body.items.map((o: { companyId: string }) => o.companyId))).toEqual(new Set([company.id, other.id]));
    expect(all.body.items.find((o: { companyId: string }) => o.companyId === other.id).companyName).toBe('Second Client Ltd');
    const mine = await as(assigned, 'get', '/compliance/obligations?due=all&limit=200');
    expect(mine.status).toBe(200);
    expect(new Set(mine.body.items.map((o: { companyId: string }) => o.companyId))).toEqual(new Set([company.id]));
    expect((await as(assigned, 'get', `/compliance/obligations?due=all&companyId=${other.id}`)).body.items).toEqual([]);
    expect((await s.api().get(orgPath(owner, '/compliance/obligations')).set(bearer(outsider.token))).status).toBe(404);
  });
  it('due windows: overdue, soon (overdue + 14 days), next 90 days; final statuses are never overdue', async () => {
    const titles = async (due: string) => (await as(owner, 'get', `/compliance/obligations?due=${due}&kind=OTHER&limit=200`)).body.items.map((o: { title: string }) => o.title);
    expect(await titles('overdue')).toEqual(['Second client overdue']);
    expect(await titles('soon')).toEqual(expect.arrayContaining(['Second client overdue', 'Waiting soon']));
    expect(await titles('soon')).not.toContain('Second client later');
    expect(await titles('next90')).toEqual(expect.arrayContaining(['Waiting soon', 'Second client later']));
    expect(await titles('next90')).not.toContain('Second client overdue');
    for (const o of (await as(owner, 'get', '/compliance/obligations?due=all&limit=200')).body.items)
      expect(o.overdue, o.title ?? o.kind).toBe(o.dueDate < today && !['DONE', 'NOT_REQUIRED'].includes(o.status));
  });
  it('pages are ordered by due date with a cursor', async () => {
    const p1 = await as(owner, 'get', '/compliance/obligations?due=all&limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await as(owner, 'get', `/compliance/obligations?due=all&limit=200&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    const dates = [...p1.body.items, ...p2.body.items].map((o: { dueDate: string }) => o.dueDate);
    expect(dates).toEqual([...dates].sort());
    expect(new Set([...p1.body.items, ...p2.body.items].map((o: { id: string }) => o.id)).size).toBe(dates.length);
  });
  it('the counts cover only the clients the person may read', async () => {
    const all = (await as(owner, 'get', '/compliance/summary')).body;
    const mine = (await as(assigned, 'get', '/compliance/summary')).body;
    expect(all.overdue).toBeGreaterThanOrEqual(1);
    expect(all.waitingOnClient).toBe(1);
    expect(mine.waitingOnClient).toBe(1);
    expect(mine.overdue).toBe(all.overdue - 1);   // the second client's overdue deadline is not counted for the assigned accountant
  });
  it('the routes are behind practice.management', async () => {
    const theirs = await makeCompany(s, outsider, 'Outsider Client');
    expect((await s.api().put(`/api/v1/organisations/${outsider.organisationId}/feature-flags/practice.management`).set(bearer(outsider.token)).send({ enabled: false, reason: 'Off for the test' })).status).toBe(200);
    expect((await s.api().get(`/api/v1/organisations/${outsider.organisationId}/companies/${theirs.id}/compliance/obligations`).set(bearer(outsider.token))).body.code).toBe('feature_disabled');
    expect((await s.api().get(`/api/v1/organisations/${outsider.organisationId}/compliance/summary`).set(bearer(outsider.token))).body.code).toBe('feature_disabled');
  });
});
