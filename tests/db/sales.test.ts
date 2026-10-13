import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, SalesService, money, type SalesActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M5a: the database defends the sales sub-ledger even if application code is wrong or bypassed (runtime role, tenant context): numbering without
 * gaps, immutable approved documents and line revisions, outstanding amounts that move only through allocations and never below zero, allocations
 * within one customer and currency, and credit notes only against approved invoices of the same customer.
 */
let db: Database;
let org: string, user: string, co: string, roleA: string, roleB: string, contactA: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const sales = new SalesService();
const me: SalesActor = { kind: 'USER', userId: '', can: async () => true };
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const raw = (statements: string[]) => t(async (tx) => { for (const s of statements) await tx.$executeRawUnsafe(s); });
const invoice = async (role: string, amount: string, date = '2026-02-10') => {
  const d = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: co, actor: me, customerRoleId: role, issueDate: date, amountsIncludeVat: false,
    lines: [{ description: 'Synthetic service', quantity: '1', unitPrice: amount, accountId: acc['4000']! }] }));
  return t((tx) => sales.approve(tx, { organisationId: org, companyId: co, actor: me, id: d.id }));
};

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('sdb-${org}@t.test','S') RETURNING id`).split('\n')[0]!;
  me.userId = user;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Sales DB')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Sales DB Co') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  const role = (name: string) => {
    const c = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${name}','${user}') RETURNING id`).split('\n')[0]!;
    const r = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${co}','${c}','CUSTOMER','${user}') RETURNING id`).split('\n')[0]!;
    return { c, r };
  };
  ({ c: contactA, r: roleA } = role('Customer A')); roleB = role('Customer B').r;
  await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: co, actor: me, receivablesAccountId: acc['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the database tests' }));
});
afterAll(() => db.close());

describe('documents and numbering', () => {
  it('a document starts as a DRAFT; the customer role must be a CUSTOMER role of the company and belong to the contact', async () => {
    await expect(raw([`INSERT INTO sales_document(organisation_id, company_id, kind, status, customer_role_id, contact_id, issue_date, due_date, currency, created_by_user_id)
      VALUES ('${org}','${co}','INVOICE','APPROVED','${roleA}','${contactA}','2026-02-10','2026-02-10','GBP','${user}')`])).rejects.toThrow(/starts as a DRAFT|approved_ck/);
    await expect(raw([`INSERT INTO sales_document(organisation_id, company_id, kind, customer_role_id, contact_id, issue_date, due_date, currency, created_by_user_id)
      VALUES ('${org}','${co}','INVOICE','${roleB}','${contactA}','2026-02-10','2026-02-10','GBP','${user}')`])).rejects.toThrow(/belong to this company and contact/);
  });
  it('approval takes exactly the next number; the sequence moves forward by one; numbering settings freeze', async () => {
    const a = await invoice(roleA, '10.00');
    expect(a.number).toBe(1);
    await expect(raw([`UPDATE sales_sequence SET last_number = last_number + 2 WHERE company_id='${co}' AND kind='INVOICE'`])).rejects.toThrow(/moves forward by one/);
    await expect(raw([`UPDATE sales_setting SET invoice_start = 50 WHERE company_id='${co}'`])).rejects.toThrow(/numbering cannot change/);
    // a draft forced to APPROVED with a number that is not the sequence's is refused (as are the missing journal and snapshot)
    const d = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: co, actor: me, customerRoleId: roleA, issueDate: '2026-02-11', amountsIncludeVat: false, lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: acc['4000']! }] }));
    await expect(raw([`UPDATE sales_document SET status='APPROVED', number=7, document_number='INV-7', journal_id='${a.journalId}', approved_by_user_id='${user}', approved_at=now(), contact_snapshot='{}', functional_gross=1, outstanding=1, functional_outstanding=1 WHERE id='${d.id}'`]))
      .rejects.toThrow(/next number|unique|duplicate/);
  });
  it('an approved document is immutable except through an allocation; it is never deleted', async () => {
    const a = await invoice(roleA, '20.00', '2026-02-12');
    await expect(raw([`UPDATE sales_document SET notes='edited' WHERE id='${a.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`UPDATE sales_document SET outstanding=0, functional_outstanding=0 WHERE id='${a.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`DELETE FROM sales_document WHERE id='${a.id}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('lines are append-only revisions, written only for the current revision of a draft', async () => {
    const a = await invoice(roleA, '30.00', '2026-02-13');
    await expect(raw([`UPDATE sales_document_line SET net=1 WHERE document_id='${a.id}'`])).rejects.toThrow(/permission denied|not permitted/);
    await expect(raw([`INSERT INTO sales_document_line(organisation_id, company_id, document_id, revision, line_no, description, quantity, unit_price, account_id, net, vat, gross)
      VALUES ('${org}','${co}','${a.id}',${a.revision},9,'late line',1,1,'${acc['4000']}',1,0,1)`])).rejects.toThrow(/current revision of a draft/);
  });
});

describe('allocations and credit notes', () => {
  it('a credit note credits an approved invoice of the same customer and currency', async () => {
    const draft = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: co, actor: me, customerRoleId: roleA, issueDate: '2026-02-14', amountsIncludeVat: false, lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: acc['4000']! }] }));
    const ins = (orig: string, role: string) => `INSERT INTO sales_document(organisation_id, company_id, kind, customer_role_id, contact_id, issue_date, due_date, currency, original_invoice_id, credit_reason, created_by_user_id)
      VALUES ('${org}','${co}','CREDIT_NOTE','${role}',(SELECT contact_id FROM contact_role WHERE id='${role}'),'2026-02-20','2026-02-20','GBP','${orig}','Probe credit','${user}')`;
    await expect(raw([ins(draft.id, roleA)])).rejects.toThrow(/approved invoice of the same customer/);
    const a = await invoice(roleA, '40.00', '2026-02-15');
    await expect(raw([ins(a.id, roleB)])).rejects.toThrow(/approved invoice of the same customer/);
  });
  it('allocations never take an outstanding amount below zero, never cross customers, and cannot be changed', async () => {
    const a = await invoice(roleA, '50.00', '2026-02-16');
    const cn = await t((tx) => sales.createCreditNote(tx, { organisationId: org, companyId: co, actor: me, originalInvoiceId: a.id, issueDate: '2026-02-20', reason: 'Partial credit',
      lines: [{ description: 'credit', quantity: '1', unitPrice: '10.00', accountId: acc['4000']! }] }));
    const ca = await t((tx) => sales.approve(tx, { organisationId: org, companyId: co, actor: me, id: cn.id }));
    expect(ca.allocations[0]).toMatchObject({ amount: '10.0000' });
    const alloc = (inv: string, amount: string) => `INSERT INTO sales_allocation(id, organisation_id, company_id, invoice_id, credit_id, amount, invoice_functional, credit_functional, fx_difference, allocated_on, created_by_user_id)
      VALUES ('${uuidv7()}','${org}','${co}','${inv}','${cn.id}',${amount},${amount},${amount},0,'2026-02-20','${user}')`;
    // the credit note is fully allocated: any further allocation would take it below zero
    await expect(raw([alloc(a.id, '1')])).rejects.toThrow(/outstanding_ck|violates check/);
    const other = await invoice(roleB, '60.00', '2026-02-17');
    await expect(raw([alloc(other.id, '1')])).rejects.toThrow(/one company, customer and currency|invoice it credits/);
    await expect(raw([`UPDATE sales_allocation SET amount=1 WHERE credit_id='${cn.id}'`])).rejects.toThrow(/permission denied|not permitted/);
    // what the trigger did is exact: 50 - 10 outstanding on the invoice
    expect(sql(`SELECT outstanding||'|'||functional_outstanding FROM sales_document WHERE id='${a.id}'`)).toBe('40.0000|40.0000');
    expect(money(ca.outstanding).isZero()).toBe(true);
  });
  it('a sales journal cannot be reversed in the ledger, even by a direct insert', async () => {
    const a = await invoice(roleA, '70.00', '2026-02-18');
    const period = sql(`SELECT id FROM accounting_period WHERE company_id='${co}'`);
    await expect(t(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
      await tx.$executeRawUnsafe(`INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, reverses_journal_id)
        VALUES ('${uuidv7()}','${org}','${co}','${period}',990001,'2026-02-19','REVERSAL','${a.journalId}','x','GBP',70,2,'USER','${user}','k-${uuidv7()}','h','${a.journalId}')`);
    })).rejects.toThrow(/corrected in its sub-ledger/);
  });
  it('tenant isolation: another organisation sees no sales rows', async () => {
    const other = uuidv7();
    sql(`INSERT INTO organisation(id,type,name) VALUES ('${other}','BUSINESS','Sales DB other')`);
    const n = await db.tenant({ organisationId: other, userId: user }, (tx) => tx.salesDocument.count());
    expect(n).toBe(0);
  });
});

