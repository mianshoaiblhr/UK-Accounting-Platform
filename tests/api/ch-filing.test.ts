import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { approvedYear, type ApprovedYear } from '../helpers/approved-year';
import { addMember, bearer, createUser, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V3-M3 (DEC-095) through the public API: the Companies House filing of the iXBRL document of a synthetic approved year, along the path
 * DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED, a rejection (the fake adapter rejects company numbers starting 99), a filing made
 * elsewhere recorded with its evidence, and the accounts deadline. The adapter is a fake: nothing reaches Companies House.
 */
let s: Stack;
let owner: TestUser, admin: TestUser;
let good: ApprovedYear, bad: ApprovedYear;
let goodDoc: string, badDoc: string, goodObligation: string, notADirector: string;
const SOURCE = { url: 'https://example.invalid/synthetic-taxonomy', provision: 'Synthetic taxonomy 2026 (test fixture)', retrievedOn: '2026-01-01' };
const ENTRIES = [
  { sourceKind: 'COMPANY', sourceKey: 'company.name', concept: 'bus:EntityName', dataType: 'TEXT', periodType: 'DURATION', mandatory: true },
  { sourceKind: 'LINE', sourceKey: 'B.NA', concept: 'core:NetAssets', dataType: 'MONETARY', periodType: 'INSTANT', decimals: 2, mandatory: true },
];
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const c = (y: ApprovedYear, p: string) => `/companies/${y.company.id}${p}`;
async function documentOf(y: ApprovedYear) {
  const v = ok(await as(admin, 'post', '/ixbrl/taxonomy-versions', { label: `Synthetic for ${y.standardCode}`, standardCode: y.standardCode, entryPoint: 'https://example.invalid/tax/entry.xsd',
    namespaces: { core: 'https://example.invalid/core', bus: 'https://example.invalid/bus' }, entityScheme: 'https://example.invalid/registry', effectiveFrom: '2020-01-01', source: SOURCE }), 201);
  for (const e of ENTRIES) ok(await as(admin, 'post', `/ixbrl/taxonomy-versions/${v.id}/entries`, e), 201);
  ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${v.id}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
  const d = ok(await as(y.accountant, 'post', c(y, '/ixbrl-documents'), { yearStart: y.yearStart }), 201);
  expect(d.status).toBe('VALID');
  return d.id as string;
}
const authority = (y: ApprovedYear, o: object = {}) => ({ directorContactId: y.director, authorisedOn: '2026-03-20', evidenceDocumentId: y.evidence, ...o });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  good = await approvedYear(s, owner, { name: 'Filing Good Ltd', companyNumber: '01234567', standardCode: 'SYN-CH1' });
  bad = await approvedYear(s, owner, { name: 'Filing Rejected Ltd', companyNumber: '99887766', standardCode: 'SYN-CH2' });
  goodDoc = await documentOf(good);
  badDoc = await documentOf(bad);
  goodObligation = ok(await as(owner, 'post', c(good, '/compliance/obligations'), { kind: 'ACCOUNTS_FILING', periodEnd: good.yearEnd, dueDate: '2026-09-30', reason: 'Entered by hand for the synthetic year' }), 201).id;
  notADirector = ok(await as(owner, 'post', '/contacts', { companyId: good.company.id, kind: 'PERSON', name: 'Not A Director' }), 201).id;
}, 480_000);
afterAll(() => s.stop());

