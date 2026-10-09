import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService, PostingService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M1: the database defends the ledger even if application code is wrong or bypassed. Every statement here runs as the RUNTIME role (uk_app)
 * in a tenant context, written around the PostingService on purpose.
 */
let db: Database;
let org: string, org2: string, user: string, co: string, co2: string, periodOpen: string, periodClosed: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const ctx = () => ({ organisationId: org, userId: user });
/** Raw statements as uk_app; `flag` simulates (honestly: the flag is application-asserted) code that sets the posting switch itself. */
const raw = (q: string, o: { flag?: boolean; userless?: boolean; organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: o.userless ? undefined : user }, async (tx) => {
    if (o.flag) await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
    return tx.$executeRawUnsafe(q);
  });
const rawTx = (statements: string[], o: { flag?: boolean } = {}) =>
  db.tenant(ctx(), async (tx) => {
    if (o.flag) await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
    for (const s of statements) await tx.$executeRawUnsafe(s);
  });
const jid = () => uuidv7();
const hdr = (id: string, o: { n?: number; date?: string; period?: string; total?: string; lines?: number; source?: string; key?: string; reverses?: string; currency?: string; company?: string } = {}) =>
  `INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
   VALUES ('${id}','${org}','${o.company ?? co}','${o.period ?? periodOpen}',${o.n ?? Math.floor(1_000_000 + Math.random() * 8_000_000)},'${o.date ?? '2026-03-01'}','${o.source ?? 'MANUAL'}','db test','${o.currency ?? 'GBP'}',${o.total ?? '10'},${o.lines ?? 2},'USER','${user}','${o.key ?? `k-${uuidv7()}`}','h',${o.reverses ? `'${o.reverses}'` : 'NULL'})`;
