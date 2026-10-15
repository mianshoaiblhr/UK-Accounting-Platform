import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statementMappingSchema } from '@uk/contracts';
import { FieldEncryption, uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, BankService, FxSettingsService, PostingService, RateService, type BankActor } from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { adminSql } from '../helpers/db';

/**
 * V1-M7a through the services: bank accounts with encrypted details, CSV statement imports staged by the importer (all or nothing, duplicates,
 * overlap, void and re-import) and transfers between bank and cash accounts (negative cash, foreign currency, reversal). ALL DATA IS SYNTHETIC.
 */
let db: Database;
let org: string, user: string, co: string;
const acc: Record<string, string> = {};
const crypto = new FieldEncryption(process.env.FIELD_ENCRYPTION_KEY ?? 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=');
const bank = new BankService({ crypto });
const statements = new BankStatementService();
const files = new Map<string, Buffer>();
const storage = { getObject: async (key: string) => files.get(key)! };
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): BankActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||coalesce(':'||l.original_currency||l.original_debit||'/'||l.original_credit,''), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const MAPPING = statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount', balanceColumn: 'Balance', referenceColumn: 'Reference' });

/** A scanned (AVAILABLE) CSV document of the company, held in the fake storage. */
function upload(csv: string, status = 'AVAILABLE') {
  const data = Buffer.from(csv, 'utf8');
  const doc = sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','statement.csv','${user}') RETURNING id`).split('\n')[0]!;
  const key = `k-${uuidv7()}`;
  files.set(key, data);
  const ver = sql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, sha256, status, created_by_user_id)
    VALUES ('${org}','${doc}',1,'${key}','text/csv',${data.length},'${createHash('sha256').update(data).digest('hex')}','${status}','${user}') RETURNING id`).split('\n')[0]!;
  return { documentId: doc, versionId: ver };
}
const importCsv = async (bankAccountId: string, csv: string, o: { mapping?: typeof MAPPING; duplicateOverrideReason?: string } = {}) => {
  const f = upload(csv);
  const req = await t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId, ...f, mapping: o.mapping ?? MAPPING, duplicateOverrideReason: o.duplicateOverrideReason }));
  await statements.process(db, storage, { organisationId: org, userId: user, importId: req.id });
  return t((tx) => statements.getImport(tx, co, req.id));
};
const lines = (bankAccountId: string, q: Record<string, unknown> = {}) => t((tx) => statements.listLines(tx, co, bankAccountId, { limit: 100, ...q }));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('bank-${org}@t.test','B') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Bank')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Bank Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  const accounts = new AccountService();
  for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  const mk = async (code: string, name: string, type: string, subtype: string, mapping: string) =>
    (acc[code] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: co, userId: user, input: { code, name, type: type as never, subtype, isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: mapping, activeFrom: null, activeTo: null } }))).id);
  for (const [n, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) await mk(n, name, 'EXPENSE', 'OTHER_EXPENSE', 'PL.OTHER_EXPENSES');
  await mk('1250', 'Euro account A', 'ASSET', 'CURRENT_ASSET_BANK', 'BS.CURRENT_ASSETS.CASH');
  await mk('1251', 'Euro account B', 'ASSET', 'CURRENT_ASSET_BANK', 'BS.CURRENT_ASSETS.CASH');
  await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: co, actor: me(), roundingAccountId: acc['7900']!, realisedAccountId: acc['7910']!, unrealisedAccountId: acc['7920']!, defaultSeries: {}, reason: 'FX accounts for the bank tests' }));
  await t((tx) => new RateService().create(tx, { organisationId: org, companyId: co, actor: me(), fromCurrency: 'EUR', kind: 'DAILY', validFrom: '2026-03-02', rate: '0.85', source: 'synthetic test rate' }));
});
afterAll(() => db.close());

describe('bank accounts (V1-MOD-10, V1-BANK-01)', () => {
  let main: Awaited<ReturnType<BankService['create']>>;
  it('sits on a bank ledger account; details are encrypted, listed masked, read in full only by an audited call', async () => {
    main = await t((tx) => bank.create(tx, { organisationId: org, companyId: co, actor: me(), accountId: acc['1200']!, name: 'Main current account', bankName: 'Synthetic Bank plc',
      details: { sortCode: '123456', accountNumber: '12345678', iban: 'GB29NWBK60161331926819' }, statementOpeningDate: '2026-02-28', statementOpeningBalance: '50.00', chargesAccountId: acc['6800'] }));
    expect(main).toMatchObject({ accountCode: '1200', currency: 'GBP', detailsMasked: '**-**-56 ****5678 / GB** **** 6819', statementOpeningBalance: '50.00', ledgerBalance: '0.00',
      statement: { lines: 0, balance: '50.00', lastDate: null, unmatchedLines: 0 }, status: 'ACTIVE' });
    const enc = sql(`SELECT account_details_enc FROM bank_account WHERE id='${main.id}'`);
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain('12345678');
    expect(sql(`SELECT count(*) FROM audit_event WHERE entity_id='${main.id}' AND (after::text LIKE '%12345678%' OR after::text LIKE '%NWBK6016%')`)).toBe('0');
    const full = await t((tx) => bank.details(tx, { organisationId: org, companyId: co, actor: me(), id: main.id }));
    expect(full.details).toEqual({ sortCode: '123456', accountNumber: '12345678', iban: 'GB29NWBK60161331926819' });
    expect(sql(`SELECT count(*) FROM audit_event WHERE entity_id='${main.id}' AND action='bank_account.details_read'`)).toBe('1');
    await rejects(t((tx) => bank.details(tx, { organisationId: org, companyId: co, actor: me(['bank:manage']), id: main.id })), 'permission_denied', 403);
  });
  it('one bank account per ledger account; only CURRENT_ASSET_BANK accounts; charges accounts are ordinary accounts', async () => {
    const create = (accountId: string, o: Record<string, unknown> = {}) => t((tx) => bank.create(tx, { organisationId: org, companyId: co, actor: me(), accountId, name: 'X', statementOpeningDate: '2026-01-01', statementOpeningBalance: '0', ...o }));
    await rejects(create(acc['1200']!), 'bank_account_exists', 409);
    await rejects(create(acc['1220']!), 'not_a_bank_account');
    await rejects(create(acc['1210']!, { chargesAccountId: acc['2100'] }), 'control_account_restricted');
    await rejects(create(acc['1210']!, { statementOpeningBalance: '1.001' }), 'invalid_amount');
    await rejects(create(acc['1210']!, { currency: 'XXX' }), 'unknown_currency');
  });

  describe('statement import (V1-BANK-02, V1-BANK-03)', () => {
    const FEB = 'Date,Description,Amount,Balance,Reference\n'
      + '03/03/2026,CARD PAYMENT STATIONERS,-12.40,287.60,\n'
      + '02/03/2026,"ACME LTD, PAYMENT",250.00,300.00,INV-1\n';
    it('stages the lines in date order with the opening and closing balance; nothing is posted', async () => {
      const journals = sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`);
      const imp = await importCsv(main.id, FEB);
      expect(imp).toMatchObject({ status: 'COMPLETED', rowsRead: 2, rowsImported: 2, rowsDuplicate: 0, errors: [], firstDate: '2026-03-02', lastDate: '2026-03-03', openingBalance: '50.00', closingBalance: '287.60' });
      expect((await lines(main.id)).items.map((l) => [l.date, l.amount, l.reference, l.status])).toEqual([['2026-03-02', '250.00', 'INV-1', 'UNMATCHED'], ['2026-03-03', '-12.40', null, 'UNMATCHED']]);
      expect(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`)).toBe(journals);
      expect((await t((tx) => bank.get(tx, co, main.id))).statement).toEqual({ lines: 2, balance: '287.60', lastDate: '2026-03-03', unmatchedLines: 2 });
      expect(sql(`SELECT count(*) FROM outbox_event WHERE event_type='bank_statement.imported' AND aggregate_id='${imp.id}'`)).toBe('1');
    });
    it('the same file again needs a reason, and then imports nothing new', async () => {
      await rejects(importCsv(main.id, FEB), 'statement_already_imported', 409);
      const again = await importCsv(main.id, FEB, { duplicateOverrideReason: 'Checking the overlap handling deliberately' });
      expect(again).toMatchObject({ status: 'COMPLETED', rowsImported: 0, rowsDuplicate: 2 });
    });
    it('an overlapping statement skips only the overlap; two genuine identical payments on one day are both kept', async () => {
      const MAR = 'Date,Description,Amount,Balance,Reference\n'
        + '03/03/2026,CARD PAYMENT STATIONERS,-12.40,287.60,\n'
        + '04/03/2026,COFFEE,-2.50,285.10,\n'
        + '04/03/2026,COFFEE,-2.50,282.60,\n';
      const imp = await importCsv(main.id, MAR);
      expect(imp).toMatchObject({ rowsRead: 3, rowsImported: 2, rowsDuplicate: 1, openingBalance: '300.00', closingBalance: '282.60' });
      expect((await lines(main.id)).items.map((l) => l.amount)).toEqual(['250.00', '-12.40', '-2.50', '-2.50']);
    });
    it('one bad row fails the whole file: nothing stored, every row error reported, the job itself completes', async () => {
      const before = (await lines(main.id)).items.length;
      const imp = await importCsv(main.id, 'Date,Description,Amount,Balance,Reference\n05/03/2026,OK,1.00,283.60,\n06/03/2026,BROKEN,abc,283.60,\n31/02/2026,BAD DATE,1.00,284.60,\n');
      expect(imp).toMatchObject({ status: 'FAILED', rowsRead: 3, rowsImported: null });
      expect(imp.errors).toEqual([{ row: 3, message: expect.stringMatching(/not a number/) }, { row: 4, message: expect.stringMatching(/not a date/) }]);
      expect((await lines(main.id)).items.length).toBe(before);
    });
    it('a wrongly mapped import is voided with a reason; its lines stay visible as void; the file then imports correctly', async () => {
      const csv = 'Date,Description,Amount,Balance,Reference\n05/03/2026,INTEREST,0.40,283.00,\n';
      // the bank exports interest as positive, but the person flipped the sign by mistake (and left out the balance check)
      const wrong = await importCsv(main.id, csv, { mapping: statementMappingSchema.parse({ ...MAPPING, balanceColumn: undefined, invertSign: true }) });
      expect((await lines(main.id, { importId: wrong.id })).items.map((l) => l.amount)).toEqual(['-0.40']);
      const voided = await t((tx) => statements.void(tx, { organisationId: org, companyId: co, userId: user, importId: wrong.id, reason: 'Sign flipped in the mapping by mistake' }));
      expect(voided).toMatchObject({ status: 'VOID', voidReason: 'Sign flipped in the mapping by mistake' });
      expect((await lines(main.id, { status: 'VOID' })).items.map((l) => l.amount)).toEqual(['-0.40']);
      await rejects(t((tx) => statements.void(tx, { organisationId: org, companyId: co, userId: user, importId: wrong.id, reason: 'Voiding twice on purpose' })), 'import_not_completed', 409);
      const right = await importCsv(main.id, csv, { duplicateOverrideReason: 'Re-importing after voiding the wrong mapping' });
      expect(right).toMatchObject({ status: 'COMPLETED', rowsImported: 1 });
      expect((await lines(main.id, { status: 'UNMATCHED' })).items.map((l) => l.amount)).toEqual(['250.00', '-12.40', '-2.50', '-2.50', '0.40']);
    });
    it('only scanned documents of the company, into active accounts; a closed account takes no statement', async () => {
      const pending = upload('Date,Description,Amount\n', 'SCANNING');
      await rejects(t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: main.id, ...pending, mapping: MAPPING })), 'document_not_available', 409);
      const other = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Other Co') RETURNING id`).split('\n')[0]!;
      const f = upload('x');
      sql(`UPDATE document SET company_id='${other}' WHERE id='${f.documentId}'`);
      await rejects(t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: main.id, ...f, mapping: MAPPING })), 'document_company_mismatch');
      const dep = await t((tx) => bank.create(tx, { organisationId: org, companyId: co, actor: me(), accountId: acc['1210']!, name: 'Deposit', statementOpeningDate: '2026-01-01', statementOpeningBalance: '0' }));
      await t((tx) => bank.close(tx, { organisationId: org, companyId: co, actor: me(), id: dep.id, reason: 'Account closed at the bank' }));
      await rejects(t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: dep.id, ...upload('y'), mapping: MAPPING })), 'bank_account_closed', 409);
      await rejects(t((tx) => bank.update(tx, { organisationId: org, companyId: co, actor: me(), id: dep.id, name: 'Renamed', reason: 'Trying to edit' })), 'bank_account_closed', 409);
    });
    it('the opening point is fixed once lines exist', async () => {
      await rejects(t((tx) => bank.update(tx, { organisationId: org, companyId: co, actor: me(), id: main.id, statementOpeningBalance: '60.00', reason: 'Correcting the opening balance' })), 'bank_opening_fixed', 409);
      const renamed = await t((tx) => bank.update(tx, { organisationId: org, companyId: co, actor: me(), id: main.id, name: 'Main account', details: { sortCode: '654321', accountNumber: '87654321' }, reason: 'New account number after a bank merger' }));
      expect(renamed).toMatchObject({ name: 'Main account', detailsMasked: '**-**-21 ****4321' });
    });
  });
});

