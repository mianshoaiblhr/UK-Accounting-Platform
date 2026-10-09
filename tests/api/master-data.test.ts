import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, roleId, startStack, type Stack, type TestUser } from '../helpers/stack';

/** Specification §3: companies (profile), contacts, addresses, directors/officers, currencies, countries, tax jurisdictions, accounting periods, financial year-end. */
let s: Stack;
let owner: TestUser, other: TestUser, accountant: TestUser, viewer: TestUser, assigned: TestUser;
let coA: { id: string }, coB: { id: string };
type M = 'get' | 'post' | 'patch' | 'put' | 'delete';
const call = (u: TestUser, m: M, p: string, b?: object, org = owner.organisationId) => s.api()[m](`/api/v1/organisations/${org}${p}`).set(bearer(u.token)).send(b);
const mid = async (u: TestUser) => ((await call(owner, 'get', '/members')).body.items as { id: string; user: { id: string } }[]).find((m) => m.user.id === u.userId)!.id;
const mkCompany = async (name: string, extra: object = {}) => (await call(owner, 'post', '/companies', { name, ...extra })).body as { id: string };
const contact = async (u: TestUser, body: object) => call(u, 'post', '/contacts', { kind: 'PERSON', name: 'Jane Smith', ...body });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'BUSINESS' });
  other = await createUser(s, { type: 'BUSINESS' });
  accountant = await addMember(s, owner, 'accountant');
  viewer = await addMember(s, owner, 'client_viewer');
  assigned = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
  coA = await mkCompany('Master A Ltd');
  coB = await mkCompany('Master B Ltd');
  await call(owner, 'put', `/companies/${coA.id}/access/${await mid(assigned)}`, { roleId: await roleId(s, owner, 'reviewer') });
});
afterAll(() => s.stop());

describe('reference data', () => {
  it('currencies: ISO 4217 with the right minor units; funds and metals are not offered', async () => {
    const items = (await call(owner, 'get', '/reference/currencies')).body.items as Array<{ code: string; minorUnits: number; name: string }>;
    const by = Object.fromEntries(items.map((c) => [c.code, c]));
    expect(by.GBP).toMatchObject({ minorUnits: 2, name: 'Pound Sterling', numericCode: '826' });
    expect(by.JPY.minorUnits).toBe(0);
    expect(by.KWD.minorUnits).toBe(3);
    expect(items.length).toBeGreaterThan(140);
    for (const c of ['XAU', 'XAG', 'XXX', 'XDR', 'CHE']) expect(by[c], c).toBeUndefined();
  });
  it('countries: all 249 ISO 3166-1 entries, alpha-3 and numeric codes included', async () => {
    const items = (await call(owner, 'get', '/reference/countries')).body.items as Array<{ alpha2: string; alpha3: string }>;
    expect(items).toHaveLength(249);
    expect(items.find((c) => c.alpha2 === 'GB')).toMatchObject({ alpha3: 'GBR', name: 'United Kingdom', numericCode: '826' });
    expect(new Set(items.map((c) => c.alpha3)).size).toBe(249);
  });
  it('tax jurisdictions are effective-dated: in force today, none before they existed, filterable by country', async () => {
    const now = (await call(owner, 'get', '/reference/tax-jurisdictions')).body.items as Array<{ code: string; authority: string }>;
    expect(now.map((j) => j.code)).toEqual(expect.arrayContaining(['GB-HMRC', 'IE-REV']));
    expect(now.find((j) => j.code === 'GB-HMRC')!.authority).toBe('HM Revenue & Customs');
    expect((await call(owner, 'get', '/reference/tax-jurisdictions?asOf=1960-01-01')).body.items).toEqual([]);
    expect(((await call(owner, 'get', '/reference/tax-jurisdictions?countryCode=IE')).body.items as unknown[]).length).toBe(1);
    expect((await call(owner, 'get', '/reference/tax-jurisdictions?asOf=nonsense')).status).toBe(422);
  });
  it('is readable by any member, never by outsiders, and never writable through the API', async () => {
    expect((await call(viewer, 'get', '/reference/currencies')).status).toBe(200);
    expect((await s.api().get(`/api/v1/organisations/${owner.organisationId}/reference/countries`).set(bearer(other.token))).status).toBe(404);
    expect((await call(owner, 'post', '/reference/currencies', { code: 'ZZZ' })).status).toBe(404);
  });
});

