import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService, PostingService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M2: the database defends the fixed-asset register even if application code is wrong or bypassed (DEC-058). Runtime role, tenant context. */
let db: Database;
let org: string, org2: string, user: string, co: string, cls: string, journal: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const klass = (id: string, o: Partial<Record<'cost' | 'dep' | 'exp' | 'disp', string>> & { code?: string } = {}) =>
  `INSERT INTO fixed_asset_class(id, organisation_id, company_id, code, name, cost_account_id, depreciation_account_id, expense_account_id, disposal_account_id, method, life_months, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${o.code ?? 'C' + id.slice(-6).toUpperCase()}','Synthetic','${acc[o.cost ?? '0030']}','${acc[o.dep ?? '0031']}','${acc[o.exp ?? '6900']}','${acc[o.disp ?? '8000']}','STRAIGHT_LINE',12,'${user}')`;
const asset = (id: string, n: number, o: { kind?: string; status?: string } = {}) =>
  `INSERT INTO fixed_asset(id, organisation_id, company_id, class_id, number, description, acquired_on, in_use_from, cost, addition_kind, addition_journal_id, status, created_by_user_id)
   VALUES ('${id}','${org}','${co}','${cls}',${n},'Synthetic asset','2026-01-01','2026-01-01',1200,'${o.kind ?? 'LINKED'}','${journal}','${o.status ?? 'ACTIVE'}','${user}')`;
const basis = (assetId: string, from: string) => `INSERT INTO fixed_asset_basis(organisation_id, asset_id, effective_from, carrying_amount, accumulated_before, method, life_months, residual, convention, reason, created_by_user_id)
   VALUES ('${org}','${assetId}','${from}',1200,0,'STRAIGHT_LINE',12,0,'MONTHLY','Synthetic','${user}')`;
const run = (id: string, asAt: string) => `INSERT INTO depreciation_run(id, organisation_id, company_id, as_at, total, created_by_user_id) VALUES ('${id}','${org}','${co}','${asAt}',0,'${user}')`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('fadb-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','FA DB A'),('${org2}','BUSINESS','FA DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await db.tenant({ organisationId: org, userId: user }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  journal = (await db.tenant({ organisationId: org, userId: user }, (t) => new PostingService().post(t, { organisationId: org, companyId: co, journalDate: '2026-01-01', sourceType: 'MANUAL', description: 'Synthetic purchase',
    idempotencyKey: `fa-db-${org}`, actor: { kind: 'USER', userId: user, can: async () => true }, lines: [{ accountId: acc['0030']!, debit: '1200.00', credit: '0' }, { accountId: acc['2230']!, debit: '0', credit: '1200.00' }] }))).id;
  cls = uuidv7(); await tx([klass(cls, { code: 'OFFICE' })]);
});
afterAll(() => db.close());

describe('classes', () => {
  it('the four accounts are of the right kind and never control accounts; code and accounts never move', async () => {
    await expect(tx([klass(uuidv7(), { cost: '6900' })])).rejects.toThrow(/cost account must be a tangible or intangible fixed asset/);
    await expect(tx([klass(uuidv7(), { dep: '0030' })])).rejects.toThrow(/depreciation account must be an accumulated depreciation account/);
    await expect(tx([klass(uuidv7(), { exp: '8000' })])).rejects.toThrow(/expense account must be a depreciation expense account/);
    await expect(tx([klass(uuidv7(), { disp: '1110' })])).rejects.toThrow(/disposal account must be an income or expense account/);
    await expect(tx([klass(uuidv7(), { code: 'OFFICE' })])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([`UPDATE fixed_asset_class SET cost_account_id='${acc['0040']}' WHERE id='${cls}'`])).rejects.toThrow(/keeps its code and accounts/);
    await tx([`UPDATE fixed_asset_class SET name='Office equipment' WHERE id='${cls}'`]);
    await expect(tx([`DELETE FROM fixed_asset_class WHERE id='${cls}'`])).rejects.toThrow(/permission denied/);
  });
});

