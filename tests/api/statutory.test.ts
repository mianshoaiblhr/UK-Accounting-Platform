import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/**
 * V2-M1 through the public API (v2-plan 3.5): a standard version authored and verified by different people, the golden micro-entity trial balance
 * (DEC-054) reproduced to the cent with its comparative, an override moving an account between lines, a broken map failing its validation rule,
 * immutability after verification, the grammar refused at write time, permissions and tenancy. Synthetic data and a synthetic standard only.
 */
type Golden = {
  company: { periods: [string, string][] };
  postings: ({ kind: 'cash'; date: string; direction: string; bank: string; lines: [string, string][]; description: string } | { kind: 'journal'; date: string; description: string; lines: [string, string, string][] })[];
  standard: { code: string; name: string };
  version: { label: string; effectiveFrom: string; source: object; lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][]; validationRules: Record<string, unknown>[]; disclosureRules: Record<string, unknown>[] };
  frameworks: { yearStart: string; yearEnd: string; entitySize: string; reason: string }[];
  expected: {
    yearStart: string; profitAndLoss: Record<string, [string, string]>; balanceSheet: Record<string, [string, string]>; accountsOnLines: Record<string, [string, string][]>; validations: Record<string, boolean>;
    override: { account: string; to: string; 'P.T': string; 'P.OI': string; 'P.PROFIT': string };
    brokenMap: { remove: [string, string | null]; unplaced: [string, string][]; comparativeUnplaced: [string, string][]; 'B.CA1': string; 'B.NA': string; 'B.CR': string; balanceSheetDifference: string };
    earlierYear: { yearStart: string; 'B.NA': string; 'P.PROFIT': string };
  };
  alternative: { standard: { code: string; name: string }; version: Golden['version']; expected: { profitAndLoss: Record<string, [string, string]>; balanceSheet: Record<string, [string, string]> } };
};
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m1-micro-synthetic.json'), 'utf8')) as Golden;

let s: Stack;
let owner: TestUser, author: TestUser, partner: TestUser, accountant: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'patch' | 'put' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
let standardId: string, versionId: string;
const lineIds: Record<string, string> = {};
const mapIds: Record<string, string> = {};
const preview = async (u = reviewer, yearStart = G.expected.yearStart) => { const r = await as(u, 'get', c(`/statutory-preview?yearStart=${yearStart}`)); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
const lineOf = (p: { statements: { profitAndLoss: { key: string }[]; balanceSheet: { key: string }[] } }, key: string) =>
  [...p.statements.profitAndLoss, ...p.statements.balanceSheet].find((l) => l.key === key) as { key: string; amount: string; comparative?: string; accounts?: { code: string; amount: string; drilldown: object }[] };

beforeAll(async () => {
  s = await startStack({ FEATURE_FLAG_DEFAULTS: 'bookkeeping.core=true,accounts.production=true' });
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Golden Micro Ltd');
  author = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.company.periods) expect((await as(owner, 'post', c('/periods'), { startDate, endDate })).status).toBe(201);
  for (const a of (await as(owner, 'post', c('/accounts/initialise'))).body.items) acc[a.code] = a.id;
  for (const p of G.postings) {
    const r = p.kind === 'cash'
      ? await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc[p.bank], description: p.description, lines: p.lines.map(([code, amount]) => ({ description: p.description, accountId: acc[code], amount })) })
      : await as(accountant, 'post', c('/journals'), { journalDate: p.date, description: p.description, lines: p.lines.map(([code, debit, credit]) => ({ accountId: acc[code], debit, credit })) });
    expect(r.status, `${p.date} ${p.description}: ${JSON.stringify(r.body)}`).toBe(201);
  }
});
afterAll(() => s.stop());

