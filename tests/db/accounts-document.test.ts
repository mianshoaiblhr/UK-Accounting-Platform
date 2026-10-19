import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V2-M5a: the database defends the preparer's facts and the new wording columns even if application code is bypassed (DEC-063). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, co: string, fw: string, director: string, stranger: string, version: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const fact = (key: string, value: string) => `INSERT INTO accounts_fact(organisation_id, company_id, framework_id, key, value, reason, set_by_user_id) VALUES ('${org}','${co}','${fw}','${key}','${value}','Synthetic','${user}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('docdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','DOC DB A'),('${org2}','BUSINESS','DOC DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  director = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','D','${user}') RETURNING id`).split('\n')[0]!;
  stranger = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','S','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO company_officer(organisation_id, company_id, contact_id, role, appointed_on) VALUES ('${org}','${co}','${director}','DIRECTOR','2020-01-01')`);
  const std = sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${user}') RETURNING id`).split('\n')[0]!;
  version = sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2025-01-01','https://example.test','Synthetic','2026-10-19','${user}') RETURNING id`).split('\n')[0]!;
  fw = sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2026-01-01','2026-12-31','${version}','MICRO','Synthetic','${user}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('facts', () => {
  it('are typed, belong to their company\'s framework year, are written once and never deleted', async () => {
    await expect(tx([fact('employees.average', '2.5')])).rejects.toThrow(/whole number/);
    await expect(tx([fact('approval.date', '31/03/2027')])).rejects.toThrow(/YYYY-MM-DD/);
    await expect(tx([fact('approval.director', stranger)])).rejects.toThrow(/director of the company/);
    await expect(tx([fact('turnover', '1')])).rejects.toThrow(/af_key_ck|violates check/);
    await expect(tx([fact('text.going-concern', 'x')])).rejects.toThrow(/af_key_ck|violates check/);
    await tx([fact('employees.average', '3'), fact('approval.director', director), fact('text.goingConcern', 'Synthetic wording')]);
    await expect(tx([`UPDATE accounts_fact SET value = '4' WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM accounts_fact WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
  });
  it('another organisation sees none of them (forced RLS)', async () => {
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.accountsFact.count())).toBe(0);
    await expect(tx([fact('employees.average', '1')], { organisationId: org2 })).rejects.toThrow(/row-level security|framework year/);
  });
});

describe('wording columns', () => {
  it('a section is one of four and a body is not empty (verified wording is frozen with its version: tests/api/accounts-document.test.ts)', async () => {
    const add = (o: { section?: string; body?: string }) => `INSERT INTO disclosure_rule(organisation_id, version_id, key, title, section, body) VALUES ('${org}','${version}','N${Math.floor(Math.random() * 1e9)}','Synthetic note','${o.section ?? 'NOTES'}',${o.body === undefined ? 'NULL' : `'${o.body}'`})`;
    await expect(tx([add({ section: 'APPENDIX' })])).rejects.toThrow(/disclosure_rule_section_ck|violates check/);
    await expect(tx([add({ body: '' })])).rejects.toThrow(/disclosure_rule_body_ck|violates check/);
    await tx([add({ section: 'POLICIES', body: 'Synthetic policy wording' })]);
  });
});
