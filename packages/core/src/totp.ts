import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));
export const totpStep = (nowMs = Date.now(), period = 30): number => Math.floor(nowMs / 1000 / period);

/** RFC 6238 / RFC 4226 (HMAC-SHA1, 6 digits, 30s). */
export function totpAt(secretB32: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Returns the matched step (for replay protection) or null. Window: ±1 step. */
export function verifyTotp(secretB32: string, code: string, opts: { nowMs?: number; window?: number; minStepExclusive?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(opts.nowMs);
  const w = opts.window ?? 1;
  for (let s = now - w; s <= now + w; s++) {
    if (opts.minStepExclusive !== undefined && s <= opts.minStepExclusive) continue;
    if (totpAt(secretB32, s) === code) return s;
  }
  return null;
}

export const otpauthUrl = (issuer: string, account: string, secret: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
