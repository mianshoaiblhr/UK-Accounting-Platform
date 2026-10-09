import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

let db: Database;
let org: string, org2: string, user: string, co: string, co2: string;
const q = (sql: string) => adminSql(sql);

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  q(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Doc DB A'),('${org2}','BUSINESS','Doc DB B')`);
  user = q(`INSERT INTO "user"(email, display_name) VALUES ('dd-${org}@t.test','U') RETURNING id`).split('\n')[0]!;
  co = q(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  co2 = q(`INSERT INTO company(organisation_id, name) VALUES ('${org2}','B') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('document types', () => {
  it('the database seed equals the @uk/contracts registry', () => {
    const rows = q(`SELECT code||'='||name FROM document_type ORDER BY code`).split('\n');
    expect(rows).toEqual(DOCUMENT_TYPES.map((t) => `${t.code}=${t.name}`).sort());
  });
  it('a document cannot carry an unknown type, and the runtime role cannot add types', async () => {
    expect(() => q(`INSERT INTO document(organisation_id, name, document_class, created_by_user_id) VALUES ('${org}','x','NOT_A_TYPE','${user}')`)).toThrow(/document_document_class_fkey/);
    await expect(db.system((tx) => tx.documentType.create({ data: { code: 'SNEAKY', name: 'x' } }))).rejects.toThrow(/permission denied/);
  });
});

describe('document columns and constraints', () => {
  const ins = (extra: string) => q(`INSERT INTO document(organisation_id, name, created_by_user_id${extra.split('|')[0]}) VALUES ('${org}','x','${user}'${extra.split('|')[1] ?? ''}) RETURNING id`);
  it('visibility, labels, description and metadata are bounded', () => {
    expect(() => ins(`, visibility|, 'SECRET'`)).toThrow(/document_visibility_ck/);
    expect(() => ins(`, labels|, ARRAY['a','b','c','d','e','f','g','h','i','j','k']`)).toThrow(/document_labels_ck/);
    expect(() => ins(`, metadata|, '[]'::jsonb`)).toThrow(/document_metadata_ck/);
    expect(() => ins(`, metadata|, jsonb_build_object('k', repeat('x', 9000))`)).toThrow(/document_metadata_ck/);
  });
  it('folder and period must belong to the document\'s own company; organisation-level documents cannot carry a period', () => {
    const f = q(`INSERT INTO document_folder(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${co}','F','${user}') RETURNING id`).split('\n')[0]!;
    const orgFolder = q(`INSERT INTO document_folder(organisation_id, name, created_by_user_id) VALUES ('${org}','Org level','${user}') RETURNING id`).split('\n')[0]!;
    const p = q(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2025-04-01','2026-03-31') RETURNING id`).split('\n')[0]!;
    q(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id, folder_id, period_id) VALUES ('${org}','${co}','ok','${user}','${f}','${p}')`);
    expect(() => q(`INSERT INTO document(organisation_id, name, created_by_user_id, folder_id) VALUES ('${org}','bad','${user}','${f}')`)).toThrow(/own company/);
    expect(() => q(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id, folder_id) VALUES ('${org}','${co}','bad','${user}','${orgFolder}')`)).toThrow(/own company/);
    expect(() => q(`INSERT INTO document(organisation_id, name, created_by_user_id, period_id) VALUES ('${org}','bad','${user}','${p}')`)).toThrow(/only company documents/);
    expect(() => q(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id, folder_id) VALUES ('${org2}','${co2}','bad','${user}','${f}')`)).toThrow(/foreign key|folder not found/); // another tenant's folder
  });
  it('the runtime role cannot delete documents (archive instead)', async () => {
    const id = q(`INSERT INTO document(organisation_id, name, created_by_user_id) VALUES ('${org}','keep','${user}') RETURNING id`).split('\n')[0]!;
    await expect(db.tenant({ organisationId: org, userId: user }, (tx) => tx.document.delete({ where: { id } }))).rejects.toThrow(/permission denied/);
  });
});

describe('folder tree and tenant isolation', () => {
  it('rejects cycles, depth > 8, a parent in another company and duplicate sibling names (case-insensitive)', () => {
    const mk = (name: string, parent?: string, company = co) => q(`INSERT INTO document_folder(organisation_id, company_id, parent_id, name, created_by_user_id) VALUES ('${org}','${company}',${parent ? `'${parent}'` : 'NULL'},'${name}','${user}') RETURNING id`).split('\n')[0]!;
    const root = mk('tree-root');
    let cur = root;
    for (let i = 0; i < 7; i++) cur = mk(`n${i}`, cur);
    expect(() => mk('too-deep', cur)).toThrow(/at most 8 levels/);
    expect(() => q(`UPDATE document_folder SET parent_id='${cur}' WHERE id='${root}'`)).toThrow(/itself or its own subfolder/);
    expect(() => mk('x', root, co2)).toThrow();
    expect(() => mk('TREE-ROOT')).toThrow(/document_folder_sibling_name_uq/);
    expect(() => q(`UPDATE document_folder SET name='a/b' WHERE id='${root}'`)).toThrow(/document_folder_name_ck/);
  });
  it('row-level security hides folders and access grants from other organisations', async () => {
    q(`INSERT INTO document_folder(organisation_id, name, created_by_user_id) VALUES ('${org}','visible only to A','${user}')`);
    expect(await db.tenant({ organisationId: org2 }, (tx) => tx.documentFolder.count({ where: { name: 'visible only to A' } }))).toBe(0);
    expect(await db.tenant({ organisationId: org }, (tx) => tx.documentFolder.count({ where: { name: 'visible only to A' } }))).toBe(1);
    expect(await db.prisma.documentFolder.count()).toBe(0);
  });
  it('access grants cannot be edited by the runtime role and need a document of the same organisation', async () => {
    const d = q(`INSERT INTO document(organisation_id, name, created_by_user_id, visibility) VALUES ('${org}','r','${user}','RESTRICTED') RETURNING id`).split('\n')[0]!;
    expect(() => q(`INSERT INTO document_access(organisation_id, document_id, user_id, granted_by_user_id) VALUES ('${org2}','${d}','${user}','${user}')`)).toThrow(/foreign key/);
    q(`INSERT INTO document_access(organisation_id, document_id, user_id, granted_by_user_id) VALUES ('${org}','${d}','${user}','${user}')`);
    await expect(db.tenant({ organisationId: org, userId: user }, (tx) => tx.documentAccess.updateMany({ where: { documentId: d }, data: { userId: uuidv7() } }))).rejects.toThrow(/permission denied/);
  });
});
