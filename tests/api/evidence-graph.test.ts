import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** Evidence graph foundation: typed, same-company, immutable, permission-aware at both ends. */
let s: Stack;
let owner: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, other: TestUser;
let co: { id: string }, coB: { id: string };
let db: Database;
const call = (u: TestUser, m: 'get' | 'post' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const link = (u: TestUser, source: [string, string], target: [string, string], kind = 'SUPPORTS', extra: object = {}) =>
  call(u, 'post', '/evidence-links', { sourceType: source[0], sourceId: source[1], targetType: target[0], targetId: target[1], kind, ...extra });
const links = async (u: TestUser, type: string, id: string, qs = '') => (await call(u, 'get', `/evidence-links?entityType=${type}&entityId=${id}${qs}`)).body.items as Array<Record<string, any>>;
const doc = async (u: TestUser, companyId: string | null = co.id) => { const d = await uploadDoc(s, u, { companyId: companyId ?? undefined }); await waitForVersion(s, u, d.documentId, d.versionId); return d; };
const task = async (companyId: string | null = co.id) => (await call(accountant, 'post', '/tasks', { title: 'Evidence task', ...(companyId ? { companyId } : {}) })).body as { id: string };

beforeAll(async () => {
  s = await startStack();
  db = new Database(process.env.DATABASE_URL!);
  owner = await createUser(s, { type: 'PRACTICE' });
  co = await makeCompany(s, owner, 'Evidence Co');
  coB = await makeCompany(s, owner, 'Evidence Other');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  other = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [coB.id] });
});
afterAll(async () => { await db.close(); await s.stop(); });

describe('creating and reading links', () => {
  it('links two entities of the same company; both directions are queryable; duplicates and self-links are refused', async () => {
    const d = await doc(bookkeeper), t = await task();
    const l = await link(bookkeeper, ['document', d.documentId], ['task', t.id], 'SUPPORTS', { note: 'bank statement for the VAT task' });
    expect(l.status).toBe(201);
    expect(l.body).toMatchObject({ companyId: co.id, sourceType: 'document', targetType: 'task', kind: 'SUPPORTS', createdByUserId: bookkeeper.userId, revokedAt: null });
    expect((await links(bookkeeper, 'document', d.documentId)).map((x) => [x.direction, x.targetType])).toContainEqual(['out', 'task']);
    expect((await links(bookkeeper, 'task', t.id)).find((x) => x.id === l.body.id)).toMatchObject({ direction: 'in' });
    expect((await links(bookkeeper, 'task', t.id, '&direction=out')).some((x) => x.id === l.body.id)).toBe(false);
    expect((await link(bookkeeper, ['document', d.documentId], ['task', t.id])).body.code).toBe('link_exists');
    expect((await link(bookkeeper, ['document', d.documentId], ['task', t.id], 'REFERENCES')).status).toBe(201); // another kind is another link
    expect((await link(bookkeeper, ['document', d.documentId], ['document', d.documentId])).body.code).toBe('evidence_self_link');
    const audit = (await call(owner, 'get', '/audit-events?limit=100&action=evidence_link.created')).body.items.find((e: { entityId: string }) => e.entityId === l.body.id);
    expect(audit).toMatchObject({ actorUserId: bookkeeper.userId, companyId: co.id });
  });

  it('supports organisation-level entities and every V0 entity type; refuses links across companies', async () => {
    const d = await doc(bookkeeper), dB = await doc(owner, coB.id), tB = await task(coB.id);
    expect((await link(owner, ['document', d.documentId], ['company', co.id], 'REFERENCES')).status).toBe(201);
    const period = (await call(owner, 'post', `/companies/${co.id}/periods`, { startDate: '2020-04-01', endDate: '2021-03-31' })).body;
    expect((await link(owner, ['document', d.documentId], ['accounting_period', period.id], 'SUPPORTS')).status).toBe(201);
    expect((await link(owner, ['document_version', d.versionId], ['document', d.documentId], 'DERIVED_FROM')).status).toBe(201);
    const orgDoc = await doc(owner, null);
    expect((await link(owner, ['document', orgDoc.documentId], ['task', (await task(null)).id], 'ATTACHED_TO')).body.companyId).toBeNull();
    expect((await link(owner, ['document', d.documentId], ['task', tB.id])).body.code).toBe('evidence_company_mismatch');
    expect((await link(owner, ['document', d.documentId], ['document', dB.documentId])).body.code).toBe('evidence_company_mismatch');
    expect((await link(owner, ['document', d.documentId], ['task', '00000000-0000-4000-8000-000000000000'])).body.code).toBe('unknown_evidence_entity');
    expect((await call(owner, 'post', '/evidence-links', { sourceType: 'journal', sourceId: d.documentId, targetType: 'task', targetId: d.documentId, kind: 'SUPPORTS' })).status).toBe(422); // not a V0 entity
  });

  it('permissions: evidence:manage to link, evidence:read to read; each end is checked with its own rules', async () => {
    const d = await doc(bookkeeper), t = await task();
    expect((await link(reviewer, ['document', d.documentId], ['task', t.id])).status).toBe(403);   // reviewers read only
    expect((await link(viewer, ['document', d.documentId], ['task', t.id])).status).toBe(403);
    expect((await call(viewer, 'get', `/evidence-links?entityType=task&entityId=${t.id}`)).status).toBe(403);
    expect((await call(reviewer, 'get', `/evidence-links?entityType=task&entityId=${t.id}`)).status).toBe(200);
    // a user of another company can neither link to nor read these entities - the same answer as for a missing entity
    const missing = await link(other, ['document', d.documentId], ['task', '00000000-0000-4000-8000-000000000000']);
    const invisible = await link(other, ['document', d.documentId], ['task', t.id]);
    expect(invisible.status).toBe(422);
    const { correlationId: _a, ...invisibleBody } = invisible.body, { correlationId: _b, ...missingBody } = missing.body;
    expect(invisibleBody).toEqual(missingBody); // indistinguishable from a missing entity
    expect((await call(other, 'get', `/evidence-links?entityType=task&entityId=${t.id}`)).status).toBe(404);
  });
});

