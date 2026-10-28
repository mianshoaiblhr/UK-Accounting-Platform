import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCtRules } from '../../scripts/tax/import-ct-rules.mjs';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V4-M1 (DEC-097) through the public API: Corporation Tax rules as sourced, effective-dated organisation data, UNVERIFIED until a second person
 * verifies them and changed only by a new version; the company's tax profile; CT accounting periods derived from an accounts year and split by the
 * verified maximum. Synthetic data only; the figures in the tests are fixtures, not the law.
 */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, `/companies/${company.id}${p}`)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const SOURCE = { url: 'https://example.invalid/synthetic-ct', provision: 'Synthetic Corporation Tax provision (test fixture)', retrievedOn: '2026-01-01' };
const RATES = { mainRate: '30', smallProfitsRate: '15', lowerLimit: '10000', upperLimit: '90000', marginalReliefFraction: { numerator: 1, denominator: 40 } };
const pack = JSON.parse(readFileSync(resolve(__dirname, '../../content/tax/drafts/uk-ct-rules.json'), 'utf8'));

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  company = await makeCompany(s, owner, 'Synthetic CT Ltd');
});
afterAll(() => s.stop());

describe('Corporation Tax rules are sourced versions, verified by a second person', () => {
  let ratesId: string;
  it('ct:manage enters a rule (UNVERIFIED); a reviewer may not; anyone with the ledger reads', async () => {
    expect((await as(reviewer, 'post', '/ct-rules', { kind: 'CT_RATES', effectiveFrom: '2030-04-01', parameters: RATES, source: SOURCE })).status).toBe(403);
    const r = ok(await as(accountant, 'post', '/ct-rules', { kind: 'CT_RATES', effectiveFrom: '2030-04-01', effectiveTo: '2031-03-31', parameters: RATES, source: SOURCE }), 201);
    expect(r).toMatchObject({ kind: 'CT_RATES', jurisdiction: 'UK', verificationStatus: 'UNVERIFIED', enteredByUserId: accountant.userId, parameters: RATES, effectiveTo: '2031-03-31' });
    ratesId = r.id;
    expect(ok(await as(reviewer, 'get', '/ct-rules?kind=CT_RATES')).items.map((x: { id: string }) => x.id)).toContain(ratesId);
  });
  it('parameters are checked by kind', async () => {
    const bad = async (kind: string, parameters: object) => { const r = await as(accountant, 'post', '/ct-rules', { kind, effectiveFrom: '2040-04-01', parameters, source: SOURCE }); expect(r.status, JSON.stringify(r.body)).toBe(422); };
    await bad('CT_RATES', { ...RATES, lowerLimit: '90000', upperLimit: '10000' });
    await bad('CT_RATES', { ...RATES, smallProfitsRate: '31' });
    await bad('CT_RATES', { ...RATES, mainRate: '101' });
    await bad('CT_RATES', { ...RATES, extra: 1 });
    await bad('PERIOD_MAX_MONTHS', { months: 0 });
    await bad('PERIOD_MAX_MONTHS', { months: 12, mainRate: '25' });
    expect((await as(accountant, 'post', '/ct-rules', { kind: 'OTHER', effectiveFrom: '2040-04-01', parameters: {}, source: SOURCE })).status).toBe(422);
  });
  it('two current versions of one kind may not overlap', async () => {
    expect((await as(accountant, 'post', '/ct-rules', { kind: 'CT_RATES', effectiveFrom: '2031-01-01', parameters: RATES, source: SOURCE })).body.code).toBe('ct_rule_overlap');
  });
  it('verification: tax:rule-verify, never by the person who entered it; once', async () => {
    expect((await as(partner, 'post', `/ct-rules/${ratesId}/verify`, { notes: 'Checked against the synthetic provision' })).status).toBe(403);
    expect((await as(accountant, 'post', `/ct-rules/${ratesId}/verify`, { notes: 'Checked against the synthetic provision' })).status).toBe(403);
    const v = ok(await as(owner, 'post', `/ct-rules/${ratesId}/verify`, { notes: 'Checked against the synthetic provision' }));
    expect(v).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: owner.userId, verificationNotes: 'Checked against the synthetic provision' });
    expect((await as(admin, 'post', `/ct-rules/${ratesId}/verify`, { notes: 'Checked against the synthetic provision' })).body.code).toBe('already_verified');
  });
  it('a change is a new UNVERIFIED version of the same kind; the old one stays, superseded once', async () => {
    expect((await as(accountant, 'post', `/ct-rules/${ratesId}/supersede`, { kind: 'PERIOD_MAX_MONTHS', effectiveFrom: '2030-04-01', parameters: { months: 12 }, source: SOURCE, reason: 'Wrong kind on purpose' })).body.code).toBe('kind_mismatch');
    const n = ok(await as(accountant, 'post', `/ct-rules/${ratesId}/supersede`, { kind: 'CT_RATES', effectiveFrom: '2030-04-01', effectiveTo: '2031-03-31', parameters: { ...RATES, mainRate: '29' }, source: SOURCE, reason: 'The synthetic main rate changed' }), 201);
    expect(n).toMatchObject({ verificationStatus: 'UNVERIFIED', parameters: { mainRate: '29' } });
    expect(ok(await as(reviewer, 'get', `/ct-rules/${ratesId}`)).supersededById).toBe(n.id);
    expect((await as(accountant, 'post', `/ct-rules/${ratesId}/supersede`, { kind: 'CT_RATES', effectiveFrom: '2030-04-01', parameters: RATES, source: SOURCE, reason: 'A second time on purpose' })).body.code).toBe('ct_rule_superseded');
    expect((await as(owner, 'post', `/ct-rules/${ratesId}/verify`, { notes: 'Checked against the synthetic provision' })).body.code).toBe('ct_rule_superseded');
    expect(ok(await as(reviewer, 'get', '/ct-rules?kind=CT_RATES')).items.map((x: { id: string }) => x.id)).not.toContain(ratesId);
    expect(ok(await as(reviewer, 'get', '/ct-rules?kind=CT_RATES&includeSuperseded=true')).items.map((x: { id: string }) => x.id)).toContain(ratesId);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${ratesId}'`)).toMatch(/ct.rule_added.*ct.rule_verified.*ct.rule_superseded/);
  });
  it('the database keeps a version as entered and refuses self-verification and removal', () => {
    expect(() => adminSql(`UPDATE ct_rule SET parameters = '{"months": 6}' WHERE id = '${ratesId}'`)).toThrow(/immutable/);
    expect(() => adminSql(`UPDATE ct_rule SET verification_status = 'UNVERIFIED', verified_by_user_id = NULL, verified_at = NULL WHERE id = '${ratesId}'`)).toThrow(/not withdrawn/);
    expect(() => adminSql(`DELETE FROM ct_rule WHERE id = '${ratesId}'`)).toThrow(/not permitted/);
    const fresh = adminSql(`SELECT id FROM ct_rule WHERE superseded_by_id IS NULL AND verification_status = 'UNVERIFIED' AND kind = 'CT_RATES' AND organisation_id = '${owner.organisationId}' LIMIT 1`);
    expect(() => adminSql(`UPDATE ct_rule SET verification_status = 'VERIFIED', verified_by_user_id = entered_by_user_id, verified_at = now(), verification_notes = 'Self verification attempt' WHERE id = '${fresh}'`)).toThrow(/ctr_verification_ck/);
  });
});

