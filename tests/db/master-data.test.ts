import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** Database guarantees behind the master data (they hold even if application code is wrong). */
let db: Database;
const A = uuidv7(), B = uuidv7();
let userId: string, coA: string, coA2: string, coB: string, contactA: string, contactCoA: string, contactB: string;
const e = (sql: string) => adminSql(sql);
const first = (sql: string) => e(sql).split('\n')[0]!;

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  userId = first(`INSERT INTO "user"(email, display_name) VALUES ('md-${A}@t.test','M') RETURNING id`);
  e(`INSERT INTO organisation(id,type,name) VALUES ('${A}','BUSINESS','MD A'),('${B}','BUSINESS','MD B')`);
  coA = first(`INSERT INTO company(organisation_id,name) VALUES ('${A}','Co A') RETURNING id`);
  coA2 = first(`INSERT INTO company(organisation_id,name) VALUES ('${A}','Co A2') RETURNING id`);
  coB = first(`INSERT INTO company(organisation_id,name) VALUES ('${B}','Co B') RETURNING id`);
  contactA = first(`INSERT INTO contact(organisation_id,kind,name,created_by_user_id) VALUES ('${A}','PERSON','Org-level','${userId}') RETURNING id`);
  contactCoA = first(`INSERT INTO contact(organisation_id,company_id,kind,name,created_by_user_id) VALUES ('${A}','${coA}','PERSON','Co-A person','${userId}') RETURNING id`);
  contactB = first(`INSERT INTO contact(organisation_id,kind,name,created_by_user_id) VALUES ('${B}','PERSON','B person','${userId}') RETURNING id`);
});
afterAll(() => db.close());

describe('reference data integrity', () => {
  it('tax jurisdictions are effective-dated: no overlapping definitions of one code, but a later redefinition is fine', () => {
    e(`INSERT INTO tax_jurisdiction(code,country_code,name,authority,valid_from,valid_to) VALUES ('TEST-J','GB','v1','Auth A','2000-01-01','2010-01-01')`);
    expect(() => e(`INSERT INTO tax_jurisdiction(code,country_code,name,authority,valid_from) VALUES ('TEST-J','GB','overlap','Auth B','2005-01-01')`)).toThrow(/tax_jurisdiction_no_overlap/);
    e(`INSERT INTO tax_jurisdiction(code,country_code,name,authority,valid_from) VALUES ('TEST-J','GB','v2','Auth B','2010-01-01')`); // adjacent: [) ranges do not overlap
    expect(() => e(`INSERT INTO tax_jurisdiction(code,country_code,name,authority,valid_from,valid_to) VALUES ('TEST-K','GB','bad','x','2020-01-01','2020-01-01')`)).toThrow(/tax_jurisdiction_dates_ck/);
    expect(() => e(`INSERT INTO tax_jurisdiction(code,country_code,name,authority,valid_from) VALUES ('TEST-L','ZZ','no country','x','2020-01-01')`)).toThrow(/foreign key/);
  });
  it('currency and country codes are well-formed and unique', () => {
    expect(() => e(`INSERT INTO currency(code,numeric_code,name,minor_units) VALUES ('gbp','999','lower',2)`)).toThrow(/currency_code_ck/);
    expect(() => e(`INSERT INTO currency(code,numeric_code,name,minor_units) VALUES ('ZZZ','826','dup numeric',2)`)).toThrow(/unique|duplicate/i);
    expect(() => e(`INSERT INTO currency(code,numeric_code,name,minor_units) VALUES ('ZZY','998','bad units',7)`)).toThrow(/currency_minor_units_ck/);
    expect(() => e(`INSERT INTO country(alpha2,alpha3,numeric_code,name) VALUES ('XQ','GBR','998','dup alpha3')`)).toThrow(/unique|duplicate/i);
  });
});

describe('company profile constraints', () => {
  it('year-end must be a real month/day pair, set together; currency and country must exist', () => {
    expect(() => e(`UPDATE company SET year_end_month=2, year_end_day=30 WHERE id='${coA}'`)).toThrow(/company_year_end_ck/);
    expect(() => e(`UPDATE company SET year_end_month=4, year_end_day=31 WHERE id='${coA}'`)).toThrow(/company_year_end_ck/);
    expect(() => e(`UPDATE company SET year_end_month=3 WHERE id='${coA}'`)).toThrow(/company_year_end_ck/);
    e(`UPDATE company SET year_end_month=2, year_end_day=29 WHERE id='${coA}'`);
    expect(() => e(`UPDATE company SET base_currency='QQQ' WHERE id='${coA}'`)).toThrow(/foreign key/);
    expect(() => e(`UPDATE company SET country_code='ZZ' WHERE id='${coA}'`)).toThrow(/foreign key/);
    expect(() => e(`UPDATE company SET tax_jurisdiction_code='NOPE' WHERE id='${coA}'`)).toThrow(/unknown tax jurisdiction/);
    e(`UPDATE company SET tax_jurisdiction_code='GB-HMRC' WHERE id='${coA}'`);
  });
});

