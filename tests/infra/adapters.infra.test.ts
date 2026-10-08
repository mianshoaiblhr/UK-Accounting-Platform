import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { ClamAvScanner, LocalStorage, NoopScanner, S3Storage } from '@uk/adapters';
import { antivirusContract, storageContract } from './contracts';
import { ensureBucket, infra } from './env';

/**
 * Real-infrastructure layer. Fakes keep unit/integration tests fast; THIS layer proves the adapters against the
 * real thing (MinIO/S3 and clamd). CI sets INFRA_* (and INFRA_REQUIRED=1 so a missing service FAILS rather than skips).
 * Locally: see docs/runbooks/infra-tests.md.
 */
describe('infrastructure availability gate', () => {
  it('real S3 and ClamAV are configured when INFRA_REQUIRED=1 (CI / pre-release)', () => {
    if (process.env.INFRA_REQUIRED === '1') { expect(infra.s3, 'INFRA_S3_ENDPOINT').toBeTruthy(); expect(infra.clam, 'INFRA_CLAMAV_HOST').toBeTruthy(); }
  });
});

// Fakes / local adapters: always run (and define the contract)
storageContract('LocalStorage (dev/test adapter)', () => new LocalStorage(mkdtempSync(join(tmpdir(), 'contract-'))));
antivirusContract('NoopScanner (EICAR-only dev adapter)', () => new NoopScanner());

// Real services
const s3 = () => new S3Storage({ bucket: infra.bucket, region: 'eu-west-2', endpoint: infra.s3 });
storageContract('S3Storage against real S3-compatible server', async () => { await ensureBucket(); return s3(); }, { skip: !infra.s3, presigns: true });
antivirusContract('ClamAvScanner against real clamd', () => new ClamAvScanner(infra.clam!, infra.clamPort), { skip: !infra.clam });

describe.skipIf(!infra.s3)('S3Storage specifics (adapter-level; never visible to business code)', () => {
  it('writes objects with server-side encryption', async () => {
    await ensureBucket();
    const client = new S3Client({ region: 'eu-west-2', endpoint: infra.s3, forcePathStyle: true });
    const st = s3(), key = `org/sse/${Date.now()}`;
    await st.putObject(key, Buffer.from('secret'), 'text/plain');
    const head = await client.send(new HeadObjectCommand({ Bucket: infra.bucket, Key: key }));
    expect(head.ServerSideEncryption).toBeTruthy();
  });
  it('rejects expired presigned URLs on servers that enforce signatures (MinIO/S3)', async () => {
    if (process.env.INFRA_ENFORCES_SIGNATURES !== '1') return; // moto (local stand-in) does not validate signatures
    await ensureBucket();
    const st = s3(), key = `org/exp/${Date.now()}`;
    await st.putObject(key, Buffer.from('x'), 'text/plain');
    const url = (await st.presignDownload(key, 'f.txt', 1))!;
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(url)).status).toBeGreaterThanOrEqual(400);
  });
});

describe.skipIf(!infra.clam)('ClamAV specifics', () => {
  it('fails loudly when the daemon is unreachable so jobs retry', async () => {
    await expect(new ClamAvScanner('127.0.0.1', 1).scan(Buffer.from('x'))).rejects.toThrow();
  });
});
