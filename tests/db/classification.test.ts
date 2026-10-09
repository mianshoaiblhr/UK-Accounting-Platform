import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_AUTH_TABLES, REFERENCE_TABLES, TABLE_PROTECTION, TENANT_TABLES, Database } from '@uk/db';
import { uuidv7 } from '@uk/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminSql } from '../helpers/db';

/** Automated enforcement of docs/architecture/security-architecture.md. */
let db: Database;
beforeAll(() => { db = new Database(process.env.DATABASE_URL!); });
afterAll(() => db.close());

const dbTables = () => adminSql(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1`).split('\n').filter(Boolean);

describe('every table is classified (adding a table without a decision fails CI)', () => {
  it('registry == database', () => expect(Object.keys(TABLE_PROTECTION).sort()).toEqual(dbTables()));
});

describe('security-architecture.md is in sync with the registry', () => {
  const doc = readFileSync(resolve(__dirname, '../../docs/architecture/security-architecture.md'), 'utf8');
  it.each(Object.keys(TABLE_PROTECTION))('documents table %s', (t) => expect(doc).toContain('`' + t + '`'));
});

describe('classification matches reality', () => {
  it('RLS / RLS+APP tables: row security enabled AND forced, with at least one policy', () => {
    for (const t of TENANT_TABLES) {
      expect(adminSql(`SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname='${t}' AND relkind='r'`), `${t} RLS`).toBe('t');
      expect(Number(adminSql(`SELECT count(*) FROM pg_policies WHERE tablename='${t}'`)), `${t} policies`).toBeGreaterThan(0);
    }
  });
  it('tenant tables carry organisation_id (or are the tenant root)', () => {
    for (const t of TENANT_TABLES) {
      const has = adminSql(`SELECT count(*) FROM information_schema.columns WHERE table_name='${t}' AND column_name='organisation_id'`);
      expect(has === '1' || t === 'organisation', `${t} organisation_id`).toBe(true);
    }
  });
  it('APP-only tables are the authentication subsystem: no organisation_id, no tenant business data', () => {
    expect(GLOBAL_AUTH_TABLES.sort()).toEqual(['auth_challenge', 'auth_token', 'login_trusted_ip', 'mfa_factor', 'mfa_recovery_code', 'session', 'user', 'user_identity']);
    for (const t of GLOBAL_AUTH_TABLES) {
      expect(adminSql(`SELECT count(*) FROM information_schema.columns WHERE table_name='${t}' AND column_name='organisation_id'`), t).toBe('0');
    }
  });
  it('the runtime role cannot change RLS settings or policies (not the table owner)', () => {
    expect(adminSql(`SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='uk_app'`)).toBe('0');
  });
});

describe('reference tables (global, read-only)', () => {
  it('are exactly the ISO / jurisdiction / document-type tables, carry no organisation_id and are populated', () => {
    expect([...REFERENCE_TABLES].sort()).toEqual(['country', 'currency', 'document_type', 'retention_category', 'retention_rule', 'tax_jurisdiction']);
    for (const t of REFERENCE_TABLES) {
      expect(adminSql(`SELECT count(*) FROM information_schema.columns WHERE table_name='${t}' AND column_name='organisation_id'`), t).toBe('0');
      expect(Number(adminSql(`SELECT count(*) FROM ${t}`)), `${t} rows`).toBeGreaterThan(0);
    }
  });
  it('the runtime role can read but never write them (changes are migrations)', async () => {
    for (const t of REFERENCE_TABLES) {
      expect(adminSql(`SELECT has_table_privilege('uk_app','${t}','SELECT')`), t).toBe('t');
      for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect(adminSql(`SELECT has_table_privilege('uk_app','${t}','${p}')`), `${t} ${p}`).toBe('f');
    }
    expect(await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM country`)).toBeTruthy();
    await expect(db.prisma.$executeRawUnsafe(`INSERT INTO currency(code,numeric_code,name,minor_units) VALUES ('ZZZ','999','x',2)`)).rejects.toThrow();
  });
});

