import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AccountService } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M2: the database enforces the approval rules even if application code is wrong or bypassed. Every statement runs as the RUNTIME role (uk_app)
 * in a tenant context; `flag` simulates code that sets the posting switch itself (the switch is application-asserted - the other guards are not).
 */
let db: Database;
let org: string, org2: string, requester: string, approver: string, co: string, co2: string, period: string;
const acc: Record<string, string> = {};
const sql = adminSql;
const tx = (statements: string[], o: { flag?: boolean; organisationId?: string; userId?: string } = {}) =>
  db.tenant({ organisationId: o.organisationId ?? org, userId: o.userId ?? requester }, async (t) => {
    if (o.flag) await t.$queryRawUnsafe(`SELECT set_config('app.posting','on',true)`);
    for (const s of statements) await t.$executeRawUnsafe(s);
  });
const lines = (total = '500') => JSON.stringify([{ accountId: acc['1100'], debit: total, credit: '0' }, { accountId: acc['3000'], debit: '0', credit: total }]);
const mkRequest = (id: string, o: { kind?: string; total?: string; date?: string; by?: string; expires?: string; approval?: boolean; self?: boolean; reason?: string; company?: string; org?: string } = {}) =>
  `INSERT INTO journal_request(id, organisation_id, company_id, kind, journal_date, description, reason, currency, lines, total, requested_by_user_id, expires_at, approval_required, self_approved, policy_snapshot, content_hash)
   VALUES ('${id}','${o.org ?? org}','${o.company ?? co}','${o.kind ?? 'OPENING_BALANCE'}','${o.date ?? '2026-01-01'}','db test request','${o.reason ?? 'A reason that is long enough'}','GBP','${lines(o.total)}'::jsonb,${o.total ?? '500'},'${o.by ?? requester}',
     ${o.expires ? `'${o.expires}'` : `now() + interval '14 days'`},${o.approval ?? true},${o.self ?? false},'{}'::jsonb,'h')`;
const mkJournal = (id: string, o: { request?: string | null; by?: string | null; approved?: string | null; source?: string; total?: string; date?: string } = {}) =>
  `INSERT INTO journal(id, organisation_id, company_id, period_id, journal_number, journal_date, source_type, source_id, description, currency, total, line_count, actor_type, posted_by_user_id, idempotency_key, content_hash, request_id, requested_by_user_id, approved_by_user_id)
   VALUES ('${id}','${org}','${co}','${period}',${Math.floor(1_000_000 + Math.random() * 8_000_000)},'${o.date ?? '2026-01-01'}','${o.source ?? 'OPENING_BALANCE'}',${o.request ? `'${o.request}'` : 'NULL'},'db test','GBP',${o.total ?? '500'},2,'USER','${approver}','k-${uuidv7()}','h',
     ${o.request ? `'${o.request}'` : 'NULL'},${o.by === null ? 'NULL' : `'${o.by ?? requester}'`},${o.approved === null ? 'NULL' : `'${o.approved ?? approver}'`})`;
