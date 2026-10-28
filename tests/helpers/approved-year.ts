import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { addMember, bearer, makeCompany, orgPath, uploadDoc, waitForVersion, type Stack, type TestUser } from './stack';

/**
 * A synthetic approved year with its filing-ready package (DEC-070), built through the public API from the V2-M6c golden
 * (tests/golden/v2-m6c-approval.json), for the tests that read an approved package (V3). Synthetic data only.
 */
export const APPROVAL_GOLDEN = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m6c-approval.json'), 'utf8')) as Record<string, any>;

export interface ApprovedYear {
  company: { id: string }; yearStart: string; yearEnd: string; standardCode: string; acc: Record<string, string>;
  partner: TestUser; author: TestUser; accountant: TestUser; reviewer: TestUser; director: string; evidence: string; pkg: { id: string; sha256: string; content: Record<string, any> };
}

export async function approvedYear(s: Stack, owner: TestUser, o: { name?: string; companyNumber?: string; standardCode?: string } = {}): Promise<ApprovedYear> {
  const G = APPROVAL_GOLDEN, S = G.setup, Y = G.year.yearStart;
  const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
  const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
  const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
  const company = await makeCompany(s, owner, o.name ?? G.company.name, o.companyNumber);
  const c = (p = '') => `/companies/${company.id}${p}`;
  const partner = await addMember(s, owner, 'partner');
  const author = await addMember(s, owner, 'admin');
  const accountant = await addMember(s, owner, 'accountant');
  const reviewer = await addMember(s, owner, 'reviewer');
  const acc: Record<string, string> = {};
  const periodId = ok(await as(owner, 'post', c('/periods'), { startDate: Y, endDate: G.year.yearEnd }), 201).id;
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  acc['6950'] = ok(await as(owner, 'post', c('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201).id;
  ok(await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  ok(await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  const party = async (name: string, role: string, code: string) => ok(await as(owner, 'post', c('/contact-roles'), { contactId: ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name }), 201).id, role, accountCode: code }), 201).id;
  const customer = await party(G.company.customer, 'CUSTOMER', 'APC01');
  await party(G.company.supplier, 'SUPPLIER', 'APS01');
  const director = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.director }), 201).id;
  ok(await as(owner, 'post', c('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: G.company.appointedOn }), 201);
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
  const standardCode = o.standardCode ?? 'SYN-AP';
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: standardCode, name: 'Synthetic approval standard' }), 201).id;
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
  for (const [key, value] of S.facts) ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: Y, key, value: value === '@director' ? director : value, reason: 'Synthetic' }), 201);
  ok(await as(accountant, 'post', c('/review-settings'), { ...S.settings, reason: 'Firm settings (synthetic)' }), 201);
  ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: S.depreciationRun.asAt }), 201);
  const bankFlag = ok(await as(reviewer, 'get', c(`/review-checklist?yearStart=${Y}`))).controls.find((x: any) => x.code === 'RC-08').flags[0].key;
  ok(await as(accountant, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: bankFlag, note: 'The bank account is set up with the first statements next year (synthetic)' }));
  ok(await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: bankFlag }));
  for (let n = 1; n <= 11; n++) ok(await as(n === 11 ? partner : accountant, 'post', c('/year-end-workflow/sign-off'), { yearStart: Y, step: n, note: `Step ${n} reviewed (synthetic)` }));
  const d = await uploadDoc(s, owner, { companyId: company.id }); await waitForVersion(s, owner, d.documentId, d.versionId);
  ok(await as(owner, 'post', c('/accounts-approval/partner-review'), { yearStart: Y }));
  ok(await as(accountant, 'post', c(`/periods/${periodId}/close`), { reason: 'Year end (synthetic)' }));
  ok(await as(partner, 'post', c('/accounts-approval/client-approval'), { yearStart: Y, directorContactId: director, approvedOn: S.approval.approvedOn, evidenceDocumentId: d.documentId, note: 'Signed (synthetic)' }));
  const pkg = ok(await as(accountant, 'post', c('/accounts-package'), { yearStart: Y }), 201);
  return { company, yearStart: Y, yearEnd: G.year.yearEnd, standardCode, acc, partner, author, accountant, reviewer, director, evidence: d.documentId, pkg };
}
