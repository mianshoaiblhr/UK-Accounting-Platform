import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M3: the database defends the foreign-currency rules even if application code is wrong or bypassed. Statements run as the RUNTIME role (uk_app)
 * in a tenant context; `flag` simulates code that sets the posting switch itself (the switch is application-asserted - the other guards are not).
 */
let db: Database;
let org: string, org2: string, user: string, user2: string, co: string, period: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const ctx = () => ({ organisationId: org, userId: user });
const rawTx = (statements: string[], o: { flag?: boolean; organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => {
    if (o.flag) await t.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
    for (const s of statements) await t.$executeRawUnsafe(s);
  });
const rate = (id: string, o: { from?: string; to?: string; kind?: string; vf?: string; vt?: string; rate?: string; pub?: string; series?: string | null; kindSrc?: string; ref?: string | null; org?: string } = {}) =>
  `INSERT INTO exchange_rate(id, organisation_id, from_currency, to_currency, kind, valid_from, valid_to, rate, source_kind, publisher, series, source_ref, retrieved_at, import_batch_id, entered_by_user_id)
   VALUES ('${id}','${o.org ?? org}','${o.from ?? 'USD'}','${o.to ?? 'GBP'}','${o.kind ?? 'DAILY'}','${o.vf ?? '2026-03-02'}','${o.vt ?? o.vf ?? '2026-03-02'}',${o.rate ?? '1.25'},'${o.kindSrc ?? 'MANUAL'}','${o.pub ?? 'MANUAL'}',${o.series === undefined || o.series === null ? 'NULL' : `'${o.series}'`},
     ${o.ref === null ? 'NULL' : `'${o.ref ?? 'bank advice'}'`},${o.kindSrc === 'IMPORT' ? 'now()' : 'NULL'},${o.kindSrc === 'IMPORT' ? `'${uuidv7()}'` : 'NULL'},'${user}')`;
const hdr = (id: string, o: { total?: string; date?: string } = {}) =>
  `INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash)
   VALUES ('${id}','${org}','${co}','${period}',${Math.floor(1_000_000 + Math.random() * 8_000_000)},'${o.date ?? '2026-03-02'}','MANUAL','fx db test','GBP',${o.total ?? '125'},2,'USER','${user}','k-${uuidv7()}','h')`;
interface L { account: string; debit?: string; credit?: string; od?: string; oc?: string; ccy?: string | null; rate?: string; rateId?: string | null; adjusts?: string }
const line = (j: string, no: number, l: L) =>
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit, original_currency, original_debit, original_credit, rate, exchange_rate_id, adjusts_currency)
   VALUES ('${org}','${co}','${j}',${no},'${acc[l.account]}',${l.debit ?? 0},${l.credit ?? 0},${l.ccy ? `'${l.ccy}'` : 'NULL'},${l.od ?? 'NULL'},${l.oc ?? 'NULL'},${l.rate ?? 'NULL'},${l.rateId ? `'${l.rateId}'` : 'NULL'},${l.adjusts ? `'${l.adjusts}'` : 'NULL'})`;
const fxJournal = (rateId: string, o: { debit?: L; credit?: L; total?: string; date?: string } = {}) => {
  const id = uuidv7();
  return [hdr(id, { total: o.total, date: o.date }),
    line(id, 1, { account: '1200', debit: '125', od: '100', oc: '0', ccy: 'USD', rate: '1.25', rateId, ...o.debit }),
    line(id, 2, { account: '4000', credit: '125', od: '0', oc: '100', ccy: 'USD', rate: '1.25', rateId, ...o.credit })];
};

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('fx1-${org}@t.test','F') RETURNING id`).split('\n')[0]!;
  user2 = sql(`INSERT INTO "user"(email, display_name) VALUES ('fx2-${org}@t.test','G') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','FX DB A'),('${org2}','BUSINESS','FX DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO company(organisation_id, name) VALUES ('${org2}','B')`);
  period = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31') RETURNING id`).split('\n')[0]!;
  const chart = await db.tenant(ctx(), (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: user }));
  for (const a of chart.items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('journal lines carry original-currency values that the database proves', () => {
  let rid: string;
  beforeAll(async () => { rid = uuidv7(); await rawTx([rate(rid)]); });

  it('a correct foreign-currency journal commits, with the original values and the rate stored', async () => {
    const j = fxJournal(rid);
    await rawTx(j, { flag: true });
    const id = /VALUES \('([^']+)'/.exec(j[0]!)![1]!;
    expect(sql(`SELECT original_currency||'|'||original_debit||'|'||rate||'|'||debit FROM journal_line WHERE journal_id='${id}' AND line_no=1`)).toBe('USD|100.0000|1.25000000|125.0000');
  });
  it('the functional amount must be exactly round(original x rate): too high, too low and unrounded are all refused', async () => {
    for (const debit of ['126', '124.99', '125.001']) {
      await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit, od: '100', oc: '0', ccy: 'USD', rate: '1.25', rateId: rid }, total: debit }), { flag: true })).rejects.toThrow(/not the original amount converted|more decimal places|not balanced/);
    }
  });
  it('rounding is half-up at the boundary: 1.00 x 0.125 = 0.13 commits, 0.12 is refused', async () => {
    const r2 = uuidv7(); await rawTx([rate(r2, { vf: '2026-03-03', rate: '0.125' })]);
    const mk = (f: string) => { const id = uuidv7(); return [hdr(id, { total: f, date: '2026-03-03' }), line(id, 1, { account: '1200', debit: f, od: '1', oc: '0', ccy: 'USD', rate: '0.125', rateId: r2 }), line(id, 2, { account: '4000', credit: f, od: '0', oc: '1', ccy: 'USD', rate: '0.125', rateId: r2 })]; };
    await rawTx(mk('0.13'), { flag: true });
    await expect(rawTx(mk('0.12'), { flag: true })).rejects.toThrow(/not the original amount converted/);
  });
  it('the original amount sits on the same side as the functional amount, and is all-or-none with the rate', async () => {
    await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit: '125', od: '0', oc: '100', ccy: 'USD', rate: '1.25', rateId: rid } }), { flag: true })).rejects.toThrow(/not the original amount converted|original_amount_ck/);   // the trigger (before the CHECK) already proves it
    await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit: '125', od: '100', oc: '0', ccy: 'USD', rate: undefined as unknown as string, rateId: rid } }), { flag: true })).rejects.toThrow(/all_or_none|violates check/);
    await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit: '125', od: '100', oc: '0', ccy: 'USD', rate: '1.25', rateId: null } }), { flag: true })).rejects.toThrow(/all_or_none|violates check|not the stored exchange rate/);
  });
  it('the line rate must be the stored rate for that pair: a different number, another pair, a missing id are refused', async () => {
    await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit: '130', od: '100', oc: '0', ccy: 'USD', rate: '1.30', rateId: rid }, total: '130' }), { flag: true })).rejects.toThrow(/not the stored exchange rate/);
    const eur = uuidv7(); await rawTx([rate(eur, { from: 'EUR', rate: '0.85' })]);
    await expect(rawTx(fxJournal(eur), { flag: true })).rejects.toThrow(/not the stored exchange rate/);
    await expect(rawTx(fxJournal(uuidv7()), { flag: true })).rejects.toThrow(/oreign key|not the stored exchange rate/i);
  });
  it('a rate dated after the journal cannot be used', async () => {
    const future = uuidv7(); await rawTx([rate(future, { vf: '2026-06-01', rate: '1.25' })]);
    await expect(rawTx(fxJournal(future, { date: '2026-03-02' }), { flag: true })).rejects.toThrow(/dated after the journal/);
  });
  it('the original currency must differ from the functional one and respect its own minor units', async () => {
    const same = uuidv7(); await rawTx([rate(same, { from: 'JPY', to: 'GBP', vf: '2026-03-04', rate: '0.0053' })]);
    const jpy = (od: string) => { const id = uuidv7(); return [hdr(id, { total: '0.53', date: '2026-03-04' }), line(id, 1, { account: '1200', debit: '0.53', od, oc: '0', ccy: 'JPY', rate: '0.0053', rateId: same }), line(id, 2, { account: '4000', credit: '0.53', od: '0', oc: od, ccy: 'JPY', rate: '0.0053', rateId: same })]; };
    await expect(rawTx(jpy('100.5'), { flag: true })).rejects.toThrow(/more decimal places than JPY allows/);
    await rawTx(jpy('100'), { flag: true });                                   // 100 JPY x 0.0053 = 0.53 and JPY has no minor units
    await expect(rawTx(fxJournal(rid, { debit: { account: '1200', debit: '100', od: '100', oc: '0', ccy: 'GBP', rate: '1', rateId: rid }, total: '100' }), { flag: true })).rejects.toThrow();
  });
  it('an adjustment line (revaluation) names a foreign currency, never the functional one, and never carries original values', async () => {
    const adj = (ccy: string, withOriginal = false) => { const id = uuidv7(); return [hdr(id, { total: '5' }), line(id, 1, { account: '1200', debit: '5', adjusts: ccy, ...(withOriginal ? { od: '4', oc: '0', ccy: 'USD', rate: '1.25', rateId: rid } : {}) }), line(id, 2, { account: '8000', credit: '5' })]; };
    await rawTx(adj('USD'), { flag: true });
    await expect(rawTx(adj('GBP'), { flag: true })).rejects.toThrow(/names a foreign currency/);
    await expect(rawTx(adj('USD', true), { flag: true })).rejects.toThrow(/journal_line_adjusts_ck|violates check/);
  });
  it('original values are immutable like the rest of the ledger', async () => {
    expect(() => sql(`UPDATE journal_line SET original_debit = 1 WHERE original_currency IS NOT NULL`)).toThrow(/append-only/);
  });
});

