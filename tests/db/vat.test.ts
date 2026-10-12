import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V1-M4b: the database defends the VAT rules even if application code is wrong or bypassed. Runtime role, tenant context; synthetic rates only. */
let db: Database;
let org: string, org2: string, author: string, reviewer: string, co: string, period: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { flag?: boolean; organisationId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: author }, async (t) => {
    if (o.flag) await t.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
    for (const s of statements) await t.$executeRawUnsafe(s);
  });
const code = (id: string, c: string, treatment = 'STANDARD', direction = 'SALES', rc = false) =>
  `INSERT INTO tax_code(id, organisation_id, code, name, treatment, direction, reverse_charge, created_by_user_id) VALUES ('${id}','${org}','${c}','Synthetic ${c}','${treatment}','${direction}',${rc},'${author}')`;
const rate = (id: string, codeId: string, o: { rate?: string; from?: string; to?: string | null; status?: string } = {}) =>
  `INSERT INTO tax_rate(id, organisation_id, tax_code_id, rate, effective_from, effective_to, net_boxes, vat_boxes, source_url, source_provision, source_retrieved_on, entered_by_user_id, verification_status)
   VALUES ('${id}','${org}','${codeId}',${o.rate ?? '12.5'},'${o.from ?? '2026-01-01'}',${o.to ? `'${o.to}'` : 'NULL'},ARRAY[6]::smallint[],ARRAY[1]::smallint[],'https://example.invalid/rule','Synthetic Act s.1','2026-01-01','${author}','${o.status ?? 'UNVERIFIED'}')`;
const verify = (id: string, by = reviewer) => `UPDATE tax_rate SET verification_status='VERIFIED', verified_by_user_id='${by}', verified_at=now(), verification_notes='Checked against the synthetic source' WHERE id='${id}'`;
const hdr = (id: string, total: string, o: { reverses?: string; date?: string } = {}) =>
  `INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
   VALUES ('${id}','${org}','${co}','${period}',${Math.floor(1_000_000 + Math.random() * 8_000_000)},'${o.date ?? '2026-02-10'}','${o.reverses ? 'REVERSAL' : 'MANUAL'}',${o.reverses ? `'${o.reverses}'` : 'NULL'},'vat db test','GBP',${total},3,'USER','${author}','k-${uuidv7()}','h',${o.reverses ? `'${o.reverses}'` : 'NULL'})`;
const line = (j: string, no: number, a: string, d: string, c: string, v?: { code: string; rate: string; role: string; net?: number; tp?: string; inc?: boolean }) =>
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit, tax_code_id, tax_rate_id, vat_role, tax_point, vat_net_line_no, vat_inclusive)
   VALUES ('${org}','${co}','${j}',${no},'${acc[a]}',${d},${c},${v ? `'${v.code}','${v.rate}','${v.role}','${v.tp ?? '2026-02-10'}',${v.net ?? 'NULL'},${v.inc ?? false}` : 'NULL,NULL,NULL,NULL,NULL,NULL'})`;
const sale = (j: string, codeId: string, rateId: string, vatAmt = '12.5', o: { tp?: string; reverses?: string } = {}) => {
  const gross = (100 + Number(vatAmt)).toFixed(2);
  return o.reverses
    ? [hdr(j, gross, { reverses: o.reverses }), line(j, 1, '1110', '0', gross), line(j, 2, '4000', '100', '0', { code: codeId, rate: rateId, role: 'NET', tp: o.tp }), line(j, 3, '2200', vatAmt, '0', { code: codeId, rate: rateId, role: 'VAT', net: 2, tp: o.tp })]
    : [hdr(j, gross), line(j, 1, '1110', gross, '0'), line(j, 2, '4000', '0', '100', { code: codeId, rate: rateId, role: 'NET', tp: o.tp }), line(j, 3, '2200', '0', vatAmt, { code: codeId, rate: rateId, role: 'VAT', net: 2, tp: o.tp })];
};

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  author = sql(`INSERT INTO "user"(email, display_name) VALUES ('vdb1-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  reviewer = sql(`INSERT INTO "user"(email, display_name) VALUES ('vdb2-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','VAT DB A'),('${org2}','BUSINESS','VAT DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  period = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31') RETURNING id`).split('\n')[0]!;
  for (const a of (await db.tenant({ organisationId: org, userId: author }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: author }))).items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('codes and rate versions', () => {
  it('codes are immutable and unique; reverse charge only on standard/reduced purchases', async () => {
    const c = uuidv7(); await tx([code(c, 'S')]);
    await expect(tx([code(uuidv7(), 'S')])).rejects.toThrow(/unique|duplicate/i);
    await expect(tx([`UPDATE tax_code SET treatment='ZERO' WHERE id='${c}'`])).rejects.toThrow(/permission denied|append-only/);
    expect(() => sql(`UPDATE tax_code SET name='x' WHERE id='${c}'`)).toThrow(/append-only/);
    await expect(tx([code(uuidv7(), 'RCS', 'STANDARD', 'SALES', true)])).rejects.toThrow(/rc_ck|violates check/);
  });
  it('a version fits its treatment, starts UNVERIFIED, never overlaps a current version, and changes only by verification (once, by another person) or supersession (once)', async () => {
    const z = uuidv7(), s = uuidv7(); await tx([code(z, 'Z', 'ZERO'), code(s, 'S2')]);
    await expect(tx([rate(uuidv7(), z, { rate: '5' })])).rejects.toThrow(/has a rate of 0/);
    await expect(tx([rate(uuidv7(), s, { rate: '0' })])).rejects.toThrow(/has a rate above 0/);
    await expect(tx([rate(uuidv7(), s, { status: 'VERIFIED' })])).rejects.toThrow(/starts UNVERIFIED|verification_ck|violates check/);
    const r1 = uuidv7(); await tx([rate(r1, s, { to: '2026-06-30' })]);
    await expect(tx([rate(uuidv7(), s, { from: '2026-06-30' })])).rejects.toThrow(/overlaps another current version/);
    await tx([rate(uuidv7(), s, { from: '2026-07-01' })]);                                                   // adjacent: fine
    await expect(tx([verify(r1, author)])).rejects.toThrow(/verification_ck|violates check/);                // the author cannot verify
    await tx([verify(r1)]);
    await expect(tx([`UPDATE tax_rate SET verification_status='UNVERIFIED', verified_by_user_id=NULL, verified_at=NULL WHERE id='${r1}'`])).rejects.toThrow(/verified once/);
    for (const set of ['rate = 13', `effective_from = '2026-01-02'`, `source_url = 'https://example.invalid/other'`, `net_boxes = ARRAY[7]::smallint[]`]) {
      await expect(tx([`UPDATE tax_rate SET ${set} WHERE id='${r1}'`])).rejects.toThrow(/immutable/);
    }
    await expect(tx([`UPDATE tax_rate SET verification_notes='edited later' WHERE id='${r1}'`])).rejects.toThrow(/cannot be edited/);
    await expect(tx([`DELETE FROM tax_rate WHERE id='${r1}'`])).rejects.toThrow(/permission denied/);
  });
  it('only the STANDARD scheme is allowed; a registered company needs its VRN, dates and accounts', async () => {
    const s = (scheme: string, registered = false) => `INSERT INTO company_vat_setting(organisation_id, company_id, registered, scheme) VALUES ('${org}','${co}',${registered},'${scheme}')`;
    await expect(tx([s('CASH')])).rejects.toThrow(/scheme_ck|violates check/);
    await expect(tx([s('FLAT_RATE')])).rejects.toThrow(/scheme_ck|violates check/);
    await expect(tx([s('STANDARD', true)])).rejects.toThrow(/registered_ck|violates check/);
  });
});

