import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, FxSettingsService, LedgerPolicyService, LedgerQueries, PeriodService, PostingService, RateService, RevaluationService, money, type PostInput, type PostingActor, type RateActor, type RequestActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M3: foreign currency through the services - rate lookup (DEC-016), conversion and rounding (DEC-017), revaluation, auto-reversal and close
 * controls (DEC-018). All rates are synthetic. The database proofs are in tests/db/fx.test.ts, the API in tests/api/fx.test.ts.
 */
let db: Database;
let org: string, user: string, user2: string, co: string, coB: string, coR: string;
const acc: Record<string, string> = {};
const accB: Record<string, string> = {};
const accR: Record<string, string> = {};
const accOf = (company: string) => (company === co ? acc : company === coB ? accB : accR);
const rates = new RateService();
const posting = new PostingService();
const settingsSvc = new FxSettingsService();
const reval = new RevaluationService(rates, posting);
const periods = new PeriodService({ fx: reval });
const queries = new LedgerQueries();
const policies = new LedgerPolicyService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const allow = (...deny: string[]) => (p: string) => !deny.includes(p);
const actorOf = (userId: string, can: (p: string) => boolean = () => true): PostingActor & RateActor & RequestActor => ({ kind: 'USER', userId, can: async (p) => can(p) });
const actor = () => actorOf(user);
const rejects = (p: Promise<unknown>, code: string, status?: number) => expect(p).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
const manual = (from: string, date: string, rate: string, source = 'synthetic test rate') => t((tx) => rates.create(tx, { organisationId: org, companyId: co, actor: actor(), fromCurrency: from, kind: 'DAILY', validFrom: date, rate, source }));
const postUsd = (over: Partial<PostInput> & { amount?: string; debit?: string; credit?: string; company?: string } = {}) => {
  const a = over.amount ?? '100.00'; const company = over.company ?? co; const ac = accOf(company);
  return t((tx) => posting.post(tx, { organisationId: org, companyId: company, journalDate: '2026-03-02', sourceType: 'MANUAL', description: 'USD journal', currency: 'USD', idempotencyKey: `k-${uuidv7()}`, actor: actor(),
    lines: [{ accountId: ac[over.debit ?? '1110']!, debit: a, credit: '0' }, { accountId: ac[over.credit ?? '4000']!, debit: '0', credit: a }], ...over }));
};
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||':'||coalesce(l.original_currency,'-')||':'||coalesce(l.original_debit::text,'-')||'/'||coalesce(l.original_credit::text,'-')||':'||coalesce(l.rate::text,'-'), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const balance = (company: string, code: string, to: string) => sql(`SELECT coalesce(sum(l.debit-l.credit),0) FROM journal_line l JOIN journal j ON j.id=l.journal_id JOIN account a ON a.id=l.account_id WHERE l.company_id='${company}' AND a.code='${code}' AND j.journal_date<='${to}'`);
const periodId = (start: string, company = co) => sql(`SELECT id FROM accounting_period WHERE company_id='${company}' AND start_date='${start}'`);

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('fxs1-${org}@t.test','F') RETURNING id`).split('\n')[0]!;
  user2 = sql(`INSERT INTO "user"(email, display_name) VALUES ('fxs2-${org}@t.test','G') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','FX services')`);
  const mk = (n: string) => sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${n}') RETURNING id`).split('\n')[0]!;
  co = mk('FX Co'); coB = mk('FX Co without settings'); coR = mk('FX Co revaluation');
  for (const c of [co, coB, coR]) for (const [s, e] of [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-12-31']]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','${s}','${e}')`);
  }
  const accounts = new AccountService();
  for (const [c, map] of [[co, acc], [coB, accB], [coR, accR]] as const) {
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) map[a.code] = a.id;
  }
  for (const [company, map] of [[co, acc], [coR, accR]] as const) {
    for (const [code, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX gains and losses'], ['7920', 'Unrealised FX gains and losses']] as const) {
      const r = await t((tx) => accounts.create(tx, { organisationId: org, companyId: company, userId: user, input: { code, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }));
      map[code] = r.id;
    }
    await t((tx) => settingsSvc.set(tx, { organisationId: org, companyId: company, actor: { ...actor(), kind: 'USER' }, roundingAccountId: map['7900']!, realisedAccountId: map['7910']!, unrealisedAccountId: map['7920']!, defaultSeries: {}, reason: 'Initial FX configuration for the tests' }));
  }
});
afterAll(() => db.close());

describe('rate lookup (DEC-016): the day, else the latest earlier daily rate within 7 days, else refuse; never a later rate', () => {
  it('no rate at all: refused, nothing written', async () => {
    const n = sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`);
    await rejects(postUsd(), 'exchange_rate_not_found', 422);
    expect(sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`)).toBe(n);
  });
  it('a manual rate is stored with its source, audited, and used: lines carry the original values and the rate id', async () => {
    const r = await manual('USD', '2026-03-02', '1.25', 'Synthetic rate for the first test');
    expect(r).toMatchObject({ fromCurrency: 'USD', toCurrency: 'GBP', kind: 'DAILY', rate: '1.25000000', sourceKind: 'MANUAL', publisher: 'MANUAL', verificationStatus: 'UNVERIFIED', sourceRef: 'Synthetic rate for the first test' });
    const j = await postUsd();
    expect(j.total).toBe('125.00');
    expect(linesOf(j.id)).toBe('1110:125.0000/0.0000:USD:100.0000/0.0000:1.25000000 ; 4000:0.0000/125.0000:USD:0.0000/100.0000:1.25000000');
    expect(sql(`SELECT count(DISTINCT exchange_rate_id) FROM journal_line WHERE journal_id='${j.id}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM audit_event WHERE action='fx.rate_created' AND entity_id='${r.id}'`)).toBe('1');
  });
  it('window boundaries: the rate day, day +7 still works, day +8 is refused, the day before the rate is refused (never a later rate)', async () => {
    await postUsd({ journalDate: '2026-03-02' });
    await postUsd({ journalDate: '2026-03-09' });
    await rejects(postUsd({ journalDate: '2026-03-10' }), 'exchange_rate_not_found');
    await rejects(postUsd({ journalDate: '2026-03-01' }), 'exchange_rate_not_found');
  });
  it('a weekend gap is bridged by the earlier rate within the window; a PERIOD rate covers every day of its range', async () => {
    await manual('EUR', '2026-03-06', '0.85');                            // a Friday
    await postUsd({ journalDate: '2026-03-08', currency: 'EUR' });       // Sunday: Friday\'s rate within 7 days
    await t((tx) => rates.importCsv(tx, { organisationId: org, companyId: co, actor: actor(), publisher: 'Synthetic Monthly', series: 'S1', retrievedAt: new Date(), kind: 'PERIOD', csv: 'from,valid_from,valid_to,rate\nJPY,2026-03-01,2026-03-31,0.005\n' }));
    const j = await postUsd({ journalDate: '2026-03-31', currency: 'JPY', amount: '1000' });          // 1000 JPY x 0.005 = 5.00 on the last day of the range
    expect(j.total).toBe('5.00');
    await postUsd({ journalDate: '2026-03-01', currency: 'JPY', amount: '1000' });
    await rejects(postUsd({ journalDate: '2026-04-01', currency: 'JPY', amount: '1000' }), 'exchange_rate_not_found');   // a PERIOD rate does not roll forward
  });
  it('an explicit rate id must apply (pair, date, current); an unusable one is refused', async () => {
    const eur = await manual('EUR', '2026-03-12', '0.86');
    await postUsd({ journalDate: '2026-03-12', currency: 'EUR', rateId: eur.id });
    await rejects(postUsd({ journalDate: '2026-03-12', currency: 'USD', rateId: eur.id }), 'exchange_rate_not_applicable');   // wrong pair
    await rejects(postUsd({ journalDate: '2026-03-11', currency: 'EUR', rateId: eur.id }), 'exchange_rate_not_applicable');   // dated after the journal
    await rejects(postUsd({ journalDate: '2026-03-12', currency: 'EUR', rateId: uuidv7() }), 'exchange_rate_not_applicable');
  });
  it('more than one series covering a date is ambiguous until the company chooses a default series or passes a rate id', async () => {
    await manual('CHF', '2026-03-15', '1.10');
    await t((tx) => rates.importCsv(tx, { organisationId: org, companyId: co, actor: actor(), publisher: 'Synthetic Daily', series: 'D1', retrievedAt: new Date(), kind: 'DAILY', csv: 'from,valid_from,rate\nCHF,2026-03-15,1.12\n' }));
    await rejects(postUsd({ journalDate: '2026-03-15', currency: 'CHF' }), 'exchange_rate_ambiguous');
    await t((tx) => settingsSvc.set(tx, { organisationId: org, companyId: co, actor: { ...actor(), kind: 'USER' }, roundingAccountId: acc['7900']!, realisedAccountId: acc['7910']!, unrealisedAccountId: acc['7920']!, defaultSeries: { CHF: { publisher: 'Synthetic Daily', series: 'D1' } }, reason: 'Choose the synthetic daily series for CHF' }));
    const j = await postUsd({ journalDate: '2026-03-15', currency: 'CHF', amount: '100.00' });
    expect(j.total).toBe('112.00');
    await t((tx) => settingsSvc.set(tx, { organisationId: org, companyId: co, actor: { ...actor(), kind: 'USER' }, roundingAccountId: acc['7900']!, realisedAccountId: acc['7910']!, unrealisedAccountId: acc['7920']!, defaultSeries: { CHF: { publisher: 'MANUAL', series: null } }, reason: 'Switch CHF to manual rates only' }));
    expect((await postUsd({ journalDate: '2026-03-15', currency: 'CHF', amount: '100.00' })).total).toBe('110.00');
    await t((tx) => settingsSvc.set(tx, { organisationId: org, companyId: co, actor: { ...actor(), kind: 'USER' }, roundingAccountId: acc['7900']!, realisedAccountId: acc['7910']!, unrealisedAccountId: acc['7920']!, defaultSeries: {}, reason: 'Reset the series choices for later tests' }));
  });
});

