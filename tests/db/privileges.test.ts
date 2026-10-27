import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/**
 * EFFECTIVE privileges of the runtime role (uk_app), not just the migration text: has_table_privilege() resolves default privileges,
 * PUBLIC grants and role membership. Append-only guarantees must hold at the privilege level (first line) AND by trigger (second line).
 */
let db: Database;
let org: string, user: string;

/** table -> privileges the runtime role must NOT hold at all. */
const FORBIDDEN: Record<string, string[]> = {
  audit_event: ['UPDATE', 'DELETE', 'TRUNCATE'],
  workflow_transition: ['UPDATE', 'DELETE', 'TRUNCATE'],
  ai_run: ['UPDATE', 'DELETE', 'TRUNCATE'],
  task_comment: ['UPDATE', 'DELETE', 'TRUNCATE'],
  document_version: ['DELETE', 'TRUNCATE'],      // immutable content; only status bookkeeping may be updated
  task_attachment: ['UPDATE', 'TRUNCATE'],       // link or unlink, never edit
  task_reminder: ['DELETE', 'TRUNCATE'],         // pending -> sent | cancelled, never removed
  evidence_link: ['DELETE', 'TRUNCATE'],         // revoked, never deleted; the only permitted UPDATE is revocation (trigger)
  document: ['DELETE', 'TRUNCATE'],              // archived, never deleted
  document_extraction: ['DELETE', 'TRUNCATE'],
  journal: ['UPDATE', 'DELETE', 'TRUNCATE'],      // posted journals are immutable (V1)
  journal_line: ['UPDATE', 'DELETE', 'TRUNCATE'],
  account: ['DELETE', 'TRUNCATE'],                // deactivated, never deleted
  ledger_sequence: ['DELETE', 'TRUNCATE'],
  journal_request: ['DELETE', 'TRUNCATE'],        // decided, never deleted (content immutable by trigger)
  ledger_policy: ['DELETE', 'TRUNCATE'],
  exchange_rate: ['DELETE', 'TRUNCATE'],           // superseded, never deleted (only verification / supersession update a row, by trigger)
  company_fx_setting: ['DELETE', 'TRUNCATE'],
  fx_revaluation_run: ['DELETE', 'TRUNCATE'],
  contact_role: ['DELETE', 'TRUNCATE'],             // ended, never deleted
  customer_profile: ['DELETE', 'TRUNCATE'],
  supplier_profile: ['DELETE', 'TRUNCATE'],
  tax_code: ['UPDATE', 'DELETE', 'TRUNCATE'],     // immutable; a change is a new code
  tax_rate: ['DELETE', 'TRUNCATE'],               // versions are superseded, never deleted
  company_vat_setting: ['DELETE', 'TRUNCATE'],
  sales_setting: ['DELETE', 'TRUNCATE'],
  sales_sequence: ['DELETE', 'TRUNCATE'],           // moves forward by one, by trigger
  sales_document: ['DELETE', 'TRUNCATE'],           // discarded or corrected by credit note, never deleted
  sales_document_line: ['UPDATE', 'DELETE', 'TRUNCATE'], // append-only revisions
  sales_allocation: ['UPDATE', 'DELETE', 'TRUNCATE'],
  sales_receipt: ['DELETE', 'TRUNCATE'],
  purchase_setting: ['DELETE', 'TRUNCATE'],
  purchase_sequence: ['DELETE', 'TRUNCATE'],
  purchase_document: ['DELETE', 'TRUNCATE'],
  purchase_document_line: ['UPDATE', 'DELETE', 'TRUNCATE'],
  purchase_allocation: ['UPDATE', 'DELETE', 'TRUNCATE'],
  purchase_payment: ['DELETE', 'TRUNCATE'],        // POSTED -> REVERSED once, never removed; immutable by trigger
  cash_transaction: ['DELETE', 'TRUNCATE'],        // POSTED -> REVERSED once by a proven mirror; immutable by trigger
  cash_transaction_line: ['UPDATE', 'DELETE', 'TRUNCATE'], // written once with its transaction
  bank_account: ['DELETE', 'TRUNCATE'],            // closed, never deleted
  bank_statement_import: ['DELETE', 'TRUNCATE'],   // QUEUED -> COMPLETED | FAILED, COMPLETED -> VOID (trigger)
  bank_statement_line: ['DELETE', 'TRUNCATE'],     // facts from the bank: only voided / matched_amount move (trigger)
  bank_transfer: ['DELETE', 'TRUNCATE'],           // POSTED -> REVERSED once by a proven mirror
  bank_match: ['DELETE', 'TRUNCATE'],              // ACTIVE -> UNMATCHED once with a reason (trigger)
  bank_reconciliation: ['UPDATE', 'DELETE', 'TRUNCATE'], // a sign-off is recorded once
  reporting_standard: ['UPDATE', 'DELETE', 'TRUNCATE'],         // written once (V2-M1)
  reporting_standard_version: ['DELETE', 'TRUNCATE'],           // verified once, superseded once; immutable once verified (trigger)
  statutory_line: ['DELETE', 'TRUNCATE'],                       // removed by a flag while unverified (trigger)
  statutory_map_entry: ['DELETE', 'TRUNCATE'],
  validation_rule: ['DELETE', 'TRUNCATE'],
  disclosure_rule: ['DELETE', 'TRUNCATE'],
  statutory_account_override: ['DELETE', 'TRUNCATE'],           // ended once, never edited (trigger)
  company_reporting_framework: ['DELETE', 'TRUNCATE'],          // changed with a reason while unlocked (trigger)
  fixed_asset_class: ['DELETE', 'TRUNCATE'],                    // defaults change with a reason; accounts never (V2-M2)
  fixed_asset: ['DELETE', 'TRUNCATE'],                          // ACTIVE -> DISPOSED | VOID; acquisition facts immutable (trigger)
  fixed_asset_basis: ['UPDATE', 'DELETE', 'TRUNCATE'],          // append-only
  depreciation_run: ['DELETE', 'TRUNCATE'],                     // POSTED -> REVERSED once (trigger)
  depreciation_run_line: ['UPDATE', 'DELETE', 'TRUNCATE'],      // written once with its run
  year_end_item: ['DELETE', 'TRUNCATE'],                        // ACTIVE -> CANCELLED once by mirrors (V2-M3a)
  release_run: ['DELETE', 'TRUNCATE'],                          // POSTED -> REVERSED once (trigger)
  release_run_line: ['UPDATE', 'DELETE', 'TRUNCATE'],           // written once with its run
  provision: ['UPDATE', 'DELETE', 'TRUNCATE'],                  // written once
  provision_movement: ['DELETE', 'TRUNCATE'],                   // POSTED -> REVERSED once (trigger)
  year_end_close: ['DELETE', 'TRUNCATE'],
  director_loan_account: ['DELETE', 'TRUNCATE'],                // ACTIVE -> CLOSED once (trigger)
  director_loan_threshold: ['UPDATE', 'DELETE', 'TRUNCATE'],    // versioned rows, written once
  related_party: ['DELETE', 'TRUNCATE'],
  year_end_step_signoff: ['UPDATE', 'DELETE', 'TRUNCATE'],      // written once; a reopen is a new row
  accounts_approval: ['UPDATE', 'DELETE', 'TRUNCATE'],          // written once; a lapsed review is followed by a new one
  accounts_package: ['UPDATE', 'DELETE', 'TRUNCATE'],           // one per year, written once
  review_setting: ['UPDATE', 'DELETE', 'TRUNCATE'],             // the latest row applies
  review_flag_response: ['UPDATE', 'DELETE', 'TRUNCATE'],       // written once; the second-person rule in a trigger
  cash_flow_class: ['DELETE', 'TRUNCATE'],                      // version content; frozen once the version is verified (trigger)
  cash_flow_map_entry: ['DELETE', 'TRUNCATE'],
  size_threshold_set: ['DELETE', 'TRUNCATE'],                   // verified once, superseded once; immutable once verified (trigger)
  accounts_fact: ['UPDATE', 'DELETE', 'TRUNCATE'],                // written once; the latest applies                        // ACTIVE -> ENDED once (trigger)                       // POSTED -> REVERSED once (trigger)
  notification_preference: ['DELETE', 'TRUNCATE'], // toggled, never removed
  notification_delivery: ['DELETE', 'TRUNCATE'],   // planned deliveries are final once handled
  outbox_event: ['TRUNCATE'],                    // DELETE is system-context only (RLS) and trigger-guarded
  // V7-M1 (DEC-088)
  deadline_rule: ['DELETE', 'TRUNCATE'],             // versions are superseded, never deleted (only verification / supersession update a row, by trigger)
  company_compliance_profile: ['DELETE', 'TRUNCATE'],
  compliance_obligation: ['DELETE', 'TRUNCATE'],     // never deleted; identity fixed and versioned updates (trigger)
  vat_return: ['DELETE', 'TRUNCATE'],                // never deleted; identity fixed; the lock and approved content written once (trigger)
  vat_return_event: ['UPDATE', 'DELETE', 'TRUNCATE'], // append-only
};
const has = (table: string, priv: string) => adminSql(`SELECT has_table_privilege('uk_app', '${table}', '${priv}')`) === 't';
const hasAnyColumn = (table: string, priv: string) => adminSql(`SELECT has_any_column_privilege('uk_app', '${table}', '${priv}')`) === 't';

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('pv-${org}@t.test','P') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Privileges')`);
});
afterAll(() => db.close());

