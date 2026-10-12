import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M4a through the public API: customers and suppliers as roles of shared contacts, with protected supplier bank details. Synthetic data only. */
let s: Stack;
let owner: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser, assignedOther: TestUser;
let company: { id: string }, otherCompany: { id: string };
const acc: Record<string, string> = {};
const GHOST = '11111111-1111-4111-8111-111111111111';
const base = (c = company.id) => `/companies/${c}/contact-roles`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const contact = async (name: string, over: object = {}) => (await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name, ...over })).body;
const BANK = { accountName: 'Synthetic Supplies Ltd', sortCode: '12-34-56', accountNumber: '87654321', reason: 'Supplier letter on headed paper, 1 March' };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Roles Client');
  otherCompany = await makeCompany(s, owner, 'Roles Other');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  assignedOther = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [otherCompany.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const a of (await as(owner, 'post', `/companies/${company.id}/accounts/initialise`)).body.items) acc[a.code] = a.id;
});
afterAll(() => s.stop());

describe('customers and suppliers are roles of one shared contact', () => {
  let shared: { id: string }, cust: string, supp: string;
  it('a contact becomes a customer and a supplier of the same company, each with its own terms; a VAT number is stored normalised', async () => {
    shared = await contact('Both Ways Ltd', { vatNumber: 'gb 123 4567 89' });
    expect((await as(owner, 'get', `/contacts/${shared.id}`)).body.vatNumber).toBe('GB123456789');
    const c = await as(bookkeeper, 'post', base(), { contactId: shared.id, role: 'CUSTOMER', accountCode: 'BOTH01', paymentTermsDays: 14, creditLimit: '5000.00', defaultCurrency: 'EUR' });
    expect(c.status).toBe(201);
    cust = c.body.id;
    expect(c.body).toMatchObject({ role: 'CUSTOMER', accountCode: 'BOTH01', status: 'ACTIVE', contact: { name: 'Both Ways Ltd', vatNumber: 'GB123456789' }, customer: { paymentTermsDays: 14, creditLimit: '5000.00', defaultCurrency: 'EUR' }, supplier: null });
    const sp = await as(bookkeeper, 'post', base(), { contactId: shared.id, role: 'SUPPLIER', accountCode: 'BOTH01', paymentTermsDays: 30, defaultExpenseAccountId: acc['6310'] });
    expect(sp.status).toBe(201);
    supp = sp.body.id;
    expect(sp.body.supplier).toMatchObject({ paymentTermsDays: 30, defaultExpenseAccountId: acc['6310'], bankDetails: { status: 'NONE', masked: null } });
    expect((await as(bookkeeper, 'post', base(), { contactId: shared.id, role: 'CUSTOMER' })).body.code).toBe('contact_role_exists');
    // the same organisation-level contact can also be a customer of another company
    expect((await as(owner, 'post', base(otherCompany.id), { contactId: shared.id, role: 'CUSTOMER' })).status).toBe(201);
  });
  it('validation: unknown contact, archived contact, a contact of another company, duplicate account code, wrong fields per role, bad expense account', async () => {
    expect((await as(owner, 'post', base(), { contactId: GHOST, role: 'CUSTOMER' })).body.code).toBe('unknown_contact');
    const archived = await contact('Gone Ltd');
    await as(owner, 'post', `/contacts/${archived.id}/archive?reason=closed`);
    expect((await as(owner, 'post', base(), { contactId: archived.id, role: 'CUSTOMER' })).body.code).toBe('contact_archived');
    const linked = await contact('Belongs Elsewhere Ltd', { companyId: otherCompany.id });
    expect((await as(owner, 'post', base(), { contactId: linked.id, role: 'CUSTOMER' })).body.code).toBe('contact_other_company');
    const other = await contact('Second Ltd');
    expect((await as(owner, 'post', base(), { contactId: other.id, role: 'CUSTOMER', accountCode: 'both01' })).body.code).toBe('account_code_exists');
    expect((await as(owner, 'post', base(), { contactId: other.id, role: 'SUPPLIER', creditLimit: '10' })).status).toBe(422);
    expect((await as(owner, 'post', base(), { contactId: other.id, role: 'SUPPLIER', defaultExpenseAccountId: acc['1100'] })).body.code).toBe('invalid_account');      // a control account
    expect((await as(owner, 'post', base(), { contactId: other.id, role: 'SUPPLIER', defaultExpenseAccountId: GHOST })).body.code).toBe('unknown_account');
    expect((await as(owner, 'post', base(), { contactId: other.id, role: 'CUSTOMER', defaultCurrency: 'ZZZ' })).body.code).toBe('unknown_currency');
    expect((await as(owner, 'post', '/contacts', { kind: 'PERSON', name: 'Bad VAT', vatNumber: 'GB12' })).status).toBe(422);
  });
  it('lists customers and suppliers with filters and search; updates are audited with before/after; a credit-limit change needs a reason', async () => {
    const customers = (await as(reviewer, 'get', `${base()}?role=CUSTOMER`)).body.items;
    expect(customers.every((r: { role: string }) => r.role === 'CUSTOMER')).toBe(true);
    expect((await as(reviewer, 'get', `${base()}?q=both`)).body.items.map((r: { id: string }) => r.id).sort()).toEqual([cust, supp].sort());
    expect((await as(accountant, 'patch', `${base()}/${cust}`, { creditLimit: '7500.00' })).body.code).toBe('reason_required');
    const u = await as(accountant, 'patch', `${base()}/${cust}`, { creditLimit: '7500.00', paymentTermsDays: 21, reason: 'Credit committee review' });
    expect(u.body.customer).toMatchObject({ creditLimit: '7500.00', paymentTermsDays: 21 });
    const audit = (await as(owner, 'get', `/audit-events?entityType=contact_role&entityId=${cust}`)).body.items.find((e: { action: string }) => e.action === 'contact_role.updated');
    expect(audit).toMatchObject({ reason: 'Credit committee review', before: { creditLimit: '5000.00', paymentTermsDays: 14 }, after: { creditLimit: '7500.00', paymentTermsDays: 21 } });
    expect((await as(accountant, 'patch', `${base()}/${supp}`, { creditLimit: '1', reason: 'not for suppliers' })).body.code).toBe('invalid_field');
  });
  it('ending keeps the role (with its reason) and blocks changes until reactivated', async () => {
    const e = await as(accountant, 'post', `${base()}/${cust}/end`, { reason: 'Stopped trading with us' });
    expect(e.body).toMatchObject({ status: 'ENDED', endedReason: 'Stopped trading with us' });
    expect((await as(accountant, 'patch', `${base()}/${cust}`, { paymentTermsDays: 7 })).body.code).toBe('contact_role_ended');
    expect((await as(accountant, 'get', `${base()}/${cust}/snapshot`)).body.code).toBe('contact_role_ended');
    expect((await as(accountant, 'post', `${base()}/${cust}/end`, { reason: 'again' })).body.code).toBe('invalid_role_state');
    expect((await as(reviewer, 'get', `${base()}?status=ENDED`)).body.items.map((r: { id: string }) => r.id)).toContain(cust);
    expect((await as(accountant, 'post', `${base()}/${cust}/reactivate`, {})).body.status).toBe('ACTIVE');
  });
  it('the snapshot captures what a document needs: legal name, VAT number, account code and the primary address', async () => {
    await as(owner, 'post', `/contacts/${shared.id}/addresses`, { kind: 'TRADING', line1: '1 Other Street', city: 'Leeds', countryCode: 'GB' });
    await as(owner, 'post', `/contacts/${shared.id}/addresses`, { kind: 'REGISTERED_OFFICE', line1: '2 Main Street', city: 'York', postcode: 'YO1 7HH', countryCode: 'GB', primary: true });
    const snap = (await as(reviewer, 'get', `${base()}/${cust}/snapshot`)).body;
    expect(snap).toMatchObject({ roleId: cust, role: 'CUSTOMER', accountCode: 'BOTH01', name: 'Both Ways Ltd', vatNumber: 'GB123456789', address: { line1: '2 Main Street', city: 'York', postcode: 'YO1 7HH' } });
  });
});

