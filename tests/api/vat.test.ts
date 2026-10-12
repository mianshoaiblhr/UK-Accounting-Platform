import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M4b through the public API: VAT codes, sourced rate versions verified by a second person, VAT on journals and the workpaper. SYNTHETIC rates only. */
let s: Stack;
let owner: TestUser, admin: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string }, otherCompany: { id: string };
const acc: Record<string, string> = {};
const GHOST = '11111111-1111-4111-8111-111111111111';
const base = (c = company.id) => `/companies/${c}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const SOURCE = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026 s.1 (test fixture)', retrievedOn: '2026-01-01' };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'VAT Client');
  otherCompany = await makeCompany(s, owner, 'VAT Other');
  admin = await addMember(s, owner, 'admin');
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  await as(owner, 'post', `${base()}/periods`, { startDate: '2026-01-01', endDate: '2026-12-31' });
  for (const a of (await as(owner, 'post', `${base()}/accounts/initialise`)).body.items) acc[a.code] = a.id;
  acc['1150'] = (await as(owner, 'post', `${base()}/accounts`, { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', taxTreatment: 'VAT_CONTROL' })).body.id;
});
afterAll(() => s.stop());

describe('permissions: vat:manage (owner, admin, partner, accountant) and tax:rule-verify (owner and admin only, by default)', () => {
  for (const [name, u, manage, verify] of [['owner', () => owner, true, true], ['admin', () => admin, true, true], ['partner', () => partner, true, false], ['accountant', () => accountant, true, false],
    ['manager', () => manager, false, false], ['bookkeeper', () => bookkeeper, false, false], ['reviewer', () => reviewer, false, false]] as const) {
    it(`${name}: ${manage ? 'may' : 'may not'} maintain VAT codes; ${verify ? 'may' : 'may not'} verify VAT rules`, async () => {
      const m = (await as(u(), 'post', `${base()}/tax-codes`, {})).status;
      const v = (await as(u(), 'post', `${base()}/tax-rates/${GHOST}/verify`, {})).status;
      expect(manage ? m : 403).toBe(manage ? 422 : m);
      expect(verify ? v : 403).toBe(verify ? 422 : v);
    });
  }
  it('reading needs ledger:read; a client viewer cannot; another organisation cannot see the company', async () => {
    expect((await as(reviewer, 'get', `${base()}/tax-codes`)).status).toBe(200);
    expect((await as(viewer, 'get', `${base()}/tax-codes`)).status).toBe(403);
    expect((await s.api().get(orgPath(owner, `${base()}/tax-codes`)).set(bearer(outsider.token))).status).toBe(404);
  });
});

describe('VAT end to end', () => {
  let sales: string, salesRate: string;
  it('an accountant creates a code and a sourced rate version; it is UNVERIFIED and cannot be used', async () => {
    const c = await as(accountant, 'post', `${base()}/tax-codes`, { code: 'SX', name: 'Synthetic standard sales', treatment: 'STANDARD', direction: 'SALES' });
    expect(c.status).toBe(201);
    sales = c.body.id;
    const r = await as(accountant, 'post', `${base()}/tax-codes/${sales}/rates`, { rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: SOURCE });
    expect(r.status).toBe(201);
    salesRate = r.body.id;
    expect(r.body).toMatchObject({ rate: '12.5000', verificationStatus: 'UNVERIFIED', source: SOURCE, enteredByUserId: accountant.userId });
    expect((await as(accountant, 'post', `${base()}/tax-codes/${sales}/rates`, { rate: '12.5', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: { ...SOURCE, url: 'nope' } })).status).toBe(422);
  });
  it('the company registers for VAT (STANDARD scheme only) with its VAT accounts', async () => {
    const body = { registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', anchorPeriodEnd: '2026-03-31', outputAccountId: acc['2200'], inputAccountId: acc['1150'], reason: 'Registered from 1 January (synthetic)' };
    expect((await as(accountant, 'put', `${base()}/vat-settings`, { ...body, scheme: 'FLAT_RATE' })).body.code).toBe('vat_scheme_not_supported');
    expect((await as(bookkeeper, 'put', `${base()}/vat-settings`, body)).status).toBe(403);
    const ok = await as(accountant, 'put', `${base()}/vat-settings`, body);
    expect(ok.body).toMatchObject({ registered: true, vrn: 'GB123456789', scheme: 'STANDARD', periodMonths: 3 });
    expect((await as(reviewer, 'get', `${base()}/vat/period?date=2026-05-20`)).body).toEqual({ from: '2026-04-01', to: '2026-06-30', periodMonths: 3 });
  });
  it('a journal with the unverified code is refused; after verification by the owner it posts with a visible VAT line', async () => {
    const journal = { journalDate: '2026-02-10', description: 'Synthetic sale', lines: [{ accountId: acc['1110'], debit: '112.50', credit: '0' }, { accountId: acc['4000'], debit: '0', credit: '100.00', taxCodeId: sales }] };
    expect((await as(accountant, 'post', `${base()}/journals`, journal)).body.code).toBe('tax_rate_unverified');
    expect((await as(accountant, 'post', `${base()}/tax-rates/${salesRate}/verify`, { notes: 'Trying to verify my own rule' })).status).toBe(403);   // no permission
    expect((await as(owner, 'post', `${base()}/tax-rates/${salesRate}/verify`, { notes: 'short' })).status).toBe(422);
    const v = await as(owner, 'post', `${base()}/tax-rates/${salesRate}/verify`, { notes: 'Checked against the synthetic test source' });
    expect(v.body).toMatchObject({ verificationStatus: 'VERIFIED', verifiedByUserId: owner.userId });
    const j = await as(accountant, 'post', `${base()}/journals`, journal);
    expect(j.status).toBe(201);
    expect(j.body.lines.map((l: { accountCode: string; debit: string; credit: string; vat: { role: string } | null }) => `${l.accountCode}:${l.debit}/${l.credit}:${l.vat?.role ?? '-'}`))
      .toEqual(['1110:112.50/0.00:-', '4000:0.00/100.00:NET', '2200:0.00/12.50:VAT']);
    const inc = await as(accountant, 'post', `${base()}/journals`, { ...journal, amountsIncludeVat: true, lines: [{ accountId: acc['1110'], debit: '45.00', credit: '0' }, { accountId: acc['4000'], debit: '0', credit: '45.00', taxCodeId: sales }] });
    expect(inc.body.lines.map((l: { credit: string }) => l.credit)).toEqual(['0.00', '40.00', '5.00']);
  });
  it('the workpaper shows the boxes with drill-down and the reconciliation; it is labelled as a workpaper, not a return', async () => {
    const w = (await as(reviewer, 'get', `${base()}/vat/workpaper?from=2026-01-01&to=2026-03-31`)).body;
    const box = (n: number) => w.boxes.find((b: { box: number }) => b.box === n);
    expect(box(1).amount).toBe('17.50');
    expect(box(6).amount).toBe('140.00');
    expect(box(6).lines).toHaveLength(2);
    expect(w.reconciliation).toMatchObject({ difference: '0.00' });
    expect(w.rules[0]).toMatchObject({ code: 'SX', verifiedBy: owner.userId, provision: SOURCE.provision });
    expect(w.notice).toMatch(/not a VAT return/);
    expect((await as(viewer, 'get', `${base()}/vat/workpaper?from=2026-01-01&to=2026-03-31`)).status).toBe(403);
    expect((await as(reviewer, 'get', `${base(otherCompany.id)}/vat/workpaper?from=2026-01-01&to=2026-03-31`)).body.code).toBe('not_vat_registered');
  });
  it('changing a rule makes a new UNVERIFIED version; the old one stays on the lines that used it; audits record source and reason', async () => {
    const sup = await as(accountant, 'post', `${base()}/tax-rates/${salesRate}/supersede`, { rate: '7', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: SOURCE, reason: 'Synthetic rule change for the test' });
    expect(sup.status).toBe(201);
    expect(sup.body.verificationStatus).toBe('UNVERIFIED');
    const code = (await as(reviewer, 'get', `${base()}/tax-codes/${sales}`)).body;
    expect(code.rates.map((r: { rate: string; supersededById: string | null }) => `${r.rate}:${r.supersededById ? 'superseded' : 'current'}`).sort()).toEqual(['12.5000:superseded', '7.0000:current']);
    const audit = (await as(owner, 'get', `/audit-events?entityType=tax_rate&entityId=${salesRate}`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['vat.rate_added', 'vat.rate_verified', 'vat.rate_superseded']));
  });
});