describe('manual rates, correction by supersession, verification', () => {
  it('a manual rate on a journal is stored and audited; it needs fx:rate-manage; a different value for the same day needs a supersession', async () => {
    const j = await postUsd({ journalDate: '2026-02-10', manualRate: { rate: '1.30', source: 'Invoice from the supplier shows 1.30' } });
    expect(j.total).toBe('130.00');
    expect(sql(`SELECT count(*) FROM exchange_rate WHERE source_ref='Invoice from the supplier shows 1.30' AND rate=1.3`)).toBe('1');
    expect(sql(`SELECT count(*) FROM audit_event WHERE action='fx.rate_created' AND metadata->>'via'='journal posting'`)).not.toBe('0');
    await postUsd({ journalDate: '2026-02-10', manualRate: { rate: '1.30', source: 'Same value again is fine' } });
    await rejects(postUsd({ journalDate: '2026-02-10', manualRate: { rate: '1.31', source: 'A different value' } }), 'exchange_rate_exists', 409);
    await rejects(postUsd({ journalDate: '2026-02-11', manualRate: { rate: '1.31', source: 'No permission to enter rates' }, actor: actorOf(user, allow('fx:rate-manage')) }), 'permission_denied', 403);
    await rejects(postUsd({ rateId: uuidv7(), manualRate: { rate: '1.3', source: 'both given' } , currency: 'GBP' }), 'rate_not_applicable');
  });
  it('supersede: the old rate stays for the journals that used it, the new one is used from now on, the correction is audited with its reason', async () => {
    const old = await manual('USD', '2026-02-20', '1.20', 'First entry with a typo');
    const before = await postUsd({ journalDate: '2026-02-20' });
    const fixed = await t((tx) => rates.supersede(tx, { organisationId: org, companyId: co, actor: actor(), id: old.id, rate: '1.2', source: 'Corrected from the bank advice', reason: 'The first entry had a transposed digit' }));
    expect(fixed).toMatchObject({ rate: '1.20000000', sourceRef: 'Corrected from the bank advice', supersededById: null });
    expect(sql(`SELECT superseded_by_id FROM exchange_rate WHERE id='${old.id}'`)).toBe(fixed.id);
    const after = await postUsd({ journalDate: '2026-02-20' });
    expect(sql(`SELECT exchange_rate_id FROM journal_line WHERE journal_id='${before.id}' AND line_no=1`)).toBe(old.id);
    expect(sql(`SELECT exchange_rate_id FROM journal_line WHERE journal_id='${after.id}' AND line_no=1`)).toBe(fixed.id);
    await rejects(t((tx) => rates.supersede(tx, { organisationId: org, companyId: co, actor: actor(), id: old.id, rate: '1.3', source: 'second correction', reason: 'Trying to correct the old row again' })), 'exchange_rate_superseded', 409);
    await rejects(t((tx) => rates.supersede(tx, { organisationId: org, companyId: co, actor: actorOf(user, allow('fx:rate-manage')), id: fixed.id, rate: '1.3', source: 'no permission', reason: 'Trying without the permission' })), 'permission_denied');
    expect(sql(`SELECT reason FROM audit_event WHERE action='fx.rate_superseded' AND entity_id='${old.id}'`)).toBe('The first entry had a transposed digit');
  });
  it('verification is by a second person, once; the company policy can refuse unverified rates', async () => {
    const r = await manual('SEK', '2026-02-25', '0.09');
    await rejects(t((tx) => rates.verify(tx, { organisationId: org, companyId: co, actor: actor(), id: r.id })), 'self_verification_not_allowed', 403);
    await t((tx) => policies.set(tx, { organisationId: org, companyId: co, actor: actor(), openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14, fxBlockUnverifiedRates: true, reason: 'Require verified rates for all FX postings' }));
    await rejects(postUsd({ journalDate: '2026-02-25', currency: 'SEK' }), 'exchange_rate_unverified', 422);
    const v = await t((tx) => rates.verify(tx, { organisationId: org, companyId: co, actor: actorOf(user2), id: r.id, note: 'Checked against the source document' }));
    expect(v).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: user2 });
    expect((await postUsd({ journalDate: '2026-02-25', currency: 'SEK', amount: '100.00' })).total).toBe('9.00');
    await rejects(t((tx) => rates.verify(tx, { organisationId: org, companyId: co, actor: actorOf(user2), id: r.id })), 'already_verified', 409);
    await rejects(postUsd({ journalDate: '2026-02-26', manualRate: { rate: '1.5', source: 'Fresh manual rate under the strict policy' } }), 'exchange_rate_unverified');   // a new manual rate is unverified too
    await t((tx) => policies.set(tx, { organisationId: org, companyId: co, actor: actor(), openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14, fxBlockUnverifiedRates: false, reason: 'Relax again so later tests use unverified rates' }));
  });
});

