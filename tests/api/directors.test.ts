import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/** V2-M4 through the public API (v2-plan 5c.3): the golden loan accounts and related-party report (DEC-054, DEC-062) to the cent, thresholds, refusals, permissions and tenancy. Synthetic data. */
type Year = { from: string; to: string; opening: string; closing: string; movements: [string, string, string, string, string][]; byCategory: Record<string, string>; lowest: string; lowestOn: string; daysOverdrawn: number;
  flags: string[]; notEvaluated: string[]; flagsWithThresholds: string[]; largeMovements: string[] };
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m4-directors.json'), 'utf8')) as {
  periods: [string, string][]; accounts: Record<string, string>[];
  people: Record<'A' | 'B', { name: string; kind: string; account: string; officer?: { role: string; appointedOn: string } }>;
  postings: ({ ref: string; kind: 'cash'; direction: string; date: string; lines: [string, string][]; description: string } | { ref: string; kind: 'journal'; date: string; lines: [string, string, string][]; description: string })[];
  loanAccounts: { A: { year: Year; secondHalf: { from: string; to: string; opening: string; closing: string; movements: string[]; lowest: string; lowestOn: string; daysOverdrawn: number; flags: string[] } }; B: { year: Year } };
  thresholds: { largeMovement: string; overdrawn: string; reason: string };
  relatedCompany: { name: string; relationship: string; from: string; description: string; documents: Record<string, any>[] };
  relatedReport: { from: string; to: string; parties: Record<string, Record<string, any>> };
};