const line = (jidv: string, no: number, account: string, debit: string, credit: string, company = co) =>
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit) VALUES ('${org}','${company}','${jidv}',${no},'${account}',${debit},${credit})`;
const goodJournal = (id: string, o: Parameters<typeof hdr>[1] = {}) => [hdr(id, o), line(id, 1, acc['6100']!, '10', '0'), line(id, 2, acc['4000']!, '0', '10')];

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('ldb-${org}@t.test','L') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Ledger DB A'),('${org2}','BUSINESS','Ledger DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  co2 = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org2}','B') RETURNING id`).split('\n')[0]!;
  periodOpen = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31') RETURNING id`).split('\n')[0]!;
  periodClosed = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date, status) VALUES ('${org}','${co}','2025-01-01','2025-12-31','CLOSED') RETURNING id`).split('\n')[0]!;
  const chart = await db.tenant(ctx(), (tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }));
  for (const a of chart.items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('journals can only be posted through the PostingService', () => {
  it('a direct insert is refused without the posting switch', async () => {
    await expect(rawTx(goodJournal(jid()))).rejects.toThrow(/only be posted through the PostingService/);
    await expect(raw(line(jid(), 1, acc['6100']!, '1', '0'))).rejects.toThrow(/only be posted through the PostingService|foreign key/);
  });
  it('even with the switch, the database enforces period, date, currency and company', async () => {
    await expect(rawTx(goodJournal(jid(), { period: periodClosed, date: '2025-06-01' }), { flag: true })).rejects.toThrow(/posting requires an OPEN period/);
    await expect(rawTx(goodJournal(jid(), { date: '2025-06-01' }), { flag: true })).rejects.toThrow(/outside its accounting period/);
    await expect(rawTx(goodJournal(jid(), { currency: 'EUR' }), { flag: true })).rejects.toThrow(/base currency/);
    await expect(rawTx(goodJournal(jid(), { company: co2 }), { flag: true })).rejects.toThrow();
  });
  it('lines cannot be added to a journal after the transaction that posted it', async () => {
    const id = jid();
    await rawTx(goodJournal(id), { flag: true });
    expect(sql(`SELECT count(*) FROM journal_line WHERE journal_id='${id}'`)).toBe('2');
    await expect(rawTx([line(id, 3, acc['6100']!, '1', '0')], { flag: true })).rejects.toThrow(/only be added in the transaction that posts their journal/);
  });
});

describe('integrity is re-checked at commit', () => {
  it('an unbalanced journal cannot commit', async () => {
    await expect(rawTx([hdr(jid(), { total: '10' }), ...[]], { flag: true })).rejects.toThrow(/header does not match its lines|not balanced/);
    const id = jid();
    await expect(rawTx([hdr(id), line(id, 1, acc['6100']!, '10', '0'), line(id, 2, acc['4000']!, '0', '9')], { flag: true })).rejects.toThrow(/not balanced/);
  });
  it('the header must agree with its lines (total, count, contiguous numbering)', async () => {
    let id = jid();
    await expect(rawTx([hdr(id, { total: '11' }), line(id, 1, acc['6100']!, '10', '0'), line(id, 2, acc['4000']!, '0', '10')], { flag: true })).rejects.toThrow(/header does not match/);
    id = jid();
    await expect(rawTx([hdr(id, { lines: 3 }), line(id, 1, acc['6100']!, '10', '0'), line(id, 2, acc['4000']!, '0', '10')], { flag: true })).rejects.toThrow(/header does not match/);
    id = jid();
    await expect(rawTx([hdr(id), line(id, 1, acc['6100']!, '10', '0'), line(id, 3, acc['4000']!, '0', '10')], { flag: true })).rejects.toThrow(/header does not match/);
  });
  it('line amounts: exactly one side, non-negative, at the currency\'s decimals, on an active account of the same company', async () => {
    const id = jid();
    const bad = async (l: string[], re: RegExp) => { const j = jid(); await expect(rawTx([hdr(j), ...l.map((x) => x.replace('{J}', j))], { flag: true })).rejects.toThrow(re); };
    void id;
    await bad([line('{J}', 1, acc['6100']!, '0', '0'), line('{J}', 2, acc['4000']!, '0', '10')], /journal_line_amount_ck/);
    await bad([line('{J}', 1, acc['6100']!, '5', '5'), line('{J}', 2, acc['4000']!, '0', '10')], /journal_line_amount_ck/);
    await bad([line('{J}', 1, acc['6100']!, '-1', '0'), line('{J}', 2, acc['4000']!, '0', '10')], /journal_line_amount_ck/);
    await bad([line('{J}', 1, acc['6100']!, '10.001', '0'), line('{J}', 2, acc['4000']!, '0', '10.001')], /decimal places/);
    await bad([line('{J}', 1, uuidv7(), '10', '0'), line('{J}', 2, acc['4000']!, '0', '10')], /foreign key|not found in this company/);
  });
  it('a reversal must mirror its original per account and carry the same total; a reversal cannot be reversed; one reversal per original', async () => {
    const orig = jid();
    await rawTx(goodJournal(orig), { flag: true });
    const rev = jid();
    // not a mirror (same sides)
    await expect(rawTx([hdr(rev, { source: 'REVERSAL', reverses: orig }), line(rev, 1, acc['6100']!, '10', '0'), line(rev, 2, acc['4000']!, '0', '10')], { flag: true })).rejects.toThrow(/must mirror/);
    // wrong total
    await expect(rawTx([hdr(rev, { source: 'REVERSAL', reverses: orig, total: '5' }), line(rev, 1, acc['6100']!, '0', '5'), line(rev, 2, acc['4000']!, '5', '0')], { flag: true })).rejects.toThrow(/same total/);
    // correct mirror posts once
    await rawTx([hdr(rev, { source: 'REVERSAL', reverses: orig }), line(rev, 1, acc['6100']!, '0', '10'), line(rev, 2, acc['4000']!, '10', '0')], { flag: true });
    const again = jid();
    await expect(rawTx([hdr(again, { source: 'REVERSAL', reverses: orig }), line(again, 1, acc['6100']!, '0', '10'), line(again, 2, acc['4000']!, '10', '0')], { flag: true })).rejects.toThrow(/Unique constraint failed|duplicate key/);
    const rr = jid();
    await expect(rawTx([hdr(rr, { source: 'REVERSAL', reverses: rev }), line(rr, 1, acc['6100']!, '10', '0'), line(rr, 2, acc['4000']!, '0', '10')], { flag: true })).rejects.toThrow(/cannot itself be reversed/);
  });
  it('the check constraints on the header hold: reversal source and link go together; idempotency keys and numbers are unique per company', async () => {
    const id = jid();
    await expect(rawTx([hdr(id, { source: 'REVERSAL' })], { flag: true })).rejects.toThrow(/journal_reversal_ck/);
    const key = `dup-${uuidv7()}`;
    await rawTx(goodJournal(jid(), { key }), { flag: true });
    await expect(rawTx(goodJournal(jid(), { key }), { flag: true })).rejects.toThrow(/Unique constraint failed|duplicate key/);
    const n = 9_100_000 + Math.floor(Math.random() * 1000);
    await rawTx(goodJournal(jid(), { n }), { flag: true });
    await expect(rawTx(goodJournal(jid(), { n }), { flag: true })).rejects.toThrow(/Unique constraint failed|duplicate key/);
  });
});

describe('posted journals are immutable (privileges first, triggers second)', () => {
  let id: string;
  beforeAll(async () => { id = jid(); await rawTx(goodJournal(id), { flag: true }); });
  it('the runtime role holds no UPDATE, DELETE or TRUNCATE on journals or lines', async () => {
    for (const t of ['journal', 'journal_line']) for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) expect(sql(`SELECT has_table_privilege('uk_app','${t}','${p}')`), `${t} ${p}`).toBe('f');
    await expect(raw(`UPDATE journal SET description='tampered' WHERE id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(raw(`UPDATE journal_line SET debit=1 WHERE journal_id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(raw(`DELETE FROM journal WHERE id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(raw(`DELETE FROM journal_line WHERE journal_id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(raw(`TRUNCATE journal_line`)).rejects.toThrow(/permission denied/);
  });
  it('even the table owner cannot change a journal: the trigger refuses', () => {
    expect(() => sql(`UPDATE journal SET description='tampered' WHERE id='${id}'`)).toThrow(/not permitted \(append-only\)/);
    expect(() => sql(`DELETE FROM journal_line WHERE journal_id='${id}'`)).toThrow(/not permitted \(append-only\)/);
    expect(() => sql(`TRUNCATE journal, journal_line, journal_request`)).toThrow(/not permitted \(append-only\)/);
  });
  it('accounts are never deleted by the runtime role', async () => {
    await expect(raw(`DELETE FROM account WHERE id='${acc['8000']}'`)).rejects.toThrow(/permission denied/);
    await expect(raw(`DELETE FROM ledger_sequence`)).rejects.toThrow(/permission denied/);
  });
});

describe('accounts', () => {
  it('code, type and control flags freeze once an account has postings; deactivation cannot precede the last posting; system accounts stay active', async () => {
    await rawTx(goodJournal(jid(), { date: '2026-06-15' }), { flag: true });
    await expect(raw(`UPDATE account SET code='XXXX' WHERE id='${acc['6100']}'`)).rejects.toThrow(/cannot change once the account has postings/);
    await expect(raw(`UPDATE account SET type='ASSET' WHERE id='${acc['6100']}'`)).rejects.toThrow(/cannot change once the account has postings/);
    await expect(raw(`UPDATE account SET is_control=true, control_kind='BANK' WHERE id='${acc['6100']}'`)).rejects.toThrow(/cannot change once the account has postings/);
    await expect(raw(`UPDATE account SET active_to='2026-01-01' WHERE id='${acc['6100']}'`)).rejects.toThrow(/cannot be deactivated before its last posting/);
    await expect(raw(`UPDATE account SET active_to='2026-12-31' WHERE id='${acc['1100']}'`)).rejects.toThrow(/account_system_active_ck/);
    await expect(raw(`UPDATE account SET company_id='${co2}' WHERE id='${acc['6100']}'`)).rejects.toThrow();
    // an unused account can still be edited freely, and a used one can be renamed
    await raw(`UPDATE account SET name='Rent and rates (renamed)' WHERE id='${acc['6100']}'`);
    await raw(`UPDATE account SET code='8001' WHERE id='${acc['8000']}'`);
  });
  it('control accounts need a control kind, and codes are unique per company', async () => {
    await expect(raw(`INSERT INTO account(organisation_id, company_id, code, name, type, subtype, is_control, reporting_mapping) VALUES ('${org}','${co}','CTL1','x','ASSET','CURRENT_ASSET_OTHER',true,'BS.CURRENT_ASSETS.DEBTORS')`)).rejects.toThrow(/account_control_ck/);
    await expect(raw(`INSERT INTO account(organisation_id, company_id, code, name, type, subtype, reporting_mapping) VALUES ('${org}','${co}','4000','dup','INCOME','SALES','PL.TURNOVER')`)).rejects.toThrow(/Unique constraint failed|duplicate key/);
  });
});

describe('accounting period states are enforced by the database', () => {
  it('only OPEN<->CLOSED->LOCKED->CLOSED, and only by a signed-in user', async () => {
    const p = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2020-01-01','2020-12-31') RETURNING id`).split('\n')[0]!;
    await expect(raw(`UPDATE accounting_period SET status='LOCKED' WHERE id='${p}'`)).rejects.toThrow(/cannot go from OPEN to LOCKED/);
    await expect(raw(`UPDATE accounting_period SET status='CLOSED' WHERE id='${p}'`, { userless: true })).rejects.toThrow(/signed-in user/);
    await raw(`UPDATE accounting_period SET status='CLOSED' WHERE id='${p}'`);
    await raw(`UPDATE accounting_period SET status='LOCKED' WHERE id='${p}'`);
    await expect(raw(`UPDATE accounting_period SET status='OPEN' WHERE id='${p}'`)).rejects.toThrow(/cannot go from LOCKED to OPEN/);
    await raw(`UPDATE accounting_period SET status='CLOSED' WHERE id='${p}'`);
  });
});