describe('authoring a standard version (accounts:rules-manage, while unverified)', () => {
  it('a standard and a sourced version are created; only rules managers may; nothing is seeded', async () => {
    expect((await as(reviewer, 'get', c('/reporting-standards'))).body).toEqual({ items: [] });
    expect((await as(accountant, 'post', c('/reporting-standards'), G.standard)).status).toBe(403);
    const st = await as(author, 'post', c('/reporting-standards'), G.standard);
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    standardId = st.body.id;
    expect((await as(author, 'post', c('/reporting-standards'), G.standard)).status).toBe(409);
    expect((await as(author, 'post', c('/reporting-standards'), { code: 'lower', name: 'x' })).status).toBe(422);
    const v = await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: G.version.label, effectiveFrom: G.version.effectiveFrom, source: G.version.source });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body).toMatchObject({ status: 'UNVERIFIED', createdByUserId: author.userId, lines: [], problems: ['The version has no statement lines'] });
    versionId = v.body.id;
    // a second current version overlapping it is refused
    expect((await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Overlap', effectiveFrom: '2026-01-01', source: G.version.source })).body.code).toBe('version_overlap');
  });
  it('lines, map entries, rules and a disclosure are added; the grammar and line references are checked when written', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    for (const l of G.version.lines) {
      const r = await as(author, 'post', `${v}/lines`, l);
      expect(r.status, `${l.key as string}: ${JSON.stringify(r.body)}`).toBe(201);
      lineIds[l.key as string] = r.body.id;
    }
    expect((await as(author, 'post', `${v}/lines`, G.version.lines[0])).body.code).toBe('content_exists');
    expect((await as(author, 'post', `${v}/lines`, { key: 'X.BAD', statement: 'PL', name: 'Bad', kind: 'TOTAL', naturalSide: 'DEBIT', formula: [{ line: 'P.T', sign: 1 }] })).status).toBe(422);
    expect((await as(author, 'post', `${v}/lines`, { key: 'X.BAD', statement: 'PL', name: 'Bad', kind: 'TOTAL', formula: [{ line: 'NOPE', sign: 1 }] })).body.code).toBe('unknown_line');
    // a total may not come to depend on itself
    expect((await as(author, 'patch', `${v}/lines/${lineIds['B.NCA']}`, { formula: [{ line: 'B.TALCL', sign: 1 }] })).body.code).toBe('total_cycle');
    for (const [sourceLine, accountSubtype, targetKey] of G.version.mapEntries) {
      const r = await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey });
      expect(r.status, `${sourceLine}: ${JSON.stringify(r.body)}`).toBe(201);
      mapIds[`${sourceLine}|${accountSubtype ?? ''}`] = r.body.id;
    }
    expect((await as(author, 'post', `${v}/map-entries`, { sourceLine: 'PL.TURNOVER', targetKey: 'P.OI' })).body.code).toBe('content_exists');
    expect((await as(author, 'post', `${v}/map-entries`, { sourceLine: 'PL.NOT_A_LINE', targetKey: 'P.T' })).status).toBe(422);
    expect((await as(author, 'post', `${v}/map-entries`, { sourceLine: 'BS.CAPITAL.RESERVES', accountSubtype: 'DIVIDENDS', targetKey: 'P.PROFIT' })).body.code).toBe('unknown_line');
    for (const r of G.version.validationRules) expect((await as(author, 'post', `${v}/validation-rules`, r)).status).toBe(201);
    for (const [expression, why] of [
      [{ mul: [{ line: 'P.T' }, { const: '2' }] }, 'unknown construct'],
      [{ eq: [{ line: 'P.NOPE' }, { const: '0' }] }, 'not a line of this version'],
      [{ line: 'P.T' }, 'a value is not a condition'],
      [{ eq: [{ const: 1 }, { const: '0' }] }, 'a decimal string'],
      [{ ge: [{ line: 'P.T' }, { const: '0' }], tolerance: '-1' }, 'non-negative'],
    ] as const) {
      const r = await as(author, 'post', `${v}/validation-rules`, { key: 'BAD', description: 'Refused', expression });
      expect(r.body.code, why).toBe('invalid_expression');
      expect(JSON.stringify(r.body.errors.problems)).toContain(why);
    }
    for (const d of G.version.disclosureRules) expect((await as(author, 'post', `${v}/disclosure-rules`, d)).status).toBe(201);
    expect((await as(author, 'post', `${v}/disclosure-rules`, { key: 'BAD', title: 'Refused', requires: { lines: ['NOPE'] } })).body.code).toBe('unknown_line');
    expect((await as(author, 'post', `${v}/disclosure-rules`, { key: 'BAD', title: 'Refused', requires: { other: [] } })).status).toBe(422);
    // a line in use cannot be removed; an unused one can, and its key is free again
    expect((await as(author, 'delete', `${v}/lines/${lineIds['P.T']}`)).body.code).toBe('line_in_use');
    const spare = await as(author, 'post', `${v}/lines`, { key: 'P.SPARE', statement: 'PL', sort: 99, name: 'Spare', kind: 'ACCOUNTS', naturalSide: 'DEBIT' });
    expect((await as(author, 'delete', `${v}/lines/${spare.body.id}`)).body).toEqual({ id: spare.body.id, removed: true });
    const detail = (await as(reviewer, 'get', v)).body;
    expect(detail.lines.map((l: { key: string }) => l.key).sort()).toEqual(G.version.lines.map((l) => l.key as string).sort());
    expect(detail).toMatchObject({ status: 'UNVERIFIED', problems: [] });
    expect(detail.mapEntries).toHaveLength(G.version.mapEntries.length);
  });
});