describe('restricted documents stay invisible in the graph', () => {
  it('cannot be linked, listed or discovered through other entities by people who cannot see them', async () => {
    const d = await doc(accountant), t = await task();
    expect((await link(accountant, ['document', d.documentId], ['task', t.id])).status).toBe(201);
    expect((await link(bookkeeper, ['task', t.id], ['document', d.documentId], 'REFERENCES')).status).toBe(201); // visible for now
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { visibility: 'RESTRICTED' })).status).toBe(200);
    expect((await link(bookkeeper, ['task', t.id], ['document', d.documentId], 'ATTACHED_TO')).body.code).toBe('unknown_evidence_entity');
    expect((await call(bookkeeper, 'get', `/evidence-links?entityType=document&entityId=${d.documentId}`)).status).toBe(404);
    expect((await links(bookkeeper, 'task', t.id)).some((x) => x.targetId === d.documentId || x.sourceId === d.documentId)).toBe(false); // omitted, not hidden-with-a-count
    expect((await links(accountant, 'task', t.id)).filter((x) => x.targetId === d.documentId || x.sourceId === d.documentId).length).toBe(2);
  });
});

describe('immutability and revocation', () => {
  it('revoking records who and why, hides the link by default and is final; links cannot be edited or deleted', async () => {
    const d = await doc(bookkeeper), t = await task();
    const l = (await link(bookkeeper, ['document', d.documentId], ['task', t.id])).body;
    expect((await call(reviewer, 'post', `/evidence-links/${l.id}/revoke`, { reason: 'x' })).status).toBe(403);
    expect((await call(bookkeeper, 'post', `/evidence-links/${l.id}/revoke`, {})).status).toBe(422); // reason mandatory
    const r = await call(bookkeeper, 'post', `/evidence-links/${l.id}/revoke`, { reason: 'wrong statement' });
    expect(r.body).toMatchObject({ revokedAt: expect.any(String), revokedByUserId: bookkeeper.userId, revokedReason: 'wrong statement' });
    expect((await links(bookkeeper, 'task', t.id)).some((x) => x.id === l.id)).toBe(false);
    expect((await links(bookkeeper, 'task', t.id, '&includeRevoked=true')).some((x) => x.id === l.id)).toBe(true);
    expect((await call(bookkeeper, 'post', `/evidence-links/${l.id}/revoke`, { reason: 'again' })).body.code).toBe('link_revoked');
    expect((await link(bookkeeper, ['document', d.documentId], ['task', t.id])).status).toBe(201); // may be linked again afterwards (a new link)
    const ctx = { organisationId: owner.organisationId, userId: bookkeeper.userId };
    await expect(db.tenant(ctx, (tx) => tx.evidenceLink.updateMany({ where: { id: l.id }, data: { kind: 'REFERENCES' } }))).rejects.toThrow(/immutable/);
    await expect(db.tenant(ctx, (tx) => tx.evidenceLink.updateMany({ where: { id: l.id }, data: { revokedReason: 'rewrite history' } }))).rejects.toThrow(/final/);
    await expect(db.tenant(ctx, (tx) => tx.evidenceLink.deleteMany({ where: { id: l.id } }))).rejects.toThrow(/permission denied/);
    expect((await call(other, 'post', `/evidence-links/${l.id}/revoke`, { reason: 'x' })).status).toBe(404);
  });
});

