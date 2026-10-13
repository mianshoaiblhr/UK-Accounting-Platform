import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M5a through the public API: sales settings, invoices and credit notes from draft to approval, attachments, reconciliation and the fences. Synthetic data only. */
let s: Stack;
let owner: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
let customerRole: string;
const GHOST = '11111111-1111-4111-8111-111111111111';
const base = `/companies/`;
const c = (p = '') => `${base}${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const line = (unitPrice: string, o: object = {}) => ({ description: 'Synthetic consultancy', quantity: '1', unitPrice, accountId: acc['4000'], ...o });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Sales Client');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' });
  for (const a of (await as(owner, 'post', c('/accounts/initialise'))).body.items) acc[a.code] = a.id;
  const contact = (await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'API Customer Ltd' })).body;
  customerRole = (await as(owner, 'post', c('/contact-roles'), { contactId: contact.id, role: 'CUSTOMER', accountCode: 'APICUST', paymentTermsDays: 14 })).body.id;
});
afterAll(() => s.stop());

describe('permissions: sales:read / sales:manage / sales:approve; settings need ledger:policy', () => {
  for (const [name, u, read, manage, approve] of [['partner', () => partner, true, true, true], ['accountant', () => accountant, true, true, true], ['manager', () => manager, true, true, false],
    ['bookkeeper', () => bookkeeper, true, true, false], ['reviewer', () => reviewer, true, false, false], ['client viewer', () => viewer, false, false, false]] as const) {
    it(`${name}: read ${read}, prepare ${manage}, approve ${approve}`, async () => {
      expect((await as(u(), 'get', c('/sales/documents'))).status).toBe(read ? 200 : 403);
      expect((await as(u(), 'post', c('/sales/invoices'), {})).status).toBe(manage ? 422 : 403);
      expect((await as(u(), 'post', c(`/sales/documents/${GHOST}/approve`), {})).status).toBe(approve ? 404 : 403);
    });
  }
  it('another organisation cannot see the company; the accountant cannot change sales settings', async () => {
    expect((await s.api().get(orgPath(owner, c('/sales/documents'))).set(bearer(outsider.token))).status).toBe(404);
    expect((await as(accountant, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Trying to configure sales' })).status).toBe(403);
  });
});

describe('sales end to end', () => {
  let inv: { id: string; journalId: string; documentNumber: string };
  it('the owner sets the receivables account; a non-receivables account is refused', async () => {
    expect((await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1110'], reason: 'Wrong account on purpose' })).body.code).toBe('receivables_account_invalid');
    const r = await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], requireSeparateApprover: true, reason: 'Receivables control and a second approver' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ receivablesAccountId: acc['1100'], invoicePrefix: 'INV-', requireSeparateApprover: true });
  });
  it('a bookkeeper prepares a draft; the bookkeeper cannot approve; the preparer cannot approve under the policy; an accountant approves and the journal links back', async () => {
    const d = await as(bookkeeper, 'post', c('/sales/invoices'), { customerRoleId: customerRole, issueDate: '2026-03-02', customerReference: 'PO-API-1', lines: [line('250.00', { quantity: '2' })] });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: 'DRAFT', dueDate: '2026-03-16', totals: { gross: '500.00' }, documentNumber: null });
    expect((await as(bookkeeper, 'post', c(`/sales/documents/${d.body.id}/approve`), {})).status).toBe(403);
    const self = await as(accountant, 'post', c('/sales/invoices'), { customerRoleId: customerRole, issueDate: '2026-03-03', lines: [line('1.00')] });
    expect((await as(accountant, 'post', c(`/sales/documents/${self.body.id}/approve`), {})).body.code).toBe('separate_approver_required');
    const a = await as(accountant, 'post', c(`/sales/documents/${d.body.id}/approve`), {});
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'APPROVED', documentNumber: 'INV-1', paymentStatus: 'UNPAID', outstanding: '500.00', contactSnapshot: { name: 'API Customer Ltd', accountCode: 'APICUST' } });
    inv = a.body;
    const j = await as(reviewer, 'get', c(`/journals/${inv.journalId}`));
    expect(j.body).toMatchObject({ sourceType: 'SALES_INVOICE', sourceId: inv.id, total: '500.00' });
    expect((await as(accountant, 'patch', c(`/sales/documents/${inv.id}`), { revision: 1, notes: 'late edit' })).body.code).toBe('document_not_draft');
    expect((await as(accountant, 'post', c(`/sales/documents/${inv.id}/discard`), { reason: 'Trying to discard an invoice' })).body.code).toBe('document_not_draft');
  });
  it('lists filter by kind and payment status; a reviewer reads the document with its lines', async () => {
    const l = await as(reviewer, 'get', `${c('/sales/invoices')}?paymentStatus=UNPAID`);
    expect(l.status).toBe(200);
    expect(l.body.items.map((x: { id: string }) => x.id)).toContain(inv.id);
    expect((await as(reviewer, 'get', `${c('/sales/invoices')}?paymentStatus=PAID`)).body.items.map((x: { id: string }) => x.id)).not.toContain(inv.id);
    const g = await as(reviewer, 'get', c(`/sales/documents/${inv.id}`));
    expect(g.body.lines).toEqual([expect.objectContaining({ quantity: '2', unitPrice: '250', net: '500.00' })]);
  });
  it('a stored document is attached to the invoice and listed with it', async () => {
    const doc = await as(owner, 'post', '/documents', { name: 'signed-order.pdf', companyId: company.id, contentType: 'application/pdf', sizeBytes: 60 });
    expect(doc.status).toBe(201);
    const docId = doc.body.document?.id ?? doc.body.id;
    const at = await as(bookkeeper, 'post', c(`/sales/documents/${inv.id}/attachments`), { documentId: docId, note: 'Customer purchase order' });
    expect(at.status).toBe(201);
    expect(at.body).toMatchObject({ kind: 'ATTACHED_TO', targetType: 'sales_document', targetId: inv.id });
    expect((await as(reviewer, 'get', c(`/sales/documents/${inv.id}/attachments`))).body.items.map((x: { sourceId: string }) => x.sourceId)).toEqual([docId]);
  });
  it('the ledger refuses to reverse the invoice journal; a credit note settles it; the receivables reconcile', async () => {
    expect((await as(accountant, 'post', c(`/journals/${inv.journalId}/reverse`), { reason: 'Trying to reverse a sales invoice' })).body.code).toBe('subledger_journal');
    const cn = await as(bookkeeper, 'post', c('/sales/credit-notes'), { originalInvoiceId: inv.id, issueDate: '2026-03-20', reason: 'Order cancelled by the customer' });
    expect(cn.status).toBe(201);
    const ca = await as(accountant, 'post', c(`/sales/documents/${cn.body.id}/approve`), {});
    expect(ca.body).toMatchObject({ documentNumber: 'CN-1', paymentStatus: 'ALLOCATED' });
    expect((await as(reviewer, 'get', c(`/sales/documents/${inv.id}`))).body).toMatchObject({ paymentStatus: 'PAID', creditNotes: [{ id: cn.body.id }] });
    const rec = await as(reviewer, 'get', c('/sales/reconciliation'));
    expect(rec.body).toMatchObject({ reconciled: true, currencies: [{ currency: 'GBP', openItems: '0.00', difference: '0.00' }] });
  });
  it('a customer role with open documents cannot end; a draft blocks closing its period unless acknowledged', async () => {
    const d = await as(bookkeeper, 'post', c('/sales/invoices'), { customerRoleId: customerRole, issueDate: '2026-04-02', lines: [line('10.00')] });
    const end = await as(owner, 'post', c(`/contact-roles/${customerRole}/end`), { reason: 'No longer trading with them' });
    expect(end.status).toBe(409);
    expect(end.body.code).toBe('contact_role_has_open_documents');
    const p = (await as(owner, 'get', c('/periods'))).body.items[0];
    expect((await as(owner, 'post', c(`/periods/${p.id}/close`), {})).body.code).toBe('unposted_documents');
    for (const id of [d.body.id, (await as(owner, 'get', `${c('/sales/invoices')}?status=DRAFT`)).body.items.map((x: { id: string }) => x.id)].flat()) {
      await as(bookkeeper, 'post', c(`/sales/documents/${id}/discard`), { reason: 'Not needed any more' });
    }
    expect((await as(owner, 'post', c(`/contact-roles/${customerRole}/end`), { reason: 'No longer trading with them' })).status).toBe(200);
  });
  it('requests are validated: strict bodies, decimal strings, dates in order', async () => {
    const bad = [
      { customerRoleId: customerRole, issueDate: '2026-04-02', lines: [line(12.5 as unknown as string)] },
      { customerRoleId: customerRole, issueDate: '2026-04-02', dueDate: '2026-04-01', lines: [line('1.00')] },
      { customerRoleId: customerRole, issueDate: '2026-04-02', lines: [] },
      { customerRoleId: customerRole, issueDate: '2026-04-02', lines: [line('1.00')], status: 'APPROVED' },
    ];
    for (const b of bad) expect((await as(bookkeeper, 'post', c('/sales/invoices'), b)).status).toBe(422);
  });
});

describe('receipts through the API (M5b)', () => {
  let role: string, inv: { id: string };
  it('a bookkeeper cannot record a receipt; an accountant records one with an allocation; the overpayment stays unallocated', async () => {
    const contact = (await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'API Payer Ltd' })).body;
    role = (await as(owner, 'post', c('/contact-roles'), { contactId: contact.id, role: 'CUSTOMER', accountCode: 'APIPAY', paymentTermsDays: 30 })).body.id;
    const d = await as(bookkeeper, 'post', c('/sales/invoices'), { customerRoleId: role, issueDate: '2026-05-01', lines: [line('120.00')] });
    inv = (await as(accountant, 'post', c(`/sales/documents/${d.body.id}/approve`), {})).body;
    const body = { customerRoleId: role, receiptDate: '2026-05-10', amount: '150.00', bankAccountId: acc['1200'], reference: 'FPS 123', allocations: [{ invoiceId: inv.id, amount: '120.00' }] };
    expect((await as(bookkeeper, 'post', c('/sales/receipts'), body)).status).toBe(403);
    const r = await as(accountant, 'post', c('/sales/receipts'), body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ amount: '150.00', unallocated: '30.00', status: 'POSTED', allocations: [{ invoiceId: inv.id, amount: '120.0000' }] });
    expect((await as(reviewer, 'get', c(`/sales/documents/${inv.id}`))).body.paymentStatus).toBe('PAID');
    expect((await as(reviewer, 'get', `${c('/sales/receipts')}?unallocated=true&customerRoleId=${role}`)).body.items.map((x: { id: string }) => x.id)).toEqual([r.body.id]);
    expect((await as(accountant, 'post', c(`/journals/${r.body.journalId}/reverse`), { reason: 'Trying the ledger route' })).body.code).toBe('subledger_journal');
  });
  it('a customer with unallocated credit cannot end; statement and ageing are available to readers', async () => {
    const end = await as(owner, 'post', c(`/contact-roles/${role}/end`), { reason: 'Stopped trading with them' });
    expect(end.body.code).toBe('contact_role_has_open_documents');
    const st = await as(reviewer, 'get', `${c(`/sales/customers/${role}/statement`)}?from=2026-05-01&to=2026-05-31`);
    expect(st.status).toBe(200);
    expect(st.body.currencies[0]).toMatchObject({ currency: 'GBP', opening: '0.00', closing: '-30.00' });
    const aged = await as(reviewer, 'get', `${c('/sales/aged-receivables')}?asOf=2026-06-30&customerRoleId=${role}`);
    expect(aged.body.customers[0]).toMatchObject({ unallocatedCredits: '-30.00', total: '-30.00' });
    expect((await as(viewer, 'get', c('/sales/aged-receivables'))).status).toBe(403);
    expect((await as(reviewer, 'get', `${c(`/sales/customers/${role}/statement`)}?from=2026-05-31&to=2026-05-01`)).status).toBe(422);
  });
});

describe('purchases through the API (M6a)', () => {
  let supplierRole: string;
  it('roles: bookkeeper prepares a bill, cannot approve; accountant approves; a supplier with an open bill cannot end; payables reconcile', async () => {
    await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control for the API tests' });
    const contact = (await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'API Supplier Ltd' })).body;
    supplierRole = (await as(owner, 'post', c('/contact-roles'), { contactId: contact.id, role: 'SUPPLIER', accountCode: 'APISUP', paymentTermsDays: 30, defaultExpenseAccountId: acc['6310'] })).body.id;
    expect((await as(reviewer, 'post', c('/purchases/bills'), {})).status).toBe(403);
    const d = await as(bookkeeper, 'post', c('/purchases/bills'), { supplierRoleId: supplierRole, supplierReference: 'SUP-INV-9', issueDate: '2026-06-01', lines: [{ description: 'Stationery', unitPrice: '45.00' }] });
    expect(d.status).toBe(201);
    expect(d.body.lines[0].accountId).toBe(acc['6310']);
    expect((await as(bookkeeper, 'post', c(`/purchases/documents/${d.body.id}/approve`), {})).status).toBe(403);
    expect((await as(bookkeeper, 'post', c('/purchases/bills'), { supplierRoleId: supplierRole, issueDate: '2026-06-01', lines: [{ description: 'x', unitPrice: '1.00' }] })).status).toBe(422); // supplier reference required
    const a = await as(accountant, 'post', c(`/purchases/documents/${d.body.id}/approve`), {});
    expect(a.body).toMatchObject({ status: 'APPROVED', documentNumber: 'BILL-1', supplierReference: 'SUP-INV-9', paymentStatus: 'UNPAID' });
    expect((await as(reviewer, 'get', c(`/journals/${a.body.journalId}`))).body).toMatchObject({ sourceType: 'PURCHASE_BILL', sourceId: d.body.id });
    expect((await as(owner, 'post', c(`/contact-roles/${supplierRole}/end`), { reason: 'Stopped buying from them' })).body.code).toBe('contact_role_has_open_documents');
    expect((await as(reviewer, 'get', c('/purchases/reconciliation'))).body).toMatchObject({ reconciled: true, currencies: [{ currency: 'GBP', openItems: '45.00', difference: '0.00' }] });
    expect((await as(viewer, 'get', c('/purchases/documents'))).status).toBe(403);
  });
});
