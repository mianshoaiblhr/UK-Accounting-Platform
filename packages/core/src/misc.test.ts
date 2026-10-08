import { describe, expect, it } from 'vitest';
import { passwordSchema } from './password-policy';
import { redact } from './redact';
import { uuidv7 } from './ids';
import { getCorrelationId, runWithContext } from './context';

describe('password policy', () => {
  it.each(['short', 'password123', 'aaaaaaaaaaaaaaaa', 'x'.repeat(129)])('rejects %s', (p) => expect(passwordSchema.safeParse(p).success).toBe(false));
  it('accepts a long passphrase', () => expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true));
});

describe('redact', () => {
  it('masks secrets recursively', () => {
    expect(redact({ a: 1, password: 'p', nested: { token: 't', list: [{ secret: 's', ok: 1 }] } })).toEqual({
      a: 1, password: '[REDACTED]', nested: { token: '[REDACTED]', list: [{ secret: '[REDACTED]', ok: 1 }] },
    });
  });
});

describe('uuidv7', () => {
  it('is v7 and time ordered', () => {
    const a = uuidv7(1_000_000), b = uuidv7(2_000_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('correlation context', () => {
  it('propagates through async calls', async () => {
    await runWithContext({ correlationId: 'abc-123-xyz' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getCorrelationId()).toBe('abc-123-xyz');
    });
  });
});