describe('existing evidence-like features write to the graph in the same transaction', () => {
  it('task attachments create (and removal revokes) an ATTACHED_TO link', async () => {
    const d = await doc(bookkeeper), t = await task();
    await call(bookkeeper, 'post', `/tasks/${t.id}/attachments`, { documentId: d.documentId });
    expect((await links(bookkeeper, 'task', t.id)).find((x) => x.targetId === d.documentId)).toMatchObject({ kind: 'ATTACHED_TO', sourceType: 'task', companyId: co.id });
    await call(bookkeeper, 'delete', `/tasks/${t.id}/attachments/${d.documentId}`);
    expect((await links(bookkeeper, 'task', t.id)).some((x) => x.targetId === d.documentId)).toBe(false);
    expect((await links(bookkeeper, 'task', t.id, '&includeRevoked=true')).find((x) => x.targetId === d.documentId)).toMatchObject({ revokedReason: 'attachment removed' });
  });

  it('workflow evidence creates a SUPPORTS link from the workflow instance; a failed transition leaves no link', async () => {
    const d = await doc(accountant);
    const w = (await call(accountant, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'task', subjectId: 'graph-evidence', companyId: co.id })).body;
    await call(accountant, 'post', `/workflows/${w.id}/transitions`, { action: 'begin' });
    const bad = await call(accountant, 'post', `/workflows/${w.id}/transitions`, { action: 'pass_review', evidenceDocumentIds: [d.documentId] }); // not a valid action in this state
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await links(accountant, 'workflow_instance', w.id)).length).toBe(0);
    expect((await call(accountant, 'post', `/workflows/${w.id}/transitions`, { action: 'submit_for_review', evidenceDocumentIds: [d.documentId] })).status).toBe(201);
    expect((await links(accountant, 'workflow_instance', w.id))[0]).toMatchObject({ kind: 'SUPPORTS', targetType: 'document', targetId: d.documentId, companyId: co.id });
    expect((await links(accountant, 'document', d.documentId)).find((x) => x.sourceId === w.id)).toMatchObject({ direction: 'in' });
  });
});

describe('integrity', () => {
  it('no active link points at an entity that does not exist or belongs to another company', () => {
    const dangling = adminSql(`
      SELECT count(*) FROM evidence_link l WHERE l.revoked_at IS NULL AND (
        (l.source_type='document' AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id=l.source_id AND d.organisation_id=l.organisation_id AND d.company_id IS NOT DISTINCT FROM COALESCE(l.company_id, d.company_id)))
        OR (l.target_type='document' AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id=l.target_id AND d.organisation_id=l.organisation_id AND d.company_id IS NOT DISTINCT FROM COALESCE(l.company_id, d.company_id)))
        OR (l.source_type='task' AND NOT EXISTS (SELECT 1 FROM task t WHERE t.id=l.source_id AND t.organisation_id=l.organisation_id))
        OR (l.target_type='task' AND NOT EXISTS (SELECT 1 FROM task t WHERE t.id=l.target_id AND t.organisation_id=l.organisation_id))
        OR (l.source_type='workflow_instance' AND NOT EXISTS (SELECT 1 FROM workflow_instance w WHERE w.id=l.source_id AND w.organisation_id=l.organisation_id)))`);
    expect(dangling).toBe('0');
  });
});
