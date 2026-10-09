import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** D2 through the public API: standard workflow, reassignment, evidence, company-level permission. */
let s: Stack;
let owner: TestUser, accountant: TestUser, partner: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string }, otherCompany: { id: string };
let evidence: { documentId: string };
const call = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'WF Client');
  otherCompany = await makeCompany(s, owner, 'WF Other');
  accountant = await addMember(s, owner, 'accountant');
  partner = await addMember(s, owner, 'partner');
  bookkeeper = await addMember(s, owner, 'manager'); // the preparer: workflow:manage + review, but no approval
  outsider = await createUser(s, { type: 'PRACTICE' });
  const d = await uploadDoc(s, owner, { companyId: company.id });
  await waitForVersion(s, owner, d.documentId, d.versionId);
  evidence = d;
});
afterAll(() => s.stop());

describe('standard_workflow over the API', () => {
  it('is listed with its explicit transitions and permissions', async () => {
    const def = (await call(owner, 'get', '/workflows/definitions')).body.items.find((d: { type: string }) => d.type === 'standard_workflow');
    expect(def).toMatchObject({ version: 1, initialState: 'DRAFT', terminalStates: ['COMPLETED', 'REJECTED'], apiStartable: true });
    expect(def.transitions.map((t: { action: string }) => t.action)).toEqual(expect.arrayContaining(['begin', 'submit_for_review', 'pass_review', 'approve', 'reject', 'reopen']));
  });
  it('manager prepares, accountant reviews, partner approves — with evidence on the record', async () => {
    const w = (await call(bookkeeper, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'task', subjectId: 'vat-q1', companyId: company.id }));
    expect(w.status).toBe(201);
    const id = w.body.id;
    await call(bookkeeper, 'post', `/workflows/${id}/transitions`, { action: 'begin' });
    expect((await call(bookkeeper, 'post', `/workflows/${id}/transitions`, { action: 'submit_for_review', evidenceDocumentIds: [evidence.documentId] })).body.state).toBe('REVIEW');
    expect((await call(bookkeeper, 'post', `/workflows/${id}/transitions`, { action: 'pass_review' })).status).toBe(403); // (preparer) may not review their own submission
    expect((await call(accountant, 'post', `/workflows/${id}/transitions`, { action: 'pass_review' })).body.state).toBe('APPROVAL');
    expect((await call(accountant, 'post', `/workflows/${id}/transitions`, { action: 'approve' })).status).toBe(403);         // accountant lacks workflow:approve
    expect((await call(partner, 'post', `/workflows/${id}/transitions`, { action: 'approve', comment: 'ok' })).body.state).toBe('COMPLETED');
    const view = (await call(owner, 'get', `/workflows/${id}`)).body;
    expect(view.transitions.map((t: { action: string }) => t.action)).toEqual(['start', 'begin', 'submit_for_review', 'pass_review', 'approve']);
    expect(view.transitions[2].evidenceDocumentIds).toEqual([evidence.documentId]);
    expect(view.availableActions).toEqual([]);
  });
  it('evidence from a different company is refused', async () => {
    const d2 = await uploadDoc(s, owner, { companyId: otherCompany.id });
    const id = (await call(bookkeeper, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'x', subjectId: 'y', companyId: company.id })).body.id;
    await call(bookkeeper, 'post', `/workflows/${id}/transitions`, { action: 'begin' });
    const r = await call(bookkeeper, 'post', `/workflows/${id}/transitions`, { action: 'submit_for_review', evidenceDocumentIds: [d2.documentId] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid_evidence');
  });
  it('reassignment is recorded; the assignee must be able to see the company', async () => {
    const id = (await call(bookkeeper, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'x', subjectId: 'z', companyId: company.id })).body.id;
    const ok = await call(bookkeeper, 'post', `/workflows/${id}/reassign`, { assigneeUserId: accountant.userId, comment: 'over to you' });
    expect(ok.status).toBe(200);
    expect(ok.body.assigneeUserId).toBe(accountant.userId);
    const bad = await call(bookkeeper, 'post', `/workflows/${id}/reassign`, { assigneeUserId: outsider.userId });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_assignee');
    const hist = (await call(owner, 'get', `/workflows/${id}`)).body.transitions;
    expect(hist.at(-1)).toMatchObject({ action: 'reassign', actorUserId: bookkeeper.userId, comment: 'over to you' });
  });
  it('starting a workflow for a company needs workflow:manage on THAT company', async () => {
    const restricted = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    const r = await call(restricted, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'x', subjectId: 'y', companyId: company.id });
    expect([403, 404]).toContain(r.status);
  });
});