describe('the framework of each year (accounts:prepare) and the preview before verification', () => {
  it('each financial year chooses the version and entity size; overlap, dates out of effect and missing permissions are refused', async () => {
    for (const f of G.frameworks) {
      const r = await as(accountant, 'put', c('/reporting-frameworks'), { ...f, versionId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ yearStart: f.yearStart, entitySize: f.entitySize, version: { status: 'UNVERIFIED' } });
    }
    expect((await as(reviewer, 'put', c('/reporting-frameworks'), { ...G.frameworks[0], versionId })).status).toBe(403);
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2025-06-01', yearEnd: '2026-05-31', versionId, entitySize: 'MICRO', reason: 'Overlapping year' })).body.code).toBe('financial_year_overlap');
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2024-01-01', yearEnd: '2024-12-31', versionId, entitySize: 'MICRO', reason: 'Before the version' })).body.code).toBe('version_not_effective');
    expect((await as(reviewer, 'get', c('/reporting-frameworks'))).body.items).toHaveLength(2);
  });
  it('a preview from the unverified version is computed but says on its face that it is only a preview', async () => {
    const p = await preview();
    expect(p.verified).toBe(false);
    expect(p.notices[0]).toMatch(/^PREVIEW ONLY/);
  });
});

describe('verification by a second person (DEC-052)', () => {
  it('the author cannot verify; a partner (no accounts:rule-verify) cannot; an inconsistent version cannot be verified', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    expect((await as(author, 'post', `${v}/verify`, { notes: 'Checked against the synthetic layout' })).body.code).toBe('self_verification_not_allowed');
    expect((await as(partner, 'post', `${v}/verify`, { notes: 'Checked against the synthetic layout' })).status).toBe(403);
    const orphan = await as(author, 'post', `${v}/lines`, { key: 'P.ORPHAN', statement: 'PL', parentKey: 'P.MISSING', sort: 99, name: 'Orphan', kind: 'ACCOUNTS', naturalSide: 'DEBIT' });
    const bad = await as(owner, 'post', `${v}/verify`, { notes: 'Checked against the synthetic layout' });
    expect(bad.body.code).toBe('version_inconsistent');
    expect(bad.body.errors.problems).toEqual(['Line P.ORPHAN: parent P.MISSING is not a line of this version']);
    expect((await as(author, 'delete', `${v}/lines/${orphan.body.id}`)).status).toBe(200);
  });
  it('the owner verifies; the version and its content are then immutable (service and database); verifying again is refused', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    const ok = await as(owner, 'post', `${v}/verify`, { notes: 'Checked against the synthetic layout' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'VERIFIED', verifiedByUserId: owner.userId, createdByUserId: author.userId });
    expect((await as(owner, 'post', `${v}/verify`, { notes: 'Checked against the synthetic layout' })).body.code).toBe('already_verified');
    expect((await as(author, 'post', `${v}/lines`, { key: 'P.LATE', statement: 'PL', name: 'Late', kind: 'ACCOUNTS', naturalSide: 'DEBIT' })).body.code).toBe('version_not_editable');
    expect((await as(author, 'patch', `${v}/map-entries/${mapIds['PL.TURNOVER|']}`, { targetKey: 'P.OI' })).body.code).toBe('version_not_editable');
    expect((await as(author, 'patch', v, { label: 'Renamed' })).body.code).toBe('version_not_editable');
    expect((await as(author, 'delete', `${v}/lines/${lineIds['P.TAX']}`)).body.code).toBe('version_not_editable');
    // the database refuses the same changes even from the runtime role, bypassing the service
    const org = owner.organisationId;
    const asApp = (sql: string) => adminSql(`SET ROLE uk_app; SELECT set_config('app.organisation_id','${org}',false); ${sql}`);
    expect(() => asApp(`UPDATE statutory_line SET name = 'Changed' WHERE id = '${lineIds['P.T']}'`)).toThrow(/verified and its content cannot change/);
    expect(() => asApp(`UPDATE reporting_standard_version SET label = 'Changed' WHERE id = '${versionId}'`)).toThrow(/immutable/);
    const audit = adminSql(`SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_event WHERE entity_id = '${versionId}'`);
    expect(audit).toContain('accounts.standard_version_verified');
  });
});