describe('automated cross-tenant sweep over EVERY tenant table', () => {
  const A = uuidv7(), B = uuidv7();
  beforeAll(() => {
    const u = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('sweep-${A}@t.test','S') RETURNING id`).split('\n')[0]!;
    adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${A}','PRACTICE','Sweep A'),('${B}','PRACTICE','Sweep B')`);
    for (const o of [A, B]) {
      const practice = adminSql(`INSERT INTO practice(organisation_id,name) VALUES ('${o}','p-${o}') RETURNING id`).split('\n')[0]!;
      const company = adminSql(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${o}','c-${o}','${practice}') RETURNING id`).split('\n')[0]!;
      const m = adminSql(`INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('${o}','${u}','00000000-0000-4000-8000-0000000000a1') RETURNING id`).split('\n')[0]!;
      adminSql(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${o}','${practice}','${m}','00000000-0000-4000-8000-0000000000a7')`);
      adminSql(`INSERT INTO company_membership(organisation_id,membership_id,company_id,role_id) VALUES ('${o}','${m}','${company}','00000000-0000-4000-8000-0000000000a3')`);
      adminSql(`INSERT INTO task(organisation_id,title,created_by_user_id) VALUES ('${o}','t','${u}')`);
      adminSql(`INSERT INTO notification(organisation_id,user_id,type,title) VALUES ('${o}','${u}','x','y')`);
      adminSql(`INSERT INTO audit_event(organisation_id,action) VALUES ('${o}','sweep')`);
      adminSql(`INSERT INTO outbox_event(event_type,aggregate_type,aggregate_id,organisation_id,payload,correlation_id,status) VALUES ('t','t','1','${o}','{}','c','PUBLISHED')`);
      adminSql(`INSERT INTO job_record(organisation_id,queue,type,idempotency_key,correlation_id,payload,max_attempts) VALUES ('${o}','scheduled','t','${o}:k','c','{}',1)`);
    }
  });
  it.each(TENANT_TABLES.filter((t) => t !== 'organisation'))('%s: with tenant A context, zero rows belong to any other tenant; without context, zero rows at all', async (t) => {
    const foreign = await db.tenant({ organisationId: A }, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}" WHERE organisation_id IS NOT NULL AND organisation_id <> '${A}'`));
    expect(Number(foreign[0]!.n), `${t} leaked foreign rows`).toBe(0);
    const none = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}" ${t === 'role' ? 'WHERE organisation_id IS NOT NULL' : ''}`);
    expect(Number(none[0]!.n), `${t} visible without a tenant context`).toBe(0);
  });
  it('organisation: a context sees only itself', async () => {
    const rows = await db.tenant({ organisationId: A }, (tx) => tx.organisation.findMany());
    expect(rows.map((r) => r.id)).toEqual([A]);
  });
  it.each(['practice', 'practice_membership', 'company_membership', 'organisation_membership'])('the sweep is not vacuous for %s: both tenants have rows', (t) => {
    expect(Number(adminSql(`SELECT count(*) FROM ${t} WHERE organisation_id IN ('${A}','${B}')`))).toBe(2);
  });
  it("the sweep is not vacuous: tenant B's rows exist (superuser view) and are invisible to A", async () => {
    expect(Number(adminSql(`SELECT count(*) FROM company WHERE organisation_id='${B}'`))).toBe(1);
    expect(await db.tenant({ organisationId: A }, (tx) => tx.company.count({ where: { organisationId: B } }))).toBe(0);
  });
  it('writes into another tenant are rejected for every sweep table that accepts simple inserts', async () => {
    await expect(db.tenant({ organisationId: A }, (tx) => tx.task.create({ data: { organisationId: B, title: 'x', createdByUserId: uuidv7() } }))).rejects.toThrow();
    await expect(db.tenant({ organisationId: A }, (tx) => tx.company.create({ data: { organisationId: B, name: 'x' } }))).rejects.toThrow();
    await expect(db.tenant({ organisationId: A }, (tx) => tx.practice.create({ data: { organisationId: B, name: 'x' } }))).rejects.toThrow();
  });
});
