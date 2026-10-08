import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, totpAt, verifyTotp } from './totp';

// RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890"), 8-digit truncated to 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'],
  ])('matches RFC vector at t=%i', (t, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(t / 30))).toBe(code);
  });
  it('base32 round-trips', () => {
    const raw = Buffer.from('hello world, totp!');
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
  });
  it('accepts ±1 step, rejects further drift', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(s, totpAt(s, step), { nowMs: now })).toBe(step);
    expect(verifyTotp(s, totpAt(s, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step + 2), { nowMs: now })).toBeNull();
  });
  it('blocks replay of an already-used step', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(s, totpAt(s, step), { nowMs: now, minStepExclusive: step })).toBeNull();
  });
  it('rejects malformed codes', () => {
    expect(verifyTotp(generateTotpSecret(), '12345')).toBeNull();
    expect(verifyTotp(generateTotpSecret(), 'abcdef')).toBeNull();
  });
});
