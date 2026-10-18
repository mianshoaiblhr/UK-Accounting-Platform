import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M1: the database defends the reporting framework even if application code is wrong or bypassed (DEC-052, DEC-055). Runtime role, tenant context; synthetic content only. */
let db: Database;
let org: string, org2: string, author: string, verifier: string, co: string, standard: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: author }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const version = (id: string, o: { from?: string; to?: string | null; status?: string; by?: string } = {}) =>
  `INSERT INTO reporting_standard_version(id, organisation_id, standard_id, label, effective_from, effective_to, source_url, source_reference, source_retrieved_on, created_by_user_id, status)
   VALUES ('${id}','${org}','${standard}','Synthetic','${o.from ?? '2026-01-01'}',${o.to ? `'${o.to}'` : 'NULL'},'https://example.invalid/layout','Synthetic layout, para 1','2026-10-17','${o.by ?? author}','${o.status ?? 'UNVERIFIED'}')`;
const line = (v: string, key: string, kind = 'ACCOUNTS', o: { side?: string | null; formula?: string } = {}) =>
  `INSERT INTO statutory_line(organisation_id, version_id, key, statement, name, kind, natural_side, formula)
   VALUES ('${org}','${v}','${key}','BS','Line ${key}','${kind}',${o.side === null ? 'NULL' : `'${o.side ?? 'DEBIT'}'`},${o.formula ? `'${o.formula}'::jsonb` : 'NULL'})`;
const map = (v: string, target: string, source = 'BS.CURRENT_ASSETS.CASH') => `INSERT INTO statutory_map_entry(organisation_id, version_id, source_line, target_key) VALUES ('${org}','${v}','${source}','${target}')`;
const verify = (v: string, by = verifier) => `UPDATE reporting_standard_version SET status='VERIFIED', verified_by_user_id='${by}', verified_at=now(), verification_notes='Checked against the synthetic source' WHERE id='${v}'`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  author = sql(`INSERT INTO "user"(email, display_name) VALUES ('rf1-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  verifier = sql(`INSERT INTO "user"(email, display_name) VALUES ('rf2-${org}@t.test','V') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','RF A'),('${org2}','BUSINESS','RF B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  for (const a of (await db.tenant({ organisationId: org, userId: author }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: author }))).items) acc[a.code] = a.id;
  standard = uuidv7();
  await tx([`INSERT INTO reporting_standard(id, organisation_id, code, name, created_by_user_id) VALUES ('${standard}','${org}','SYNTH','Synthetic','${author}')`]);
});
afterAll(() => db.close());