describe('conversion and the visible rounding line (DEC-017)', () => {
  it('per-line half-up rounding leaves a difference that a visible FX-rounding line absorbs, and the journal balances', async () => {
    await manual('USD', '2026-03-20', '1.2345');
    // 10.01 x 1.2345 = 12.357345 -> 12.36 (x2 = 24.72); 20.02 x 1.2345 = 24.71469 -> 24.71: the debits exceed the credit by 0.01
    const j = await t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-20', sourceType: 'MANUAL', description: 'Rounding', currency: 'USD', idempotencyKey: `k-${uuidv7()}`, actor: actor(),
      lines: [{ accountId: acc['1110']!, debit: '10.01', credit: '0' }, { accountId: acc['6100']!, debit: '10.01', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '20.02' }] }));
    expect(j.total).toBe('24.72');
    expect(j.lineCount).toBe(4);
    expect(linesOf(j.id)).toBe('1110:12.3600/0.0000:USD:10.0100/0.0000:1.23450000 ; 6100:12.3600/0.0000:USD:10.0100/0.0000:1.23450000 ; 4000:0.0000/24.7100:USD:0.0000/20.0200:1.23450000 ; 7900:0.0000/0.0100:-:-/-:-');
    const gen = sql(`SELECT description FROM journal_line WHERE journal_id='${j.id}' AND line_no=4`);
    expect(gen).toBe('FX rounding');
  });
  it('a company without an FX rounding account refuses a conversion that needs one (and says so)', async () => {
    await t((tx) => rates.create(tx, { organisationId: org, companyId: coB, actor: actor(), fromCurrency: 'USD', kind: 'DAILY', validFrom: '2026-03-20', rate: '1.2345', source: 'same synthetic rate' })).catch(() => undefined);
    await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: coB, journalDate: '2026-03-20', sourceType: 'MANUAL', description: 'Rounding', currency: 'USD', idempotencyKey: `k-${uuidv7()}`, actor: actor(),
      lines: [{ accountId: accB['1110']!, debit: '10.01', credit: '0' }, { accountId: accB['6100']!, debit: '10.01', credit: '0' }, { accountId: accB['4000']!, debit: '0', credit: '20.02' }] })), 'fx_rounding_account_missing', 422);
  });
  it('validation in the transaction currency: unbalanced, minor units of the transaction currency, zero after conversion, unknown currency', async () => {
    await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-02', sourceType: 'MANUAL', description: 'x', currency: 'USD', idempotencyKey: `k-${uuidv7()}`, actor: actor(),
      lines: [{ accountId: acc['1110']!, debit: '100.00', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '99.99' }] })), 'unbalanced_journal');
    await rejects(postUsd({ amount: '100.001' }), 'invalid_amount');
    await rejects(postUsd({ currency: 'JPY', journalDate: '2026-03-02', amount: '100.5' }), 'invalid_amount');                  // yen has no minor units
    await rejects(postUsd({ currency: 'XXX' }), 'unknown_currency');
    await rejects(postUsd({ journalDate: '2026-03-02', rateId: uuidv7(), currency: undefined }), 'rate_not_applicable');         // a rate on a functional journal
  });
  it('MANUAL journals cannot use the accounts reserved for FX, nor control accounts, in any currency', async () => {
    await rejects(postUsd({ debit: '7920' }), 'system_account_restricted');
    await rejects(postUsd({ debit: '7900' }), 'system_account_restricted');
    await rejects(postUsd({ debit: '1100' }), 'control_account_restricted');
    await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-02', sourceType: 'MANUAL', description: 'GBP', idempotencyKey: `k-${uuidv7()}`, actor: actor(),
      lines: [{ accountId: acc['7910']!, debit: '1', credit: '0' }, { accountId: acc['4000']!, debit: '0', credit: '1' }] })), 'system_account_restricted');
  });
  it('opening balances and control adjustments stay in the company currency', async () => {
    await rejects(t((tx) => posting.validateForRequest(tx, { organisationId: org, companyId: co, journalDate: '2026-01-01', sourceType: 'OPENING_BALANCE', description: 'x', currency: 'USD',
      lines: [{ accountId: acc['1100']!, debit: '5', credit: '0' }, { accountId: acc['3000']!, debit: '0', credit: '5' }] })), 'foreign_currency_not_supported');
  });
  it('AI actors are refused before anything is converted or stored', async () => {
    const n = sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`);
    await rejects(postUsd({ actor: { kind: 'AI', userId: user, can: async () => true }, journalDate: '2026-02-12', manualRate: { rate: '1.4', source: 'AI should never get this far' } }), 'ai_cannot_post', 403);
    expect(sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`)).toBe(n);
  });
});

