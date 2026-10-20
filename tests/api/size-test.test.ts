import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V2-M5b through the public API (v2-plan 5f.5): the golden size test (DEC-054, DEC-066) matched exactly, threshold sets verified by a second person, facts, permissions and tenancy. Synthetic limits and data only. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m5b-size.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };

let s: Stack;
let owner: TestUser, author: TestUser, verifier: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string };
let versionId: string;
const acc: Record<string, string> = {}, sets: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const test = async (yearStart: string, u = reviewer) => ok(await as(u, 'get', c(`/size-test?yearStart=${yearStart}`)));
const setBody = (st: any) => ({ label: st.label, effectiveFrom: st.effectiveFrom, effectiveTo: st.effectiveTo, priorYearOnFirst: st.priorYearOnFirst, limits: st.limits, source: G.source });
/** The year as the golden writes it: the set names instead of objects. */
const shape = (y: any) => ({ ...y, thresholdSet: y.thresholdSet?.label ?? null, priorTestedAgainst: y.priorTestedAgainst?.label ?? null });
const fact = (yearStart: string, key: string, value: string) => as(accountant, 'post', c('/accounts-facts'), { yearStart, key, value, reason: 'Synthetic' });

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
  for (const p of G.seed) ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description,
    lines: p.lines.map(([k, amount]: string[]) => ({ description: p.description, accountId: acc[k!], amount })) }), 201);
  for (const [yearStart, yearEnd] of G.closes) ok(await as(accountant, 'post', c('/year-end-closes'), { yearStart, yearEnd }), 201);
  // a verified synthetic version (the V2-M1 golden lines) naming its turnover line
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-SIZE', name: 'Synthetic size standard' }), 201).id;
  versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: G.source }), 201).id;
  const v = c(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
});
afterAll(() => s.stop());

describe('the turnover line (DEC-066)', () => {
  it('a version names a P&L line as its turnover line while unverified; it is frozen with the version and protects the line', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    expect((await as(author, 'patch', v, { turnoverLineKey: 'B.CA' })).body.code).toBe('invalid_turnover_line');
    expect((await as(author, 'patch', v, { turnoverLineKey: 'NOPE' })).body.code).toBe('invalid_turnover_line');
    expect(ok(await as(author, 'patch', v, { turnoverLineKey: G.turnoverLineKey })).turnoverLineKey).toBe('P.T');
    const line = ok(await as(reviewer, 'get', v)).lines.find((l: any) => l.key === 'P.T');
    expect((await as(author, 'delete', `${v}/lines/${line.id}`)).body.code).toBe('line_in_use');
    ok(await as(verifier, 'post', `${v}/verify`, { notes: 'Synthetic version checked for the size test' }));
    expect((await as(author, 'patch', v, { turnoverLineKey: null })).body.code).toBe('version_not_editable');
    for (const f of G.frameworks) ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: f.yearStart, yearEnd: f.yearEnd, versionId, entitySize: f.entitySize, reason: 'Synthetic' }));
    for (const f of G.frameworks) ok(await fact(f.yearStart, 'employees.average', f.employees), 201);
  });
});

describe('threshold sets (DEC-052, DEC-066)', () => {
  it('are created UNVERIFIED by a rules manager, refused when not nested or overlapping, and verified only by another person', async () => {
    const [A, B] = G.sets;
    const bad = structuredClone(A); bad.limits.MICRO.turnover = '70000.00';
    expect((await as(author, 'post', c('/size-threshold-sets'), setBody(bad))).status).toBe(422);
    expect((await as(accountant, 'post', c('/size-threshold-sets'), setBody(A))).status).toBe(403);
    for (const st of G.sets) sets[st.key] = ok(await as(author, 'post', c('/size-threshold-sets'), setBody(st)), 201).id;
    expect(ok(await as(reviewer, 'get', c(`/size-threshold-sets/${sets.A}`)))).toMatchObject({ status: 'UNVERIFIED', limits: A.limits, priorYearOnFirst: false, effectiveTo: '2025-12-31' });
    const overlap = await as(author, 'post', c('/size-threshold-sets'), { ...setBody(B), label: 'Overlapping', effectiveFrom: '2025-06-01' });
    expect([overlap.status, overlap.body.code]).toEqual([409, 'threshold_set_overlap']);
    expect((await as(author, 'post', c(`/size-threshold-sets/${sets.A}/verify`), { notes: 'Checked by the author, which is refused' })).body.code).toBe('self_verification_not_allowed');
    expect((await as(accountant, 'post', c(`/size-threshold-sets/${sets.A}/verify`), { notes: 'No accounts:rule-verify permission' })).status).toBe(403);
    ok(await as(verifier, 'post', c(`/size-threshold-sets/${sets.A}/verify`), { notes: 'Synthetic limits A checked for the golden' }));
  });
  it('a test from an unverified set is a preview; once verified the set is frozen and changed only by superseding it', async () => {
    ok(await fact(G.earliestFacts.yearStart, 'size.priorMet', G.earliestFacts['size.priorMet']), 201);
    ok(await fact(G.earliestFacts.yearStart, 'size.priorStatus', G.earliestFacts['size.priorStatus']), 201);
    const preview = await test('2026-01-01');
    expect([preview.verified, preview.notices[0]]).toEqual([false, expect.stringMatching(/^PREVIEW ONLY/)]);
    ok(await as(verifier, 'post', c(`/size-threshold-sets/${sets.B}/verify`), { notes: 'Synthetic limits B checked for the golden' }));
    expect((await as(author, 'patch', c(`/size-threshold-sets/${sets.B}`), { label: 'Changed' })).body.code).toBe('threshold_set_not_editable');
    expect((await test('2026-01-01')).verified).toBe(true);
  });
});