describe('the path to ACCEPTED through the port', () => {
  let id: string;
  it('a filing starts as a DRAFT of one document; it needs ixbrl:file; reading needs ledger:read', async () => {
    expect((await as(good.accountant, 'post', c(good, '/ch-filings'), { documentId: goodDoc })).status).toBe(403);
    const f = ok(await as(good.partner, 'post', c(good, '/ch-filings'), { documentId: goodDoc }), 201);
    id = f.id;
    expect(f).toMatchObject({ status: 'DRAFT', mode: 'PORT', documentId: goodDoc, events: [{ fromStatus: null, toStatus: 'DRAFT' }] });
    expect((await as(good.partner, 'post', c(good, '/ch-filings'), { documentId: goodDoc })).body.code).toBe('filing_exists');
    expect((await as(good.partner, 'post', c(good, `/ch-filings/${id}/submit`), {})).body.code).toBe('filing_wrong_status');
    expect(ok(await as(good.reviewer, 'get', c(good, '/ch-filings'))).items.map((x: { id: string }) => x.id)).toEqual([id]);
  });
  it('VALIDATED by one person; the authority is recorded by another, from a serving director, dated, with evidence', async () => {
    expect(ok(await as(good.partner, 'post', c(good, `/ch-filings/${id}/validate`), {}))).toMatchObject({ status: 'VALIDATED', validatedByUserId: good.partner.userId });
    expect((await as(good.partner, 'post', c(good, `/ch-filings/${id}/authorise`), authority(good))).body.code).toBe('self_authorisation_not_allowed');
    expect((await as(owner, 'post', c(good, `/ch-filings/${id}/authorise`), authority(good, { authorisedOn: '2099-01-01' }))).body.code).toBe('authority_date_invalid');
    expect((await as(owner, 'post', c(good, `/ch-filings/${id}/authorise`), authority(good, { directorContactId: notADirector }))).body.code).toBe('director_not_serving');
    expect((await as(owner, 'post', c(good, `/ch-filings/${id}/authorise`), authority(good, { evidenceDocumentId: bad.evidence }))).body.code).toBe('evidence_invalid');
    const f = ok(await as(owner, 'post', c(good, `/ch-filings/${id}/authorise`), authority(good, { note: 'The director asked us to file (synthetic)' })));
    expect(f).toMatchObject({ status: 'AUTHORISED', authority: { byUserId: owner.userId, directorContactId: good.director, authorisedOn: '2026-03-20', evidenceDocumentId: good.evidence } });
  });
  it('SUBMITTED through the fake port with the document hash; a retry returns the same submission', async () => {
    const f = ok(await as(owner, 'post', c(good, `/ch-filings/${id}/submit`), {}));
    expect(f.status).toBe('SUBMITTED');
    expect(f.submissionId).toMatch(/^FAKE-[0-9A-F]{16}$/);
    expect(f.events.at(-1)).toMatchObject({ fromStatus: 'AUTHORISED', toStatus: 'SUBMITTED', submissionId: f.submissionId, request: { companyNumber: '01234567', documentSha256: f.payloadSha256, idempotencyKey: id } });
    expect(ok(await as(owner, 'post', c(good, `/ch-filings/${id}/submit`), {})).submissionId).toBe(f.submissionId);
  });
  it('ACCEPTED when the status is read; the accounts deadline is DONE with the reference; the accounts are filed once', async () => {
    const f = ok(await as(good.partner, 'post', c(good, `/ch-filings/${id}/status`)));
    expect(f).toMatchObject({ status: 'ACCEPTED', chReference: `${f.submissionId}-ACC` });
    expect(f.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['DRAFT', 'VALIDATED', 'AUTHORISED', 'SUBMITTED', 'ACCEPTED']);
    expect(ok(await as(good.reviewer, 'get', c(good, `/compliance/obligations/${goodObligation}`)))).toMatchObject({ status: 'DONE', doneReference: f.chReference, version: 2 });
    const again = ok(await as(good.accountant, 'post', c(good, '/ixbrl-documents'), { yearStart: good.yearStart }), 201);
    expect((await as(owner, 'post', c(good, '/ch-filings'), { documentId: again.id })).body.code).toBe('already_filed');
  });
  it('the database keeps the path and the evidence', async () => {
    expect(() => adminSql(`UPDATE ch_filing SET status = 'DRAFT' WHERE id = '${id}'`)).toThrow(/moves only|final/);
    expect(() => adminSql(`UPDATE ch_filing SET submission_id = 'OTHER' WHERE id = '${id}'`)).toThrow(/cannot change/);
    expect(() => adminSql(`DELETE FROM ch_filing WHERE id = '${id}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`UPDATE ch_filing_event SET note = 'changed' WHERE filing_id = '${id}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`INSERT INTO ch_filing (organisation_id, company_id, document_id, status, payload_sha256, created_by_user_id) SELECT organisation_id, company_id, document_id, 'ACCEPTED', payload_sha256, created_by_user_id FROM ch_filing WHERE id = '${id}'`)).toThrow(/starts as a DRAFT/);
  });
});

describe('a rejection, the port switched off, and a filing made elsewhere', () => {
  let id: string;
  it('production refuses the fake Companies House adapter at start', async () => {
    const { loadConfig } = await import('@uk/core');
    const base = { DATABASE_URL: 'x', FIELD_ENCRYPTION_KEY: 'k', NODE_ENV: 'production', AWS_REGION: 'eu-west-2', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', EMAIL_DRIVER: 'ses', AV_DRIVER: 'clamav' };
    expect(loadConfig(base).CH_ADAPTER).toBe('none');
    expect(() => loadConfig({ ...base, CH_ADAPTER: 'fake' })).toThrow(/CH_ADAPTER=fake is not allowed in production/);
  });
  it('with no adapter configured (the default) submission says the platform does not file', async () => {
    id = ok(await as(bad.partner, 'post', c(bad, '/ch-filings'), { documentId: badDoc }), 201).id;
    ok(await as(bad.partner, 'post', c(bad, `/ch-filings/${id}/validate`), {}));
    ok(await as(owner, 'post', c(bad, `/ch-filings/${id}/authorise`), authority(bad)));
    const none = await startStack({ CH_ADAPTER: 'none' });
    try {
      const r = await none.api().post(orgPath(owner, c(bad, `/ch-filings/${id}/submit`))).set(bearer(owner.token)).send({});
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('filing_not_available');
    } finally { await none.stop(); }
  });
  it('REJECTED is final with the reasons; a new filing of the same document may follow and be recorded as filed elsewhere', async () => {
    ok(await as(owner, 'post', c(bad, `/ch-filings/${id}/submit`), {}));
    const r = ok(await as(owner, 'post', c(bad, `/ch-filings/${id}/status`)));
    expect(r).toMatchObject({ status: 'REJECTED', rejectionReasons: ['FAKE: the company number is not on the register (test rejection)'] });
    expect((await as(owner, 'post', c(bad, `/ch-filings/${id}/status`))).body.code).toBe('filing_wrong_status');
    const n = ok(await as(bad.partner, 'post', c(bad, '/ch-filings'), { documentId: badDoc }), 201).id;
    ok(await as(bad.partner, 'post', c(bad, `/ch-filings/${n}/validate`), {}));
    expect((await as(owner, 'post', c(bad, `/ch-filings/${n}/record`), { reference: 'CH-SYN-0001', acceptedOn: '2099-01-01', evidenceDocumentId: bad.evidence })).body.code).toBe('acceptance_date_invalid');
    const f = ok(await as(owner, 'post', c(bad, `/ch-filings/${n}/record`), { reference: 'CH-SYN-0001', acceptedOn: '2026-04-01', evidenceDocumentId: bad.evidence, note: 'Filed through the WebFiling service (synthetic)' }));
    expect(f).toMatchObject({ status: 'ACCEPTED', mode: 'RECORDED', chReference: 'CH-SYN-0001', acceptedOn: '2026-04-01', acceptanceEvidenceId: bad.evidence, submissionId: null });
    expect(f.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['DRAFT', 'VALIDATED', 'ACCEPTED']);
  });
});
