import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/**
 * V5-M1 (DEC-090) through the public API: the VAT return of a synthetic quarter. Preparation, review flags and their explanations, the
 * second-person review, the client's approval that freezes the return and locks the period, and lapsing when the ledger changes.
 * SYNTHETIC rates and amounts only; nothing is filed.
 */
let s: Stack;
let owner: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser;
let company: { id: string }, other: { id: string };
const acc: Record<string, string> = {};
let salesCode: string, purchCode: string, obligationId: string, contact: string, otherContact: string, evidence: string, otherEvidence: string;
const c = (p: string, co = company.id) => `/companies/${co}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const SOURCE = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026 s.1 (test fixture)', retrievedOn: '2026-01-01' };
/** The synthetic rate is 20%: the bank side carries net plus VAT. */
const gross = (net: string) => (Number(net) * 1.2).toFixed(2);
const journal = (u: TestUser, d: { date: string; taxPoint?: string; account: string; code: string; side: 'sale' | 'purchase'; net: string }) => as(u, 'post', c('/journals'), {
  journalDate: d.date, ...(d.taxPoint ? { taxPoint: d.taxPoint } : {}), description: `Synthetic ${d.side}`,
  lines: d.side === 'sale'
    ? [{ accountId: acc['1110'], debit: gross(d.net), credit: '0' }, { accountId: acc[d.account], debit: '0', credit: d.net, taxCodeId: d.code }]
    : [{ accountId: acc[d.account], debit: d.net, credit: '0', taxCodeId: d.code }, { accountId: acc['1110'], debit: '0', credit: gross(d.net) }],
});
const box = (r: { workpaper: { boxes: { box: number; amount: string }[] } }, n: number) => r.workpaper.boxes.find((b) => b.box === n)!.amount;

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'VAT Return Client Ltd');
  other = await makeCompany(s, owner, 'Not Registered Ltd');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  ok(await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  acc['1150'] = ok(await as(owner, 'post', c('/accounts'), { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', taxTreatment: 'VAT_CONTROL' }), 201).id;
  salesCode = ok(await as(accountant, 'post', c('/tax-codes'), { code: 'SX', name: 'Synthetic standard sales', treatment: 'STANDARD', direction: 'SALES' }), 201).id;
  purchCode = ok(await as(accountant, 'post', c('/tax-codes'), { code: 'PX', name: 'Synthetic standard purchases', treatment: 'STANDARD', direction: 'PURCHASES' }), 201).id;
  const sr = ok(await as(accountant, 'post', c(`/tax-codes/${salesCode}/rates`), { rate: '20', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: SOURCE }), 201).id;
  const pr = ok(await as(accountant, 'post', c(`/tax-codes/${purchCode}/rates`), { rate: '20', effectiveFrom: '2026-01-01', netBoxes: [7], vatBoxes: [4], source: SOURCE }), 201).id;
  for (const id of [sr, pr]) ok(await as(owner, 'post', c(`/tax-rates/${id}/verify`), { notes: 'Checked against the synthetic test source' }));
  ok(await as(accountant, 'put', c('/vat-settings'), { registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2026-03-31',
    outputAccountId: acc['2200'], inputAccountId: acc['1150'], reason: 'Registered from 1 January (synthetic)' }));
  ok(await journal(accountant, { date: '2026-02-10', account: '4000', code: salesCode, side: 'sale', net: '1000.00' }), 201);
  ok(await journal(accountant, { date: '2026-02-20', account: '6310', code: purchCode, side: 'purchase', net: '400.00' }), 201);
  obligationId = ok(await as(owner, 'post', c('/compliance/obligations'), { kind: 'VAT_RETURN', periodStart: '2026-01-01', periodEnd: '2026-03-31', dueDate: '2026-05-07', reason: 'Entered by hand for the synthetic quarter' }), 201).id;
  contact = ok(await as(owner, 'post', '/contacts', { companyId: company.id, kind: 'PERSON', name: 'Synthetic Director' }), 201).id;
  otherContact = ok(await as(owner, 'post', '/contacts', { companyId: other.id, kind: 'PERSON', name: 'Someone Else' }), 201).id;
  const d = await uploadDoc(s, owner, { companyId: company.id, name: 'vat-approval.pdf' }); await waitForVersion(s, owner, d.documentId, d.versionId); evidence = d.documentId;
  const o = await uploadDoc(s, owner, { companyId: other.id }); await waitForVersion(s, owner, o.documentId, o.versionId); otherEvidence = o.documentId;
});
afterAll(() => s.stop());

describe('permissions: vat:prepare (owner, admin, partner, accountant) and vat:review (owner, admin, partner)', () => {
  for (const [name, u, prepare] of [['manager', () => manager, false], ['bookkeeper', () => bookkeeper, false], ['reviewer', () => reviewer, false], ['accountant', () => accountant, true]] as const) {
    it(`${name} ${prepare ? 'may' : 'may not'} open a return`, async () => {
      const st = (await as(u(), 'post', c('/vat-returns'), {})).status;
      expect(st).toBe(prepare ? 422 : 403);   // with the permission, only the missing date is refused
    });
  }
  it('reading needs ledger:read: a reviewer reads, a client viewer cannot', async () => {
    expect((await as(reviewer, 'get', c('/vat-returns'))).status).toBe(200);
    expect((await as(viewer, 'get', c('/vat-returns'))).status).toBe(403);
  });
});

describe('the VAT return of a synthetic quarter', () => {
  let q1: string;
  it('an accountant opens the return for the period containing a date; it links the VAT obligation and starts as DRAFT', async () => {
    expect((await as(accountant, 'post', c('/vat-returns', other.id), { date: '2026-02-15' })).body.code).toBe('not_vat_registered');
    const r = ok(await as(accountant, 'post', c('/vat-returns'), { date: '2026-02-15' }), 201);
    q1 = r.id;
    expect(r).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-03-31', obligationId, status: 'DRAFT', locked: false, flags: [], unexplainedFlags: 0 });
    expect([box(r, 1), box(r, 3), box(r, 4), box(r, 5), box(r, 6), box(r, 7)]).toEqual(['200.00', '200.00', '80.00', '120.00', '1000.00', '400.00']);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.notice).toMatch(/not a submission/);
    const again = await as(accountant, 'post', c('/vat-returns'), { date: '2026-03-31' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('vat_return_exists');
  });

  it('preparing records the fingerprint; it cannot be prepared twice as it stands; the accountant cannot review', async () => {
    const r = ok(await as(accountant, 'post', c(`/vat-returns/${q1}/prepare`), { note: 'Prepared from the synthetic ledger' }));
    expect(r.status).toBe('PREPARED');
    expect(r.events).toEqual([expect.objectContaining({ kind: 'PREPARED', live: true, byUserId: accountant.userId, byName: accountant.displayName, fingerprint: r.fingerprint })]);
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/prepare`), {})).body.code).toBe('already_prepared');
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/review`), {})).status).toBe(403);
  });

  it('a later posting into the period makes the preparation lapse and raises the late-posting and reconciliation flags', async () => {
    const before = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    const late = ok(await journal(accountant, { date: '2026-04-05', taxPoint: '2026-03-30', account: '4000', code: salesCode, side: 'sale', net: '100.00' }), 201);
    const r = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    expect(r.fingerprint).not.toBe(before.fingerprint);
    expect(r.status).toBe('DRAFT');
    expect(r.events[0]).toMatchObject({ kind: 'PREPARED', live: false });
    expect([box(r, 1), box(r, 4), box(r, 5), box(r, 6), box(r, 7)]).toEqual(['220.00', '80.00', '140.00', '1100.00', '400.00']);   // docs/architecture/v5-m1-golden-workings.xlsx
    expect(r.workpaper.reconciliation).toMatchObject({ vatAccountMovement: '120.00', vatLinesByTaxPoint: '140.00', difference: '-20.00' });
    const lateLine = late.lines.find((l: { vat: { role: string } | null }) => l.vat?.role === 'VAT').lineNo;
    expect(r.flags.map((f: { key: string }) => f.key).sort()).toEqual([`late_posting:${late.id}:${lateLine}`, 'reconciliation_difference']);
    expect(r.unexplainedFlags).toBe(2);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/review`), {})).body.code).toBe('not_prepared');
  });

  it('every flag is explained before review; explanations need vat:prepare or vat:review and a live flag', async () => {
    ok(await as(accountant, 'post', c(`/vat-returns/${q1}/prepare`), {}));
    const r = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    const refused = await as(partner, 'post', c(`/vat-returns/${q1}/review`), {});
    expect(refused.body.code).toBe('flags_unexplained');
    expect(refused.body.errors.flags).toHaveLength(2);
    expect((await as(bookkeeper, 'post', c(`/vat-returns/${q1}/flag-explanations`), { flagKey: 'zero_return', explanation: 'Not my place to explain this' })).status).toBe(403);
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/flag-explanations`), { flagKey: 'zero_return', explanation: 'This return is not a zero return' })).body.code).toBe('unknown_flag');
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/flag-explanations`), { flagKey: 'nonsense', explanation: 'An explanation of nothing' })).status).toBe(422);
    for (const f of r.flags) ok(await as(accountant, 'post', c(`/vat-returns/${q1}/flag-explanations`), { flagKey: f.key, explanation: 'The sale was invoiced in March and entered in April (synthetic)' }));
    const after = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    expect(after.unexplainedFlags).toBe(0);
    expect(after.status).toBe('PREPARED');
  });

  it('a second person reviews; the preparer of a return cannot review it, in the service and in the database', async () => {
    const q2 = ok(await as(owner, 'post', c('/vat-returns'), { date: '2026-05-10' }), 201).id;
    ok(await as(owner, 'post', c(`/vat-returns/${q2}/prepare`), {}));
    expect((await as(owner, 'post', c(`/vat-returns/${q2}/review`), {})).body.code).toBe('self_review_not_allowed');
    const fp = (await as(owner, 'get', c(`/vat-returns/${q2}`))).body.fingerprint;
    expect(() => adminSql(`INSERT INTO vat_return_event (organisation_id, company_id, vat_return_id, kind, fingerprint, by_user_id) VALUES ('${owner.organisationId}', '${company.id}', '${q2}', 'REVIEWED', '${fp}', '${owner.userId}')`)).toThrow(/someone other than the person who prepared/);
    const r = ok(await as(partner, 'post', c(`/vat-returns/${q1}/review`), { note: 'Boxes agreed to the ledger' }));
    expect(r.status).toBe('REVIEWED');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/review`), {})).body.code).toBe('already_reviewed');
  });

  it("the client's approval needs vat:review and period:lock, a date after the period, the client's contact and the client's clean evidence", async () => {
    const body = { approverContactId: contact, approvedOn: '2026-04-20', evidenceDocumentId: evidence };
    expect((await as(manager, 'post', c(`/vat-returns/${q1}/client-approval`), body)).status).toBe(403);
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/client-approval`), body)).status).toBe(403);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), { ...body, approvedOn: '2026-03-31' })).body.code).toBe('approval_date_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), { ...body, approvedOn: '2099-01-01' })).body.code).toBe('approval_date_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), { ...body, approverContactId: otherContact })).body.code).toBe('approver_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), { ...body, evidenceDocumentId: otherEvidence })).body.code).toBe('evidence_invalid');
    const r = ok(await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), body));
    expect(r).toMatchObject({ status: 'APPROVED', locked: true, lockedByUserId: partner.userId });
    expect(r.events.at(-1)).toMatchObject({ kind: 'CLIENT_APPROVED', approverContactId: contact, approvedOn: '2026-04-20', evidenceDocumentId: evidence, live: true });
    const o = ok(await as(reviewer, 'get', c(`/compliance/obligations/${obligationId}`)));
    expect(o).toMatchObject({ status: 'READY', version: 2, statusReason: 'The client approved the VAT return' });
    const audit = adminSql(`SELECT action FROM audit_event WHERE entity_id = '${q1}' ORDER BY occurred_at`);
    expect(audit).toMatch(/vat.return_created[\s\S]*vat.return_prepared[\s\S]*vat.return_flag_explained[\s\S]*vat.return_reviewed[\s\S]*vat.return_client_approved/);
  });

  it('the approved period is locked against new VAT lines; the return is frozen; the next period stays open', async () => {
    const before = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    const refused = await journal(accountant, { date: '2026-04-10', taxPoint: '2026-03-15', account: '4000', code: salesCode, side: 'sale', net: '50.00' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('vat_period_locked');
    ok(await journal(accountant, { date: '2026-04-10', account: '4000', code: salesCode, side: 'sale', net: '50.00' }), 201);
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/prepare`), {})).body.code).toBe('vat_return_locked');
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/flag-explanations`), { flagKey: 'repayment', explanation: 'Trying after the approval' })).body.code).toBe('vat_return_locked');
    const after = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}`)));
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(box(after, 1)).toBe('220.00');
    const list = ok(await as(reviewer, 'get', c('/vat-returns?year=2026'))).items;
    expect(list.map((x: { periodFrom: string; status: string }) => `${x.periodFrom}:${x.status}`)).toEqual(['2026-04-01:DRAFT', '2026-01-01:APPROVED']);   // the April sale changed the second quarter after it was prepared: it lapsed
  });

  it('the database guards the lock, the frozen return and the append-only events', async () => {
    expect(() => adminSql(`UPDATE vat_return SET approved_content = '{}'::jsonb WHERE id = '${q1}'`)).toThrow(/frozen/);
    expect(() => adminSql(`UPDATE vat_return SET period_to = '2026-02-28' WHERE id = '${q1}'`)).toThrow(/cannot change/);
    expect(() => adminSql(`DELETE FROM vat_return WHERE id = '${q1}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`UPDATE vat_return_event SET note = 'changed' WHERE vat_return_id = '${q1}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`INSERT INTO vat_return_event (organisation_id, company_id, vat_return_id, kind, fingerprint, by_user_id) SELECT organisation_id, company_id, id, 'PREPARED', approved_fingerprint, '${accountant.userId}' FROM vat_return WHERE id = '${q1}'`)).toThrow(/no further events/);
    expect(() => adminSql(`BEGIN; SELECT set_config('app.posting', 'on', true); INSERT INTO journal_line (organisation_id, company_id, journal_id, line_no, account_id, debit, credit, tax_code_id, tax_rate_id, vat_role, tax_point, vat_inclusive)
      SELECT organisation_id, company_id, journal_id, 99, account_id, debit, credit, tax_code_id, tax_rate_id, vat_role, DATE '2026-03-01', vat_inclusive FROM journal_line WHERE company_id = '${company.id}' AND vat_role = 'NET' LIMIT 1; ROLLBACK;`)).toThrow(/vat_period_locked/);
  });

  it('with the flag off the routes say so', async () => {
    const solo = await createUser(s, { type: 'PRACTICE' });
    const co = await makeCompany(s, solo, 'Flag Off Ltd');
    expect((await s.api().put(orgPath(solo, '/feature-flags/vat.returns')).set(bearer(solo.token)).send({ enabled: false, reason: 'Off for the test' })).status).toBe(200);
    const r = await s.api().get(orgPath(solo, `/companies/${co.id}/vat-returns`)).set(bearer(solo.token));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('feature_disabled');
  });
});
