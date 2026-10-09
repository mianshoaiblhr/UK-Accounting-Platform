import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

let db: Database;
const A = uuidv7(), B = uuidv7();
let userA: string, userB: string, companyA: string, companyB: string;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  // Arrange as superuser (bypasses RLS) so the assertions below prove what the runtime role can see.
  const e = (s: string) => adminSql(s);
  userA = e(`INSERT INTO "user"(email, display_name) VALUES ('a-${A}@t.test','A') RETURNING id`).split('\n')[0]!;
  userB = e(`INSERT INTO "user"(email, display_name) VALUES ('b-${B}@t.test','B') RETURNING id`).split('\n')[0]!;
  e(`INSERT INTO organisation(id,type,name) VALUES ('${A}','PRACTICE','Org A'),('${B}','BUSINESS','Org B')`);
  e(`INSERT INTO practice(organisation_id,name) VALUES ('${A}','Practice A')`);
  companyA = e(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${A}','Co A',(SELECT id FROM practice WHERE organisation_id='${A}')) RETURNING id`).split('\n')[0]!;
  companyB = e(`INSERT INTO company(organisation_id,name) VALUES ('${B}','Co B') RETURNING id`).split('\n')[0]!;
  const owner = e(`SELECT id FROM "role" WHERE key='owner'`);
  e(`INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('${A}','${userA}','${owner}'),('${B}','${userB}','${owner}')`);
});
afterAll(() => db.close());

describe('runtime role hardening', () => {
  it('uk_app is not a superuser and cannot bypass RLS', () => {
    expect(adminSql(`SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='uk_app'`)).toBe('f');
  });
  it('RLS is enabled and forced on every tenant table', () => {
    const rows = adminSql(`SELECT relname FROM pg_class WHERE relname IN ('organisation','role','organisation_membership','company_membership','practice','practice_membership','invitation','company','accounting_period','document','document_version','audit_event','job_record','idempotency_record') AND NOT (relrowsecurity AND relforcerowsecurity)`);
    expect(rows).toBe('');
  });
  it('every table carrying organisation_id has RLS (guard for future migrations)', () => {
    const rows = adminSql(`SELECT c.table_name FROM information_schema.columns c JOIN pg_class p ON p.relname=c.table_name AND p.relkind='r'
      WHERE c.column_name='organisation_id' AND c.table_schema='public' AND NOT p.relrowsecurity`);
    expect(rows).toBe('');
  });
});

describe('row level security (fail closed)', () => {
  it('no context => zero rows from tenant tables', async () => {
    expect(await db.prisma.company.count()).toBe(0);
    expect(await db.prisma.organisation.count()).toBe(0);
    expect(await db.prisma.organisationMembership.count()).toBe(0);
  });
  it('no context => writes are rejected', async () => {
    await expect(db.prisma.company.create({ data: { organisationId: A, name: 'x' } })).rejects.toThrow();
  });
  it('tenant context sees only its own rows', async () => {
    const rows = await db.tenant({ organisationId: A, userId: userA }, (tx) => tx.company.findMany());
    expect(rows.map((r) => r.id)).toEqual([companyA]);
    const rowsB = await db.tenant({ organisationId: B }, (tx) => tx.company.findMany());
    expect(rowsB.map((r) => r.id)).toEqual([companyB]);
  });
  it("tenant context cannot read another tenant's row by id", async () => {
    expect(await db.tenant({ organisationId: A }, (tx) => tx.company.findUnique({ where: { id: companyB } }))).toBeNull();
  });
  it('cannot insert, update or delete across tenants', async () => {
    await expect(db.tenant({ organisationId: A }, (tx) => tx.company.create({ data: { organisationId: B, name: 'evil' } }))).rejects.toThrow();
    const upd = await db.tenant({ organisationId: A }, (tx) => tx.company.updateMany({ where: { id: companyB }, data: { name: 'pwn' } }));
    expect(upd.count).toBe(0);
    const del = await db.tenant({ organisationId: A }, (tx) => tx.company.deleteMany({ where: { id: companyB } }));
    expect(del.count).toBe(0);
    expect(adminSql(`SELECT name FROM company WHERE id='${companyB}'`)).toBe('Co B');
  });
  it('context does not leak between pooled connections/transactions', async () => {
    await db.tenant({ organisationId: A }, (tx) => tx.company.findMany());
    expect(await db.prisma.company.count()).toBe(0);
  });
  it('user context sees own memberships across orgs but cannot modify them', async () => {
    const ms = await db.asUser(userA, (tx) => tx.organisationMembership.findMany());
    expect(ms.map((m) => m.organisationId)).toEqual([A]);
    const r = await db.asUser(userA, (tx) => tx.organisationMembership.updateMany({ data: { status: 'SUSPENDED' } }));
    expect(r.count).toBe(0);
  });
  it('organisation visible to its members only', async () => {
    const orgs = await db.asUser(userA, (tx) => tx.organisation.findMany());
    expect(orgs.map((o) => o.id)).toEqual([A]);
  });
  it('system roles are readable by all tenants; other tenants custom roles are not', async () => {
    adminSql(`INSERT INTO "role"(organisation_id,key,name,permissions) VALUES ('${B}','custom_b','Custom B',ARRAY['org:read'])`);
    const roles = await db.tenant({ organisationId: A }, (tx) => tx.role.findMany());
    expect(roles.some((r) => r.key === 'custom_b')).toBe(false);
    expect(roles.filter((r) => r.isSystem)).toHaveLength(SYSTEM_ROLES.length);
  });
  it('system roles are immutable to the runtime role', async () => {
    const r = await db.tenant({ organisationId: A }, (tx) => tx.role.updateMany({ where: { isSystem: true }, data: { name: 'hacked' } }));
    expect(r.count).toBe(0);
  });
});

