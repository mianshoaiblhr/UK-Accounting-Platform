import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { importPack, importThresholds } from '../../scripts/standards/import-pack.mjs';

/**
 * DEC-064: the draft wording packs import through the public API as UNVERIFIED versions with no consistency problems, and render a document
 * for a synthetic company: marked unverified, never complete, the wording filled from the ledger and the facts. Synthetic company data only.
 */
const pack = (f: string) => JSON.parse(readFileSync(resolve(__dirname, '../../content/standards/drafts', f), 'utf8'));
const MICRO = pack('frs105-micro.json'), SMALL = pack('frs102-1a-small.json'), SIZES = pack('uk-size-thresholds.json');

let s: Stack;
let owner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, versions: Record<string, string> = {};
let director: string;
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const text = (d: any, key: string) => d.sections.flatMap((x: any) => x.items).find((i: any) => i.key === key)?.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text);

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Draft Wording Ltd');
  author = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  ok(await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
  ok(await as(owner, 'post', c('/periods'), { startDate: '2027-01-01', endDate: '2027-12-31' }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  director = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: 'Robin Director' }), 201).id;
  ok(await as(owner, 'post', c('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: '2020-01-01' }), 201);
  for (const [direction, date, account, amount] of [['RECEIPT', '2026-01-02', '3000', '100.00'], ['RECEIPT', '2026-05-31', '4000', '20000.00'], ['PAYMENT', '2026-06-30', '6100', '7500.00']] as const)
    ok(await as(accountant, 'post', c('/cash-transactions'), { direction, transactionDate: date, bankAccountId: acc['1200'], description: 'Synthetic', lines: [{ description: 'Synthetic', accountId: acc[account], amount }] }), 201);
});
afterAll(() => s.stop());

describe('importing the drafts (DEC-064)', () => {
  it('each pack imports through the API as an UNVERIFIED version with every line, map entry, rule and wording, and no consistency problem', async () => {
    const call = (m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => as(author, m, c(p), b);
    for (const [name, p] of [['micro', MICRO], ['small', SMALL]] as const) {
      const r = await importPack(call, p);
      versions[name] = r.versionId;
      expect(r).toMatchObject({ status: 'UNVERIFIED', turnoverLineKey: 'P.T', lines: p.lines.length, mapEntries: p.mapEntries.length, validationRules: p.validationRules.length, disclosureRules: p.rules.length, problems: [] });
    }
    // the importer cannot verify their own import (DEC-052)
    expect((await as(author, 'post', c(`/reporting-standard-versions/${versions.micro}/verify`), { notes: 'Checked by the importer, which is refused' })).body.code).toBe('self_verification_not_allowed');
    // a person without accounts:rules-manage cannot import
    await expect(importPack((m, p, b) => as(accountant, m, c(p), b), MICRO)).rejects.toThrow(/HTTP 403/);
  });
});

describe('importing the draft size thresholds (DEC-066)', () => {
  it('each set lands UNVERIFIED with its limits; the importer cannot verify; the size test from them is a preview', async () => {
    const call = (m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => as(author, m, c(p), b);
    const r = await importThresholds(call, SIZES);
    expect(r.sets.map((x) => x.status)).toEqual(['UNVERIFIED', 'UNVERIFIED']);
    const set = ok(await as(reviewer, 'get', c(`/size-threshold-sets/${r.sets[1]!.id}`)));
    expect(set).toMatchObject({ effectiveFrom: '2025-04-06', effectiveTo: null, priorYearOnFirst: true, limits: SIZES.sets[1].limits });
    expect((await as(author, 'post', c(`/size-threshold-sets/${r.sets[1]!.id}/verify`), { notes: 'Checked by the importer, which is refused' })).body.code).toBe('self_verification_not_allowed');
  });
});

describe('a document from the unverified FRS 105 draft', () => {
  it('renders the micro-entity statements and notes from the ledger and facts, marked unverified and never complete', async () => {
    ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2026-01-01', yearEnd: '2026-12-31', versionId: versions.micro, entitySize: 'MICRO', reason: 'Micro-entity (synthetic)' }));
    for (const [key, value] of [['employees.average', '1'], ['employees.averagePrior', '1'], ['approval.date', '2027-02-28'], ['approval.director', director], ['text.commitments', 'There were no financial commitments, guarantees or contingencies at the year end.']])
      ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: '2026-01-01', key, value, reason: 'Synthetic' }), 201);
    const d = ok(await as(reviewer, 'get', c('/accounts-document?yearStart=2026-01-01')));
    expect([d.verified, d.complete]).toEqual([false, false]);
    expect(d.notices.join(' ')).toMatch(/PREVIEW ONLY/);
    const line = (k: string) => [...d.statements.profitAndLoss, ...d.statements.balanceSheet].find((l: any) => l.key === k).amount;
    expect([line('P.T'), line('P.OC'), line('P.PROFIT'), line('B.CA'), line('B.NA'), line('B.CR')]).toEqual(['20000.00', '7500.00', '12500.00', '12600.00', '12600.00', '12600.00']);
    expect(d.sections.map((x: any) => x.section)).toEqual(['NOTES', 'BALANCE_SHEET_STATEMENTS']);
    expect(text(d, 'NOTE.EMPLOYEES')).toEqual(['The average number of persons employed by the company during the year was 1 (31 December 2025: 1).']);
    expect(text(d, 'BSS.AUDIT')![0]).toBe('For the year ending 31 December 2026 the company was entitled to exemption from audit under section 477 of the Companies Act 2006 relating to small companies.');
    expect(text(d, 'BSS.APPROVAL')).toEqual(['The financial statements were approved by the board of directors on 28 February 2027 and signed on its behalf by:', 'Robin Director, Director']);
    expect(d.omitted).toEqual([{ key: 'NOTE.ADV', title: 'Advances, credits and guarantees granted to directors', reason: 'EMPTY' }]);
    expect(d.problems).toEqual([]);                                       // nothing is missing: it is incomplete only because the wording is unverified
  });
});

