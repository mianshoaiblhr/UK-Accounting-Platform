import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** Specification V0 §6: folders, metadata, document type, accounting period, permissions (visibility), immutable filing evidence. */
let s: Stack;
let owner: TestUser, partner: TestUser, manager: TestUser, accountant: TestUser, accountant2: TestUser, bookkeeper: TestUser, viewer: TestUser, other: TestUser;
let co: { id: string }, coB: { id: string };
let period: { id: string }, periodB: { id: string };
let db: Database;

const call = (u: TestUser, m: 'get' | 'post' | 'patch' | 'delete' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const doc = async (u: TestUser, o: { name?: string; companyId?: string | null } = {}, extra: Record<string, unknown> = {}) => {
  const companyId = o.companyId === null ? undefined : o.companyId ?? co.id;
  const r = await call(u, 'post', '/documents', { name: o.name ?? 'statement.pdf', companyId, contentType: 'application/pdf', sizeBytes: 60, ...extra });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { document: { id: string }; version: { id: string }; upload: { url: string } };
};
const available = async (u: TestUser, extra: Record<string, unknown> = {}, o: { name?: string; companyId?: string | null } = {}) => {
  const d = await uploadDoc(s, u, { companyId: o.companyId === null ? undefined : o.companyId ?? co.id, name: o.name });
  await waitForVersion(s, u, d.documentId, d.versionId);
  if (Object.keys(extra).length) expect((await call(u, 'patch', `/documents/${d.documentId}`, extra)).status).toBe(200);
  return d;
};
const folder = (u: TestUser, b: Record<string, unknown>) => call(u, 'post', '/document-folders', b);

beforeAll(async () => {
  s = await startStack();
  db = new Database(process.env.DATABASE_URL!);
  owner = await createUser(s, { type: 'PRACTICE', orgName: 'Docs LLP' });
  co = await makeCompany(s, owner, 'Docs Co Ltd');
  coB = await makeCompany(s, owner, 'Docs Other Ltd');
  period = (await call(owner, 'post', `/companies/${co.id}/periods`, { startDate: '2025-04-01', endDate: '2026-03-31' })).body;
  periodB = (await call(owner, 'post', `/companies/${coB.id}/periods`, { startDate: '2025-04-01', endDate: '2026-03-31' })).body;
  partner = await addMember(s, owner, 'partner');
  manager = await addMember(s, owner, 'manager');
  accountant = await addMember(s, owner, 'accountant');
  accountant2 = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  other = await addMember(s, owner, 'bookkeeper', { scope: 'ASSIGNED', companyIds: [coB.id] });
});
afterAll(async () => { await db.close(); await s.stop(); });

describe('document type', () => {
  it('is a controlled vocabulary; existing behaviour (default GENERAL) is unchanged', async () => {
    const d = await doc(bookkeeper);
    expect((await call(bookkeeper, 'get', `/documents/${d.document.id}`)).body).toMatchObject({ documentClass: 'GENERAL', visibility: 'STANDARD', folderId: null, periodId: null, labels: [], metadata: {}, evidenceLockedAt: null });
    const typed = await doc(bookkeeper, {}, { documentClass: 'BANK_STATEMENT' });
    expect((await call(bookkeeper, 'get', `/documents/${typed.document.id}`)).body.documentClass).toBe('BANK_STATEMENT');
    const bad = await call(bookkeeper, 'post', '/documents', { name: 'x.pdf', contentType: 'application/pdf', sizeBytes: 5, documentClass: 'MADE_UP' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('unknown_document_type');
    const filtered = (await call(bookkeeper, 'get', '/documents?documentClass=BANK_STATEMENT&limit=100')).body.items.map((x: { id: string }) => x.id);
    expect(filtered).toContain(typed.document.id);
    expect(filtered).not.toContain(d.document.id);
  });
});

describe('folders', () => {
  it('build a tree per company; list, rename, move and delete when empty', async () => {
    const root = await folder(bookkeeper, { name: 'VAT 2025', companyId: co.id });
    expect(root.status).toBe(201);
    const sub = await folder(bookkeeper, { name: 'Q1', parentId: root.body.id });
    expect(sub.body).toMatchObject({ companyId: co.id, parentId: root.body.id });
    expect((await folder(bookkeeper, { name: 'q1', parentId: root.body.id })).body.code).toBe('folder_exists'); // case-insensitive siblings
    expect((await folder(bookkeeper, { name: 'Q1', parentId: root.body.id, companyId: coB.id })).body.code).toBe('folder_company_mismatch');
    expect((await call(bookkeeper, 'get', `/document-folders?companyId=${co.id}&parentId=${root.body.id}`)).body.items.map((f: { name: string }) => f.name)).toEqual(['Q1']);
    expect((await call(bookkeeper, 'patch', `/document-folders/${sub.body.id}`, { name: 'Quarter 1' })).body.name).toBe('Quarter 1');
    const d = await available(bookkeeper, { folderId: sub.body.id });
    expect((await call(bookkeeper, 'get', `/documents?folderId=${sub.body.id}`)).body.items.map((x: { id: string }) => x.id)).toEqual([d.documentId]);
    expect((await call(accountant, 'delete', `/document-folders/${sub.body.id}`)).body.code).toBe('folder_not_empty');
    expect((await call(accountant, 'delete', `/document-folders/${root.body.id}`)).body.code).toBe('folder_not_empty'); // has a subfolder
    await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { folderId: null });
    expect((await call(accountant, 'delete', `/document-folders/${sub.body.id}`)).status).toBe(204);
    expect((await call(accountant, 'delete', `/document-folders/${root.body.id}`)).status).toBe(204);
  });

  it('refuse cycles, excessive depth and cross-company filing', async () => {
    const a = (await folder(accountant, { name: 'A', companyId: co.id })).body;
    const b = (await folder(accountant, { name: 'B', parentId: a.id })).body;
    expect((await call(accountant, 'patch', `/document-folders/${a.id}`, { parentId: b.id })).body.code).toBe('folder_cycle');
    expect((await call(accountant, 'patch', `/document-folders/${a.id}`, { parentId: a.id })).status).toBe(422);
    let parent = b.id;
    for (let i = 0; i < 6; i++) parent = (await folder(accountant, { name: `L${i}`, parentId: parent })).body.id; // depth 8 reached
    const deep = await folder(accountant, { name: 'too deep', parentId: parent });
    expect(deep.body.code, JSON.stringify(deep.body)).toBe('folder_too_deep');
    const foreign = (await folder(accountant, { name: 'Other co', companyId: coB.id })).body;
    expect((await call(accountant, 'patch', `/document-folders/${b.id}`, { parentId: foreign.id })).body.code).toBe('folder_company_mismatch');
    const d = await available(accountant);
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { folderId: foreign.id })).body.code).toBe('folder_company_mismatch');
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { folderId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('unknown_folder');
  });

  it('follow company permissions: viewers cannot create, members of other companies cannot see them', async () => {
    const f = (await folder(accountant, { name: 'Private to Co', companyId: co.id })).body;
    expect((await folder(viewer, { name: 'x', companyId: co.id })).status).toBe(403);
    expect((await call(other, 'get', `/document-folders/${f.id}`)).status).toBe(404);
    expect((await call(other, 'get', `/document-folders?limit=100`)).body.items.some((x: { id: string }) => x.id === f.id)).toBe(false);
    expect((await call(other, 'patch', `/document-folders/${f.id}`, { name: 'hijack' })).status).toBe(404);
    expect((await call(viewer, 'get', `/document-folders/${f.id}`)).status).toBe(200);
  });
});

