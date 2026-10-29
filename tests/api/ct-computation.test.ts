import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, type Stack, type TestUser } from '../helpers/stack';

/**
 * V4-M4 (DEC-101) through the public API: a profitable 12-month CT period across two financial years and a following short loss period carried
 * back to it, against the hand-worked golden tests/golden/v4-m4-computation.json (docs/architecture/v4-m4-golden-workings.xlsx). Computations
 * are prepared by one person and approved by another; the canonical CT600 comes from the approved computation. Synthetic data only.
 */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v4-m4-computation.json'), 'utf8'));
const SOURCE = { url: 'https://example.invalid/synthetic-ct', provision: 'Synthetic Corporation Tax provision (test fixture)', retrievedOn: '2026-01-01' };
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const periods: string[] = [];
let evidence: string;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, `/companies/${company.id}${p}`)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const fy = (r: any) => r.financialYears.map((y: any) => [y.financialYear, y.days, y.profit, y.lowerLimit, y.upperLimit, y.basis, y.taxAtRate, y.marginalRelief, y.tax]);
const comp = (n: number) => `/ct-periods/${periods[n]}/computation`;
const expectGolden = (result: any, key: 'A1' | 'B' | 'A2') => {
  const { financialYears, ...rest } = G.expected[key];
  expect(result).toMatchObject(rest);
  expect(fy(result)).toEqual(financialYears);
};

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  company = await makeCompany(s, owner, 'Synthetic Computation Ltd', '07654321');
  for (const a of ok(await as(owner, 'post', '/accounts/initialise'), 201).items) acc[a.code] = a.id;
  for (const y of ['2027', '2028']) ok(await as(owner, 'post', '/periods', { startDate: `${y}-01-01`, endDate: `${y}-12-31` }), 201);
  for (const p of G.periods) for (const [account, debit, credit] of p.journals) {
    ok(await as(accountant, 'post', '/journals', { journalDate: p.yearStart, description: 'Synthetic trading', lines: [{ accountId: acc[account], debit, credit }, { accountId: acc['2230'], debit: credit, credit: debit }] }), 201);
  }
  const std = ok(await as(owner, 'post', '/reporting-standards', { code: 'SYN-CTC', name: 'Synthetic standard' }), 201).id;
  const ver = ok(await as(owner, 'post', `/reporting-standards/${std}/versions`, { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: SOURCE }), 201).id;
  for (const p of G.periods) ok(await as(accountant, 'put', '/reporting-frameworks', { yearStart: p.yearStart, yearEnd: p.yearEnd, versionId: ver, entitySize: 'MICRO', reason: 'Synthetic year for the computation' }));
  const rules: [string, object][] = [['PERIOD_MAX_MONTHS', { months: 12 }], ['AIA_LIMIT', { annualLimit: '1000000' }], ['WDA_RATES', { mainRate: '18', specialRate: '6' }], ['SMALL_POOL_LIMIT', { limit: '1000' }], ['CT_RATES', G.rates]];
  for (const [kind, parameters] of rules) {
    const id = ok(await as(accountant, 'post', '/ct-rules', { kind, effectiveFrom: '2020-01-01', parameters, source: SOURCE }), 201).id;
    ok(await as(owner, 'post', `/ct-rules/${id}/verify`, { notes: 'Checked the synthetic fixture' }));
  }
  for (const p of G.periods) {
    const id = ok(await as(accountant, 'post', '/ct-periods/derive', { yearStart: p.yearStart })).items[0].id;
    ok(await as(accountant, 'post', `/ct-periods/${id}/associated-companies`, { associatedCompanies: 0, reason: 'No associated companies (synthetic)' }));
    periods.push(id);
  }
  evidence = (await uploadDoc(s, owner, { companyId: company.id, name: 'prior-return.pdf' })).documentId;
  for (const [pool, amount] of [['MAIN', G.periods[0].mainPoolOpening], ['SPECIAL_RATE', '0']]) {
    const id = ok(await as(accountant, 'post', '/ca-pool-openings', { pool, asOf: '2026-12-31', amount, evidenceDocumentId: evidence, reason: 'From the 2026 computation (synthetic)' }), 201).id;
    ok(await as(admin, 'post', `/ca-pool-openings/${id}/verify`, { notes: 'Agreed to the 2026 computation' }));
  }
  for (const n of [0, 1]) {
    const ca = ok(await as(reviewer, 'get', `/ct-periods/${periods[n]}/capital-allowances`));
    ok(await as(accountant, 'post', `/ct-periods/${periods[n]}/capital-allowances`, { fingerprint: ca.fingerprint }), 201);
  }
}, 180_000);
afterAll(() => s.stop());