describe('standards and versions', () => {
  it('a standard is written once; codes are unique per organisation and upper case', async () => {
    await expect(tx([`UPDATE reporting_standard SET name='x' WHERE id='${standard}'`])).rejects.toThrow(/permission denied/);
    expect(() => sql(`UPDATE reporting_standard SET name='x' WHERE id='${standard}'`)).toThrow(/append-only/);
    await expect(tx([`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Again','${author}')`])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','lower','x','${author}')`])).rejects.toThrow(/code_ck|violates check/);
  });
  it('a version starts UNVERIFIED with its source; current versions of a standard never overlap', async () => {
    await expect(tx([version(uuidv7(), { status: 'VERIFIED' })])).rejects.toThrow(/starts UNVERIFIED|verification_ck|violates check/);
    await expect(tx([version(uuidv7()).replace("'https://example.invalid/layout'", "'ftp://x'")])).rejects.toThrow(/source_ck|violates check/);
    const v1 = uuidv7(); await tx([version(v1, { to: '2026-12-31' })]);
    await expect(tx([version(uuidv7(), { from: '2026-12-31' })])).rejects.toThrow(/overlaps another current version/);
    await tx([version(uuidv7(), { from: '2027-01-01', to: '2027-12-31' })]);                                // adjacent: fine
  });
  it('verification: once, by a person other than the author, only when every map entry lands on an accounts line; then the version and its content are immutable', async () => {
    const v = uuidv7(); await tx([version(v, { from: '2030-01-01', to: '2030-12-31' })]);
    await expect(tx([verify(v)])).rejects.toThrow(/without statement lines/);
    await tx([line(v, 'CASH'), line(v, 'TOTAL', 'TOTAL', { side: null, formula: '[{"line":"CASH","sign":1}]' }), map(v, 'TOTAL')]);
    await expect(tx([verify(v)])).rejects.toThrow(/not an accounts line/);
    await tx([`UPDATE statutory_map_entry SET target_key='CASH' WHERE version_id='${v}'`]);
    await expect(tx([verify(v, author)])).rejects.toThrow(/verification_ck|violates check/);              // the author cannot verify
    await tx([verify(v)]);
    await expect(tx([`UPDATE reporting_standard_version SET status='UNVERIFIED', verified_by_user_id=NULL, verified_at=NULL WHERE id='${v}'`])).rejects.toThrow(/immutable|verified once/);
    for (const set of [`label='x'`, `effective_from='2030-01-02'`, `source_url='https://example.invalid/other'`, `verification_notes='edited later on'`]) {
      await expect(tx([`UPDATE reporting_standard_version SET ${set} WHERE id='${v}'`]), set).rejects.toThrow(/immutable/);
    }
    await expect(tx([`UPDATE statutory_line SET name='x' WHERE version_id='${v}' AND key='CASH'`])).rejects.toThrow(/verified and its content cannot change/);
    await expect(tx([line(v, 'LATE')])).rejects.toThrow(/verified and its content cannot change/);
    await expect(tx([map(v, 'CASH', 'BS.CURRENT_ASSETS.STOCK')])).rejects.toThrow(/verified and its content cannot change/);
    await expect(tx([`INSERT INTO validation_rule(organisation_id, version_id, key, description, expression) VALUES ('${org}','${v}','R','Late rule','{"eq":[{"const":"0"},{"const":"0"}]}')`])).rejects.toThrow(/cannot change/);
    await expect(tx([`DELETE FROM statutory_line WHERE version_id='${v}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM reporting_standard_version WHERE id='${v}'`])).rejects.toThrow(/permission denied/);
    // supersession: only a verified version, once, pointing at its replacement; then final
    const v2 = uuidv7();
    await tx([`UPDATE reporting_standard_version SET status='SUPERSEDED', superseded_by_id='${v2}' WHERE id='${v}'`, version(v2, { from: '2030-01-01', to: '2030-12-31' })]);
    await expect(tx([`UPDATE reporting_standard_version SET notes='x' WHERE id='${v}'`])).rejects.toThrow(/superseded standard version is final/);
    await expect(tx([`UPDATE reporting_standard_version SET status='SUPERSEDED', superseded_by_id='${v}' WHERE id='${v2}'`])).rejects.toThrow(/verified once and superseded once/);
    await expect(tx([`UPDATE reporting_standard_version SET status='SUPERSEDED' WHERE id='${v2}'`])).rejects.toThrow(/superseded_ck|violates check|verified once/);
  });
  it('content stays in its version; rule shapes are checked; one live entry per (version, V1 line, subtype); removed keys can return', async () => {
    const v = uuidv7(); await tx([version(v, { from: '2031-01-01', to: '2031-12-31' })]);
    await tx([line(v, 'A'), map(v, 'A')]);
    await expect(tx([map(v, 'A')])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([line(v, 'B', 'TOTAL', { side: 'DEBIT', formula: '[]' })])).rejects.toThrow(/side_ck|violates check/);
    await expect(tx([line(v, 'B', 'ACCOUNTS', { formula: '[]' })])).rejects.toThrow(/formula_ck|violates check/);
    await expect(tx([line(v, 'lower')])).rejects.toThrow(/key_ck|violates check/);
    await expect(tx([`UPDATE statutory_line SET version_id='${uuidv7()}' WHERE version_id='${v}'`])).rejects.toThrow(/belongs to one version/);
    await tx([`UPDATE statutory_line SET removed=true WHERE version_id='${v}' AND key='A'`, line(v, 'A')]);
    await expect(tx([`INSERT INTO validation_rule(organisation_id, version_id, key, description, expression, applies_to) VALUES ('${org}','${v}','R','Rule','{}', ARRAY['TINY'])`])).rejects.toThrow(/sizes_ck|violates check/);
    await expect(tx([`INSERT INTO disclosure_rule(organisation_id, version_id, key, title, requires) VALUES ('${org}','${v}','N','Note','[]')`])).rejects.toThrow(/requires_ck|violates check/);
  });
  it('another organisation sees none of it (forced RLS)', async () => {
    const n = await db.tenant({ organisationId: org2, userId: author }, (t) => t.reportingStandardVersion.count());
    expect(n).toBe(0);
    await expect(tx([`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','LEAK','x','${author}')`], { organisationId: org2 })).rejects.toThrow(/row-level security/);
  });
});

describe('per company', () => {
  let v: string;
  beforeAll(async () => { v = uuidv7(); await tx([version(v, { from: '2040-01-01', to: '2045-12-31' }), line(v, 'CASH'), line(v, 'TOT', 'TOTAL', { side: null, formula: '[{"line":"CASH","sign":1}]' })]); });
  it('an override lands on an accounts line of its version, is unique while active, and is ended once, never edited', async () => {
    const o = (target: string) => `INSERT INTO statutory_account_override(organisation_id, company_id, version_id, account_id, target_key, reason, created_by_user_id) VALUES ('${org}','${co}','${v}','${acc['1200']}','${target}','Synthetic reason','${author}')`;
    await expect(tx([o('TOT')])).rejects.toThrow(/accounts line of its version/);
    await tx([o('CASH')]);
    await expect(tx([o('CASH')])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([`UPDATE statutory_account_override SET target_key='TOT' WHERE version_id='${v}'`])).rejects.toThrow(/ended, never edited/);
    await expect(tx([`UPDATE statutory_account_override SET ended_at=now() WHERE version_id='${v}'`])).rejects.toThrow(/end_ck|violates check/);
    await tx([`UPDATE statutory_account_override SET ended_at=now(), ended_by_user_id='${author}', ended_reason='Back to the map' WHERE version_id='${v}'`]);
    await expect(tx([`UPDATE statutory_account_override SET ended_reason='Changed my mind' WHERE version_id='${v}'`])).rejects.toThrow(/ended, never edited/);
    await expect(tx([`DELETE FROM statutory_account_override WHERE version_id='${v}'`])).rejects.toThrow(/permission denied/);
  });
  it('financial years of a company do not overlap; the start is fixed; a locked year never changes', async () => {
    const f = (start: string, end: string) => `INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id) VALUES ('${org}','${co}','${start}','${end}','${v}','MICRO','Synthetic year','${author}')`;
    await tx([f('2040-01-01', '2040-12-31')]);
    await expect(tx([f('2040-06-01', '2041-05-31')])).rejects.toThrow(/do not overlap/);
    await expect(tx([f('2041-01-01', '2043-01-01')])).rejects.toThrow(/range_ck|violates check/);           // not longer than 18 months
    await expect(tx([`UPDATE company_reporting_framework SET year_start='2040-01-02' WHERE company_id='${co}' AND year_start='2040-01-01'`])).rejects.toThrow(/starts on one date/);
    await tx([`UPDATE company_reporting_framework SET entity_size='SMALL', year_end='2040-12-30' WHERE company_id='${co}' AND year_start='2040-01-01'`]);
    sql(`UPDATE company_reporting_framework SET locked_at=now() WHERE company_id='${co}' AND year_start='2040-01-01'`);  // V2-M6 will lock approved years
    await expect(tx([`UPDATE company_reporting_framework SET entity_size='MICRO' WHERE company_id='${co}' AND year_start='2040-01-01'`])).rejects.toThrow(/locked/);
    await expect(tx([`DELETE FROM company_reporting_framework WHERE company_id='${co}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('system roles carry the new permissions as the contracts say (DEC-052)', () => {
  it('owner and admin hold all three; partner may author and prepare but not verify; accountant prepares only', () => {
    const perms = (key: string) => sql(`SELECT array_to_string(ARRAY(SELECT p FROM unnest(permissions) p WHERE p LIKE 'accounts:%' ORDER BY 1), ',') FROM role WHERE organisation_id IS NULL AND key='${key}'`);
    expect(perms('owner')).toBe('accounts:prepare,accounts:rule-verify,accounts:rules-manage');
    expect(perms('admin')).toBe('accounts:prepare,accounts:rule-verify,accounts:rules-manage');
    expect(perms('partner')).toBe('accounts:prepare,accounts:rules-manage');
    expect(perms('accountant')).toBe('accounts:prepare');
    for (const k of ['manager', 'bookkeeper', 'reviewer', 'client_viewer']) expect(perms(k), k).toBe('');
  });
});