describe('the tax profile', () => {
  it('ct:prepare sets the UTR with a reason; its form is checked; it is audited', async () => {
    expect(ok(await as(reviewer, 'get', '/tax-profile'))).toMatchObject({ companyId: company.id, utr: null });
    expect((await as(reviewer, 'put', '/tax-profile', { utr: '1234567890', reason: 'From the synthetic notice' })).status).toBe(403);
    expect((await as(accountant, 'put', '/tax-profile', { utr: '12345', reason: 'From the synthetic notice' })).status).toBe(422);
    expect((await as(accountant, 'put', '/tax-profile', { utr: '1234567890' })).status).toBe(422);
    expect(ok(await as(accountant, 'put', '/tax-profile', { utr: '1234567890', reason: 'From the synthetic notice' }))).toMatchObject({ utr: '1234567890', updatedByUserId: accountant.userId });
    expect(ok(await as(partner, 'put', '/tax-profile', { utr: null, reason: 'Cleared: the synthetic UTR was wrong' }))).toMatchObject({ utr: null });
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action = 'ct.tax_profile_set' AND company_id = '${company.id}'`)).toBe('2');
  });
});

describe('CT accounting periods', () => {
  let periodRuleId: string, periods: { id: string; startDate: string; endDate: string; version: number }[];
  beforeAll(async () => {
    const std = ok(await as(owner, 'post', '/reporting-standards', { code: 'SYN-CT', name: 'Synthetic standard for CT periods' }), 201).id;
    const ver = ok(await as(owner, 'post', `/reporting-standards/${std}/versions`, { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: SOURCE }), 201).id;
    ok(await as(accountant, 'put', '/reporting-frameworks', { yearStart: '2027-01-01', yearEnd: '2028-06-30', versionId: ver, entitySize: 'MICRO', reason: 'An 18-month first year (synthetic)' }));
    ok(await as(accountant, 'put', '/reporting-frameworks', { yearStart: '2028-07-01', yearEnd: '2029-06-30', versionId: ver, entitySize: 'MICRO', reason: 'A 12-month year (synthetic)' }));
  });
  it('deriving needs a verified period rule for the year start', async () => {
    expect((await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2027-01-01' })).body.code).toBe('ct_rule_not_found');
    periodRuleId = ok(await as(accountant, 'post', '/ct-rules', { kind: 'PERIOD_MAX_MONTHS', effectiveFrom: '2020-04-01', parameters: { months: 12 }, source: SOURCE }), 201).id;
    expect((await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2027-01-01' })).body.code).toBe('ct_rule_unverified');
    ok(await as(admin, 'post', `/ct-rules/${periodRuleId}/verify`, { notes: 'Checked the synthetic period rule' }));
    expect((await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2026-01-01' })).body.code).toBe('year_not_found');
    expect((await as(reviewer, 'post', '/ct-periods/derive', { yearStart: '2027-01-01' })).status).toBe(403);
  });
  it('a year longer than the maximum splits into 12 months from its start and the rest; deriving again returns the same periods', async () => {
    const d = ok(await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2027-01-01' }));
    expect(d.created).toBe(true);
    expect(d.items.map((p: { startDate: string; endDate: string }) => [p.startDate, p.endDate])).toEqual([['2027-01-01', '2027-12-31'], ['2028-01-01', '2028-06-30']]);
    expect(d.items.every((p: { periodRuleId: string; associatedCompanies: number }) => p.periodRuleId === periodRuleId && p.associatedCompanies === 0)).toBe(true);
    periods = d.items;
    const again = ok(await as(partner, 'post', '/ct-periods/derive', { yearStart: '2027-01-01' }));
    expect(again).toMatchObject({ created: false });
    expect(again.items.map((p: { id: string }) => p.id)).toEqual(periods.map((p) => p.id));
    const twelve = ok(await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2028-07-01' }));
    expect(twelve.items.map((p: { startDate: string; endDate: string }) => [p.startDate, p.endDate])).toEqual([['2028-07-01', '2029-06-30']]);
    expect(ok(await as(reviewer, 'get', '/ct-periods')).items).toHaveLength(3);
  });
  it('associated companies are set with a reason, each change advancing the version', async () => {
    const p = periods[0]!;
    expect((await as(accountant, 'post', `/ct-periods/${p.id}/associated-companies`, { associatedCompanies: 2, reason: 'short' })).status).toBe(422);
    const v = ok(await as(accountant, 'post', `/ct-periods/${p.id}/associated-companies`, { associatedCompanies: 2, reason: 'Two synthetic companies under common control' }));
    expect(v).toMatchObject({ associatedCompanies: 2, version: 2, associatedReason: 'Two synthetic companies under common control' });
    expect(ok(await as(reviewer, 'get', `/ct-periods/${p.id}`))).toMatchObject({ associatedCompanies: 2, version: 2 });
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action = 'ct.associated_companies_set' AND entity_id = '${p.id}'`)).toBe('1');
  });
  it('a period\'s dates never change and it is never removed; a changed accounts year is reported', async () => {
    const p = periods[1]!;
    expect(() => adminSql(`UPDATE ct_period SET end_date = '2028-05-31', version = version + 1 WHERE id = '${p.id}'`)).toThrow(/never change/);
    expect(() => adminSql(`UPDATE ct_period SET associated_companies = 1 WHERE id = '${p.id}'`)).toThrow(/advance its version/);
    expect(() => adminSql(`DELETE FROM ct_period WHERE id = '${p.id}'`)).toThrow(/not permitted/);
    const ver = adminSql(`SELECT version_id FROM company_reporting_framework WHERE company_id = '${company.id}' AND year_start = '2028-07-01'`);
    ok(await as(accountant, 'put', '/reporting-frameworks', { yearStart: '2028-07-01', yearEnd: '2029-05-31', versionId: ver, entitySize: 'MICRO', reason: 'The synthetic year end moved' }));
    expect((await as(accountant, 'post', '/ct-periods/derive', { yearStart: '2028-07-01' })).body.code).toBe('ct_periods_stale');
  });
});

describe('the draft pack', () => {
  it('imports UNVERIFIED with every rule; importing needs ct:manage', async () => {
    const other = await makeCompany(s, owner, 'Synthetic CT import Ltd');
    const call = (u: TestUser) => async (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => {
      const r = await s.api()[method](orgPath(owner, `/companies/${other.id}${path}`)).set(bearer(u.token)).send(body); return { status: r.status, body: r.body };
    };
    await expect(importCtRules(call(reviewer), pack)).rejects.toThrow(/HTTP 403/);
    // the organisation already holds a synthetic PERIOD_MAX_MONTHS rule from the tests above; a fresh organisation takes the whole pack
    const fresh = await createUser(s, { type: 'PRACTICE' });
    const co = await makeCompany(s, fresh, 'Synthetic CT pack Ltd');
    const r = await importCtRules(async (method, path, body) => { const x = await s.api()[method](orgPath(fresh, `/companies/${co.id}${path}`)).set(bearer(fresh.token)).send(body); return { status: x.status, body: x.body }; }, pack);
    expect(r.rules.map((x) => [x.kind, x.verificationStatus])).toEqual(pack.rules.map((x: { kind: string }) => [x.kind, 'UNVERIFIED']));
  });
});
