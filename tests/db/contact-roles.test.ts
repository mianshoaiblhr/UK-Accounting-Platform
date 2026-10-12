import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** V1-M4a: the database enforces the contact-role rules even if application code is wrong or bypassed. Statements run as the RUNTIME role in a tenant context. */
let db: Database;
let org: string, org2: string, user: string, user2: string, co: string, coOther: string, shared: string, linked: string;
const sql = adminSql;
const tx = (statements: string[], o: { organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: user }, async (t) => { for (const s of statements) await t.$executeRawUnsafe(s); });
const role = (id: string, o: { company?: string; contact?: string; role?: string; code?: string | null; org?: string } = {}) =>
  `INSERT INTO contact_role(id, organisation_id, company_id, contact_id, role, account_code, created_by_user_id) VALUES ('${id}','${o.org ?? org}','${o.company ?? co}','${o.contact ?? shared}','${o.role ?? 'CUSTOMER'}',${o.code ? `'${o.code}'` : 'NULL'},'${user}')`;
const supplierProfile = (roleId: string, extra = '') => `INSERT INTO supplier_profile(role_id, organisation_id, company_id${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ('${roleId}','${org}','${co}'${extra ? ', ' + extra.split('|')[1] : ''})`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('cr1-${org}@t.test','C') RETURNING id`).split('\n')[0]!;
  user2 = sql(`INSERT INTO "user"(email, display_name) VALUES ('cr2-${org}@t.test','D') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Roles DB A'),('${org2}','BUSINESS','Roles DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  coOther = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','B') RETURNING id`).split('\n')[0]!;
  shared = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','Shared Ltd','${user}') RETURNING id`).split('\n')[0]!;
  linked = sql(`INSERT INTO contact(organisation_id, company_id, kind, name, created_by_user_id) VALUES ('${org}','${coOther}','ORGANISATION','Linked to B','${user}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('roles', () => {
  it('one contact may be a customer and a supplier of the same company, and a customer of another; never the same role twice', async () => {
    await tx([role(uuidv7()), role(uuidv7(), { role: 'SUPPLIER' }), role(uuidv7(), { company: coOther })]);
    await expect(tx([role(uuidv7())])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([role(uuidv7(), { role: 'EMPLOYEE' })])).rejects.toThrow(/role_ck|violates check/);
  });
  it('a contact that belongs to one company cannot take a role in another', async () => {
    await expect(tx([role(uuidv7(), { contact: linked })])).rejects.toThrow(/belongs to another company/);
    await tx([role(uuidv7(), { contact: linked, company: coOther })]);
  });
  it('account codes are unique per company and role, ignoring case', async () => {
    const c2 = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Second','${user}') RETURNING id`).split('\n')[0]!;
    const c3 = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Third','${user}') RETURNING id`).split('\n')[0]!;
    await tx([role(uuidv7(), { contact: c2, code: 'CUST-001' })]);
    await expect(tx([role(uuidv7(), { contact: c3, code: 'cust-001' })])).rejects.toThrow(/unique|duplicate/i);
    await tx([role(uuidv7(), { contact: c3, code: 'CUST-001', role: 'SUPPLIER' })]);            // another role may reuse it
    await expect(tx([role(uuidv7(), { contact: c3, code: 'bad code!' })])).rejects.toThrow(/account_code_ck|violates check/);
  });
  it('a role\'s company, contact and kind never change; ending needs a reason; nothing is deleted', async () => {
    const id = uuidv7(); const c4 = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Fourth','${user}') RETURNING id`).split('\n')[0]!;
    await tx([role(id, { contact: c4 })]);
    for (const set of [`company_id='${coOther}'`, `contact_id='${shared}'`, `role='SUPPLIER'`]) await expect(tx([`UPDATE contact_role SET ${set} WHERE id='${id}'`])).rejects.toThrow(/never change/);
    await expect(tx([`UPDATE contact_role SET status='ENDED', ended_at=now(), ended_by_user_id='${user}' WHERE id='${id}'`])).rejects.toThrow(/status_ck|violates check/);
    await tx([`UPDATE contact_role SET status='ENDED', ended_at=now(), ended_by_user_id='${user}', ended_reason='No longer trading' WHERE id='${id}'`]);
    await expect(tx([`DELETE FROM contact_role WHERE id='${id}'`])).rejects.toThrow(/permission denied/);
    expect(() => sql(`DELETE FROM contact_role WHERE id='${id}'`)).toThrow(/append-only/);
  });
});