describe('accounting period and metadata', () => {
  it('links a document to a period of its own company only', async () => {
    const ok = await doc(bookkeeper, {}, { periodId: period.id });
    expect((await call(bookkeeper, 'get', `/documents/${ok.document.id}`)).body.periodId).toBe(period.id);
    expect((await call(bookkeeper, 'get', `/documents?periodId=${period.id}`)).body.items.map((x: { id: string }) => x.id)).toContain(ok.document.id);
    const wrong = await call(bookkeeper, 'post', '/documents', { name: 'x.pdf', companyId: co.id, contentType: 'application/pdf', sizeBytes: 5, periodId: periodB.id });
    expect(wrong.body.code).toBe('unknown_period');
    const orgLevel = await call(accountant, 'post', '/documents', { name: 'x.pdf', contentType: 'application/pdf', sizeBytes: 5, periodId: period.id });
    expect(orgLevel.body.code).toBe('period_requires_company');
    expect(() => adminSql(`UPDATE document SET period_id='${periodB.id}' WHERE id='${ok.document.id}'`)).toThrow(/period of its own company/);
  });

  it('metadata edits are audited with before/after and a reason; invalid metadata is refused', async () => {
    const d = await available(bookkeeper);
    const r = await call(bookkeeper, 'patch', `/documents/${d.documentId}`, {
      description: 'Barclays current account, April', documentDate: '2025-04-30', reference: 'BARC-0425', labels: ['bank', 'april', 'bank'],
      metadata: { sortCode: '20-00-00', closingBalance: 1234.56, reconciled: false }, documentClass: 'BANK_STATEMENT', periodId: period.id, reason: 'classified on receipt' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ description: 'Barclays current account, April', documentDate: '2025-04-30T00:00:00.000Z', reference: 'BARC-0425', labels: ['bank', 'april'], metadata: { closingBalance: 1234.56 } });
    const a = (await call(owner, 'get', '/audit-events?limit=100&action=document.updated')).body.items.find((e: { entityId: string }) => e.entityId === d.documentId);
    expect(a).toMatchObject({ actorUserId: bookkeeper.userId, reason: 'classified on receipt', companyId: co.id, before: { documentClass: 'GENERAL', periodId: null }, after: { documentClass: 'BANK_STATEMENT', periodId: period.id } });
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { metadata: { nested: { a: 1 } } })).status).toBe(422);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { metadata: { ['x'.repeat(200)]: 'long key' } })).status).toBe(422);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })).status).toBe(422);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { documentDate: '2025-13-45' })).status).toBe(422);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, {})).status).toBe(422);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { documentClass: 'NOPE' })).body.code).toBe('unknown_document_type');
    expect((await call(viewer, 'patch', `/documents/${d.documentId}`, { description: 'x' })).status).toBe(403);
    expect((await call(other, 'patch', `/documents/${d.documentId}`, { description: 'x' })).status).toBe(404);
  });

  it('searches by name and filters by status', async () => {
    const d = await available(bookkeeper, {}, { name: 'unique-needle-xyz.pdf' });
    expect((await call(bookkeeper, 'get', '/documents?q=NEEDLE-xyz')).body.items.map((x: { id: string }) => x.id)).toEqual([d.documentId]);
    await call(accountant, 'post', `/documents/${d.documentId}/archive`, { reason: 'dup' });
    expect((await call(bookkeeper, 'get', '/documents?q=needle-xyz&status=ACTIVE')).body.items).toHaveLength(0);
    expect((await call(bookkeeper, 'get', '/documents?q=needle-xyz&status=ARCHIVED')).body.items).toHaveLength(1);
    expect((await call(bookkeeper, 'patch', `/documents/${d.documentId}`, { description: 'late' })).body.code).toBe('document_archived');
  });
});

