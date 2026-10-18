import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService, PostingService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M3a: the database defends the year-end adjustments even if application code is wrong or bypassed (DEC-059). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, co: string, journal: string, prov: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const accrual = (id: string, o: { kind?: string; pl?: string; bal?: string } = {}) =>
  `INSERT INTO year_end_item(id, organisation_id, company_id, kind, description, amount, pl_account_id, balance_account_id, item_date, accrual_journal_id, auto_reversal_journal_id, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${o.kind ?? 'ACCRUAL'}','Synthetic',100,'${acc[o.pl ?? '6110']}','${acc[o.bal ?? '2110']}','2026-12-31','${journal}','${journal}','${user}')`;
const run = (id: string, asAt: string) => `INSERT INTO release_run(id, organisation_id, company_id, as_at, journal_id, total, created_by_user_id) VALUES ('${id}','${org}','${co}','${asAt}','${journal}',10,'${user}')`;
const move = (id: string, kind: string, date: string, amount: number, offset?: string) =>
  `INSERT INTO provision_movement(id, organisation_id, company_id, provision_id, kind, movement_date, amount, offset_account_id, reason, journal_id, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${prov}','${kind}','${date}',${amount},${offset ? `'${acc[offset]}'` : 'NULL'},'Synthetic reason','${journal}','${user}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('yedb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','YE DB A'),('${org2}','BUSINESS','YE DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await db.tenant({ organisationId: org, userId: user }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  journal = (await db.tenant({ organisationId: org, userId: user }, (t) => new PostingService().post(t, { organisationId: org, companyId: co, journalDate: '2026-12-31', sourceType: 'MANUAL', description: 'Synthetic',
    idempotencyKey: `ye-db-${org}`, actor: { kind: 'USER', userId: user, can: async () => true }, lines: [{ accountId: acc['6110']!, debit: '100.00', credit: '0' }, { accountId: acc['2110']!, debit: '0', credit: '100.00' }] }))).id;
});
afterAll(() => db.close());

describe('items', () => {
  it('the accounts suit the kind and are never control accounts; the shape fits the kind', async () => {
    await expect(tx([accrual(uuidv7(), { pl: '4000' })])).rejects.toThrow(/do not suit the accrual/);
    await expect(tx([accrual(uuidv7(), { kind: 'ACCRUED_INCOME', pl: '4900', bal: '2110' })])).rejects.toThrow(/do not suit the accrued income/);
    await expect(tx([accrual(uuidv7(), { bal: '2100' })])).rejects.toThrow(/cannot use a control account/);
    await expect(tx([accrual(uuidv7(), { kind: 'PREPAYMENT', pl: '6200', bal: '1120' })])).rejects.toThrow(/yei_shape_ck|violates check/);
  });
  it('facts never change; ACTIVE -> CANCELLED once; never deleted', async () => {
    const i = uuidv7(); await tx([accrual(i)]);
    await expect(tx([`UPDATE year_end_item SET amount = 200 WHERE id='${i}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`UPDATE year_end_item SET status='CANCELLED' WHERE id='${i}'`])).rejects.toThrow(/yei_status_ck|violates check/);
    await tx([`UPDATE year_end_item SET status='CANCELLED', cancelled_at=now(), cancelled_reason='Synthetic' WHERE id='${i}'`]);
    await expect(tx([`UPDATE year_end_item SET cancelled_reason='Edited' WHERE id='${i}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`DELETE FROM year_end_item WHERE id='${i}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('release runs', () => {
  it('later than every live run; one live run per date; only the latest reversed, once', async () => {
    const r1 = uuidv7(), r2 = uuidv7();
    await tx([run(r1, '2026-03-31'), run(r2, '2026-06-30')]);
    await expect(tx([run(uuidv7(), '2026-05-31')])).rejects.toThrow(/later than every live run/);
    await expect(tx([`UPDATE release_run SET status='REVERSED', reversal_journal_id='${journal}', reversed_at=now(), reversed_reason='x' WHERE id='${r1}'`])).rejects.toThrow(/only the latest live release run/);
    await tx([`UPDATE release_run SET status='REVERSED', reversal_journal_id='${journal}', reversed_at=now(), reversed_reason='Re-run' WHERE id='${r2}'`]);
    await expect(tx([`UPDATE release_run SET reversed_reason='Edited' WHERE id='${r2}'`])).rejects.toThrow(/never edited/);
    await tx([run(uuidv7(), '2026-06-30')]);
  });
});

describe('provisions', () => {
  it('a provision sits on a non-control liability and an expense account and is written once', async () => {
    prov = uuidv7();
    await expect(tx([`INSERT INTO provision(id, organisation_id, company_id, name, account_id, expense_account_id, basis, created_by_user_id) VALUES ('${uuidv7()}','${org}','${co}','P','${acc['1120']}','${acc['6700']}','Synthetic','${user}')`])).rejects.toThrow(/non-control liability/);
    await tx([`INSERT INTO provision(id, organisation_id, company_id, name, account_id, expense_account_id, basis, created_by_user_id) VALUES ('${prov}','${org}','${co}','P','${acc['2110']}','${acc['6700']}','Synthetic','${user}')`]);
    await expect(tx([`UPDATE provision SET basis='x' WHERE id='${prov}'`])).rejects.toThrow(/permission denied/);
  });
  it('movements are dated in order, never take the balance below zero, and only the latest is reversed, once', async () => {
    const m1 = uuidv7(), m2 = uuidv7();
    await expect(tx([move(uuidv7(), 'USED', '2026-01-31', 1, '6700')])).rejects.toThrow(/below zero/);
    await tx([move(m1, 'MADE', '2026-02-28', 100), move(m2, 'USED', '2026-03-31', 40, '6700')]);
    await expect(tx([move(uuidv7(), 'MADE', '2026-03-01', 1)])).rejects.toThrow(/date order/);
    await expect(tx([move(uuidv7(), 'RELEASED', '2026-04-30', 60.01)])).rejects.toThrow(/below zero/);
    await expect(tx([move(uuidv7(), 'USED', '2026-04-30', 1)])).rejects.toThrow(/pm_kind_ck|violates check/);                 // a use names its offset account
    await expect(tx([move(uuidv7(), 'USED', '2026-04-30', 1, '1200')])).rejects.toThrow(/not used against a control account/);
    await expect(tx([`UPDATE provision_movement SET status='REVERSED', reversal_journal_id='${journal}', reversed_at=now(), reversed_reason='x' WHERE id='${m1}'`])).rejects.toThrow(/only the latest live movement/);
    await tx([`UPDATE provision_movement SET status='REVERSED', reversal_journal_id='${journal}', reversed_at=now(), reversed_reason='Wrong' WHERE id='${m2}'`]);
    await expect(tx([`UPDATE provision_movement SET amount = 1 WHERE id='${m2}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`DELETE FROM provision_movement WHERE id='${m1}'`])).rejects.toThrow(/permission denied/);
  });
  it('another organisation sees none of it (forced RLS)', async () => {
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.provisionMovement.count())).toBe(0);
    await expect(tx([accrual(uuidv7())], { organisationId: org2 })).rejects.toThrow(/row-level security/);
  });
});