const jlines = (j: string, total = '500') => [
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit) VALUES ('${org}','${co}','${j}',1,'${acc['1100']}',${total},0)`,
  `INSERT INTO journal_line(organisation_id, company_id, journal_id, line_no, account_id, debit, credit) VALUES ('${org}','${co}','${j}',2,'${acc['3000']}',0,${total})`];
const approve = (req: string, j: string, by = approver) => `UPDATE journal_request SET status='APPROVED', decided_by_user_id='${by}', decided_at=now(), posted_journal_id='${j}' WHERE id='${req}'`;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  requester = sql(`INSERT INTO "user"(email, display_name) VALUES ('lcr-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  approver = sql(`INSERT INTO "user"(email, display_name) VALUES ('lca-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Controls DB A'),('${org2}','BUSINESS','Controls DB B')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  co2 = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org2}','B') RETURNING id`).split('\n')[0]!;
  period = sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31') RETURNING id`).split('\n')[0]!;
  const chart = await db.tenant({ organisationId: org, userId: requester }, (t) => new AccountService().initialiseDefault(t, { organisationId: org, companyId: co, userId: requester }));
  for (const a of chart.items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('opening balances and control adjustments exist only through a request', () => {
  it('a journal of those sources without a request is refused, even with the posting switch', async () => {
    for (const source of ['OPENING_BALANCE', 'CONTROL_ADJUSTMENT']) {
      await expect(tx([mkJournal(uuidv7(), { source, request: null, by: null, approved: null }), ...[]], { flag: true })).rejects.toThrow(/need an approved journal request/);
    }
  });
  it('a journal must match a PENDING request: kind, company, total, date and requester', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    const bad = async (j: Parameters<typeof mkJournal>[1], re: RegExp) => expect(tx([mkJournal(uuidv7(), { request: r, ...j })], { flag: true })).rejects.toThrow(re);
    await bad({ source: 'CONTROL_ADJUSTMENT' }, /does not match a pending journal request/);
    await bad({ total: '501' }, /does not match a pending journal request/);
    await bad({ date: '2026-01-02' }, /does not match a pending journal request/);
    await bad({ by: approver }, /requester does not match/);
    await bad({ by: null, approved: null }, /need an approved journal request/);
  });
  it('second-person rule: the requester cannot be the approver (unless the policy exempted the request)', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    await expect(tx([mkJournal(uuidv7(), { request: r, approved: requester })], { flag: true })).rejects.toThrow(/cannot be approved by the person who made it/);
    const exempt = uuidv7();
    await tx([mkRequest(exempt, { approval: false, self: true })]);
    await expect(tx([mkJournal(uuidv7(), { request: exempt, approved: approver })], { flag: true })).rejects.toThrow(/policy-exempt request is posted by its requester/);
  });
  it('an expired request cannot be posted', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    sql(`SET session_replication_role = replica; UPDATE journal_request SET requested_at = now() - interval '20 days', expires_at = now() - interval '1 second' WHERE id='${r}'`);
    await expect(tx([mkJournal(uuidv7(), { request: r })], { flag: true })).rejects.toThrow(/has expired/);
  });
  it('the happy path commits journal, lines and the request status together; the request cannot be posted twice', async () => {
    const r = uuidv7(), j = uuidv7();
    await tx([mkRequest(r)]);
    await tx([mkJournal(j, { request: r }), ...jlines(j), approve(r, j)], { flag: true, userId: approver });
    expect(sql(`SELECT status||'|'||decided_by_user_id||'|'||posted_journal_id FROM journal_request WHERE id='${r}'`)).toBe(`APPROVED|${approver}|${j}`);
    await expect(tx([mkJournal(uuidv7(), { request: r }), ], { flag: true })).rejects.toThrow(/does not match a pending journal request|duplicate key|unique/i);
  });
  it('a request cannot be marked approved without the journal posted from it, nor by its requester', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    await expect(tx([approve(r, uuidv7())])).rejects.toThrow(/must point at the journal posted from it|violates foreign key/);
    const j = uuidv7();
    await expect(tx([mkJournal(j, { request: r }), ...jlines(j), approve(r, j, requester)], { flag: true })).rejects.toThrow(/cannot be approved by the person who made it|separation/);
    expect(sql(`SELECT status FROM journal_request WHERE id='${r}'`)).toBe('PENDING');
  });
});

