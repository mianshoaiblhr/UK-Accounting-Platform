import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { AiProposalService, WorkflowEngine, WorkflowRegistry, type Actor } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** D3: AI recommendations stay distinguishable from human decisions; nothing is applied by the AI path. */
let db: Database;
let org: string, human: string, human2: string;
const svc = () => new AiProposalService(new WorkflowEngine(new WorkflowRegistry()));
const decider = (id = human): Actor => ({ userId: id, permissions: new Set(['ai:approve']) });
const run = <T>(fn: (tx: import('@uk/db').Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: human }, fn);
const make = (extra: Record<string, unknown> = {}) => run((tx) => svc().create(tx, { organisationId: org, requestedByUserId: null, kind: 'categorise_document', payload: { summary: 's' }, ...extra }));
const fail = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  human = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('ai1-${org}@t.test','H') RETURNING id`).split('\n')[0]!;
  human2 = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('ai2-${org}@t.test','H2') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','AI Org')`);
});
afterAll(() => db.close());

describe('SUGGESTED → UNDER_REVIEW → ACCEPTED | REJECTED', () => {
  it('a new proposal is only a SUGGESTION, with provenance, and is attributed to no human decision', async () => {
    const doc = uuidv7();
    const p = await make({ provider: 'bedrock', model: 'm-1', promptVersion: 'categorise@3', confidence: 0.8731, sourceEvidence: [{ type: 'document', id: doc }] });
    expect(p).toMatchObject({ status: 'SUGGESTED', provider: 'bedrock', model: 'm-1', promptVersion: 'categorise@3', decidedByUserId: null, decidedAt: null, appliedAt: null });
    expect(Number(p.confidence)).toBeCloseTo(0.8731);
    expect(p.sourceEvidence).toEqual([{ type: 'document', id: doc }]);
  });
  it('acceptance needs an explicit human review step first (no silent transition)', async () => {
    const p = await make();
    expect(await fail(run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'ACCEPT', actor: decider() })))).toBe('invalid_transition');
    const r = await run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: p.id, actor: decider() }));
    expect(r).toMatchObject({ status: 'UNDER_REVIEW', reviewStartedByUserId: human });
    const done = await run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'ACCEPT', actor: decider(human2), comment: 'ok' }));
    expect(done).toMatchObject({ status: 'ACCEPTED', decidedByUserId: human2, decisionComment: 'ok', appliedAt: null });
    const hist = await run((tx) => tx.workflowTransition.findMany({ where: { instanceId: p.workflowInstanceId! }, orderBy: { occurredAt: 'asc' } }));
    expect(hist.map((h) => [h.action, h.toState, h.actorUserId])).toEqual([['start', 'SUGGESTED', '00000000-0000-0000-0000-000000000000'], ['begin_review', 'UNDER_REVIEW', human], ['accept', 'ACCEPTED', human2]]);
  });
  it('rejection is possible from SUGGESTED or UNDER_REVIEW and requires a reason', async () => {
    const a = await make(), b = await make();
    expect(await fail(run((tx) => svc().decide(tx, { organisationId: org, proposalId: a.id, decision: 'REJECT', actor: decider() })))).toBe('comment_required');
    expect((await run((tx) => svc().decide(tx, { organisationId: org, proposalId: a.id, decision: 'REJECT', actor: decider(), comment: 'wrong' }))).status).toBe('REJECTED');
    await run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: b.id, actor: decider() }));
    expect((await run((tx) => svc().decide(tx, { organisationId: org, proposalId: b.id, decision: 'REJECT', actor: decider(), comment: 'no' }))).status).toBe('REJECTED');
  });
  it('only a human holding ai:approve can move it forward; a finished proposal is final', async () => {
    const p = await make();
    const nobody: Actor = { userId: human, permissions: new Set(['ai:use']) };
    expect(await fail(run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: p.id, actor: nobody })))).toBe('permission_denied');
    await run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: p.id, actor: decider() }));
    await run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'ACCEPT', actor: decider() }));
    expect(await fail(run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'REJECT', actor: decider(), comment: 'x' })))).toBe('workflow_finished');
  });
});

describe('accepting is not applying', () => {
  it('ACCEPTED changes nothing else; application is recorded separately by the owning service and only for ACCEPTED proposals', async () => {
    const before = adminSql(`SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM document)||','||(SELECT count(*) FROM task)||','||(SELECT count(*) FROM accounting_period)`);
    const p = await make();
    expect(await fail(run((tx) => svc().recordApplication(tx, { proposalId: p.id, appliedByUserId: human, reference: 'journal:1' })))).toBe('proposal_not_accepted');
    await run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: p.id, actor: decider() }));
    await run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'ACCEPT', actor: decider() }));
    expect(adminSql(`SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM document)||','||(SELECT count(*) FROM task)||','||(SELECT count(*) FROM accounting_period)`)).toBe(before);
    const applied = await run((tx) => svc().recordApplication(tx, { proposalId: p.id, appliedByUserId: human2, reference: 'journal:1' }));
    expect(applied).toMatchObject({ status: 'ACCEPTED', appliedByUserId: human2, appliedReference: 'journal:1' });
    expect(applied.appliedAt).not.toBeNull();
    expect(await fail(run((tx) => svc().recordApplication(tx, { proposalId: p.id, appliedByUserId: human2, reference: 'again' })))).toBe('proposal_already_applied');
  });
  it('confidence outside 0..1 is rejected', async () => {
    expect(await fail(make({ confidence: 1.2 }))).toBe('invalid_confidence');
  });
  it('proposals created before the state-model change (legacy v1 workflow) can still be decided by a human', async () => {
    const p = await make();
    // Re-point the proposal at a legacy v1 instance, as migrated data would be
    const legacy = adminSql(`INSERT INTO workflow_instance(organisation_id,type,definition_version,state,subject_type,subject_id,started_by_user_id) VALUES ('${org}','ai_proposal_review',1,'PENDING_REVIEW','ai_proposal','${p.id}','${human}') RETURNING id`).split('\n')[0]!;
    adminSql(`INSERT INTO workflow_transition(organisation_id,instance_id,to_state,action) VALUES ('${org}','${legacy}','PENDING_REVIEW','start')`);
    adminSql(`UPDATE ai_proposal SET workflow_instance_id='${legacy}' WHERE id='${p.id}'`);
    expect(await fail(run((tx) => svc().beginReview(tx, { organisationId: org, proposalId: p.id, actor: decider() })))).toBe('no_review_step');
    expect((await run((tx) => svc().decide(tx, { organisationId: org, proposalId: p.id, decision: 'ACCEPT', actor: decider() }))).status).toBe('ACCEPTED');
  });
});