describe('the golden micro-entity trial balance (DEC-054)', () => {
  it('reproduces the hand-written P&L and balance sheet to the cent, with the comparative, proofs and validations', async () => {
    const p = await preview();
    expect(p).toMatchObject({ verified: true, year: { start: '2026-01-01', end: '2026-12-31', entitySize: 'MICRO' }, comparative: { start: '2025-01-01', end: '2025-12-31', fromFramework: true },
      standard: { code: G.standard.code }, version: { id: versionId, status: 'VERIFIED' }, unplacedAccounts: [], comparativeUnplacedAccounts: [], problems: [] });
    expect(p.notices.join(' ')).not.toMatch(/PREVIEW ONLY/);
    const got = (stmt: { key: string; amount: string; comparative: string }[]) => Object.fromEntries(stmt.map((l) => [l.key, [l.amount, l.comparative]]));
    expect(got(p.statements.profitAndLoss)).toEqual(G.expected.profitAndLoss);
    expect(got(p.statements.balanceSheet)).toEqual(G.expected.balanceSheet);
    // statement order and nesting come from the data
    expect(p.statements.balanceSheet.map((l: { key: string; depth: number }) => `${l.key}:${l.depth}`)).toEqual(['B.FA:0', 'B.CA:0', 'B.PREPAY:0', 'B.CW:0', 'B.NCA:0', 'B.TALCL:0', 'B.CA1:0', 'B.ACCR:0', 'B.NA:0', 'B.CR:0', 'B.SC:1', 'B.RES:1', 'B.PLR:1']);
    for (const [key, accounts] of Object.entries(G.expected.accountsOnLines)) expect(lineOf(p, key).accounts!.map((a) => [a.code, a.amount]), key).toEqual(accounts);
    expect(lineOf(p, 'P.OI').accounts![0]!.drilldown).toEqual({ accountId: acc['4100'], from: '2026-01-01', to: '2026-12-31' });
    expect(lineOf(p, 'B.CW').accounts![0]!.drilldown).toEqual({ accountId: acc['2220'], from: null, to: '2026-12-31' });
    expect(Object.fromEntries(p.validations.map((v: { key: string; passed: boolean }) => [v.key, v.passed]))).toEqual(G.expected.validations);
    expect(p.validationSummary).toEqual({ errors: 0, warnings: 0 });
    expect(p.reconciliation).toMatchObject({
      profitAndLoss: { profitFromLedger: '13180.00', profitFromLines: '13180.00', reconciled: true }, balanceSheet: { difference: '0.00', balanced: true }, trialBalance: { balanced: true },
      comparative: { profitAndLoss: { profitFromLedger: '7800.00', reconciled: true }, balanceSheet: { balanced: true } },
    });
    // the M8 management statements agree with the statutory figures (same ledger, different presentation)
    expect((await as(reviewer, 'get', c('/reports/profit-and-loss?from=2026-01-01&to=2026-12-31'))).body.profitForPeriod).toBe(G.expected.profitAndLoss['P.PROFIT']![0]);
    expect((await as(reviewer, 'get', c('/reports/balance-sheet?asOf=2026-12-31'))).body.netAssets).toBe(G.expected.balanceSheet['B.NA']![0]);
  });
  it('an override moves one account between lines for this company (audited, reasoned) and ending it restores the map', async () => {
    const o = G.expected.override;
    expect((await as(reviewer, 'post', c('/statutory-overrides'), { versionId, accountId: acc[o.account], targetKey: o.to, reason: 'Grant income presented as turnover' })).status).toBe(403);
    expect((await as(accountant, 'post', c('/statutory-overrides'), { versionId, accountId: acc[o.account], targetKey: 'P.PROFIT', reason: 'Not an accounts line' })).body.code).toBe('unknown_line');
    const set = await as(accountant, 'post', c('/statutory-overrides'), { versionId, accountId: acc[o.account], targetKey: o.to, reason: 'Grant income presented as turnover' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    const p = await preview();
    expect([lineOf(p, 'P.T').amount, lineOf(p, 'P.OI').amount, lineOf(p, 'P.PROFIT').amount]).toEqual([o['P.T'], o['P.OI'], o['P.PROFIT']]);
    expect(p.overridesApplied).toBe(1);
    expect(adminSql(`SELECT action || '|' || reason FROM audit_event WHERE entity_id = '${set.body.id}'`)).toBe('accounts.override_set|Grant income presented as turnover');
    const end = await as(accountant, 'post', c(`/statutory-overrides/${set.body.id}/end`), { reason: 'Back to the standard map' });
    expect(end.body.endedReason).toBe('Back to the standard map');
    expect((await as(accountant, 'post', c(`/statutory-overrides/${set.body.id}/end`), { reason: 'Again' })).body.code).toBe('override_ended');
    expect(lineOf(await preview(), 'P.T').amount).toBe(G.expected.profitAndLoss['P.T']![0]);
    expect((await as(reviewer, 'get', c('/statutory-overrides?includeEnded=true'))).body.items).toHaveLength(1);
    expect((await as(reviewer, 'get', c('/statutory-overrides'))).body.items).toHaveLength(0);
  });
  it('a second standard with another layout, on the same ledger, gives its own hand-calculated statements when the year switches to it (no code involved)', async () => {
    const A = G.alternative;
    const st = await as(author, 'post', c('/reporting-standards'), A.standard);
    const v = await as(author, 'post', c(`/reporting-standards/${st.body.id}/versions`), { label: A.version.label, effectiveFrom: A.version.effectiveFrom, source: A.version.source });
    const base = c(`/reporting-standard-versions/${v.body.id}`);
    for (const l of A.version.lines) expect((await as(author, 'post', `${base}/lines`, l)).status, l.key as string).toBe(201);
    for (const [sourceLine, accountSubtype, targetKey] of A.version.mapEntries) expect((await as(author, 'post', `${base}/map-entries`, { sourceLine, accountSubtype, targetKey })).status, sourceLine).toBe(201);
    for (const r of A.version.validationRules) expect((await as(author, 'post', `${base}/validation-rules`, r)).status).toBe(201);
    expect((await as(owner, 'post', `${base}/verify`, { notes: 'Checked against the synthetic alternative layout' })).status).toBe(200);
    const [, y2026] = G.frameworks;
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { ...y2026, versionId: v.body.id, reason: 'Compare the alternative layout' })).status).toBe(200);
    const p = await preview();
    const got = (stmt: { key: string; amount: string; comparative: string }[]) => Object.fromEntries(stmt.map((l) => [l.key, [l.amount, l.comparative]]));
    expect(p).toMatchObject({ verified: true, standard: { code: A.standard.code }, unplacedAccounts: [], problems: [], validationSummary: { errors: 0 } });
    expect(got(p.statements.profitAndLoss)).toEqual(A.expected.profitAndLoss);
    expect(got(p.statements.balanceSheet)).toEqual(A.expected.balanceSheet);
    expect(adminSql(`SELECT reason FROM audit_event WHERE action = 'accounts.framework_changed' AND entity_type = 'company_reporting_framework' ORDER BY occurred_at DESC LIMIT 1`)).toBe('Compare the alternative layout');
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { ...y2026, versionId, reason: 'Back to the first layout' })).status).toBe(200);
    expect(lineOf(await preview(), 'P.PROFIT').amount).toBe(G.expected.profitAndLoss['P.PROFIT']![0]);
  });
  it('a change supersedes the verified version; a deliberately broken map in the new version fails net assets = capital and reserves', async () => {
    const b = G.expected.brokenMap;
    expect((await as(author, 'post', c(`/reporting-standard-versions/${versionId}/supersede`), { label: 'Synthetic v2', effectiveFrom: G.version.effectiveFrom, source: G.version.source, reason: 'Short' })).status).toBe(422);
    const sup = await as(author, 'post', c(`/reporting-standard-versions/${versionId}/supersede`), { label: 'Synthetic v2', effectiveFrom: G.version.effectiveFrom, source: G.version.source, reason: 'Test of a broken map (synthetic)' });
    expect(sup.status, JSON.stringify(sup.body)).toBe(201);
    expect(sup.body).toMatchObject({ status: 'UNVERIFIED', copiedFromId: versionId, problems: [] });
    expect(sup.body.lines).toHaveLength(G.version.lines.length);
    const v2 = sup.body.id as string;
    expect((await as(reviewer, 'get', c(`/reporting-standard-versions/${versionId}`))).body).toMatchObject({ status: 'SUPERSEDED', supersededById: v2 });
    expect((await as(author, 'post', c(`/reporting-standard-versions/${versionId}/supersede`), { label: 'Again', effectiveFrom: G.version.effectiveFrom, source: G.version.source, reason: 'A second supersession' })).body.code).toBe('version_superseded');
    expect((await as(author, 'post', c(`/reporting-standard-versions/${v2}/supersede`), { label: 'Again', effectiveFrom: G.version.effectiveFrom, source: G.version.source, reason: 'Superseding an unverified one' })).body.code).toBe('version_unverified');
    const entry = sup.body.mapEntries.find((m: { sourceLine: string; accountSubtype: string | null }) => m.sourceLine === b.remove[0] && m.accountSubtype === b.remove[1]);
    expect((await as(author, 'delete', c(`/reporting-standard-versions/${v2}/map-entries/${entry.id}`))).status).toBe(200);
    const [, y2026] = G.frameworks;
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { ...y2026, versionId: v2, reason: 'Moved to the new version' })).status).toBe(200);
    expect((await as(accountant, 'put', c('/reporting-frameworks'), { ...y2026, versionId, reason: 'Back to the superseded one' })).body.code).toBe('version_superseded');
    const p = await preview();
    expect(p).toMatchObject({ verified: false, version: { id: v2, status: 'UNVERIFIED' } });
    expect(p.unplacedAccounts.map((u: { code: string; net: string; reason: string }) => [u.code, u.net, u.reason])).toEqual(b.unplaced.map(([code, net]) => [code, net, 'unmapped']));
    expect(p.comparativeUnplacedAccounts.map((u: { code: string; net: string }) => [u.code, u.net])).toEqual(b.comparativeUnplaced);
    expect([lineOf(p, 'B.CA1').amount, lineOf(p, 'B.NA').amount, lineOf(p, 'B.CR').amount]).toEqual([b['B.CA1'], b['B.NA'], b['B.CR']]);
    expect(p.validations.find((v: { key: string }) => v.key === 'NA_EQ_CR')).toMatchObject({ passed: false, severity: 'ERROR' });
    expect(p.validationSummary.errors).toBe(1);
    expect(p.reconciliation.balanceSheet).toEqual({ difference: b.balanceSheetDifference, balanced: false });
    // the earlier year keeps the version it was prepared under, and its figures (MAN-ACC-09)
    const e = G.expected.earlierYear;
    const earlier = await preview(reviewer, e.yearStart);
    expect(earlier).toMatchObject({ verified: true, version: { id: versionId, status: 'SUPERSEDED' }, unplacedAccounts: [] });
    expect([lineOf(earlier, 'B.NA').amount, lineOf(earlier, 'P.PROFIT').amount]).toEqual([e['B.NA'], e['P.PROFIT']]);
    expect(earlier.notices.join(' ')).toMatch(/superseded/);
    expect((await as(reviewer, 'get', c('/reporting-frameworks'))).body.items.map((f: { versionId: string }) => f.versionId)).toEqual([versionId, v2]);
  });
});