let s: Stack;
let owner: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, refs: Record<string, string> = {}, contacts: Record<string, string> = {}, loans: Record<string, string> = {}, parties: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const statement = async (id: string, from: string, to: string) => ok(await as(reviewer, 'get', c(`/director-loan-accounts/${id}/statement?from=${from}&to=${to}`))).statement;
const checkYear = (st: any, y: Year, withThresholds: boolean) => {
  expect([st.opening, st.closing, st.lowest, st.lowestOn, st.daysOverdrawn]).toEqual([y.opening, y.closing, y.lowest, y.lowestOn, y.daysOverdrawn]);
  expect(st.movements.map((m: any) => [m.journalId, m.date, m.amount, m.category, m.balance])).toEqual(y.movements.map(([ref, ...rest]) => [refs[ref], ...rest]));
  expect(Object.fromEntries(st.byCategory.map((x: any) => [x.category, x.amount]))).toEqual(y.byCategory);
  if (withThresholds) {
    expect([st.flags, st.notEvaluated, st.largeMovementJournalIds]).toEqual([y.flagsWithThresholds, [], y.largeMovements.map((r) => refs[r])]);
  } else expect([st.flags, st.notEvaluated]).toEqual([y.flags, y.notEvaluated]);
};

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Golden Directors Ltd');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const a of G.accounts) acc[a.code!] = ok(await as(owner, 'post', c('/accounts'), a), 201).id;
  ok(await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  ok(await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  for (const [k, p] of Object.entries(G.people)) {
    contacts[k] = ok(await as(owner, 'post', '/contacts', { kind: 'PERSON', name: p.name }), 201).id;
    if (p.officer) ok(await as(owner, 'post', c('/officers'), { contactId: contacts[k], role: p.officer.role, appointedOn: p.officer.appointedOn }), 201);
  }
  for (const p of G.postings) {
    const r = p.kind === 'cash'
      ? ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description, lines: p.lines.map(([k, amount]) => ({ description: p.description, accountId: acc[k], amount })) }), 201)
      : ok(await as(accountant, 'post', c('/journals'), { journalDate: p.date, description: p.description, lines: p.lines.map(([k, debit, credit]) => ({ accountId: acc[k], debit, credit })) }), 201);
    refs[p.ref] = r.journalId ?? r.id;
  }
  // the related company: customer and supplier, with documents, settlements and a cash payment
  const rc = G.relatedCompany;
  contacts.H = ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: rc.name }), 201).id;
  const customer = ok(await as(owner, 'post', c('/contact-roles'), { contactId: contacts.H, role: 'CUSTOMER', accountCode: 'ALEXH' }), 201).id;
  const supplier = ok(await as(owner, 'post', c('/contact-roles'), { contactId: contacts.H, role: 'SUPPLIER', accountCode: 'ALEXHS' }), 201).id;
  const docs: Record<string, any> = {};
  const line = (account: string, price: string) => ({ description: 'Synthetic', quantity: '1', unitPrice: price, accountId: acc[account] });
  for (const d of rc.documents) {
    let r: any;
    if (d.kind === 'invoice') r = ok(await as(accountant, 'post', c('/sales/invoices'), { customerRoleId: customer, issueDate: d.date, lines: d.lines.map(([k, v]: string[]) => ({ ...line(k!, v!), taxCodeId: null })) }), 201);
    if (d.kind === 'creditNote') r = ok(await as(accountant, 'post', c('/sales/credit-notes'), { originalInvoiceId: docs[d.of].id, issueDate: d.date, reason: d.reason, lines: d.lines.map(([k, v]: string[]) => ({ ...line(k!, v!), taxCodeId: null })) }), 201);
    if (d.kind === 'invoice' || d.kind === 'creditNote') r = ok(await as(accountant, 'post', c(`/sales/documents/${r.id}/approve`), {}));
    if (d.kind === 'receipt') r = ok(await as(accountant, 'post', c('/sales/receipts'), { customerRoleId: customer, receiptDate: d.date, amount: d.amount, bankAccountId: acc['1200'], allocations: [{ invoiceId: docs[d.allocate].id, amount: d.amount }] }), 201);
    if (d.kind === 'bill') {
      r = ok(await as(accountant, 'post', c('/purchases/bills'), { supplierRoleId: supplier, issueDate: d.date, supplierReference: d.supplierReference, lines: d.lines.map(([k, v]: string[]) => line(k!, v!)) }), 201);
      r = ok(await as(accountant, 'post', c(`/purchases/documents/${r.id}/approve`), {}));
    }
    if (d.kind === 'payment') r = ok(await as(accountant, 'post', c('/purchases/payments'), { supplierRoleId: supplier, paymentDate: d.date, amount: d.amount, bankAccountId: acc['1200'], allocations: [{ billId: docs[d.allocate].id, amount: d.amount }] }), 201);
    if (d.kind === 'cash') r = ok(await as(accountant, 'post', c('/cash-transactions'), { direction: d.direction, transactionDate: d.date, bankAccountId: acc['1200'], description: d.description, contactId: contacts.H,
      lines: d.lines.map(([k, amount]: string[]) => ({ description: d.description, accountId: acc[k!], amount })) }), 201);
    docs[d.ref] = r;
    refs[d.ref] = r.journalId;
  }
});
afterAll(() => s.stop());