describe('seed data', () => {
  it('system roles in the database match @uk/contracts SYSTEM_ROLES exactly', async () => {
    const rows = await db.tenant({ organisationId: A }, (tx) => tx.role.findMany({ where: { isSystem: true } }));
    for (const def of SYSTEM_ROLES) {
      const row = rows.find((r) => r.key === def.key);
      expect(row, def.key).toBeDefined();
      expect([...row!.permissions].sort()).toEqual([...def.permissions].sort());
    }
  });
});

describe('structural integrity', () => {
  it('composite FK rejects a period pointing at another tenants company', () => {
    expect(() => adminSql(`INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${A}','${companyB}','2025-04-01','2026-03-31')`)).toThrow();
  });
  it('document -> company composite FK is tenant safe', () => {
    expect(() => adminSql(`INSERT INTO document(organisation_id,company_id,name,created_by_user_id) VALUES ('${A}','${companyB}','d','${userA}')`)).toThrow();
  });
  it('overlapping accounting periods are rejected by the database', () => {
    adminSql(`INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${A}','${companyA}','2024-04-01','2025-03-31')`);
    expect(() => adminSql(`INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${A}','${companyA}','2025-03-01','2026-03-31')`)).toThrow(/period_no_overlap/);
    adminSql(`INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${A}','${companyA}','2025-04-01','2026-03-31')`);
  });
  it('period must end after it starts', () => {
    expect(() => adminSql(`INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${A}','${companyA}','2030-04-01','2030-03-31')`)).toThrow();
  });
  it('a membership cannot use another organisations custom role', () => {
    const roleB = adminSql(`SELECT id FROM "role" WHERE key='custom_b'`);
    expect(() => adminSql(`UPDATE organisation_membership SET role_id='${roleB}' WHERE organisation_id='${A}'`)).toThrow(/different organisation/);
  });
  it('email must be lowercase', () => {
    expect(() => adminSql(`INSERT INTO "user"(email,display_name) VALUES ('UPPER@T.TEST','x')`)).toThrow();
  });
});

describe('audit log is append-only', () => {
  it('runtime role can insert but not update, delete or truncate', async () => {
    const ev = await db.tenant({ organisationId: A, userId: userA }, (tx) => tx.auditEvent.create({ data: { organisationId: A, actorUserId: userA, action: 'test.event' } }));
    await expect(db.tenant({ organisationId: A }, (tx) => tx.auditEvent.update({ where: { id: ev.id }, data: { action: 'tampered' } }))).rejects.toThrow();
    await expect(db.tenant({ organisationId: A }, (tx) => tx.auditEvent.delete({ where: { id: ev.id } }))).rejects.toThrow();
    await expect(db.prisma.$executeRawUnsafe('TRUNCATE audit_event')).rejects.toThrow();
  });
  it('even the table owner is blocked by triggers', () => {
    expect(() => adminSql(`UPDATE audit_event SET action='x'`)).toThrow(/append-only/);
    expect(() => adminSql(`DELETE FROM audit_event`)).toThrow(/append-only/);
    expect(() => adminSql(`TRUNCATE audit_event`)).toThrow(/append-only/);
  });
  it("tenant cannot read another tenant's audit events; pre-tenant events only by their actor", async () => {
    await db.asUser(userA, (tx) => tx.auditEvent.create({ data: { actorUserId: userA, action: 'auth.login_succeeded' } }));
    expect(await db.tenant({ organisationId: B }, (tx) => tx.auditEvent.count())).toBe(0);
    expect((await db.asUser(userA, (tx) => tx.auditEvent.findMany({ where: { organisationId: null } }))).length).toBe(1);
    expect(await db.asUser(userB, (tx) => tx.auditEvent.count({ where: { organisationId: null } }))).toBe(0);
  });
  it('cannot insert audit rows for a different organisation context', async () => {
    await expect(db.tenant({ organisationId: A }, (tx) => tx.auditEvent.create({ data: { organisationId: B, action: 'forged' } }))).rejects.toThrow();
  });
});

describe('document versions are immutable', () => {
  let docId: string, verId: string;
  beforeAll(() => {
    docId = adminSql(`INSERT INTO document(organisation_id,name,created_by_user_id) VALUES ('${A}','d','${userA}') RETURNING id`).split('\n')[0]!;
    verId = adminSql(`INSERT INTO document_version(organisation_id,document_id,version_no,storage_key,content_type,size_bytes,created_by_user_id) VALUES ('${A}','${docId}',1,'k1','text/plain',10,'${userA}') RETURNING id`).split('\n')[0]!;
  });
  it('storage key, size and content type cannot change', () => {
    expect(() => adminSql(`UPDATE document_version SET storage_key='other' WHERE id='${verId}'`)).toThrow(/immutable/);
    expect(() => adminSql(`UPDATE document_version SET size_bytes=99 WHERE id='${verId}'`)).toThrow(/immutable/);
  });
  it('hash can be set once, never changed', () => {
    adminSql(`UPDATE document_version SET sha256='aa' WHERE id='${verId}'`);
    expect(() => adminSql(`UPDATE document_version SET sha256='bb' WHERE id='${verId}'`)).toThrow(/immutable/);
  });
  it('versions and documents cannot be deleted by the runtime role', async () => {
    await expect(db.tenant({ organisationId: A }, (tx) => tx.documentVersion.delete({ where: { id: verId } }))).rejects.toThrow();
    await expect(db.tenant({ organisationId: A }, (tx) => tx.document.delete({ where: { id: docId } }))).rejects.toThrow();
  });
});
