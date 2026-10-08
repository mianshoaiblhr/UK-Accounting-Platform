import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { bearer, createUser, orgPath, startStack, waitForVersion, type Stack, type TestUser } from '../helpers/stack';
import { EICAR } from './contracts';
import { ensureBucket, infra } from './env';

/** The whole document pipeline on REAL storage + REAL antivirus: API -> presigned upload -> queue -> worker -> clamd -> availability. */
describe.skipIf(!infra.s3 || !infra.clam)('document pipeline on real S3 + real ClamAV', () => {
  let s: Stack, u: TestUser;
  beforeAll(async () => {
    await ensureBucket();
    s = await startStack({ STORAGE_DRIVER: 's3', S3_BUCKET: infra.bucket, S3_ENDPOINT: infra.s3!, AV_DRIVER: 'clamav', CLAMAV_HOST: infra.clam!, CLAMAV_PORT: String(infra.clamPort) });
    u = await createUser(s);
  });
  afterAll(() => s.stop());

  async function upload(name: string, contentType: string, body: Buffer) {
    const c = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name, contentType, sizeBytes: body.length });
    expect(c.status).toBe(201);
    expect(c.body.upload.via).toBe('presigned'); // direct-to-storage; the API never proxies bytes
    const put = await fetch(c.body.upload.url, { method: 'PUT', headers: c.body.upload.headers, body });
    expect(put.status).toBe(200);
    const done = await s.api().post(orgPath(u, `/documents/${c.body.document.id}/versions/${c.body.version.id}/complete`)).set(bearer(u.token));
    expect(done.status).toBe(200);
    return { documentId: c.body.document.id as string, versionId: c.body.version.id as string };
  }

  it('clean file: uploaded straight to S3, scanned by clamd, AVAILABLE, downloadable via presigned URL', async () => {
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2_000_000)]);
    const d = await upload('big.pdf', 'application/pdf', body);
    const v = await waitForVersion(s, u, d.documentId, d.versionId);
    expect(v.status).toBe('AVAILABLE');
    const link = await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/download`)).set(bearer(u.token));
    expect(link.body.url).toMatch(/^http/);
    const res = await fetch(link.body.url);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(v.storageKey).toMatch(new RegExp(`^org/${u.organisationId}/`));
  });

  it('EICAR: detected by real clamd, quarantined, never downloadable', async () => {
    const d = await upload('eicar.txt', 'text/plain', Buffer.from(EICAR));
    const v = await waitForVersion(s, u, d.documentId, d.versionId);
    expect(v.status).toBe('QUARANTINED');
    expect(v.scanResult).toMatch(/malware:.*eicar/i);
    expect((await s.api().get(orgPath(u, `/documents/${d.documentId}/versions/${d.versionId}/download`)).set(bearer(u.token))).status).toBe(409);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE entity_id='${d.versionId}' AND action='document.quarantined'`)).toBe('1');
  });

  it('complete without an uploaded object is refused', async () => {
    const c = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: 'ghost.pdf', contentType: 'application/pdf', sizeBytes: 10 });
    const r = await s.api().post(orgPath(u, `/documents/${c.body.document.id}/versions/${c.body.version.id}/complete`)).set(bearer(u.token));
    expect(r.body.code).toBe('upload_missing');
  });
});
