import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statementMappingSchema } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, BankService, PostingService, type BankActor } from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** V1-M7a: the database defends bank accounts, statement imports and lines, and transfers even if application code is wrong or bypassed. */
let db: Database;
let org: string, user: string, co: string, bankId: string, importId: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const files = new Map<string, Buffer>();
const statements = new BankStatementService();
const me: BankActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const raw = (statements: string[], flags: string[] = []) => t(async (tx) => {
  for (const f of flags) await tx.$queryRawUnsafe(`SELECT set_config('${f}','on',true)`);
  for (const s of statements) await tx.$executeRawUnsafe(s);
});
const MAPPING = statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount' });
function upload(csv: string, status = 'AVAILABLE') {
  const data = Buffer.from(csv);
  const doc = sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','s.csv','${user}') RETURNING id`).split('\n')[0]!;
  const key = `k-${uuidv7()}`; files.set(key, data);
  const ver = sql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, sha256, status, created_by_user_id)
    VALUES ('${org}','${doc}',1,'${key}','text/csv',${data.length},'${createHash('sha256').update(data).digest('hex')}','${status}','${user}') RETURNING id`).split('\n')[0]!;
  return { documentId: doc, versionId: ver };
}

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('bdb-${org}@t.test','B') RETURNING id`).split('\n')[0]!;
  me.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Bank DB')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Bank DB Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  bankId = (await t((tx) => new BankService().create(tx, { organisationId: org, companyId: co, actor: me, accountId: acc['1200']!, name: 'Main', statementOpeningDate: '2026-01-01', statementOpeningBalance: '0' }))).id;
  const f = upload('Date,Description,Amount\n02/03/2026,ACME,100.00\n03/03/2026,FEE,-1.50\n');
  importId = (await t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: bankId, ...f, mapping: MAPPING }))).id;
  await statements.process(db, { getObject: async (k) => files.get(k)! }, { organisationId: org, userId: user, importId });
});
afterAll(() => db.close());

