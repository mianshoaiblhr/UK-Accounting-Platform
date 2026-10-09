import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETENTION_CATEGORIES, RETENTION_RULES, DOCUMENT_TYPES } from '@uk/contracts';
import { loadConfig } from '@uk/core';
import { Database, TABLE_PROTECTION } from '@uk/db';
import { adminSql } from '../helpers/db';

/** ADR-39: retention is classified in reference data; the registry, the database and the table registry cannot drift apart. */
let db: Database;
beforeAll(() => { db = new Database(process.env.DATABASE_URL!); });
afterAll(() => db.close());
// sorted in JS on both sides: ORDER BY follows the database collation (en_US in CI puts '_' differently from a plain code-point sort)
const rows = (sql: string) => adminSql(sql).split('\n').filter(Boolean).sort();
const n = (v: number | null) => (v === null ? '' : String(v));

describe('retention reference tables', () => {
  it('the database seed equals the @uk/contracts registry (categories and rules)', () => {
    expect(rows(`SELECT code||'|'||name||'|'||kind||'|'||coalesce(period_years::text,'')||'|'||coalesce(period_days::text,'')||'|'||period_trigger||'|'||status||'|'||basis FROM retention_category ORDER BY code`))
      .toEqual(RETENTION_CATEGORIES.map((c) => `${c.code}|${c.name}|${c.kind}|${n(c.years)}|${n(c.days)}|${c.trigger}|${c.status}|${c.basis}`).sort());
    expect(rows(`SELECT subject_kind||'|'||subject||'|'||category_code FROM retention_rule ORDER BY 1`))
      .toEqual(RETENTION_RULES.map((r) => `${r.kind}|${r.subject}|${r.category}`).sort());
  });

  it('EVERY table in the database is classified, and nothing else is: a new table without a rule fails here', () => {
    const real = rows(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY 1`);
    const classified = rows(`SELECT subject FROM retention_rule WHERE subject_kind='TABLE' ORDER BY 1`);
    expect(classified).toEqual(real);
    expect(Object.keys(TABLE_PROTECTION).sort()).toEqual(real); // the protection registry and the retention rules describe the same set
  });

  it('every document type is classified (and only document types)', () => {
    expect(rows(`SELECT subject FROM retention_rule WHERE subject_kind='DOCUMENT_TYPE' ORDER BY 1`)).toEqual(rows(`SELECT code FROM document_type ORDER BY 1`));
    expect(rows(`SELECT code FROM document_type ORDER BY 1`)).toEqual(DOCUMENT_TYPES.map((t) => t.code).sort());
  });

  it('what the platform enforces today matches the classification (outbox cleanup window, filing-evidence default)', () => {
    expect(loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv).OUTBOX_RETENTION_DAYS).toBe(14);
    expect(RETENTION_CATEGORIES.find((c) => c.code === 'OPERATIONAL_EVENTS')?.days).toBe(14);
  });

  it('the database refuses a malformed category and a rule for an unknown category', () => {
    const ins = (cols: string) => adminSql(`INSERT INTO retention_category(code,name,kind,period_years,period_days,period_trigger,basis) VALUES (${cols})`);
    expect(() => ins(`'BAD_BOTH','x','PERIOD',1,1,'RECORD_CREATED','b'`)).toThrow(/period_ck/);
    expect(() => ins(`'BAD_NONE','x','PERIOD',NULL,NULL,'RECORD_CREATED','b'`)).toThrow(/period_ck/);
    expect(() => ins(`'BAD_ZERO','x','PERIOD',0,NULL,'RECORD_CREATED','b'`)).toThrow(/period_ck/);
    expect(() => ins(`'BAD_TRIG','x','PERIOD',1,NULL,'NOT_APPLICABLE','b'`)).toThrow(/period_ck/);
    expect(() => ins(`'BAD_ACTIVE','x','WHILE_ACTIVE',1,NULL,'NOT_APPLICABLE','b'`)).toThrow(/period_ck/);
    expect(() => ins(`'bad code','x','WHILE_ACTIVE',NULL,NULL,'NOT_APPLICABLE','b'`)).toThrow(/code_ck/);
    expect(() => ins(`'BAD_KIND','x','FOREVER',NULL,NULL,'NOT_APPLICABLE','b'`)).toThrow(/kind_ck/);
    expect(() => adminSql(`INSERT INTO retention_rule VALUES ('TABLE','x','NO_SUCH_CATEGORY')`)).toThrow(/category_code_fkey/);
    expect(() => adminSql(`DELETE FROM retention_category WHERE code='ACCOUNTING_RECORDS'`)).toThrow(/foreign key|violates/);
  });

  it('the runtime role can read the classification but never change it (changes ship as migrations)', async () => {
    expect(await db.system((tx) => tx.retentionCategory.count())).toBe(RETENTION_CATEGORIES.length);
    await expect(db.system((tx) => tx.retentionCategory.update({ where: { code: 'ACCOUNTING_RECORDS' }, data: { periodYears: 1 } }))).rejects.toThrow(/permission denied/);
    await expect(db.system((tx) => tx.retentionRule.create({ data: { subjectKind: 'TABLE', subject: 'x', categoryCode: 'WHILE_ACTIVE' } }))).rejects.toThrow(/permission denied/);
    await expect(db.system((tx) => tx.retentionRule.deleteMany({}))).rejects.toThrow(/permission denied/);
  });
});