describe('VAT on journal lines is proven at commit', () => {
  let c: string, r: string, unverified: string;
  beforeAll(async () => {
    c = uuidv7(); r = uuidv7(); unverified = uuidv7();
    const cu = uuidv7();
    await tx([code(c, 'SV'), rate(r, c), verify(r), code(cu, 'SU'), rate(unverified, cu)]);
    (globalThis as Record<string, unknown>).__cu = cu;
  });
  it('a correct VAT line commits; a wrong VAT amount is refused', async () => {
    await tx(sale(uuidv7(), c, r), { flag: true });
    await expect(tx(sale(uuidv7(), c, r, '12.49'), { flag: true })).rejects.toThrow(/VAT on its net line is 12.50/);
    await expect(tx(sale(uuidv7(), c, r, '13'), { flag: true })).rejects.toThrow(/VAT on its net line/);
  });
  it('an UNVERIFIED version, a version of another code, and a tax point outside the dates are refused', async () => {
    const cu = (globalThis as Record<string, unknown>).__cu as string;
    await expect(tx(sale(uuidv7(), cu, unverified), { flag: true })).rejects.toThrow(/UNVERIFIED tax rate/);
    await expect(tx(sale(uuidv7(), cu, r), { flag: true })).rejects.toThrow(/rate of another tax code/);
    await expect(tx(sale(uuidv7(), c, r, '12.5', { tp: '2025-12-31' }), { flag: true })).rejects.toThrow(/outside the rate's effective dates/);
  });
  it('a superseded version is refused for new journals but accepted on a reversal (corrections mirror history)', async () => {
    const orig = uuidv7(); await tx(sale(orig, c, r), { flag: true });
    const r2 = uuidv7();
    await tx([`UPDATE tax_rate SET superseded_by_id='${r2}' WHERE id='${r}'`, rate(r2, c, { rate: '7' })]);
    await expect(tx(sale(uuidv7(), c, r), { flag: true })).rejects.toThrow(/superseded tax rate version/);
    await tx(sale(uuidv7(), c, r, '12.5', { reverses: orig }), { flag: true });
  });
  it('VAT facts are all-or-none, a VAT line points at its net line, and VAT never sits on a foreign-currency line', async () => {
    const j = uuidv7();
    await expect(tx([hdr(j, '10'), `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit, tax_code_id) VALUES ('${org}','${co}','${j}',1,'${acc['4000']}',0,10,'${c}')`], { flag: true })).rejects.toThrow(/all_or_none|violates check/);
    await expect(tx([hdr(j, '10'), line(j, 1, '4000', '0', '10', { code: c, rate: r, role: 'VAT' })], { flag: true })).rejects.toThrow(/vat_link_ck|violates check/);
    await expect(tx([hdr(j, '10'), line(j, 1, '4000', '0', '10', { code: c, rate: r, role: 'NET', net: 1 })], { flag: true })).rejects.toThrow(/vat_link_ck|violates check/);
  });
  it('tenant isolation: another organisation sees no codes or rates', async () => {
    expect(await db.tenant({ organisationId: org2, userId: author }, async (t) => (await t.taxCode.count()) + (await t.taxRate.count()))).toBe(0);
  });
});