describe('bank accounts', () => {
  it('sit on a bank ledger account of the company, keep it, fix the currency once lines exist, and are never deleted', async () => {
    await expect(raw([`INSERT INTO bank_account(id, organisation_id, company_id, account_id, name, currency, statement_opening_date, created_by_user_id) VALUES ('${uuidv7()}','${org}','${co}','${acc['1220']}','Cash','GBP','2026-01-01','${user}')`])).rejects.toThrow(/bank ledger account/);
    await expect(raw([`UPDATE bank_account SET account_id='${acc['1210']}' WHERE id='${bankId}'`])).rejects.toThrow(/keeps its ledger account/);
    await expect(raw([`UPDATE bank_account SET currency='EUR' WHERE id='${bankId}'`])).rejects.toThrow(/fixed once statement lines exist/);
    await expect(raw([`UPDATE bank_account SET statement_opening_balance=10 WHERE id='${bankId}'`])).rejects.toThrow(/fixed once statement lines exist/);
    await expect(raw([`DELETE FROM bank_account WHERE id='${bankId}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
});

describe('statement imports and lines', () => {
  it('an import starts QUEUED from a scanned document of the company; what was requested never changes; its outcome is recorded once', async () => {
    const ins = (f: { documentId: string; versionId: string }, status = 'QUEUED') => `INSERT INTO bank_statement_import(id, organisation_id, company_id, bank_account_id, document_id, document_version_id, file_sha256, mapping, status, requested_by_user_id, completed_at)
      VALUES ('${uuidv7()}','${org}','${co}','${bankId}','${f.documentId}','${f.versionId}','${'0'.repeat(64)}','{}','${status}','${user}',${status === 'QUEUED' ? 'NULL' : 'now()'})`;
    await expect(raw([ins(upload('a'), 'COMPLETED')])).rejects.toThrow(/starts QUEUED/);
    await expect(raw([ins(upload('b', 'QUARANTINED'))])).rejects.toThrow(/scanned, available document/);
    await expect(raw([`UPDATE bank_statement_import SET mapping='{"x":1}' WHERE id='${importId}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`UPDATE bank_statement_import SET rows_imported=5 WHERE id='${importId}'`])).rejects.toThrow(/recorded once/);
    await expect(raw([`UPDATE bank_statement_import SET status='FAILED' WHERE id='${importId}'`])).rejects.toThrow(/QUEUED -> COMPLETED/);
    await expect(raw([`DELETE FROM bank_statement_import WHERE id='${importId}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('a completed import counts exactly what it stored; a failed one stores nothing', async () => {
    const f = upload('c');
    const id = uuidv7();
    const req = `INSERT INTO bank_statement_import(id, organisation_id, company_id, bank_account_id, document_id, document_version_id, file_sha256, mapping, requested_by_user_id) VALUES ('${id}','${org}','${co}','${bankId}','${f.documentId}','${f.versionId}','${'1'.repeat(64)}','{}','${user}')`;
    const line = `INSERT INTO bank_statement_line(organisation_id, company_id, bank_account_id, import_id, line_no, source_row, transaction_date, description, amount, fingerprint) VALUES ('${org}','${co}','${bankId}','${id}',1,2,'2026-03-04','X',5,'${'2'.repeat(64)}')`;
    await expect(raw([req, line, `UPDATE bank_statement_import SET status='COMPLETED', rows_imported=2, completed_at=now() WHERE id='${id}'`])).rejects.toThrow(/counts exactly the lines/);
    await expect(raw([req, line, `UPDATE bank_statement_import SET status='FAILED', completed_at=now() WHERE id='${id}'`])).rejects.toThrow(/stores nothing/);
  });
  it('lines are facts from the bank: no late inserts, no edits, no deletes; voided only with their import; the matched part moves only through a match', async () => {
    const lineId = sql(`SELECT id FROM bank_statement_line WHERE import_id='${importId}' AND line_no=1`);
    await expect(raw([`INSERT INTO bank_statement_line(organisation_id, company_id, bank_account_id, import_id, line_no, source_row, transaction_date, description, amount, fingerprint) VALUES ('${org}','${co}','${bankId}','${importId}',9,9,'2026-03-04','late',5,'${'3'.repeat(64)}')`])).rejects.toThrow(/stored by their own import while it runs/);
    await expect(raw([`UPDATE bank_statement_line SET amount=1000 WHERE id='${lineId}'`])).rejects.toThrow(/never edited/);
    await expect(raw([`UPDATE bank_statement_line SET voided=true WHERE id='${lineId}'`])).rejects.toThrow(/voided only with their import/);
    await expect(raw([`UPDATE bank_statement_line SET matched_amount=50 WHERE id='${lineId}'`])).rejects.toThrow(/only through a match/);
    await expect(raw([`UPDATE bank_statement_line SET matched_amount=150 WHERE id='${lineId}'`], ['app.bank_match'])).rejects.toThrow(/bank_statement_line_ck/);
    await expect(raw([`UPDATE bank_statement_line SET matched_amount=-5 WHERE id='${lineId}'`], ['app.bank_match'])).rejects.toThrow(/bank_statement_line_ck/);
    await expect(raw([`DELETE FROM bank_statement_line WHERE id='${lineId}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('an import with a matched line cannot be voided; voiding releases the fingerprints for a correct re-import', async () => {
    const lineId = sql(`SELECT id FROM bank_statement_line WHERE import_id='${importId}' AND line_no=1`);
    await raw([`UPDATE bank_statement_line SET matched_amount=40 WHERE id='${lineId}'`], ['app.bank_match']);
    await expect(raw([`UPDATE bank_statement_import SET status='VOID', voided_by_user_id='${user}', voided_at=now(), void_reason='Testing the matched-line rule' WHERE id='${importId}'`])).rejects.toThrow(/matched lines cannot be voided/);
    await raw([`UPDATE bank_statement_line SET matched_amount=0 WHERE id='${lineId}'`], ['app.bank_match']);
    await raw([`UPDATE bank_statement_import SET status='VOID', voided_by_user_id='${user}', voided_at=now(), void_reason='Testing the release of fingerprints' WHERE id='${importId}'`]);
    expect(sql(`SELECT string_agg(voided::text, ',') FROM bank_statement_line WHERE import_id='${importId}'`)).toBe('true,true');
    await expect(raw([`UPDATE bank_statement_import SET status='COMPLETED' WHERE id='${importId}'`])).rejects.toThrow(/void import cannot change/);
    const f = upload('Date,Description,Amount\n02/03/2026,ACME,100.00\n03/03/2026,FEE,-1.50\n ');
    const again = (await t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: bankId, ...f, mapping: MAPPING }))).id;
    await statements.process(db, { getObject: async (k) => files.get(k)! }, { organisationId: org, userId: user, importId: again });
    expect(sql(`SELECT rows_imported FROM bank_statement_import WHERE id='${again}'`)).toBe('2');
  });
});

describe('transfers', () => {
  it('point at their own journal; are immutable; a reversal must mirror the journal line by line; never deleted; never reversed in the ledger', async () => {
    const bank = new BankService();
    const x = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me, fromAccountId: acc['1200']!, toAccountId: acc['1210']!, transferDate: '2026-03-05', amount: '20.00', description: 'To deposit' }));
    await expect(raw([`UPDATE bank_transfer SET amount=1 WHERE id='${x.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`DELETE FROM bank_transfer WHERE id='${x.id}'`])).rejects.toThrow(/permission denied|not permitted/);
    await expect(raw([`INSERT INTO bank_transfer(id, organisation_id, company_id, from_account_id, to_account_id, transfer_date, currency, amount, description, journal_id, created_by_user_id)
      VALUES ('${uuidv7()}','${org}','${co}','${acc['1200']}','${acc['1210']}','2026-03-05','GBP',20,'x','${x.journalId}','${user}')`])).rejects.toThrow(/own posted journal|duplicate key/);
    const bad = await t((tx) => new PostingService().post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-05', sourceType: 'BANK_TRANSFER_REVERSAL', sourceId: x.id, description: 'not a mirror',
      lines: [{ accountId: acc['1200']!, debit: '20.00', credit: '0' }, { accountId: acc['1220']!, debit: '0', credit: '20.00' }], idempotencyKey: `bad:${x.id}`, actor: me, negativeCashReason: 'Synthetic attack on the mirror rule' }));
    await expect(raw([`UPDATE bank_transfer SET status='REVERSED', reversal_journal_id='${bad.id}', reversed_by_user_id='${user}', reversed_at=now(), reversed_reason='attack' WHERE id='${x.id}'`])).rejects.toThrow(/mirror its posted journal line by line/);
    await expect(t(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
      const period = sql(`SELECT id FROM accounting_period WHERE company_id='${co}'`);
      await tx.$executeRawUnsafe(`INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
        VALUES ('${uuidv7()}','${org}','${co}','${period}',990004,'2026-03-05','REVERSAL','${x.journalId}','x','GBP',20,2,'USER','${user}','k-${uuidv7()}','h','${x.journalId}')`);
    })).rejects.toThrow(/corrected in its sub-ledger/);
  });
});
