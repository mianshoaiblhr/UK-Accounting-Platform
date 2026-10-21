import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/**
 * V2-M6c through the public API (v2-plan 5j.4): partner review, client approval, locking and the filing-ready package of the golden year
 * (DEC-054, DEC-070) phase by phase, the refusals, permissions and tenancy. Synthetic data only.
 */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m6c-approval.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
const S = G.setup, Y = G.year.yearStart;

let s: Stack;
let owner: TestUser, partner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser, outsider: TestUser;
let company: { id: string };
let periodId: string, director: string, notADirector: string, evidence: string, bankFlag: string;
const fingerprints: string[] = [];
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const users = () => ({ owner, partner, accountant, reviewer } as Record<string, TestUser>);
const ref = (v: string) => (v === '@director' ? director : v === '@notADirector' ? notADirector : v);
const approvalBody = (r: Record<string, string> = {}) => ({ yearStart: Y, directorContactId: ref(r.director ?? S.approval.director), approvedOn: r.approvedOn ?? S.approval.approvedOn,
  evidenceDocumentId: r.evidence === 'missing' ? randomUUID() : evidence, note: 'Signed balance sheet received (synthetic)' });
const status = async () => ok(await as(reviewer, 'get', c(`/accounts-approval?yearStart=${Y}`)));
const phase = async (i: number) => {
  const p = G.phases[i], w = ok(await as(reviewer, 'get', c(`/year-end-workflow?yearStart=${Y}`)));
  expect(w.steps.map((x: any) => [x.control.status, x.state]), p.name).toEqual(p.steps);
  expect(w.current, p.name).toBe(p.current);
  fingerprints[i] = w.fingerprint;
  return w;
};
/** Attempts one of the golden's refusals and returns its code (or HTTP status when there is no code). */
const attempt = async (r: Record<string, any>) => {
  const u = users()[r.by]!;
  const res = r.action === 'partner-review' ? await as(u, 'post', c('/accounts-approval/partner-review'), { yearStart: Y })
    : r.action === 'client-approval' ? await as(u, 'post', c('/accounts-approval/client-approval'), approvalBody(r))
    : r.action === 'package' ? await as(u, 'post', c('/accounts-package'), { yearStart: Y })
    : r.action === 'sign-off' ? await as(u, 'post', c('/year-end-workflow/sign-off'), { yearStart: Y, step: r.step })
    : r.action === 'reopen' ? await as(u, 'post', c('/year-end-workflow/reopen'), { yearStart: Y, step: r.step, note: 'Look again (synthetic)' })
    : r.action === 'fact' ? await as(u, 'post', c('/accounts-facts'), { yearStart: Y, key: 'employees.average', value: '3', reason: 'Synthetic' })
    : r.action === 'flag-reopen' ? await as(u, 'post', c('/review-flags/reopen'), { yearStart: Y, flagKey: bankFlag, note: 'Look again (synthetic)' })
    : r.action === 'unlock' ? await as(u, 'post', c(`/periods/${periodId}/unlock`), { reason: 'Correct an error (synthetic)' })
    : r.action === 'journal' ? await as(u, 'post', c('/journals'), { journalDate: G.year.yearEnd, description: 'After approval (synthetic)', lines: [{ accountId: acc['6310'], debit: '10.00', credit: '0' }, { accountId: acc['1200'], debit: '0', credit: '10.00' }] })
    : (() => { throw new Error(r.action); })();
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  return r.status ? res.status : res.body.code;
};
const refusals = async (i: number) => { for (const r of G.phases[i].refusals) expect(await attempt(r), `${G.phases[i].name}: ${JSON.stringify(r)}`).toBe(r.code ?? r.status); };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, G.company.name);
  partner = await addMember(s, owner, 'partner');
  author = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  periodId = ok(await as(owner, 'post', c('/periods'), { startDate: Y, endDate: G.year.yearEnd }), 201).id;
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  acc['6950'] = ok(await as(owner, 'post', c('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201).id;
  ok(await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  ok(await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  const party = async (name: string, role: string, code: string) => ok(await as(owner, 'post', c('/contact-roles'), { contactId: ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name }), 201).id, role, accountCode: code }), 201).id;
  const customer = await party(G.company.customer, 'CUSTOMER', 'APC01');
  await party(G.company.supplier, 'SUPPLIER', 'APS01');
  director = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.director }), 201).id;
  notADirector = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.notADirector }), 201).id;
  ok(await as(owner, 'post', c('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: G.company.appointedOn }), 201);
  // the laptops bought from the bank and added to the register from that payment; the shares received; the invoice approved
  const a = S.asset, k = a.class;
  const payment = ok(await as(accountant, 'post', c('/cash-transactions'), { direction: 'PAYMENT', transactionDate: a.acquiredOn, bankAccountId: acc['1200'], description: a.description,
    lines: [{ description: a.description, accountId: acc[k.costAccount], amount: a.cost }] }), 201);
  ok(await as(accountant, 'post', c('/cash-transactions'), { direction: 'RECEIPT', transactionDate: S.shares.date, bankAccountId: acc['1200'], description: 'Shares issued',
    lines: [{ description: 'Shares issued', accountId: acc['3000'], amount: S.shares.amount }] }), 201);
  const classId = ok(await as(accountant, 'post', c('/fixed-asset-classes'), { code: k.code, name: k.name, costAccountId: acc[k.costAccount], depreciationAccountId: acc[k.depreciationAccount],
    expenseAccountId: acc[k.expenseAccount], disposalAccountId: acc[k.disposalAccount], method: k.method, lifeMonths: k.lifeMonths, convention: k.convention }), 201).id;
  ok(await as(accountant, 'post', c('/fixed-assets'), { classId, description: a.description, acquiredOn: a.acquiredOn, cost: a.cost, addition: { kind: 'LINKED', journalId: payment.journalId } }), 201);
  const inv = S.invoice;
  const invoiceId = ok(await as(accountant, 'post', c('/sales/invoices'), { customerRoleId: customer, issueDate: inv.issueDate, dueDate: inv.dueDate,
    lines: [{ description: 'Synthetic', quantity: '1', unitPrice: inv.amount, accountId: acc[inv.account], taxCodeId: null }] }), 201).id;
  ok(await as(accountant, 'post', c(`/sales/documents/${invoiceId}/approve`), {}));
  // a verified synthetic version with the two wording rules, the framework year, verified thresholds and the facts
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-AP', name: 'Synthetic approval standard' }), 201).id;
  const versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic approval v1', effectiveFrom: '2020-01-01',
    source: { url: 'https://example.test/synthetic-approval', provision: 'Synthetic test content', retrievedOn: '2026-10-21' } }), 201).id;
  const v = c(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
  for (const r of S.rules) ok(await as(author, 'post', `${v}/disclosure-rules`, r), 201);
  ok(await as(author, 'patch', v, { turnoverLineKey: 'P.T' }));
  ok(await as(owner, 'post', `${v}/verify`, { notes: 'Synthetic version checked for the approval golden' }));
  ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: Y, yearEnd: G.year.yearEnd, versionId, entitySize: G.year.entitySize, reason: 'Synthetic' }));
  const set = ok(await as(author, 'post', c('/size-threshold-sets'), { ...S.thresholds, source: { url: 'https://example.test/synthetic-limits', provision: 'Synthetic test limits', retrievedOn: '2026-10-21' } }), 201);
  ok(await as(owner, 'post', c(`/size-threshold-sets/${set.id}/verify`), { notes: 'Synthetic limits checked for the approval golden' }));
  for (const [key, value] of S.facts) ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: Y, key, value: ref(value), reason: 'Synthetic' }), 201);
  // review settings, the year-end depreciation, the bank flag explained by the accountant and signed off by the partner
  ok(await as(accountant, 'post', c('/review-settings'), { ...S.settings, reason: 'Firm settings (synthetic)' }), 201);
  expect(ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: S.depreciationRun.asAt }), 201).total).toBe(S.depreciationRun.total);
  bankFlag = ok(await as(reviewer, 'get', c(`/review-checklist?yearStart=${Y}`))).controls.find((x: any) => x.code === 'RC-08').flags[0].key;
  ok(await as(accountant, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: bankFlag, note: 'The bank account is set up with the first statements next year (synthetic)' }));
  ok(await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: bankFlag }));
  // steps 1 to 10 by the accountant, step 11 (the accounts) by the partner
  for (let n = 1; n <= 11; n++) ok(await as(n === 11 ? partner : accountant, 'post', c('/year-end-workflow/sign-off'), { yearStart: Y, step: n, note: `Step ${n} reviewed (synthetic)` }));
  const d = await uploadDoc(s, owner, { companyId: company.id }); await waitForVersion(s, owner, d.documentId, d.versionId); evidence = d.documentId;
});
afterAll(() => s.stop());