describe('contacts, addresses, officers: structure', () => {
  it('a contact cannot be attached to a company of another organisation', () => {
    expect(() => e(`INSERT INTO contact(organisation_id,company_id,kind,name,created_by_user_id) VALUES ('${A}','${coB}','PERSON','x','${userId}')`)).toThrow(/foreign key/);
  });
  it('an address belongs to exactly one of company or contact, and only within its own organisation', () => {
    const ins = (cols: string, vals: string) => e(`INSERT INTO address(organisation_id,${cols},kind,line1,city,country_code) VALUES ('${A}',${vals},'OTHER','1 St','Town','GB')`);
    expect(() => e(`INSERT INTO address(organisation_id,kind,line1,city,country_code) VALUES ('${A}','OTHER','1 St','Town','GB')`)).toThrow(/address_one_owner_ck/);
    expect(() => ins('company_id,contact_id', `'${coA}','${contactA}'`)).toThrow(/address_one_owner_ck/);
    expect(() => ins('company_id', `'${coB}'`)).toThrow(/foreign key/);
    expect(() => ins('contact_id', `'${contactB}'`)).toThrow(/foreign key/);
    ins('contact_id', `'${contactA}'`);
  });
  it('at most one primary address per owner and kind; UK postcodes are validated in the database too', () => {
    const p = (extra: string) => e(`INSERT INTO address(organisation_id,company_id,kind,line1,city,country_code,is_primary${extra ? ',postcode' : ''}) VALUES ('${A}','${coA2}','REGISTERED_OFFICE','1 St','Town','GB',true${extra ? `,'${extra}'` : ''})`);
    p('');
    expect(() => p('')).toThrow(/address_company_primary_uq/);
    expect(() => e(`INSERT INTO address(organisation_id,company_id,kind,line1,city,country_code,postcode) VALUES ('${A}','${coA2}','TRADING','1 St','Town','GB','12345')`)).toThrow(/address_gb_postcode_ck/);
    e(`INSERT INTO address(organisation_id,company_id,kind,line1,city,country_code,postcode) VALUES ('${A}','${coA2}','TRADING','1 St','Paris','FR','75001')`);
  });
  it('an officer cannot be a contact of a different company, and dates must be ordered', () => {
    expect(() => e(`INSERT INTO company_officer(organisation_id,company_id,contact_id,role,appointed_on) VALUES ('${A}','${coA2}','${contactCoA}','DIRECTOR','2024-01-01')`)).toThrow(/same company/);
    e(`INSERT INTO company_officer(organisation_id,company_id,contact_id,role,appointed_on) VALUES ('${A}','${coA}','${contactCoA}','DIRECTOR','2024-01-01')`);      // own company's contact
    e(`INSERT INTO company_officer(organisation_id,company_id,contact_id,role,appointed_on) VALUES ('${A}','${coA2}','${contactA}','DIRECTOR','2024-01-01')`);       // organisation-level contact
    expect(() => e(`INSERT INTO company_officer(organisation_id,company_id,contact_id,role,appointed_on,resigned_on) VALUES ('${A}','${coA}','${contactA}','SECRETARY','2024-01-01','2023-01-01')`)).toThrow(/officer_dates_ck/);
    expect(() => e(`INSERT INTO company_officer(organisation_id,company_id,contact_id,role,appointed_on) VALUES ('${A}','${coA}','${contactB}','DIRECTOR','2024-01-01')`)).toThrow(/not found|foreign key/);
  });
  it('a contact with officer history cannot be deleted (history is kept)', () => {
    expect(() => e(`DELETE FROM contact WHERE id='${contactCoA}'`)).toThrow(/foreign key|violates/);
  });
  it('email and label limits are enforced', () => {
    expect(() => e(`INSERT INTO contact(organisation_id,kind,name,email,created_by_user_id) VALUES ('${A}','PERSON','x','nope','${userId}')`)).toThrow(/contact_email_ck/);
    expect(() => e(`INSERT INTO contact(organisation_id,kind,name,labels,created_by_user_id) VALUES ('${A}','PERSON','x',ARRAY['1','2','3','4','5','6','7','8','9','10','11'],'${userId}')`)).toThrow(/contact_labels_ck/);
  });
});

describe('row-level security on the tenant master-data tables', () => {
  it.each(['contact', 'address', 'company_officer'])('%s: no context => nothing; tenant A never sees B', async (t) => {
    expect(Number((await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM ${t}`))[0]!.n)).toBe(0);
    const foreign = await db.tenant({ organisationId: A }, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM ${t} WHERE organisation_id <> '${A}'`));
    expect(Number(foreign[0]!.n)).toBe(0);
  });
  it('tenant A cannot read or change tenant B\'s contacts', async () => {
    expect(await db.tenant({ organisationId: A }, (tx) => tx.contact.findUnique({ where: { id: contactB } }))).toBeNull();
    expect(await db.tenant({ organisationId: A }, (tx) => tx.contact.updateMany({ where: { id: contactB }, data: { name: 'hacked' } }))).toEqual({ count: 0 });
    await expect(db.tenant({ organisationId: A }, (tx) => tx.contact.create({ data: { organisationId: B, kind: 'PERSON', name: 'x', createdByUserId: userId } }))).rejects.toThrow();
  });
});
