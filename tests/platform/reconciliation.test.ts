import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statementMappingSchema } from '@uk/contracts';
import { FieldEncryption, uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, BankService, CashService, ReconciliationService, type ReconcileActor } from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { adminSql } from '../helpers/db';

/**
 * V1-M7b through the services, on one hand-calculated month (all synthetic):
 *   statement opening 28 Feb 100.00 (the ledger also holds 100.00 from a transfer on 15 Feb)
 *   bank: +250.00 ACME INV-1001 (3 Mar), +200.00 counter credit (8 Mar = two lodgements 120.00 + 80.00), -30.00 to petty cash (9 Mar),
 *         -6.50 service charge (10 Mar), +1.25 gross interest (12 Mar)                                        -> statement 514.75
 *   ledger: 100.00 + 250.00 - 40.00 (cheque 101, not yet presented) + 120.00 + 80.00 - 30.00 - 6.50 + 1.25    -> ledger 474.75
 *   proof at 31 Mar: 514.75 - 0.00 = 474.75 - (-40.00): difference 0.00
 */
let db: Database;
let org: string, user: string, co: string, bankId: string;
const acc: Record<string, string> = {};
const files = new Map<string, Buffer>();
const bank = new BankService({ crypto: new FieldEncryption('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=') });
const cash = new CashService();
const rec = new ReconciliationService();
const statements = new BankStatementService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): ReconcileActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const MAPPING = statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount', balanceColumn: 'Balance' });
async function importCsv(csv: string) {
  const data = Buffer.from(csv);
  const doc = sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','s.csv','${user}') RETURNING id`).split('\n')[0]!;
  const key = `k-${uuidv7()}`; files.set(key, data);
  const ver = sql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, sha256, status, created_by_user_id)
    VALUES ('${org}','${doc}',1,'${key}','text/csv',${data.length},'${createHash('sha256').update(data).digest('hex')}','AVAILABLE','${user}') RETURNING id`).split('\n')[0]!;
  const req = await t((tx) => statements.request(tx, { organisationId: org, companyId: co, userId: user, bankAccountId: bankId, documentId: doc, versionId: ver, mapping: MAPPING }));
  await statements.process(db, { getObject: async (k) => files.get(k)! }, { organisationId: org, userId: user, importId: req.id });
  return (await t((tx) => statements.listLines(tx, co, bankId, { importId: req.id, limit: 100 }))).items;
}
const money = (direction: 'RECEIPT' | 'PAYMENT', date: string, amount: string, account: string, reference: string) =>
  t((tx) => cash.record(tx, { organisationId: org, companyId: co, actor: me(), direction, transactionDate: date, bankAccountId: acc['1200']!, reference, description: reference, amountsIncludeVat: false,
    lines: [{ description: reference, accountId: acc[account]!, amount }] }));
const bankLine = (journalId: string) => sql(`SELECT l.id FROM journal_line l WHERE l.journal_id='${journalId}' AND l.account_id='${acc['1200']}'`);
const match = (statementLineId: string, journalLineId: string, o: { amount?: string; overrideReason?: string; fromSuggestion?: boolean; actor?: ReconcileActor } = {}) =>
  t((tx) => rec.match(tx, { organisationId: org, companyId: co, actor: o.actor ?? me(), statementLineId, journalLineId, amount: o.amount, overrideReason: o.overrideReason, fromSuggestion: o.fromSuggestion }));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('rec-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Reconciliation')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Rec Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  bankId = (await t((tx) => bank.create(tx, { organisationId: org, companyId: co, actor: me(), accountId: acc['1200']!, name: 'Current', statementOpeningDate: '2026-02-28', statementOpeningBalance: '100.00',
    chargesAccountId: acc['6800'], interestReceivedAccountId: acc['4900'], interestPaidAccountId: acc['7000'] }))).id;
});
afterAll(() => db.close());

describe('a month reconciled (V1-MOD-18, V1-BANK-04, V1-REC-01..05, V1-BANK-05/07/08)', () => {
  let s: Awaited<ReturnType<typeof importCsv>>;
  let receipt: string, cheque: string, lodge120: string, lodge80: string, transfer: string;
  it('the ledger and the statement', async () => {
    await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1210']!, toAccountId: acc['1200']!, transferDate: '2026-02-15', amount: '100.00', description: 'Opening funds' }));
    receipt = bankLine((await money('RECEIPT', '2026-03-02', '250.00', '4000', 'INV-1001')).journalId);
    cheque = bankLine((await money('PAYMENT', '2026-03-05', '40.00', '6310', 'CHQ 101')).journalId);
    lodge120 = bankLine((await money('RECEIPT', '2026-03-08', '120.00', '4000', 'LODGE A')).journalId);
    lodge80 = bankLine((await money('RECEIPT', '2026-03-08', '80.00', '4000', 'LODGE B')).journalId);
    const tr = await t((tx) => bank.transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc['1200']!, toAccountId: acc['1220']!, transferDate: '2026-03-09', amount: '30.00', description: 'Petty cash' }));
    transfer = bankLine(tr.journalId);
    s = await importCsv('Date,Description,Amount,Balance\n03/03/2026,ACME LTD INV-1001,250.00,350.00\n08/03/2026,COUNTER CREDIT,200.00,550.00\n09/03/2026,TFR PETTY CASH,-30.00,520.00\n'
      + '10/03/2026,SERVICE CHARGE,-6.50,513.50\n12/03/2026,GROSS INTEREST,1.25,514.75\n');
    expect(s.map((l) => l.amount)).toEqual(['250.00', '200.00', '-30.00', '-6.50', '1.25']);
  });
  it('suggestions: same amount within 7 days, the reference raises the score; charges and interest are proposed; nothing is matched by suggesting', async () => {
    const sug = await t((tx) => rec.suggestions(tx, co, bankId, { limit: 50 }));
    const by = (i: number) => sug.items.find((x) => x.statementLineId === s[i]!.id)!;
    expect(by(0).candidates[0]).toMatchObject({ journalLineId: receipt, score: 145, reasons: ['same amount', '1 day(s) apart', 'reference in the bank narrative'] });
    expect(by(0).ambiguous).toBe(false);
    expect(by(1).candidates).toEqual([]);   // 200.00 is two lodgements: no single entry has the amount
    expect(by(1).proposal).toBeNull();
    expect(by(2).candidates[0]).toMatchObject({ journalLineId: transfer, score: 100 });
    expect(by(3).proposal).toEqual({ kind: 'CHARGE', accountId: acc['6800'] });
    expect(by(4).proposal).toEqual({ kind: 'INTEREST', accountId: acc['4900'] });
    expect(sql(`SELECT count(*) FROM bank_match WHERE bank_account_id='${bankId}'`)).toBe('0');
  });
  it('matches in full and in parts; the rest of a line stays visible; refusals name the rule', async () => {
    expect(await match(s[0]!.id, receipt, { fromSuggestion: true })).toMatchObject({ status: 'MATCHED', matched: '250.00', unmatched: '0.00', matches: [{ kind: 'SUGGESTION', amount: '250.00', journalDate: '2026-03-02' }] });
    expect(await match(s[1]!.id, lodge120)).toMatchObject({ status: 'PARTIAL', matched: '120.00', unmatched: '80.00' });
    await rejects(match(s[1]!.id, lodge80, { amount: '90.00' }), 'match_exceeds_outstanding');
    expect(await match(s[1]!.id, lodge80)).toMatchObject({ status: 'MATCHED', matches: [{ amount: '120.00' }, { amount: '80.00' }] });
    await rejects(match(s[0]!.id, cheque), 'direction_mismatch');
    await rejects(match(s[2]!.id, sql(`SELECT l.id FROM journal_line l JOIN journal j ON j.id=l.journal_id WHERE j.company_id='${co}' AND j.journal_date='2026-02-15' AND l.account_id='${acc['1200']}'`)), 'before_statement_opening');
    await rejects(match(s[2]!.id, sql(`SELECT l.id FROM journal_line l JOIN journal j ON j.id=l.journal_id WHERE j.company_id='${co}' AND j.journal_date='2026-03-02' AND l.account_id='${acc['4000']}'`)), 'not_on_bank_account');
    await rejects(match(s[2]!.id, transfer, { actor: me(['bank:reconcile']) }), 'permission_denied', 403);
    expect(await match(s[2]!.id, transfer)).toMatchObject({ status: 'MATCHED', amount: '-30.00' });
  });
  it('a bank charge and interest are posted from the statement on its date, through the cash rules, and matched in the same step', async () => {
    const charge = await t((tx) => rec.postFromStatement(tx, { organisationId: org, companyId: co, actor: me(), statementLineId: s[3]!.id, kind: 'CHARGE' }));
    expect(charge.cashTransaction).toMatchObject({ direction: 'PAYMENT', transactionDate: '2026-03-10', gross: '6.50' });
    expect(charge.line).toMatchObject({ status: 'MATCHED', matches: [{ kind: 'POSTED_FROM_STATEMENT', amount: '-6.50' }] });
    expect(sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit, ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${charge.cashTransaction.journalId}'`)).toBe('1200:0.0000/6.5000 ; 6800:6.5000/0.0000');
    const interest = await t((tx) => rec.postFromStatement(tx, { organisationId: org, companyId: co, actor: me(), statementLineId: s[4]!.id, kind: 'INTEREST' }));
    expect(interest.cashTransaction).toMatchObject({ direction: 'RECEIPT', gross: '1.25', lines: [{ accountId: acc['4900'] }] });
    await rejects(t((tx) => rec.postFromStatement(tx, { organisationId: org, companyId: co, actor: me(), statementLineId: s[4]!.id, kind: 'INTEREST' })), 'already_matched', 409);
  });
  it('unmatched items with ageing: only the unpresented cheque, 26 days old at the month end', async () => {
    const u = await t((tx) => rec.unmatched(tx, co, bankId, { asOf: '2026-03-31' }));
    expect(u.statement).toMatchObject({ count: 0, total: '0.00' });
    expect(u.ledger).toMatchObject({ count: 1, total: '-40.00', buckets: { '0-7': { count: 0 }, '8-30': { count: 1, total: '-40.00' }, '31-60': { count: 0 }, '61+': { count: 0 } } });
    expect(u.ledger.items[0]).toMatchObject({ id: cheque, reference: 'CHQ 101', unmatched: '-40.00', ageDays: 26 });
    // as at 9 March, the later charge, interest and their matches do not exist yet
    const early = await t((tx) => rec.unmatched(tx, co, bankId, { asOf: '2026-03-09' }));
    expect([early.statement.count, early.ledger.count]).toEqual([0, 1]);
  });
  it('the proof: 514.75 statement against 474.75 ledger plus the 40.00 cheque; sign-off needs the bank closing balance and records the figures once', async () => {
    const r = await t((tx) => rec.report(tx, co, bankId, { asOf: '2026-03-31' }));
    expect(r).toMatchObject({ statementBalance: '514.75', unmatchedStatement: '0.00', adjustedStatement: '514.75', ledgerBalance: '474.75', unmatchedLedger: '-40.00', adjustedLedger: '514.75',
      difference: '0.00', reconciled: true, opening: { date: '2026-02-28', statement: '100.00', ledger: '100.00' }, lastSignOff: null });
    await rejects(t((tx) => rec.signOff(tx, { organisationId: org, companyId: co, actor: me(), bankAccountId: bankId, asOf: '2026-03-31', bankClosingBalance: '520.00' })), 'statement_incomplete');
    const signed = await t((tx) => rec.signOff(tx, { organisationId: org, companyId: co, actor: me(), bankAccountId: bankId, asOf: '2026-03-31', bankClosingBalance: '514.75', notes: 'March reconciled' }));
    expect(signed.signOff).toMatchObject({ asAt: '2026-03-31' });
    expect((await t((tx) => rec.listSignOffs(tx, co, bankId))).items).toMatchObject([{ asAt: '2026-03-31', statementBalance: '514.75', ledgerBalance: '474.75', unmatchedLedger: '-40.00', unmatchedLedgerLines: 1 }]);
    await rejects(t((tx) => rec.signOff(tx, { organisationId: org, companyId: co, actor: me(), bankAccountId: bankId, asOf: '2026-03-15', bankClosingBalance: '520.00' })), 'reconciled_later', 409);
  });
  it('undoing a signed-off match needs a reason and is flagged; the line becomes unmatched again; an account with unmatched lines cannot close', async () => {
    const line = await t((tx) => rec.lineDetail(tx, co, s[0]!.id));
    const undone = await t((tx) => rec.unmatch(tx, { organisationId: org, companyId: co, actor: me(), matchId: line.matches[0]!.id, reason: 'Receipt belonged to another customer' }));
    expect(undone).toMatchObject({ status: 'UNMATCHED', matches: [{ status: 'UNMATCHED', afterSignOff: true, unmatchReason: 'Receipt belonged to another customer' }] });
    expect(sql(`SELECT metadata->>'afterSignOff' FROM audit_event WHERE entity_id='${line.matches[0]!.id}' AND action='bank_match.undone'`)).toBe('true');
    await rejects(t((tx) => rec.unmatch(tx, { organisationId: org, companyId: co, actor: me(), matchId: line.matches[0]!.id, reason: 'Undoing twice on purpose' })), 'match_undone', 409);
    const r = await t((tx) => rec.report(tx, co, bankId, { asOf: '2026-03-31' }));
    // the 250.00 is now unmatched on both sides: 514.75 - 250.00 = 474.75 - (250.00 - 40.00)
    expect([r.unmatchedStatement, r.unmatchedLedger, r.difference]).toEqual(['250.00', '210.00', '0.00']);
    await rejects(t((tx) => bank.close(tx, { organisationId: org, companyId: co, actor: me(), id: bankId, reason: 'Moving to another bank' })), 'bank_has_unmatched_lines', 409);
    await match(s[0]!.id, receipt);
  });
  it('dates more than 14 days apart need an override reason, recorded on the match', async () => {
    const late = bankLine((await money('RECEIPT', '2026-04-20', '9.99', '4100', 'LATE')).journalId);
    const [x] = await importCsv('Date,Description,Amount,Balance\n01/04/2026,DEPOSIT,9.99,524.74\n');
    await expect(match(x!.id, late)).rejects.toMatchObject({ code: 'override_reason_required', details: { days: 19 } });
    expect(await match(x!.id, late, { overrideReason: 'Cheque banked before it was recorded in the books' })).toMatchObject({ status: 'MATCHED', matches: [{ kind: 'MANUAL', overrideReason: 'Cheque banked before it was recorded in the books' }] });
  });
});