describe('the golden approval (DEC-054, DEC-070)', () => {
  it('phase 1: the accounts generated; the step-11 signer cannot review them', async () => {
    const w = await phase(0);
    expect(w.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(w.steps[12].control.details).toMatchObject({ liveReview: false, openPeriods: 1, approvalFacts: true });
    await refusals(0);
    const st = await status();
    expect(st).toMatchObject({ fingerprint: w.fingerprint, locked: false, partnerReviews: [], clientApproval: null, package: null });
  });
  it('phase 2: the owner reviews the accounts', async () => {
    const st = ok(await as(owner, 'post', c('/accounts-approval/partner-review'), { yearStart: Y, note: 'Reviewed (synthetic)' }));
    expect(st.partnerReviews).toMatchObject([{ fingerprint: fingerprints[0], live: true, note: 'Reviewed (synthetic)', byUserId: owner.userId }]);
    await phase(1);
    expect(fingerprints[1]).toBe(fingerprints[0]);
    await refusals(1);
  });
  it('phase 3: a fact changed: the review lapses', async () => {
    const [key, value] = S.factChange;
    ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: Y, key, value, reason: 'Average corrected (synthetic)' }), 201);
    await phase(2);
    expect(fingerprints[2]).not.toBe(fingerprints[0]);
    expect((await status()).partnerReviews).toMatchObject([{ fingerprint: fingerprints[0], live: false }]);
    await refusals(2);
  });
  it('phase 4: reviewed again and the period closed; approvals that differ from the accounts are refused', async () => {
    ok(await as(owner, 'post', c('/accounts-approval/partner-review'), { yearStart: Y }));
    ok(await as(accountant, 'post', c(`/periods/${periodId}/close`), { reason: 'Year end (synthetic)' }));
    await phase(3);
    expect(fingerprints[3]).toBe(fingerprints[2]);
    await refusals(3);
  });
  it("phase 5: the client's approval recorded locks the year", async () => {
    const st = ok(await as(partner, 'post', c('/accounts-approval/client-approval'), approvalBody()));
    expect(st).toMatchObject({ locked: true, clientApproval: { fingerprint: fingerprints[3], current: true, directorContactId: director, approvedOn: S.approval.approvedOn, evidenceDocumentId: evidence, byUserId: partner.userId } });
    expect(st.lockedAt).not.toBeNull();
    await phase(4);
    const periods = ok(await as(owner, 'get', c('/periods')));
    expect((periods.items ?? periods).find((p: any) => p.id === periodId).status).toBe(G.phases[4].periodStatus);
    await refusals(4);
    expect(ok(await as(owner, 'get', c('/reporting-frameworks'))).items[0].lockedAt).not.toBeNull();
  });
  it('phase 6: the filing-ready package generated once', async () => {
    const p = ok(await as(accountant, 'post', c('/accounts-package'), { yearStart: Y }), 201);
    expect(p).toMatchObject({ fingerprint: fingerprints[3], byUserId: accountant.userId });
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    const k = p.content;
    expect(k).toMatchObject({ format: G.package.format, fingerprint: fingerprints[3], clientApproval: { director: { name: G.package.approval.director }, approvedOn: G.package.approval.approvedOn, evidenceDocumentId: evidence },
      partnerReview: { byUserId: owner.userId }, framework: { version: { label: 'Synthetic approval v1', status: 'VERIFIED', verifiedByUserId: owner.userId } }, sizeTest: { qualifiesAs: 'MICRO', fits: true, verified: true } });
    expect(k.notices).toContain(G.package.notice);
    const texts = k.accounts.sections.flatMap((x: any) => x.items.flatMap((i: any) => i.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text)));
    for (const t of G.package.wording) expect(texts).toContain(t);
    await phase(5);
    expect(ok(await as(reviewer, 'get', c(`/accounts-package?yearStart=${Y}`)))).toMatchObject({ id: p.id, sha256: p.sha256, fingerprint: p.fingerprint });
    expect((await status()).package).toMatchObject({ id: p.id, sha256: p.sha256 });
    await refusals(5);
  });
});

describe('permissions and tenancy', () => {
  it('reading needs ledger:read; review and approval need accounts:review; another organisation sees nothing', async () => {
    expect((await as(reviewer, 'post', c('/accounts-approval/partner-review'), { yearStart: Y })).status).toBe(403);
    expect((await as(reviewer, 'post', c('/accounts-package'), { yearStart: Y })).status).toBe(403);
    expect((await as(outsider, 'get', c(`/accounts-approval?yearStart=${Y}`))).status).toBe(404);
    expect((await as(outsider, 'get', c(`/accounts-package?yearStart=${Y}`))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/accounts-package?yearStart=2030-01-01'))).body.code).toBe('framework_not_set');
  });
});