describe('profiles', () => {
  it('a profile belongs to a role of the right kind and of its own company', async () => {
    const cust = uuidv7(), supp = uuidv7(); const c5 = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','PERSON','Fifth','${user}') RETURNING id`).split('\n')[0]!;
    await tx([role(cust, { contact: c5 }), role(supp, { contact: c5, role: 'SUPPLIER' })]);
    await expect(tx([supplierProfile(cust)])).rejects.toThrow(/foreign key|violates/i);                             // a supplier profile on a customer role
    await expect(tx([`INSERT INTO customer_profile(role_id, organisation_id, company_id) VALUES ('${supp}','${org}','${co}')`])).rejects.toThrow(/foreign key|violates/i);
    await expect(tx([`INSERT INTO customer_profile(role_id, organisation_id, company_id) VALUES ('${cust}','${org}','${coOther}')`])).rejects.toThrow(/role's company/);
    await tx([`INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days, credit_limit) VALUES ('${cust}','${org}','${co}', 30, 1000)`]);
    await expect(tx([`UPDATE customer_profile SET payment_terms_days = 400 WHERE role_id='${cust}'`])).rejects.toThrow(/terms_ck|violates check/);
    await expect(tx([`UPDATE customer_profile SET credit_limit = -1 WHERE role_id='${cust}'`])).rejects.toThrow(/limit_ck|violates check/);
  });
  it('supplier bank details: a change is always UNVERIFIED, verification is by another person, never in the same step, never stored as plain digits', async () => {
    const r = uuidv7(); const c6 = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','Sixth','${user}') RETURNING id`).split('\n')[0]!;
    await tx([role(r, { contact: c6, role: 'SUPPLIER' }), supplierProfile(r)]);
    const set = (enc: string, status: string, extra = '') => `UPDATE supplier_profile SET bank_details_enc='${enc}', bank_details_masked='S*** - x', bank_details_status='${status}', bank_details_changed_by_user_id='${user}', bank_details_changed_at=now()${extra} WHERE role_id='${r}'`;
    await expect(tx([set('v1:a:b:c', 'VERIFIED', `, bank_details_verified_by_user_id='${user2}', bank_details_verified_at=now()`)])).rejects.toThrow(/start UNVERIFIED|one step/);
    await expect(tx([set('12345678', 'UNVERIFIED')])).rejects.toThrow(/enc_ck|violates check/);
    await tx([set('v1:a:b:c', 'UNVERIFIED')]);
    await expect(tx([`UPDATE supplier_profile SET bank_details_status='VERIFIED', bank_details_verified_by_user_id='${user}', bank_details_verified_at=now() WHERE role_id='${r}'`])).rejects.toThrow(/bank_ck|violates check/);   // same person
    await tx([`UPDATE supplier_profile SET bank_details_status='VERIFIED', bank_details_verified_by_user_id='${user2}', bank_details_verified_at=now() WHERE role_id='${r}'`]);
    await expect(tx([`UPDATE supplier_profile SET bank_details_enc='v1:x:y:z' WHERE role_id='${r}'`])).rejects.toThrow(/start UNVERIFIED/);   // changing verified details without resetting
    await expect(tx([`DELETE FROM supplier_profile WHERE role_id='${r}'`])).rejects.toThrow(/permission denied/);
  });
  it('tenant isolation: another organisation neither sees nor creates roles here', async () => {
    expect(await db.tenant({ organisationId: org2, userId: user }, (t) => t.contactRole.count())).toBe(0);
    await expect(tx([role(uuidv7(), { contact: uuidv7() })], { organisationId: org2 })).rejects.toThrow();
  });
  it('VAT numbers on contacts are format-checked by the database', async () => {
    await tx([`UPDATE contact SET vat_number='GB123456789' WHERE id='${shared}'`]);
    for (const bad of ['GB12', 'GB12345678', 'DE1234567']) await expect(tx([`UPDATE contact SET vat_number='${bad}' WHERE id='${shared}'`])).rejects.toThrow(/vat_number_ck|violates check/);
    await tx([`UPDATE contact SET vat_number='DE123456789' WHERE id='${shared}'`]);
  });
});