describe('the profitable period (golden A1)', () => {
  it('losses brought forward must be known: a loss opening balance is entered with evidence and verified by a second person', async () => {
    expect(ok(await as(reviewer, 'get', comp(0))).problems).toEqual([expect.stringMatching(/Losses brought forward are unknown/)]);
    const o = ok(await as(accountant, 'post', '/ct-loss-openings', { asOf: '2026-12-31', amount: G.periods[0].lossOpening, evidenceDocumentId: evidence, reason: 'Losses carried forward in the 2026 return (synthetic)' }), 201);
    expect(ok(await as(reviewer, 'get', comp(0))).problems).toEqual(['The loss opening balance has not been verified']);
    expect((await as(accountant, 'post', `/ct-loss-openings/${o.id}/verify`, { notes: 'Agreed to the 2026 return' })).status).toBe(403);
    ok(await as(admin, 'post', `/ct-loss-openings/${o.id}/verify`, { notes: 'Agreed to the 2026 return' }));
    expect(() => adminSql(`UPDATE ct_loss_opening SET amount = 1 WHERE id = '${o.id}'`)).toThrow(/immutable/);
  });
  it('equals the hand workings: marginal relief in each financial year', async () => {
    const v = ok(await as(reviewer, 'get', comp(0)));
    expect(v.problems).toEqual([]);
    expect(v.turnover).toBe('200000.00');
    expectGolden(v.result, 'A1');
  });
  it('is prepared as read by ct:prepare and approved by a holder of ct:approve; the CT600 needs the UTR', async () => {
    const v = ok(await as(reviewer, 'get', comp(0)));
    expect((await as(accountant, 'post', comp(0), { fingerprint: '0'.repeat(64) })).body.code).toBe('fingerprint_mismatch');
    expect((await as(reviewer, 'post', comp(0), { fingerprint: v.fingerprint })).status).toBe(403);
    const c = ok(await as(accountant, 'post', comp(0), { fingerprint: v.fingerprint }), 201);
    expect(c).toMatchObject({ status: 'PREPARED', preparedByUserId: accountant.userId, stale: false });
    expect((await as(reviewer, 'get', `/ct-periods/${periods[0]}/ct600`)).body.code).toBe('computation_not_approved');
    expect((await as(accountant, 'post', `/ct-periods/${periods[0]}/computations/${c.id}/approve`, { notes: 'Reviewed the computation' })).status).toBe(403);
    const a = ok(await as(owner, 'post', `/ct-periods/${periods[0]}/computations/${c.id}/approve`, { notes: 'Reviewed the computation against the workings' }));
    expect(a).toMatchObject({ status: 'APPROVED', approval: { byUserId: owner.userId } });
    expect((await as(reviewer, 'get', `/ct-periods/${periods[0]}/ct600`)).body.code).toBe('utr_missing');
    ok(await as(accountant, 'put', '/tax-profile', { utr: '1234567890', reason: 'From the synthetic notice to file' }));
    expect(ok(await as(reviewer, 'get', `/ct-periods/${periods[0]}/ct600`))).toMatchObject({ format: 'uk-ct600-canonical/1', company: { name: 'Synthetic Computation Ltd', registrationNumber: '07654321', utr: '1234567890' },
      turnover: '200000.00', tradingProfits: '130000.00', tradingLossesBroughtForwardUsed: '10000.00', taxableTotalProfits: '120000.00', corporationTaxChargeable: '28050.00' });
  });
});

