import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

/** URL-safe random token with >= 256 bits of entropy. Store only `sha256Hex(token)`. */
export const generateToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Human-friendly one-time recovery code, e.g. "k3f9-a82b-qq1x". */
export const generateRecoveryCode = (): string => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chunk = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${chunk()}-${chunk()}-${chunk()}`;
};

/** AES-256-GCM envelope for secrets stored in the database (TOTP seeds, integration tokens later). */
export class FieldEncryption {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64)');
  }
  encrypt(plain: string, aad = ''): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }
  decrypt(payload: string, aad = ''): string {
    const [v, iv, tag, ct] = payload.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}
