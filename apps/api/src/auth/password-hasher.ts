import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** Argon2id with OWASP-recommended minimum parameters (19 MiB, t=2, p=1) raised to 64 MiB / t=3. */
const OPTS = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 } as const;

@Injectable()
export class PasswordHasher {
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> { return argon2.hash(password, OPTS); }

  async verify(hash: string, password: string): Promise<boolean> {
    try { return await argon2.verify(hash, password); } catch { return false; }
  }

  needsRehash(hash: string): boolean { return argon2.needsRehash(hash, OPTS); }

  /** Spend equivalent CPU for unknown accounts so response timing does not reveal account existence. */
  async burn(password: string): Promise<void> {
    this.dummy ??= this.hash('dummy-password-for-timing');
    await this.verify(await this.dummy, password);
  }
}
