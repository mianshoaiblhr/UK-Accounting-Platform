import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V2-M5c through the public API (v2-plan 5g.4): the golden cash flow statement (DEC-054, DEC-067) matched exactly, the content verified and frozen, an unplaced account, the accounts document, permissions and tenancy. Synthetic data and synthetic captions only. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m5c-cash-flow.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
const CF = G.cashFlow, E = G.expected;

let s: Stack;
let owner: TestUser, author: TestUser, verifier: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string };
let versionId: string;
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const statement = async (yearStart: string, compare = true, u = reviewer) => ok(await as(u, 'get', c(`/cash-flow?yearStart=${yearStart}&compare=${compare}`)));
const lines = (st: any) => st.sections.flatMap((x: any) => x.lines.map((l: any) => ({ ...l, section: x.section })));

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, G.company.name);
  author = await addMember(s, owner, 'admin');
  verifier = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const a of G.accounts) acc[a.code] = ok(await as(owner, 'post', c('/accounts'), a), 201).id;
  const posts = [...G.cash.map((p: any) => ({ ...p, kind: 'cash' })), ...G.journals.map((j: any) => ({ ...j, kind: 'journal' }))].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  for (const p of posts) {
    if (p.kind === 'cash') ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description,
      lines: p.lines.map(([k, amount]: string[]) => ({ description: p.description, accountId: acc[k!], amount })) }), 201);
    else ok(await as(accountant, 'post', c('/journals'), { journalDate: p.date, description: p.description, lines: p.lines.map(([k, debit, credit]: string[]) => ({ accountId: acc[k!], debit, credit })) }), 201);
  }
  for (const [yearStart, yearEnd] of G.closes) ok(await as(accountant, 'post', c('/year-end-closes'), { yearStart, yearEnd }), 201);
  // a synthetic version: the V2-M1 golden lines and map
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-CF', name: 'Synthetic cash flow standard' }), 201).id;
  versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic CF v1', effectiveFrom: '2020-01-01',
    source: { url: 'https://example.test/synthetic-cash-flow', provision: 'Synthetic test content (not FRS 102)', retrievedOn: '2026-10-20' } }), 201).id;
  const v = c(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
});
afterAll(() => s.stop());

describe('cash-flow content (DEC-067)', () => {
  it('the author writes classes, the map and captions; shapes, targets and cash are checked; only rules managers may write', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    expect((await as(author, 'post', `${v}/cash-flow-classes`, { key: 'X', section: 'OPERATING', name: 'Bad', adjustmentName: 'No' })).status).toBe(422);
    expect((await as(author, 'post', `${v}/cash-flow-classes`, { key: 'X', section: 'INVESTING', name: 'Bad' })).status).toBe(422);              // no non-cash caption
    expect((await as(author, 'post', `${v}/cash-flow-classes`, { key: 'X', section: 'FINANCING', name: 'Bad', adjustmentName: 'A', inflowName: 'In' })).status).toBe(422);
    expect((await as(author, 'post', `${v}/cash-flow-classes`, { key: 'CASH', section: 'OPERATING', name: 'Reserved' })).status).toBe(422);
    expect((await as(accountant, 'post', `${v}/cash-flow-classes`, CF.classes[0])).status).toBe(403);
    const ids: Record<string, string> = {};
    for (const k of CF.classes) ids[k.key] = ok(await as(author, 'post', `${v}/cash-flow-classes`, k), 201).id;
    expect((await as(author, 'post', `${v}/cash-flow-classes`, CF.classes[0])).body.code).toBe('content_exists');
    expect((await as(author, 'post', `${v}/cash-flow-map-entries`, { sourceLine: 'BS.CURRENT_ASSETS.CASH', target: 'NOPE' })).body.code).toBe('unknown_cash_flow_class');
    expect((await as(author, 'post', `${v}/cash-flow-map-entries`, { sourceLine: 'PL.TURNOVER', target: 'CASH' })).status).toBe(422);
    for (const [sourceLine, accountSubtype, target] of CF.map) ok(await as(author, 'post', `${v}/cash-flow-map-entries`, { sourceLine, accountSubtype, target }), 201);
    expect((await as(author, 'delete', `${v}/cash-flow-classes/${ids['OP.STOCK']}`)).body.code).toBe('cash_flow_class_in_use');
    // listing a size without captions makes the version inconsistent; with them it is consistent
    ok(await as(author, 'patch', v, { cashFlowAppliesTo: CF.appliesTo }));
    expect(ok(await as(reviewer, 'get', v)).problems).toEqual(['The cash flow statement applies to some sizes but has no captions']);
    expect((await as(verifier, 'post', `${v}/verify`, { notes: 'Checked synthetic content for the cash flow' })).body.code).toBe('version_inconsistent');
    ok(await as(author, 'patch', v, { cashFlowCaptions: CF.captions }));
    const content = ok(await as(reviewer, 'get', v));
    expect([content.problems, content.cashFlowClasses.length, content.cashFlowMapEntries.length, content.cashFlowAppliesTo]).toEqual([[], CF.classes.length, CF.map.length, CF.appliesTo]);
  });
  it('a second person verifies the version; the cash-flow content is then frozen', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    ok(await as(verifier, 'post', `${v}/verify`, { notes: 'Checked synthetic content for the cash flow' }));
    expect((await as(author, 'post', `${v}/cash-flow-classes`, { key: 'LATE', section: 'OPERATING', name: 'Too late' })).body.code).toBe('version_not_editable');
    expect((await as(author, 'patch', v, { cashFlowAppliesTo: [] })).body.code).toBe('version_not_editable');
    for (const f of G.frameworks) ok(await as(accountant, 'put', c('/reporting-frameworks'), { ...f, versionId, reason: 'Medium-sized (synthetic)' }));
  });
});