describe('receipts (M5b)', () => {
  const receipt = (role: string, amount: string, date: string) => t((tx) => sales.recordReceipt(tx, { organisationId: org, companyId: co, actor: me, customerRoleId: role, receiptDate: date, amount,
    bankAccountId: acc['1200']!, allocations: [], duplicateOverrideReason: 'Synthetic receipts in the database tests' }));
  it('a receipt is immutable; its unallocated amount moves only through an allocation; it is never deleted', async () => {
    const r = await receipt(roleA, '80.00', '2026-03-01');
    await expect(raw([`UPDATE sales_receipt SET amount=1 WHERE id='${r.id}'`])).rejects.toThrow(/immutable/);
    await expect(raw([`UPDATE sales_receipt SET outstanding=0, functional_outstanding=0 WHERE id='${r.id}'`])).rejects.toThrow(/only through an allocation/);
    await expect(raw([`DELETE FROM sales_receipt WHERE id='${r.id}'`])).rejects.toThrow(/permission denied|not permitted/);
  });
  it('a receipt is allocated only to the same customer, and an allocated receipt cannot be marked reversed', async () => {
    const r = await receipt(roleB, '90.00', '2026-03-02');
    const a = await invoice(roleA, '15.00', '2026-03-02');
    const alloc = (inv: string) => `INSERT INTO sales_allocation(id, organisation_id, company_id, invoice_id, receipt_id, amount, invoice_functional, credit_functional, fx_difference, allocated_on, created_by_user_id)
      VALUES ('${uuidv7()}','${org}','${co}','${inv}','${r.id}',5,5,5,0,'2026-03-02','${user}')`;
    await expect(raw([alloc(a.id)])).rejects.toThrow(/one company, customer and currency/);
    const b = await invoice(roleB, '15.00', '2026-03-02');
    await raw([alloc(b.id)]);
    expect(sql(`SELECT outstanding FROM sales_receipt WHERE id='${r.id}'`)).toBe('85.0000');
    await expect(raw([`UPDATE sales_receipt SET status='REVERSED', reversal_journal_id='${r.journalId}', reversed_by_user_id='${user}', reversed_at=now(), reversed_reason='probe' WHERE id='${r.id}'`]))
      .rejects.toThrow(/only an unallocated receipt/);
  });
});
