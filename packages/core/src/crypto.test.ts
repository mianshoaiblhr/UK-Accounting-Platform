import { describe, expect, it } from 'vitest';
import { FieldEncryption, generateRecoveryCode, generateToken, safeEqual, sha256Hex } from './crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('FieldEncryption', () => {
  const fe = new FieldEncryption(KEY);
  it('round-trips and never repeats ciphertext', () => {
    const a = fe.encrypt('secret'), b = fe.encrypt('secret');
    expect(a).not.toBe(b);
    expect(fe.decrypt(a)).toBe('secret');
  });
  it('binds ciphertext to its AAD', () => {
    const c = fe.encrypt('secret', 'user-1');
    expect(() => fe.decrypt(c, 'user-2')).toThrow();
  });
  it('detects tampering', () => {
    const parts = fe.encrypt('secret').split(':');
    parts[3] = Buffer.from('xxxxxx').toString('base64');
    expect(() => fe.decrypt(parts.join(':'))).toThrow();
  });
  it('rejects bad keys', () => expect(() => new FieldEncryption('c2hvcnQ=')).toThrow(/32 bytes/));
});

describe('token helpers', () => {
  it('generates unique url-safe tokens with >=256 bits', () => {
    const t = generateToken();
    expect(t).toMatch(/^[\w-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });
  it('hashes deterministically and compares safely', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('recovery codes have the expected shape', () => expect(generateRecoveryCode()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/));
});