describe('loan accounts (DEC-062)', () => {
  it('a loan account sits on a dedicated non-control account; a director needs an appointment; only accounts:prepare may register one', async () => {
    const body = (k: 'A' | 'B') => ({ contactId: contacts[k], kind: G.people[k].kind, accountId: acc[G.people[k].account], openedOn: '2026-01-01' });
    expect((await as(bookkeeper, 'post', c('/director-loan-accounts'), body('A'))).status).toBe(403);
    expect((await as(reviewer, 'post', c('/director-loan-accounts'), body('A'))).status).toBe(403);
    expect((await as(accountant, 'post', c('/director-loan-accounts'), { ...body('A'), accountId: acc['1200'] })).body.code).toBe('invalid_loan_account');
    expect((await as(accountant, 'post', c('/director-loan-accounts'), { ...body('A'), accountId: acc['2100'] })).body.code).toBe('invalid_loan_account');
    expect((await as(accountant, 'post', c('/director-loan-accounts'), { ...body('B'), kind: 'DIRECTOR' })).body.code).toBe('not_a_director');
    for (const k of ['A', 'B'] as const) loans[k] = ok(await as(accountant, 'post', c('/director-loan-accounts'), body(k)), 201).id;
    expect((await as(accountant, 'post', c('/director-loan-accounts'), { ...body('B'), contactId: contacts.A, kind: 'DIRECTOR' })).body.code).toBe('loan_account_exists');
    expect(ok(await as(reviewer, 'get', c('/director-loan-accounts'))).items.map((x: any) => [x.contactName, x.accountCode, x.status])).toEqual([['Alex Director', '2230', 'ACTIVE'], ['Blair Holder', '2231', 'ACTIVE']]);
  });
  it('without thresholds: the golden statements, categories, lowest balances and days overdrawn; size flags are not evaluated', async () => {
    for (const k of ['A', 'B'] as const) {
      const y = G.loanAccounts[k].year;
      checkYear(await statement(loans[k]!, y.from, y.to), y, false);
    }
    const h = G.loanAccounts.A.secondHalf;
    const st = await statement(loans.A!, h.from, h.to);
    expect([st.opening, st.closing, st.lowest, st.lowestOn, st.daysOverdrawn, st.flags]).toEqual([h.opening, h.closing, h.lowest, h.lowestOn, h.daysOverdrawn, h.flags]);
    expect(st.movements.map((m: any) => m.journalId)).toEqual(h.movements.map((r) => refs[r]));
  });
  it('the firm sets review thresholds with a reason; the flags follow; the history is kept', async () => {
    const t = G.thresholds;
    expect((await as(reviewer, 'put', c('/director-loan-thresholds'), { largeMovement: t.largeMovement, overdrawn: t.overdrawn, reason: t.reason })).status).toBe(403);
    ok(await as(accountant, 'put', c('/director-loan-thresholds'), { largeMovement: '9999.00', overdrawn: null, reason: 'First setting (synthetic)' }));
    const r = ok(await as(accountant, 'put', c('/director-loan-thresholds'), { largeMovement: t.largeMovement, overdrawn: t.overdrawn, reason: t.reason }));
    expect(r.current).toMatchObject({ largeMovement: t.largeMovement, overdrawn: t.overdrawn, reason: t.reason });
    expect(r.history.map((x: any) => x.largeMovement)).toEqual([t.largeMovement, '9999.00']);
    for (const k of ['A', 'B'] as const) {
      const y = G.loanAccounts[k].year;
      checkYear(await statement(loans[k]!, y.from, y.to), y, true);
    }
    const rep = ok(await as(reviewer, 'get', c('/director-loan-accounts/report?from=2026-01-01&to=2026-12-31')));
    expect(rep.items.map((x: any) => [x.contactName, x.closing, x.flags])).toEqual([['Alex Director', '50.00', G.loanAccounts.A.year.flagsWithThresholds], ['Blair Holder', '-550.00', G.loanAccounts.B.year.flagsWithThresholds]]);
    expect(rep.flagged).toBe(2);
  });
});

