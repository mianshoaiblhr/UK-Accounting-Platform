import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, type Stack, type TestUser } from '../helpers/stack';

/**
 * V4-M2 (DEC-099) through the public API: account adjustment rules (company data, verified by a second person), manual adjustments with evidence
 * (withdrawn, never removed) and the profit of a CT period adjusted for tax, read from the ledger, against the hand-worked golden
 * tests/golden/v4-m2-adjusted-profit.json (docs/architecture/v4-m2-golden-workings.xlsx). Synthetic data only.
 */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v4-m2-adjusted-profit.json'), 'utf8'));
const SOURCE = { url: 'https://example.invalid/synthetic-ct', provision: 'Synthetic Corporation Tax provision (test fixture)', retrievedOn: '2026-01-01' };
let s: Stack;
let owner: TestUser, admin: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
let periodId: string, evidence: string;
const ruleIds: Record<string, string> = {};
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, `/companies/${company.id}${p}`)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  admin = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  company = await makeCompany(s, owner, 'Synthetic Adjustments Ltd');
  for (const a of ok(await as(owner, 'post', '/accounts/initialise'), 201).items) acc[a.code] = a.id;
  for (const y of ['2026', '2027']) ok(await as(owner, 'post', '/periods', { startDate: `${y}-01-01`, endDate: `${y}-12-31` }), 201);
  for (const j of G.journals) {
    const lines = [{ accountId: acc[j.account], debit: j.debit, credit: j.credit }, { accountId: acc['2230'], debit: j.credit, credit: j.debit }];
    ok(await as(accountant, 'post', '/journals', { journalDate: j.date, description: j.description, lines }), 201);
  }
  const std = ok(await as(owner, 'post', '/reporting-standards', { code: 'SYN-CTA', name: 'Synthetic standard' }), 201).id;
  const ver = ok(await as(owner, 'post', `/reporting-standards/${std}/versions`, { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: SOURCE }), 201).id;
  ok(await as(accountant, 'put', '/reporting-frameworks', { ...G.year, versionId: ver, entitySize: 'MICRO', reason: 'Synthetic year for adjustments' }));
  const rule = ok(await as(accountant, 'post', '/ct-rules', { kind: 'PERIOD_MAX_MONTHS', effectiveFrom: '2020-04-01', parameters: { months: 12 }, source: SOURCE }), 201).id;
  ok(await as(owner, 'post', `/ct-rules/${rule}/verify`, { notes: 'Checked the synthetic period rule' }));
  periodId = ok(await as(accountant, 'post', '/ct-periods/derive', { yearStart: G.year.yearStart })).items[0].id;
  evidence = (await uploadDoc(s, owner, { companyId: company.id, name: 'synthetic-evidence.pdf' })).documentId;
}, 120_000);
afterAll(() => s.stop());

describe('account adjustment rules', () => {
  it('ct:prepare enters a rule for an income or expense account (UNVERIFIED); a reviewer may not; other accounts are refused', async () => {
    const r0 = G.rules[0];
    expect((await as(reviewer, 'post', '/ct-adjustment-rules', { ...r0, accountId: acc[r0.account], account: undefined })).status).toBe(403);
    expect((await as(accountant, 'post', '/ct-adjustment-rules', { accountId: acc['1200'], category: 'OTHER', percentage: '100', effectiveFrom: '2020-01-01', reason: 'A bank account on purpose' })).body.code).toBe('account_not_profit_and_loss');
    expect((await as(accountant, 'post', '/ct-adjustment-rules', { accountId: acc['7100'], category: 'OTHER', percentage: '100', effectiveFrom: '2020-01-01', reason: 'The tax charge on purpose' })).body.code).toBe('account_not_profit_and_loss');
    for (const { account, ...r } of G.rules) {
      const x = ok(await as(accountant, 'post', '/ct-adjustment-rules', { ...r, accountId: acc[account] }), 201);
      expect(x).toMatchObject({ accountId: acc[account], verificationStatus: 'UNVERIFIED', enteredByUserId: accountant.userId });
      ruleIds[account] = x.id;
    }
    expect((await as(accountant, 'post', '/ct-adjustment-rules', { accountId: acc['8000'], category: 'OTHER', percentage: '50', effectiveFrom: '2027-01-01', reason: 'Overlapping on purpose' })).body.code).toBe('adjustment_rule_overlap');
    expect(ok(await as(reviewer, 'get', '/ct-adjustment-rules')).items).toHaveLength(G.rules.length);
  });
  it('manual adjustments need evidence of the company; one is withdrawn with a reason and kept', async () => {
    const other = await makeCompany(s, owner, 'Synthetic Other Ltd');
    const foreign = (await uploadDoc(s, owner, { companyId: other.id })).documentId;
    const [m0, m1] = G.manual;
    const path = `/ct-periods/${periodId}/adjustments`;
    expect((await as(accountant, 'post', path, { ...m0, evidenceDocumentId: foreign })).body.code).toBe('invalid_evidence');
    expect((await as(reviewer, 'post', path, { ...m0, evidenceDocumentId: evidence })).status).toBe(403);
    ok(await as(accountant, 'post', path, { ...m0, evidenceDocumentId: evidence }), 201);
    const { withdraw, ...m1body } = m1;
    const w = ok(await as(accountant, 'post', path, { ...m1body, evidenceDocumentId: evidence }), 201);
    const done = ok(await as(accountant, 'post', `${path}/${w.id}/withdraw`, { reason: withdraw }));
    expect(done.withdrawn).toMatchObject({ byUserId: accountant.userId, reason: withdraw });
    expect((await as(accountant, 'post', `${path}/${w.id}/withdraw`, { reason: withdraw })).body.code).toBe('adjustment_withdrawn');
    expect(ok(await as(reviewer, 'get', path)).items).toHaveLength(2);
    expect(() => adminSql(`UPDATE ct_adjustment SET amount = 1 WHERE id = '${w.id}'`)).toThrow(/never changed/);
    expect(() => adminSql(`DELETE FROM ct_adjustment WHERE id = '${w.id}'`)).toThrow(/not permitted/);
  });
});

