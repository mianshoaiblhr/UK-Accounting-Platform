import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** V2-M6a through the public API (v2-plan 5h.3): the golden review checklist (DEC-054, DEC-068) matched exactly, the response flow with its second-person rule, settings, permissions and tenancy. Synthetic data only. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m6a-review.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
const E = G.expected, Y = E.yearStart;

let s: Stack;
let owner: TestUser, partner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, refs = new Map<string, string>();   // entity id -> golden ref
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const checklist = async (u = reviewer) => ok(await as(u, 'get', c(`/review-checklist?yearStart=${Y}`)));
const control = (cl: any, code: string) => cl.controls.find((x: any) => x.code === code);
const flagOf = (cl: any, code: string, i = 0) => control(cl, code).flags[i];
/** How the golden names a flag's subject: the posting's reference where it has one, else the label's account code or party name. */
const subject = (f: any) => {
  const t = f.subject.type, id = t === 'customer' || t === 'supplier' ? f.subject.id.split(':')[0] : f.subject.id;
  return `${t}:${t === 'line' ? id : t === 'account' ? f.subject.label.split(' ')[0] : refs.get(id) ?? f.subject.label}`;
};

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, G.company.name);
  partner = await addMember(s, owner, 'partner');
  author = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  ok(await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  ok(await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  const doc = async () => { const d = await uploadDoc(s, owner, { companyId: company.id }); await waitForVersion(s, owner, d.documentId, d.versionId); return d.documentId; };
  // the opening balances (suspense), requested by the owner and approved by the partner
  const ob = G.openingBalance;
  const req = ok(await as(owner, 'post', c('/opening-balance-requests'), { journalDate: ob.date, description: ob.description, reason: 'Opening balances agreed to the prior accountant\'s trial balance (synthetic)',
    lines: ob.lines.map(([k, debit, credit]: string[]) => ({ accountId: acc[k!], debit, credit })), evidenceDocumentIds: [await doc()] }), 201);
  ok(await as(partner, 'post', c(`/journal-requests/${req.id}/approve`), {}));
  // the director, the loan account, the customer and the supplier
  const director = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.director }), 201).id;
  ok(await as(owner, 'post', c('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: G.company.appointedOn }), 201);
  const loan = ok(await as(accountant, 'post', c('/director-loan-accounts'), { contactId: director, kind: G.loanAccount.kind, accountId: acc[G.loanAccount.account], openedOn: G.loanAccount.openedOn }), 201);
  refs.set(loan.id, G.loanAccount.account);
  const cust = ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: G.company.customer }), 201).id;
  const supp = ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: G.company.supplier }), 201).id;
  const customer = ok(await as(owner, 'post', c('/contact-roles'), { contactId: cust, role: 'CUSTOMER', accountCode: 'LATE01' }), 201).id;
  const supplier = ok(await as(owner, 'post', c('/contact-roles'), { contactId: supp, role: 'SUPPLIER', accountCode: 'SLOW01' }), 201).id;
  refs.set(customer, G.company.customer); refs.set(supplier, G.company.supplier);
  // postings in date order
  const posts = [...G.cash.map((p: any) => ({ ...p, kind: 'cash' })), ...G.journals.map((j: any) => ({ ...j, kind: 'journal' })),
    { ...G.invoice, kind: 'invoice', date: G.invoice.issueDate }, ...G.bills.map((b: any) => ({ ...b, kind: 'bill', date: b.issueDate }))].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  for (const p of posts) {
    if (p.kind === 'cash') refs.set(ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description,
      lines: p.lines.map(([k, amount]: string[]) => ({ description: p.description, accountId: acc[k!], amount })) }), 201).id, p.ref);
    if (p.kind === 'journal') {
      const j = ok(await as(accountant, 'post', c('/journals'), { journalDate: p.date, description: p.description, lines: p.lines.map(([k, debit, credit]: string[]) => ({ accountId: acc[k!], debit, credit })) }), 201);
      refs.set(j.id, p.ref);
      if (p.evidence) ok(await as(accountant, 'post', '/evidence-links', { sourceType: 'document', sourceId: await doc(), targetType: 'journal', targetId: j.id, kind: 'SUPPORTS' }), 201);
    }
    if (p.kind === 'invoice') {
      const inv = ok(await as(accountant, 'post', c('/sales/invoices'), { customerRoleId: customer, issueDate: p.issueDate, dueDate: p.dueDate, lines: p.lines.map(([k, v]: string[]) => ({ description: 'Synthetic', quantity: '1', unitPrice: v, accountId: acc[k!], taxCodeId: null })) }), 201);
      ok(await as(accountant, 'post', c(`/sales/documents/${inv.id}/approve`), {}));
    }
    if (p.kind === 'bill') {
      const bill = ok(await as(accountant, 'post', c('/purchases/bills'), { supplierRoleId: supplier, issueDate: p.issueDate, dueDate: p.dueDate, supplierReference: p.supplierReference,
        lines: p.lines.map(([k, v]: string[]) => ({ description: 'Synthetic', quantity: '1', unitPrice: v, accountId: acc[k!] })) }), 201);
      ok(await as(accountant, 'post', c(`/purchases/documents/${bill.id}/approve`), {}));
      refs.set(bill.id, p.ref);
    }
  }
  // a verified synthetic version for the statements, and the framework years
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-REV', name: 'Synthetic review standard' }), 201).id;
  const versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic review v1', effectiveFrom: '2020-01-01',
    source: { url: 'https://example.test/synthetic-review', provision: 'Synthetic test content', retrievedOn: '2026-10-21' } }), 201).id;
  const v = c(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
  ok(await as(owner, 'post', `${v}/verify`, { notes: 'Synthetic version checked for the review golden' }));
  for (const f of G.frameworks) ok(await as(accountant, 'put', c('/reporting-frameworks'), { ...f, versionId, reason: 'Synthetic' }));
});
afterAll(() => s.stop());

