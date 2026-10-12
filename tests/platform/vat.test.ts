import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, PostingService, RateService, VatService, type PostInput, type PostLineInput, type VatActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M4b through the services: VAT codes and verified rate versions, VAT on postings (exclusive, inclusive, zero, exempt, outside scope, reverse charge,
 * credit notes, both directions, tax point), and the nine-box workpaper with its reconciliation. ALL RATES ARE SYNTHETIC (12.5 %): the platform ships none.
 */
let db: Database;
let org: string, author: string, reviewer: string, co: string, coW: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const rateId: Record<string, string> = {};
const posting = new PostingService();
const vat = new VatService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: author }, fn);
const person = (userId: string, deny: string[] = []): VatActor & { kind: 'USER' } => ({ userId, kind: 'USER', can: async (p) => !deny.includes(p) });
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2026-01-01' };
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const L = (company: string, a: string, debit: string, credit: string, taxCode?: string): PostLineInput => ({ accountId: acc[company]![a]!, debit, credit, ...(taxCode ? { taxCodeId: code[taxCode] } : {}) });
const post = (company: string, lines: PostLineInput[], over: Partial<PostInput> = {}) => t((tx) => posting.post(tx, {
  organisationId: org, companyId: company, journalDate: '2026-02-10', sourceType: 'MANUAL', description: 'VAT journal', idempotencyKey: `k-${uuidv7()}`, actor: { kind: 'USER', userId: author, can: async () => true }, lines, ...over }));
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||':'||coalesce(l.vat_role,'-')||':'||coalesce(l.vat_net_line_no::text,'-'), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);

async function defineCode(c: string, treatment: string, direction: string, rate: string, netBoxes: number[], vatBoxes: number[], reverseCharge = false, verify = true) {
  const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: c, name: `Synthetic ${c}`, treatment: treatment as never, direction: direction as never, reverseCharge }));
  code[c] = tc.id;
  const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: tc.id, rate, effectiveFrom: '2026-01-01', netBoxes, vatBoxes, source: src }));
  rateId[c] = r.id;
  if (verify) await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r.id, notes: 'Synthetic fixture checked against the test source' }));
}

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  author = sql(`INSERT INTO "user"(email, display_name) VALUES ('vat1-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  reviewer = sql(`INSERT INTO "user"(email, display_name) VALUES ('vat2-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','VAT services')`);
  const mk = (n: string) => sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${n}') RETURNING id`).split('\n')[0]!;
  co = mk('VAT Co'); coW = mk('VAT Workpaper Co');
  const accounts = new AccountService();
  for (const c of [co, coW]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: author }))).items) acc[c]![a.code] = a.id;
    acc[c]!['1150'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: author, input: { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', isControl: false, controlKind: null, taxTreatment: 'VAT_CONTROL', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', activeFrom: null, activeTo: null } }))).id;
  }
  await defineCode('S', 'STANDARD', 'SALES', '12.5', [6], [1]);
  await defineCode('P', 'STANDARD', 'PURCHASES', '12.5', [7], [4]);
  await defineCode('Z', 'ZERO', 'BOTH', '0', [6, 7], []);
  await defineCode('E', 'EXEMPT', 'PURCHASES', '0', [7], []);
  await defineCode('O', 'OUTSIDE_SCOPE', 'BOTH', '0', [], []);
  await defineCode('RC', 'STANDARD', 'PURCHASES', '12.5', [7], [1, 4], true);
  await defineCode('B', 'STANDARD', 'BOTH', '12.5', [6, 7], [1, 4]);
  await defineCode('U', 'STANDARD', 'SALES', '12.5', [6], [1], false, false);                   // left UNVERIFIED on purpose
});
afterAll(() => db.close());

const register = (company: string) => t((tx) => vat.setSettings(tx, { organisationId: org, companyId: company, actor: person(author), registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD',
  periodMonths: 3, anchorPeriodEnd: '2026-03-31', outputAccountId: acc[company]!['2200']!, inputAccountId: acc[company]!['1150']!, reason: 'Registered for VAT from 1 January (synthetic)' }));