describe('access', () => {
  it('reading needs ledger:read; another organisation sees nothing; the routes are behind accounts.production', async () => {
    expect((await as(viewer, 'get', c('/reporting-standards'))).status).toBe(403);
    expect((await as(viewer, 'get', c(`/statutory-preview?yearStart=${G.expected.yearStart}`))).status).toBe(403);
    expect((await s.api().get(orgPath(owner, c('/reporting-standards'))).set(bearer(outsider.token))).status).toBe(404);
    const theirs = await makeCompany(s, outsider, 'Other Org Co');
    const other = (p: string) => s.api().get(`/api/v1/organisations/${outsider.organisationId}/companies/${theirs.id}${p}`).set(bearer(outsider.token));
    expect((await other('/reporting-standards')).body).toEqual({ items: [] });
    expect((await other(`/reporting-standard-versions/${versionId}`)).status).toBe(404);
    expect((await other(`/statutory-preview?yearStart=${G.expected.yearStart}`)).body.code).toBe('framework_not_set');
    expect((await s.api().put(`/api/v1/organisations/${outsider.organisationId}/feature-flags/accounts.production`).set(bearer(outsider.token)).send({ enabled: false })).status).toBe(200);
    expect((await other('/reporting-standards')).body.code).toBe('feature_disabled');
  });
});