describe('closing a period cannot race a posting', () => {
  it('a concurrent close waits for the in-flight posting (row lock), so no journal lands in a period closed a moment earlier', async () => {
    const p = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2019-01-01','2019-12-31') RETURNING id`).split('\n')[0]!;
    const id = jid();
    const inflight = db.tenant(ctx(), async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
      for (const q of goodJournal(id, { period: p, date: '2019-03-01' })) await tx.$executeRawUnsafe(q);
      await new Promise((r) => setTimeout(r, 900));
    });
    await new Promise((r) => setTimeout(r, 250));
    const t0 = Date.now();
    const close = raw(`UPDATE accounting_period SET status='CLOSED' WHERE id='${p}'`).then(() => Date.now() - t0);
    await inflight;
    const waited = await close;
    expect(waited).toBeGreaterThanOrEqual(400);                          // the close queued behind the posting
    expect(sql(`SELECT status FROM accounting_period WHERE id='${p}'`)).toBe('CLOSED');
    expect(sql(`SELECT count(*) FROM journal WHERE id='${id}' AND period_id='${p}'`)).toBe('1');
    await expect(rawTx(goodJournal(jid(), { period: p, date: '2019-03-02' }), { flag: true })).rejects.toThrow(/posting requires an OPEN period/);
  });
});

