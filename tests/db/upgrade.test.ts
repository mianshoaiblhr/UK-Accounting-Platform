import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@uk/contracts';

/**
 * Migration guarantees that need a database built the way production builds it:
 *  1. every migration applies from scratch as a NON-superuser table owner (RDS-style `uk_migrator`): FORCE ROW LEVEL SECURITY
 *     applies to owners, so data statements must not silently skip or fail;
 *  2. the architecture change set upgrades a POPULATED pre-change database without losing or corrupting data.
 */
const HOST = process.env.TEST_PG_HOST ?? 'localhost:5432';
const ADMIN = process.env.TEST_PG_ADMIN ?? 'postgres';
const adminUrl = (db: string) => `postgresql://${ADMIN}@${HOST}/${db}`;
const psql = (url: string, sql: string) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = resolve(ROOT, 'packages/db/prisma/migrations');
const all = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const CHANGE_SET = all.filter((d) => d >= '20260103' && d < '20260104');
const UP_TO_CHANGE_SET = all.filter((d) => d < '20260104'); // later migrations are covered by their own tests
const BEFORE = all.filter((d) => d < '20260103');
const deploy = (schema: string, url: string) =>
  execFileSync('pnpm', ['--filter', '@uk/db', 'exec', 'prisma', 'migrate', 'deploy', '--schema', schema], { cwd: ROOT, env: { ...process.env, MIGRATION_DATABASE_URL: url }, stdio: 'pipe' });

let tmp: string;
const dbs = ['uk_upgrade_nonsu', 'uk_upgrade_data', 'uk_upgrade_tasks'];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uk-mig-'));
  psql(adminUrl('postgres'), "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='uk_migrator_t') THEN CREATE ROLE uk_migrator_t LOGIN PASSWORD 'm' NOSUPERUSER NOBYPASSRLS CREATEROLE; END IF; END $$");
  for (const d of dbs) { psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); psql(adminUrl('postgres'), `CREATE DATABASE ${d} OWNER uk_migrator_t`); }
  psql(adminUrl('uk_upgrade_nonsu'), 'GRANT ALL ON SCHEMA public TO uk_migrator_t; CREATE EXTENSION IF NOT EXISTS btree_gist');
  psql(adminUrl('uk_upgrade_tasks'), 'GRANT ALL ON SCHEMA public TO uk_migrator_t; CREATE EXTENSION IF NOT EXISTS btree_gist');
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const d of dbs) psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
});

