import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, type Stack, type TestUser } from '../helpers/stack';

/**
 * V4-M3 (DEC-100) through the public API: capital allowances of two consecutive CT periods from the fixed-asset register's tax fields, against
 * the hand-worked golden tests/golden/v4-m3-capital-allowances.json (docs/architecture/v4-m3-golden-workings.xlsx); opening balances verified
 * by a second person; stored computations chained by period. The rates and limits are test fixtures verified in the test. Synthetic data only.
 */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v4-m3-capital-allowances.json'), 'utf8'));
const SOURCE = { url: 'https://example.invalid/synthetic-ca', provision: 'Synthetic capital allowances provision (test fixture)', retrievedOn: '2026-01-01' };
let s: Stack;
let owner: TestUser, admin: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const assetId: Record<string, string> = {};
const periods: string[] = [];
const ruleIds: Record<string, string> = {};
let evidence: string;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, `/companies/${company.id}${p}`)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const keyOf = (id: string | null) => (id ? Object.entries(assetId).find(([, v]) => v === id)![0] : null);
const shape = (r: any) => ({
  fraction: r.fraction, aia: { available: r.aia.available, claims: r.aia.claims.map((c: any) => [keyOf(c.assetId), c.aia, c.toMainPool]) },
  pools: r.pools.map((p: any) => [p.pool, keyOf(p.assetId), p.opening, p.additions, p.disposals, p.writingDownAllowance, p.balancingAllowance, p.balancingCharge, p.closing])
    .sort((a: any[], b: any[]) => ['MAIN', 'SPECIAL_RATE', 'SINGLE_ASSET'].indexOf(a[0]) - ['MAIN', 'SPECIAL_RATE', 'SINGLE_ASSET'].indexOf(b[0]) || String(a[1]).localeCompare(String(b[1]))),
  totals: r.totals,
});

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  company = await makeCompany(s, owner, 'Synthetic Allowances Ltd');
  for (const a of ok(await as(owner, 'post', '/accounts/initialise'), 201).items) acc[a.code] = a.id;
  acc['6950'] = ok(await as(owner, 'post', '/accounts', { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201).id;
  for (const y of ['2027', '2028']) ok(await as(owner, 'post', '/periods', { startDate: `${y}-01-01`, endDate: `${y}-12-31` }), 201);
  const classId = ok(await as(accountant, 'post', '/fixed-asset-classes', { code: 'PLANT', name: 'Plant', costAccountId: acc['0020'], depreciationAccountId: acc['0021'], expenseAccountId: acc['6900'],
    disposalAccountId: acc['6950'], method: 'STRAIGHT_LINE', lifeMonths: 60, convention: 'MONTHLY' }), 201).id;
  for (const a of G.assets) {
    const before = a.acquiredOn < '2027-01-01';
    const addition = before ? { kind: 'TAKE_ON', takeOnDate: '2026-12-31', accumulatedDepreciation: '0.00' } : { kind: 'POSTED', offsetAccountId: acc['2230'] };
    // A6 starts UNDECIDED so the problem is seen; the test decides it
    const tax = { category: a.key === 'A6' ? 'UNDECIDED' : a.category };
    assetId[a.key] = ok(await as(accountant, 'post', '/fixed-assets', { classId, description: a.description, acquiredOn: a.acquiredOn, cost: a.cost, addition, tax, ...(before ? { lifeMonths: 36 } : {}) }), 201).id;
  }
  for (const d of G.disposals) ok(await as(accountant, 'post', `/fixed-assets/${assetId[d.asset]}/dispose`, { disposedOn: d.disposedOn, proceeds: d.proceeds, proceedsAccountId: acc['1110'], reason: 'Sold (synthetic)' }));
  const std = ok(await as(owner, 'post', '/reporting-standards', { code: 'SYN-CA', name: 'Synthetic standard' }), 201).id;
  const ver = ok(await as(owner, 'post', `/reporting-standards/${std}/versions`, { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: SOURCE }), 201).id;
  for (const y of G.years) ok(await as(accountant, 'put', '/reporting-frameworks', { ...y, versionId: ver, entitySize: 'MICRO', reason: 'Synthetic year for allowances' }));
  const rule = async (kind: string, parameters: object) => { ruleIds[kind] = ok(await as(accountant, 'post', '/ct-rules', { kind, effectiveFrom: '2020-01-01', parameters, source: SOURCE }), 201).id; };
  await rule('PERIOD_MAX_MONTHS', { months: 12 });
  ok(await as(owner, 'post', `/ct-rules/${ruleIds.PERIOD_MAX_MONTHS}/verify`, { notes: 'Checked the synthetic period rule' }));
  for (const y of G.years) periods.push(ok(await as(accountant, 'post', '/ct-periods/derive', { yearStart: y.yearStart })).items[0].id);
  await rule('AIA_LIMIT', { annualLimit: G.rules.aiaLimit });
  await rule('WDA_RATES', { mainRate: G.rules.mainRate, specialRate: G.rules.specialRate });
  await rule('SMALL_POOL_LIMIT', { limit: G.rules.smallPoolLimit });
  evidence = (await uploadDoc(s, owner, { companyId: company.id, name: 'prior-computation.pdf' })).documentId;
}, 180_000);
afterAll(() => s.stop());

