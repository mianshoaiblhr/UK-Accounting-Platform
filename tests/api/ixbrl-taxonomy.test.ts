import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importTaxonomy } from '../../scripts/ixbrl/import-taxonomy.mjs';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V3-M1 (DEC-093) through the public API: taxonomy versions and their concept maps as organisation data, edited while UNVERIFIED, verified by a
 * second person (then frozen, in the database too) and changed by supersession. The draft pack imports UNVERIFIED. Nothing of the taxonomy is in code.
 */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, accountant: TestUser, viewer: TestUser;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, `/ixbrl${p}`)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const pack = JSON.parse(readFileSync(resolve(__dirname, '../../content/ixbrl/drafts/frc-frs105.json'), 'utf8'));
const SOURCE = { url: 'https://example.invalid/synthetic-taxonomy', provision: 'Synthetic taxonomy 2026 (test fixture)', retrievedOn: '2026-01-01' };
const VERSION = { label: 'Synthetic taxonomy for tests', standardCode: 'FRS105', entryPoint: 'https://example.invalid/tax/entry.xsd', namespaces: { core: 'https://example.invalid/core', bus: 'https://example.invalid/bus' }, effectiveFrom: '2026-01-01', source: SOURCE };
const ENTRY = { sourceKind: 'LINE', sourceKey: 'P.T', concept: 'core:Turnover', dataType: 'MONETARY', periodType: 'DURATION', decimals: 2 };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  accountant = await addMember(s, owner, 'accountant');
  viewer = await addMember(s, owner, 'client_viewer');
});
afterAll(() => s.stop());

describe('taxonomy versions are organisation data managed with ixbrl:rules-manage', () => {
  it('owner and admin may create a version; a partner or accountant may not; anyone in the organisation reads', async () => {
    for (const u of [partner, accountant]) expect((await as(u, 'post', '/taxonomy-versions', VERSION)).status).toBe(403);
    const v = ok(await as(admin, 'post', '/taxonomy-versions', VERSION), 201);
    expect(v).toMatchObject({ status: 'UNVERIFIED', standardCode: 'FRS105', entries: [], problems: ['the version maps nothing'], createdByUserId: admin.userId });
    expect(ok(await as(viewer, 'get', '/taxonomy-versions')).items.map((x: { id: string }) => x.id)).toContain(v.id);
  });
  it('entries are checked: decimals for money only, declared prefixes, known company details, one entry per source', async () => {
    const v = ok(await as(owner, 'post', '/taxonomy-versions', { ...VERSION, label: 'Entry checks' }), 201);
    const path = `/taxonomy-versions/${v.id}/entries`;
    expect((await as(owner, 'post', path, { ...ENTRY, decimals: null })).status).toBe(422);
    expect((await as(owner, 'post', path, { ...ENTRY, dataType: 'TEXT' })).status).toBe(422);
    expect((await as(owner, 'post', path, { ...ENTRY, concept: 'not a qname' })).status).toBe(422);
    const e = ok(await as(owner, 'post', path, ENTRY), 201);
    expect((await as(owner, 'post', path, ENTRY)).body.code).toBe('entry_exists');
    ok(await as(owner, 'post', path, { sourceKind: 'COMPANY', sourceKey: 'company.colour', concept: 'other:Colour', dataType: 'TEXT', periodType: 'DURATION' }), 201);
    const back = ok(await as(owner, 'get', `/taxonomy-versions/${v.id}`));
    expect(back.problems).toEqual(['COMPANY company.colour: the prefix of other:Colour is not declared', 'COMPANY company.colour: not a company detail the platform knows (company.name, company.number, period.start, period.end, balanceSheetDate, directors, approval.director, approval.date)']);
    const changed = ok(await as(owner, 'put', `${path}/${e.id}`, { ...ENTRY, concept: 'core:TurnoverRevenue', mandatory: true }));
    expect(changed).toMatchObject({ concept: 'core:TurnoverRevenue', mandatory: true });
  });
});