describe('company profile and financial year-end', () => {
  it('defaults to GBP / GB and has no year-end until set', async () => {
    const c = (await call(owner, 'get', `/companies/${coA.id}`)).body;
    expect(c).toMatchObject({ baseCurrency: 'GBP', countryCode: 'GB', yearEnd: null, incorporationDate: null, taxJurisdictionCode: null });
  });
  it('can be created with a full profile', async () => {
    const r = await call(owner, 'post', '/companies', { name: 'Profiled Ltd', incorporationDate: '2024-06-15', yearEnd: { month: 3, day: 31 }, baseCurrency: 'EUR', countryCode: 'IE', taxJurisdictionCode: 'IE-REV' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ incorporationDate: '2024-06-15', yearEnd: { month: 3, day: 31 }, baseCurrency: 'EUR', countryCode: 'IE', taxJurisdictionCode: 'IE-REV' });
  });
  it('update changes only what is sent, validates references, and is audited with before/after', async () => {
    const r = await call(owner, 'patch', `/companies/${coA.id}`, { yearEnd: { month: 2, day: 29 }, incorporationDate: '2023-02-10', taxJurisdictionCode: 'GB-HMRC', legalForm: 'LLP' });
    expect(r.body).toMatchObject({ name: 'Master A Ltd', yearEnd: { month: 2, day: 29 }, incorporationDate: '2023-02-10', taxJurisdictionCode: 'GB-HMRC', legalForm: 'LLP' });
    const e = ((await call(owner, 'get', `/audit-events?action=company.updated&entityId=${coA.id}`)).body.items as Array<Record<string, any>>)[0]!;
    expect(e.before).toMatchObject({ yearEndMonth: null, legalForm: 'LTD' });
    expect(e.after).toMatchObject({ yearEndMonth: 2, yearEndDay: 29, legalForm: 'LLP', incorporationDate: '2023-02-10' });
    expect(e.after.name).toBeUndefined();
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { yearEnd: null })).body.yearEnd).toBeNull();
    await call(owner, 'patch', `/companies/${coA.id}`, { yearEnd: { month: 3, day: 31 } });
  });
  it('rejects impossible or unknown values with clear errors', async () => {
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { yearEnd: { month: 2, day: 30 } })).status).toBe(422);
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { yearEnd: { month: 13, day: 1 } })).status).toBe(422);
    expect((await call(owner, 'patch', `/companies/${coA.id}`, {})).status).toBe(422);
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { incorporationDate: '2025-02-30' })).status).toBe(422);
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { baseCurrency: 'XAU' })).body.code).toBe('unknown_currency');
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { countryCode: 'ZZ' })).body.code).toBe('unknown_country');
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { taxJurisdictionCode: 'NOPE' })).body.code).toBe('unknown_tax_jurisdiction');
    expect((await call(owner, 'patch', `/companies/${coA.id}`, { baseCurrency: 'gbp' })).status).toBe(422);
  });
  it('needs company:update on THAT company', async () => {
    expect((await call(viewer, 'patch', `/companies/${coA.id}`, { baseCurrency: 'USD' })).status).toBe(403);
    expect((await call(assigned, 'patch', `/companies/${coA.id}`, { baseCurrency: 'USD' })).status).toBe(403);   // reviewer on A
    expect((await call(assigned, 'patch', `/companies/${coB.id}`, { baseCurrency: 'USD' })).status).toBe(403);   // holds company:update nowhere: refused before B is even looked up (no existence oracle)
    expect((await call(accountant, 'patch', `/companies/${coA.id}`, { baseCurrency: 'GBP' })).status).toBe(200);
  });
  it('proposes the next accounting period from the year-end, the incorporation date and the latest period', async () => {
    const c = await mkCompany('Periods Ltd');
    expect((await call(owner, 'get', `/companies/${c.id}/periods/next`)).body.code).toBe('year_end_not_set');
    await call(owner, 'patch', `/companies/${c.id}`, { yearEnd: { month: 3, day: 31 } });
    expect((await call(owner, 'get', `/companies/${c.id}/periods/next`)).body.code).toBe('no_period_basis');
    await call(owner, 'patch', `/companies/${c.id}`, { incorporationDate: '2024-09-10' });
    expect((await call(owner, 'get', `/companies/${c.id}/periods/next`)).body).toEqual({ startDate: '2024-09-10', endDate: '2025-03-31' });
    await call(owner, 'post', `/companies/${c.id}/periods`, { startDate: '2024-09-10', endDate: '2025-03-31' });
    expect((await call(owner, 'get', `/companies/${c.id}/periods/next`)).body).toEqual({ startDate: '2025-04-01', endDate: '2026-03-31' });
    // the proposal is directly usable: it never overlaps what exists
    const next = (await call(owner, 'get', `/companies/${c.id}/periods/next`)).body;
    expect((await call(owner, 'post', `/companies/${c.id}/periods`, next)).status).toBe(201);
    expect((await call(owner, 'get', `/companies/${c.id}/periods/next`)).body.startDate).toBe('2026-04-01');
    expect((await call(assigned, 'get', `/companies/${c.id}/periods/next`)).status).toBe(404);
  });
});

