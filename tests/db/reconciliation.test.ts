import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statementMappingSchema } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, BankService, CashService, type BankActor } from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** V1-M7b: the database proves every match (same account, same direction, never more than either side) and keeps sign-offs immutable, past any code. */
let db: Database;
let org: string, user: string, co: string, bankId: string;
let lineIn: string, lineIn2: string, lineOut: string, receipt: string, payment: string, otherAccountLine: string;
const acc: Record<string, string> = {};
const files = new Map<string, Buffer>();
const sql = adminSql;
const me: BankActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const raw = (statements: string[]) => t(async (tx) => { for (const s of statements) await tx.$executeRawUnsafe(s); });
const ins = (line: string, jl: string, amount: string, o: { account?: string; journal?: string } = {}) => {
  const journal = o.journal ?? sql(`SELECT journal_id FROM journal_line WHERE id='${jl}'`);
  return `INSERT INTO bank_match(id, organisation_id, company_id, bank_account_id, statement_line_id, journal_line_id, journal_id, amount, kind, created_by_user_id)
    VALUES ('${uuidv7()}','${org}','${co}','${o.account ?? bankId}','${line}','${jl}','${journal}',${amount},'MANUAL','${user}')`;
};
const matched = (line: string) => sql(`SELECT matched_amount FROM bank_statement_line WHERE id='${line}'`);

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('rdb-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  me.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Rec DB')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Rec DB Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  bankId = (await t((tx) => new BankService().create(tx, { organisationId: org, companyId: co, actor: me, accountId: acc['1200']!, name: 'Main', statementOpeningDate: '2026-01-31', statementOpeningBalance: '0' }))).id;
  const cash = new CashService();
  const post = async (direction: 'RECEIPT' | 'PAYMENT', amount: string, account: string) => (await t((tx) => cash.record(tx, { organisationId: org, companyId: co, actor: me, direction, transactionDate: '2026-02-02',
    bankAccountId: acc['1200']!, description: 'x', amountsIncludeVat: false, lines: [{ description: 'x', accountId: acc[account]!, amount }], duplicateOverrideReason: 'Synthetic entries in the database tests' }))).journalId;
  const rj = await post('RECEIPT', '100.00', '4000'), pj = await post('PAYMENT', '30.00', '6310');
  receipt = sql(`SELECT id FROM journal_line WHERE journal_id='${rj}' AND account_id='${acc['1200']}'`);
  payment = sql(`SELECT id FROM journal_line WHERE journal_id='${pj}' AND account_id='${acc['1200']}'`);
  otherAccountLine = sql(`SELECT id FROM journal_line WHERE journal_id='${rj}' AND account_id='${acc['4000']}'`);
  const data = Buffer.from('Date,Description,Amount\n02/02/2026,IN,60.00\n02/02/2026,IN TWO,60.00\n02/02/2026,OUT,-30.00\n');
  const doc = sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','s.csv','${user}') RETURNING id`).split('\n')[0]!;
  files.set('k1', data);
  const ver = sql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, sha256, status, created_by_user_id)
    VALUES ('${org}','${doc}',1,'k1','text/csv',${data.length},'${createHash('sha256').update(data).digest('hex')}','AVAILABLE','${user}') RETURNING id`).split('\n')[0]!;
  const st = new BankStatementService();
  const req = await t((tx) => st.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: bankId, documentId: doc, versionId: ver,
    mapping: statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount' }) }));
  await st.process(db, { getObject: async (k) => files.get(k)! }, { organisationId: org, userId: user, importId: req.id });
  [lineIn, lineIn2, lineOut] = sql(`SELECT id FROM bank_statement_line WHERE import_id='${req.id}' ORDER BY line_no`).split('\n') as [string, string, string];
});
afterAll(() => db.close());

describe('matches', () => {
  it('only a ledger entry on the bank account, in the same direction, with the same sign as the line', async () => {
    await expect(raw([ins(lineIn, otherAccountLine, '60')])).rejects.toThrow(/bank account's own ledger account/);
    await expect(raw([ins(lineIn, payment, '30')])).rejects.toThrow(/money in matches a debit/);
    await expect(raw([ins(lineIn, receipt, '-60')])).rejects.toThrow(/money in matches a debit/);
    await expect(raw([ins(lineIn, receipt, '60', { journal: sql(`SELECT journal_id FROM journal_line WHERE id='${payment}'`) })])).rejects.toThrow(/own ledger account/);
  });
  it('the statement line moves with every match and unmatch, never above its amount; the ledger entry is never matched for more than it holds', async () => {
    await raw([ins(lineIn, receipt, '60')]);
    expect(matched(lineIn)).toBe('60.0000');
    await expect(raw([ins(lineIn, receipt, '1')])).rejects.toThrow(/bank_match_active_pair_key|duplicate key|Unique constraint failed/);
    await expect(raw([ins(lineIn2, receipt, '50')])).rejects.toThrow(/matched for more than it holds/);
    await raw([ins(lineIn2, receipt, '40')]);
    expect(matched(lineIn2)).toBe('40.0000');
    await raw([ins(lineOut, payment, '-30')]);
    await expect(raw([`UPDATE bank_statement_line SET matched_amount = 0 WHERE id='${lineOut}'`])).rejects.toThrow(/only through a match/);
    const id = sql(`SELECT id FROM bank_match WHERE statement_line_id='${lineIn2}'`);
    await expect(raw([`UPDATE bank_match SET amount = 1 WHERE id='${id}'`])).rejects.toThrow(/never edited/);
    await expect(raw([`UPDATE bank_match SET status='UNMATCHED', unmatched_by_user_id='${user}', unmatched_at=now(), unmatch_reason='short' WHERE id='${id}'`])).rejects.toThrow(/bank_match_status_ck/);
    await raw([`UPDATE bank_match SET status='UNMATCHED', unmatched_by_user_id='${user}', unmatched_at=now(), unmatch_reason='Matched to the wrong lodgement' WHERE id='${id}'`]);
    expect(matched(lineIn2)).toBe('0.0000');
    await expect(raw([`UPDATE bank_match SET status='ACTIVE', unmatched_by_user_id=NULL, unmatched_at=NULL, unmatch_reason=NULL WHERE id='${id}'`])).rejects.toThrow(/undone match cannot change/);
    await expect(raw([`DELETE FROM bank_match WHERE id='${id}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
});

describe('sign-offs', () => {
  it('only a proved reconciliation is recorded, and it is never changed or deleted', async () => {
    const insRec = (diff: string, closing = '10', stmt = '10') => `INSERT INTO bank_reconciliation(id, organisation_id, company_id, bank_account_id, as_at, bank_closing_balance, statement_balance, ledger_balance, unmatched_statement, unmatched_ledger, difference, unmatched_statement_lines, unmatched_ledger_lines, signed_by_user_id)
      VALUES ('${uuidv7()}','${org}','${co}','${bankId}','2026-02-28',${closing},${stmt},10,0,0,${diff},0,0,'${user}')`;
    await expect(raw([insRec('5')])).rejects.toThrow(/bank_reconciliation_proof_ck/);
    await expect(raw([insRec('0', '11')])).rejects.toThrow(/bank_reconciliation_proof_ck/);
    await raw([insRec('0')]);
    await expect(raw([`UPDATE bank_reconciliation SET notes='x' WHERE bank_account_id='${bankId}'`])).rejects.toThrow(/permission denied|not permitted/);
    await expect(raw([`DELETE FROM bank_reconciliation WHERE bank_account_id='${bankId}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
});