describe('the golden cash flow statement (DEC-054)', () => {
  it('every line, its accounts and comparative, the totals, the cash and the proof match the hand-written golden', async () => {
    const st = await statement(E.yearStart);
    expect([st.verified, st.applies, st.problems, st.comparative]).toEqual([true, true, [], { start: '2025-01-01', end: '2025-12-31', fromFramework: true }]);
    const got = lines(st);
    expect(got.map((l: any) => l.key)).toEqual(E.lines.map((l: any) => l.key));
    for (const e of E.lines) {
      const l = got.find((x: any) => x.key === e.key);
      expect({ section: l.section, name: l.name, amount: l.amount, comparative: l.comparative }, e.key).toEqual({ section: e.section, name: e.name, amount: e.amount, comparative: e.comparative });
      if (e.accounts) expect(l.accounts.map((a: any) => [a.code, a.amount]), e.key).toEqual(e.accounts);
    }
    for (const sec of st.sections) expect(sec.total, sec.section).toEqual(E.totals[sec.section]);
    for (const k of ['netChange', 'opening', 'closing']) expect(st[k], k).toEqual(E[k]);
    expect(st.proof).toMatchObject({ ...E.proof, opening: '28000.00', closing: '36800.00', comparative: { reconciled: true, cashMovement: '28000.00' } });
    for (const k of E.omitted) expect(got.some((l: any) => l.key === k), k).toBe(false);
  });
  it('the 2025 statement on its own equals the comparative column', async () => {
    const st = await statement('2025-01-01', false);
    expect(st.comparative).toBeNull();
    const got = new Map(lines(st).map((l: any) => [l.key, l.amount]));
    for (const e of E.lines) if (e.comparative !== '0.00') expect(got.get(e.key), e.key).toBe(e.comparative);
    expect(st.closing.amount).toBe(E.closing.comparative);
  });
});

describe('an account the map does not place', () => {
  it('is shown as an unclassified movement and reported; the statement still reconciles; the version is a preview', async () => {
    const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-CF-COPY', name: 'Synthetic copy' }), 201).id;
    const copy = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Copy without stock', effectiveFrom: '2020-01-01', copyFromVersionId: versionId,
      source: { url: 'https://example.test/synthetic-cash-flow', provision: 'Synthetic test content (not FRS 102)', retrievedOn: '2026-10-20' } }), 201);
    expect([copy.cashFlowClasses.length, copy.cashFlowMapEntries.length, copy.cashFlowAppliesTo]).toEqual([CF.classes.length, CF.map.length, CF.appliesTo]);   // copied with the content
    const stock = copy.cashFlowMapEntries.find((m: any) => m.sourceLine === 'BS.CURRENT_ASSETS.STOCK');
    ok(await as(author, 'delete', c(`/reporting-standard-versions/${copy.id}/cash-flow-map-entries/${stock.id}`)));
    ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2026-01-01', yearEnd: '2026-12-31', versionId: copy.id, entitySize: 'MEDIUM', reason: 'Trying the copy (synthetic)' }));
    const st = await statement('2026-01-01');
    const un = lines(st).find((l: any) => l.key === 'UNCLASSIFIED');
    expect([un.amount, un.comparative, un.accounts.map((a: any) => a.code)]).toEqual(['2000.00', '-6000.00', ['1000']]);
    expect(st.unplacedAccounts.map((a: any) => a.code)).toEqual(['1000']);
    expect(st.problems).toEqual(['Account 1000 Stock (BS.CURRENT_ASSETS.STOCK/CURRENT_ASSET_STOCK) is not placed by the cash-flow map; its movement is shown as unclassified']);
    expect([st.proof.reconciled, st.verified, st.notices[0]]).toEqual([true, false, expect.stringMatching(/^PREVIEW ONLY/)]);
    const d = ok(await as(reviewer, 'get', c('/accounts-document?yearStart=2026-01-01')));
    expect(d.complete).toBe(false);
    expect(d.problems).toContain('Cash flow: Account 1000 Stock (BS.CURRENT_ASSETS.STOCK/CURRENT_ASSET_STOCK) is not placed by the cash-flow map; its movement is shown as unclassified');
    ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2026-01-01', yearEnd: '2026-12-31', versionId, entitySize: 'MEDIUM', reason: 'Back to the verified version (synthetic)' }));
  });
});

describe('the accounts document', () => {
  it('a medium-sized year carries the statement and is complete; a small year has none', async () => {
    const d = ok(await as(reviewer, 'get', c('/accounts-document?yearStart=2026-01-01')));
    const st = await statement('2026-01-01');
    expect(d.statements.cashFlow).toEqual(st);
    expect([d.complete, d.problems]).toEqual([true, []]);
    ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2025-01-01', yearEnd: '2025-12-31', versionId, entitySize: 'SMALL', reason: 'Small (synthetic)' }));
    expect(ok(await as(reviewer, 'get', c('/accounts-document?yearStart=2025-01-01'))).statements.cashFlow).toBeNull();
    const small = await statement('2025-01-01', false);
    expect([small.applies, small.notices.join(' ')]).toEqual([false, expect.stringMatching(/does not apply to the year's entity size \(SMALL\)/)]);
  });
});

describe('permissions and tenancy', () => {
  it('the statement needs ledger:read; content needs accounts:rules-manage; another organisation sees nothing', async () => {
    expect(lines(await statement('2026-01-01', true, bookkeeper)).length).toBe(E.lines.length);
    expect((await as(outsider, 'get', c('/cash-flow?yearStart=2026-01-01'))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/cash-flow?yearStart=2030-01-01'))).body.code).toBe('framework_not_set');
  });
});
