import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M3 through the public API: exchange rates, foreign-currency journals, FX settings, revaluation and the close acknowledgement, with real roles and tenants. All rates are synthetic. */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser, assignedOther: TestUser;
let company: { id: string }, otherCompany: { id: string };
const acc: Record<string, string> = {};
const base = (c = company.id) => `/companies/${c}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const rate = (over: object = {}) => ({ fromCurrency: 'USD', validFrom: '2026-03-02', rate: '1.25', source: 'Synthetic rate for the API test', ...over });
const usdJournal = (amount = '100.00', over: object = {}) => ({ journalDate: '2026-03-02', description: 'USD sale', currency: 'USD', lines: [{ accountId: acc['1110'], debit: amount, credit: '0' }, { accountId: acc['4000'], debit: '0', credit: amount }], ...over });
const settingsBody = (over: object = {}) => ({ roundingAccountId: acc['7900'], realisedAccountId: acc['7910'], unrealisedAccountId: acc['7920'], defaultSeries: {}, reason: 'Designate the FX accounts for the API tests', ...over });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'FX Client');
  otherCompany = await makeCompany(s, owner, 'FX Other');
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  assignedOther = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [otherCompany.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30']]) await as(owner, 'post', `${base()}/periods`, { startDate, endDate });
  for (const a of (await as(owner, 'post', `${base()}/accounts/initialise`)).body.items) acc[a.code] = a.id;
  for (const [code, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
    const r = await as(owner, 'post', `${base()}/accounts`, { code, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES', taxTreatment: 'NOT_APPLICABLE' });
    acc[code] = r.body.id;
  }
});
afterAll(() => s.stop());

describe('permissions: fx:rate-manage, ledger:policy (settings) and period:manage (revaluation) by role', () => {
  const rateProbe = (u: TestUser) => as(u, 'post', `${base()}/exchange-rates`, {}).then((r) => r.status);
  for (const [name, u, allowed] of [['owner', () => owner, true], ['admin', () => admin, true], ['partner', () => partner, true], ['accountant', () => accountant, true],
    ['manager', () => manager, false], ['bookkeeper', () => bookkeeper, false], ['reviewer', () => reviewer, false], ['client_viewer', () => viewer, false]] as const) {
    it(`${name} ${allowed ? 'may' : 'may not'} enter exchange rates`, async () => {
      const st = await rateProbe(u());
      if (allowed) expect(st).toBe(422); else expect(st).toBe(403);
    });
  }
  it('FX settings need ledger:policy (the accountant has none); reading needs ledger:read; revaluation needs period:manage', async () => {
    expect((await as(accountant, 'put', `${base()}/fx-settings`, settingsBody())).status).toBe(403);
    expect((await as(reviewer, 'get', `${base()}/fx-settings`)).status).toBe(200);
    expect((await as(viewer, 'get', `${base()}/fx-settings`)).status).toBe(403);
    expect((await as(bookkeeper, 'post', `${base()}/periods/${GHOST}/revaluation/preview`, {})).status).toBe(403);
    expect((await as(reviewer, 'get', `${base()}/exchange-rates`)).status).toBe(200);
    expect((await as(viewer, 'get', `${base()}/exchange-rates`)).status).toBe(403);
  });
  it('a member assigned only to another company gets 404 for this company; an outsider cannot see the organisation', async () => {
    expect((await as(assignedOther, 'post', `${base()}/exchange-rates`, rate())).status).toBe(404);
    expect((await as(assignedOther, 'get', `${base()}/exchange-rates`)).status).toBe(404);
    expect((await s.api().get(orgPath(owner, `${base()}/exchange-rates`)).set(bearer(outsider.token))).status).toBe(404);
  });
});
const GHOST = '11111111-1111-4111-8111-111111111111';

describe('FX settings', () => {
  it('start unset; the owner designates three different active P&L accounts; invalid choices are refused; the change is audited', async () => {
    expect((await as(owner, 'get', `${base()}/fx-settings`)).body).toMatchObject({ isDefault: true, roundingAccountId: null });
    expect((await as(owner, 'put', `${base()}/fx-settings`, settingsBody({ realisedAccountId: acc['7900'] }))).status).toBe(422);          // same account twice
    expect((await as(owner, 'put', `${base()}/fx-settings`, settingsBody({ roundingAccountId: acc['1100'] }))).body.code).toBe('invalid_fx_accounts');   // a control / balance sheet account
    expect((await as(owner, 'put', `${base()}/fx-settings`, settingsBody({ roundingAccountId: GHOST }))).body.code).toBe('unknown_account');
    expect((await as(owner, 'put', `${base()}/fx-settings`, settingsBody({ defaultSeries: { GBP: { publisher: 'X' } } }))).body.code).toBe('unknown_currency');   // the functional currency has no series
    expect((await as(owner, 'put', `${base()}/fx-settings`, settingsBody({ reason: 'short' }))).status).toBe(422);
    const ok = await as(owner, 'put', `${base()}/fx-settings`, settingsBody());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ isDefault: false, roundingAccountId: acc['7900'], unrealisedAccountId: acc['7920'], updatedByUserId: owner.userId });
    const audit = (await as(owner, 'get', `/audit-events?entityType=company_fx_setting&entityId=${company.id}`)).body.items.find((e: { action: string }) => e.action === 'fx.settings_changed');
    expect(audit).toMatchObject({ reason: 'Designate the FX accounts for the API tests', before: { roundingAccountId: null }, after: { roundingAccountId: acc['7900'] } });
  });
});

describe('exchange rates', () => {
  let rid: string;
  it('an accountant enters a manual rate: source mandatory, stored with provenance, UNVERIFIED, audited', async () => {
    const r = await as(accountant, 'post', `${base()}/exchange-rates`, rate());
    expect(r.status).toBe(201);
    rid = r.body.id;
    expect(r.body).toMatchObject({ fromCurrency: 'USD', toCurrency: 'GBP', kind: 'DAILY', validFrom: '2026-03-02', validTo: '2026-03-02', rate: '1.25000000', sourceKind: 'MANUAL', publisher: 'MANUAL', verificationStatus: 'UNVERIFIED', enteredByUserId: accountant.userId });
    expect((await as(accountant, 'post', `${base()}/exchange-rates`, rate({ source: 'ab' }))).status).toBe(422);
    expect((await as(accountant, 'post', `${base()}/exchange-rates`, rate({ rate: 1.25 }))).status).toBe(422);               // never a JSON number
    expect((await as(accountant, 'post', `${base()}/exchange-rates`, rate({ rate: '0' }))).status).toBe(422);
    expect((await as(accountant, 'post', `${base()}/exchange-rates`, rate({ fromCurrency: 'ZZZ' }))).body.code).toBe('unknown_currency');
    expect((await as(accountant, 'post', `${base()}/exchange-rates`, rate())).body.code).toBe('exchange_rate_exists');
    const audit = (await as(owner, 'get', `/audit-events?entityType=exchange_rate&entityId=${rid}`)).body.items;
    expect(audit.map((e: { action: string }) => e.action)).toContain('fx.rate_created');
  });
  it('lists and reads rates; the list shows current rates and (on request) superseded ones', async () => {
    const list = await as(reviewer, 'get', `${base()}/exchange-rates?from=USD&asOf=2026-03-02`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(rid);
    expect((await as(reviewer, 'get', `${base()}/exchange-rates/${rid}`)).body.rate).toBe('1.25000000');
    expect((await as(reviewer, 'get', `${base()}/exchange-rates/${GHOST}`)).status).toBe(404);
  });
  it('verification by a second person, once; a rate is corrected by supersession with a reason, never edited', async () => {
    expect((await as(accountant, 'post', `${base()}/exchange-rates/${rid}/verify`, {})).body.code).toBe('self_verification_not_allowed');
    const v = await as(partner, 'post', `${base()}/exchange-rates/${rid}/verify`, { note: 'Checked against the source' });
    expect(v.body).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: partner.userId });
    expect((await as(partner, 'post', `${base()}/exchange-rates/${rid}/verify`, {})).body.code).toBe('already_verified');
    expect((await as(bookkeeper, 'post', `${base()}/exchange-rates/${rid}/verify`, {})).status).toBe(403);
    const fix = await as(accountant, 'post', `${base()}/exchange-rates/${rid}/supersede`, { rate: '1.26', source: 'Corrected from the bank advice', reason: 'The first entry used the wrong day\'s number' });
    expect(fix.status).toBe(201);
    expect(fix.body).toMatchObject({ rate: '1.26000000', verificationStatus: 'UNVERIFIED' });
    expect((await as(accountant, 'post', `${base()}/exchange-rates/${rid}/supersede`, { rate: '1.27', source: 'again', reason: 'Trying to supersede the old row again' })).body.code).toBe('exchange_rate_superseded');
    expect((await as(reviewer, 'get', `${base()}/exchange-rates/${rid}`)).body.supersededById).toBe(fix.body.id);
    rid = fix.body.id;
  });
  it('imports a published series from a CSV file: unverified, with provenance; invalid files store nothing and report each line', async () => {
    const body = (csv: string) => ({ publisher: 'Synthetic Publisher', series: 'SP-1', sourceUrl: 'https://example.invalid/rates', retrievedAt: '2026-04-01T09:00:00Z', kind: 'DAILY', csv });
    const ok = await as(accountant, 'post', `${base()}/exchange-rates/import`, body('from,valid_from,rate\nEUR,2026-03-02,0.8500\nEUR,2026-03-03,0.8600\n'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ imported: 2, skippedIdentical: 0, status: 'UNVERIFIED' });
    const again = await as(accountant, 'post', `${base()}/exchange-rates/import`, body('from,valid_from,rate\nEUR,2026-03-02,0.8500\n'));
    expect(again.body).toMatchObject({ imported: 0, skippedIdentical: 1 });
    const bad = await as(accountant, 'post', `${base()}/exchange-rates/import`, body('from,valid_from,rate\nEUR,2026-03-04,0.87\nEUR,not-a-date,abc\n'));
    expect([bad.status, bad.body.code]).toEqual([422, 'rate_import_invalid']);
    expect(bad.body.errors?.errors ?? bad.body.details?.errors).toEqual(expect.arrayContaining([expect.objectContaining({ line: 3 })]));
    expect(adminSql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${owner.organisationId}' AND from_currency='EUR' AND valid_from='2026-03-04'`)).toBe('0');
    expect((await as(accountant, 'post', `${base()}/exchange-rates/import`, { ...body('x'), publisher: 'MANUAL' })).body.code).toBe('invalid_publisher');
    expect((await as(bookkeeper, 'post', `${base()}/exchange-rates/import`, body('from,valid_from,rate\n'))).status).toBe(403);
    expect((await as(accountant, 'post', `${base()}/exchange-rates/import`, { ...body('x'), csv: 'a'.repeat(1_000_001) })).status).toBe(422);
  });
});

