import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, PurchasesService, type PurchaseActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V1-M6a: the database defends the purchase sub-ledger even if application code is wrong or bypassed (runtime role, tenant context). */
let db: Database;
let org: string, user: string, co: string, supA: string, supB: string, contactA: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const purchases = new PurchasesService();
const me: PurchaseActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const raw = (statements: string[]) => t(async (tx) => { for (const s of statements) await tx.$executeRawUnsafe(s); });
const bill = async (role: string, amount: string, ref: string, date = '2026-02-10') => {
  const d = await t((tx) => purchases.createBill(tx, { organisationId: org, companyId: co, actor: me, supplierRoleId: role, supplierReference: ref, issueDate: date, amountsIncludeVat: false,
    lines: [{ description: 'Synthetic goods', quantity: '1', unitPrice: amount, accountId: acc['6100']! }] }));
  return t((tx) => purchases.approve(tx, { organisationId: org, companyId: co, actor: me, id: d.id }));
};

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('pdb-${org}@t.test','P') RETURNING id`).split('\n')[0]!;
  me.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Purchases DB')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Purchases DB Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  const role = (name: string) => {
    const c = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${name}','${user}') RETURNING id`).split('\n')[0]!;
    return { c, r: sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${co}','${c}','SUPPLIER','${user}') RETURNING id`).split('\n')[0]! };
  };
  ({ c: contactA, r: supA } = role('Supplier A')); supB = role('Supplier B').r;
  await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: co, actor: me, payablesAccountId: acc['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Purchase settings for the database tests' }));
});
afterAll(() => db.close());

describe('purchase documents', () => {
  it("a bill carries the supplier's own number; the role must be a SUPPLIER role of the company", async () => {
    const ins = (role: string, contact: string, ref: string) => `INSERT INTO purchase_document(organisation_id, company_id, kind, supplier_role_id, contact_id, supplier_reference, issue_date, due_date, currency, created_by_user_id)
      VALUES ('${org}','${co}','BILL','${role}','${contact}',${ref},'2026-02-10','2026-02-10','GBP','${user}')`;
    await expect(raw([ins(supA, contactA, 'NULL')])).rejects.toThrow(/supplier_ref_ck/);
    await expect(raw([ins(supB, contactA, `'X-1'`)])).rejects.toThrow(/belong to this company and contact/);
    const cust = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${co}','${contactA}','CUSTOMER','${user}') RETURNING id`).split('\n')[0]!;
    await expect(raw([ins(cust, contactA, `'X-2'`)])).rejects.toThrow(/purchase_document_role_fkey|violates foreign key/);
  });
  it('an approved bill is immutable; numbering moves forward by one; lines and allocations cannot be changed', async () => {
    const b = await bill(supA, '10.00', 'A-1');
    expect(b.documentNumber).toBe('BILL-1');
    await expect(raw([`UPDATE purchase_document SET supplier_reference='edited' WHERE id='${b.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`UPDATE purchase_sequence SET last_number = last_number + 5 WHERE company_id='${co}'`])).rejects.toThrow(/moves forward by one/);
    await expect(raw([`UPDATE purchase_document_line SET net=1 WHERE document_id='${b.id}'`])).rejects.toThrow(/permission denied|not permitted/);
    await expect(raw([`DELETE FROM purchase_document WHERE id='${b.id}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('a debit note credits an approved bill of the same supplier; allocations never cross suppliers or go below zero', async () => {
    const a = await bill(supA, '50.00', 'A-2');
    const dn = await t(async (tx) => purchases.approve(tx, { organisationId: org, companyId: co, actor: me, id: (await purchases.createDebitNote(tx, { organisationId: org, companyId: co, actor: me, originalBillId: a.id, issueDate: '2026-02-20', reason: 'Part credit',
      lines: [{ description: 'credit', quantity: '1', unitPrice: '10.00', accountId: acc['6100']! }] })).id }));
    const other = await bill(supB, '60.00', 'B-1');
    const alloc = (b: string, amount: string) => `INSERT INTO purchase_allocation(id, organisation_id, company_id, bill_id, debit_id, amount, bill_functional, debit_functional, fx_difference, allocated_on, created_by_user_id)
      VALUES ('${uuidv7()}','${org}','${co}','${b}','${dn.id}',${amount},${amount},${amount},0,'2026-02-20','${user}')`;
    await expect(raw([alloc(a.id, '1')])).rejects.toThrow(/outstanding_ck|violates check/);
    await expect(raw([alloc(other.id, '1')])).rejects.toThrow(/one company, supplier and currency|bill it credits/);
    expect(sql(`SELECT outstanding FROM purchase_document WHERE id='${a.id}'`)).toBe('40.0000');
  });
  it('a purchase journal cannot be reversed in the ledger, even by a direct insert', async () => {
    const b = await bill(supA, '70.00', 'A-3');
    const period = sql(`SELECT id FROM accounting_period WHERE company_id='${co}'`);
    await expect(t(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
      await tx.$executeRawUnsafe(`INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
        VALUES ('${uuidv7()}','${org}','${co}','${period}',990002,'2026-02-19','REVERSAL','${b.journalId}','x','GBP',70,2,'USER','${user}','k-${uuidv7()}','h','${b.journalId}')`);
    })).rejects.toThrow(/corrected in its sub-ledger/);
  });
});
