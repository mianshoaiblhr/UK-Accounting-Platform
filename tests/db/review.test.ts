import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V2-M6a: the database defends review settings and responses even if application code is bypassed (DEC-068). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, a: string, b: string, co: string, fw: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: a }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const rows = (statement: string, o: { organisationId?: string } = {}) => db.tenant({ organisationId: o.organisationId ?? org, userId: a }, (t) => t.$queryRawUnsafe<{ id: string }[]>(statement));
const respond = (action: string, by: string, figures = '{"balance":"300.00"}', key = 'RC-07:account:x1', note: string | null = 'Synthetic note') =>
  `INSERT INTO review_flag_response(organisation_id, company_id, framework_id, flag_key, control, action, note, figures, by_user_id) VALUES ('${org}','${co}','${fw}','${key}','${key.slice(0, 5)}','${action}',${note === null ? 'NULL' : `'${note}'`},'${figures}','${by}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  a = sql(`INSERT INTO "user"(email, display_name) VALUES ('revdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  b = sql(`INSERT INTO "user"(email, display_name) VALUES ('revdb2-${org}@t.test','B') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','REV DB A'),('${org2}','BUSINESS','REV DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  const std = sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${a}') RETURNING id`).split('\n')[0]!;
  const version = sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2025-01-01','https://example.test','Synthetic','2026-10-21','${a}') RETURNING id`).split('\n')[0]!;
  fw = sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2026-01-01','2026-12-31','${version}','MICRO','Synthetic','${a}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('review settings', () => {
  it('are positive, use 30, 60 or 90 days, carry a reason, and are written once', async () => {
    const set = (cols: string, vals: string) => `INSERT INTO review_setting(organisation_id, company_id, ${cols}, reason, set_by_user_id) VALUES ('${org}','${co}',${vals},'Firm policy','${a}')`;
    await expect(tx([set('material_amount', '0')])).rejects.toThrow(/rs_amounts_ck/);
    await expect(tx([set('old_item_days', '45')])).rejects.toThrow(/rs_days_ck/);
    await tx([set('material_amount, old_item_days', '5000, 60')]);
    await expect(tx([`UPDATE review_setting SET material_amount = 1 WHERE company_id = '${co}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM review_setting WHERE company_id = '${co}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('responses', () => {
  it('a sign-off needs an explanation by another person with the same figures, not yet signed off; responses are written once', async () => {
    await expect(tx([respond('SIGN_OFF', b, undefined, undefined, null)])).rejects.toThrow(/only after it is explained/);
    await expect(tx([respond('EXPLAIN', a, undefined, undefined, null)])).rejects.toThrow(/rfr_note_ck/);
    await expect(tx([respond('EXPLAIN', a).replace("'RC-07:account:x1','RC-07'", "'RC-08:account:x1','RC-07'")])).rejects.toThrow(/rfr_key_ck/);   // key and control disagree
    await tx([respond('EXPLAIN', a)]);
    await expect(tx([respond('SIGN_OFF', a, undefined, undefined, null)])).rejects.toThrow(/someone other than the person who explained it/);
    await expect(tx([respond('SIGN_OFF', b, '{"balance":"350.00"}', undefined, null)])).rejects.toThrow(/changed since it was explained/);
    await tx([respond('SIGN_OFF', b, undefined, undefined, null)]);
    await expect(tx([respond('SIGN_OFF', b, undefined, undefined, null)])).rejects.toThrow(/already signed off or reopened/);
    await expect(tx([`UPDATE review_flag_response SET note = 'changed' WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM review_flag_response WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`TRUNCATE review_flag_response`])).rejects.toThrow(/permission denied/);
  });
  it('belong to a framework year of their company; another organisation sees none', async () => {
    const other = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','B') RETURNING id`).split('\n')[0]!;
    await expect(tx([respond('EXPLAIN', a).replace(`'${co}'`, `'${other}'`)])).rejects.toThrow(/belongs to a framework year of its company/);
    expect(await rows(`SELECT id FROM review_flag_response`, { organisationId: org2 })).toEqual([]);
    expect(await rows(`SELECT id FROM review_setting`, { organisationId: org2 })).toEqual([]);
  });
});
