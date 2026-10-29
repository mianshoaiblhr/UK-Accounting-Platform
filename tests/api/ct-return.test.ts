import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@uk/core';
import { CT600_FIELDS } from '@uk/contracts';
import { adminSql } from '../helpers/db';
import { approvedYear, type ApprovedYear } from '../helpers/approved-year';
import { addMember, bearer, createUser, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V4-M5 (DEC-102) through the public API: the CT return of an approved computation of a synthetic approved year, with the CT600's boxes (a
 * verified CT600_FORM rule), the computation as inline XBRL (a verified CT-COMP taxonomy version) and the accounts' iXBRL, along DRAFT ->
 * VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED; a rejection (the fake adapter rejects UTRs starting 99); a return filed elsewhere recorded with
 * its evidence; the CT return deadline. The adapter is a fake: nothing reaches HMRC. The box numbers and concepts are synthetic fixtures.
 */
let s: Stack;
let owner: TestUser, admin: TestUser;
let good: ApprovedYear, bad: ApprovedYear;
const computation: Record<string, string> = {};
let obligation: string;
const SOURCE = { url: 'https://example.invalid/synthetic', provision: 'Synthetic provision (test fixture)', retrievedOn: '2026-01-01' };
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const c = (y: ApprovedYear, p: string) => `/companies/${y.company.id}${p}`;

async function accountsIxbrl(y: ApprovedYear) {
  const v = ok(await as(admin, 'post', '/ixbrl/taxonomy-versions', { label: `Accounts ${y.standardCode}`, standardCode: y.standardCode, entryPoint: 'https://example.invalid/tax/entry.xsd',
    namespaces: { core: 'https://example.invalid/core', bus: 'https://example.invalid/bus' }, entityScheme: 'https://example.invalid/registry', effectiveFrom: '2020-01-01', source: SOURCE }), 201);
  ok(await as(admin, 'post', `/ixbrl/taxonomy-versions/${v.id}/entries`, { sourceKind: 'COMPANY', sourceKey: 'company.name', concept: 'bus:EntityName', dataType: 'TEXT', periodType: 'DURATION', mandatory: true }), 201);
  ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${v.id}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
  expect(ok(await as(y.accountant, 'post', c(y, '/ixbrl-documents'), { yearStart: y.yearStart }), 201).status).toBe('VALID');
}
/** The CT chain of the approved year: period, allowances, losses, an approved computation and the UTR. */
async function approvedComputation(y: ApprovedYear, utr: string) {
  const period = ok(await as(y.accountant, 'post', c(y, '/ct-periods/derive'), { yearStart: y.yearStart })).items[0].id;
  ok(await as(y.accountant, 'post', c(y, `/ct-periods/${period}/associated-companies`), { associatedCompanies: 0, reason: 'No associated companies (synthetic)' }));
  for (const a of ok(await as(owner, 'get', c(y, '/fixed-assets'))).items) ok(await as(y.accountant, 'post', c(y, `/fixed-assets/${a.id}/tax`), { category: 'MAIN_POOL', reason: 'Plant in the main pool (synthetic)' }));
  const asOf = '2024-12-31';
  for (const pool of ['MAIN', 'SPECIAL_RATE']) {
    const o = ok(await as(y.accountant, 'post', c(y, '/ca-pool-openings'), { pool, asOf, amount: '0', evidenceDocumentId: y.evidence, reason: 'A new company: nothing brought forward' }), 201);
    ok(await as(admin, 'post', c(y, `/ca-pool-openings/${o.id}/verify`), { notes: 'Checked: the company started in 2025' }));
  }
  const ca = ok(await as(owner, 'get', c(y, `/ct-periods/${period}/capital-allowances`)));
  expect(ca.problems).toEqual([]);
  ok(await as(y.accountant, 'post', c(y, `/ct-periods/${period}/capital-allowances`), { fingerprint: ca.fingerprint }), 201);
  const l = ok(await as(y.accountant, 'post', c(y, '/ct-loss-openings'), { asOf, amount: '0', evidenceDocumentId: y.evidence, reason: 'A new company: no losses brought forward' }), 201);
  ok(await as(admin, 'post', c(y, `/ct-loss-openings/${l.id}/verify`), { notes: 'Checked: the company started in 2025' }));
  const v = ok(await as(owner, 'get', c(y, `/ct-periods/${period}/computation`)));
  expect(v.problems).toEqual([]);
  const p = ok(await as(y.accountant, 'post', c(y, `/ct-periods/${period}/computation`), { fingerprint: v.fingerprint }), 201);
  ok(await as(y.partner, 'post', c(y, `/ct-periods/${period}/computations/${p.id}/approve`), { notes: 'Reviewed the synthetic computation' }));
  ok(await as(y.accountant, 'put', c(y, '/tax-profile'), { utr, reason: 'From the synthetic notice to file' }));
  computation[y.company.id] = p.id;
  return period as string;
}

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  good = await approvedYear(s, owner, { name: 'CT Return Good Ltd', companyNumber: '02345678', standardCode: 'SYN-CTR1' });
  bad = await approvedYear(s, owner, { name: 'CT Return Rejected Ltd', companyNumber: '03456789', standardCode: 'SYN-CTR2' });
  // the CT rules are organisation data: entered once through one company, verified by a second person
  const boxes = Object.fromEntries(CT600_FIELDS.map((f, n) => [f, 100 + n]));
  for (const [kind, parameters] of [['PERIOD_MAX_MONTHS', { months: 12 }], ['AIA_LIMIT', { annualLimit: '1000000' }], ['WDA_RATES', { mainRate: '18', specialRate: '6' }], ['SMALL_POOL_LIMIT', { limit: '1000' }],
    ['CT_RATES', { mainRate: '25', smallProfitsRate: '19', lowerLimit: '50000', upperLimit: '250000', marginalReliefFraction: { numerator: 3, denominator: 200 } }],
    ['CT600_FORM', { formVersion: 'CT600 (synthetic fixture)', boxes }]] as const) {
    const id = ok(await as(good.accountant, 'post', c(good, '/ct-rules'), { kind, effectiveFrom: '2020-01-01', parameters, source: SOURCE }), 201).id;
    ok(await as(owner, 'post', c(good, `/ct-rules/${id}/verify`), { notes: 'Checked the synthetic fixture' }));
  }
  for (const [y, utr] of [[good, '1234567890'], [bad, '9988776655']] as const) { await accountsIxbrl(y); await approvedComputation(y, utr); }
  obligation = ok(await as(owner, 'post', c(good, '/compliance/obligations'), { kind: 'CT_RETURN', periodStart: good.yearStart, periodEnd: good.yearEnd, dueDate: '2026-12-31', reason: 'The Company Tax Return (synthetic)' }), 201).id;
}, 300_000);
afterAll(() => s.stop());