describe('supplier bank details: encrypted, masked, audited, verified by a second person', () => {
  let supp: string;
  beforeAll(async () => {
    const c = await contact('Bank Detail Suppliers Ltd');
    supp = (await as(owner, 'post', base(), { contactId: c.id, role: 'SUPPLIER' })).body.id;
  });
  it('only holders of contact:bank-details may set or read them (owner, partner, accountant; not manager, bookkeeper, reviewer)', async () => {
    for (const u of [manager, bookkeeper, reviewer, viewer]) {
      expect((await as(u, 'put', `${base()}/${supp}/bank-details`, BANK)).status).toBe(403);
      expect((await as(u, 'get', `${base()}/${supp}/bank-details`)).status).toBe(403);
    }
  });
  it('setting them stores ciphertext only, shows a mask everywhere, starts UNVERIFIED and audits the masked change with its reason', async () => {
    const r = await as(accountant, 'put', `${base()}/${supp}/bank-details`, BANK);
    expect(r.status).toBe(200);
    expect(r.body.supplier.bankDetails).toMatchObject({ status: 'UNVERIFIED', masked: 'S*** - sort code **-**-56, account ****4321', changedByUserId: accountant.userId });
    const stored = adminSql(`SELECT bank_details_enc FROM supplier_profile WHERE role_id='${supp}'`);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('87654321');
    expect(stored).not.toContain('123456');
    const list = JSON.stringify((await as(reviewer, 'get', base())).body);
    expect(list).not.toContain('87654321');
    const audits = JSON.stringify((await as(owner, 'get', `/audit-events?entityType=contact_role&entityId=${supp}`)).body);
    expect(audits).toContain('supplier.bank_details_changed');
    expect(audits).not.toContain('87654321');
    expect(audits).toContain('Supplier letter on headed paper');
  });
  it('the full details are readable only through the dedicated endpoint, and each read is audited', async () => {
    const v = await as(partner, 'get', `${base()}/${supp}/bank-details`);
    expect(v.body).toMatchObject({ accountName: 'Synthetic Supplies Ltd', sortCode: '123456', accountNumber: '87654321', status: 'UNVERIFIED' });
    const views = (await as(owner, 'get', `/audit-events?entityType=contact_role&entityId=${supp}`)).body.items.filter((e: { action: string }) => e.action === 'supplier.bank_details_viewed');
    expect(views[0]).toMatchObject({ actorUserId: partner.userId });
    expect(JSON.stringify(views)).not.toContain('87654321');
  });
  it('a second person verifies; the person who entered them cannot; a later change resets to UNVERIFIED', async () => {
    expect((await as(accountant, 'post', `${base()}/${supp}/bank-details/verify`, {})).body.code).toBe('self_verification_not_allowed');
    const ok = await as(partner, 'post', `${base()}/${supp}/bank-details/verify`, { note: 'Called the supplier on the number already on file' });
    expect(ok.body.supplier.bankDetails).toMatchObject({ status: 'VERIFIED', verifiedByUserId: partner.userId });
    expect((await as(owner, 'post', `${base()}/${supp}/bank-details/verify`, {})).body.code).toBe('already_verified');
    const changed = await as(owner, 'put', `${base()}/${supp}/bank-details`, { accountName: 'Synthetic Supplies Ltd', iban: 'GB82 WEST 1234 5698 7654 32', bic: 'WESTGB2L', reason: 'Supplier moved banks, letter dated 5 March' });
    expect(changed.body.supplier.bankDetails).toMatchObject({ status: 'UNVERIFIED', masked: 'S*** - IBAN GB** **** 5432', verifiedByUserId: null });
    expect((await as(partner, 'post', `${base()}/${supp}/bank-details/verify`, {})).body.supplier.bankDetails.status).toBe('VERIFIED');
  });
  it('bank details exist for suppliers only; invalid details are refused', async () => {
    const c = await contact('Customer Only Ltd');
    const cust = (await as(owner, 'post', base(), { contactId: c.id, role: 'CUSTOMER' })).body.id;
    expect((await as(owner, 'put', `${base()}/${cust}/bank-details`, BANK)).body.code).toBe('not_a_supplier');
    expect((await as(owner, 'put', `${base()}/${supp}/bank-details`, { ...BANK, accountNumber: '123' })).status).toBe(422);
    expect((await as(owner, 'put', `${base()}/${supp}/bank-details`, { ...BANK, reason: 'short' })).status).toBe(422);
    expect((await as(owner, 'get', `${base()}/${cust}/bank-details`)).body.code).toBe('not_a_supplier');
  });
});

describe('permissions and isolation', () => {
  it('reading needs contact:read (client viewer cannot); creating needs contact:manage (reviewer cannot)', async () => {
    expect((await as(viewer, 'get', base())).status).toBe(403);
    const c = await contact('Permission Probe Ltd');
    expect((await as(reviewer, 'post', base(), { contactId: c.id, role: 'CUSTOMER' })).status).toBe(403);
  });
  it('another company\'s path does not reveal a role; an assigned-elsewhere member and an outsider get 404', async () => {
    const c = await contact('Isolation Ltd');
    const r = (await as(owner, 'post', base(), { contactId: c.id, role: 'CUSTOMER' })).body.id;
    expect((await as(owner, 'get', `${base(otherCompany.id)}/${r}`)).status).toBe(404);
    expect((await as(assignedOther, 'get', base())).status).toBe(404);
    expect((await s.api().get(orgPath(owner, base())).set(bearer(outsider.token))).status).toBe(404);
  });
});