describe('exchange rates are immutable reference data', () => {
  it('shape checks: DAILY is one date, PERIOD a range, MANUAL needs a source, IMPORT needs provenance, from differs from to, rate positive', async () => {
    await expect(rawTx([rate(uuidv7(), { vf: '2026-04-01', vt: '2026-04-05' })])).rejects.toThrow(/kind_ck|violates check/);
    await expect(rawTx([rate(uuidv7(), { kind: 'PERIOD', vf: '2026-04-05', vt: '2026-04-01' })])).rejects.toThrow(/kind_ck|violates check/);
    await rawTx([rate(uuidv7(), { kind: 'PERIOD', vf: '2026-05-01', vt: '2026-05-31', pub: 'Series A', series: 's1', kindSrc: 'IMPORT', ref: null })]);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-04-02', ref: null })])).rejects.toThrow(/manual_ck|violates check/);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-04-02', ref: 'ab' })])).rejects.toThrow(/manual_ck|violates check/);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-04-02', from: 'GBP' })])).rejects.toThrow(/pair_ck|violates check/);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-04-02', rate: '0' })])).rejects.toThrow(/rate_ck|violates check/);
  });
  it('only one current rate per currency pair, series and dates; a superseded one frees the slot', async () => {
    const a = uuidv7(), b = uuidv7();
    await rawTx([rate(a, { vf: '2026-07-01', series: null })]);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-07-01' })])).rejects.toThrow(/unique|current_uq/i);
    // supersede in the documented order: mark the old row first (reference is checked at commit), insert the new one second
    await rawTx([`UPDATE exchange_rate SET superseded_by_id='${b}' WHERE id='${a}'`, rate(b, { vf: '2026-07-01', rate: '1.26' })]);
    expect(sql(`SELECT rate FROM exchange_rate WHERE id='${b}'`)).toBe('1.26000000');
    await expect(rawTx([`UPDATE exchange_rate SET superseded_by_id='${uuidv7()}' WHERE id='${a}'`])).rejects.toThrow(/superseded once/);
    // a dangling supersession is caught at commit
    const c = uuidv7();
    await expect(rawTx([rate(c, { vf: '2026-08-01' }), `UPDATE exchange_rate SET superseded_by_id='${uuidv7()}' WHERE id='${c}'`])).rejects.toThrow(/oreign key constraint/i);
  });
  it('the number, dates, currencies and provenance never change; verification happens once and is not withdrawn', async () => {
    const r = uuidv7(); await rawTx([rate(r, { vf: '2026-09-01' })]);
    for (const set of ['rate = 2', `valid_from = '2026-09-02', valid_to = '2026-09-02'`, `from_currency = 'EUR'`, `source_ref = 'edited'`, `publisher = 'X'`, `entered_by_user_id = '${user2}'`]) {
      await expect(rawTx([`UPDATE exchange_rate SET ${set} WHERE id='${r}'`])).rejects.toThrow(/immutable/);
    }
    await expect(rawTx([`UPDATE exchange_rate SET verification_status='VERIFIED' WHERE id='${r}'`])).rejects.toThrow(/verification_ck|violates check/);   // needs verifier and date
    await rawTx([`UPDATE exchange_rate SET verification_status='VERIFIED', verified_by_user_id='${user2}', verified_at=now() WHERE id='${r}'`]);
    await expect(rawTx([`UPDATE exchange_rate SET verification_status='UNVERIFIED', verified_by_user_id=NULL, verified_at=NULL WHERE id='${r}'`])).rejects.toThrow(/not withdrawn|verified once/);
    await expect(rawTx([`UPDATE exchange_rate SET verified_by_user_id='${user}' WHERE id='${r}'`])).rejects.toThrow(/cannot be edited|verified once/);
  });
  it('nothing deletes or truncates rates: the runtime role has no privilege, the owner is stopped by a trigger', async () => {
    const r = uuidv7(); await rawTx([rate(r, { vf: '2026-10-01' })]);
    await expect(rawTx([`DELETE FROM exchange_rate WHERE id='${r}'`])).rejects.toThrow(/permission denied/);
    expect(() => sql(`DELETE FROM exchange_rate WHERE id='${r}'`)).toThrow(/append-only/);
    expect(() => sql(`TRUNCATE exchange_rate, fx_revaluation_run, journal, journal_line, journal_request, sales_allocation, sales_receipt, sales_document_line, sales_document, purchase_allocation, purchase_payment, purchase_document_line, purchase_document`)).toThrow(/append-only/);
  });
  it('tenant isolation: another organisation neither sees nor creates rates for this one', async () => {
    const r = uuidv7(); await rawTx([rate(r, { vf: '2026-11-01' })]);
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.exchangeRate.count({ where: { id: r } }))).toBe(0);
    await expect(rawTx([rate(uuidv7(), { vf: '2026-11-02' })], { organisationId: org2 })).rejects.toThrow();
  });
});

