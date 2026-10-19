import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M4: the database defends the loan-account and related-party registers even if application code is wrong or bypassed (DEC-062). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, co: string, director: string, holder: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const loan = (id: string, o: { contact?: string; kind?: string; account?: string } = {}) =>
  `INSERT INTO director_loan_account(id, organisation_id, company_id, contact_id, kind, account_id, opened_on, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${o.contact ?? director}','${o.kind ?? 'DIRECTOR'}','${acc[o.account ?? '2230']}','2026-01-01','${user}')`;
const party = (id: string, o: { contact?: string; relationship?: string } = {}) =>
  `INSERT INTO related_party(id, organisation_id, company_id, contact_id, relationship, description, from_date, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${o.contact ?? holder}','${o.relationship ?? 'SHAREHOLDER'}','Synthetic','2026-01-01','${user}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('dirdb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','DIR DB A'),('${org2}','BUSINESS','DIR DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  director = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','D','${user}') RETURNING id`).split('\n')[0]!;
  holder = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','H','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO company_officer(organisation_id, company_id, contact_id, role, appointed_on) VALUES ('${org}','${co}','${director}','DIRECTOR','2020-01-01')`);
  for (const a of (await db.tenant({ organisationId: org, userId: user }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('loan accounts', () => {
  it('sit on a non-control asset or liability account that is not bank or cash; a director needs an appointment; one live account per ledger account and per person', async () => {
    await expect(tx([loan(uuidv7(), { account: '1200' })])).rejects.toThrow(/non-control asset or liability/);
    await expect(tx([loan(uuidv7(), { account: '2100' })])).rejects.toThrow(/non-control asset or liability/);
    await expect(tx([loan(uuidv7(), { account: '6400' })])).rejects.toThrow(/non-control asset or liability/);
    await expect(tx([loan(uuidv7(), { contact: holder, account: '2210' })])).rejects.toThrow(/DIRECTOR appointment/);
    await tx([loan(uuidv7())]);
    await expect(tx([loan(uuidv7(), { contact: holder, kind: 'SHAREHOLDER' })])).rejects.toThrow(/dla_live_account_key|duplicate key|Unique constraint/);
    await expect(tx([loan(uuidv7(), { account: '2210' })])).rejects.toThrow(/dla_live_person_key|duplicate key|Unique constraint/);
  });
  it('facts never change; ACTIVE -> CLOSED once with date, reason and who; never deleted', async () => {
    const id = sql(`SELECT id FROM director_loan_account WHERE company_id='${co}'`);
    await expect(tx([`UPDATE director_loan_account SET account_id='${acc['2210']}' WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`UPDATE director_loan_account SET status='CLOSED' WHERE id='${id}'`])).rejects.toThrow(/dla_status_ck|violates check/);
    await tx([`UPDATE director_loan_account SET status='CLOSED', closed_on='2026-12-31', closed_reason='Synthetic', closed_by_user_id='${user}' WHERE id='${id}'`]);
    await expect(tx([`UPDATE director_loan_account SET closed_reason='Edited' WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`DELETE FROM director_loan_account WHERE id='${id}'`])).rejects.toThrow(/permission denied/);
    await tx([loan(uuidv7())]);                                                                  // the account is free again once closed
  });
  it('thresholds are written once: above zero, with a reason; never updated or deleted', async () => {
    const ins = (lm: string, od: string, reason = 'Synthetic review threshold') =>
      `INSERT INTO director_loan_threshold(organisation_id, company_id, large_movement, overdrawn, reason, set_by_user_id) VALUES ('${org}','${co}',${lm},${od},'${reason}','${user}')`;
    await expect(tx([ins('0', 'NULL')])).rejects.toThrow(/dlt_amounts_ck|violates check/);
    await expect(tx([ins('NULL', 'NULL', 'x')])).rejects.toThrow(/dlt_reason_ck|violates check/);
    await tx([ins('2000', 'NULL')]);
    await expect(tx([`UPDATE director_loan_threshold SET large_movement = 1 WHERE company_id='${co}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`DELETE FROM director_loan_threshold WHERE company_id='${co}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('related parties', () => {
  it('one live entry per counterparty and relationship; facts never change; ACTIVE -> ENDED once; never deleted', async () => {
    const id = uuidv7();
    await expect(tx([party(uuidv7(), { relationship: 'COUSIN' })])).rejects.toThrow(/rp_relationship_ck|violates check/);
    await tx([party(id)]);
    await expect(tx([party(uuidv7())])).rejects.toThrow(/rp_live_key|duplicate key|Unique constraint/);
    await tx([party(uuidv7(), { relationship: 'KEY_MANAGEMENT' })]);
    await expect(tx([`UPDATE related_party SET description='Edited' WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`UPDATE related_party SET status='ENDED', to_date='2025-12-31', ended_reason='x', ended_by_user_id='${user}', ended_at=now() WHERE id='${id}'`])).rejects.toThrow(/rp_status_ck|violates check/);
    await tx([`UPDATE related_party SET status='ENDED', to_date='2026-12-31', ended_reason='Synthetic', ended_by_user_id='${user}', ended_at=now() WHERE id='${id}'`]);
    await expect(tx([`UPDATE related_party SET ended_reason='Edited' WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(tx([`DELETE FROM related_party WHERE id='${id}'`])).rejects.toThrow(/permission denied/);
  });
  it('another organisation sees none of it (forced RLS)', async () => {
    for (const m of ['directorLoanAccount', 'directorLoanThreshold', 'relatedParty'] as const)
      expect(await db.tenant({ organisationId: org2, userId: user }, (t) => (t[m] as unknown as { count: () => Promise<number> }).count()), m).toBe(0);
    await expect(tx([party(uuidv7(), { relationship: 'OTHER' })], { organisationId: org2 })).rejects.toThrow(/row-level security/);
  });
});
