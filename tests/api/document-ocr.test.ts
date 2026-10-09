import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** The OCR-ready pipeline: flag-gated, tenant-scoped, visibility-aware, data only. */
let s: Stack;
let owner: TestUser, accountant: TestUser, bookkeeper: TestUser, outsider: TestUser;
let co: { id: string };
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 20_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n(${marker})\ntrailer<<>>\n%%EOF`);
const upload = async (u: TestUser, marker: string, o: { companyId?: string; contentType?: string; name?: string; body?: Buffer } = {}) => {
  const d = await uploadDoc(s, u, { companyId: o.companyId ?? co.id, body: o.body ?? pdf(marker), contentType: o.contentType, name: o.name });
  await waitForVersion(s, u, d.documentId, d.versionId);
  return d;
};
const extractions = async (u: TestUser, d: { documentId: string; versionId: string }, text = false) =>
  (await call(u, 'get', `/documents/${d.documentId}/versions/${d.versionId}/extraction${text ? '?text=true' : ''}`)).body.items as Array<Record<string, any>>;
const setFlag = (enabled: boolean) => call(owner, 'put', '/feature-flags/documents.ocr', { enabled, reason: 'test' });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  co = await makeCompany(s, owner, 'OCR Co Ltd');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  outsider = await createUser(s, { type: 'BUSINESS' });
});
afterAll(() => s.stop());

describe('feature flag documents.ocr (default off)', () => {
  it('nothing is extracted and extraction cannot be requested while the flag is off', async () => {
    const d = await upload(bookkeeper, 'FLAG-OFF-MARKER');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await extractions(bookkeeper, d)).toEqual([]);
    const r = await call(bookkeeper, 'post', `/documents/${d.documentId}/versions/${d.versionId}/extract`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('feature_disabled');
  });
});

describe('with the flag on', () => {
  beforeAll(async () => { expect((await setFlag(true)).status).toBe(200); });
  afterAll(async () => { await setFlag(false); });

  it('a clean upload is extracted automatically; text is data, returned only on request, and reading it is audited', async () => {
    const d = await upload(bookkeeper, 'INVOICE-TOTAL-1234.56');
    const e = await until(async () => (await extractions(bookkeeper, d)).find((x) => x.status === 'SUCCEEDED'));
    expect(e).toMatchObject({ provider: 'fake', pageCount: 1, truncated: false, charCount: expect.any(Number), documentVersionId: d.versionId });
    expect(e.text).toBeUndefined();
    const withText = (await extractions(bookkeeper, d, true))[0]!;
    expect(withText.text).toContain('INVOICE-TOTAL-1234.56');
    const audit = (await call(owner, 'get', '/audit-events?limit=100')).body.items.filter((x: { entityId: string }) => x.entityId === d.versionId);
    expect(audit.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['document.extracted', 'document.extraction_read']));
    expect(JSON.stringify(audit)).not.toContain('INVOICE-TOTAL'); // the text never reaches the audit trail
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE event_type='document.extracted' AND aggregate_id='${d.versionId}'`)).toBe('1');
  });

  it('requesting extraction again is idempotent and never overwrites a completed result', async () => {
    const d = await upload(bookkeeper, 'IDEMPOTENT-MARKER');
    const first = await until(async () => (await extractions(bookkeeper, d)).find((x) => x.status === 'SUCCEEDED'));
    const again = await call(bookkeeper, 'post', `/documents/${d.documentId}/versions/${d.versionId}/extract`);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ id: first.id, status: 'SUCCEEDED' });
    expect(adminSql(`SELECT count(*) FROM document_extraction WHERE document_version_id='${d.versionId}'`)).toBe('1');
    expect(() => adminSql(`UPDATE document_extraction SET text='tampered' WHERE id='${first.id}'`)).toThrow(/final/);
  });

  it('an engine failure is recorded, retried, and a manual request recovers', async () => {
    (s.worker.ocr as unknown as { failTimes: number }).failTimes = 1; // the next engine call fails once
    const d = await upload(bookkeeper, 'RETRY-MARKER');
    const failed = await until(async () => (await extractions(bookkeeper, d)).find((x) => x.status === 'FAILED'));
    expect(failed.error).toContain('fake OCR engine unavailable');
    const r = await call(bookkeeper, 'post', `/documents/${d.documentId}/versions/${d.versionId}/extract`);
    expect(r.status).toBe(202);
    const ok = await until(async () => (await extractions(bookkeeper, d)).find((x) => x.status === 'SUCCEEDED'));
    expect(ok.id).toBe(failed.id); // one row per version and engine
    expect((await extractions(bookkeeper, d, true))[0]!.text).toContain('RETRY-MARKER');
  });

  it('quarantined files are never read; unsupported types are skipped', async () => {
    const bad = await uploadDoc(s, bookkeeper, { companyId: co.id, contentType: 'text/plain', body: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), name: 'bad.txt' });
    await waitForVersion(s, bookkeeper, bad.documentId, bad.versionId);
    expect(await extractions(bookkeeper, bad)).toEqual([]);
    expect((await call(bookkeeper, 'post', `/documents/${bad.documentId}/versions/${bad.versionId}/extract`)).body.code).toBe('document_not_available');
    const txt = await uploadDoc(s, bookkeeper, { companyId: co.id, contentType: 'text/plain', body: Buffer.from('plain text is not OCR material'), name: 'note.txt' });
    await waitForVersion(s, bookkeeper, txt.documentId, txt.versionId);
    expect(await extractions(bookkeeper, txt)).toEqual([]); // not queued automatically
    expect((await call(bookkeeper, 'post', `/documents/${txt.documentId}/versions/${txt.versionId}/extract`)).status).toBe(202);
    const skipped = await until(async () => (await extractions(bookkeeper, txt)).find((x) => x.status === 'SKIPPED'));
    expect(skipped.error).toContain('not supported');
  });

  it('extraction follows document visibility and tenancy: invisible documents have no extraction either', async () => {
    const d = await upload(accountant, 'SECRET-ACCOUNTS-MARKER');
    await until(async () => (await extractions(accountant, d)).find((x) => x.status === 'SUCCEEDED'));
    expect((await call(accountant, 'patch', `/documents/${d.documentId}`, { visibility: 'RESTRICTED' })).status).toBe(200);
    expect((await call(bookkeeper, 'get', `/documents/${d.documentId}/versions/${d.versionId}/extraction?text=true`)).status).toBe(404);
    expect((await call(bookkeeper, 'post', `/documents/${d.documentId}/versions/${d.versionId}/extract`)).status).toBe(404);
    expect((await s.api().get(orgPath(owner, `/documents/${d.documentId}/versions/${d.versionId}/extraction`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await extractions(accountant, d, true))[0]!.text).toContain('SECRET-ACCOUNTS-MARKER');
  });
});

describe('switching the flag off stops the pipeline', () => {
  it('uploads made after the switch-off are not extracted and manual requests are refused', async () => {
    expect((await setFlag(true)).status).toBe(200);
    expect((await setFlag(false)).status).toBe(200);
    const d = await upload(bookkeeper, 'AFTER-OFF-MARKER');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await extractions(bookkeeper, d)).toEqual([]);
    expect((await call(bookkeeper, 'post', `/documents/${d.documentId}/versions/${d.versionId}/extract`)).status).toBe(403);
  });
});