describe('VAT rules: codes, sourced rate versions, verification by a second person', () => {
  it('a rate version starts UNVERIFIED; the author cannot verify it; a holder of tax:rule-verify can, once', async () => {
    const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: 'V1', name: 'Verification probe', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false }));
    const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: tc.id, rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: src }));
    expect(r).toMatchObject({ verificationStatus: 'UNVERIFIED', source: { provision: src.provision } });
    await rejects(t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(author), id: r.id, notes: 'Trying to verify my own entry' })), 'self_verification_not_allowed', 403);
    await rejects(t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer, ['tax:rule-verify']), id: r.id, notes: 'No permission to verify here' })), 'permission_denied', 403);
    const v = await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r.id, notes: 'Checked against the synthetic source' }));
    expect(v).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: reviewer, verificationNotes: 'Checked against the synthetic source' });
    await rejects(t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r.id, notes: 'A second verification attempt' })), 'already_verified', 409);
  });
  it('verification evidence must be a document the verifier can read (restricted documents included); unreadable is indistinguishable from missing', async () => {
    const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: 'EV', name: 'Evidence probe', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false }));
    const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: tc.id, rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: src }));
    const doc = sql(`INSERT INTO document(organisation_id,company_id,name,visibility,created_by_user_id) VALUES ('${org}','${co}','source-extract.pdf','RESTRICTED','${author}') RETURNING id`).split('\n')[0]!;
    const blind = { ...person(reviewer), canReadDocument: async () => false };
    await rejects(t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: blind, id: r.id, notes: 'Checked against the extract', evidenceDocumentId: doc })), 'invalid_evidence');
    await rejects(t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r.id, notes: 'Checked against the extract', evidenceDocumentId: uuidv7() })), 'invalid_evidence');
    const ok = await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: { ...person(reviewer), canReadDocument: async () => true }, id: r.id, notes: 'Checked against the extract', evidenceDocumentId: doc }));
    expect(ok.evidenceDocumentId).toBe(doc);
  });
  it('the rate must fit the treatment, box mappings fit the direction, versions of one code do not overlap, codes are unique', async () => {
    const z = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: 'Z2', name: 'Zero probe', treatment: 'ZERO', direction: 'SALES', reverseCharge: false }));
    await rejects(t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: z.id, rate: '5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [], source: src })), 'rate_treatment_mismatch');
    await rejects(t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: z.id, rate: '0', effectiveFrom: '2026-01-01', netBoxes: [7], vatBoxes: [], source: src })), 'invalid_boxes');
    await rejects(t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: code.S!, rate: '12.5', effectiveFrom: '2026-06-01', netBoxes: [6], vatBoxes: [1], source: src })), 'tax_rate_overlap', 409);
    await rejects(t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: 'S', name: 'dup', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false })), 'tax_code_exists', 409);
    await rejects(t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author, ['vat:manage']), code: 'NP', name: 'no permission', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false })), 'permission_denied', 403);
  });
  it('only the STANDARD scheme can be selected; CASH and FLAT_RATE are registered but refused', async () => {
    for (const scheme of ['CASH', 'FLAT_RATE']) {
      await rejects(t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: person(author), registered: false, vrn: null, registeredFrom: null, scheme, periodMonths: 3, anchorPeriodEnd: null, outputAccountId: null, inputAccountId: null, reason: 'Trying another scheme' })), 'vat_scheme_not_supported');
    }
    await rejects(t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: person(author), registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2026-03-30', outputAccountId: acc[co]!['2200']!, inputAccountId: acc[co]!['1150']!, reason: 'Wrong period end day' })), 'invalid_period_end');
  });
});