describe('journal requests are append-and-decide only', () => {
  it('the proposed content never changes', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    for (const set of [`total=1`, `description='x'`, `reason='a different long enough reason'`, `journal_date='2026-02-01'`, `requested_by_user_id='${approver}'`, `expires_at=expires_at + interval '1 day'`, `approval_required=false`, `evidence_document_ids=ARRAY[gen_random_uuid()]`, `lines='[]'::jsonb`]) {
      await expect(tx([`UPDATE journal_request SET ${set} WHERE id='${r}'`])).rejects.toThrow();
    }
  });
  it('a decided request is final; status never returns to PENDING; rejection needs a reason; only the requester can cancel', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    await expect(tx([`UPDATE journal_request SET status='REJECTED', decided_by_user_id='${approver}', decided_at=now() WHERE id='${r}'`])).rejects.toThrow(/outcome|check/);                 // no reason
    await expect(tx([`UPDATE journal_request SET status='CANCELLED', decided_by_user_id='${approver}', decided_at=now() WHERE id='${r}'`])).rejects.toThrow(/cancel|check/);                  // not the requester
    await tx([`UPDATE journal_request SET status='REJECTED', decided_by_user_id='${approver}', decided_at=now(), decision_reason='No support' WHERE id='${r}'`]);
    await expect(tx([`UPDATE journal_request SET status='PENDING', decided_by_user_id=NULL, decided_at=NULL, decision_reason=NULL WHERE id='${r}'`])).rejects.toThrow(/final/);
    await expect(tx([`UPDATE journal_request SET decision_reason='edited' WHERE id='${r}'`])).rejects.toThrow(/final/);
  });
  it('shape checks: reason length, total, self-approval consistency, kind, status', async () => {
    await expect(tx([mkRequest(uuidv7(), { reason: 'short' })])).rejects.toThrow(/reason/);
    await expect(tx([mkRequest(uuidv7(), { total: '0' })])).rejects.toThrow();
    await expect(tx([mkRequest(uuidv7(), { approval: true, self: true })])).rejects.toThrow(/self/);
    await expect(tx([mkRequest(uuidv7(), { kind: 'MANUAL' })])).rejects.toThrow(/kind/);
  });
  it('nothing deletes or truncates requests: the runtime role has no privilege, and the table owner is stopped by a trigger', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    await expect(tx([`DELETE FROM journal_request WHERE id='${r}'`])).rejects.toThrow(/permission denied/);
    expect(() => sql(`DELETE FROM journal_request WHERE id='${r}'`)).toThrow(/append-only/);
    expect(() => sql(`TRUNCATE journal_request, journal, journal_line`)).toThrow(/append-only/);
  });
  it('tenant isolation: another organisation neither sees nor creates requests for this one', async () => {
    const r = uuidv7();
    await tx([mkRequest(r)]);
    const seen = await db.tenant({ organisationId: org2, userId: requester }, (t) => t.journalRequest.count({ where: { id: r } }));
    expect(seen).toBe(0);
    await expect(tx([mkRequest(uuidv7())], { organisationId: org2 })).rejects.toThrow();                     // WITH CHECK: row belongs to org, session is org2
    await expect(tx([mkRequest(uuidv7(), { org: org2, company: co })], { organisationId: org2 })).rejects.toThrow();   // company of another organisation
  });
});

describe('ledger policy', () => {
  const policy = (set: string, c = co, o = org) => `INSERT INTO ledger_policy(organisation_id, company_id${set ? ', ' + set.split('=')[0] : ''}) VALUES ('${o}','${c}'${set ? ', ' + set.split('=').slice(1).join('=') : ''})`;
  it('there is no way to configure "never": only ALWAYS or ABOVE_THRESHOLD, and a threshold is required for the latter', async () => {
    await expect(tx([policy(`opening_balance_approval='NEVER'`)])).rejects.toThrow(/modes/);
    await expect(tx([policy(`opening_balance_approval='ABOVE_THRESHOLD'`)])).rejects.toThrow(/threshold_needed/);
    await expect(tx([policy(`materiality_threshold=0`)])).rejects.toThrow(/threshold/);
    await expect(tx([policy(`request_expiry_days=0`)])).rejects.toThrow(/expiry/);
    await expect(tx([policy(`request_expiry_days=91`)])).rejects.toThrow(/expiry/);
  });
  it('tenant-scoped, company must belong to the organisation, never deleted by the runtime role', async () => {
    await expect(tx([policy('', co2, org)])).rejects.toThrow();
    await tx([policy('')]);
    expect(await db.tenant({ organisationId: org2, userId: requester }, (t) => t.ledgerPolicy.count())).toBe(0);
    await expect(tx([`DELETE FROM ledger_policy WHERE company_id='${co}'`])).rejects.toThrow(/permission denied/);
  });
});