describe('without settings', () => {
  it('the controls that need a setting are NOT_EVALUATED, never passed; the others raise their flags', async () => {
    const cl = await checklist();
    const by = (st: string) => cl.controls.filter((x: any) => x.status === st).map((x: any) => x.code);
    expect([by('NOT_EVALUATED'), by('OPEN')]).toEqual([E.withoutSettings.NOT_EVALUATED, E.withoutSettings.OPEN]);
    expect(cl.complete).toBe(false);
    expect((await as(reviewer, 'post', c('/review-settings'), { ...G.settings, reason: 'Not allowed' })).status).toBe(403);
    ok(await as(accountant, 'post', c('/review-settings'), { ...G.settings, reason: 'The firm\'s review settings (synthetic)' }), 201);
  });
});

describe('the golden checklist (DEC-054)', () => {
  it('every control raises exactly the hand-written flags with their figures', async () => {
    const cl = await checklist();
    for (const [code, expected] of Object.entries(E.controls) as [string, any[]][]) {
      const got = control(cl, code);
      expect(got.flags.map((f: any) => ({ subject: subject(f), figures: f.figures })), code).toEqual(expected);
      expect([got.status, got.counts.open], code).toEqual(['OPEN', E.counts[code]]);
    }
    expect(cl.complete).toBe(false);
    expect(cl.settings).toMatchObject({ unexplainedAmount: '1000.00', materialPercent: '20.00', oldItemDays: 60 });
  });
});

