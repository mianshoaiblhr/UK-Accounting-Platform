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
  outbox_event: ['TRUNCATE'],                    // DELETE is system-context only (RLS) and trigger-guarded
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