describe('the adjusted profit of the period (golden)', () => {
  it('matches the hand workings; unverified rules and unset associated companies are listed as problems', async () => {
    const st = ok(await as(reviewer, 'get', `/ct-periods/${periodId}/adjusted-profit`));
    expect(st).toMatchObject({ startDate: G.year.yearStart, endDate: G.year.yearEnd, currency: 'GBP', accountingProfit: G.expected.accountingProfit,
      totalAdded: G.expected.totalAdded, totalDeducted: G.expected.totalDeducted, adjustedProfit: G.expected.adjustedProfit });
    const rules = st.adjustments.filter((a: { source: string }) => a.source === 'RULE');
    expect(rules.map((a: { account: { code: string }; direction: string; amount: string }) => ({ account: a.account.code, direction: a.direction, amount: a.amount })))
      .toEqual(expect.arrayContaining(G.expected.ruleAdjustments));
    expect(rules).toHaveLength(G.expected.ruleAdjustments.length);
    const prof = rules.find((a: { account: { code: string } }) => a.account.code === '6600');
    expect(prof.drilldown).toEqual({ accountId: acc['6600'], from: '2027-07-01', to: '2027-12-31', excludeClosing: true });
    const manual = st.adjustments.filter((a: { source: string }) => a.source === 'MANUAL');
    expect(manual).toEqual([expect.objectContaining({ direction: 'ADD', amount: '350.00', evidenceDocumentId: evidence })]);
    expect(st.problems).toHaveLength(G.rules.length + 1);
    expect(st.problems.at(-1)).toMatch(/associated companies/);
    expect(st.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it('once the rules are verified by a second person and associated companies are set, nothing needs attention; the figures are unchanged', async () => {
    expect((await as(accountant, 'post', `/ct-adjustment-rules/${ruleIds['8000']}/verify`, { notes: 'Checked against the synthetic ledger' })).status).toBe(403);
    for (const id of Object.values(ruleIds)) ok(await as(admin, 'post', `/ct-adjustment-rules/${id}/verify`, { notes: 'Checked against the synthetic ledger' }));
    ok(await as(accountant, 'post', `/ct-periods/${periodId}/associated-companies`, { associatedCompanies: 0, reason: 'No associated companies (synthetic)' }));
    const st = ok(await as(reviewer, 'get', `/ct-periods/${periodId}/adjusted-profit`));
    expect(st).toMatchObject({ adjustedProfit: G.expected.adjustedProfit, problems: [] });
  });
  it('a superseded rule gives way to its new version (UNVERIFIED again); the database keeps rules as entered', async () => {
    const n = ok(await as(accountant, 'post', `/ct-adjustment-rules/${ruleIds['6600']}/supersede`, { category: 'LEGAL_PROFESSIONAL', percentage: '50', effectiveFrom: '2027-07-01', reason: 'Half of the fees are capital' }), 201);
    expect(n).toMatchObject({ accountId: acc['6600'], percentage: '50.00', verificationStatus: 'UNVERIFIED' });
    const st = ok(await as(reviewer, 'get', `/ct-periods/${periodId}/adjusted-profit`));
    expect(st.adjustedProfit).toBe('28350.00');
    expect(st.problems).toEqual([expect.stringMatching(/6600 .* has not been verified/)]);
    expect(() => adminSql(`UPDATE ct_adjustment_rule SET percentage = 10 WHERE id = '${n.id}'`)).toThrow(/immutable/);
    expect(() => adminSql(`DELETE FROM ct_adjustment_rule WHERE id = '${n.id}'`)).toThrow(/not permitted/);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${ruleIds['6600']}'`)).toMatch(/ct.adjustment_rule_added.*ct.adjustment_rule_verified.*ct.adjustment_rule_superseded/);
  });
});