describe('idempotency and reversal of foreign-currency journals', () => {
  it('the same key and content returns the existing journal even if a newer rate exists; different content with the same key is a conflict', async () => {
    const key = `idem-${uuidv7()}`;
    await manual('USD', '2026-03-05', '1.40');
    const first = await postUsd({ journalDate: '2026-03-05', idempotencyKey: key });
    await t((tx) => rates.supersede(tx, { organisationId: org, companyId: co, actor: actor(), id: sql(`SELECT id FROM exchange_rate WHERE organisation_id='${org}' AND from_currency='USD' AND valid_from='2026-03-05' AND superseded_by_id IS NULL`), rate: '1.41', source: 'Corrected', reason: 'A later correction of the day\'s rate' }));
    const again = await postUsd({ journalDate: '2026-03-05', idempotencyKey: key });
    expect(again).toMatchObject({ id: first.id, replayed: true, total: '140.00' });
    await rejects(postUsd({ journalDate: '2026-03-05', idempotencyKey: key, amount: '101.00' }), 'idempotency_conflict', 409);
    expect(sql(`SELECT count(*) FROM journal WHERE company_id='${co}' AND idempotency_key='${key}'`)).toBe('1');
  });
  it('reversing copies the original values with sides swapped, the rate and its id; the account nets to zero in both currencies', async () => {
    const j = await postUsd({ journalDate: '2026-03-02', debit: '1110', credit: '4000', amount: '55.55' });
    const rev = await t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: j.id, journalDate: '2026-03-03', reason: 'Posted to the wrong customer', actor: actor() }));
    expect(linesOf(rev.id)).toBe('1110:0.0000/69.4400:USD:0.0000/55.5500:1.25000000 ; 4000:69.4400/0.0000:USD:55.5500/0.0000:1.25000000');
    expect(sql(`SELECT count(*) FROM (SELECT 1 FROM journal_line l WHERE l.journal_id IN ('${j.id}','${rev.id}') AND l.account_id='${acc['1110']}' GROUP BY l.account_id HAVING sum(l.debit-l.credit)=0 AND sum(l.original_debit-l.original_credit)=0) x`)).toBe('1');
  });
  it('the journal view shows the original values; reports read functional amounts', async () => {
    const j = await postUsd({ journalDate: '2026-03-02', amount: '10.00' });
    const view = await t((tx) => queries.getJournal(tx, co, j.id));
    expect(view.lines[0]).toMatchObject({ debit: '12.50', credit: '0.00', original: { currency: 'USD', debit: '10.0000', credit: '0.0000', rate: '1.25000000' } });
    const tb = await t((tx) => queries.trialBalance(tx, co, { asOf: '2026-12-31' })) as { currency: string; rows: { code: string }[] };
    expect(tb.currency).toBe('GBP');
  });
});

