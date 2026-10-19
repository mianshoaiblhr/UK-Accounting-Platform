import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, DirectorService, PostingService, type PostingActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V2-M4 through the service: refusals that the API does not reach (an AI actor, a person without the permission, bad dates, unknown contacts), and a statement read from a posted journal. The rule that VAT lines never decide a category is unit-tested (tests/unit/directors.test.ts). */
let db: Database;
let org: string, user: string, co: string, director: string;
const acc: Record<string, string> = {};
const svc = new DirectorService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): PostingActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string) => expect(p).rejects.toMatchObject({ code: c });
const base = (actor = me()) => ({ organisationId: org, companyId: co, actor });

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('dir-${org}@t.test','D') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Directors')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Dir Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  director = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Dana Director','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO company_officer(organisation_id, company_id, contact_id, role, appointed_on) VALUES ('${org}','${co}','${director}','DIRECTOR','2020-01-01')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('refusals', () => {
  it('an AI actor and a person without accounts:prepare are refused; an unknown contact and a close before the opening are refused; nothing is written', async () => {
    const body = { contactId: director, kind: 'DIRECTOR', accountId: acc['2230']!, openedOn: '2026-01-01' };
    await rejects(t((tx) => svc.createLoanAccount(tx, { ...base({ ...me(), kind: 'AI' }), ...body })), 'ai_cannot_write');
    await rejects(t((tx) => svc.createLoanAccount(tx, { ...base(me(['accounts:prepare'])), ...body })), 'permission_denied');
    await rejects(t((tx) => svc.createLoanAccount(tx, { ...base(), ...body, contactId: uuidv7() })), 'unknown_contact');
    await rejects(t((tx) => svc.createRelatedParty(tx, { ...base(me(['accounts:prepare'])), contactId: director, relationship: 'DIRECTOR', description: 'Director', fromDate: '2026-01-01' })), 'permission_denied');
    await rejects(t((tx) => svc.setThresholds(tx, { ...base({ ...me(), kind: 'AI' }), largeMovement: '10.00', overdrawn: null, reason: 'Not allowed' })), 'ai_cannot_write');
    expect(sql(`SELECT count(*) FROM director_loan_account WHERE company_id='${co}'`)).toBe('0');
    const l = await t((tx) => svc.createLoanAccount(tx, { ...base(), ...body }));
    await rejects(t((tx) => svc.closeLoanAccount(tx, { ...base(), id: l.id, closedOn: '2025-12-31', reason: 'Before it opened' })), 'invalid_date');
    await rejects(t((tx) => svc.loanStatement(tx, co, l.id, { from: '2026-12-31', to: '2026-01-01' })), 'invalid_date');
  });
});

describe('categories through the ledger', () => {
  it('expenses paid personally are EXPENSES; with no earlier movement the lowest balance is the opening one, from the first day', async () => {
    const l = (await t((tx) => svc.listLoanAccounts(tx, co, { status: 'ACTIVE' }))).items[0]!;
    const j = (await t((tx) => new PostingService().post(tx, { organisationId: org, companyId: co, journalDate: '2026-04-30', sourceType: 'MANUAL', description: 'Travel paid by the director',
      idempotencyKey: `dir-${uuidv7()}`, actor: me(), lines: [{ accountId: acc['6400']!, debit: '300.00', credit: '0' }, { accountId: acc['2230']!, debit: '0', credit: '300.00' }] }))).id;
    const st = (await t((tx) => svc.loanStatement(tx, co, l.id, { from: '2026-01-01', to: '2026-12-31' }))).statement!;
    expect(st.movements.map((m) => [m.journalId, m.amount, m.category])).toEqual([[j, '300.00', 'EXPENSES']]);
    expect(st).toMatchObject({ closing: '300.00', lowest: '0.00', lowestOn: '2026-01-01', daysOverdrawn: 0, flags: [], notEvaluated: ['LARGE_MOVEMENT', 'OVERDRAWN_ABOVE_THRESHOLD'] });
  });
});
