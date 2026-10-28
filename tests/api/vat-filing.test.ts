import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/**
 * V5-M2 (DEC-091) through the public API: the presentation rule of boxes 6 to 9 (verified by a second person), the filing package of an
 * approved return, a simulated submission through the fake HMRC adapter (nothing else changes), and a filing made outside the platform recorded
 * with HMRC's receipt (the liability journal and the obligation). SYNTHETIC rates, amounts and receipts only; nothing is sent to HMRC.
 */
let s: Stack;
let owner: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string }, other: { id: string };
const acc: Record<string, string> = {};
let q1: string, q2: string, obligationId: string, evidence: string, otherEvidence: string, contact: string, settings: Record<string, unknown>;
const c = (p: string) => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const SOURCE = { url: 'https://example.invalid/synthetic-presentation-rule', provision: 'Synthetic notice 2026 para 1 (test fixture)', retrievedOn: '2026-01-01' };
const gross = (net: string) => (Number(net) * 1.2).toFixed(2);   // the synthetic rate is 20%
const sale = (net: string, date: string) => ({ journalDate: date, description: 'Synthetic sale', lines: [{ accountId: acc['1110'], debit: gross(net), credit: '0' }, { accountId: acc['4000'], debit: '0', credit: net, taxCodeId: acc.SX }] });
const purchase = (net: string, date: string) => ({ journalDate: date, description: 'Synthetic purchase', lines: [{ accountId: acc['6310'], debit: net, credit: '0', taxCodeId: acc.PX }, { accountId: acc['1110'], debit: '0', credit: gross(net) }] });
const record = { submittedOn: '2026-05-02', receiptReference: '123456789012', declarationConfirmed: true };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'VAT Filing Client Ltd');
  other = await makeCompany(s, owner, 'Other Client Ltd');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  ok(await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  acc['1150'] = ok(await as(owner, 'post', c('/accounts'), { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', taxTreatment: 'VAT_CONTROL' }), 201).id;
  acc['2202'] = ok(await as(owner, 'post', c('/accounts'), { code: '2202', name: 'VAT liability', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY_TAX', reportingMapping: 'BS.CREDITORS_WITHIN_ONE_YEAR' }), 201).id;
  acc.SX = ok(await as(accountant, 'post', c('/tax-codes'), { code: 'SX', name: 'Synthetic standard sales', treatment: 'STANDARD', direction: 'SALES' }), 201).id;
  acc.PX = ok(await as(accountant, 'post', c('/tax-codes'), { code: 'PX', name: 'Synthetic standard purchases', treatment: 'STANDARD', direction: 'PURCHASES' }), 201).id;
  for (const [code, boxes] of [[acc.SX, { netBoxes: [6], vatBoxes: [1] }], [acc.PX, { netBoxes: [7], vatBoxes: [4] }]] as const) {
    const id = ok(await as(accountant, 'post', c(`/tax-codes/${code}/rates`), { rate: '20', effectiveFrom: '2026-01-01', ...boxes, source: { ...SOURCE, url: 'https://example.invalid/synthetic-rate' } }), 201).id;
    ok(await as(owner, 'post', c(`/tax-rates/${id}/verify`), { notes: 'Checked against the synthetic test source' }));
  }
  settings = { registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2026-03-31', outputAccountId: acc['2200'], inputAccountId: acc['1150'], reason: 'Registered from 1 January (synthetic)' };
  ok(await as(accountant, 'put', c('/vat-settings'), settings));
  ok(await as(accountant, 'post', c('/journals'), sale('1000.55', '2026-02-10')), 201);
  ok(await as(accountant, 'post', c('/journals'), purchase('400.70', '2026-02-20')), 201);
  obligationId = ok(await as(owner, 'post', c('/compliance/obligations'), { kind: 'VAT_RETURN', periodStart: '2026-01-01', periodEnd: '2026-03-31', dueDate: '2026-05-07', reason: 'Entered by hand for the synthetic quarter' }), 201).id;
  contact = ok(await as(owner, 'post', '/contacts', { companyId: company.id, kind: 'PERSON', name: 'Synthetic Director' }), 201).id;
  const d = await uploadDoc(s, owner, { companyId: company.id, name: 'hmrc-receipt.pdf' }); await waitForVersion(s, owner, d.documentId, d.versionId); evidence = d.documentId;
  const o = await uploadDoc(s, owner, { companyId: other.id }); await waitForVersion(s, owner, o.documentId, o.versionId); otherEvidence = o.documentId;
  q1 = ok(await as(accountant, 'post', c('/vat-returns'), { date: '2026-02-15' }), 201).id;
  ok(await as(accountant, 'post', c(`/vat-returns/${q1}/prepare`), {}));
  ok(await as(partner, 'post', c(`/vat-returns/${q1}/review`), {}));
  ok(await as(partner, 'post', c(`/vat-returns/${q1}/client-approval`), { approverContactId: contact, approvedOn: '2026-04-20', evidenceDocumentId: evidence }));
  q2 = ok(await as(accountant, 'post', c('/vat-returns'), { date: '2026-05-15' }), 201).id;
});
afterAll(() => s.stop());

describe('the presentation rule of boxes 6 to 9 (DEC-021 pattern)', () => {
  let round: string;
  it('without a verified rule there is no package; an unapproved return has none either', async () => {
    expect((await as(reviewer, 'get', c(`/vat-returns/${q1}/package`))).body.code).toBe('presentation_rule_unverified');
    expect((await as(reviewer, 'get', c(`/vat-returns/${q2}/package`))).body.code).toBe('not_approved');
  });
  it('a rule is entered with vat:manage, starts UNVERIFIED, is verified by someone else with tax:rule-verify', async () => {
    expect((await as(manager, 'post', c('/vat-presentation-rules'), { method: 'ROUND_TO_POUND', effectiveFrom: '2026-01-01', source: SOURCE })).status).toBe(403);
    const r = ok(await as(accountant, 'post', c('/vat-presentation-rules'), { method: 'ROUND_TO_POUND', effectiveFrom: '2026-01-01', source: SOURCE }), 201);
    round = r.id;
    expect(r).toMatchObject({ verificationStatus: 'UNVERIFIED', enteredByUserId: accountant.userId, source: SOURCE });
    expect((await as(accountant, 'post', c('/vat-presentation-rules'), { method: 'TRUNCATE_PENCE', effectiveFrom: '2026-06-01', source: SOURCE })).body.code).toBe('presentation_rule_overlap');
    expect((await as(reviewer, 'get', c(`/vat-returns/${q1}/package`))).body.code).toBe('presentation_rule_unverified');
    expect((await as(accountant, 'post', c(`/vat-presentation-rules/${round}/verify`), { notes: 'Checking my own rule here' })).status).toBe(403);
    ok(await as(owner, 'post', c(`/vat-presentation-rules/${round}/verify`), { notes: 'Checked against the synthetic notice' }));
    expect((await as(owner, 'post', c(`/vat-presentation-rules/${round}/verify`), { notes: 'Checked against the synthetic notice' })).body.code).toBe('already_verified');
  });
  it('the package shows boxes 1 to 5 as approved and 6 to 9 in whole pounds by the rule', async () => {
    const p = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}/package`)));
    expect(p.package.boxes).toEqual({ 1: '200.11', 2: '0.00', 3: '200.11', 4: '80.14', 5: '119.97', 6: '1001', 7: '401', 8: '0', 9: '0' });
    expect(p.package).toMatchObject({ vrn: 'GB123456789', periodFrom: '2026-01-01', periodTo: '2026-03-31', box5Direction: 'PAYABLE', presentation: { ruleId: round, method: 'ROUND_TO_POUND' } });
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a superseding version is UNVERIFIED until verified; the package then follows it', async () => {
    const t = ok(await as(accountant, 'post', c(`/vat-presentation-rules/${round}/supersede`), { method: 'TRUNCATE_PENCE', effectiveFrom: '2026-01-01', source: SOURCE, reason: 'Pence are left out, not rounded (synthetic)' }), 201);
    expect((await as(reviewer, 'get', c(`/vat-returns/${q1}/package`))).body.code).toBe('presentation_rule_unverified');
    ok(await as(owner, 'post', c(`/vat-presentation-rules/${t.id}/verify`), { notes: 'Checked against the synthetic notice' }));
    expect(ok(await as(reviewer, 'get', c(`/vat-returns/${q1}/package`))).package.boxes).toMatchObject({ 6: '1000', 7: '400' });
    expect(ok(await as(reviewer, 'get', c('/vat-presentation-rules'))).items.map((r: { method: string; supersededById: string | null }) => `${r.method}:${r.supersededById ? 'old' : 'current'}`))
      .toEqual(['ROUND_TO_POUND:old', 'TRUNCATE_PENCE:current']);
  });
});

describe('a simulated submission (fake adapter only)', () => {
  it('records the fake receipt and changes nothing else; it needs vat:file', async () => {
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/simulated-submissions`), { declarationConfirmed: true })).status).toBe(403);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/simulated-submissions`), {})).status).toBe(422);
    const f = ok(await as(partner, 'post', c(`/vat-returns/${q1}/simulated-submissions`), { declarationConfirmed: true }), 201);
    expect(f).toMatchObject({ mode: 'SIMULATED', adapter: 'fake', journalId: null, evidenceDocumentId: null, receipt: { fake: true } });
    expect(f.receiptReference).toMatch(/^000\d{9}$/);
    expect(f.notice).toMatch(/Nothing was sent to HMRC/);
    expect(ok(await as(reviewer, 'get', c(`/compliance/obligations/${obligationId}`))).status).toBe('READY');
  });
  it('production refuses the fake adapter at start', async () => {
    const { loadConfig } = await import('@uk/core');
    const base = { DATABASE_URL: 'x', FIELD_ENCRYPTION_KEY: 'k', NODE_ENV: 'production', AWS_REGION: 'eu-west-2', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', EMAIL_DRIVER: 'ses', AV_DRIVER: 'clamav' };
    expect(loadConfig(base).HMRC_VAT_ADAPTER).toBe('none');
    expect(() => loadConfig({ ...base, HMRC_VAT_ADAPTER: 'fake' })).toThrow(/HMRC_VAT_ADAPTER=fake is not allowed in production/);
  });
  it('with no adapter configured (the default) the route says the platform does not submit', async () => {
    const none = await startStack({ HMRC_VAT_ADAPTER: 'none' });
    try {
      const r = await none.api().post(orgPath(owner, c(`/vat-returns/${q1}/simulated-submissions`))).set(bearer(partner.token)).send({ declarationConfirmed: true });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('filing_not_available');
    } finally { await none.stop(); }
  });
});

describe('a filing made outside the platform, recorded with the receipt', () => {
  it('needs vat:file and the VAT liability account, which must differ from the output and input accounts', async () => {
    const body = { ...record, evidenceDocumentId: evidence };
    expect((await as(accountant, 'post', c(`/vat-returns/${q1}/filings`), body)).status).toBe(403);
    expect((await as(manager, 'post', c(`/vat-returns/${q1}/filings`), body)).status).toBe(403);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), body)).body.code).toBe('liability_account_missing');
    expect((await as(accountant, 'put', c('/vat-settings'), { ...settings, liabilityAccountId: acc['2200'] })).body.code).toBe('invalid_account');
    expect(ok(await as(accountant, 'put', c('/vat-settings'), { ...settings, liabilityAccountId: acc['2202'], reason: 'The VAT liability account (synthetic)' })).liabilityAccountId).toBe(acc['2202']);
  });
  it('refuses a date before the approval or in the future, a malformed receipt, no declaration, and evidence of another client', async () => {
    const body = { ...record, evidenceDocumentId: evidence };
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...body, submittedOn: '2026-04-19' })).body.code).toBe('submission_date_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...body, submittedOn: '2099-01-01' })).body.code).toBe('submission_date_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...body, receiptReference: 'ABC123' })).status).toBe(422);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...body, declarationConfirmed: false })).status).toBe(422);
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...body, evidenceDocumentId: otherEvidence })).body.code).toBe('evidence_invalid');
    expect((await as(partner, 'post', c(`/vat-returns/${q2}/filings`), body)).body.code).toBe('not_approved');
  });
  it('posts the liability journal at the period end and marks the obligation DONE with the receipt; once only', async () => {
    const f = ok(await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...record, evidenceDocumentId: evidence, note: 'Filed through bridging software (synthetic)' }), 201);
    expect(f).toMatchObject({ mode: 'RECORDED', submittedOn: '2026-05-02', receiptReference: '123456789012', evidenceDocumentId: evidence, adapter: null });
    expect(f.package.boxes).toMatchObject({ 3: '200.11', 4: '80.14', 5: '119.97', 6: '1000', 7: '400' });
    const j = ok(await as(reviewer, 'get', c(`/journals/${f.journalId}`)));
    expect(j).toMatchObject({ journalDate: '2026-03-31', sourceType: 'VAT_RETURN' });
    expect(j.lines.map((l: { accountCode: string; debit: string; credit: string }) => `${l.accountCode}:${l.debit}/${l.credit}`)).toEqual(['2200:200.11/0.00', '1150:0.00/80.14', '2202:0.00/119.97']);
    expect(ok(await as(reviewer, 'get', c(`/compliance/obligations/${obligationId}`)))).toMatchObject({ status: 'DONE', doneOn: '2026-05-02', doneReference: '123456789012', evidenceDocumentId: evidence });
    expect((await as(partner, 'post', c(`/vat-returns/${q1}/filings`), { ...record, evidenceDocumentId: evidence })).body.code).toBe('already_filed');
    expect(ok(await as(reviewer, 'get', c(`/vat-returns/${q1}/filings`))).items.map((x: { mode: string }) => x.mode)).toEqual(['SIMULATED', 'RECORDED']);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${f.id}'`)).toBe('vat.filing_recorded');
  });
  it('the liability journal carries no VAT code or tax point', async () => {
    const f = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}/filings`))).items.find((x: { mode: string }) => x.mode === 'RECORDED');
    const j = ok(await as(reviewer, 'get', c(`/journals/${f.journalId}`)));
    expect(j.lines.map((l: { vat: unknown }) => l.vat ?? null)).toEqual([null, null, null]);
  });
  it('VAT_RETURN is corrected in a later return: the ledger cannot reverse the liability journal directly', async () => {
    const f = ok(await as(reviewer, 'get', c(`/vat-returns/${q1}/filings`))).items.find((x: { mode: string }) => x.mode === 'RECORDED');
    expect((await as(owner, 'post', c(`/journals/${f.journalId}/reverse`), { reason: 'Trying the ledger reversal' })).body.code).toBe('subledger_journal');
    const drill = ok(await as(reviewer, 'get', c(`/journals/${f.journalId}/source`)));
    expect(drill.source).toMatchObject({ entityType: 'vat_filing', id: f.id, receiptReference: '123456789012', mode: 'RECORDED' });
  });
  it('the database keeps filings append-only, of approved returns only, and rule versions immutable', async () => {
    const f = adminSql(`SELECT id FROM vat_filing WHERE vat_return_id = '${q1}' AND mode = 'RECORDED'`);
    expect(() => adminSql(`UPDATE vat_filing SET receipt_reference = '000000000000' WHERE id = '${f}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`DELETE FROM vat_filing WHERE id = '${f}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`INSERT INTO vat_filing (organisation_id, company_id, vat_return_id, mode, package, package_sha256, presentation_rule_id, submitted_on, receipt_reference, receipt, adapter, by_user_id)
      SELECT organisation_id, company_id, '${q2}', 'SIMULATED', package, package_sha256, presentation_rule_id, submitted_on, receipt_reference, '{}'::jsonb, 'fake', by_user_id FROM vat_filing WHERE id = '${f}'`)).toThrow(/only an approved VAT return/);
    const rule = adminSql(`SELECT presentation_rule_id FROM vat_filing WHERE id = '${f}'`);
    expect(() => adminSql(`UPDATE vat_presentation_rule SET method = 'ROUND_TO_POUND' WHERE id = '${rule}'`)).toThrow(/immutable/);
    expect(() => adminSql(`DELETE FROM vat_presentation_rule WHERE id = '${rule}'`)).toThrow(/not permitted/);
  });
  it('a filing whose liability journal falls in a closed accounting period is refused; nothing is written', async () => {
    ok(await as(accountant, 'post', c('/journals'), sale('50.00', '2026-05-10')), 201);   // a zero return posts no journal, so the quarter needs VAT
    ok(await as(accountant, 'post', c(`/vat-returns/${q2}/prepare`), {}));
    ok(await as(partner, 'post', c(`/vat-returns/${q2}/review`), {}));
    ok(await as(partner, 'post', c(`/vat-returns/${q2}/client-approval`), { approverContactId: contact, approvedOn: '2026-07-10', evidenceDocumentId: evidence }));
    const period = ok(await as(reviewer, 'get', c('/periods'))).items[0].id;
    ok(await as(owner, 'post', c(`/periods/${period}/close`), { reason: 'Closed for the test (synthetic)', acknowledgeUnreconciledBank: true, acknowledgeUnrevaluedFx: true }));
    const r = await as(partner, 'post', c(`/vat-returns/${q2}/filings`), { ...record, submittedOn: '2026-07-20', receiptReference: '210987654321', evidenceDocumentId: evidence });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('period_closed');
    expect(ok(await as(reviewer, 'get', c(`/vat-returns/${q2}/filings`))).items).toEqual([]);
  });
});