function stage(name: string, migrations: string[]) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  cpSync(resolve(MIGRATIONS, '../schema.prisma'), join(dir, 'schema.prisma'));
  writeFileSync(join(dir, 'migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  for (const m of migrations) cpSync(join(MIGRATIONS, m), join(dir, 'migrations', m), { recursive: true });
  return join(dir, 'schema.prisma');
}

describe('migrations as a non-superuser owner (production model)', () => {
  it('apply from scratch and leave the system roles exactly as @uk/contracts defines them', () => {
    deploy(stage('nonsu', all), 'postgresql://uk_migrator_t:m@' + HOST + '/uk_upgrade_nonsu');
    const rows = psql(adminUrl('uk_upgrade_nonsu'), `SELECT key||'='||array_to_string(ARRAY(SELECT unnest(permissions) ORDER BY 1), ',') FROM role WHERE organisation_id IS NULL ORDER BY key`).split('\n');
    const expected = SYSTEM_ROLES.map((r) => `${r.key}=${[...r.permissions].sort().join(',')}`).sort();
    expect(rows.sort()).toEqual(expected);
    // FORCE ROW LEVEL SECURITY is back on every tenant table after the migrations that temporarily lifted it
    expect(psql(adminUrl('uk_upgrade_nonsu'), `SELECT string_agg(relname, ',') FROM pg_class WHERE relkind='r' AND relname IN ('role','organisation','company','organisation_membership','company_membership','ai_proposal','ai_run') AND NOT relforcerowsecurity`)).toBe('');
  }, 180_000);
});

describe('architecture change set upgrades a populated database without data loss', () => {
  const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
  const ORG_P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const M1 = 'c1111111-1111-4111-8111-111111111111', M2 = 'c2222222-2222-4222-8222-222222222222';
  const C1 = 'd1111111-1111-4111-8111-111111111111', C2 = 'd2222222-2222-4222-8222-222222222222', C3 = 'd3333333-3333-4333-8333-333333333333';
  const url = adminUrl('uk_upgrade_data');
  it('maps practices, memberships, company assignments and AI proposal states', () => {
    deploy(stage('before', BEFORE), 'postgresql://uk_migrator_t:m@' + HOST + '/uk_upgrade_data');
    psql(url, `
      INSERT INTO "user"(id,email,display_name) VALUES ('${U1}','a@x.com','A'),('${U2}','b@x.com','B');
      INSERT INTO organisation(id,type,name) VALUES ('${ORG_P}','PRACTICE','Smith & Co'),('${ORG_B}','BUSINESS','Solo Ltd');
      INSERT INTO membership(id,organisation_id,user_id,role_id,company_scope) VALUES
        ('${M1}','${ORG_P}','${U1}','00000000-0000-4000-8000-0000000000a1','ALL'),
        ('${M2}','${ORG_P}','${U2}','00000000-0000-4000-8000-0000000000a3','ASSIGNED');
      INSERT INTO company(id,organisation_id,name,company_number) VALUES ('${C1}','${ORG_P}','Client 1','AAAA0001'),('${C2}','${ORG_P}','Client 2',NULL),('${C3}','${ORG_B}','Solo Co',NULL);
      INSERT INTO accounting_period(organisation_id,company_id,start_date,end_date) VALUES ('${ORG_P}','${C1}','2025-04-01','2026-03-31');
      INSERT INTO company_assignment(organisation_id,membership_id,company_id) VALUES ('${ORG_P}','${M2}','${C1}');
      INSERT INTO ai_proposal(id,organisation_id,kind,payload,status) VALUES
        ('e1111111-1111-4111-8111-111111111111','${ORG_P}','x','{}','PENDING_REVIEW'),('e2222222-2222-4222-8222-222222222222','${ORG_P}','x','{}','APPROVED'),('e3333333-3333-4333-8333-333333333333','${ORG_P}','x','{}','REJECTED');
      INSERT INTO workflow_instance(organisation_id,type,definition_version,state,subject_type,subject_id,started_by_user_id) VALUES ('${ORG_P}','ai_proposal_review',1,'PENDING_REVIEW','ai_proposal','e1111111-1111-4111-8111-111111111111','${U1}');`);
    const before = psql(url, `SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM accounting_period)||','||(SELECT count(*) FROM membership)||','||(SELECT count(*) FROM workflow_instance)`);

    // The production runner refuses the destructive-approved change set without a verified backup id, and applies it with one.
    const migrator = 'postgresql://uk_migrator_t:m@' + HOST + '/uk_upgrade_data';
    const runner = (extra: Record<string, string>) => execFileSync('bash', ['infra/db/migrate.sh'], { cwd: ROOT, env: { ...process.env, MIGRATION_DATABASE_URL: migrator, ...extra }, stdio: 'pipe' });
    expect(() => runner({})).toThrow(/BACKUP_SNAPSHOT_ID/);
    expect(() => psql(url, 'SELECT 1 FROM practice')).toThrow(/does not exist/); // refused BEFORE anything was applied
    runner({ BACKUP_SNAPSHOT_ID: 'snap-test-0001' });
    expect(CHANGE_SET.length).toBeGreaterThanOrEqual(2);

    // nothing lost
    expect(psql(url, `SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM accounting_period)||','||(SELECT count(*) FROM organisation_membership)||','||(SELECT count(*) FROM workflow_instance)`)).toBe(before);
    // PRACTICE organisation got exactly one default practice named after it; its companies are linked; the BUSINESS one has none
    expect(psql(url, `SELECT name FROM practice WHERE organisation_id='${ORG_P}'`)).toBe('Smith & Co');
    expect(psql(url, `SELECT count(*) FROM practice WHERE organisation_id='${ORG_B}'`)).toBe('0');
    expect(psql(url, `SELECT count(*) FROM company WHERE organisation_id='${ORG_P}' AND practice_id IS NOT NULL`)).toBe('2');
    expect(psql(url, `SELECT count(*) FROM company WHERE organisation_id='${ORG_B}' AND practice_id IS NULL`)).toBe('1');
    // assignments became company memberships carrying the member's role
    expect(psql(url, `SELECT r.key FROM company_membership cm JOIN role r ON r.id=cm.role_id WHERE cm.membership_id='${M2}' AND cm.company_id='${C1}'`)).toBe('accountant');
    // AI states mapped; legacy workflow instance preserved at its own version
    expect(psql(url, `SELECT string_agg(status::text, ',' ORDER BY id) FROM ai_proposal`)).toBe('SUGGESTED,ACCEPTED,REJECTED');
    expect(psql(url, `SELECT definition_version||':'||state FROM workflow_instance`)).toBe('1:PENDING_REVIEW');
    // new integrity rules are live on migrated data
    expect(() => psql(url, `INSERT INTO company(organisation_id,name) VALUES ('${ORG_P}','no practice')`)).toThrow(/managing practice/);
    // rows are still protected after the upgrade
    expect(psql(url, `SELECT bool_and(relforcerowsecurity)::text FROM pg_class WHERE relname IN ('practice','practice_membership','company_membership','organisation_membership','company','role')`)).toBe('true');
  }, 240_000);
});

describe('task engine migration upgrades a populated database', () => {
  const U = '11111111-1111-4111-8111-111111111111', ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CO = 'd1111111-1111-4111-8111-111111111111';
  const T_OPEN = 'e1111111-1111-4111-8111-111111111111', T_DONE = 'e2222222-2222-4222-8222-222222222222';
  const url = adminUrl('uk_upgrade_tasks'), owner = 'postgresql://uk_migrator_t:m@' + HOST + '/uk_upgrade_tasks';
  it('keeps existing tasks (source MANUAL, no reviewer), and their company link now has a composite foreign key', () => {
    const TASK_MIGRATION = all.find((d) => d.endsWith('_v0_task_engine'))!;
    deploy(stage('pre-task', all.filter((d) => d < TASK_MIGRATION)), owner);
    psql(url, `
      INSERT INTO "user"(id,email,display_name) VALUES ('${U}','t@x.com','T');
      INSERT INTO organisation(id,type,name) VALUES ('${ORG}','BUSINESS','Task Upgrade Ltd');
      INSERT INTO company(id,organisation_id,name) VALUES ('${CO}','${ORG}','Upgrade Co');
      INSERT INTO task(id,organisation_id,company_id,title,status,created_by_user_id) VALUES ('${T_OPEN}','${ORG}','${CO}','open one','IN_PROGRESS','${U}');
      INSERT INTO task(id,organisation_id,title,status,created_by_user_id,completed_at) VALUES ('${T_DONE}','${ORG}','done one','DONE','${U}', now());`);
    deploy(stage('with-task', all), owner);
    expect(psql(url, `SELECT string_agg(id::text||':'||status::text||':'||source||':'||coalesce(reviewer_user_id::text,'-'), ',' ORDER BY title) FROM task`))
      .toBe(`${T_DONE}:DONE:MANUAL:-,${T_OPEN}:IN_PROGRESS:MANUAL:-`);
    expect(psql(url, `SELECT count(*) FROM pg_constraint WHERE conname='task_organisation_id_company_id_fkey'`)).toBe('1');
    // the new status value is usable now that the migration is committed
    psql(url, `UPDATE task SET status='IN_REVIEW', reviewer_user_id='${U}' WHERE id='${T_OPEN}'`);
  });
});

describe('the architecture change set is reversible (documented rollback script)', () => {
  /** A structural fingerprint: columns, indexes, constraints, policies, triggers, functions, enums, role permissions. */
  const fingerprint = (url: string) => psql(url, `
    SELECT x FROM (
      SELECT 'col '||table_name||'.'||column_name||' '||data_type||' '||udt_name||' '||is_nullable||' '||coalesce(column_default,'') AS x FROM information_schema.columns WHERE table_schema='public' AND table_name <> '_prisma_migrations'
      UNION ALL SELECT 'idx '||indexname||' '||regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ', '') FROM pg_indexes WHERE schemaname='public' AND tablename <> '_prisma_migrations'
      UNION ALL SELECT 'con '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text <> '_prisma_migrations'
      UNION ALL SELECT 'pol '||tablename||' '||policyname||' '||cmd FROM pg_policies WHERE schemaname='public'
      UNION ALL SELECT 'trg '||event_object_table||' '||trigger_name FROM information_schema.triggers WHERE trigger_schema='public' AND event_object_table <> '_prisma_migrations'
      UNION ALL SELECT 'fn '||proname FROM pg_proc WHERE pronamespace='public'::regnamespace
      UNION ALL SELECT 'enum '||t.typname||' '||string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY t.typname
      UNION ALL SELECT 'force '||relname||' '||relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations'
      UNION ALL SELECT 'role '||key||' '||array_to_string(ARRAY(SELECT unnest(permissions) ORDER BY 1), ',')||' '||description FROM "role" WHERE organisation_id IS NULL
    ) q ORDER BY x`);
  it('rolling back restores the previous schema exactly (tables, columns, constraints, policies, triggers, enums, system roles)', () => {
    for (const d of ['uk_rollback_old', 'uk_rollback_new']) { psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); psql(adminUrl('postgres'), `CREATE DATABASE ${d}`); }
    try {
      deploy(stage('rb-old', BEFORE), adminUrl('uk_rollback_old'));
      deploy(stage('rb-new', UP_TO_CHANGE_SET), adminUrl('uk_rollback_new'));
      expect(fingerprint(adminUrl('uk_rollback_new'))).not.toBe(fingerprint(adminUrl('uk_rollback_old')));
      execFileSync('psql', [adminUrl('uk_rollback_new'), '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', join(ROOT, 'docs/runbooks/rollback/20260103-architecture-change-set.down.sql')], { stdio: 'pipe' });
      expect(fingerprint(adminUrl('uk_rollback_new')).split('\n')).toEqual(fingerprint(adminUrl('uk_rollback_old')).split('\n'));
    } finally {
      for (const d of ['uk_rollback_old', 'uk_rollback_new']) psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    }
  }, 240_000);
  it('refuses to roll back while the new roles or practice memberships are in use', () => {
    const d = 'uk_rollback_guard';
    psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); psql(adminUrl('postgres'), `CREATE DATABASE ${d}`);
    try {
      deploy(stage('rb-guard', UP_TO_CHANGE_SET), adminUrl(d));
      psql(adminUrl(d), `INSERT INTO "user"(id,email,display_name) VALUES ('11111111-1111-4111-8111-111111111111','g@x.com','G');
        INSERT INTO organisation(id,type,name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','PRACTICE','G');
        INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','00000000-0000-4000-8000-0000000000a7')`);
      expect(() => execFileSync('psql', [adminUrl(d), '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', join(ROOT, 'docs/runbooks/rollback/20260103-architecture-change-set.down.sql')], { stdio: 'pipe' })).toThrow(/rollback refused/);
    } finally { psql(adminUrl('postgres'), `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); }
  }, 240_000);
});
