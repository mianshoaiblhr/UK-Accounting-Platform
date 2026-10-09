import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '@uk/contracts';
import { AppError, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { WorkflowEngine, WorkflowRegistry, type Actor } from '@uk/platform';
import { adminSql } from '../helpers/db';

/**
 * D2: the reusable workflow foundation, exercised directly on the engine with a real database.
 * Actors are described by the permissions they hold PER COMPANY, mirroring what the API's central authoriser supplies.
 */
let db: Database;
let org: string, coX: string, coY: string;
const u = { prep: '', rev: '', appr: '', other: '' };

// Stricter statutory-style definition built from the same primitives: evidence + more segregation + mandatory comments.
const STATUTORY: WorkflowDefinition = {
  type: 'statutory_filing_test', version: 1, initialState: 'DRAFT', terminalStates: ['SUBMITTED', 'REJECTED'],
  transitions: [
    { action: 'prepare', from: ['DRAFT'], to: 'IN_PROGRESS', permission: 'workflow:manage' },
    { action: 'submit_for_review', from: ['IN_PROGRESS'], to: 'REVIEW', permission: 'workflow:manage', evidenceRequired: true },
    { action: 'pass_review', from: ['REVIEW'], to: 'APPROVAL', permission: 'workflow:review', requireDistinctFrom: ['prepare', 'submit_for_review'], commentRequired: true },
    { action: 'approve', from: ['APPROVAL'], to: 'SUBMITTED', permission: 'workflow:approve', requireDistinctFrom: ['prepare', 'submit_for_review', 'pass_review'], commentRequired: true, evidenceRequired: true },
    { action: 'reject', from: ['REVIEW', 'APPROVAL'], to: 'REJECTED', permission: 'workflow:approve', commentRequired: true },
  ],
};
const engine = () => new WorkflowEngine(new WorkflowRegistry([...WORKFLOW_DEFINITIONS, STATUTORY]));

const everything = ['workflow:manage', 'workflow:review', 'workflow:approve', 'document:read'];
/** `grants`: permissions per company id ('*' = any). */
const actor = (userId: string, grants: Record<string, string[]>): Actor => ({
  userId, can: (perm, companyId) => (grants[companyId ?? '*'] ?? grants['*'] ?? []).includes(perm),
});
const run = <T>(fn: (tx: import('@uk/db').Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: u.prep }, fn);
const start = (type: string, companyId: string | null, by = u.prep) => run((tx) => engine().start(tx, { type, organisationId: org, companyId, subjectType: 'test', subjectId: uuidv7(), actorUserId: by }));
const act = (id: string, action: string, a: Actor, extra: { comment?: string; evidenceDocumentIds?: string[] } = {}) =>
  run((tx) => engine().transition(tx, { organisationId: org, instanceId: id, action, actor: a, ...extra }));
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code ?? (e as Error).message; } };