describe('the golden size test (DEC-054)', () => {
  it('every year, figure, limit, condition and status matches the hand-written golden', async () => {
    for (const e of G.expected) {
      const r = await test(e.yearStart);
      expect({ chosen: r.chosen, qualifiesAs: r.qualifiesAs, fits: r.fits, years: r.years.map((y: any) => y.start) }, e.yearStart).toEqual({ chosen: e.chosen, qualifiesAs: e.qualifiesAs, fits: e.fits, years: e.years });
      for (const y of r.years) expect(shape(y), `${e.yearStart} via ${y.start}`).toMatchObject(G.yearResults[y.start]);
      expect([r.verified, r.problems], e.yearStart).toEqual([true, []]);
    }
    expect((await test('2024-01-01')).notices).toContain(G.notFitting);
    expect((await test('2027-01-01')).notices.join(' ')).toMatch(/excluded/);
  });
});

describe('missing facts and history', () => {
  it('a year that needs no history is decided without the earliest facts; one that does reports them and is UNKNOWN', async () => {
    // a second company with the same ledger shape but no facts for its earliest year
    const other = await makeCompany(s, owner, 'Golden Size Two Ltd');
    const o = (p = '') => `/companies/${other.id}${p}`;
    const a2: Record<string, string> = {};
    for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', o('/periods'), { startDate, endDate }), 201);
    for (const a of ok(await as(owner, 'post', o('/accounts/initialise')), 201).items) a2[a.code] = a.id;
    for (const p of G.seed) ok(await as(accountant, 'post', o('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: a2['1200'], description: p.description,
      lines: p.lines.map(([k, amount]: string[]) => ({ description: p.description, accountId: a2[k!], amount })) }), 201);
    for (const f of G.frameworks) {
      ok(await as(accountant, 'put', o('/reporting-frameworks'), { yearStart: f.yearStart, yearEnd: f.yearEnd, versionId, entitySize: f.entitySize, reason: 'Synthetic' }));
      ok(await as(accountant, 'post', o('/accounts-facts'), { yearStart: f.yearStart, key: 'employees.average', value: f.employees, reason: 'Synthetic' }), 201);
    }
    const W = G.withoutFacts;
    const r26 = ok(await as(reviewer, 'get', o('/size-test?yearStart=2026-01-01')));
    expect({ qualifiesAs: r26.qualifiesAs, fits: r26.fits, problems: r26.problems }).toEqual(W['2026-01-01']);
    const r25 = ok(await as(reviewer, 'get', o('/size-test?yearStart=2025-01-01')));
    expect({ qualifiesAs: r25.qualifiesAs, fits: r25.fits, problems: r25.problems }).toEqual({ qualifiesAs: W['2025-01-01'].qualifiesAs, fits: W['2025-01-01'].fits, problems: W['2025-01-01'].problems });
    expect(r25.years[1].classes[0]).toMatchObject(W['2025-01-01'].micro2024);
    // facts are typed: the service names the problem
    expect((await as(accountant, 'post', o('/accounts-facts'), { yearStart: '2024-01-01', key: 'size.priorMet', value: 'TINY', reason: 'Synthetic' })).body.code).toBe('invalid_fact');
    expect((await as(accountant, 'post', o('/accounts-facts'), { yearStart: '2024-01-01', key: 'size.priorMet', value: 'FIRST_YEAR', reason: 'Synthetic' })).body.code).toBe('invalid_fact');
    // FIRST_YEAR: the earliest year's status is its own result, and no priorMet is needed
    ok(await as(accountant, 'post', o('/accounts-facts'), { yearStart: '2024-01-01', key: 'size.priorStatus', value: 'FIRST_YEAR', reason: 'Incorporated 1 January 2024 (synthetic)' }), 201);
    const r24 = ok(await as(reviewer, 'get', o('/size-test?yearStart=2024-01-01')));
    expect([r24.qualifiesAs, r24.fits, r24.problems]).toEqual(['MICRO', true, []]);
    expect(r24.years[0].classes.map((x: any) => [x.class, x.status, x.basis, x.priorMet])).toEqual([['MICRO', true, 'FIRST_YEAR', null], ['SMALL', true, 'FIRST_YEAR', null], ['MEDIUM', true, 'FIRST_YEAR', null]]);
  });
  it('a year with no governing set, or a version with no turnover line, is reported and not verified', async () => {
    const third = await makeCompany(s, owner, 'Golden Size Three Ltd');
    const t = (p = '') => `/companies/${third.id}${p}`;
    ok(await as(owner, 'post', t('/periods'), { startDate: '2019-01-01', endDate: '2019-12-31' }), 201);
    const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-NOTURN', name: 'No turnover line' }), 201).id;
    const vid = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'No turnover', effectiveFrom: '2019-01-01', copyFromVersionId: versionId, source: G.source }), 201).id;
    expect(ok(await as(reviewer, 'get', c(`/reporting-standard-versions/${vid}`))).turnoverLineKey).toBe('P.T');      // copied with the content
    ok(await as(author, 'patch', c(`/reporting-standard-versions/${vid}`), { turnoverLineKey: null }));
    ok(await as(accountant, 'put', t('/reporting-frameworks'), { yearStart: '2019-01-01', yearEnd: '2019-12-31', versionId: vid, entitySize: 'SMALL', reason: 'Synthetic' }));
    const r = ok(await as(reviewer, 'get', t('/size-test?yearStart=2019-01-01')));
    expect(r.verified).toBe(false);
    expect(r.qualifiesAs).toBe('UNKNOWN');
    expect(r.problems).toEqual(expect.arrayContaining(['Year 2019-01-01: no current size threshold set governs a year beginning on this date', 'Year 2019-01-01: the standard version No turnover names no turnover line',
      'Year 2019-01-01: missing fact employees.average']));
  });
});

