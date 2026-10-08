import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedUpload { method: 'PUT'; url: string; headers: Record<string, string> }

/** Provider-neutral object storage. Application code never imports AWS directly. */
export interface StoragePort {
  readonly driver: 'local' | 's3';
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<{ sizeBytes: number } | null>;
  /** null => the adapter cannot presign; callers fall back to streaming through the API. */
  presignUpload(key: string, contentType: string, expiresSeconds: number): Promise<PresignedUpload | null>;
  presignDownload(key: string, filename: string, expiresSeconds: number): Promise<string | null>;
  deleteObject(key: string): Promise<void>;
}

export class LocalStorage implements StoragePort {
  readonly driver = 'local' as const;
  constructor(private readonly root: string) {}
  private path(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root) + sep)) throw new Error('Invalid storage key'); // path traversal guard
    return p;
  }
  async putObject(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  getObject(key: string): Promise<Buffer> { return readFile(this.path(key)); }
  async headObject(key: string) {
    try { return { sizeBytes: (await stat(this.path(key))).size }; } catch { return null; }
  }
  async presignUpload() { return null; }
  async presignDownload() { return null; }
  async deleteObject(key: string) { await rm(this.path(key), { force: true }); }
  stream(key: string) { return createReadStream(this.path(key)); }
}

export interface S3Options { bucket: string; region: string; endpoint?: string; kmsKeyId?: string }

export class S3Storage implements StoragePort {
  readonly driver = 's3' as const;
  private readonly s3: S3Client;
  constructor(private readonly opts: S3Options) {
    this.s3 = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint });
  }
  private sse() {
    return this.opts.kmsKeyId
      ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: this.opts.kmsKeyId }
      : { ServerSideEncryption: 'AES256' as const };
  }
  async putObject(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentType: contentType, ...this.sse() }));
  }
  async getObject(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async headObject(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { sizeBytes: r.ContentLength ?? 0 };
    } catch { return null; }
  }
  async presignUpload(key: string, contentType: string, expiresSeconds: number): Promise<PresignedUpload> {
    const cmd = new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, ContentType: contentType, ...this.sse() });
    const headers: Record<string, string> = { 'Content-Type': contentType, 'x-amz-server-side-encryption': this.sse().ServerSideEncryption };
    if (this.opts.kmsKeyId) headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.opts.kmsKeyId;
    return { method: 'PUT', url: await getSignedUrl(this.s3, cmd, { expiresIn: expiresSeconds }), headers };
  }
  async presignDownload(key: string, filename: string, expiresSeconds: number) {
    const cmd = new GetObjectCommand({
      Bucket: this.opts.bucket, Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
    });
    return getSignedUrl(this.s3, cmd, { expiresIn: expiresSeconds });
  }
  async deleteObject(key: string) {
    // Buckets use Object Lock/versioning; deletion is a soft delete marker only.
    await this.s3.send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