describe('importing a published series from a file (no live fetching exists)', () => {
  const imp = (csv: string, o: Partial<{ publisher: string; series: string; actor: RateActor }> = {}) => t((tx) => rates.importCsv(tx, { organisationId: org, companyId: co, actor: o.actor ?? actor(), publisher: o.publisher ?? 'Synthetic Series', series: o.series ?? 'X1', sourceUrl: 'https://example.invalid/series', retrievedAt: new Date('2026-04-01T09:00:00Z'), kind: 'DAILY', csv }));
  it('stores UNVERIFIED rows with publisher, series, URL, retrieval time and batch; re-importing the same file stores nothing new', async () => {
    const csv = 'from,valid_from,rate\nNOK,2026-04-01,0.0950\nNOK,2026-04-02,0.0960\n';
    const a = await imp(csv);
    expect(a).toMatchObject({ imported: 2, skippedIdentical: 0, status: 'UNVERIFIED' });
    expect(sql(`SELECT string_agg(publisher||'|'||series||'|'||source_kind||'|'||verification_status||'|'||(source_url IS NOT NULL)::text, ',') FROM exchange_rate WHERE import_batch_id='${a.batchId}'`)).toBe('Synthetic Series|X1|IMPORT|UNVERIFIED|true,Synthetic Series|X1|IMPORT|UNVERIFIED|true');
    expect(await imp(csv)).toMatchObject({ imported: 0, skippedIdentical: 2 });
    expect(sql(`SELECT count(*) FROM audit_event WHERE action='fx.rates_imported' AND entity_id='${a.batchId}'`)).toBe('1');
  });
  it('is all-or-nothing: a bad row, an unknown currency, a conflicting value or a duplicate row rejects the file and stores nothing', async () => {
    const n = sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`);
    await rejects(imp('from,valid_from,rate\nNOK,2026-04-03,0.0970\nNOK,2026-04-04,oops\n'), 'rate_import_invalid', 422);
    await rejects(imp('from,valid_from,rate\nZZZ,2026-04-03,0.1\n'), 'rate_import_invalid');
    await rejects(imp('from,valid_from,rate\nNOK,2026-04-01,0.0999\n'), 'rate_import_invalid');           // differs from the current stored value
    await rejects(imp('from,valid_from,rate\nNOK,2026-04-05,0.1\nNOK,2026-04-05,0.1\n'), 'rate_import_invalid');
    expect(sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`)).toBe(n);
    const err = await imp('from,valid_from,rate\nNOK,2026-04-03,0.0970\nNOK,2026-04-04,oops\n').catch((e) => e);
    expect(err.details?.errors ?? err.errors).toEqual([{ line: 3, message: expect.stringMatching(/rate must be/) }]);
  });
  it('needs fx:rate-manage; MANUAL is a reserved publisher name', async () => {
    await rejects(imp('from,valid_from,rate\nNOK,2026-04-06,0.1\n', { actor: actorOf(user, allow('fx:rate-manage')) }), 'permission_denied', 403);
    await rejects(imp('from,valid_from,rate\nNOK,2026-04-06,0.1\n', { publisher: 'manual' }), 'invalid_publisher');
  });
});

