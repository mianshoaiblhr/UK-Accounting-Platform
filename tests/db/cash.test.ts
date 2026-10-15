import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, CashService, PostingService, type CashActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M6c: the database defends cash transactions and cash in hand even if application code is wrong or bypassed (runtime role, tenant context).
 * The posting flag is set by hand here to simulate code that bypasses the PostingService.
 */
let db: Database;
let org: string, user: string, co: string, period: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const cash = new CashService();
const me: CashActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const raw = (statements: string[], o: { flag?: boolean } = {}) => t(async (tx) => {
  if (o.flag) await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
  for (const s of statements) await tx.$executeRawUnsafe(s);
});
const journal = (id: string, o: { date?: string; source?: string; sourceId?: string; total: string; lines: number; reason?: string; actor?: string }) =>
  `INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, negative_cash_reason)
   VALUES ('${id}','${org}','${co}','${period}',${Math.floor(1_000_000 + Math.random() * 8_000_000)},'${o.date ?? '2026-03-01'}','${o.source ?? 'CASH_PAYMENT'}',${o.sourceId ? `'${o.sourceId}'` : 'NULL'},'db test','GBP',${o.total},${o.lines},'${o.actor ?? 'USER'}',${o.actor === 'SYSTEM' ? 'NULL' : `'${user}'`},'k-${uuidv7()}','h',${o.reason ? `'${o.reason}'` : 'NULL'})`;
