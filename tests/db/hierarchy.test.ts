import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** Database-level guarantees behind the ownership model: they hold even if application code is wrong. */
let db: Database;
const A = uuidv7(), B = uuidv7(), BIZ = uuidv7();
let pA: string, pB: string, cA: string, cB: string, mA: string, mB: string, userA: string, userB: string;
const OWNER = '00000000-0000-4000-8000-0000000000a1', PARTNER = '00000000-0000-4000-8000-0000000000a7';
const e = (sql: string) => adminSql(sql);
const first = (sql: string) => e(sql).split('\n')[0]!;

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  userA = first(`INSERT INTO "user"(email, display_name) VALUES ('ha-${A}@t.test','A') RETURNING id`);
  userB = first(`INSERT INTO "user"(email, display_name) VALUES ('hb-${B}@t.test','B') RETURNING id`);
  e(`INSERT INTO organisation(id,type,name) VALUES ('${A}','PRACTICE','Firm A'),('${B}','PRACTICE','Firm B'),('${BIZ}','BUSINESS','Direct')`);
  pA = first(`INSERT INTO practice(organisation_id,name) VALUES ('${A}','P A') RETURNING id`);
  pB = first(`INSERT INTO practice(organisation_id,name) VALUES ('${B}','P B') RETURNING id`);
  cA = first(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${A}','C A','${pA}') RETURNING id`);
  cB = first(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${B}','C B','${pB}') RETURNING id`);
  mA = first(`INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('${A}','${userA}','${OWNER}') RETURNING id`);
  mB = first(`INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('${B}','${userB}','${OWNER}') RETURNING id`);
});
afterAll(() => db.close());