describe('contacts', () => {
  it('create / read / update with normalisation and validation', async () => {
    const r = await contact(accountant, { name: 'Acme Supplies Ltd', kind: 'ORGANISATION', email: 'Billing@ACME.example', labels: ['supplier', 'uk'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'ORGANISATION', email: 'billing@acme.example', labels: ['supplier', 'uk'], status: 'ACTIVE', companyId: null });
    const up = await call(accountant, 'patch', `/contacts/${r.body.id}`, { phone: '020 7946 0000', notes: 'pays in 30 days' });
    expect(up.body).toMatchObject({ phone: '020 7946 0000', email: 'billing@acme.example' });
    expect((await call(accountant, 'patch', `/contacts/${r.body.id}`, { email: null })).body.email).toBeNull();
    expect((await contact(accountant, { email: 'not-an-email' })).status).toBe(422);
    expect((await contact(accountant, { name: '   ' })).status).toBe(422);
    expect((await contact(accountant, { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) })).status).toBe(422);
    expect((await call(accountant, 'patch', `/contacts/${r.body.id}`, {})).status).toBe(422);
    expect((await contact(accountant, { unknownField: 1 })).status).toBe(422);
  });
  it('access follows the owner: organisation-level contacts need the organisation role; company contacts the company grant', async () => {
    const org = (await contact(owner, { name: 'Org Level Person' })).body;
    const forA = (await contact(owner, { name: 'Only For A', companyId: coA.id })).body;
    const forB = (await contact(owner, { name: 'Only For B', companyId: coB.id })).body;
    // client_viewer role has no contact permissions at all
    expect((await call(viewer, 'get', '/contacts')).status).toBe(403);
    // a reviewer grant on A: reads A's contacts, not B's; org-level ones need the organisation role (client_viewer lacks contact:read)
    const list = (await call(assigned, 'get', '/contacts')).body.items as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([forA.id]);
    expect((await call(assigned, 'get', `/contacts/${forA.id}`)).status).toBe(200);
    expect((await call(assigned, 'get', `/contacts/${forB.id}`)).status).toBe(404);
    expect((await call(assigned, 'get', `/contacts/${org.id}`)).status).toBe(403);
    // read-only on A: cannot create or edit
    expect((await call(assigned, 'post', '/contacts', { kind: 'PERSON', name: 'x', companyId: coA.id })).status).toBe(403);
    expect((await call(assigned, 'patch', `/contacts/${forA.id}`, { phone: '1' })).status).toBe(403);
    // accountant (organisation-wide) manages everything
    expect((await call(accountant, 'patch', `/contacts/${forB.id}`, { phone: '2' })).status).toBe(200);
  });
  it('archive / restore keep the record and are audited with the reason; default list shows active contacts only', async () => {
    const c = (await contact(owner, { name: 'To Archive Person' })).body;
    expect((await call(owner, 'post', `/contacts/${c.id}/archive?reason=duplicate%20entry`)).body.status).toBe('ARCHIVED');
    expect(((await call(owner, 'get', '/contacts?q=to%20archive')).body.items as unknown[])).toHaveLength(0);
    expect(((await call(owner, 'get', '/contacts?q=to%20archive&status=ARCHIVED')).body.items as unknown[])).toHaveLength(1);
    expect((await call(owner, 'post', `/contacts/${c.id}/restore`)).body.status).toBe('ACTIVE');
    const ev = (await call(owner, 'get', `/audit-events?entityId=${c.id}`)).body.items as Array<Record<string, any>>;
    expect(ev.find((e) => e.action === 'contact.archived')).toMatchObject({ reason: 'duplicate entry', before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } });
  });
  it('search and filters', async () => {
    await contact(owner, { name: 'Zed Searchable', kind: 'ORGANISATION' });
    expect(((await call(owner, 'get', '/contacts?q=searchable')).body.items as Array<{ name: string }>).map((c) => c.name)).toEqual(['Zed Searchable']);
    expect(((await call(owner, 'get', '/contacts?q=searchable&kind=PERSON')).body.items as unknown[])).toHaveLength(0);
  });
  it('tenant isolation: other organisations cannot read, list or attach contacts to foreign companies', async () => {
    const c = (await contact(owner, { name: 'Isolated Person' })).body;
    expect((await call(other, 'get', `/contacts/${c.id}`, undefined, owner.organisationId)).status).toBe(404);
    expect((await call(other, 'get', `/contacts/${c.id}`, undefined, other.organisationId)).status).toBe(404);
    expect(((await call(other, 'get', '/contacts', undefined, other.organisationId)).body.items as unknown[])).toHaveLength(0);
    expect((await call(other, 'post', '/contacts', { kind: 'PERSON', name: 'x', companyId: coA.id }, other.organisationId)).status).toBe(404);
    expect(adminSql(`SELECT count(*) FROM contact WHERE organisation_id='${other.organisationId}'`)).toBe('0');
  });
});