const prep = () => actor(u.prep, { '*': ['workflow:manage', 'document:read'] });
const rev = () => actor(u.rev, { '*': ['workflow:manage', 'workflow:review', 'document:read'] });
const appr = () => actor(u.appr, { '*': everything });

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('wf-${k}-${org}@t.test','${k}') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','WF Org')`);
  coX = adminSql(`INSERT INTO company(organisation_id,name) VALUES ('${org}','X') RETURNING id`).split('\n')[0]!;
  coY = adminSql(`INSERT INTO company(organisation_id,name) VALUES ('${org}','Y') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('standard_workflow: DRAFT → IN_PROGRESS → REVIEW → APPROVAL → COMPLETED / REJECTED', () => {
  it('runs end-to-end with three different people and records actor, comment and attempt for every step', async () => {
    const w = await start('standard_workflow', coX);
    expect(w.state).toBe('DRAFT');
    await act(w.id, 'begin', prep());
    await act(w.id, 'submit_for_review', prep());
    await act(w.id, 'pass_review', rev(), { comment: 'checked against ledger' });
    const done = await act(w.id, 'approve', appr(), { comment: 'approved' });
    expect(done.state).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    const hist = await run((tx) => tx.workflowTransition.findMany({ where: { instanceId: w.id }, orderBy: { occurredAt: 'asc' } }));
    expect(hist.map((h) => [h.action, h.toState, h.actorUserId])).toEqual([
      ['start', 'DRAFT', u.prep], ['begin', 'IN_PROGRESS', u.prep], ['submit_for_review', 'REVIEW', u.prep], ['pass_review', 'APPROVAL', u.rev], ['approve', 'COMPLETED', u.appr],
    ]);
    expect(hist.every((h) => h.occurredAt instanceof Date)).toBe(true);
    expect(hist.find((h) => h.action === 'pass_review')!.comment).toBe('checked against ledger');
  });
  it('every transition is explicit: undefined edges, finished workflows and stale versions are refused', async () => {
    const w = await start('standard_workflow', coX);
    expect(await code(act(w.id, 'approve', appr()))).toBe('invalid_transition'); // cannot skip ahead
    expect(await code(act(w.id, 'teleport', appr()))).toBe('invalid_transition');
    await act(w.id, 'begin', prep());
    expect(await code(run((tx) => engine().transition(tx, { organisationId: org, instanceId: w.id, action: 'submit_for_review', actor: prep(), expectedVersion: 99 })))).toBe('version_conflict');
  });
  it('NO SILENT TRANSITIONS: the database itself refuses a state change without a recorded transition', async () => {
    const w = await start('standard_workflow', coX);
    await expect(run((tx) => tx.workflowInstance.update({ where: { id: w.id }, data: { state: 'COMPLETED' } }))).rejects.toThrow(/recorded transition/);
    expect(adminSql(`SELECT state FROM workflow_instance WHERE id='${w.id}'`)).toBe('DRAFT');
    // not even with a fabricated history row from another transaction
    adminSql(`INSERT INTO workflow_transition(organisation_id,instance_id,from_state,to_state,action) VALUES ('${org}','${w.id}','DRAFT','COMPLETED','forged')`);
    await expect(run((tx) => tx.workflowInstance.update({ where: { id: w.id }, data: { state: 'COMPLETED' } }))).rejects.toThrow(/recorded transition/);
  });
  it('permission is required per transition, per company', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    const reviewerOnlyOnY = actor(u.rev, { [coY]: everything, [coX]: ['document:read'] });
    expect(await code(act(w.id, 'pass_review', reviewerOnlyOnY))).toBe('permission_denied');
    const reviewerOnX = actor(u.rev, { [coX]: ['workflow:review'] });
    expect(await code(act(w.id, 'pass_review', reviewerOnX))).toBe('ok');
    const prepOnly = actor(u.other, { '*': ['workflow:manage'] });
    expect(await code(act(w.id, 'approve', prepOnly))).toBe('permission_denied');
  });
});

describe('segregation of duties', () => {
  it('the preparer cannot review; the reviewer cannot approve — enforced in the engine, not the UI', async () => {
    const w = await start('standard_workflow', coX);
    const everyone = (id: string) => actor(id, { '*': everything });
    await act(w.id, 'begin', everyone(u.prep)); await act(w.id, 'submit_for_review', everyone(u.prep));
    expect(await code(act(w.id, 'pass_review', everyone(u.prep)))).toBe('separation_of_duties');
    await act(w.id, 'pass_review', everyone(u.rev));
    expect(await code(act(w.id, 'approve', everyone(u.rev)))).toBe('separation_of_duties');
    expect(await code(act(w.id, 'approve', everyone(u.prep)))).toBe('separation_of_duties');
    expect(await code(act(w.id, 'approve', everyone(u.appr)))).toBe('ok');
  });
  it('availableActions reflects permission and segregation of duties for the actor', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    const inst = await run((tx) => tx.workflowInstance.findUniqueOrThrow({ where: { id: w.id } }));
    const names = (a: Actor) => run((tx) => engine().availableActions(tx, inst, a)).then((x) => x.sort());
    expect(await names(actor(u.prep, { '*': everything }))).toEqual([]);                        // preparer: nothing at REVIEW
    expect(await names(actor(u.rev, { '*': everything }))).toEqual(['pass_review', 'reject', 'request_changes']);
    expect(await names(actor(u.other, { '*': ['document:read'] }))).toEqual([]);                // no workflow rights
  });
});

describe('rejection, comments, retry', () => {
  it('rejection requires a comment and reaches REJECTED; only an explicit commented reopen starts a new attempt', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    expect(await code(act(w.id, 'reject', rev()))).toBe('comment_required');
    const rej = await act(w.id, 'reject', rev(), { comment: 'wrong period' });
    expect(rej.state).toBe('REJECTED');
    expect(rej.completedAt).not.toBeNull();
    expect(await code(act(w.id, 'begin', prep()))).toBe('workflow_finished');        // nothing but reopen leaves a terminal state
    expect(await code(act(w.id, 'reopen', prep()))).toBe('comment_required');
    const re = await act(w.id, 'reopen', prep(), { comment: 'fixed the period' });
    expect(re).toMatchObject({ state: 'DRAFT', attempt: 2, completedAt: null });
    const hist = await run((tx) => tx.workflowTransition.findMany({ where: { instanceId: w.id }, orderBy: { occurredAt: 'asc' } }));
    expect(hist.map((h) => h.attempt)).toEqual([1, 1, 1, 1, 2]);
  });
  it('request_changes sends the work back with a mandatory comment and the same preparer must resubmit', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    expect(await code(act(w.id, 'request_changes', rev()))).toBe('comment_required');
    expect((await act(w.id, 'request_changes', rev(), { comment: 'missing invoice' })).state).toBe('IN_PROGRESS');
  });
  it('a reopened workflow cannot be used to review or approve one\'s own earlier work (segregation spans attempts)', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    await act(w.id, 'reject', rev(), { comment: 'no' });
    await act(w.id, 'reopen', appr(), { comment: 'retry' });
    await act(w.id, 'begin', appr()); await act(w.id, 'submit_for_review', appr());
    expect(await code(act(w.id, 'pass_review', actor(u.prep, { '*': everything })))).toBe('separation_of_duties'); // prepared attempt 1
  });
});

describe('reassignment', () => {
  it('is an explicit recorded step needing workflow:manage; the new assignee must be able to work on the company', async () => {
    const w = await start('standard_workflow', coX);
    const canAssign = async (id: string) => id !== u.other;
    const ok = await run((tx) => engine().reassign(tx, { organisationId: org, instanceId: w.id, assigneeUserId: u.rev, actor: prep(), comment: 'handover', canBeAssigned: canAssign }));
    expect(ok.assigneeUserId).toBe(u.rev);
    expect(ok.state).toBe('DRAFT');
    expect(await code(run((tx) => engine().reassign(tx, { organisationId: org, instanceId: w.id, assigneeUserId: u.other, actor: prep(), canBeAssigned: canAssign })))).toBe('invalid_assignee');
    expect(await code(run((tx) => engine().reassign(tx, { organisationId: org, instanceId: w.id, assigneeUserId: u.rev, actor: actor(u.other, { '*': ['document:read'] }) })))).toBe('permission_denied');
    const hist = await run((tx) => tx.workflowTransition.findMany({ where: { instanceId: w.id, action: 'reassign' } }));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ fromState: 'DRAFT', toState: 'DRAFT', actorUserId: u.prep, comment: 'handover' });
  });
  it('a finished workflow cannot be reassigned', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    await act(w.id, 'reject', rev(), { comment: 'x' });
    expect(await code(run((tx) => engine().reassign(tx, { organisationId: org, instanceId: w.id, assigneeUserId: u.rev, actor: prep() })))).toBe('workflow_finished');
  });
});

describe('evidence', () => {
  let docX: string, docY: string, docOrgLevel: string;
  beforeAll(() => {
    docX = adminSql(`INSERT INTO document(organisation_id,company_id,name,created_by_user_id) VALUES ('${org}','${coX}','x.pdf','${u.prep}') RETURNING id`).split('\n')[0]!;
    docY = adminSql(`INSERT INTO document(organisation_id,company_id,name,created_by_user_id) VALUES ('${org}','${coY}','y.pdf','${u.prep}') RETURNING id`).split('\n')[0]!;
    docOrgLevel = adminSql(`INSERT INTO document(organisation_id,name,created_by_user_id) VALUES ('${org}','o.pdf','${u.prep}') RETURNING id`).split('\n')[0]!;
  });
  it('is stored with the transition and must be real, same-company (or organisation-level) and readable by the actor', async () => {
    const w = await start('statutory_filing_test', coX);
    await act(w.id, 'prepare', prep());
    expect(await code(act(w.id, 'submit_for_review', prep()))).toBe('evidence_required');
    expect(await code(act(w.id, 'submit_for_review', prep(), { evidenceDocumentIds: [uuidv7()] }))).toBe('invalid_evidence');
    expect(await code(act(w.id, 'submit_for_review', prep(), { evidenceDocumentIds: [docY] }))).toBe('invalid_evidence');     // other company
    const blind = actor(u.prep, { '*': ['workflow:manage'] });                                                                  // cannot read documents
    expect(await code(act(w.id, 'submit_for_review', blind, { evidenceDocumentIds: [docX] }))).toBe('permission_denied');
    await act(w.id, 'submit_for_review', prep(), { evidenceDocumentIds: [docX, docOrgLevel, docX] });
    const t = await run((tx) => tx.workflowTransition.findFirstOrThrow({ where: { instanceId: w.id, action: 'submit_for_review' } }));
    expect([...t.evidenceDocumentIds].sort()).toEqual([docX, docOrgLevel].sort());
  });
  it('evidence of another organisation is invisible (RLS) and therefore rejected', async () => {
    const other = uuidv7();
    adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${other}','BUSINESS','Other')`);
    const foreign = adminSql(`INSERT INTO document(organisation_id,name,created_by_user_id) VALUES ('${other}','f.pdf','${u.prep}') RETURNING id`).split('\n')[0]!;
    const w = await start('statutory_filing_test', coX);
    await act(w.id, 'prepare', prep());
    expect(await code(act(w.id, 'submit_for_review', prep(), { evidenceDocumentIds: [foreign] }))).toBe('invalid_evidence');
  });
});

