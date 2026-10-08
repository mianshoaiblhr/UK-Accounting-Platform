import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { PDF, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForJob, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let u: TestUser;
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

beforeAll(async () => { s = await startStack(); u = await createUser(s); });
afterAll(() => s.stop());

describe('document pipeline (async: upload -> job -> scan -> available)', () => {
  it('uploads, hashes, scans and serves a clean document', async () => {
    const d = await uploadDoc(s, u);
    expect(d.createResponse.body.upload).toMatchObject({ method: 'PUT', via: 'api' });
    expect(d.uploadResponse.status).toBe(200);
    expect(d.uploadResponse.body.status).toBe('UPLOADED'); // HTTP returns before heavy processing
    const v = await waitForVersion(s, u, d.documentId, d.versionId);
    expect(v.status).toBe('AVAILABLE');
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.sha256).toBe((await import('node:crypto')).createHash('sha256').update(PDF).digest('hex'));
    const link = await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/download`)).set(bearer(u.token));
    expect(link.status).toBe(200);
    const bytes = await s.api().get(link.body.url).set(bearer(u.token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(bytes.status).toBe(200);
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect((bytes.body as Buffer).equals(PDF)).toBe(true);
  });
  it('tracks the processing job (status, progress, correlation id) and never exposes payloads', async () => {
    const d = await uploadDoc(s, u);
    await waitForVersion(s, u, d.documentId, d.versionId);
    const jobs = await s.api().get(orgPath(u, '/jobs')).set(bearer(u.token));
    const job = jobs.body.items.find((j: { type: string; status: string }) => j.type === 'document.process' && j.status === 'COMPLETED');
    expect(job).toBeTruthy();
    expect(job.progress).toBe(100);
    expect(job.correlationId).toBeTruthy();
    expect(job.payload).toBeUndefined();
  });
  it('quarantines malware (EICAR) and refuses to serve it', async () => {
    const d = await uploadDoc(s, u, { contentType: 'text/plain', body: EICAR, name: 'bad.txt' });
    const v = await waitForVersion(s, u, d.documentId, d.versionId);
    expect(v.status).toBe('QUARANTINED');
    expect(v.scanResult).toMatch(/malware/);
    const dl = await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/download`)).set(bearer(u.token));
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('document_not_available');
    expect((await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/content`)).set(bearer(u.token))).status).toBe(409);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE entity_id='${d.versionId}' AND action='document.quarantined'`)).toBe('1');
  });
  it('quarantines files whose bytes do not match the declared type', async () => {
    const d = await uploadDoc(s, u, { contentType: 'application/pdf', body: Buffer.from('MZ\x90\x00 this is an exe, not a pdf'), name: 'fake.pdf' });
    const v = await waitForVersion(s, u, d.documentId, d.versionId);
    expect(v.status).toBe('QUARANTINED');
    expect(v.scanResult).toBe('content_type_mismatch');
  });
  it('rejects uploads whose size differs from the declared size', async () => {
    const c = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 999 });
    const up = await s.api().put(c.body.upload.url).set(bearer(u.token)).set('Content-Type', 'application/pdf').send(PDF);
    expect(up.status).toBe(422);
    expect(up.body.code).toBe('size_mismatch');
  });
  it('rejects disallowed content types and oversized declarations', async () => {
    const bad = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 10 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('content_type_not_allowed');
    const big = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: 'x.pdf', contentType: 'application/pdf', sizeBytes: 26 * 1024 * 1024 });
    expect(big.body.code).toBe('file_too_large');
  });
  it('content can only be uploaded once per version (immutability)', async () => {
    const d = await uploadDoc(s, u);
    const again = await s.api().put(`/api/v1/organisations/${u.organisationId}/documents/${d.documentId}/versions/${d.versionId}/content`).set(bearer(u.token)).set('Content-Type', 'application/pdf').send(PDF);
    expect(again.status).toBe(409);
  });
  it('versioning: a new version gets a new key, the first stays intact', async () => {
    const d = await uploadDoc(s, u);
    await waitForVersion(s, u, d.documentId, d.versionId);
    const nv = await s.api().post(orgPath(u, `/documents/${d.documentId}/versions`)).set(bearer(u.token)).send({ contentType: 'application/pdf', sizeBytes: PDF.length });
    expect(nv.status).toBe(201);
    expect(nv.body.version.versionNo).toBe(2);
    expect(nv.body.version.storageKey).not.toBe(adminSql(`SELECT storage_key FROM document_version WHERE id='${d.versionId}'`));
    expect(nv.body.version.storageKey).toContain(`org/${u.organisationId}/doc/${d.documentId}/v2-`);
  });
  it('storage keys are tenant-prefixed', async () => {
    const d = await uploadDoc(s, u);
    expect(adminSql(`SELECT storage_key FROM document_version WHERE id='${d.versionId}'`)).toMatch(new RegExp(`^org/${u.organisationId}/doc/${d.documentId}/v1-`));
  });
  it('archiving works and keeps the record (no deletion)', async () => {
    const d = await uploadDoc(s, u);
    const r = await s.api().post(orgPath(u, `/documents/${d.documentId}/archive`)).set(bearer(u.token));
    expect(r.body.status).toBe('ARCHIVED');
    expect(adminSql(`SELECT count(*) FROM document WHERE id='${d.documentId}'`)).toBe('1');
    expect((await s.api().post(orgPath(u, `/documents/${d.documentId}/versions`)).set(bearer(u.token)).send({ contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(409);
  });
  it('legal hold blocks archiving', async () => {
    const d = await uploadDoc(s, u);
    adminSql(`UPDATE document SET legal_hold=true WHERE id='${d.documentId}'`);
    expect((await s.api().post(orgPath(u, `/documents/${d.documentId}/archive`)).set(bearer(u.token))).body.code).toBe('legal_hold');
  });
  it('document actions are audited', async () => {
    const d = await uploadDoc(s, u);
    await waitForVersion(s, u, d.documentId, d.versionId);
    await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/download`)).set(bearer(u.token));
    const actions = adminSql(`SELECT action FROM audit_event WHERE entity_id IN ('${d.documentId}','${d.versionId}')`);
    expect(actions).toContain('document.created');
    expect(actions).toContain('document.available');
    expect(actions).toContain('document.download_link_issued');
  });
  it('documents can be linked to a company of the same organisation', async () => {
    const co = await makeCompany(s, u);
    const d = await uploadDoc(s, u, { companyId: co.id });
    const list = await s.api().get(orgPath(u, `/documents?companyId=${co.id}`)).set(bearer(u.token));
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([d.documentId]);
  });
});

describe('job API', () => {
  it('echo job: retries with backoff, visible status and attempts', async () => {
    const r = await s.api().post(orgPath(u, '/jobs/echo')).set(bearer(u.token)).send({ message: 'flaky', failTimes: 2 });
    expect(r.status).toBe(202);
    const final = await waitForJob(s, u, r.body.id, ['COMPLETED']);
    expect(final.attempts).toBe(3);
    expect(final.result).toMatchObject({ echoed: 'flaky' });
  });
  it('dead jobs surface as DEAD and can be retried via the API', async () => {
    const r = await s.api().post(orgPath(u, '/jobs/echo')).set(bearer(u.token)).send({ message: 'doomed', failTimes: 10 });
    const dead = await waitForJob(s, u, r.body.id, ['DEAD']);
    expect(dead.error).toMatch(/simulated failure/);
    const retry = await s.api().post(orgPath(u, `/jobs/${r.body.id}/retry`)).set(bearer(u.token));
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('QUEUED');
  });
  it('Idempotency-Key makes retried POSTs safe (single job, replayed response)', async () => {
    const key = `idem-${Math.random()}`;
    const first = await s.api().post(orgPath(u, '/jobs/echo')).set(bearer(u.token)).set('Idempotency-Key', key).send({ message: 'once' });
    const second = await s.api().post(orgPath(u, '/jobs/echo')).set(bearer(u.token)).set('Idempotency-Key', key).send({ message: 'once' });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const different = await s.api().post(orgPath(u, '/jobs/echo')).set(bearer(u.token)).set('Idempotency-Key', key).send({ message: 'changed' });
    expect(different.status).toBe(422);
    expect(different.body.code).toBe('idempotency_key_reused');
  });
  it('unknown job ids 404; malformed ids 400', async () => {
    expect((await s.api().get(orgPath(u, '/jobs/11111111-1111-4111-8111-111111111111')).set(bearer(u.token))).status).toBe(404);
    expect((await s.api().get(orgPath(u, '/jobs/not-a-uuid')).set(bearer(u.token))).status).toBe(400);
  });
});