describe('addresses', () => {
  it('company addresses: one primary per kind (setting a new one demotes the old), UK postcodes validated, country must exist', async () => {
    const base = { kind: 'REGISTERED_OFFICE', line1: '1 High Street', city: 'London', postcode: 'sw1a 1aa', countryCode: 'GB' };
    const a1 = (await call(owner, 'post', `/companies/${coA.id}/addresses`, { ...base, primary: true })).body;
    expect(a1).toMatchObject({ postcode: 'SW1A 1AA', primary: true, companyId: coA.id, contactId: null });
    const a2 = (await call(owner, 'post', `/companies/${coA.id}/addresses`, { ...base, line1: '2 Low Road', primary: true })).body;
    const list = (await call(owner, 'get', `/companies/${coA.id}/addresses`)).body.items as Array<{ id: string; primary: boolean }>;
    expect(list.find((a) => a.id === a1.id)!.primary).toBe(false);
    expect(list.find((a) => a.id === a2.id)!.primary).toBe(true);
    expect((await call(owner, 'post', `/companies/${coA.id}/addresses`, { ...base, postcode: 'NOT A POSTCODE' })).status).toBe(422);
    expect((await call(owner, 'post', `/companies/${coA.id}/addresses`, { ...base, countryCode: 'ZZ', postcode: undefined })).body.code).toBe('unknown_country');
    expect((await call(owner, 'post', `/companies/${coA.id}/addresses`, { ...base, countryCode: 'FR', postcode: '75001' })).status).toBe(201); // non-UK postcodes are not UK-validated
    const back = (await call(owner, 'patch', `/companies/${coA.id}/addresses/${a1.id}`, { primary: true })).body;
    expect(back.primary).toBe(true);
    expect(((await call(owner, 'get', `/companies/${coA.id}/addresses`)).body.items as Array<{ id: string; primary: boolean; kind: string }>).filter((a) => a.primary && a.kind === 'REGISTERED_OFFICE')).toHaveLength(1);
  });
  it('contact addresses are separate from company addresses and cannot be reached through the wrong owner', async () => {
    const c = (await contact(owner, { name: 'Addr Person' })).body;
    const a = (await call(owner, 'post', `/contacts/${c.id}/addresses`, { kind: 'RESIDENTIAL', line1: '5 Elm Close', city: 'Leeds', postcode: 'LS1 4AB', countryCode: 'GB', primary: true })).body;
    expect(a).toMatchObject({ contactId: c.id, companyId: null });
    expect((await call(owner, 'patch', `/companies/${coA.id}/addresses/${a.id}`, { city: 'X' })).status).toBe(404);
    const upd = await call(owner, 'patch', `/contacts/${c.id}/addresses/${a.id}`, { city: 'York', line2: null });
    expect(upd.body.city).toBe('York');
    const del = await call(owner, 'delete', `/contacts/${c.id}/addresses/${a.id}?reason=moved%20abroad`);
    expect(del.status).toBe(204);
    expect(((await call(owner, 'get', `/contacts/${c.id}/addresses`)).body.items as unknown[])).toHaveLength(0);
    const ev = ((await call(owner, 'get', `/audit-events?action=address.deleted&entityId=${a.id}`)).body.items as Array<Record<string, any>>)[0]!;
    expect(ev).toMatchObject({ reason: 'moved abroad', before: { city: 'York' } });
  });
  it('writes need the owner\'s manage permission; reads the owner\'s read permission', async () => {
    const body = { kind: 'TRADING', line1: '9 Market Sq', city: 'Bath', postcode: 'BA1 1AA', countryCode: 'GB' };
    expect((await call(assigned, 'post', `/companies/${coA.id}/addresses`, body)).status).toBe(403);   // reviewer on A
    expect((await call(assigned, 'get', `/companies/${coA.id}/addresses`)).status).toBe(200);
    expect((await call(assigned, 'get', `/companies/${coB.id}/addresses`)).status).toBe(404);
    expect((await call(viewer, 'post', `/companies/${coA.id}/addresses`, body)).status).toBe(403);
    expect((await call(other, 'get', `/companies/${coA.id}/addresses`)).status).toBe(404);
  });
});