describe('transfers (V1-BANK-06)', () => {
  it('bank to cash posts one journal; cash back to the bank; the cash box cannot go below zero without a reason', async () => {
    const out = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-10', amount: '100.00', reference: 'PETTY 1', description: 'Petty cash float' }));
    expect(out).toMatchObject({ amount: '100.00', currency: 'GBP', status: 'POSTED' });
    expect(linesOf(out.journalId)).toBe('1220:100.0000/0.0000 ; 1200:0.0000/100.0000');
    expect(out.balanceWarnings).toMatchObject([{ accountCode: '1200', kind: 'BANK', lowestBalance: '-100.00' }]);
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1220']!, toAccountId: acc['1200']!, transferDate: '2026-03-11', amount: '150.00', description: 'Banking the float' })), 'negative_cash', 422);
    const back = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1220']!, toAccountId: acc['1200']!, transferDate: '2026-03-11', amount: '40.00', description: 'Unused float banked' }));
    expect(linesOf(back.journalId)).toBe('1200:40.0000/0.0000 ; 1220:0.0000/40.0000');
  });
  it('duplicates need a reason; a reversal mirrors the journal and is refused when it would empty the cash box', async () => {
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-12', amount: '1.00', reference: 'PETTY 1', description: 'Again' })), 'possible_duplicate', 409);
    const x = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-12', amount: '70.00', description: 'Second float' }));
    // the box holds 60.00 + 70.00 = 130.00; reversing the first float (100.00) on 12 March leaves 30.00: fine (dated 10 March it would leave -40.00 on 11 March)
    const list = await t((tx) => bank.listTransfers(tx, co, { accountId: acc['1220'], limit: 10 }));
    const first = list.items.find((i) => i.reference === 'PETTY 1')!;
    const rev = await t((tx) => bank.reverseTransfer(tx, { organisationId: org, companyId: co, actor: me(), id: first.id, reason: 'Float was never taken out', date: '2026-03-12' }));
    expect(rev).toMatchObject({ status: 'REVERSED' });
    expect(linesOf(rev.reversalJournalId!)).toBe('1220:0.0000/100.0000 ; 1200:100.0000/0.0000');
    // reversing the second float now would leave -40.00 on 12 March
    await rejects(t((tx) => bank.reverseTransfer(tx, { organisationId: org, companyId: co, actor: me(), id: x.id, reason: 'Entered by mistake' })), 'negative_cash');
    await rejects(t((tx) => bank.reverseTransfer(tx, { organisationId: org, companyId: co, actor: me(), id: first.id, reason: 'Again' })), 'transfer_reversed', 409);
    await rejects(t((tx) => new PostingService().reverse(tx, { organisationId: org, companyId: co, journalId: x.journalId, reason: 'Ledger route', actor: me() })), 'subledger_journal');
  });
  it('same foreign currency at one rate (no exchange difference); different currencies are refused; only bank or cash accounts; people with bank:transfer', async () => {
    for (const [code, name] of [['1250', 'Euro A'], ['1251', 'Euro B']]) await t((tx) => bank.create(tx, { organisationId: org, companyId: co, actor: me(), accountId: acc[code]!, name, currency: 'EUR', statementOpeningDate: '2026-01-01', statementOpeningBalance: '0' }));
    const eur = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1250']!, toAccountId: acc['1251']!, transferDate: '2026-03-02', amount: '100.00', description: 'Between euro accounts' }));
    expect(eur.currency).toBe('EUR');
    expect(linesOf(eur.journalId)).toBe('1251:85.0000/0.0000:EUR100.0000/0.0000 ; 1250:0.0000/85.0000:EUR0.0000/100.0000');
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1250']!, toAccountId: acc['1200']!, transferDate: '2026-03-02', amount: '10.00', description: 'Cross' })), 'cross_currency_transfer_not_supported');
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1200']!, toAccountId: acc['6800']!, transferDate: '2026-03-02', amount: '10.00', description: 'Not a bank' })), 'not_a_bank_account');
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(['bank:transfer']), fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-02', amount: '10.00', description: 'No permission' })), 'permission_denied', 403);
    await rejects(t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: { ...me(), kind: 'AI' } as BankActor, fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-02', amount: '10.00', description: 'AI' })), 'ai_cannot_post', 403);
  });
});