describe('functional currency, FX settings and revaluation runs', () => {
  it('the functional currency can change before the first journal and never after', async () => {
    const fresh = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Fresh') RETURNING id`).split('\n')[0]!;
    sql(`UPDATE company SET base_currency='EUR' WHERE id='${fresh}'`);
    expect(sql(`SELECT base_currency FROM company WHERE id='${fresh}'`)).toBe('EUR');
    expect(() => sql(`UPDATE company SET base_currency='USD' WHERE id='${co}'`)).toThrow(/cannot change once the company has journals/);
    expect(sql(`SELECT base_currency FROM company WHERE id='${co}'`)).toBe('GBP');
    sql(`UPDATE company SET name='Renamed A' WHERE id='${co}'`);                // other columns are unaffected
  });
  it('FX accounts must be three different accounts of the same company', async () => {
    const s = (cols: string, vals: string) => `INSERT INTO company_fx_setting(organisation_id, company_id, ${cols}) VALUES ('${org}','${co}', ${vals})`;
    await expect(rawTx([s('rounding_account_id, realised_account_id', `'${acc['8000']}', '${acc['8000']}'`)])).rejects.toThrow(/distinct_ck|violates check/);
    const other = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Other') RETURNING id`).split('\n')[0]!;
    const foreignAcc = sql(`INSERT INTO account(organisation_id, company_id, code, name, type, subtype, normal_balance_unused, reporting_mapping) VALUES ('${org}','${other}','8000','x','EXPENSE','OTHER_EXPENSE','x','PL.OTHER_EXPENSES') RETURNING id`.replace(', normal_balance_unused', '').replace(",'x','PL", ",'PL")).split('\n')[0]!;
    await expect(rawTx([s('rounding_account_id', `'${foreignAcc}'`)])).rejects.toThrow(/oreign key/i);
    await rawTx([s('rounding_account_id, realised_account_id, unrealised_account_id', `'${acc['8000']}', '${acc['7000']}', '${acc['6900']}'`)]);
    await expect(rawTx([`DELETE FROM company_fx_setting WHERE company_id='${co}'`])).rejects.toThrow(/permission denied/);
  });
  it('a revaluation run is immutable except for its single move from POSTED to REVERSED', async () => {
    const j = uuidv7(), rj = uuidv7(), run = uuidv7();
    const adj = (id: string, d: string) => [hdr(id, { total: '5', date: d }), line(id, 1, { account: '1200', debit: '5', adjusts: 'USD' }), line(id, 2, { account: '8000', credit: '5' })];
    await rawTx([...adj(j, '2026-03-31'), ...adj(rj, '2026-04-01')], { flag: true });
    await rawTx([`INSERT INTO fx_revaluation_run(id, organisation_id, company_id, period_id, as_at_date, revaluation_journal_id, reversal_due_date, net_adjustment, rates, run_by_user_id) VALUES ('${run}','${org}','${co}','${period}','2026-03-31','${j}','2026-04-01',5,'{}'::jsonb,'${user}')`]);
    await expect(rawTx([`UPDATE fx_revaluation_run SET net_adjustment = 6 WHERE id='${run}'`])).rejects.toThrow(/immutable/);
    await expect(rawTx([`UPDATE fx_revaluation_run SET status='REVERSED' WHERE id='${run}'`])).rejects.toThrow(/reversal_ck|violates check/);
    await rawTx([`UPDATE fx_revaluation_run SET status='REVERSED', reversal_journal_id='${rj}', reversed_at=now() WHERE id='${run}'`]);
    await expect(rawTx([`UPDATE fx_revaluation_run SET status='POSTED', reversal_journal_id=NULL, reversed_at=NULL WHERE id='${run}'`])).rejects.toThrow(/moves once/);
    await expect(rawTx([`DELETE FROM fx_revaluation_run WHERE id='${run}'`])).rejects.toThrow(/permission denied/);
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.fxRevaluationRun.count())).toBe(0);
  });
});