describe('starting a return', () => {
  it('is refused, naming the problem, while there is no verified CT-COMP taxonomy version', async () => {
    const r = await as(good.partner, 'post', c(good, '/ct-returns'), { computationId: computation[good.company.id] });
    expect(r.body).toMatchObject({ code: 'ct_return_problems' });
    expect(r.body.errors.problems).toEqual(['There is no verified CT-COMP taxonomy version for the period']);
    const v = ok(await as(admin, 'post', '/ixbrl/taxonomy-versions', { label: 'Synthetic CT computation mapping', standardCode: 'CT-COMP', entryPoint: 'https://example.invalid/ct/comp.xsd',
      namespaces: { ct: 'https://example.invalid/ct-comp' }, entityScheme: 'https://example.invalid/utr', effectiveFrom: '2020-01-01', source: SOURCE }), 201);
    for (const [key, concept] of [['ct.turnover', 'ct:Turnover'], ['ct.taxableTotalProfits', 'ct:TaxableTotalProfits'], ['ct.corporationTaxChargeable', 'ct:CorporationTaxChargeable'], ['ct.fy1.profit', 'ct:ProfitFinancialYear']]) {
      ok(await as(admin, 'post', `/ixbrl/taxonomy-versions/${v.id}/entries`, { sourceKind: 'FACT', sourceKey: key, concept, dataType: 'MONETARY', periodType: 'DURATION', decimals: 2, mandatory: key !== 'ct.fy1.profit' }), 201);
    }
    ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${v.id}/verify`, { notes: 'Checked against the synthetic computation taxonomy' }));
  });
  it('needs ct:file; holds the CT600 with its boxes, the tagged computation (well-formed) and the accounts iXBRL; one live return per computation', async () => {
    expect((await as(good.accountant, 'post', c(good, '/ct-returns'), { computationId: computation[good.company.id] })).status).toBe(403);
    const r = ok(await as(good.partner, 'post', c(good, '/ct-returns'), { computationId: computation[good.company.id] }), 201);
    expect(r).toMatchObject({ status: 'DRAFT', mode: 'PORT', computationId: computation[good.company.id] });
    expect(r.package.form.boxes.find((b: { field: string }) => b.field === 'taxableTotalProfits')).toMatchObject({ box: 108 });
    expect(r.package.ct600.company).toEqual({ name: 'CT Return Good Ltd', registrationNumber: '02345678', utr: '1234567890' });
    const doc = await s.api().get(orgPath(owner, c(good, `/ct-returns/${r.id}/computation-ixbrl`))).set(bearer(owner.token)).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (x: string) => { d += x; }); res.on('end', () => cb(null, d)); });
    expect(doc.status).toBe(200);
    expect(doc.body).toContain('name="ct:TaxableTotalProfits"');
    expect(doc.body).toContain('scheme="https://example.invalid/utr">1234567890<');
    execFileSync('xmllint', ['--noout', '-'], { input: doc.body });
    expect((await as(good.partner, 'post', c(good, '/ct-returns'), { computationId: computation[good.company.id] })).body.code).toBe('return_exists');
  });
});

describe('the path to HMRC (a test stand-in)', () => {
  let id: string;
  it('validate, then a declaration recorded by someone other than the validator', async () => {
    id = ok(await as(owner, 'get', c(good, '/ct-returns'))).items[0].id;
    expect(ok(await as(good.partner, 'post', c(good, `/ct-returns/${id}/validate`), {})).status).toBe('VALIDATED');
    const decl = { directorContactId: good.director, declaredOn: '2026-03-20', evidenceDocumentId: good.evidence };
    expect((await as(good.partner, 'post', c(good, `/ct-returns/${id}/authorise`), decl)).body.code).toBe('self_authorisation_not_allowed');
    expect((await as(owner, 'post', c(good, `/ct-returns/${id}/authorise`), { ...decl, declaredOn: '2999-01-01' })).body.code).toBe('authority_date_invalid');
    expect(ok(await as(owner, 'post', c(good, `/ct-returns/${id}/authorise`), decl)).status).toBe('AUTHORISED');
  });
  it('submit (idempotent), then the status: ACCEPTED with the reference; the CT return deadline is DONE; a further return of the period is refused', async () => {
    const sub = ok(await as(owner, 'post', c(good, `/ct-returns/${id}/submit`), {}));
    expect(sub).toMatchObject({ status: 'SUBMITTED', submissionId: expect.stringMatching(/^FAKE-CT-[0-9A-F]{16}$/) });
    expect(ok(await as(owner, 'post', c(good, `/ct-returns/${id}/submit`), {})).submissionId).toBe(sub.submissionId);
    const acc = ok(await as(owner, 'post', c(good, `/ct-returns/${id}/status`), {}));
    expect(acc).toMatchObject({ status: 'ACCEPTED', hmrcReference: `${sub.submissionId}-IRMARK` });
    expect(acc.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['DRAFT', 'VALIDATED', 'AUTHORISED', 'SUBMITTED', 'ACCEPTED']);
    expect(ok(await as(owner, 'get', c(good, `/compliance/obligations/${obligation}`)))).toMatchObject({ status: 'DONE', doneReference: acc.hmrcReference });
    expect((await as(good.partner, 'post', c(good, '/ct-returns'), { computationId: computation[good.company.id] })).body.code).toBe('already_filed');
  });
  it('the database keeps what a return files, its path and its events', () => {
    expect(() => adminSql(`UPDATE ct_return SET payload_sha256 = '${'0'.repeat(64)}' WHERE id = '${id}'`)).toThrow(/cannot change/);
    expect(() => adminSql(`DELETE FROM ct_return WHERE id = '${id}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`UPDATE ct_return_event SET note = 'x' WHERE return_id = '${id}'`)).toThrow(/not permitted/);
  });
});