const ca = (n: number) => `/ct-periods/${periods[n]}/capital-allowances`;

describe('rules and opening balances', () => {
  it('the computation is refused while a rule it needs is unverified', async () => {
    expect((await as(reviewer, 'get', ca(0))).body.code).toBe('ct_rule_unverified');
    for (const k of ['AIA_LIMIT', 'WDA_RATES', 'SMALL_POOL_LIMIT']) ok(await as(owner, 'post', `/ct-rules/${ruleIds[k]}/verify`, { notes: 'Checked the synthetic fixture' }));
  });
  it('without opening balances, and with an undecided asset, the problems say so', async () => {
    const v = ok(await as(reviewer, 'get', ca(0)));
    expect(v.problems).toEqual(expect.arrayContaining([expect.stringMatching(/main pool at 2026-12-31/), expect.stringMatching(/special rate pool at 2026-12-31/), expect.stringMatching(/Artwork .* no tax category/)]));
    ok(await as(accountant, 'post', `/fixed-assets/${assetId.A6}/tax`, { category: 'NOT_QUALIFYING', reason: 'A painting is not plant (synthetic)' }));
  });
  it('openings are entered with evidence (ct:prepare), one current per pool and date, and verified by a second person', async () => {
    const asOf = G.openings.asOf;
    expect((await as(reviewer, 'post', '/ca-pool-openings', { pool: 'MAIN', asOf, amount: G.openings.MAIN, evidenceDocumentId: evidence, reason: 'From the 2026 computation' })).status).toBe(403);
    expect((await as(accountant, 'post', '/ca-pool-openings', { pool: 'SINGLE_ASSET', asOf, amount: '1.00', evidenceDocumentId: evidence, reason: 'No asset on purpose' })).status).toBe(422);
    const ids = [
      ok(await as(accountant, 'post', '/ca-pool-openings', { pool: 'MAIN', asOf, amount: G.openings.MAIN, evidenceDocumentId: evidence, reason: 'From the 2026 computation' }), 201).id,
      ok(await as(accountant, 'post', '/ca-pool-openings', { pool: 'SPECIAL_RATE', asOf, amount: '1999.00', evidenceDocumentId: evidence, reason: 'From the 2026 computation' }), 201).id,
      ...(await Promise.all(G.openings.single.map(async (o: { asset: string; amount: string }) => ok(await as(accountant, 'post', '/ca-pool-openings', { pool: 'SINGLE_ASSET', assetId: assetId[o.asset], asOf, amount: o.amount, evidenceDocumentId: evidence, reason: 'From the 2026 computation' }), 201).id))),
    ];
    expect((await as(accountant, 'post', '/ca-pool-openings', { pool: 'MAIN', asOf, amount: '1.00', evidenceDocumentId: evidence, reason: 'A second one on purpose' })).body.code).toBe('pool_opening_exists');
    const fixed = ok(await as(accountant, 'post', `/ca-pool-openings/${ids[1]}/supersede`, { amount: G.openings.SPECIAL_RATE, evidenceDocumentId: evidence, reason: 'The special rate pool was mistyped' }), 201);
    ids[1] = fixed.id;
    expect((await as(accountant, 'post', `/ca-pool-openings/${ids[0]}/verify`, { notes: 'Agreed to the 2026 computation' })).status).toBe(403);
    expect(ok(await as(reviewer, 'get', ca(0))).problems).toHaveLength(3);
    for (const id of ids) ok(await as(admin, 'post', `/ca-pool-openings/${id}/verify`, { notes: 'Agreed to the 2026 computation' }));
    expect(() => adminSql(`UPDATE ca_pool_opening SET amount = 1 WHERE id = '${ids[0]}'`)).toThrow(/immutable/);
  });
});

