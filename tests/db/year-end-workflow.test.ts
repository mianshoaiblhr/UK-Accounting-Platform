import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V2-M6b: the database defends the year-end step sign-offs even if application code is bypassed (DEC-069). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, a: string, co: string, fw: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: a }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const row = (step: number, action: string, note: string | null = null, company = '') =>
  `INSERT INTO year_end_step_signoff(organisation_id, company_id, framework_id, step, action, note, control, by_user_id) VALUES ('${org}','${company || co}','${fw}',${step},'${action}',${note === null ? 'NULL' : `'${note}'`},'{"status":"READY"}','${a}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  a = sql(`INSERT INTO "user"(email, display_name) VALUES ('yewdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','YEW DB A'),('${org2}','BUSINESS','YEW DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  const std = sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${a}') RETURNING id`).split('\n')[0]!;
  const version = sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2025-01-01','https://example.test','Synthetic','2026-10-21','${a}') RETURNING id`).split('\n')[0]!;
  fw = sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2026-01-01','2026-12-31','${version}','MICRO','Synthetic','${a}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('year-end step sign-offs', () => {
  it('name a step 1 to 14; a reopen needs a reason and a live sign-off; a step is not signed off twice; rows are written once', async () => {
    await expect(tx([row(15, 'SIGN_OFF')])).rejects.toThrow(/yess_step_ck/);
    await expect(tx([row(1, 'APPROVE')])).rejects.toThrow(/yess_action_ck/);
    await expect(tx([row(1, 'REOPEN', 'Look again')])).rejects.toThrow(/only a signed-off step is reopened/);
    await tx([row(1, 'SIGN_OFF')]);
    await expect(tx([row(1, 'SIGN_OFF')])).rejects.toThrow(/already signed off/);
    await expect(tx([row(1, 'REOPEN')])).rejects.toThrow(/yess_note_ck/);
    await tx([row(1, 'REOPEN', 'Look again'), row(1, 'SIGN_OFF', 'Done again')]);
    await expect(tx([`UPDATE year_end_step_signoff SET note = 'x' WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM year_end_step_signoff WHERE framework_id = '${fw}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`TRUNCATE year_end_step_signoff`])).rejects.toThrow(/permission denied/);
  });
  it('belong to a framework year of their company; another organisation sees none', async () => {
    const other = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','B') RETURNING id`).split('\n')[0]!;
    await expect(tx([row(2, 'SIGN_OFF', null, other)])).rejects.toThrow(/belongs to a framework year of its company/);
    expect(await db.tenant({ organisationId: org2, userId: a }, (t) => t.$queryRawUnsafe(`SELECT id FROM year_end_step_signoff`))).toEqual([]);
  });
});
