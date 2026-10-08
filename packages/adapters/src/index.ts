import type { AppConfig, Logger } from '@uk/core';
import { ClamAvScanner, NoopScanner, type AntivirusPort } from './antivirus';
import { ConsoleEmail, FileEmail, MemoryEmail, SesEmail, type EmailPort } from './email';
import { LocalStorage, S3Storage, type StoragePort } from './storage';

export * from './storage';
export * from './antivirus';
export * from './email';

/** Driver selection lives here (and only here) so no other code knows which cloud it runs on. */
export function createStorage(c: AppConfig): StoragePort {
  return c.STORAGE_DRIVER === 's3'
    ? new S3Storage({ bucket: c.S3_BUCKET!, region: c.AWS_REGION, endpoint: c.S3_ENDPOINT, kmsKeyId: process.env.S3_KMS_KEY_ID })
    : new LocalStorage(c.STORAGE_LOCAL_DIR);
}
export function createAntivirus(c: AppConfig): AntivirusPort {
  return c.AV_DRIVER === 'clamav' ? new ClamAvScanner(c.CLAMAV_HOST, c.CLAMAV_PORT) : new NoopScanner();
}
export function createEmail(c: AppConfig, logger: Logger): EmailPort {
  switch (c.EMAIL_DRIVER) {
    case 'ses': return new SesEmail(c.AWS_REGION, c.EMAIL_FROM);
    case 'file': return new FileEmail(c.EMAIL_FILE_DIR);
    case 'memory': return new MemoryEmail();
    default: return new ConsoleEmail(logger);
  }
}
export * from './sniff';
