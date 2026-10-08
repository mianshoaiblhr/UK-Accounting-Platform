import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AntivirusPort, StoragePort } from '@uk/adapters';

/**
 * Adapter CONTRACTS. The same suite runs against the in-process fake/local adapter AND the real service, so
 * the fake can never drift from reality: business code written against the port is correct for both.
 */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export function storageContract(label: string, make: () => StoragePort | Promise<StoragePort>, opts: { skip?: boolean; presigns?: boolean } = {}) {
  describe.skipIf(opts.skip)(`StoragePort contract: ${label}`, () => {
    const key = (n: string) => `org/test-org/doc/${randomBytes(6).toString('hex')}/${n}`;

    it('round-trips binary content exactly', async () => {
      const s = await make(), k = key('v1-a'), data = randomBytes(300_000);
      await s.putObject(k, data, 'application/octet-stream');
      expect((await s.getObject(k)).equals(data)).toBe(true);
    });
    it('reports size via headObject and null for missing keys', async () => {
      const s = await make(), k = key('v1-b');
      await s.putObject(k, Buffer.from('12345'), 'text/plain');
      expect(await s.headObject(k)).toEqual({ sizeBytes: 5 });
      expect(await s.headObject(key('nope'))).toBeNull();
    });
    it('getObject on a missing key rejects', async () => {
      await expect((await make()).getObject(key('missing'))).rejects.toThrow();
    });
    it('handles keys with unicode, spaces and deep prefixes', async () => {
      const s = await make(), k = `org/tést org/doc/ä b/v1-ü ${randomBytes(3).toString('hex')}`;
      await s.putObject(k, Buffer.from('ok'), 'text/plain');
      expect((await s.getObject(k)).toString()).toBe('ok');
    });
    it('stores multi-megabyte objects', async () => {
      const s = await make(), k = key('big'), data = randomBytes(6 * 1024 * 1024);
      await s.putObject(k, data, 'application/octet-stream');
      expect((await s.headObject(k))!.sizeBytes).toBe(data.length);
      expect((await s.getObject(k)).subarray(0, 1024).equals(data.subarray(0, 1024))).toBe(true);
    });
    it('deleteObject removes the object (or hides it, on versioned buckets)', async () => {
      const s = await make(), k = key('del');
      await s.putObject(k, Buffer.from('x'), 'text/plain');
      await s.deleteObject(k);
      expect(await s.headObject(k)).toBeNull();
    });
    it.skipIf(!opts.presigns)('presigned upload then presigned download work without credentials', async () => {
      const s = await make(), k = key('presigned'), data = randomBytes(10_000);
      const up = await s.presignUpload(k, 'application/pdf', 300);
      expect(up).not.toBeNull();
      const put = await fetch(up!.url, { method: up!.method, headers: up!.headers, body: data });
      expect(put.status).toBe(200);
      expect((await s.getObject(k)).equals(data)).toBe(true);
      const url = await s.presignDownload(k, 'report "Q1".pdf', 300);
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
    });
    it.skipIf(opts.presigns)('adapters that cannot presign say so (callers fall back to API streaming)', async () => {
      const s = await make();
      expect(await s.presignUpload(key('x'), 'text/plain', 60)).toBeNull();
      expect(await s.presignDownload(key('x'), 'f', 60)).toBeNull();
    });
  });
}

export function antivirusContract(label: string, make: () => AntivirusPort, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`AntivirusPort contract: ${label}`, () => {
    it('passes clean content', async () => expect(await make().scan(Buffer.from('hello world, nothing to see'))).toEqual({ clean: true }));
    it('passes empty content', async () => expect((await make().scan(Buffer.alloc(0))).clean).toBe(true));
    it('passes large clean binary content (streamed in chunks)', async () => expect((await make().scan(randomBytes(8 * 1024 * 1024))).clean).toBe(true));
    it('detects the EICAR test file and names the signature', async () => {
      const r = await make().scan(Buffer.from(EICAR));
      expect(r.clean).toBe(false);
      expect(r.signature).toMatch(/eicar/i);
    });
    // NOTE: detection of a signature buried inside arbitrary binary data is NOT part of the contract. The official ClamAV
    // database matches the EICAR file as a whole (verified against the real daemon in CI); a lenient local stand-in
    // signature would mask that, so we only assert what every compliant scanner must do.
  });
}