describe('foreign-currency journals through the API', () => {
  it('converts at the stored rate, keeps the original values on each line, and reports both', async () => {
    const r = await as(accountant, 'post', `${base()}/journals`, usdJournal('100.00', { idempotencyKey: 'fx-api-journal-0001' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ currency: 'GBP', total: '126.00', sourceType: 'MANUAL' });               // 100 USD x the corrected 1.26
    expect(r.body.lines[0]).toMatchObject({ accountCode: '1110', debit: '126.00', credit: '0.00', original: { currency: 'USD', debit: '100.0000', credit: '0.0000', rate: '1.26000000' } });
    const replay = await as(accountant, 'post', `${base()}/journals`, usdJournal('100.00', { idempotencyKey: 'fx-api-journal-0001' }));
    expect(replay.body).toMatchObject({ id: r.body.id, replayed: true });
  });
  it('refuses clearly: no rate for the date, a rate that does not apply, both rate forms, a bad manual rate, an unbalanced foreign journal', async () => {
    expect((await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { journalDate: '2026-03-20' }))).body.code).toBe('exchange_rate_not_found');
    expect((await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { rateId: GHOST }))).body.code).toBe('exchange_rate_not_applicable');
    expect((await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { rateId: GHOST, manualRate: { rate: '1.2', source: 'both forms' } }))).status).toBe(422);
    expect((await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { journalDate: '2026-03-21', manualRate: { rate: '1.2', source: 'x' } }))).status).toBe(422);
    const unbalanced = usdJournal('10.00'); unbalanced.lines[1]!.credit = '9.99';
    expect((await as(accountant, 'post', `${base()}/journals`, unbalanced)).body.code).toBe('unbalanced_journal');
    expect((await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { currency: 'GBP', rateId: GHOST }))).body.code).toBe('rate_not_applicable');
  });
  it('a manual rate on the journal is stored, audited and needs fx:rate-manage (the manager may post journals but not enter rates)', async () => {
    const ok = await as(accountant, 'post', `${base()}/journals`, usdJournal('10.00', { journalDate: '2026-03-21', manualRate: { rate: '1.20', source: 'Rate quoted on the supplier invoice' } }));
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe('12.00');
    const denied = await as(manager, 'post', `${base()}/journals`, usdJournal('10.00', { journalDate: '2026-03-22', manualRate: { rate: '1.20', source: 'Rate quoted on the supplier invoice' } }));
    expect([denied.status, denied.body.code]).toEqual([403, 'permission_denied']);
  });
  it('the reversal of a foreign-currency journal mirrors the original values', async () => {
    const j = await as(accountant, 'post', `${base()}/journals`, usdJournal('20.00', { journalDate: '2026-03-21' }));
    const rev = await as(accountant, 'post', `${base()}/journals/${j.body.id}/reverse`, { reason: 'Entered against the wrong customer', journalDate: '2026-03-22' });
    expect(rev.status).toBe(201);
    expect(rev.body.lines[0]).toMatchObject({ debit: '0.00', credit: '24.00', original: { currency: 'USD', debit: '0.0000', credit: '20.0000', rate: '1.20000000' } });
  });
  it('the reserved FX accounts and control accounts stay closed to manual journals', async () => {
    const reserved = usdJournal('5.00'); reserved.lines[0]!.accountId = acc['7920']!;
    expect((await as(accountant, 'post', `${base()}/journals`, reserved)).body.code).toBe('system_account_restricted');
    const control = usdJournal('5.00'); control.lines[0]!.accountId = acc['1100']!;
    expect((await as(accountant, 'post', `${base()}/journals`, control)).body.code).toBe('control_account_restricted');
  });
});