describe('the size test from the drafts', () => {
  it('the micro-entity year qualifies as MICRO under the draft 2025 thresholds, as a preview because they are unverified', async () => {
    ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: '2026-01-01', key: 'size.priorStatus', value: 'FIRST_YEAR', reason: 'Synthetic company in its first year' }), 201);
    const t = ok(await as(reviewer, 'get', c('/size-test?yearStart=2026-01-01')));
    expect([t.qualifiesAs, t.chosen, t.fits, t.verified, t.problems]).toEqual(['MICRO', 'MICRO', true, false, []]);
    expect(t.years[0]).toMatchObject({ thresholdSet: { status: 'UNVERIFIED' }, figures: { turnover: '20000.00', balanceSheetTotal: '12600.00', employees: 1 } });
    expect(t.years[0].classes[0]).toMatchObject({ class: 'MICRO', limits: { turnover: '1000000.00', balanceSheetTotal: '500000.00', employees: 10 }, met: true, status: true, basis: 'FIRST_YEAR' });
  });
});

describe('a document from the unverified FRS 102 Section 1A draft', () => {
  it('a small company gets policies, notes, the directors\' report and the balance-sheet statements; missing company wording is reported', async () => {
    ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: '2027-01-01', yearEnd: '2027-12-31', versionId: versions.small, entitySize: 'SMALL', reason: 'Small company (synthetic)' }));
    ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: '2027-01-01', key: 'approval.director', value: director, reason: 'Synthetic' }), 201);
    const d = ok(await as(reviewer, 'get', c('/accounts-document?yearStart=2027-01-01')));
    expect([d.verified, d.complete]).toEqual([false, false]);
    expect(d.sections.map((x: any) => x.section)).toEqual(['POLICIES', 'NOTES', 'DIRECTORS_REPORT', 'BALANCE_SHEET_STATEMENTS']);
    expect(text(d, 'DR.DIRECTORS')).toEqual(['The directors who held office during the year were Robin Director.']);
    expect(text(d, 'POL.COMPLIANCE')![0]).toMatch(/^These financial statements have been prepared in accordance with FRS 102/);
    expect(d.problems).toEqual(expect.arrayContaining(['POL.GC: missing fact text.goingConcern', 'POL.FA: missing fact text.depreciationRates', 'NOTE.EMPLOYEES: missing fact employees.average']));
    expect(d.omitted.map((o: any) => o.key).sort()).toEqual(['NOTE.ADV', 'NOTE.CREDLONG', 'NOTE.FA', 'NOTE.PROV', 'NOTE.RP']);
  });
});