describe('visibility: restricted documents are invisible to everyone else, on every path', () => {
  it('404 for non-grantees across documents, versions, download, content, edit, archive, tasks and workflow evidence', async () => {
    const d = await available(accountant, { visibility: 'RESTRICTED' });
    const id = d.documentId;
    // creator, confidential holders (partner, manager, owner) can see it
    for (const u of [accountant, partner, manager, owner]) expect((await call(u, 'get', `/documents/${id}`)).status, u.email).toBe(200);
    // everyone else cannot - and cannot tell it exists
    for (const u of [bookkeeper, viewer, accountant2]) {
      expect((await call(u, 'get', `/documents/${id}`)).status).toBe(404);
      expect((await call(u, 'get', `/documents/${id}/versions/${d.versionId}/download`)).status).toBe(404);
      expect((await call(u, 'get', `/documents/${id}/versions/${d.versionId}/content`)).status).toBe(404);
      expect((await call(u, 'get', '/documents?limit=100')).body.items.some((x: { id: string }) => x.id === id)).toBe(false);
      expect((await call(u, 'get', `/documents?q=${encodeURIComponent('statement')}&limit=100`)).body.items.some((x: { id: string }) => x.id === id)).toBe(false);
    }
    expect((await call(bookkeeper, 'patch', `/documents/${id}`, { description: 'x' })).status).toBe(404);
    expect((await call(bookkeeper, 'post', `/documents/${id}/versions`, { contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(404);
    expect((await call(accountant2, 'post', `/documents/${id}/versions`, { contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(404);
    expect((await call(accountant2, 'post', `/documents/${id}/archive`, {})).status).toBe(404); // holds document:archive, still cannot see it
    expect((await call(accountant2, 'patch', `/documents/${id}`, { description: 'x' })).status).toBe(404);
    // a task cannot reveal or attach it, a task cannot name it as its source, a workflow cannot cite it as evidence
    const t = (await call(bookkeeper, 'post', '/tasks', { title: 'Chase statement', companyId: co.id })).body;
    expect((await call(bookkeeper, 'post', `/tasks/${t.id}/attachments`, { documentId: id })).status).toBe(404);
    expect((await call(bookkeeper, 'post', '/tasks', { title: 'x', companyId: co.id, source: 'DOCUMENT', sourceId: id })).body.code).toBe('invalid_source');
    const w = (await call(manager, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'task', subjectId: 'restricted-evidence', companyId: co.id })).body;
    await call(manager, 'post', `/workflows/${w.id}/transitions`, { action: 'begin' });
    const cited = await call(bookkeeper, 'post', `/workflows/${w.id}/transitions`, { action: 'submit_for_review', evidenceDocumentIds: [id] });
    expect([403, 422]).toContain(cited.status);
    expect(JSON.stringify(cited.body)).not.toContain('RESTRICTED');
    // an attachment made while it was visible shows no name to someone who cannot see it
    const open = await available(accountant);
    await call(accountant, 'post', `/tasks/${t.id}/attachments`, { documentId: open.documentId });
    await call(accountant, 'patch', `/documents/${open.documentId}`, { visibility: 'RESTRICTED' });
    const seen = (await call(bookkeeper, 'get', `/tasks/${t.id}/attachments`)).body.items[0];
    expect(seen).toMatchObject({ documentId: open.documentId, documentName: null, documentStatus: null });
    expect((await call(accountant, 'get', `/tasks/${t.id}/attachments`)).body.items[0].documentName).toBe('invoice.pdf');
  });

  it('explicit grants: managed by document:confidential holders, require access to the company, revocable, audited', async () => {
    const d = await available(accountant, { visibility: 'RESTRICTED' });
    const id = d.documentId;
    expect((await call(accountant, 'post', `/documents/${id}/access`, { userId: bookkeeper.userId })).status).toBe(403); // creator alone cannot share
    expect((await call(manager, 'post', `/documents/${id}/access`, { userId: other.userId })).body.code).toBe('invalid_grantee'); // no access to this company
    expect((await call(manager, 'post', `/documents/${id}/access`, { userId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('invalid_grantee');
    expect((await call(manager, 'post', `/documents/${id}/access`, { userId: bookkeeper.userId })).status).toBe(201);
    expect((await call(manager, 'post', `/documents/${id}/access`, { userId: bookkeeper.userId })).body.code).toBe('access_exists');
    expect((await call(bookkeeper, 'get', `/documents/${id}`)).status).toBe(200);
    expect((await call(bookkeeper, 'get', '/documents?limit=100')).body.items.some((x: { id: string }) => x.id === id)).toBe(true);
    expect((await call(bookkeeper, 'get', `/documents/${id}/access`)).status).toBe(403); // reading is not managing
    expect((await call(manager, 'get', `/documents/${id}/access`)).body.items.map((g: { userId: string }) => g.userId)).toEqual([bookkeeper.userId]);
    expect((await call(manager, 'delete', `/documents/${id}/access/${bookkeeper.userId}`)).status).toBe(204);
    expect((await call(bookkeeper, 'get', `/documents/${id}`)).status).toBe(404);
    const actions = (await call(owner, 'get', '/audit-events?limit=100')).body.items.filter((e: { entityId: string }) => e.entityId === id).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['document.access_granted', 'document.access_revoked']));
  });

  it('only a confidential-document manager can relax a restriction; anyone who can edit can tighten it', async () => {
    const d = await available(accountant);
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { visibility: 'RESTRICTED' })).body.visibility).toBe('RESTRICTED');
    const r = await call(accountant, 'patch', `/documents/${d.documentId}`, { visibility: 'STANDARD' });
    expect(r.status).toBe(403);
    expect((await call(manager, 'patch', `/documents/${d.documentId}`, { visibility: 'STANDARD' })).body.visibility).toBe('STANDARD');
  });

  it('a restricted document can be created restricted from the start', async () => {
    const d = await doc(bookkeeper, {}, { visibility: 'RESTRICTED' });
    expect((await call(accountant, 'get', `/documents/${d.document.id}`)).status).toBe(404);
    expect((await call(bookkeeper, 'get', `/documents/${d.document.id}`)).status).toBe(200);
  });
});

describe('immutable filing evidence', () => {
  it('only evidence:lock holders; only an AVAILABLE version; retention of at least six years', async () => {
    const d = await available(accountant);
    expect((await call(accountant, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId, reason: 'filed' })).status).toBe(403);
    expect((await call(manager, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId, reason: 'filed' })).status).toBe(403);
    const pending = await doc(accountant);
    expect((await call(partner, 'post', `/documents/${pending.document.id}/evidence-lock`, { versionId: pending.version.id, reason: 'filed' })).body.code).toBe('version_not_available');
    const short = new Date(); short.setUTCFullYear(short.getUTCFullYear() + 2);
    expect((await call(partner, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId, reason: 'filed', retainUntil: short.toISOString().slice(0, 10) })).body.code).toBe('retention_too_short');
    expect((await call(partner, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: '00000000-0000-4000-8000-000000000000', reason: 'filed' })).status).toBe(404);
    expect((await call(partner, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId })).status).toBe(422); // reason is mandatory
  });

  it('locks one version, records its hash and a retention date, and freezes the document everywhere', async () => {
    const d = await available(accountant, { documentClass: 'FILING_EVIDENCE' }, { name: 'CT600-receipt.pdf' });
    const before = (await call(partner, 'get', `/documents/${d.documentId}`)).body;
    const sha = before.versions[0].sha256;
    const r = await call(partner, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId, reason: 'CT600 accepted by HMRC, receipt IRmark ABC' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ evidenceVersionId: d.versionId, evidenceSha256: sha, evidenceLockedAt: expect.any(String) });
    const years = new Date(r.body.retainUntil).getUTCFullYear() - new Date().getUTCFullYear();
    expect(years).toBeGreaterThanOrEqual(6);
    // application level
    expect((await call(partner, 'post', `/documents/${d.documentId}/evidence-lock`, { versionId: d.versionId, reason: 'again' })).body.code).toBe('evidence_locked');
    expect((await call(accountant, 'post', `/documents/${d.documentId}/versions`, { contentType: 'application/pdf', sizeBytes: 5 })).body.code).toBe('evidence_locked');
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { name: 'tampered.pdf' })).body.code).toBe('evidence_locked');
    expect((await call(owner, 'post', `/documents/${d.documentId}/archive`, {})).body.code).toBe('evidence_locked');
    expect((await call(accountant, 'get', '/documents?evidenceLocked=true&limit=100')).body.items.map((x: { id: string }) => x.id)).toContain(d.documentId);
    // still readable and downloadable
    expect((await call(accountant, 'get', `/documents/${d.documentId}/versions/${d.versionId}/download`)).status).toBe(200);
    // audit trail
    const e = (await call(owner, 'get', '/audit-events?limit=100&action=document.evidence_locked')).body.items.find((x: { entityId: string }) => x.entityId === d.documentId);
    expect(e).toMatchObject({ actorUserId: partner.userId, reason: expect.stringContaining('CT600'), after: { evidenceSha256: sha } });

    // database level - the application's own role, every route to the row
    const ctx = { organisationId: owner.organisationId, userId: partner.userId };
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { name: 'tampered' } }))).rejects.toThrow(/immutable/);
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { status: 'ARCHIVED' } }))).rejects.toThrow(/immutable/);
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { evidenceLockedAt: null, evidenceVersionId: null, evidenceSha256: null, evidenceLockedByUserId: null, evidenceReason: null } }))).rejects.toThrow();
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { evidenceSha256: 'f'.repeat(64) } }))).rejects.toThrow(/unlocked or re-locked/);
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { retainUntil: new Date('2020-01-01') } }))).rejects.toThrow(/cannot be shortened/);
    await expect(db.tenant(ctx, (tx) => tx.document.delete({ where: { id: d.documentId } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant(ctx, (tx) => tx.documentVersion.update({ where: { id: d.versionId }, data: { status: 'QUARANTINED' } }))).rejects.toThrow(/locked evidence version/);
    await expect(db.tenant(ctx, (tx) => tx.documentVersion.create({ data: { organisationId: owner.organisationId, documentId: d.documentId, versionNo: 2, storageKey: 'k', contentType: 'application/pdf', sizeBytes: 1, createdByUserId: partner.userId } }))).rejects.toThrow(/accepts no new versions/);
    // a legal hold may still be placed, never lifted
    await db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { legalHold: true } }));
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { legalHold: false } }))).rejects.toThrow(/immutable/);
    // a later retention date is fine
    const later = new Date(r.body.retainUntil); later.setUTCFullYear(later.getUTCFullYear() + 1);
    await db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { retainUntil: later } }));
  });

  it('the lock cannot be forged at the database: needs a matching AVAILABLE version, hash and retention', async () => {
    const d = await available(accountant);
    const ctx = { organisationId: owner.organisationId, userId: partner.userId };
    const lock = (data: Record<string, unknown>) => db.tenant(ctx, (tx) => tx.document.update({ where: { id: d.documentId }, data: { evidenceLockedAt: new Date(), evidenceLockedByUserId: partner.userId, evidenceReason: 'x', retainUntil: new Date('2099-01-01'), ...data } }));
    await expect(lock({ evidenceVersionId: d.versionId, evidenceSha256: 'a'.repeat(64) })).rejects.toThrow(/hash must match/);
    const pending = await doc(accountant);
    await expect(db.tenant(ctx, (tx) => tx.document.update({ where: { id: pending.document.id }, data: { evidenceLockedAt: new Date(), evidenceLockedByUserId: partner.userId, evidenceReason: 'x', retainUntil: new Date('2099-01-01'), evidenceVersionId: pending.version.id, evidenceSha256: 'b'.repeat(64) } }))).rejects.toThrow(/AVAILABLE/);
    await expect(lock({ evidenceVersionId: d.versionId })).rejects.toThrow(); // hash missing => incomplete lock
    expect(adminSql(`SELECT evidence_locked_at IS NULL FROM document WHERE id='${d.documentId}'`)).toBe('t');
  });
});