describe('VAT on postings', () => {
  it('a company that is not VAT registered cannot use VAT codes', async () => {
    await rejects(post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'S')]), 'not_vat_registered', 422);
    await register(co);
  });
  it('exclusive sale: the service adds a visible VAT line on the output account; the journal balances', async () => {
    const j = await post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'S')]);
    expect(linesOf(j.id)).toBe('1110:112.5000/0.0000:-:- ; 4000:0.0000/100.0000:NET:- ; 2200:0.0000/12.5000:VAT:2');
    expect(j.total).toBe('112.50');
  });
  it('inclusive purchase: the VAT fraction is taken out of the gross; VAT goes to the input account', async () => {
    const j = await post(co, [L(co, '6100', '112.50', '0', 'P'), L(co, '2230', '0', '112.50')], { amountsIncludeVat: true });
    expect(linesOf(j.id)).toBe('6100:100.0000/0.0000:NET:- ; 1150:12.5000/0.0000:VAT:1 ; 2230:0.0000/112.5000:-:-');
  });
  it('zero-rated, exempt and outside-scope lines carry their code but no VAT line', async () => {
    const j = await post(co, [L(co, '1110', '50.00', '0'), L(co, '4010', '0', '50.00', 'Z')]);
    expect(linesOf(j.id)).toBe('1110:50.0000/0.0000:-:- ; 4010:0.0000/50.0000:NET:-');
  });
  it('reverse charge: no VAT is added to the payable, equal output and input VAT lines are posted', async () => {
    const j = await post(co, [L(co, '6600', '200.00', '0', 'RC'), L(co, '2230', '0', '200.00')]);
    expect(linesOf(j.id)).toBe('6600:200.0000/0.0000:NET:- ; 2200:0.0000/25.0000:RC_OUTPUT:1 ; 1150:25.0000/0.0000:RC_INPUT:1 ; 2230:0.0000/200.0000:-:-');
    await rejects(post(co, [L(co, '6600', '200.00', '0', 'RC'), L(co, '2230', '0', '200.00')], { amountsIncludeVat: true }), 'reverse_charge_inclusive_not_supported');
  });
  it('a credit note (a debit on a sales code) reduces output VAT; a BOTH code uses output for credits and input for debits', async () => {
    const cn = await post(co, [L(co, '4000', '40.00', '0', 'S'), L(co, '1110', '0', '45.00')]);
    expect(linesOf(cn.id)).toBe('4000:40.0000/0.0000:NET:- ; 2200:5.0000/0.0000:VAT:1 ; 1110:0.0000/45.0000:-:-');
    const both = await post(co, [L(co, '6310', '80.00', '0', 'B'), L(co, '4100', '0', '80.00', 'B'), L(co, '1110', '0', '10.00'), L(co, '1110', '10.00', '0')]);
    expect(linesOf(both.id)).toBe('6310:80.0000/0.0000:NET:- ; 1150:10.0000/0.0000:VAT:1 ; 4100:0.0000/80.0000:NET:- ; 2200:0.0000/10.0000:VAT:3 ; 1110:0.0000/10.0000:-:- ; 1110:10.0000/0.0000:-:-');
  });
  it('refusals: unverified rate, no rate for the tax point, before registration, unknown code, foreign currency, a typed line on the VAT control account', async () => {
    await rejects(post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'U')]), 'tax_rate_unverified', 422);
    await rejects(post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'S')], { journalDate: '2026-02-10', taxPoint: '2025-12-31' }), 'not_vat_registered');
    sql(`UPDATE company_vat_setting SET registered_from='2025-01-01' WHERE company_id='${co}'`);
    await rejects(post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'S')], { taxPoint: '2025-12-31' }), 'tax_rate_not_found');
    sql(`UPDATE company_vat_setting SET registered_from='2026-01-01' WHERE company_id='${co}'`);
    await rejects(post(co, [L(co, '1110', '1', '0'), { accountId: acc[co]!['4000']!, debit: '0', credit: '1', taxCodeId: uuidv7() }]), 'unknown_tax_code');
    const rates = sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`);
    await rejects(post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'S')], { currency: 'USD', manualRate: { rate: '1.25', source: 'synthetic FX rate' } }), 'vat_foreign_currency_not_supported');
    expect(sql(`SELECT count(*) FROM exchange_rate WHERE organisation_id='${org}'`)).toBe(rates);              // refused before any rate is stored
    await rejects(post(co, [L(co, '2200', '12.50', '0'), L(co, '4000', '0', '12.50')]), 'control_account_restricted');
    await rejects(post(co, [L(co, '1110', '1', '0'), L(co, '4000', '0', '1')], { amountsIncludeVat: true }), 'vat_not_applicable');
  });
  it('a replay of the same key returns the original journal even after the rule changed; new postings need the new version verified', async () => {
    const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(author), code: 'CH', name: 'Change probe', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false }));
    const r1 = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(author), taxCodeId: tc.id, rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: src }));
    await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r1.id, notes: 'Initial version checked' }));
    code.CH = tc.id;
    const key = `vat-replay-${uuidv7()}`;
    const first = await post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'CH')], { idempotencyKey: key });
    const r2 = await t((tx) => vat.supersedeRate(tx, { organisationId: org, companyId: co, actor: person(author), id: r1.id, rate: '7', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: src, reason: 'Synthetic change of rate for the test' }));
    expect(r2.verificationStatus).toBe('UNVERIFIED');
    const again = await post(co, [L(co, '1110', '112.50', '0'), L(co, '4000', '0', '100.00', 'CH')], { idempotencyKey: key });
    expect(again).toMatchObject({ id: first.id, replayed: true });
    await rejects(post(co, [L(co, '1110', '107.00', '0'), L(co, '4000', '0', '100.00', 'CH')]), 'tax_rate_unverified');
    // the original can still be reversed: a reversal mirrors history even on a superseded version
    const rev = await t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: first.id, journalDate: '2026-02-11', reason: 'Wrong customer', actor: { kind: 'USER', userId: author, can: async () => true } }));
    expect(linesOf(rev.id)).toBe('1110:0.0000/112.5000:-:- ; 4000:100.0000/0.0000:NET:- ; 2200:12.5000/0.0000:VAT:2');
    await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r2.id, notes: 'New version checked' }));
    expect(linesOf((await post(co, [L(co, '1110', '107.00', '0'), L(co, '4000', '0', '100.00', 'CH')])).id)).toBe('1110:107.0000/0.0000:-:- ; 4000:0.0000/100.0000:NET:- ; 2200:0.0000/7.0000:VAT:2');
  });
});

describe('nine-box workpaper and VAT control reconciliation', () => {
  beforeAll(async () => {
    await register(coW);
    const p = (lines: PostLineInput[], over: Partial<PostInput> = {}) => post(coW, lines, over);
    await p([L(coW, '1110', '112.50', '0'), L(coW, '4000', '0', '100.00', 'S')]);                         // box 6 +100, box 1 +12.50
    await p([L(coW, '4000', '40.00', '0', 'S'), L(coW, '1110', '0', '45.00')]);                           // credit note: box 6 -40, box 1 -5
    await p([L(coW, '6100', '80.00', '0', 'P'), L(coW, '2230', '0', '90.00')]);                           // box 7 +80, box 4 +10
    await p([L(coW, '6600', '200.00', '0', 'RC'), L(coW, '2230', '0', '200.00')]);                        // box 7 +200, box 1 +25, box 4 +25
    await p([L(coW, '1110', '50.00', '0'), L(coW, '4010', '0', '50.00', 'Z')]);                           // box 6 +50
    await p([L(coW, '6200', '30.00', '0', 'E'), L(coW, '2230', '0', '30.00')]);                           // box 7 +30
    await p([L(coW, '6400', '70.00', '0', 'O'), L(coW, '2230', '0', '70.00')]);                           // outside scope: no box
    await p([L(coW, '1110', '22.50', '0'), L(coW, '4000', '0', '20.00', 'S')], { journalDate: '2026-04-02', taxPoint: '2026-03-31' });   // tax point in Q1, dated in Q2
    await p([L(coW, '1150', '7.00', '0'), L(coW, '1110', '0', '7.00')]);                                  // a non-VAT posting to the input account
    await p([L(coW, '1110', '11.25', '0'), L(coW, '4000', '0', '10.00', 'S')], { journalDate: '2026-04-15' });  // Q2: excluded from Q1
  });
  it('the boxes equal the hand-calculated figures for the synthetic scenario and each drills to its lines', async () => {
    const w = await t((tx) => vat.workpaper(tx, coW, { from: '2026-01-01', to: '2026-03-31' }));
    const box = (n: number) => w.boxes.find((b) => b.box === n)!;
    expect(box(1).amount).toBe('35.00');       // 12.50 - 5.00 + 25.00 + 2.50 (tax point 31 March)
    expect(box(2).amount).toBe('0.00');
    expect(box(3).amount).toBe('35.00');
    expect(box(4).amount).toBe('35.00');       // 10.00 + 25.00
    expect(box(5)).toMatchObject({ amount: '0.00', direction: 'PAYABLE' });
    expect(box(6).amount).toBe('130.00');      // 100 - 40 + 50 + 20
    expect(box(7).amount).toBe('310.00');      // 80 + 200 + 30
    expect(box(8).amount).toBe('0.00');
    expect(box(6).lines).toHaveLength(4);
    expect(box(1).lines.map((l) => l.amount).sort()).toEqual(['-5.00', '12.50', '2.50', '25.00'].sort());
    expect(w.rules.map((r) => r.code).sort()).toEqual(['E', 'O', 'P', 'RC', 'S', 'Z']);            // outside scope is listed (it decided that nothing goes in a box)
    expect(w.rules.every((r) => r.verifiedBy === reviewer)).toBe(true);
    expect(w.notice).toMatch(/not a VAT return and not a submission/);
  });
  it('reconciliation: VAT-account movement by journal date versus VAT lines by tax point, with every difference explained', async () => {
    const w = await t((tx) => vat.workpaper(tx, coW, { from: '2026-01-01', to: '2026-03-31' }));
    // movement (credit-positive) on 2200 and 1150 dated in Q1: 12.50 - 5 - 10 + 25 - 25 - 7 = -9.50; VAT lines by tax point: 12.50 - 5 - 10 + 25 - 25 + 2.50 = 0.00
    expect(w.reconciliation).toMatchObject({ vatAccountMovement: '-9.50', vatLinesByTaxPoint: '0.00', difference: '-9.50' });
    const reasons = w.reconciliation.explainedBy.map((e) => `${e.amount}:${e.reason.split(' ')[0]}`).sort();
    expect(reasons).toEqual(['-7.00:Posting', '2.50:Tax'].sort());
  });
  it('the return period of a date follows the stagger', async () => {
    expect(await t((tx) => vat.period(tx, coW, '2026-05-20'))).toEqual({ from: '2026-04-01', to: '2026-06-30', periodMonths: 3 });
    const unregistered = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Unregistered') RETURNING id`).split('\n')[0]!;
    await rejects(t((tx) => vat.period(tx, unregistered, '2026-05-20')), 'not_vat_registered');
  });
});

describe('isolation', () => {
  it('another organisation sees no codes, rates or settings', async () => {
    const other = uuidv7(); sql(`INSERT INTO organisation(id,type,name) VALUES ('${other}','BUSINESS','Other VAT org')`);
    const seen = await db.tenant({ organisationId: other, userId: author }, async (tx) => [await tx.taxCode.count(), await tx.taxRate.count(), await tx.companyVatSetting.count()]);
    expect(seen).toEqual([0, 0, 0]);
    void RateService;
  });
});