describe('two periods (golden)', () => {
  it('the 12-month period equals the hand workings and is stored only as read', async () => {
    const v = ok(await as(reviewer, 'get', ca(0)));
    expect(v.problems).toEqual([]);
    expect(shape(v.computation)).toEqual(G.expected[0]);
    expect(v.openingsFrom.kind).toBe('OPENING_BALANCES');
    expect(v.notQualifying.map((a: { assetId: string }) => keyOf(a.assetId))).toEqual(['A6']);
    expect(v.computation.disposals.find((d: { assetId: string }) => keyOf(d.assetId) === 'D1')).toMatchObject({ pool: 'MAIN', disposalValue: '2500.00' });
    expect((await as(accountant, 'post', ca(0), { fingerprint: '0'.repeat(64) })).body.code).toBe('fingerprint_mismatch');
    expect((await as(reviewer, 'post', ca(0), { fingerprint: v.fingerprint })).status).toBe(403);
    const c = ok(await as(accountant, 'post', ca(0), { fingerprint: v.fingerprint }), 201);
    expect(c).toMatchObject({ periodId: periods[0], priorComputationId: null, fingerprint: v.fingerprint, stale: false });
  });
  it('the 182-day period opens from the stored computation and equals the hand workings', async () => {
    const v = ok(await as(reviewer, 'get', ca(1)));
    expect(v.problems).toEqual([]);
    expect(v.openingsFrom).toMatchObject({ kind: 'PRIOR_COMPUTATION', periodId: periods[0] });
    expect(shape(v.computation)).toEqual(G.expected[1]);
    expect(v.computation.pools.find((p: { pool: string }) => p.pool === 'SPECIAL_RATE').smallPool).toBe(true);
    ok(await as(accountant, 'post', ca(1), { fingerprint: v.fingerprint }), 201);
  });
  it('storing the first period again supersedes it and marks the second as stale; stored computations never change', async () => {
    const v = ok(await as(reviewer, 'get', ca(0)));
    ok(await as(accountant, 'post', ca(0), { fingerprint: v.fingerprint }), 201);
    const first = ok(await as(reviewer, 'get', `${ca(0)}/computations`)).items;
    expect(first).toHaveLength(2);
    expect(first[1].supersededById).toBe(first[0].id);
    const second = ok(await as(reviewer, 'get', `${ca(1)}/computations`)).items;
    expect(second[0].stale).toBe(true);
    expect(() => adminSql(`UPDATE ca_computation SET fingerprint = '${'1'.repeat(64)}' WHERE id = '${second[0].id}'`)).toThrow(/never changed/);
    expect(() => adminSql(`DELETE FROM ca_computation WHERE id = '${second[0].id}'`)).toThrow(/not permitted/);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action = 'ca.computation_stored' AND company_id = '${company.id}'`)).toBe('3');
  });
  it('a change of limit inside a period is refused', async () => {
    const n = ok(await as(accountant, 'post', `/ct-rules/${ruleIds.AIA_LIMIT}/supersede`, { kind: 'AIA_LIMIT', effectiveFrom: '2020-01-01', effectiveTo: '2028-03-31', parameters: { annualLimit: G.rules.aiaLimit }, source: SOURCE, reason: 'The synthetic limit ends in March 2028' }), 201);
    ok(await as(owner, 'post', `/ct-rules/${n.id}/verify`, { notes: 'Checked the synthetic fixture' }));
    ok(await as(accountant, 'post', '/ct-rules', { kind: 'AIA_LIMIT', effectiveFrom: '2028-04-01', parameters: { annualLimit: '500000' }, source: SOURCE }), 201);
    expect((await as(reviewer, 'get', ca(1))).body.code).toBe('ca_rule_change_in_period');
  });
});