describe('supersession, permissions and tenancy', () => {
  it('a verified set is superseded by an unverified copy; the old one is final', async () => {
    const B = G.sets[1];
    const nb = ok(await as(author, 'post', c(`/size-threshold-sets/${sets.B}/supersede`), { ...setBody(B), label: 'Synthetic limits B2', reason: 'Synthetic change of limits' }), 201);
    expect(nb).toMatchObject({ status: 'UNVERIFIED', copiedFromId: sets.B });
    expect(ok(await as(reviewer, 'get', c(`/size-threshold-sets/${sets.B}`)))).toMatchObject({ status: 'SUPERSEDED', supersededById: nb.id });
    expect((await as(author, 'post', c(`/size-threshold-sets/${sets.B}/supersede`), { ...setBody(B), reason: 'A second supersession' })).body.code).toBe('threshold_set_superseded');
    expect((await as(author, 'post', c(`/size-threshold-sets/${nb.id}/supersede`), { ...setBody(B), reason: 'An unverified set is edited' })).body.code).toBe('threshold_set_unverified');
    const r = await test('2026-01-01');
    expect([r.verified, r.years[0].thresholdSet]).toEqual([false, { id: nb.id, label: 'Synthetic limits B2', status: 'UNVERIFIED' }]);
    expect(ok(await as(reviewer, 'get', c('/size-threshold-sets'))).items.map((x: any) => [x.label, x.status])).toEqual([['Synthetic limits A', 'VERIFIED'], ['Synthetic limits B', 'SUPERSEDED'], ['Synthetic limits B2', 'UNVERIFIED']]);
  });
  it('the test needs ledger:read; sets need accounts:rules-manage to write; another organisation sees nothing', async () => {
    expect((await test('2026-01-01', bookkeeper)).qualifiesAs).toBeDefined();
    expect((await as(bookkeeper, 'post', c('/size-threshold-sets'), setBody(G.sets[0]))).status).toBe(403);
    expect((await as(outsider, 'get', c('/size-test?yearStart=2026-01-01'))).status).toBe(404);
    expect((await as(outsider, 'get', c(`/size-threshold-sets/${sets.A}`))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/size-test?yearStart=2030-01-01'))).body.code).toBe('framework_not_set');
  });
});
