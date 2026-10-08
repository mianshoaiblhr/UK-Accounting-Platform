import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgresql://x', FIELD_ENCRYPTION_KEY: 'k' };
const prod = {
  ...base, NODE_ENV: 'production', AWS_REGION: 'eu-west-2', STORAGE_DRIVER: 's3', S3_BUCKET: 'b',
  EMAIL_DRIVER: 'ses', AV_DRIVER: 'clamav',
};

describe('config', () => {
  it('applies UK defaults', () => expect(loadConfig(base).AWS_REGION).toBe('eu-west-2'));
  it('fails fast on missing required variables', () => expect(() => loadConfig({})).toThrow(/DATABASE_URL/));
  it('accepts a hardened production config in eu-west-2', () => expect(loadConfig(prod).isProduction).toBe(true));
  it('data residency: production refuses non-approved regions', () => {
    expect(() => loadConfig({ ...prod, AWS_REGION: 'us-east-1' })).toThrow(/DATA_RESIDENCY_REGIONS/);
  });
  it('residency list is configurable for future DR regions without code changes', () => {
    expect(loadConfig({ ...prod, AWS_REGION: 'eu-west-1', DATA_RESIDENCY_REGIONS: 'eu-west-2,eu-west-1' }).AWS_REGION).toBe('eu-west-1');
  });
  it.each([
    [{ STORAGE_DRIVER: 'local' }, /s3/], [{ EMAIL_DRIVER: 'file' }, /EMAIL_DRIVER/],
    [{ AV_DRIVER: 'noop' }, /clamav/], [{ RATE_LIMIT_ENABLED: 'false' }, /rate limiting/],
  ])('production rejects unsafe drivers %j', (o, re) => expect(() => loadConfig({ ...prod, ...o })).toThrow(re));
});
