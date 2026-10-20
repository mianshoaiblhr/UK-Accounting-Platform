import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V2-M5c: the database defends the cash-flow content even if application code is bypassed (DEC-052, DEC-067). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, other: string, version: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const rows = (statement: string, o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, (t) => t.$queryRawUnsafe<{ id: string }[]>(statement));
const cls = (key: string, section: string, extra = '') =>
  `INSERT INTO cash_flow_class(organisation_id, version_id, key, section, name${extra ? ', adjustment_name' : ''}) VALUES ('${org}','${version}','${key}','${section}','Synthetic'${extra ? `,'${extra}'` : ''})`;
const map = (line: string, target: string) => `INSERT INTO cash_flow_map_entry(organisation_id, version_id, source_line, target) VALUES ('${org}','${version}','${line}','${target}')`;
const verify = `UPDATE reporting_standard_version SET status = 'VERIFIED', verified_by_user_id = '__OTHER__', verified_at = now(), verification_notes = 'Checked synthetic content' WHERE id = '__V__'`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('cfdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  other = sql(`INSERT INTO "user"(email, display_name) VALUES ('cfdb2-${org}@t.test','B') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','CF DB A'),('${org2}','BUSINESS','CF DB B')`);
  const std = sql(`INSERT INTO reporting_standard(organisation_id, code, name, created_by_user_id) VALUES ('${org}','SYNTH','Synthetic','${user}') RETURNING id`).split('\n')[0]!;
  version = sql(`INSERT INTO reporting_standard_version(organisation_id, standard_id, label, effective_from, source_url, source_reference, source_retrieved_on, created_by_user_id)
    VALUES ('${org}','${std}','v1','2025-01-01','https://example.test','Synthetic','2026-10-20','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO statutory_line(organisation_id, version_id, key, statement, sort, name, kind, natural_side) VALUES ('${org}','${version}','B.CA','BS',10,'Current assets','ACCOUNTS','DEBIT')`);
});
afterAll(() => db.close());

describe('cash-flow classes and map', () => {
  it('classes keep their shape: operating has no non-cash caption, investing and financing need one, CASH is reserved', async () => {
    await expect(tx([cls('OP.X', 'OPERATING', 'Not allowed')])).rejects.toThrow(/cfc_shape_ck/);
    await expect(tx([cls('INV.X', 'INVESTING')])).rejects.toThrow(/cfc_shape_ck/);
    await expect(tx([cls('CASH', 'OPERATING')])).rejects.toThrow(/cfc_key_ck/);
    await expect(tx([cls('OP.X', 'SIDEWAYS')])).rejects.toThrow(/cfc_section_ck/);
    await expect(tx([`INSERT INTO cash_flow_class(organisation_id, version_id, key, section, name, adjustment_name, inflow_name) VALUES ('${org}','${version}','FIN.X','FINANCING','x','y','in')`])).rejects.toThrow(/cfc_shape_ck/);
    await tx([cls('OP.WC', 'OPERATING'), cls('FIN.L', 'FINANCING', 'Non-cash loans')]);
    await expect(tx([cls('OP.WC', 'OPERATING')])).rejects.toThrow(/Unique constraint|duplicate key/);
  });
  it('only a balance-sheet line can be cash; a version listing sizes needs captions and cash; the map lands on its classes', async () => {
    await expect(tx([map('PL.TURNOVER', 'CASH')])).rejects.toThrow(/cfm_cash_ck/);
    await tx([map('BS.CURRENT_ASSETS.DEBTORS', 'OP.WC'), map('BS.CREDITORS_AFTER_ONE_YEAR', 'NOPE')]);
    const v = verify.replace('__OTHER__', other).replace('__V__', version);
    await expect(tx([`UPDATE reporting_standard_version SET cash_flow_applies_to = ARRAY['TINY'] WHERE id = '${version}'`])).rejects.toThrow(/rsv_cash_flow_sizes_ck/);
    await expect(tx([`UPDATE reporting_standard_version SET cash_flow_captions = '{"profit":"P"}' WHERE id = '${version}'`])).rejects.toThrow(/rsv_cash_flow_captions_ck/);
    await tx([`UPDATE reporting_standard_version SET cash_flow_applies_to = ARRAY['MEDIUM'] WHERE id = '${version}'`]);
    await expect(tx([v])).rejects.toThrow(/needs its captions and a map entry to CASH/);
    await tx([`UPDATE reporting_standard_version SET cash_flow_captions = '{"profit":"P","operating":"O","investing":"I","financing":"F","netChange":"N","opening":"A","closing":"B"}' WHERE id = '${version}'`, map('BS.CURRENT_ASSETS.CASH', 'CASH')]);
    await expect(tx([v])).rejects.toThrow(/points at a class that is not in this version/);
    const [bad] = await rows(`SELECT id FROM cash_flow_map_entry WHERE target = 'NOPE'`);
    await tx([`UPDATE cash_flow_map_entry SET target = 'FIN.L' WHERE id = '${bad!.id}'`]);
    await tx([v]);
  });
  it('once the version is verified its cash-flow content and columns are frozen; nothing is deleted; another organisation sees nothing', async () => {
    await expect(tx([cls('OP.LATE', 'OPERATING')])).rejects.toThrow(/cannot change; supersede it/);
    await expect(tx([`UPDATE cash_flow_class SET name = 'Changed' WHERE version_id = '${version}'`])).rejects.toThrow(/cannot change; supersede it/);
    await expect(tx([`UPDATE cash_flow_map_entry SET target = 'OP.WC' WHERE version_id = '${version}'`])).rejects.toThrow(/cannot change; supersede it/);
    await expect(tx([`UPDATE reporting_standard_version SET cash_flow_applies_to = ARRAY['LARGE'] WHERE id = '${version}'`])).rejects.toThrow(/verified standard version is immutable/);
    await expect(tx([`UPDATE reporting_standard_version SET cash_flow_captions = NULL WHERE id = '${version}'`])).rejects.toThrow(/verified standard version is immutable/);
    await expect(tx([`DELETE FROM cash_flow_class WHERE version_id = '${version}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM cash_flow_map_entry WHERE version_id = '${version}'`])).rejects.toThrow(/permission denied/);
    expect(await rows(`SELECT id FROM cash_flow_class`, { organisationId: org2 })).toEqual([]);
    expect(await rows(`SELECT id FROM cash_flow_map_entry`, { organisationId: org2 })).toEqual([]);
  });
});