describe('the runtime role is unprivileged', () => {
  it('is not a superuser, does not bypass RLS, cannot create roles or databases, and belongs to no other role', () => {
    expect(adminSql(`SELECT rolsuper||'|'||rolbypassrls||'|'||rolcreaterole||'|'||rolcreatedb||'|'||rolreplication FROM pg_roles WHERE rolname='uk_app'`)).toBe('false|false|false|false|false');
    expect(adminSql(`SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname='uk_app'`)).toBe('0');
  });
  it('owns nothing: triggers, policies and grants can only be changed by the migration owner', () => {
    expect(adminSql(`SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname='uk_app')`)).toBe('0');
    expect(adminSql(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname='uk_app')`)).toBe('0');
    expect(adminSql(`SELECT count(*) FROM pg_namespace WHERE nspname='public' AND nspowner = (SELECT oid FROM pg_roles WHERE rolname='uk_app')`)).toBe('0');
  });
  it('no SECURITY DEFINER function is exposed that could write on its behalf', () => {
    expect(adminSql(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef`)).toBe('0');
  });
});

describe('append-only and immutable records: privileges', () => {
  for (const [table, privs] of Object.entries(FORBIDDEN)) {
    it(`${table}: uk_app holds none of ${privs.join(', ')}`, () => {
      for (const p of privs) {
        expect(has(table, p), `${table} ${p}`).toBe(false);
        if (p === 'UPDATE') expect(hasAnyColumn(table, 'UPDATE'), `${table} column UPDATE`).toBe(false);
      }
    });
  }
  it('every table guarded by the append-only trigger is covered by this matrix (a new one cannot slip through)', () => {
    const guarded = adminSql(`SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND pg_get_triggerdef(t.oid) LIKE '%forbid_mutation%')`).split(',');
    for (const t of guarded) expect(FORBIDDEN[t], `${t} has the append-only trigger but is missing from the privilege matrix`).toBeDefined();
    for (const t of guarded) expect(FORBIDDEN[t], `${t}: the append-only trigger also forbids DELETE`).toEqual(expect.arrayContaining(['DELETE', 'TRUNCATE']));
  });
});

