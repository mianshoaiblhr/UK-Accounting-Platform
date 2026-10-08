import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@uk/db';
import { DB } from '../common/tokens';
import { PasswordHasher } from './password-hasher';

/**
 * Seam for external identity: Microsoft Entra ID, Google Workspace, Auth0, SAML...
 * A provider proves who the caller is; AuthService then applies the SAME lockout, MFA and session
 * policy to every provider. To add one: implement this interface, register it in AuthModule, and
 * link subjects through `user_identity(provider, subject)`.
 */
export interface IdentityProvider {
  readonly id: string;
  authenticate(input: Record<string, unknown>): Promise<ProviderResult>;
}
export type ProviderResult =
  | { status: 'ok'; userId: string }
  /** Credentials rejected; userId (when known) feeds the lockout counter. */
  | { status: 'invalid'; userId?: string }
  | { status: 'unknown' };

export const IDENTITY_PROVIDERS = Symbol('IDENTITY_PROVIDERS');

@Injectable()
export class LocalPasswordProvider implements IdentityProvider {
  readonly id = 'local';
  constructor(@Inject(DB) private readonly db: Database, private readonly hasher: PasswordHasher) {}

  async authenticate(input: Record<string, unknown>): Promise<ProviderResult> {
    const email = String(input.email ?? '').toLowerCase();
    const password = String(input.password ?? '');
    const user = await this.db.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      await this.hasher.burn(password);
      return { status: 'unknown' };
    }
    if (user.status !== 'ACTIVE') { await this.hasher.burn(password); return { status: 'invalid' }; }
    const ok = await this.hasher.verify(user.passwordHash, password);
    if (!ok) return { status: 'invalid', userId: user.id };
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.db.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.hasher.hash(password) } });
    }
    return { status: 'ok', userId: user.id };
  }
}