describe('related parties (DEC-062)', () => {
  it('the register: three parties; only accounts:prepare may record one; a duplicate live entry is refused', async () => {
    const rc = G.relatedCompany;
    expect((await as(bookkeeper, 'post', c('/related-parties'), { contactId: contacts.H, relationship: rc.relationship, description: rc.description, fromDate: rc.from })).status).toBe(403);
    parties.H = ok(await as(accountant, 'post', c('/related-parties'), { contactId: contacts.H, relationship: rc.relationship, description: rc.description, fromDate: rc.from }), 201).id;
    parties.A = ok(await as(accountant, 'post', c('/related-parties'), { contactId: contacts.A, relationship: 'DIRECTOR', description: 'Director', fromDate: '2020-01-01' }), 201).id;
    parties.B = ok(await as(accountant, 'post', c('/related-parties'), { contactId: contacts.B, relationship: 'SHAREHOLDER', description: 'Shareholder', fromDate: '2026-01-01' }), 201).id;
    expect((await as(accountant, 'post', c('/related-parties'), { contactId: contacts.H, relationship: rc.relationship, description: 'Again', fromDate: rc.from })).body.code).toBe('related_party_exists');
  });
  it('the year report: the golden figures and the journals behind them', async () => {
    const R = G.relatedReport;
    const rep = ok(await as(reviewer, 'get', c(`/related-parties/report?from=${R.from}&to=${R.to}`)));
    for (const [name, e] of Object.entries(R.parties)) {
      const p = rep.items.find((x: any) => x.contactName === name);
      const fg = p.figures;
      expect([fg.sales.amount, fg.purchases.amount, fg.cashPaid.amount, fg.cashReceived.amount, fg.owedBy.amount, fg.owedTo.amount], name)
        .toEqual([e.sales, e.purchases, e.cashPaid, e.cashReceived, e.owedBy, e.owedTo]);
      if (e.salesJournals) {
        expect(fg.sales.journals.map((j: any) => j.journalId)).toEqual(e.salesJournals.map((r: string) => refs[r]));
        expect(fg.purchases.journals.map((j: any) => j.journalId)).toEqual(e.purchaseJournals.map((r: string) => refs[r]));
        expect(fg.cashPaid.journals.map((j: any) => j.journalId)).toEqual(e.cashJournals.map((r: string) => refs[r]));
      }
      expect(e.loanAccount === null ? fg.loanAccounts : fg.loanAccounts.map((l: any) => ({ closing: l.closing, lowest: l.lowest }))).toEqual(e.loanAccount === null ? [] : [e.loanAccount]);
    }
  });
  it('a party is ended once with a reason; a loan account is closed once; outsiders see nothing', async () => {
    expect((await as(accountant, 'post', c(`/related-parties/${parties.B}/end`), { toDate: '2025-12-31', reason: 'Before it began' })).body.code).toBe('invalid_date');
    expect(ok(await as(accountant, 'post', c(`/related-parties/${parties.B}/end`), { toDate: '2026-12-31', reason: 'Shares sold (synthetic)' }))).toMatchObject({ status: 'ENDED', toDate: '2026-12-31' });
    expect((await as(accountant, 'post', c(`/related-parties/${parties.B}/end`), { toDate: '2026-12-31', reason: 'Again' })).body.code).toBe('related_party_ended');
    // an ended party still reports for the year it overlaps, and not for a later one
    expect(ok(await as(reviewer, 'get', c('/related-parties/report?from=2027-01-01&to=2027-12-31'))).items.map((x: any) => x.contactName)).not.toContain('Blair Holder');
    expect(ok(await as(accountant, 'post', c(`/director-loan-accounts/${loans.B}/close`), { closedOn: '2026-12-31', reason: 'Balance to be repaid (synthetic)' }))).toMatchObject({ status: 'CLOSED' });
    expect((await as(accountant, 'post', c(`/director-loan-accounts/${loans.B}/close`), { closedOn: '2026-12-31', reason: 'Again' })).body.code).toBe('loan_account_closed');
    expect((await as(outsider, 'get', c('/director-loan-accounts'))).status).toBe(404);
    expect((await as(outsider, 'get', c('/related-parties/report?from=2026-01-01&to=2026-12-31'))).status).toBe(404);
    expect(adminSql(`SELECT string_agg(action, ',' ORDER BY action) FROM (SELECT DISTINCT action FROM audit_event WHERE action LIKE 'directors.%' AND organisation_id = (SELECT organisation_id FROM company WHERE id = '${company.id}')) x`))
      .toBe('directors.loan_account_closed,directors.loan_account_created,directors.related_party_created,directors.related_party_ended,directors.thresholds_set');
  });
});