describe('ownership integrity (one canonical owner, no inconsistent duplicates)', () => {
  it('a company of a PRACTICE organisation must name a managing practice', () => {
    expect(() => e(`INSERT INTO company(organisation_id,name) VALUES ('${A}','No practice')`)).toThrow(/must have a managing practice/);
  });
  it('a company of a BUSINESS organisation cannot have a practice, and a BUSINESS organisation cannot have practices', () => {
    expect(() => e(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${BIZ}','x','${pA}')`)).toThrow();
    expect(() => e(`INSERT INTO practice(organisation_id,name) VALUES ('${BIZ}','Fake')`)).toThrow(/only practice organisations/);
    e(`INSERT INTO company(organisation_id,name) VALUES ('${BIZ}','Direct Co')`);
    expect(e(`SELECT count(*) FROM company WHERE organisation_id='${BIZ}' AND practice_id IS NULL`)).toBe('1');
  });
  it('a company cannot be managed by a practice of a different organisation (composite foreign key)', () => {
    expect(() => e(`INSERT INTO company(organisation_id,name,practice_id) VALUES ('${A}','Smuggled','${pB}')`)).toThrow(/foreign key/);
    expect(() => e(`UPDATE company SET practice_id='${pB}' WHERE id='${cA}'`)).toThrow(/foreign key/);
  });
  it('organisation.type is immutable (mode cannot drift away from its practices/companies)', () => {
    expect(() => e(`UPDATE organisation SET type='BUSINESS' WHERE id='${A}'`)).toThrow(/immutable/);
  });
  it('practice names are unique within an organisation but may repeat across organisations', () => {
    expect(() => e(`INSERT INTO practice(organisation_id,name) VALUES ('${A}','P A')`)).toThrow(/unique|duplicate/i);
    e(`INSERT INTO practice(organisation_id,name) VALUES ('${B}','P A')`);
  });
  it('a practice with companies cannot be deleted (restrict)', () => {
    expect(() => e(`DELETE FROM practice WHERE id='${pA}'`)).toThrow(/foreign key|violates/);
  });
});

describe('membership levels are structurally tenant-safe', () => {
  it('practice_membership: practice, member and role must all belong to the same organisation', () => {
    expect(() => e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pB}','${mA}','${PARTNER}')`)).toThrow(/foreign key/);
    expect(() => e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pA}','${mB}','${PARTNER}')`)).toThrow(/foreign key/);
    const foreignRole = first(`INSERT INTO "role"(organisation_id,key,name,permissions) VALUES ('${B}','b_only','B only','{}') RETURNING id`);
    expect(() => e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pA}','${mA}','${foreignRole}')`)).toThrow(/different organisation/);
    e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pA}','${mA}','${PARTNER}')`);
    expect(() => e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pA}','${mA}','${PARTNER}')`)).toThrow(/unique|duplicate/i);
  });
  it('company_membership: company, member and role must belong to the same organisation; a role is mandatory', () => {
    expect(() => e(`INSERT INTO company_membership(organisation_id,membership_id,company_id,role_id) VALUES ('${A}','${mA}','${cB}','${PARTNER}')`)).toThrow(/foreign key/);
    expect(() => e(`INSERT INTO company_membership(organisation_id,membership_id,company_id) VALUES ('${A}','${mA}','${cA}')`)).toThrow(/role not found|null value|not-null/i);
    const foreignRole = first(`SELECT id FROM "role" WHERE key='b_only'`);
    expect(() => e(`INSERT INTO company_membership(organisation_id,membership_id,company_id,role_id) VALUES ('${A}','${mA}','${cA}','${foreignRole}')`)).toThrow(/different organisation/);
    e(`INSERT INTO company_membership(organisation_id,membership_id,company_id,role_id) VALUES ('${A}','${mA}','${cA}','${PARTNER}')`);
  });
  it('deleting a company or a membership cascades its grants', () => {
    const u = first(`INSERT INTO "user"(email, display_name) VALUES ('hc-${A}@t.test','C') RETURNING id`);
    const m = first(`INSERT INTO organisation_membership(organisation_id,user_id,role_id) VALUES ('${A}','${u}','${OWNER}') RETURNING id`);
    e(`INSERT INTO practice_membership(organisation_id,practice_id,membership_id,role_id) VALUES ('${A}','${pA}','${m}','${PARTNER}')`);
    e(`INSERT INTO company_membership(organisation_id,membership_id,company_id,role_id) VALUES ('${A}','${m}','${cA}','${PARTNER}')`);
    e(`DELETE FROM organisation_membership WHERE id='${m}'`);
    expect(e(`SELECT (SELECT count(*) FROM practice_membership WHERE membership_id='${m}') + (SELECT count(*) FROM company_membership WHERE membership_id='${m}')`)).toBe('0');
  });
});

describe('row-level security on the new tables (runtime role)', () => {
  it.each(['practice', 'practice_membership', 'company_membership'])('%s: no context => no rows; tenant A never sees B', async (t) => {
    expect(Number((await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${t}`))[0]!.n)).toBe(0);
    const foreign = await db.tenant({ organisationId: A }, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${t} WHERE organisation_id <> '${A}'`));
    expect(Number(foreign[0]!.n)).toBe(0);
  });
  it('tenant A cannot create or change practices or grants for tenant B', async () => {
    await expect(db.tenant({ organisationId: A }, (tx) => tx.practice.create({ data: { organisationId: B, name: 'Hostile' } }))).rejects.toThrow();
    expect(await db.tenant({ organisationId: A }, (tx) => tx.practice.updateMany({ data: { name: 'Hacked' } , where: { id: pB } }))).toEqual({ count: 0 });
    expect(await db.tenant({ organisationId: A }, (tx) => tx.companyMembership.deleteMany({ where: { companyId: cB } }))).toEqual({ count: 0 });
  });
  it('the runtime role cannot disable the guarantees (no DDL, not an owner)', async () => {
    await expect(db.prisma.$executeRawUnsafe(`ALTER TABLE practice DISABLE ROW LEVEL SECURITY`)).rejects.toThrow();
    await expect(db.prisma.$executeRawUnsafe(`ALTER TABLE company DISABLE TRIGGER company_practice_rule_trg`)).rejects.toThrow();
  });
});

describe('workflow and AI constraints', () => {
  it('workflow history stays append-only including the new columns', () => {
    const w = first(`INSERT INTO workflow_instance(organisation_id,type,definition_version,state,subject_type,subject_id,started_by_user_id) VALUES ('${A}','standard_workflow',1,'DRAFT','t','1','${userA}') RETURNING id`);
    e(`INSERT INTO workflow_transition(organisation_id,instance_id,to_state,action,evidence_document_ids) VALUES ('${A}','${w}','DRAFT','start','{}')`);
    expect(() => e(`UPDATE workflow_transition SET evidence_document_ids=ARRAY['${uuidv7()}']::uuid[] WHERE instance_id='${w}'`)).toThrow(/append-only/);
  });
  it('an AI proposal can only be marked applied when ACCEPTED and by a named human; confidence stays within 0..1', () => {
    const p = first(`INSERT INTO ai_proposal(organisation_id,kind,payload) VALUES ('${A}','k','{}') RETURNING id`);
    expect(() => e(`UPDATE ai_proposal SET applied_at=now(), applied_by_user_id='${userA}' WHERE id='${p}'`)).toThrow(/ai_proposal_applied_ck/);
    e(`UPDATE ai_proposal SET status='ACCEPTED' WHERE id='${p}'`);
    expect(() => e(`UPDATE ai_proposal SET applied_at=now() WHERE id='${p}'`)).toThrow(/ai_proposal_applied_ck/);
    e(`UPDATE ai_proposal SET applied_at=now(), applied_by_user_id='${userA}', applied_reference='x' WHERE id='${p}'`);
    expect(() => e(`UPDATE ai_proposal SET confidence=1.5 WHERE id='${p}'`)).toThrow(/ai_proposal_confidence_ck/);
  });
});
