import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V2-M5b: the database defends threshold sets, the turnover line and the size facts even if application code is bypassed (DEC-052, DEC-066). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, other: string, co: string, fw: string, version: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const rows = (statement: string, o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, (t) => t.$queryRawUnsafe<{ id: string }[]>(statement));
const LIMITS = { micro: ['20000', '10000', 3], small: ['60000', '30000', 10], medium: ['200000', '100000', 50] } as const;
const insertSet = (from: string, to: string | null, o: { micro?: readonly [string, string, number]; status?: string; id?: string } = {}) => {
  const m = o.micro ?? LIMITS.micro, s = LIMITS.small, d = LIMITS.medium;
  return `INSERT INTO size_threshold_set(${o.id ? 'id, ' : ''}organisation_id, label, effective_from, effective_to, micro_turnover, micro_balance_sheet_total, micro_employees, small_turnover, small_balance_sheet_total, small_employees,
    medium_turnover, medium_balance_sheet_total, medium_employees, source_url, source_reference, source_retrieved_on, created_by_user_id${o.status ? ', status' : ''})
    VALUES (${o.id ? `'${o.id}', ` : ''}'${org}','Synthetic','${from}',${to ? `'${to}'` : 'NULL'},${m[0]},${m[1]},${m[2]},${s[0]},${s[1]},${s[2]},${d[0]},${d[1]},${d[2]},'https://example.test','Synthetic limits','2026-10-20','${user}'${o.status ? `,'${o.status}'` : ''})`;
};
const fact = (key: string, value: string) => `INSERT INTO accounts_fact(organisation_id, company_id, framework_id, key, value, reason, set_by_user_id) VALUES ('${org}','${co}','${fw}','${key}','${value}','Synthetic','${user}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('sizedb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  other = sql(`INSERT INTO "user"(email, display_name) VALUES ('sizedb2-${org}@t.test','B') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','SIZE DB A'),('${org2}','BUSINESS','SIZE DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  const std = sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${user}') RETURNING id`).split('\n')[0]!;
  version = sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2025-01-01','https://example.test','Synthetic','2026-10-20','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO statutory_line(organisation_id, version_id, key, statement, sort, name, kind, natural_side) VALUES ('${org}','${version}','P.T','PL',10,'Turnover','ACCOUNTS','CREDIT'),('${org}','${version}','B.CA','BS',10,'Current assets','ACCOUNTS','DEBIT')`);
  fw = sql(`INSERT INTO company_reporting_framework(organisation_id, company_id, year_start, year_end, version_id, entity_size, reason, chosen_by_user_id)
    VALUES ('${org}','${co}','2026-01-01','2026-12-31','${version}','MICRO','Synthetic','${user}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('threshold sets', () => {
  it('start UNVERIFIED, are nested and positive, and current sets never overlap', async () => {
    await expect(tx([insertSet('2016-01-01', '2025-04-05', { status: 'VERIFIED' })])).rejects.toThrow(/starts UNVERIFIED|sts_verification_ck/);
    await expect(tx([insertSet('2016-01-01', '2025-04-05', { micro: ['70000', '10000', 3] })])).rejects.toThrow(/sts_nested_ck/);
    await expect(tx([insertSet('2016-01-01', '2025-04-05', { micro: ['0', '10000', 3] })])).rejects.toThrow(/sts_positive_ck/);
    await expect(tx([insertSet('2025-04-06', '2025-01-01')])).rejects.toThrow(/sts_range_ck|range lower bound/);
    await tx([insertSet('2016-01-01', '2025-04-05')]);
    await expect(tx([insertSet('2025-04-05', null)])).rejects.toThrow(/overlaps another current threshold set/);
    await tx([insertSet('2025-04-06', null)]);
  });
  it('are verified once by another person, then never change; only a verified set is superseded; nothing is deleted', async () => {
    const [a] = await rows(`SELECT id FROM size_threshold_set WHERE effective_from = '2016-01-01'`);
    await expect(tx([`UPDATE size_threshold_set SET status = 'VERIFIED', verified_by_user_id = '${user}', verified_at = now(), verification_notes = 'Checked by the author' WHERE id = '${a!.id}'`])).rejects.toThrow(/sts_verification_ck/);
    await expect(tx([`UPDATE size_threshold_set SET status = 'VERIFIED', verified_by_user_id = '${other}', verified_at = now(), verification_notes = 'short' WHERE id = '${a!.id}'`])).rejects.toThrow(/sts_verification_ck/);
    await tx([`UPDATE size_threshold_set SET micro_turnover = 21000 WHERE id = '${a!.id}'`]);                 // editable while unverified
    await tx([`UPDATE size_threshold_set SET status = 'VERIFIED', verified_by_user_id = '${other}', verified_at = now(), verification_notes = 'Checked against the synthetic source' WHERE id = '${a!.id}'`]);
    await expect(tx([`UPDATE size_threshold_set SET micro_turnover = 22000 WHERE id = '${a!.id}'`])).rejects.toThrow(/verified threshold set is immutable/);
    await expect(tx([`UPDATE size_threshold_set SET prior_year_on_first = true WHERE id = '${a!.id}'`])).rejects.toThrow(/verified threshold set is immutable/);
    await expect(tx([`UPDATE size_threshold_set SET status = 'UNVERIFIED', verified_by_user_id = NULL, verified_at = NULL WHERE id = '${a!.id}'`])).rejects.toThrow(/immutable|verified once and superseded once|sts_verification_ck/);
    await expect(tx([`DELETE FROM size_threshold_set WHERE id = '${a!.id}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`TRUNCATE size_threshold_set`])).rejects.toThrow(/permission denied/);
    // supersede: the old set is marked first, then the copy takes its dates
    const id = uuidv7();
    await db.tenant({ organisationId: org, userId: user }, async (t) => {
      await t.$executeRawUnsafe(`UPDATE size_threshold_set SET status = 'SUPERSEDED', superseded_by_id = '${id}' WHERE id = '${a!.id}'`);
      await t.$executeRawUnsafe(insertSet('2016-01-01', '2025-04-05', { id }));
    });
    await expect(tx([`UPDATE size_threshold_set SET label = 'Changed' WHERE id = '${a!.id}'`])).rejects.toThrow(/superseded threshold set is final/);
  });
  it('another organisation sees none of them and cannot write into this one', async () => {
    expect(await rows(`SELECT id FROM size_threshold_set`, { organisationId: org2 })).toEqual([]);
    await expect(tx([insertSet('2030-01-01', null)], { organisationId: org2 })).rejects.toThrow(/row-level security/);
  });
});