describe('append-only and immutable records: behaviour of the real runtime connection', () => {
  const eventId = () => adminSql(`INSERT INTO audit_event(action, organisation_id) VALUES ('privilege.test','${org}') RETURNING id`).split('\n')[0]!;
  it('cannot update, delete or truncate the audit trail', async () => {
    const id = eventId();
    await expect(db.tenant({ organisationId: org, userId: user }, (tx) => tx.auditEvent.updateMany({ where: { id }, data: { action: 'tampered' } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant({ organisationId: org, userId: user }, (tx) => tx.auditEvent.deleteMany({ where: { id } }))).rejects.toThrow(/permission denied/);
    await expect(db.system((tx) => tx.$executeRaw`TRUNCATE audit_event`)).rejects.toThrow(/permission denied/);
    await expect(db.system((tx) => tx.auditEvent.deleteMany({}))).rejects.toThrow(/permission denied/);
    expect(adminSql(`SELECT action FROM audit_event WHERE id='${id}'`)).toBe('privilege.test');
  });
  it('cannot delete a document version', async () => {
    const co = adminSql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','PV') RETURNING id`).split('\n')[0]!;
    const doc = adminSql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','d','${user}') RETURNING id`).split('\n')[0]!;
    const v = adminSql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, created_by_user_id) VALUES ('${org}','${doc}',1,'k','application/pdf',1,'${user}') RETURNING id`).split('\n')[0]!;
    await expect(db.tenant({ organisationId: org, userId: user }, (tx) => tx.documentVersion.deleteMany({ where: { id: v } }))).rejects.toThrow(/permission denied/);
    expect(adminSql(`SELECT count(*) FROM document_version WHERE id='${v}'`)).toBe('1');
  });
  it('cannot switch off the guards: no DISABLE TRIGGER, DROP TRIGGER, DISABLE RLS, replica mode, role switch or policy change', async () => {
    const attempts = [
      `ALTER TABLE audit_event DISABLE TRIGGER ALL`, `ALTER TABLE task DISABLE TRIGGER task_review_guard_trg`, `DROP TRIGGER task_review_guard_trg ON task`,
      `ALTER TABLE task DISABLE ROW LEVEL SECURITY`, `ALTER TABLE task NO FORCE ROW LEVEL SECURITY`, `DROP POLICY tenant_isolation ON task`,
      `SET session_replication_role = replica`, `SET ROLE postgres`, `ALTER ROLE uk_app BYPASSRLS`,
      `CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    ];
    for (const sql of attempts) {
      await expect(db.system((tx) => tx.$executeRawUnsafe(sql)), sql).rejects.toThrow(/must be owner|permission denied|superuser|not permitted/i);
    }
  });
  it('cannot grant itself or PUBLIC anything (a non-owner GRANT is a silent no-op in PostgreSQL, so check the effect)', async () => {
    await db.system((tx) => tx.$executeRawUnsafe(`GRANT ALL ON audit_event TO PUBLIC`));
    expect(adminSql(`SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_schema='public'`)).toBe('0');
    expect(has('audit_event', 'UPDATE')).toBe(false);
  });
  it('comments, reminders and attachments obey the same limits through the real connection', async () => {
    const co = adminSql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','PV2') RETURNING id`).split('\n')[0]!;
    const t = adminSql(`INSERT INTO task(organisation_id, company_id, title, created_by_user_id) VALUES ('${org}','${co}','t','${user}') RETURNING id`).split('\n')[0]!;
    const c = adminSql(`INSERT INTO task_comment(organisation_id, task_id, author_user_id, body) VALUES ('${org}','${t}','${user}','b') RETURNING id`).split('\n')[0]!;
    const r = adminSql(`INSERT INTO task_reminder(organisation_id, task_id, recipient_user_id, remind_at, created_by_user_id) VALUES ('${org}','${t}','${user}', now() + interval '1 day','${user}') RETURNING id`).split('\n')[0]!;
    const ctx = { organisationId: org, userId: user };
    await expect(db.tenant(ctx, (tx) => tx.taskComment.updateMany({ where: { id: c }, data: { body: 'x' } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant(ctx, (tx) => tx.taskComment.deleteMany({ where: { id: c } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant(ctx, (tx) => tx.taskReminder.deleteMany({ where: { id: r } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant(ctx, (tx) => tx.taskReminder.updateMany({ where: { id: r }, data: { remindAt: new Date(0) } }))).rejects.toThrow(/retargeted/); // trigger: second line
  });
});

describe('no privilege leaks to PUBLIC', () => {
  it('PUBLIC holds no table privileges in the application schema', () => {
    expect(adminSql(`SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_schema='public'`)).toBe('0');
  });
});