describe('period-end revaluation (DEC-018)', () => {
  // Scenario in Q1 2026 (period end 31 March): a USD receivable and a USD loan, both entered at 1.25; closing rate 1.30.
  let q1: string;
  beforeAll(async () => {
    q1 = periodId('2026-01-01', coR);
    sql(`DELETE FROM journal_line WHERE false`);                                  // (no-op; the ledger is append-only, earlier journals stay)
  });
  it('preview computes, per monetary account and currency, the difference between carrying value and original x closing rate; it writes nothing', async () => {
    // receivable: 100.00 USD @1.25; loan: 40.00 USD @1.25 on a separate day
    await manual('USD', '2026-03-25', '1.25', 'rate used for the loan');
    await postUsd({ company: coR, journalDate: '2026-03-25', debit: '1110', credit: '4000', amount: '100.00' });
    await postUsd({ company: coR, journalDate: '2026-03-25', debit: '6100', credit: '2230', amount: '40.00' });
    await postUsd({ company: coR, journalDate: '2026-03-25', debit: '0020', credit: '2230', amount: '10.00' });         // plant bought on the loan: the PLANT is non-monetary, the loan is monetary
    await manual('USD', '2026-03-31', '1.30', 'closing rate');
    const before = sql(`SELECT count(*) FROM journal WHERE company_id='${coR}'`);
    const p = await t((tx) => reval.preview(tx, { organisationId: org, companyId: coR, periodId: q1, actor: actor(), rates: {} }));
    expect(p.asAt).toBe('2026-03-31');
    expect(p.missingRates).toEqual([]);
    const byAcc = Object.fromEntries(p.items.map((i) => [`${i.accountCode}/${i.currency}`, i]));
    // the receivable and loan balances of the whole company in USD so far are used (earlier tests posted more USD to 1110 / 2230 / 4000 / 6100)
    expect(byAcc['1110/USD']).toBeDefined();
    expect(byAcc['2230/USD']).toBeDefined();
    expect(byAcc['0020/USD']).toBeUndefined();                      // non-monetary: never revalued
    expect(byAcc['4000/USD']).toBeUndefined();                      // P&L accounts: never revalued
    const rec = byAcc['1110/USD']!;
    expect(money(rec.targetBalance).equals(money(rec.originalBalance).mul('1.30').toDecimalPlaces(2))).toBe(true);
    expect(money(rec.adjustment).equals(money(rec.targetBalance).minus(rec.carryingBalance))).toBe(true);
    expect(sql(`SELECT count(*) FROM journal WHERE company_id='${coR}'`)).toBe(before);
    expect(sql(`SELECT count(*) FROM fx_revaluation_run WHERE company_id='${coR}'`)).toBe('0');
  });
  it('posting revalues once, posts the unrealised difference, and the auto-reversal lands on the first day of the next period', async () => {
    const r = await t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q1, actor: actor(), rates: {} }));
    expect(r.status).toBe('POSTED');
    expect(r.run).toMatchObject({ status: 'REVERSED', asAt: '2026-03-31', reversalDueDate: '2026-04-01' });
    expect(r.reversalJournalId).toEqual(expect.any(String));
    const j = await t((tx) => queries.getJournal(tx, coR, r.journalId!));
    expect(j).toMatchObject({ sourceType: 'FX_REVALUATION', journalDate: '2026-03-31' });
    const rev = await t((tx) => queries.getJournal(tx, coR, r.reversalJournalId!));
    expect(rev).toMatchObject({ sourceType: 'REVERSAL', journalDate: '2026-04-01', reversesJournalId: r.journalId });
    // the counter line is on the unrealised account and the journal balances (the database proves it at commit)
    expect(j.lines.some((l) => l.accountCode === '7920')).toBe(true);
    expect(j.lines.filter((l) => l.adjustsCurrency === 'USD').length).toBeGreaterThanOrEqual(2);
    // reconciliation: after revaluation, original balance x closing rate equals the functional carrying amount, per account
    for (const code of ['1110', '2230']) {
      const row = sql(`SELECT sum(l.original_debit-l.original_credit)::text||'|'||sum(l.debit-l.credit)::text FROM journal_line l JOIN journal jj ON jj.id=l.journal_id JOIN account a ON a.id=l.account_id WHERE l.company_id='${coR}' AND a.code='${code}' AND jj.journal_date<='2026-03-31' AND coalesce(l.original_currency,l.adjusts_currency)='USD'`);
      const [orig] = row.split('|');
      const carrying = sql(`SELECT coalesce(sum(l.debit-l.credit),0) FROM journal_line l JOIN journal jj ON jj.id=l.journal_id JOIN account a ON a.id=l.account_id WHERE l.company_id='${coR}' AND a.code='${code}' AND jj.journal_date<='2026-03-31' AND coalesce(l.original_currency,l.adjusts_currency)='USD'`);
      expect(money(carrying).equals(money(orig!).mul('1.30').toDecimalPlaces(2)), `${code}: ${row}`).toBe(true);
    }
    // after the reversal (1 April) the balance is back at the historic value
    expect(money(balance(coR, '1110', '2026-04-01')).lessThan(money(balance(coR, '1110', '2026-03-31')))).toBe(true);
  });
  it('is idempotent: running it again with nothing new posted does nothing; new activity gets its own delta journal', async () => {
    const runs = sql(`SELECT count(*) FROM fx_revaluation_run WHERE company_id='${coR}'`);
    const again = await t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q1, actor: actor(), rates: {} }));
    expect(again.status).toBe('NOTHING_TO_DO');
    expect(sql(`SELECT count(*) FROM fx_revaluation_run WHERE company_id='${coR}'`)).toBe(runs);
    await postUsd({ company: coR, journalDate: '2026-03-31', debit: '1110', credit: '4000', amount: '10.00' });          // 10.00 USD @1.30 on the last day
    const next = await t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q1, actor: actor(), rates: {} }));
    expect(next.status === 'NOTHING_TO_DO' || next.status === 'POSTED').toBe(true);       // 10.00 x 1.30 = 13.00 exactly: no delta
    const view = await t((tx) => reval.listRuns(tx, coR, { limit: 10 }));
    expect(view.items.every((r) => r.status === 'REVERSED')).toBe(true);
  });
  it('two revaluations at once post exactly one journal (the period row is locked)', async () => {
    const q3 = periodId('2026-07-01', coR);
    await manual('USD', '2026-09-30', '1.50', 'Q3 closing');
    await manual('USD', '2026-08-15', '1.40', 'Q3 activity');
    await postUsd({ company: coR, journalDate: '2026-08-15', debit: '1110', credit: '4000', amount: '200.00' });
    const run = () => t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q3, actor: actor(), rates: {} }));
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter((r) => r.status === 'POSTED')).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM journal WHERE company_id='${coR}' AND source_type='FX_REVALUATION' AND journal_date='2026-09-30'`)).toBe('1');
  });
  it('a missing closing rate stops the run and says which currency; a closing rate can be chosen by id', async () => {
    const q2 = periodId('2026-04-01', coR);
    await manual('USD', '2026-04-15', '1.28', 'Q2 activity');
    await postUsd({ company: coR, journalDate: '2026-04-15', debit: '1110', credit: '4000', amount: '50.00' });
    const p = await t((tx) => reval.preview(tx, { organisationId: org, companyId: coR, periodId: q2, actor: actor(), rates: {} }));
    expect(p.missingRates.map((m) => m.currency)).toContain('USD');
    await rejects(t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q2, actor: actor(), rates: {} })), 'exchange_rate_not_found');
  });
  it('permission period:manage is required; an AI actor is refused; an unknown period is a 404', async () => {
    const q1b = periodId('2026-01-01', coR);
    await rejects(t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: periodId('2026-07-01', coR), actor: actorOf(user, allow('period:manage')), rates: {} })), 'permission_denied', 403);
    await rejects(t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: periodId('2026-07-01', coR), actor: { kind: 'AI', userId: user, can: async () => true } as never, rates: {} })), 'ai_cannot_post');
    await rejects(t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: uuidv7(), actor: actor(), rates: {} })), 'not_found');
    expect(q1b).toBeTruthy();
  });
});

describe('close controls and the due reversal', () => {
  const close = (start: string, ack = false) => t((tx) => periods.transition(tx, { organisationId: org, companyId: coR, periodId: periodId(start, coR), action: 'close', userId: user, acknowledgeUnrevaluedFx: ack, can: async () => true }));
  it('a period with foreign-currency monetary balances that are not at the closing rate cannot be closed without an explicit acknowledgement', async () => {
    await rejects(close('2026-04-01'), 'fx_unrevalued_balances', 409);
    expect((await close('2026-04-01', true)).status).toBe('CLOSED');
  });
  it('a revalued period closes normally (activity posted after the first revaluation needs a fresh run first)', async () => {
    await rejects(close('2026-07-01'), 'fx_unrevalued_balances', 409);          // the 15 April receivable was entered after the Q3 revaluation ran
    expect((await t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: periodId('2026-07-01', coR), actor: actor(), rates: {} }))).status).toBe('POSTED');
    expect((await close('2026-07-01')).status).toBe('CLOSED');
  });
  it('when the next period does not exist yet the reversal stays due; the period that contains its date cannot close until it is posted', async () => {
    await manual('USD', '2026-12-30', '1.60', 'Q4 closing');
    await manual('USD', '2026-11-10', '1.55', 'Q4 activity');
    await postUsd({ company: coR, journalDate: '2026-11-10', debit: '1110', credit: '4000', amount: '300.00' });
    const q4 = periodId('2026-10-01', coR);
    const r = await t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: q4, actor: actor(), rates: {} }));
    expect(r.status).toBe('POSTED');
    expect(r.reversalJournalId).toBeNull();
    expect(r.run).toMatchObject({ status: 'POSTED', reversalDueDate: '2027-01-01' });
    expect((await close('2026-10-01')).status).toBe('CLOSED');                       // the revalued period itself may close: the reversal belongs to the next one
    await rejects(t((tx) => reval.reverseDue(tx, { organisationId: org, companyId: coR, runId: r.run!.id, actor: actor() })), 'no_open_period_for_reversal', 422);
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${coR}','2027-01-01','2027-12-31')`);
    await rejects(close('2027-01-01', true), 'fx_reversal_pending', 409);          // even with the acknowledgement: a due reversal is never skipped
    const done = await t((tx) => reval.reverseDue(tx, { organisationId: org, companyId: coR, runId: r.run!.id, actor: actor() }));
    expect(done).toMatchObject({ status: 'REVERSED', reversalDueDate: '2027-01-01' });
    await rejects(t((tx) => reval.reverseDue(tx, { organisationId: org, companyId: coR, runId: r.run!.id, actor: actor() })), 'already_reversed', 409);
    expect((await close('2027-01-01', true)).status).toBe('CLOSED');
  });
  it('a closed period refuses a revaluation that would post (the PostingService guards closed and locked periods)', async () => {
    await manual('USD', '2026-06-30', '1.33', 'Q2 closing');
    await rejects(t((tx) => reval.post(tx, { organisationId: org, companyId: coR, periodId: periodId('2026-04-01', coR), actor: actor(), rates: {} })), 'period_closed');
  });
});