describe('the loss period carried back (golden B), and the profitable period again (golden A2)', () => {
  it('a carry back is capped at the loss; the claim is part of what is prepared; the preparer may not approve', async () => {
    expect((await as(reviewer, 'get', `${comp(1)}?carryBack=38177.54`)).body.code).toBe('carry_back_exceeds_loss');
    const v = ok(await as(reviewer, 'get', `${comp(1)}?carryBack=${G.expected.B.carryBack}`));
    expect(v.problems).toEqual([]);
    expectGolden(v.result, 'B');
    expect(v.neighbours.previous).toMatchObject({ periodId: periods[0], lossesCarriedForward: '0.00', profitsBeforeCarryBack: '120000.00' });
    const c = ok(await as(partner, 'post', comp(1), { fingerprint: v.fingerprint, carryBack: G.expected.B.carryBack }), 201);
    expect((await as(partner, 'post', `/ct-periods/${periods[1]}/computations/${c.id}/approve`, { notes: 'Approving my own work on purpose' })).body.code).toBe('self_approval_not_allowed');
    ok(await as(admin, 'post', `/ct-periods/${periods[1]}/computations/${c.id}/approve`, { notes: 'Reviewed the loss and the claim' }));
  });
  it('the profitable period deducts the loss carried back; its approved computation is now stale until prepared again', async () => {
    expect(ok(await as(reviewer, 'get', `/ct-periods/${periods[0]}/computations`)).items[0].stale).toBe(true);
    const v = ok(await as(reviewer, 'get', comp(0)));
    expectGolden(v.result, 'A2');
    const c = ok(await as(accountant, 'post', comp(0), { fingerprint: v.fingerprint }), 201);
    ok(await as(partner, 'post', `/ct-periods/${periods[0]}/computations/${c.id}/approve`, { notes: 'Reviewed the carry back' }));
    const list = ok(await as(reviewer, 'get', `/ct-periods/${periods[0]}/computations`)).items;
    expect(list.map((x: { status: string; stale: boolean }) => [x.status, x.stale])).toEqual([['APPROVED', false], ['APPROVED', false]]);
    expect(ok(await as(reviewer, 'get', `/ct-periods/${periods[1]}/computations`)).items[0].stale).toBe(false);
    expect(ok(await as(reviewer, 'get', `/ct-periods/${periods[0]}/ct600`))).toMatchObject({ lossCarriedBackFromLaterPeriod: '38177.53', taxableTotalProfits: '81822.47', corporationTaxChargeable: '17932.95',
      financialYears: [expect.objectContaining({ financialYear: 2026, marginalRelief: '622.03' }), expect.objectContaining({ financialYear: 2027, marginalRelief: '1900.64' })] });
    expect(ok(await as(reviewer, 'get', `/ct-periods/${periods[1]}/ct600`)).losses).toEqual({ tradingLossOfPeriod: '38177.53', carriedBack: '38177.53', carriedForward: '0.00' });
  });
  it('a computation whose figures change before approval is refused; stored computations never change', async () => {
    const v = ok(await as(reviewer, 'get', comp(0)));
    const c = ok(await as(accountant, 'post', comp(0), { fingerprint: v.fingerprint }), 201);
    ok(await as(accountant, 'post', '/journals', { journalDate: '2027-06-30', description: 'A late sale', lines: [{ accountId: acc['4000'], debit: '0', credit: '100.00' }, { accountId: acc['2230'], debit: '100.00', credit: '0' }] }), 201);
    expect((await as(owner, 'post', `/ct-periods/${periods[0]}/computations/${c.id}/approve`, { notes: 'Approving after a change' })).body.code).toBe('computation_changed');
    expect(() => adminSql(`UPDATE ct_computation SET carry_back = 1 WHERE id = '${c.id}'`)).toThrow(/never changed/);
    expect(() => adminSql(`DELETE FROM ct_computation WHERE id = '${c.id}'`)).toThrow(/not permitted/);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE company_id = '${company.id}' AND action LIKE 'ct.computation_%'`))
      .toBe('ct.computation_prepared,ct.computation_approved,ct.computation_prepared,ct.computation_approved,ct.computation_prepared,ct.computation_approved,ct.computation_prepared');
  });
});
