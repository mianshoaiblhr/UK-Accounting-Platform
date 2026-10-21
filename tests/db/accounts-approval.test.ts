import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/**
 * V2-M6c: the database defends the partner review, the client approval, the year lock and the filing-ready package even if application code
 * is bypassed (DEC-070, V2-ARC-04). Runtime role, tenant context.
 */
let db: Database;
let org: string, org2: string, a: string, b: string, co: string, other: string, version: string, fw: string, fw2: string, dir: string, notDir: string, doc: string, otherDoc: string, period: string;
const sql = adminSql;
const FP = 'a'.repeat(64), FP2 = 'b'.repeat(64);
const id = (s: string) => s.split('\n')[0]!;
const as = (user: string, statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const review = (by: string, o: { fw?: string; fp?: string; stage?: string; director?: string } = {}) =>
  `INSERT INTO accounts_approval(organisation_id, company_id, framework_id, stage, fingerprint, director_contact_id, by_user_id) VALUES ('${org}','${co}','${o.fw ?? fw}','${o.stage ?? 'PARTNER_REVIEW'}','${o.fp ?? FP}',${o.director ? `'${o.director}'` : 'NULL'},'${by}')`;
const approval = (o: { fp?: string; on?: string; director?: string; doc?: string | null } = {}) =>
  `INSERT INTO accounts_approval(organisation_id, company_id, framework_id, stage, fingerprint, director_contact_id, approved_on, evidence_document_id, by_user_id)
   VALUES ('${org}','${co}','${fw}','CLIENT_APPROVAL','${o.fp ?? FP}','${o.director ?? dir}','${o.on ?? '2026-03-16'}',${o.doc === null ? 'NULL' : `'${o.doc ?? doc}'`},'${b}')`;
const pkg = (o: { fw?: string; fp?: string } = {}) =>
  `INSERT INTO accounts_package(organisation_id, company_id, framework_id, fingerprint, sha256, content, by_user_id) VALUES ('${org}','${co}','${o.fw ?? fw}','${o.fp ?? FP}','${'c'.repeat(64)}','{"format":"uk-accounts-package/1"}','${a}')`;
const signoff = (step: number, by: string, f = fw) =>
  `INSERT INTO year_end_step_signoff(organisation_id, company_id, framework_id, step, action, control, by_user_id) VALUES ('${org}','${co}','${f}',${step},'SIGN_OFF','{"status":"READY"}','${by}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  a = id(sql(`INSERT INTO "user"(email, display_name) VALUES ('apdb-a-${org}@t.test','A') RETURNING id`));
  b = id(sql(`INSERT INTO "user"(email, display_name) VALUES ('apdb-b-${org}@t.test','B') RETURNING id`));
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','AP DB A'),('${org2}','BUSINESS','AP DB B')`);
  co = id(sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`));
  other = id(sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','B') RETURNING id`));
  const std = id(sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${a}') RETURNING id`));
  version = id(sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2020-01-01','https://example.test','Synthetic','2026-10-21','${a}') RETURNING id`));
  sql(`INSERT INTO statutory_line(organisation_id, version_id, key, statement, sort, name, kind, natural_side) VALUES ('${org}','${version}','B.CA','BS',10,'Current assets','ACCOUNTS','DEBIT')`);
  fw = id(sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2025-01-01','2025-12-31','${version}','MICRO','Synthetic','${a}') RETURNING id`));
  fw2 = id(sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2026-01-01','2026-12-31','${version}','MICRO','Synthetic','${a}') RETURNING id`));
  dir = id(sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Director','${a}') RETURNING id`));
  notDir = id(sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Shareholder','${a}') RETURNING id`));
  sql(`INSERT INTO company_officer(organisation_id, company_id, contact_id, role, appointed_on) VALUES ('${org}','${co}','${dir}','DIRECTOR','2024-06-01')`);
  doc = id(sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','Signed balance sheet','${a}') RETURNING id`));
  otherDoc = id(sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${other}','Other','${a}') RETURNING id`));
  period = id(sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date, status) VALUES ('${org}','${co}','2025-01-01','2025-12-31','LOCKED') RETURNING id`));
});
afterAll(() => db.close());

describe('the partner review', () => {
  it('needs the accounts signed off (step 11) and is recorded by someone else; checks its shape; rows are written once', async () => {
    await expect(as(b, [review(b)])).rejects.toThrow(/needs the accounts signed off/);
    await as(a, [signoff(11, a)]);
    await expect(as(a, [review(a)])).rejects.toThrow(/someone other than the person who signed off the accounts/);
    await expect(as(b, [review(b, { stage: 'APPROVE' })])).rejects.toThrow(/aap_stage_ck/);
    await expect(as(b, [review(b, { fp: 'not-a-hash' })])).rejects.toThrow(/aap_fingerprint_ck/);
    await expect(as(b, [review(b, { director: dir })])).rejects.toThrow(/aap_client_ck/);
    await as(b, [review(b)]);
    await expect(as(b, [`UPDATE accounts_approval SET note = 'x' WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(as(b, [`DELETE FROM accounts_approval WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(as(b, [`TRUNCATE accounts_approval`])).rejects.toThrow(/permission denied/);
  });
});

describe('the client approval', () => {
  it('needs a review of the same accounts, a date after the year end, a serving director and evidence of the company; one per year', async () => {
    await expect(as(b, [approval({ fp: FP2 })])).rejects.toThrow(/partner review of the same accounts/);
    await expect(as(b, [approval({ on: '2025-12-31' })])).rejects.toThrow(/approved after the year end/);
    await expect(as(b, [approval({ director: notDir })])).rejects.toThrow(/serves the company on the approval date/);
    await expect(as(b, [approval({ on: '2024-05-31' })])).rejects.toThrow(/after the year end/);
    await expect(as(b, [approval({ doc: otherDoc })])).rejects.toThrow(/document of the company/);
    await expect(as(b, [approval({ doc: null })])).rejects.toThrow(/aap_client_ck|document of the company/);
    await expect(as(b, [pkg()])).rejects.toThrow(/only for an approved year/);
    await as(b, [approval()]);
    await expect(as(b, [approval()])).rejects.toThrow(/aap_one_client_approval|duplicate key|Unique constraint/);
  });
});

describe('locking (DEC-070)', () => {
  it('a framework is locked only by its client approval and never changes after; the year then takes nothing more; its periods stay locked', async () => {
    await expect(as(a, [`UPDATE company_reporting_framework SET locked_at = now() WHERE id = '${fw2}'`])).rejects.toThrow(/locked only by the client approval/);
    await expect(as(a, [`UPDATE company_reporting_framework SET locked_at = now(), entity_size = 'SMALL' WHERE id = '${fw}'`])).rejects.toThrow(/locked as it stands/);
    await as(a, [`UPDATE company_reporting_framework SET locked_at = now() WHERE id = '${fw}'`]);
    await expect(as(a, [`UPDATE company_reporting_framework SET reason = 'Changed' WHERE id = '${fw}'`])).rejects.toThrow(/approved year is locked/);
    await expect(as(a, [`INSERT INTO accounts_fact(organisation_id, company_id, framework_id, key, value, reason, set_by_user_id) VALUES ('${org}','${co}','${fw}','employees.average','3','Late','${a}')`]))
      .rejects.toThrow(/the year is locked/);
    await expect(as(a, [`INSERT INTO review_flag_response(organisation_id, company_id, framework_id, flag_key, control, action, note, figures, by_user_id)
      VALUES ('${org}','${co}','${fw}','RC-07:account:x','RC-07','EXPLAIN','Late','{}','${a}')`])).rejects.toThrow(/the year is locked/);
    await expect(as(a, [signoff(2, a)])).rejects.toThrow(/the year is locked/);
    await expect(as(b, [review(b, { fp: FP2 })])).rejects.toThrow(/the year is locked/);
    await expect(as(a, [`UPDATE accounting_period SET status = 'CLOSED' WHERE id = '${period}'`])).rejects.toThrow(/its periods stay locked/);
    // the next year is not locked
    await as(a, [`INSERT INTO accounts_fact(organisation_id, company_id, framework_id, key, value, reason, set_by_user_id) VALUES ('${org}','${co}','${fw2}','employees.average','3','Next year','${a}')`]);
  });
});

describe('the filing-ready package (V2-ARC-04)', () => {
  it('is refused under a version not verified by a second person, for other accounts than approved, or a year not approved; one per year, written once', async () => {
    await expect(as(a, [pkg()])).rejects.toThrow(/standard version verified by a second person/);
    sql(`UPDATE reporting_standard_version SET status = 'VERIFIED', verified_by_user_id = '${b}', verified_at = now(), verification_notes = 'Synthetic check' WHERE id = '${version}'`);
    await expect(as(a, [pkg({ fp: FP2 })])).rejects.toThrow(/holds the accounts as approved/);
    await expect(as(a, [pkg({ fw: fw2 })])).rejects.toThrow(/only for an approved year/);
    await as(a, [pkg()]);
    await expect(as(a, [pkg()])).rejects.toThrow(/apk_framework_key|duplicate key|Unique constraint/);
    await expect(as(a, [`UPDATE accounts_package SET sha256 = '${'d'.repeat(64)}' WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(as(a, [`DELETE FROM accounts_package WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(as(a, [`TRUNCATE accounts_package`])).rejects.toThrow(/permission denied/);
  });
  it('another organisation sees no approvals or packages', async () => {
    for (const t of ['accounts_approval', 'accounts_package']) expect(await db.tenant({ organisationId: org2, userId: a }, (x) => x.$queryRawUnsafe(`SELECT id FROM ${t}`)), t).toEqual([]);
  });
});
