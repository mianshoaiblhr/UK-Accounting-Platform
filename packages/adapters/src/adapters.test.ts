import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClamAvScanner, LocalStorage, NoopScanner, sniffMatches } from './index';

describe('LocalStorage', () => {
  const s = new LocalStorage(mkdtempSync(join(tmpdir(), 'st-')));
  it('stores, reads, heads and deletes', async () => {
    await s.putObject('org/a/doc/1', Buffer.from('hello'), 'text/plain');
    expect((await s.getObject('org/a/doc/1')).toString()).toBe('hello');
    expect(await s.headObject('org/a/doc/1')).toEqual({ sizeBytes: 5 });
    await s.deleteObject('org/a/doc/1');
    expect(await s.headObject('org/a/doc/1')).toBeNull();
  });
  it('blocks path traversal', async () => {
    await expect(s.putObject('../../etc/passwd', Buffer.from('x'), 'text/plain')).rejects.toThrow(/Invalid storage key/);
  });
  it('cannot presign (falls back to API streaming)', async () => expect(await s.presignUpload()).toBeNull());
});

describe('antivirus', () => {
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  it('noop scanner flags only EICAR', async () => {
    expect((await new NoopScanner().scan(Buffer.from('fine'))).clean).toBe(true);
    expect(await new NoopScanner().scan(Buffer.from(EICAR))).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });
  const fakeClamd = (reply: string) => new Promise<number>((resolve) => {
    const srv = createServer((sock) => {
      let got = Buffer.alloc(0);
      sock.on('data', (d) => {
        got = Buffer.concat([got, d]);
        if (got.subarray(-4).equals(Buffer.alloc(4))) sock.end(reply + '\0'); // zero-length chunk = end of stream
      });
    }).listen(0, () => resolve((srv.address() as { port: number }).port));
    srv.unref();
  });
  it('speaks clamd INSTREAM: clean', async () => {
    const port = await fakeClamd('stream: OK');
    expect(await new ClamAvScanner('127.0.0.1', port).scan(Buffer.alloc(200_000, 1))).toEqual({ clean: true });
  });
  it('speaks clamd INSTREAM: infected', async () => {
    const port = await fakeClamd('stream: Win.Test.EICAR_HDB-1 FOUND');
    expect(await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'))).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
  });
  it('errors (so the job retries) when clamd is down', async () => {
    await expect(new ClamAvScanner('127.0.0.1', 1).scan(Buffer.from('x'))).rejects.toThrow();
  });
});

describe('content sniffing', () => {
  it('matches declared types to magic bytes', () => {
    expect(sniffMatches('application/pdf', Buffer.from('%PDF-1.7 ...'))).toBe(true);
    expect(sniffMatches('application/pdf', Buffer.from('MZ\x90\x00'))).toBe(false);
    expect(sniffMatches('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(sniffMatches('text/plain', Buffer.from('anything'))).toBeNull();
  });
});