describe('directors / officers', () => {
  let co: { id: string }, person: { id: string }, companyPerson: { id: string }, otherCompanyPerson: { id: string };
  beforeAll(async () => {
    co = await mkCompany('Officers Ltd');
    person = (await contact(owner, { name: 'Dora Director' })).body;
    companyPerson = (await contact(owner, { name: 'Company Local Person', companyId: co.id })).body;
    otherCompanyPerson = (await contact(owner, { name: 'Belongs Elsewhere', companyId: coB.id })).body;
  });
  it('appoints a director, keeps history on resignation, and filters active officers', async () => {
    const d = await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: person.id, role: 'DIRECTOR', appointedOn: '2023-01-05' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ role: 'DIRECTOR', appointedOn: '2023-01-05', resignedOn: null, contact: { id: person.id, name: 'Dora Director' } });
    await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: companyPerson.id, role: 'SECRETARY', appointedOn: '2023-01-05' });
    expect((await call(owner, 'get', `/companies/${co.id}/officers`)).body.items).toHaveLength(2);
    const res = await call(owner, 'patch', `/companies/${co.id}/officers/${d.body.id}`, { resignedOn: '2024-04-30' });
    expect(res.body.resignedOn).toBe('2024-04-30');
    const all = (await call(owner, 'get', `/companies/${co.id}/officers`)).body.items as Array<{ id: string; resignedOn: string | null }>;
    expect(all).toHaveLength(2);                                           // history kept
    expect(((await call(owner, 'get', `/companies/${co.id}/officers?active=true`)).body.items as Array<{ id: string }>).map((o) => o.id)).not.toContain(d.body.id);
    expect((await call(owner, 'patch', `/companies/${co.id}/officers/${d.body.id}`, { resignedOn: '2022-01-01' })).body.code).toBe('invalid_dates');
    const ev = (await call(owner, 'get', `/audit-events?entityType=company_officer&limit=20`)).body.items as Array<Record<string, any>>;
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(['officer.appointed', 'officer.resigned']));
    expect(ev.find((e) => e.action === 'officer.resigned')).toMatchObject({ before: { resignedOn: null }, after: { resignedOn: '2024-04-30' }, companyId: co.id });
  });
  it('the same person can return to the same office on a later date, but not be appointed twice from the same date', async () => {
    expect((await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: person.id, role: 'DIRECTOR', appointedOn: '2025-02-01' })).status).toBe(201);
    const dup = await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: person.id, role: 'DIRECTOR', appointedOn: '2025-02-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('officer_exists');
  });
  it('validates dates and the contact (must be organisation-level or belong to this company)', async () => {
    expect((await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: person.id, role: 'DIRECTOR', appointedOn: '2023-01-05', resignedOn: '2022-01-01' })).status).toBe(422);
    const wrong = await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: otherCompanyPerson.id, role: 'DIRECTOR', appointedOn: '2023-01-05' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('contact_company_mismatch');
    expect((await call(owner, 'post', `/companies/${co.id}/officers`, { contactId: '11111111-1111-4111-8111-111111111111', role: 'DIRECTOR', appointedOn: '2023-01-05' })).body.code).toBe('unknown_contact');
  });
  it('officer changes need company:update; reading needs company:read; other companies\' officers are unreachable', async () => {
    expect((await call(assigned, 'get', `/companies/${coA.id}/officers`)).status).toBe(200);
    expect((await call(assigned, 'post', `/companies/${coA.id}/officers`, { contactId: person.id, role: 'DIRECTOR', appointedOn: '2023-01-05' })).status).toBe(403);
    expect((await call(assigned, 'get', `/companies/${co.id}/officers`)).status).toBe(404);
    const o = ((await call(owner, 'get', `/companies/${co.id}/officers`)).body.items as Array<{ id: string }>)[0]!;
    expect((await call(owner, 'patch', `/companies/${coA.id}/officers/${o.id}`, { resignedOn: '2025-01-01' })).status).toBe(404);   // officer of another company
    expect((await call(other, 'get', `/companies/${co.id}/officers`)).status).toBe(404);
  });
});