describe('tenant isolation of the ledger', () => {
  it('another organisation sees none of these rows and cannot write into this company', async () => {
    for (const t of ['account', 'journal', 'journal_line', 'ledger_sequence']) {
      expect(await db.tenant({ organisationId: org2, userId: user }, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM ${t}`)), t).toEqual([{ n: 0n }]);
    }
    await expect(raw(`INSERT INTO account(organisation_id, company_id, code, name, type, subtype, reporting_mapping) VALUES ('${org}','${co}','ZZ99','x','ASSET','CURRENT_ASSET_OTHER','BS.CURRENT_ASSETS.DEBTORS')`, { organisationId: org2 })).rejects.toThrow();
    // without any tenant context nothing is visible
    expect(await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM journal`)).toEqual([{ n: 0n }]);
  });
  it('the PostingService honours the tenant boundary: a company of another organisation is not found', async () => {
    await expect(db.tenant(ctx(), (tx) => new PostingService().post(tx, { organisationId: org, companyId: co2, journalDate: '2026-03-01', sourceType: 'MANUAL', description: 'x', idempotencyKey: 'x-1',
      actor: { kind: 'USER', userId: user, can: async () => true }, lines: [{ accountId: acc['6100']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] }))).rejects.toMatchObject({ status: 404 });
  });
});