describe('the draft pack, verification by a second person and supersession', () => {
  let versionId: string;
  it('the draft pack imports UNVERIFIED with every entry and no problem; importing needs ixbrl:rules-manage', async () => {
    const call = (u: TestUser) => async (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => { const r = await as(u, method, path, body); return { status: r.status, body: r.body }; };
    await expect(importTaxonomy(call(accountant), pack)).rejects.toThrow(/HTTP 403/);
    const r = await importTaxonomy(call(admin), pack);
    expect(r).toMatchObject({ status: 'UNVERIFIED', entries: pack.entries.length, problems: [] });
    versionId = r.versionId;
  });
  it('the creator cannot verify; an inconsistent version cannot be verified; another holder of ixbrl:rule-verify verifies, which freezes it', async () => {
    expect((await as(admin, 'post', `/taxonomy-versions/${versionId}/verify`, { notes: 'Checked my own import' })).body.code).toBe('self_verification_not_allowed');
    const bad = ok(await as(admin, 'post', `/taxonomy-versions/${versionId}/entries`, { sourceKind: 'FACT', sourceKey: 'employees.average', concept: 'zz:Employees', dataType: 'TEXT', periodType: 'DURATION' }), 201);
    const refused = await as(owner, 'post', `/taxonomy-versions/${versionId}/verify`, { notes: 'Checked against the synthetic taxonomy' });
    expect(refused.body.code).toBe('version_inconsistent');
    expect(refused.body.errors.problems).toEqual(['FACT employees.average: the prefix of zz:Employees is not declared']);
    ok(await as(admin, 'delete', `/taxonomy-versions/${versionId}/entries/${bad.id}`));
    expect((await as(partner, 'post', `/taxonomy-versions/${versionId}/verify`, { notes: 'Checked against the synthetic taxonomy' })).status).toBe(403);
    const v = ok(await as(owner, 'post', `/taxonomy-versions/${versionId}/verify`, { notes: 'Checked against the synthetic taxonomy' }));
    expect(v).toMatchObject({ status: 'VERIFIED', verifiedByUserId: owner.userId });
    const entry = v.entries[0];
    expect((await as(admin, 'patch', `/taxonomy-versions/${versionId}`, { label: 'Changed after verification' })).body.code).toBe('version_frozen');
    expect((await as(admin, 'put', `/taxonomy-versions/${versionId}/entries/${entry.id}`, { ...ENTRY, sourceKey: entry.sourceKey, sourceKind: entry.sourceKind })).body.code).toBe('version_frozen');
    expect((await as(admin, 'delete', `/taxonomy-versions/${versionId}/entries/${entry.id}`)).body.code).toBe('version_frozen');
    expect(() => adminSql(`UPDATE xbrl_concept_map SET concept = 'core:Changed' WHERE id = '${entry.id}'`)).toThrow(/frozen/);
    expect(() => adminSql(`DELETE FROM xbrl_concept_map WHERE id = '${entry.id}'`)).toThrow(/frozen/);
    expect(() => adminSql(`UPDATE xbrl_taxonomy_version SET entry_point = 'https://example.invalid/other.xsd' WHERE id = '${versionId}'`)).toThrow(/frozen/);
    expect(() => adminSql(`UPDATE xbrl_taxonomy_version SET status = 'UNVERIFIED', verified_by_user_id = NULL, verified_at = NULL WHERE id = '${versionId}'`)).toThrow(/frozen|moves only/);
    expect(() => adminSql(`DELETE FROM xbrl_taxonomy_version WHERE id = '${versionId}'`)).toThrow(/not permitted/);
    expect(() => adminSql('TRUNCATE xbrl_concept_map')).toThrow(/not permitted/);
  });
  it('a change is a new UNVERIFIED copy with the same entries; the old version is SUPERSEDED and left out of the list', async () => {
    const n = ok(await as(admin, 'post', `/taxonomy-versions/${versionId}/supersede`, { label: 'FRC FRS 105 mapping 0.2', effectiveFrom: '2026-01-01', source: SOURCE, reason: 'A corrected concept (synthetic)' }), 201);
    expect(n).toMatchObject({ status: 'UNVERIFIED', copiedFromId: versionId, entryPoint: pack.version.entryPoint });
    expect(n.entries).toHaveLength(pack.entries.length);
    expect(ok(await as(viewer, 'get', `/taxonomy-versions/${versionId}`))).toMatchObject({ status: 'SUPERSEDED', supersededById: n.id });
    expect((await as(admin, 'post', `/taxonomy-versions/${versionId}/supersede`, { label: 'Again', effectiveFrom: '2026-01-01', source: SOURCE, reason: 'Superseding twice (synthetic)' })).body.code).toBe('version_superseded');
    const ids = (q: string) => as(viewer, 'get', `/taxonomy-versions${q}`).then((r) => r.body.items.map((x: { id: string }) => x.id));
    expect(await ids('')).not.toContain(versionId);
    expect(await ids('?includeSuperseded=true')).toContain(versionId);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${versionId}'`)).toMatch(/ixbrl.taxonomy_version_created.*ixbrl.taxonomy_version_verified.*ixbrl.taxonomy_version_superseded/);
  });
});

describe('the feature flag', () => {
  it('the routes are behind ixbrl.filing', async () => {
    const solo = await createUser(s, { type: 'PRACTICE' });
    expect((await s.api().put(orgPath(solo, '/feature-flags/ixbrl.filing')).set(bearer(solo.token)).send({ enabled: false, reason: 'Off for the test' })).status).toBe(200);
    expect((await s.api().get(orgPath(solo, '/ixbrl/taxonomy-versions')).set(bearer(solo.token))).body.code).toBe('feature_disabled');
  });
});