describe('assets, bases and runs', () => {
  const a1 = uuidv7();
  it('an asset starts ACTIVE; its acquisition facts never change; VOID is final; a disposed asset is never edited', async () => {
    await expect(tx([asset(uuidv7(), 90, { status: 'DISPOSED' })])).rejects.toThrow(/a new asset is ACTIVE|fa_disposal_ck|violates check/);
    await expect(tx([asset(uuidv7(), 91, { kind: 'POSTED' })])).rejects.toThrow(/fa_kind_ck|violates check/);              // a posted addition names its offset account
    await tx([asset(a1, 1)]);
    await expect(tx([asset(uuidv7(), 1)])).rejects.toThrow(/unique|duplicate/i);
    for (const set of ['cost = 1000', `acquired_on = '2026-02-01'`, `class_id = '${uuidv7()}'`, 'take_on_accumulated = 0.01'])
      await expect(tx([`UPDATE fixed_asset SET ${set} WHERE id='${a1}'`]), set).rejects.toThrow(/acquisition facts never change|violates/);
    await tx([`UPDATE fixed_asset SET tax_category='AIA', tax_cost=1200 WHERE id='${a1}'`]);                                  // tax fields move freely
    await expect(tx([`UPDATE fixed_asset SET status='VOID' WHERE id='${a1}'`])).rejects.toThrow(/fa_void_ck|violates check/);  // VOID only by reversing a posted addition
    await expect(tx([`DELETE FROM fixed_asset WHERE id='${a1}'`])).rejects.toThrow(/permission denied/);
  });
  it('bases are append-only and never start before the latest one', async () => {
    await tx([basis(a1, '2026-01-01')]);
    await tx([basis(a1, '2026-01-01')]);                                                     // nothing charged yet: a same-day basis replaces it
    await tx([basis(a1, '2026-07-01')]);
    await expect(tx([basis(a1, '2026-03-01')])).rejects.toThrow(/cannot start before the latest basis/);
    await expect(tx([`UPDATE fixed_asset_basis SET residual = 1 WHERE asset_id='${a1}'`])).rejects.toThrow(/permission denied/);
    expect(() => sql(`UPDATE fixed_asset_basis SET residual = 1 WHERE asset_id='${a1}'`)).toThrow(/append-only/);
  });
  it('a run is later than every live run; one live run per date; only the latest live run is reversed, once; lines are written once', async () => {
    const r1 = uuidv7(), r2 = uuidv7();
    await tx([run(r1, '2026-03-31'), run(r2, '2026-06-30')]);
    await expect(tx([run(uuidv7(), '2026-05-31')])).rejects.toThrow(/later than every live run/);
    await expect(tx([`UPDATE depreciation_run SET status='REVERSED', reversed_at=now(), reversed_reason='x' WHERE id='${r1}'`])).rejects.toThrow(/only the latest live run/);
    await tx([`UPDATE depreciation_run SET status='REVERSED', reversed_at=now(), reversed_reason='Re-run' WHERE id='${r2}'`]);
    await expect(tx([`UPDATE depreciation_run SET reversed_reason='Edited' WHERE id='${r2}'`])).rejects.toThrow(/never edited/);
    await tx([run(uuidv7(), '2026-06-30')]);                                                 // the reversed date can be run again
    await tx([`INSERT INTO depreciation_run_line(organisation_id, run_id, asset_id, class_id, amount, accumulated_after) VALUES ('${org}','${r1}','${a1}','${cls}',300,300)`]);
    await expect(tx([`UPDATE depreciation_run_line SET amount = 1 WHERE run_id='${r1}'`])).rejects.toThrow(/permission denied/);
    await expect(tx([`INSERT INTO depreciation_run_line(organisation_id, run_id, asset_id, class_id, amount, accumulated_after) VALUES ('${org}','${r1}','${a1}','${cls}',0,0)`])).rejects.toThrow(/drl_amount_ck|violates check|unique/);
  });
  it('another organisation sees none of it (forced RLS)', async () => {
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.fixedAsset.count())).toBe(0);
    await expect(tx([klass(uuidv7(), { code: 'LEAK' })], { organisationId: org2 })).rejects.toThrow(/row-level security/);
  });
});

describe('system roles carry the asset permissions as the contracts say (DEC-058)', () => {
  it('owner, admin, partner, manager and accountant manage; bookkeeper and reviewer read; client viewer neither', () => {
    const perms = (key: string) => sql(`SELECT array_to_string(ARRAY(SELECT p FROM unnest(permissions) p WHERE p LIKE 'assets:%' ORDER BY p COLLATE "C"), ',') FROM role WHERE organisation_id IS NULL AND key='${key}'`);
    for (const k of ['owner', 'admin', 'partner', 'manager', 'accountant']) expect(perms(k), k).toBe('assets:manage,assets:read');
    for (const k of ['bookkeeper', 'reviewer']) expect(perms(k), k).toBe('assets:read');
    expect(perms('client_viewer')).toBe('');
  });
});
