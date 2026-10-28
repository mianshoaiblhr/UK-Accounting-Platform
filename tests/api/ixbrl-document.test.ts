import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { approvedYear, type ApprovedYear } from '../helpers/approved-year';
import { bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V3-M2 (DEC-094) through the public API: the iXBRL document of a synthetic approved year (the V2-M6c golden), tagged by a synthetic verified
 * taxonomy version. The concepts here are test fixtures, not the FRC taxonomy. Nothing is filed.
 */
let s: Stack;
let owner: TestUser;
let y: ApprovedYear;
let mainVersion: string;
const SOURCE = { url: 'https://example.invalid/synthetic-taxonomy', provision: 'Synthetic taxonomy 2026 (test fixture)', retrievedOn: '2026-01-01' };
const NS = { core: 'https://example.invalid/core', bus: 'https://example.invalid/bus' };
const SCHEME = 'https://example.invalid/registry';
const money = (sourceKey: string, concept: string, periodType: 'INSTANT' | 'DURATION', o: object = {}) => ({ sourceKind: 'LINE', sourceKey, concept, dataType: 'MONETARY', periodType, decimals: 2, ...o });
const detail = (sourceKey: string, concept: string, dataType: 'TEXT' | 'DATE', periodType: 'INSTANT' | 'DURATION' = 'DURATION') => ({ sourceKind: 'COMPANY', sourceKey, concept, dataType, periodType, mandatory: true });
const ENTRIES = [
  detail('company.name', 'bus:EntityName', 'TEXT'), detail('company.number', 'bus:RegisteredNumber', 'TEXT'), detail('period.start', 'bus:PeriodStart', 'DATE'),
  detail('period.end', 'bus:PeriodEnd', 'DATE'), detail('balanceSheetDate', 'bus:BalanceSheetDate', 'DATE', 'INSTANT'), detail('approval.director', 'core:SigningDirector', 'TEXT'),
  detail('approval.date', 'core:ApprovalDate', 'DATE'),
  { sourceKind: 'FACT', sourceKey: 'employees.average', concept: 'core:AverageEmployees', dataType: 'TEXT', periodType: 'DURATION' },
  money('P.T', 'core:Turnover', 'DURATION'), money('P.DEP', 'core:Depreciation', 'DURATION'), money('P.PROFIT', 'core:ProfitLoss', 'DURATION', { mandatory: true }),
  money('B.FA', 'core:FixedAssets', 'INSTANT'), money('B.CW', 'core:Creditors', 'INSTANT', { dimensions: [{ axis: 'core:MaturityAxis', member: 'core:WithinOneYear' }] }),
  money('B.NA', 'core:NetAssets', 'INSTANT', { mandatory: true }), money('B.CR', 'core:Equity', 'INSTANT', { mandatory: true }),
];
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const c = (p: string) => `/companies/${y.company.id}${p}`;
async function taxonomy(o: { label: string; entityScheme?: string; entries?: object[]; verify?: boolean; effectiveFrom?: string }) {
  const v = ok(await as(y.author, 'post', '/ixbrl/taxonomy-versions', { label: o.label, standardCode: y.standardCode, entryPoint: 'https://example.invalid/tax/entry.xsd', namespaces: NS,
    effectiveFrom: o.effectiveFrom ?? '2020-01-01', source: SOURCE, ...(o.entityScheme ? { entityScheme: o.entityScheme } : {}) }), 201);
  for (const e of o.entries ?? ENTRIES) ok(await as(y.author, 'post', `/ixbrl/taxonomy-versions/${v.id}/entries`, e), 201);
  if (o.verify !== false) ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${v.id}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
  return v.id as string;
}
const line = (key: string) => [...y.pkg.content.accounts.statements.profitAndLoss, ...y.pkg.content.accounts.statements.balanceSheet].find((l: { key: string }) => l.key === key);

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  y = await approvedYear(s, owner, { companyNumber: '01234567' });
}, 240_000);
afterAll(() => s.stop());

