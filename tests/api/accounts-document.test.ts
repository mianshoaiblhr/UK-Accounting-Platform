import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/** V2-M5a through the public API (v2-plan 5d.3): the golden accounts document (DEC-054, DEC-063) rendered exactly, the template grammar, facts, verification, permissions and tenancy. Synthetic data and synthetic wording only. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m5a-document.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };

let s: Stack;
let owner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string };
let versionId: string;
const acc: Record<string, string> = {}, journals: Record<string, string> = {}, ruleIds: Record<string, string> = {};
let director: string, stranger: string;
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const doc = async (u = reviewer) => ok(await as(u, 'get', c(`/accounts-document?yearStart=${G.expected.yearStart}`)));
const factValue = (v: string) => (v === '@director' ? director : v === '@outsider' ? stranger : v);
const blocks = (b: any[]) => b.map((x) => (x.type === 'text' ? ['text', x.text] : ['table', x.key, x.columns, x.rows]));

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, G.company.name);
  adminSql(`UPDATE company SET company_number = '${G.company.number}' WHERE id = '${company.id}'`);
  author = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const a of G.accounts) acc[a.code] = ok(await as(owner, 'post', c('/accounts'), a), 201).id;
  director = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.director }), 201).id;
  stranger = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: 'Not A Director' }), 201).id;
  ok(await as(owner, 'post', c('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: G.company.appointedOn }), 201);
  for (const p of G.seed) journals[p.ref] = ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description,
    lines: p.lines.map(([k, amount]: string[]) => ({ description: p.description, accountId: acc[k!], amount })) }), 201).journalId;
  for (const j of G.journals) ok(await as(accountant, 'post', c('/journals'), { journalDate: j.date, description: j.description, lines: j.lines.map(([k, debit, credit]: string[]) => ({ accountId: acc[k!], debit, credit })) }), 201);
  // fixed assets (V2-M2): a class, two linked additions, two runs and a disposal
  const fa = G.fixedAssets, k = fa.class;
  const classId = ok(await as(accountant, 'post', c('/fixed-asset-classes'), { code: k.code, name: k.name, costAccountId: acc[k.costAccount], depreciationAccountId: acc[k.depreciationAccount],
    expenseAccountId: acc[k.expenseAccount], disposalAccountId: acc[k.disposalAccount], method: k.method, lifeMonths: k.lifeMonths, convention: k.convention }), 201).id;
  const assets: Record<string, string> = {};
  for (const a of fa.assets) assets[a.key] = ok(await as(accountant, 'post', c('/fixed-assets'), { classId, description: a.description, acquiredOn: a.acquiredOn, cost: a.cost, addition: { kind: 'LINKED', journalId: journals[a.journalRef] } }), 201).id;
  for (const st of fa.steps) {
    if (st.do === 'run') expect(ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: st.asAt }), 201).total).toBe(st.total);
    else expect(ok(await as(accountant, 'post', c(`/fixed-assets/${assets[st.asset]}/dispose`), { disposedOn: st.on, proceeds: st.proceeds, proceedsAccountId: acc[st.proceedsAccount], reason: 'Sold (synthetic)' })).disposalCatchUp).toBe(st.catchUp);
  }
  // a provision (V2-M3a), a director's loan account and a related party (V2-M4)
  const p = G.provision;
  const provisionId = ok(await as(accountant, 'post', c('/provisions'), { name: p.name, accountId: acc[p.account], expenseAccountId: acc[p.expenseAccount], basis: p.basis }), 201).id;
  ok(await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: 'MADE', date: p.made.date, amount: p.made.amount, reason: p.made.reason }), 201);
  ok(await as(accountant, 'post', c('/director-loan-accounts'), { contactId: director, kind: 'DIRECTOR', accountId: acc[G.loanAccount.account], openedOn: G.loanAccount.openedOn }), 201);
  ok(await as(accountant, 'post', c('/related-parties'), { contactId: director, relationship: G.relatedParty.relationship, description: G.relatedParty.description, fromDate: G.relatedParty.fromDate }), 201);
});
afterAll(() => s.stop());

describe('wording as version content (DEC-063)', () => {
  it('the author writes lines, the map and the wording; the template grammar refuses unknown constructs; only rules managers may write', async () => {
    const standardId = ok(await as(author, 'post', c('/reporting-standards'), G.standard), 201).id;
    versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), G.version), 201).id;
    const v = c(`/reporting-standard-versions/${versionId}`);
    for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
    for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
    for (const t of G.refusedTemplates) {
      const r = await as(author, 'post', `${v}/disclosure-rules`, { key: 'BAD', title: 'Refused wording', section: 'NOTES', body: t.body });
      expect(r.body.code, t.body).toBe('invalid_template');
      expect(JSON.stringify(r.body.errors.problems), t.body).toContain(t.why);
    }
    expect((await as(accountant, 'post', `${v}/disclosure-rules`, { key: 'X', title: 'Not allowed', body: 'Text' })).status).toBe(403);
    for (const r of G.rules) ruleIds[r.key] = ok(await as(author, 'post', `${v}/disclosure-rules`, r), 201).id;
    const content = ok(await as(reviewer, 'get', v));
    expect(content.problems).toEqual([]);
    expect(content.disclosureRules.find((x: any) => x.key === 'NOTE.PROV')).toMatchObject({ section: 'NOTES', sort: 30, omitWhenEmpty: true, body: '{{table:provisions.movements}}' });
  });
  it('a second person verifies the version; the wording is then frozen; the years are set on it', async () => {
    const v = c(`/reporting-standard-versions/${versionId}`);
    expect((await as(author, 'post', `${v}/verify`, { notes: 'Checked by the author, which is refused' })).body.code).toBe('self_verification_not_allowed');
    ok(await as(owner, 'post', `${v}/verify`, { notes: 'Synthetic wording checked against the golden document' }));
    expect((await as(author, 'patch', `${v}/disclosure-rules/${ruleIds['NOTE.GC']}`, { body: 'Changed after verification' })).body.code).toBe('version_not_editable');
    expect(() => adminSql(`UPDATE disclosure_rule SET body = 'x' WHERE id = '${ruleIds['NOTE.GC']}'`)).toThrow(/cannot change/);
    for (const [yearStart, yearEnd] of G.periods) ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart, yearEnd, versionId, entitySize: 'MICRO', reason: 'Micro-entity (synthetic)' }));
  });
});

describe('facts (DEC-063)', () => {
  it('facts are typed, need accounts:prepare, and keep their history; the latest applies', async () => {
    const y = G.expected.yearStart;
    expect((await as(bookkeeper, 'post', c('/accounts-facts'), { yearStart: y, key: 'employees.average', value: '3', reason: 'Payroll records' })).status).toBe(403);
    for (const f of G.refusedFacts) {
      const r = await as(accountant, 'post', c('/accounts-facts'), { yearStart: y, key: f.key, value: factValue(f.value), reason: 'Refused (synthetic)' });
      expect(r.status, `${f.key}=${f.value}`).toBe(422);
    }
    ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: y, key: 'employees.average', value: '9', reason: 'First estimate (synthetic)' }), 201);
    for (const f of G.facts) ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: y, key: f.key, value: factValue(f.value), reason: 'From the client (synthetic)' }), 201);
    const facts = ok(await as(reviewer, 'get', c(`/accounts-facts?yearStart=${y}`)));
    expect(facts.current.find((f: any) => f.key === 'employees.average').value).toBe('3');
    expect(facts.history.filter((f: any) => f.key === 'employees.average').map((f: any) => f.value)).toEqual(['3', '9']);
  });
});

describe('the golden document (DEC-054)', () => {
  it('statements, sections, tables and sentences exactly as written by hand; the missing fact is reported and the document is not complete', async () => {
    const E = G.expected;
    const d = await doc();
    expect(d).toMatchObject({ companyName: G.company.name, companyNumber: G.company.number, verified: true, year: { start: '2026-01-01', end: '2026-12-31', priorEnd: '2025-12-31', entitySize: 'MICRO' } });
    const line = (k: string) => [...d.statements.profitAndLoss, ...d.statements.balanceSheet].find((l: any) => l.key === k);
    for (const [k, [cur, prior]] of Object.entries(E.statements) as [string, [string, string]][]) expect([line(k).amount, line(k).comparative], k).toEqual([cur, prior]);
    expect(d.sections.map((x: any) => x.section)).toEqual(E.sections.map((x: any) => x.section));
    for (const sec of E.sections) {
      const got = d.sections.find((x: any) => x.section === sec.section);
      expect(got.items.map((i: any) => i.key)).toEqual(sec.items.map((i: any) => i.key));
      for (const it of sec.items) {
        const g = got.items.find((i: any) => i.key === it.key);
        expect(g.title).toBe(it.title);
        expect(blocks(g.blocks), it.key).toEqual(it.blocks);
        expect(g.missing).toEqual(it.missing ?? []);
      }
    }
    expect(d.omitted.map((o: any) => [o.key, o.reason])).toEqual(E.omitted);
    expect(d.problems).toEqual(E.problemsBefore);
    expect(d.complete).toBe(E.completeBefore);
  });
  it('with the going-concern wording entered the document is complete; another organisation sees nothing; the route needs ledger:read', async () => {
    const E = G.expected;
    ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: E.yearStart, key: G.lateFact.key, value: G.lateFact.value, reason: 'Directors\' assessment (synthetic)' }), 201);
    const d = await doc();
    const gc = d.sections.find((x: any) => x.section === 'NOTES').items.find((i: any) => i.key === 'NOTE.GC');
    expect(blocks(gc.blocks)).toEqual(E.sections[1].items.find((i: any) => i.key === 'NOTE.GC').afterLateFact);
    expect([d.problems, d.complete]).toEqual([[], E.completeAfter]);
    expect((await as(outsider, 'get', c(`/accounts-document?yearStart=${E.yearStart}`))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/accounts-document?yearStart=2027-01-01'))).body.code).toBe('framework_not_set');
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action = 'accounts.fact_set' AND company_id = '${company.id}'`)).toBe(String(G.facts.length + 2));
  });
});
