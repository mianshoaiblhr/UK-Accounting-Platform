import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, JournalRequestService, LedgerPolicyService, PostingService, type EffectivePolicy, type RequestActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/** V1-M2 service-level rules that the API tests do not reach: AI actors, forged requests, policy arithmetic, direct posting. */
let db: Database;
let org: string, requester: string, approver: string, co: string, evidence: string;
const acc: Record<string, string> = {};
const posting = new PostingService();
const policies = new LedgerPolicyService();
const requests = new JournalRequestService(posting, policies);
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: requester }, fn);
const person = (userId: string, can: (p: string) => boolean = () => true): RequestActor => ({ kind: 'USER', userId, can });
const lines = (n = '100') => [{ accountId: acc['1100']!, debit: n, credit: '0' }, { accountId: acc['3000']!, debit: '0', credit: n }];
const base = () => ({ organisationId: org, companyId: co, kind: 'CONTROL_ADJUSTMENT' as const, journalDate: '2026-03-31', description: 'Service level', reason: 'A sufficiently long reason for tests', lines: lines(), evidenceDocumentIds: [evidence] });

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  requester = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('lrq-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  approver = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('lra-${org}@t.test','A') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Requests svc')`);
  co = adminSql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','A') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','2026-01-01','2026-12-31')`);
  evidence = adminSql(`INSERT INTO document(organisation_id,company_id,name,created_by_user_id) VALUES ('${org}','${co}','e.pdf','${requester}') RETURNING id`).split('\n')[0]!;
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: requester }))).items) acc[a.code] = a.id;
});
afterAll(() => db.close());

describe('AI never requests, approves or posts accounting entries', () => {
  const ai: RequestActor = { kind: 'AI', userId: requester, can: () => true };
  it('create / approve / reject are refused for an AI actor, and PostingService refuses it directly', async () => {
    await expect(t((tx) => requests.create(tx, { ...base(), actor: ai }))).rejects.toMatchObject({ code: 'ai_cannot_post' });
    const r = await t((tx) => requests.create(tx, { ...base(), actor: person(requester) }));
    await expect(t((tx) => requests.approve(tx, { organisationId: org, companyId: co, requestId: r.id, actor: { ...ai, userId: approver } }))).rejects.toMatchObject({ code: 'ai_cannot_post' });
    await expect(t((tx) => requests.reject(tx, { organisationId: org, companyId: co, requestId: r.id, actor: { ...ai, userId: approver }, reason: 'x' }))).rejects.toMatchObject({ code: 'ai_cannot_post' });
    await expect(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-03-31', sourceType: 'CONTROL_ADJUSTMENT', sourceId: r.id, description: 'x', lines: lines(), idempotencyKey: 'ai-1', actor: ai }))).rejects.toMatchObject({ code: 'ai_cannot_post' });
    expect(adminSql(`SELECT count(*) FROM journal WHERE company_id='${co}'`)).toBe('0');
  });
});

describe('the PostingService refuses request-based sources without a valid request', () => {
  it('no request, a forged self-approval, and a permission-less approver', async () => {
    const direct = { organisationId: org, companyId: co, journalDate: '2026-03-31', sourceType: 'CONTROL_ADJUSTMENT', sourceId: uuidv7(), description: 'x', lines: lines(), actor: person(approver) };
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-1' }))).rejects.toMatchObject({ code: 'request_required' });
    const req = { id: direct.sourceId, requestedByUserId: requester, selfApproved: false };
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-2', actor: person(requester), request: req }))).rejects.toMatchObject({ code: 'self_approval_not_allowed' });
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-3', actor: person(approver, (p) => p !== 'ledger:approve'), request: req }))).rejects.toMatchObject({ code: 'permission_denied' });
    // a MANUAL journal cannot carry a request, and a request-based source needs the request as its source
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-4', sourceType: 'MANUAL', sourceId: undefined, request: req }))).rejects.toMatchObject({ code: 'source_reference_invalid' });
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-5', sourceId: uuidv7(), request: req }))).rejects.toMatchObject({ code: 'source_reference_invalid' });
    // a real posting for a request id that does not exist is stopped by the database
    await expect(t((tx) => posting.post(tx, { ...direct, idempotencyKey: 'd-6', request: req }))).rejects.toThrow(/does not match a pending journal request|foreign key/);
    expect(adminSql(`SELECT count(*) FROM journal WHERE company_id='${co}'`)).toBe('0');
  });
});

describe('approval policy arithmetic', () => {
  const pol = (o: Partial<{ openingBalanceApproval: 'ALWAYS' | 'ABOVE_THRESHOLD'; controlAdjustmentApproval: 'ALWAYS' | 'ABOVE_THRESHOLD'; materialityThreshold: string | null }>): EffectivePolicy =>
    ({ openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14, isDefault: false, updatedAt: null, updatedByUserId: null, ...o });
  it('ALWAYS requires approval at any amount; ABOVE_THRESHOLD is strictly greater-than, per kind', () => {
    expect(JournalRequestService.approvalRequired(pol({}), 'OPENING_BALANCE', '0.01')).toBe(true);
    const p = pol({ openingBalanceApproval: 'ABOVE_THRESHOLD', materialityThreshold: '1000.00' });
    expect(JournalRequestService.approvalRequired(p, 'OPENING_BALANCE', '999.99')).toBe(false);
    expect(JournalRequestService.approvalRequired(p, 'OPENING_BALANCE', '1000.00')).toBe(false);
    expect(JournalRequestService.approvalRequired(p, 'OPENING_BALANCE', '1000.01')).toBe(true);
    expect(JournalRequestService.approvalRequired(p, 'CONTROL_ADJUSTMENT', '0.01')).toBe(true);        // the other kind is still ALWAYS
  });
  it('a threshold of null with ABOVE_THRESHOLD fails safe (approval required)', () => {
    expect(JournalRequestService.approvalRequired(pol({ controlAdjustmentApproval: 'ABOVE_THRESHOLD' }), 'CONTROL_ADJUSTMENT', '1')).toBe(true);
  });
  it('setting a policy needs ledger:policy and a reason, and rejects AI', async () => {
    const set = (actor: RequestActor, reason = 'Agreed with the board for FY26') => t((tx) => policies.set(tx, { organisationId: org, companyId: co, actor, openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ALWAYS', materialityThreshold: null, requestExpiryDays: 14, reason }));
    await expect(set(person(requester, () => false))).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(set(person(requester), 'short')).rejects.toMatchObject({ code: 'reason_required' });
    await expect(set({ kind: 'AI', userId: requester, can: () => true })).rejects.toMatchObject({ code: 'ai_cannot_post' });
    expect((await set(person(requester))).isDefault).toBe(false);
  });
});