describe('which taxonomy version tags the year', () => {
  it('none verified: refused; a verified one without an entity scheme: refused until superseded with one', async () => {
    const draft = await taxonomy({ label: 'Draft only', verify: false });
    expect((await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart })).body.code).toBe('taxonomy_unverified');
    ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${draft}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
    expect((await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart })).body.code).toBe('entity_scheme_missing');
    mainVersion = ok(await as(y.author, 'post', `/ixbrl/taxonomy-versions/${draft}/supersede`, { label: 'With the scheme', effectiveFrom: '2020-01-01', source: SOURCE, reason: 'Add the entity scheme (synthetic)', entityScheme: SCHEME }), 201).id;
    ok(await as(owner, 'post', `/ixbrl/taxonomy-versions/${mainVersion}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
  });
});

describe('the iXBRL document of the approved year', () => {
  let doc: any, content: string;
  it('needs accounts:prepare; generates a VALID document with the API\'s counts and warnings', async () => {
    expect((await as(y.reviewer, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart })).status).toBe(403);
    expect((await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: '2030-01-01' })).body.code).toBe('framework_not_set');
    doc = ok(await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart }), 201);
    expect(doc).toMatchObject({ status: 'VALID', errors: [], packageId: y.pkg.id, taxonomyVersionId: mainVersion, byUserId: y.accountant.userId });
    content = (await as(y.reviewer, 'get', c(`/ixbrl-documents/${doc.id}/content`))).text;
    writeFileSync(join(process.env.IXBRL_DUMP ?? tmpdir(), 'ixbrl-document.xhtml'), content);
    expect(createHash('sha256').update(content).digest('hex')).toBe(doc.sha256);
  });
  it('is well-formed XHTML with the schema reference, the contexts, the unit and the tagged figures of the package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixbrl-'));
    writeFileSync(join(dir, 'doc.xhtml'), content);
    execFileSync('xmllint', ['--noout', join(dir, 'doc.xhtml')]);   // throws if not well-formed
    expect(content).toContain('<link:schemaRef xlink:type="simple" xlink:href="https://example.invalid/tax/entry.xsd"/>');
    expect(content).toContain('xmlns:core="https://example.invalid/core"');
    expect(content).toContain(`<xbrli:identifier scheme="${SCHEME}">01234567</xbrli:identifier>`);
    expect(content).toContain(`<xbrli:startDate>${y.yearStart}</xbrli:startDate><xbrli:endDate>${y.yearEnd}</xbrli:endDate>`);
    expect(content).toContain(`<xbrli:instant>${y.yearEnd}</xbrli:instant>`);
    expect(content).toContain('<xbrldi:explicitMember dimension="core:MaturityAxis">core:WithinOneYear</xbrldi:explicitMember>');
    expect(content).toContain('<xbrli:unit id="U-GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>');
    const tagged = (concept: string) => [...content.matchAll(new RegExp(`name="${concept}"[^>]*>([^<]*)<`, 'g'))].map((m) => m[1]);
    expect(tagged('core:Turnover')[0]).toBe(Number(line('P.T').amount).toLocaleString('en-GB', { minimumFractionDigits: 2 }));
    expect(tagged('core:NetAssets')[0]).toBe(Number(line('B.NA').amount).toLocaleString('en-GB', { minimumFractionDigits: 2 }));
    expect(tagged('bus:EntityName')).toEqual([y.pkg.content.company.name]);
    expect(tagged('core:ApprovalDate')).toEqual([y.pkg.content.clientApproval.approvedOn]);
    expect(tagged('core:AverageEmployees')).toEqual(['1']);
    expect(doc.contextCount).toBe((content.match(/<xbrli:context /g) ?? []).length);
    expect(doc.factCount).toBe((content.match(/<ix:non(Fraction|Numeric) /g) ?? []).length);
  });
  it('the same package and mapping give the same document; a reader lists and reads it; it cannot be changed', async () => {
    const again = ok(await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart }), 201);
    expect(again.sha256).toBe(doc.sha256);
    expect(ok(await as(y.reviewer, 'get', c(`/ixbrl-documents?yearStart=${y.yearStart}`))).items.map((d: { id: string }) => d.id)).toEqual([again.id, doc.id]);
    expect(ok(await as(y.reviewer, 'get', c(`/ixbrl-documents/${doc.id}`)))).toMatchObject({ id: doc.id, status: 'VALID' });
    expect(() => adminSql(`UPDATE ixbrl_document SET status = 'INVALID' WHERE id = '${doc.id}'`)).toThrow(/not permitted/);
    expect(() => adminSql(`DELETE FROM ixbrl_document WHERE id = '${doc.id}'`)).toThrow(/not permitted/);
  });
});

describe('the checks', () => {
  it('two verified versions for the same year: the caller names one; a mandatory value missing and conflicting facts make the document INVALID', async () => {
    const strict = await taxonomy({ label: 'Strict checks', entityScheme: SCHEME, entries: [...ENTRIES,
      { sourceKind: 'FACT', sourceKey: 'directors.report', concept: 'core:DirectorsReport', dataType: 'TEXT', periodType: 'DURATION', mandatory: true },
      money('B.CR', 'core:NetAssets', 'INSTANT', { negate: true }).sourceKey === 'B.CR' ? money('B.TALCL', 'core:NetAssets', 'INSTANT', { negate: true }) : {}] });
    expect((await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart })).body.code).toBe('taxonomy_ambiguous');
    const d = ok(await as(y.accountant, 'post', c('/ixbrl-documents'), { yearStart: y.yearStart, taxonomyVersionId: strict }), 201);
    expect(d.status).toBe('INVALID');
    expect(d.errors).toEqual(expect.arrayContaining(['The mandatory fact directors.report (core:DirectorsReport) has no value', expect.stringMatching(/^core:NetAssets has two different values in the same context/)]));
  });
  it('the routes are behind ixbrl.filing', async () => {
    const solo = await createUser(s, { type: 'PRACTICE' });
    expect((await s.api().put(orgPath(solo, '/feature-flags/ixbrl.filing')).set(bearer(solo.token)).send({ enabled: false, reason: 'Off for the test' })).status).toBe(200);
    const theirs = await makeCompany(s, solo, 'Flag Off Ltd');
    expect((await s.api().get(orgPath(solo, `/companies/${theirs.id}/ixbrl-documents`)).set(bearer(solo.token))).body.code).toBe('feature_disabled');
  });
});