describe('the turnover line and the size facts', () => {
  it('a verified version cannot name a turnover line that is not on its P&L, and its turnover line is frozen', async () => {
    await tx([`UPDATE reporting_standard_version SET turnover_line_key = 'B.CA' WHERE id = '${version}'`]);           // while unverified, checked at verification
    await expect(tx([`UPDATE reporting_standard_version SET status = 'VERIFIED', verified_by_user_id = '${other}', verified_at = now(), verification_notes = 'Checked synthetic content' WHERE id = '${version}'`]))
      .rejects.toThrow(/turnover line is not a profit and loss line/);
    await tx([`UPDATE reporting_standard_version SET turnover_line_key = 'P.T' WHERE id = '${version}'`]);
    await tx([`UPDATE reporting_standard_version SET status = 'VERIFIED', verified_by_user_id = '${other}', verified_at = now(), verification_notes = 'Checked synthetic content' WHERE id = '${version}'`]);
    await expect(tx([`UPDATE reporting_standard_version SET turnover_line_key = NULL WHERE id = '${version}'`])).rejects.toThrow(/verified standard version is immutable/);
  });
  it('size.priorMet and size.priorStatus are typed', async () => {
    await expect(tx([fact('size.priorMet', 'FIRST_YEAR')])).rejects.toThrow(/size.priorMet is MICRO, SMALL, MEDIUM or LARGE/);
    await expect(tx([fact('size.priorStatus', 'TINY')])).rejects.toThrow(/size.priorStatus is/);
    await expect(tx([fact('size.other', 'SMALL')])).rejects.toThrow(/af_key_ck|violates check/);
    await tx([fact('size.priorMet', 'SMALL'), fact('size.priorStatus', 'FIRST_YEAR')]);
  });
});