describe('a rejection, and a return filed elsewhere', () => {
  it('a UTR the stand-in does not recognise is REJECTED with reasons; a new return may follow and be recorded as filed elsewhere', async () => {
    const decl = { directorContactId: bad.director, declaredOn: '2026-03-20', evidenceDocumentId: bad.evidence };
    const r = ok(await as(bad.partner, 'post', c(bad, '/ct-returns'), { computationId: computation[bad.company.id] }), 201);
    ok(await as(bad.partner, 'post', c(bad, `/ct-returns/${r.id}/validate`), {}));
    ok(await as(owner, 'post', c(bad, `/ct-returns/${r.id}/authorise`), decl));
    ok(await as(owner, 'post', c(bad, `/ct-returns/${r.id}/submit`), {}));
    expect(ok(await as(owner, 'post', c(bad, `/ct-returns/${r.id}/status`), {}))).toMatchObject({ status: 'REJECTED', rejectionReasons: [expect.stringMatching(/test rejection/)] });
    const again = ok(await as(bad.partner, 'post', c(bad, '/ct-returns'), { computationId: computation[bad.company.id] }), 201);
    ok(await as(bad.partner, 'post', c(bad, `/ct-returns/${again.id}/validate`), {}));
    expect((await as(owner, 'post', c(bad, `/ct-returns/${again.id}/record`), { reference: 'HMRC-REF-1', acceptedOn: '2999-01-01', evidenceDocumentId: bad.evidence })).body.code).toBe('acceptance_date_invalid');
    expect(ok(await as(owner, 'post', c(bad, `/ct-returns/${again.id}/record`), { reference: 'HMRC-REF-1', acceptedOn: '2026-04-01', evidenceDocumentId: bad.evidence })))
      .toMatchObject({ status: 'ACCEPTED', mode: 'RECORDED', hmrcReference: 'HMRC-REF-1', acceptedOn: '2026-04-01' });
  });
  it('production refuses the fake adapter at start; none is the default', () => {
    const base = { DATABASE_URL: 'x', FIELD_ENCRYPTION_KEY: 'k', NODE_ENV: 'production', AWS_REGION: 'eu-west-2', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', EMAIL_DRIVER: 'ses', AV_DRIVER: 'clamav' };
    expect(loadConfig(base).HMRC_CT_ADAPTER).toBe('none');
    expect(() => loadConfig({ ...base, HMRC_CT_ADAPTER: 'fake' })).toThrow(/HMRC_CT_ADAPTER=fake is not allowed in production/);
  });
});