const line = (j: string, no: number, account: string, debit: string, credit: string) =>
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit) VALUES ('${org}','${co}','${j}',${no},'${account}',${debit},${credit})`;
const record = (amount: string, direction: 'PAYMENT' | 'RECEIPT', date = '2026-02-02', reason?: string) => t((tx) => cash.record(tx, { organisationId: org, companyId: co, actor: me, direction, transactionDate: date,
  bankAccountId: acc['1220']!, description: 'Synthetic', amountsIncludeVat: false, lines: [{ description: 'Synthetic', accountId: acc[direction === 'PAYMENT' ? '6400' : '4100']!, amount }],
  duplicateOverrideReason: 'Synthetic transactions in the database tests', ...(reason ? { negativeCashReason: reason } : {}) }));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('cdb-${org}@t.test','C') RETURNING id`).split('\n')[0]!;
  me.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Cash DB')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Cash DB Co') RETURNING id`).split('\n')[0]!;
  period = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31') RETURNING id`).split('\n')[0]!;
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('cash in hand below zero (DEC-037)', () => {
  it('a person\'s journal that takes cash in hand below zero fails at commit without a reason, even past the PostingService', async () => {
    await record('50.00', 'RECEIPT', '2026-02-01');
    const j = uuidv7();
    await expect(raw([journal(j, { total: '80', lines: 2, date: '2026-02-03' }), line(j, 1, acc['6400']!, '80', '0'), line(j, 2, acc['1220']!, '0', '80')], { flag: true })).rejects.toThrow(/below zero/);
    // a back-dated one that leaves its own day positive but overdraws a later day fails too
    await record('40.00', 'PAYMENT', '2026-02-10');
    const k = uuidv7();
    await expect(raw([journal(k, { total: '20', lines: 2, date: '2026-02-05' }), line(k, 1, acc['6400']!, '20', '0'), line(k, 2, acc['1220']!, '0', '20')], { flag: true })).rejects.toThrow(/below zero \(-10\.0000 on 2026-02-10\)/);
    // with a reason it commits; the reason must be a real sentence
    const r = uuidv7();
    await expect(raw([journal(r, { total: '20', lines: 2, date: '2026-02-05', reason: 'short' }), line(r, 1, acc['6400']!, '20', '0'), line(r, 2, acc['1220']!, '0', '20')], { flag: true })).rejects.toThrow(/negative_cash_reason_ck/);
    await raw([journal(r, { total: '20', lines: 2, date: '2026-02-05', reason: 'Owner paid from the till before banking' }), line(r, 1, acc['6400']!, '20', '0'), line(r, 2, acc['1220']!, '0', '20')], { flag: true });
    expect(sql(`SELECT sum(debit - credit) FROM journal_line WHERE account_id='${acc['1220']}'`)).toBe('-10.0000');
  });
  it('a functional-only revaluation adjustment moves no money, so it is not refused even while the box is short', async () => {
    const v = uuidv7();
    await raw([journal(v, { total: '3', lines: 2, source: 'FX_REVALUATION' }), line(v, 1, acc['8000']!, '3', '0'),
      `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit, adjusts_currency) VALUES ('${org}','${co}','${v}',2,'${acc['1220']}',0,3,'EUR')`], { flag: true });
    expect(sql(`SELECT sum(debit - credit) FROM journal_line WHERE account_id='${acc['1220']}'`)).toBe('-13.0000');
  });
  it('a bank account may be overdrawn; a system posting is not refused; the reason column cannot be edited afterwards', async () => {
    const b = uuidv7();
    await raw([journal(b, { total: '500', lines: 2 }), line(b, 1, acc['6400']!, '500', '0'), line(b, 2, acc['1200']!, '0', '500')], { flag: true });
    const s = uuidv7();
    await raw([journal(s, { total: '5', lines: 2, actor: 'SYSTEM', source: 'MANUAL' }), line(s, 1, acc['6400']!, '5', '0'), line(s, 2, acc['1220']!, '0', '5')], { flag: true });
    await expect(raw([`UPDATE journal SET negative_cash_reason = 'Changed my mind about the reason' WHERE id='${b}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
});

describe('cash transactions', () => {
  it('a transaction points at its own journal of its direction; its totals match its lines and the bank line; lines are written with it only', async () => {
    const p = await record('10.00', 'PAYMENT', '2026-03-02', 'The box is short after the earlier tests');
    const ins = (id: string, o: { journal?: string; direction?: string; gross?: string; bank?: string } = {}) => `INSERT INTO cash_transaction(id, organisation_id, company_id, direction, transaction_date, bank_account_id, description, currency, net_total, vat_total, gross_total, journal_id, created_by_user_id)
      VALUES ('${id}','${org}','${co}','${o.direction ?? 'PAYMENT'}','2026-03-02','${o.bank ?? acc['1220']}','x','GBP',${o.gross ?? '10'},0,${o.gross ?? '10'},'${o.journal ?? p.journalId}','${user}')`;
    await expect(raw([ins(uuidv7())])).rejects.toThrow(/own posted journal|cash_transaction_journal_key|duplicate key/);
    // a journal of the wrong direction
    const j = uuidv7(), id = uuidv7();
    await raw([journal(j, { total: '10', lines: 2, source: 'CASH_RECEIPT', sourceId: id, date: '2026-03-02' }), line(j, 1, acc['1220']!, '10', '0'), line(j, 2, acc['4100']!, '0', '10')], { flag: true });
    await expect(raw([ins(id, { journal: j })])).rejects.toThrow(/own posted journal of its direction/);
    // the right direction but totals that do not match the lines (no lines at all)
    await expect(raw([ins(id, { journal: j, direction: 'RECEIPT' })])).rejects.toThrow(/totals do not match its lines/);
    // a line added later, in another transaction
    await expect(raw([`INSERT INTO cash_transaction_line(organisation_id, company_id, transaction_id, line_no, description, account_id, amount, net, vat) VALUES ('${org}','${co}','${p.id}',2,'late','${acc['6400']}',1,1,0)`])).rejects.toThrow(/written with their transaction/);
    // a line to a bank or control account
    const j2 = uuidv7(), id2 = uuidv7();
    await expect(raw([journal(j2, { total: '10', lines: 2, source: 'CASH_RECEIPT', sourceId: id2, date: '2026-03-02' }), line(j2, 1, acc['1220']!, '10', '0'), line(j2, 2, acc['4100']!, '0', '10'),
      ins(id2, { journal: j2, direction: 'RECEIPT' }),
      `INSERT INTO cash_transaction_line(organisation_id, company_id, transaction_id, line_no, description, account_id, amount, net, vat) VALUES ('${org}','${co}','${id2}',1,'x','${acc['1100']}',10,10,0)`], { flag: true })).rejects.toThrow(/non-control account/);
  });
  it('a transaction is immutable; lines cannot change; nothing is deleted', async () => {
    const p = await record('3.00', 'PAYMENT', '2026-03-03', 'The box is short after the earlier tests');
    await expect(raw([`UPDATE cash_transaction SET description='edited' WHERE id='${p.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`UPDATE cash_transaction_line SET net=1 WHERE transaction_id='${p.id}'`])).rejects.toThrow(/permission denied|not permitted/);
    await expect(raw([`DELETE FROM cash_transaction WHERE id='${p.id}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('REVERSED needs its own reversal journal that mirrors the posted one line by line; only once', async () => {
    const p = await record('7.00', 'RECEIPT', '2026-03-04');
    // a "reversal" journal of the right source whose lines are not the mirror
    const bad = await t((tx) => new PostingService().post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-04', sourceType: 'CASH_RECEIPT_REVERSAL', sourceId: p.id, description: 'not a mirror',
      lines: [{ accountId: acc['8000']!, debit: '7.00', credit: '0' }, { accountId: acc['1220']!, debit: '0', credit: '7.00' }], idempotencyKey: `bad:${p.id}`, actor: me, negativeCashReason: 'Synthetic attack on the mirror rule' }));
    await expect(raw([`UPDATE cash_transaction SET status='REVERSED', reversal_journal_id='${bad.id}', reversed_by_user_id='${user}', reversed_at=now(), reversed_reason='attack' WHERE id='${p.id}'`])).rejects.toThrow(/mirror its posted journal line by line/);
    const ok = await t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me, id: p.id, reason: 'Entered in error', negativeCashReason: 'Synthetic: the box is already short' }));
    expect(ok.status).toBe('REVERSED');
    await expect(raw([`UPDATE cash_transaction SET status='POSTED', reversal_journal_id=NULL, reversed_by_user_id=NULL, reversed_at=NULL, reversed_reason=NULL WHERE id='${p.id}'`])).rejects.toThrow(/reversed cash transaction cannot change/);
  });
  it('a cash journal cannot be reversed in the ledger, even by a direct insert', async () => {
    const p = await record('2.00', 'RECEIPT', '2026-03-05');
    await expect(t(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
      await tx.$executeRawUnsafe(`INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
        VALUES ('${uuidv7()}','${org}','${co}','${period}',990003,'2026-03-05','REVERSAL','${p.journalId}','x','GBP',2,2,'USER','${user}','k-${uuidv7()}','h','${p.journalId}')`);
    })).rejects.toThrow(/corrected in its sub-ledger/);
  });
});