describe('responses (DEC-068)', () => {
  const key = async (code: string, i = 0) => flagOf(await checklist(), code, i).key;
  it('a preparer explains; a reviewer without accounts:review cannot sign off; a second person signs off', async () => {
    const k = await key('RC-07');
    expect((await as(reviewer, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: k, note: 'Not allowed' })).status).toBe(403);
    let cl = ok(await as(accountant, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: k, note: 'Opening difference agreed with the prior accountant; to be cleared to retained earnings' }));
    expect([control(cl, 'RC-07').status, flagOf(cl, 'RC-07').state]).toEqual(['EXPLAINED', 'EXPLAINED']);
    expect((await as(accountant, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: k })).status).toBe(403);
    cl = ok(await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: k, note: 'Agreed' }));
    expect([control(cl, 'RC-07').status, flagOf(cl, 'RC-07').responses.map((r: any) => r.action)]).toEqual(['SIGNED_OFF', ['EXPLAIN', 'SIGN_OFF']]);
    expect((await as(owner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: k })).body.code).toBe('flag_signed_off');
  });
  it('the person who explained cannot sign off; an unexplained flag cannot be signed off; an unknown flag is refused', async () => {
    const k = await key('RC-03');
    expect((await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: k })).body.code).toBe('flag_not_explained');
    ok(await as(partner, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: k, note: 'A refund of other income agreed with the customer' }));
    expect((await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: k })).body.code).toBe('self_sign_off_not_allowed');
    expect((await as(owner, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: 'RC-07:account:00000000-0000-4000-8000-000000000000', note: 'No such flag' })).body.code).toBe('flag_not_raised');
  });
  it('an explanation lapses when the flag\'s figures change; the flag is open again and marked changed', async () => {
    ok(await as(accountant, 'post', c('/journals'), { journalDate: '2026-11-30', description: 'A further refund (synthetic)', lines: [{ accountId: acc['4100'], debit: '50.00', credit: '0.00' }, { accountId: acc['1110'], debit: '0.00', credit: '50.00' }] }), 201);
    const cl = await checklist();
    expect([flagOf(cl, 'RC-03').figures.balance, flagOf(cl, 'RC-03').state, flagOf(cl, 'RC-03').changedSinceResponse]).toEqual(['-200.00', 'OPEN', true]);
    expect(control(cl, 'RC-04').flags.find((f: any) => f.subject.label.startsWith('1110')).figures.balance).toBe('-200.00');
    expect((await as(owner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: flagOf(cl, 'RC-03').key })).body.code).toBe('flag_not_explained');
  });
  it('a reviewer reopens a signed-off flag with a reason', async () => {
    const k = await key('RC-07');
    expect((await as(accountant, 'post', c('/review-flags/reopen'), { yearStart: Y, flagKey: k, note: 'Not allowed' })).status).toBe(403);
    const cl = ok(await as(owner, 'post', c('/review-flags/reopen'), { yearStart: Y, flagKey: k, note: 'Clear the suspense before approval instead' }));
    expect([control(cl, 'RC-07').status, flagOf(cl, 'RC-07').state]).toEqual(['OPEN', 'OPEN']);
    expect((await as(owner, 'post', c('/review-flags/reopen'), { yearStart: Y, flagKey: k, note: 'Again' })).body.code).toBe('flag_open');
  });
});

describe('bank accounts and resolved flags', () => {
  it('a bank account set up without a year-end reconciliation is raised; a signed reconciliation without a difference clears it', async () => {
    const bank = ok(await as(owner, 'post', c('/bank-accounts'), { accountId: acc['1210'], name: 'Deposit (synthetic)', statementOpeningDate: '2026-01-01' }), 201);
    let rc = control(await checklist(), 'RC-08');
    expect(rc.flags.map((f: any) => [f.subject.type, f.figures.reason])).toEqual([['account', 'NO_BANK_ACCOUNT'], ['bank', 'NOT_RECONCILED']]);
    ok(await as(owner, 'post', c(`/bank-accounts/${bank.id}/reconciliations`), { asOf: '2026-12-31', bankClosingBalance: '0.00' }), 201);
    rc = control(await checklist(), 'RC-08');
    expect(rc.flags.map((f: any) => f.subject.type)).toEqual(['account']);
  });
  it('a flag that is no longer raised keeps its history under resolved', async () => {
    const k = flagOf(await checklist(), 'RC-01').key;
    ok(await as(accountant, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: k, note: 'Travel claim approved by the board (synthetic)' }));
    ok(await as(accountant, 'post', c('/review-settings'), { ...G.settings, unexplainedAmount: '5000.00', reason: 'Raised the threshold (synthetic)' }), 201);
    const cl = await checklist();
    expect([control(cl, 'RC-01').status, cl.resolved.find((r: any) => r.key === k)?.lastAction]).toEqual(['CLEAR', 'EXPLAIN']);
    expect(ok(await as(reviewer, 'get', c('/review-settings'))).history).toHaveLength(2);
  });
});

describe('permissions and tenancy', () => {
  it('reading needs ledger:read; another organisation sees nothing; an unknown year is refused', async () => {
    expect((await as(outsider, 'get', c(`/review-checklist?yearStart=${Y}`))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/review-checklist?yearStart=2030-01-01'))).body.code).toBe('framework_not_set');
  });
});