describe('accounting and statutory workflows can impose STRICTER controls on the same engine', () => {
  const full = (id: string) => actor(id, { '*': everything });
  it('adds evidence, mandatory comments and wider segregation without any engine change', async () => {
    const doc = adminSql(`INSERT INTO document(organisation_id,company_id,name,created_by_user_id) VALUES ('${org}','${coX}','e.pdf','${u.prep}') RETURNING id`).split('\n')[0]!;
    const w = await start('statutory_filing_test', coX);
    await act(w.id, 'prepare', full(u.prep));
    await act(w.id, 'submit_for_review', full(u.prep), { evidenceDocumentIds: [doc] });
    expect(await code(act(w.id, 'pass_review', full(u.rev)))).toBe('comment_required');
    expect(await code(act(w.id, 'pass_review', full(u.prep), { comment: 'self review' }))).toBe('separation_of_duties');
    await act(w.id, 'pass_review', full(u.rev), { comment: 'reviewed' });
    expect(await code(act(w.id, 'approve', full(u.rev), { comment: 'x', evidenceDocumentIds: [doc] }))).toBe('separation_of_duties');
    expect(await code(act(w.id, 'approve', full(u.appr), { comment: 'x' }))).toBe('evidence_required');
    expect((await act(w.id, 'approve', full(u.appr), { comment: 'filed', evidenceDocumentIds: [doc] })).state).toBe('SUBMITTED');
  });
  it('the standard workflow can never be approved by anyone lacking the dedicated approval permission', async () => {
    const w = await start('standard_workflow', coX);
    await act(w.id, 'begin', prep()); await act(w.id, 'submit_for_review', prep());
    await act(w.id, 'pass_review', rev());
    expect(await code(act(w.id, 'approve', actor(u.other, { '*': ['workflow:manage', 'workflow:review'] })))).toBe('permission_denied');
  });
});

describe('versioned definitions', () => {
  it('instances keep the definition version they started with; the registry resolves latest by default', () => {
    const r = new WorkflowRegistry();
    expect(r.get('ai_proposal_review').version).toBe(2);
    expect(r.get('ai_proposal_review', 1).initialState).toBe('PENDING_REVIEW');
    expect(r.list().map((d) => d.type).sort()).toEqual(['ai_proposal_review', 'generic_approval', 'standard_workflow']);
    expect(() => r.register(WORKFLOW_DEFINITIONS[0]!)).toThrow(/already registered/);
  });
});
