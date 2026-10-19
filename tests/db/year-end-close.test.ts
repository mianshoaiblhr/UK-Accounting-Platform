import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService, PostingService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M3b: the database defends the closing journal even if application code is wrong or bypassed (DEC-060). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, co: string, pl: string, bs: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const close = (id: string, start: string, end: string, o: { re?: string } = {}) =>
  `INSERT INTO year_end_close(id, organisation_id, company_id, year_start, year_end, retained_earnings_account_id, journal_id, profit, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${start}','${end}','${acc[o.re ?? '3200']}','${pl}',100,'${user}')`;
/** A copy of a posted journal, written straight into the tables (as the PostingService would, with its flag on), so only the triggers stand in the way. */
const copy = (journalId: string) => {
  const j = uuidv7();
  return ["SELECT set_config('app.posting', 'on', true)",
    `INSERT INTO journal SELECT * FROM jsonb_populate_record(NULL::journal, (SELECT to_jsonb(x) || jsonb_build_object('id', '${j}', 'journal_number', 900000 + (random() * 99999)::int, 'idempotency_key', '${j}') FROM journal x WHERE x.id = '${journalId}'))`,
    `INSERT INTO journal_line SELECT (jsonb_populate_record(NULL::journal_line, to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'journal_id', '${j}'))).* FROM journal_line l WHERE l.journal_id = '${journalId}' ORDER BY l.line_no`];
};

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('yecdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','YEC DB A'),('${org2}','BUSINESS','YEC DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31'),('${org}','${co}','2027-01-01','2027-12-31')`);
  for (const a of (await db.tenant({ organisationId: org, userId: user }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  const post = (code: string, dr: string, cr: string) => db.tenant({ organisationId: org, userId: user }, (t) => new PostingService().post(t, { organisationId: org, companyId: co, journalDate: '2026-06-30', sourceType: 'MANUAL',
    description: 'Synthetic', idempotencyKey: `yec-db-${code}-${org}`, actor: { kind: 'USER', userId: user, can: async () => true }, lines: [{ accountId: acc[dr]!, debit: '100.00', credit: '0' }, { accountId: acc[cr]!, debit: '0', credit: '100.00' }] }));
  pl = (await post('pl', '6110', '1110')).id;
  bs = (await post('bs', '1120', '1110')).id;
});
afterAll(() => db.close());

describe('closes', () => {
  it('a close covers at most 18 months, sits on the retained-earnings account and never overlaps a live close', async () => {
    await expect(tx([close(uuidv7(), '2026-01-01', '2027-07-01')])).rejects.toThrow(/yec_year_ck|violates check/);
    await expect(tx([close(uuidv7(), '2026-01-01', '2026-12-31', { re: '3100' })])).rejects.toThrow(/retained-earnings account/);
    await tx([close(uuidv7(), '2026-01-01', '2026-12-31')]);
    await expect(tx([close(uuidv7(), '2026-07-01', '2027-06-30')])).rejects.toThrow(/overlaps a live year-end close/);
  });
  it('facts never change; POSTED -> REVERSED once with who, when and why; never deleted', async () => {
    const id = sql(`SELECT id FROM year_end_close WHERE company_id='${co}' AND status='POSTED'`);
    await expect(tx([`UPDATE year_end_close SET profit = 1 WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`UPDATE year_end_close SET status='REVERSED' WHERE id='${id}'`])).rejects.toThrow(/yec_status_ck|violates check/);
    await expect(tx([`DELETE FROM year_end_close WHERE id='${id}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('the closed year', () => {
  it('a live close keeps income and expense out of its year even when the PostingService is bypassed; balance-sheet journals still pass', async () => {
    await expect(tx(copy(pl))).rejects.toThrow(/2026-01-01 to 2026-12-31 is closed/);
    await tx(copy(bs));
    // once the close is reversed the year takes income and expense again
    const id = sql(`SELECT id FROM year_end_close WHERE company_id='${co}' AND status='POSTED'`);
    await tx([`UPDATE year_end_close SET status='REVERSED', reversal_journal_id='${bs}', reversed_at=now(), reversed_by_user_id='${user}', reversed_reason='Synthetic' WHERE id='${id}'`]);
    await expect(tx([`UPDATE year_end_close SET reversed_reason='Edited' WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await tx(copy(pl));
  });
  it('another organisation sees none of it (forced RLS)', async () => {
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.yearEndClose.count())).toBe(0);
    // the guard runs before the row-level check and cannot see the other organisation's account, so either refusal stops the write
    await expect(tx([close(uuidv7(), '2027-01-01', '2027-12-31')], { organisationId: org2 })).rejects.toThrow(/row-level security|retained-earnings account/);
    await expect(tx([`UPDATE year_end_close SET reversed_reason = 'x' WHERE company_id = '${co}'`], { organisationId: org2 })).resolves.toBeUndefined();
    expect(sql(`SELECT count(*) FROM year_end_close WHERE company_id='${co}' AND reversed_reason = 'x'`)).toBe('0');
  });
});