describe('revaluation and the close acknowledgement', () => {
  let q1: string, q2: string;
  beforeAll(async () => {
    q1 = adminSql(`SELECT id FROM accounting_period WHERE company_id='${company.id}' AND start_date='2026-01-01'`);
    q2 = adminSql(`SELECT id FROM accounting_period WHERE company_id='${company.id}' AND start_date='2026-04-01'`);
    await as(accountant, 'post', `${base()}/exchange-rates`, rate({ validFrom: '2026-03-31', rate: '1.40', source: 'Synthetic closing rate' }));
  });
  it('preview shows the difference per monetary account and currency and posts nothing; it needs period:manage', async () => {
    const before = adminSql(`SELECT count(*) FROM journal WHERE company_id='${company.id}'`);
    const p = await as(accountant, 'post', `${base()}/periods/${q1}/revaluation/preview`, {});
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ asAt: '2026-03-31', functionalCurrency: 'GBP', missingRates: [] });
    expect(p.body.items.find((i: { accountCode: string }) => i.accountCode === '1110')).toMatchObject({ currency: 'USD', rate: '1.40000000' });
    expect(adminSql(`SELECT count(*) FROM journal WHERE company_id='${company.id}'`)).toBe(before);
    expect((await as(reviewer, 'post', `${base()}/periods/${q1}/revaluation/preview`, {})).status).toBe(403);
    expect((await as(accountant, 'post', `${base()}/periods/${GHOST}/revaluation/preview`, {})).status).toBe(404);
  });
  it('closing without revaluing needs the acknowledgement; revaluing posts the FX_REVALUATION journal and, with an open next period, its reversal on 1 April', async () => {
    const refused = await as(accountant, 'post', `${base()}/periods/${q1}/close`, {});
    expect([refused.status, refused.body.code]).toEqual([409, 'fx_unrevalued_balances']);
    const run = await as(accountant, 'post', `${base()}/periods/${q1}/revaluation`, {});
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ status: 'POSTED', run: { status: 'REVERSED', asAt: '2026-03-31', reversalDueDate: '2026-04-01' } });
    const j = (await as(reviewer, 'get', `${base()}/journals/${run.body.journalId}`)).body;
    expect(j).toMatchObject({ sourceType: 'FX_REVALUATION', journalDate: '2026-03-31' });
    expect(j.lines.some((l: { accountCode: string }) => l.accountCode === '7920')).toBe(true);
    const rev = (await as(reviewer, 'get', `${base()}/journals/${run.body.reversalJournalId}`)).body;
    expect(rev).toMatchObject({ sourceType: 'REVERSAL', journalDate: '2026-04-01', reversesJournalId: run.body.journalId });
    const again = await as(accountant, 'post', `${base()}/periods/${q1}/revaluation`, {});
    expect(again.body).toMatchObject({ status: 'NOTHING_TO_DO', journalId: null });
    expect((await as(reviewer, 'get', `${base()}/revaluation-runs`)).body.items[0]).toMatchObject({ id: run.body.run.id, status: 'REVERSED' });
    // reporting: the unrealised-FX account's general ledger drills to the revaluation journal and its reversal; the trial balance (functional currency) still balances
    const gl = (await as(reviewer, 'get', `${base()}/ledger?accountId=${acc['7920']}`)).body;
    const ids = gl.items.map((i: { journalId: string }) => i.journalId);
    expect(ids).toEqual(expect.arrayContaining([run.body.journalId, run.body.reversalJournalId]));
    expect(gl.items.find((i: { journalId: string }) => i.journalId === run.body.journalId)).toMatchObject({ sourceType: 'FX_REVALUATION' });
    expect(gl.items[gl.items.length - 1].balance).toBe('0.00');                       // reversed: the unrealised difference is back to nil after 1 April
    const tb = (await as(reviewer, 'get', `${base()}/reports/trial-balance?asOf=2026-03-31`)).body;
    expect([tb.balanced, tb.totalDebit]).toEqual([true, tb.totalCredit]);
    expect((await as(accountant, 'post', `${base()}/periods/${q1}/close`, {})).body.status).toBe('CLOSED');
  });
  it('a missing closing rate is reported by currency and stops the run; the period can still be closed with the acknowledgement; revaluation of a closed period that would post is refused', async () => {
    const p = await as(accountant, 'post', `${base()}/periods/${q2}/revaluation/preview`, {});
    expect(p.body.missingRates.map((m: { currency: string }) => m.currency)).toContain('USD');
    expect((await as(accountant, 'post', `${base()}/periods/${q2}/revaluation`, {})).body.code).toBe('exchange_rate_not_found');
    expect((await as(accountant, 'post', `${base()}/periods/${q2}/close`, { acknowledgeUnrevaluedFx: true })).body.status).toBe('CLOSED');
    await as(accountant, 'post', `${base()}/exchange-rates`, rate({ validFrom: '2026-06-30', rate: '1.45', source: 'Synthetic Q2 closing rate' }));
    expect((await as(accountant, 'post', `${base()}/periods/${q2}/revaluation`, {})).body.code).toBe('period_closed');
  });
  it('revaluation runs are listed per company and a run id from another company is a 404 on reverse', async () => {
    expect((await as(owner, 'get', `${base(otherCompany.id)}/revaluation-runs`)).body.items).toEqual([]);
    expect((await as(accountant, 'post', `${base()}/revaluation-runs/${GHOST}/reverse`, {})).status).toBe(404);
  });
});
