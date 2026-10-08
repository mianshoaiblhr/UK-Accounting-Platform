import { Inject, Injectable } from '@nestjs/common';
import {
  FieldEncryption, badRequest, generateRecoveryCode, generateTotpSecret, otpauthUrl, sha256Hex, totpStep, unauthorized, verifyTotp,
} from '@uk/core';
import type { Database } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { CRYPTO, DB } from '../common/tokens';
import { PasswordHasher } from './password-hasher';

const ISSUER = 'UK Accounting Platform';

/**
 * MFA is a first-class capability: factors live in `mfa_factor` (type TOTP today; WebAuthn/SMS later add
 * enum values + a verifier here without touching login flow). Recovery codes are single-use.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CRYPTO) private readonly crypto: FieldEncryption,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.db.prisma.mfaFactor.count({ where: { userId, status: 'ACTIVE' } })) > 0;
  }

  async status(userId: string) {
    const [factor, remaining] = await Promise.all([
      this.db.prisma.mfaFactor.findFirst({ where: { userId, status: 'ACTIVE' } }),
      this.db.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return { enabled: !!factor, type: factor?.type ?? null, recoveryCodesRemaining: remaining };
  }

  async beginEnrollment(userId: string, email: string) {
    if (await this.isEnabled(userId)) throw badRequest('MFA is already enabled', 'mfa_already_enabled');
    const secret = generateTotpSecret();
    await this.db.prisma.$transaction([
      this.db.prisma.mfaFactor.deleteMany({ where: { userId, status: 'PENDING' } }),
      this.db.prisma.mfaFactor.create({ data: { userId, secretEncrypted: this.crypto.encrypt(secret, userId) } }),
    ]);
    await this.audit.record({ action: 'mfa.enrolment_started', actorUserId: userId });
    return { secret, otpauthUrl: otpauthUrl(ISSUER, email, secret) };
  }

  async confirmEnrollment(userId: string, code: string, sessionId: string) {
    const pending = await this.db.prisma.mfaFactor.findFirst({ where: { userId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (!pending) throw badRequest('No MFA enrolment in progress', 'mfa_not_pending');
    const step = verifyTotp(this.crypto.decrypt(pending.secretEncrypted, userId), code);
    if (step === null) {
      await this.audit.record({ action: 'mfa.enrolment_failed', outcome: 'FAILURE', actorUserId: userId });
      throw badRequest('Invalid code', 'invalid_mfa_code');
    }
    const codes = Array.from({ length: 10 }, generateRecoveryCode);
    await this.db.prisma.$transaction([
      this.db.prisma.mfaFactor.update({ where: { id: pending.id }, data: { status: 'ACTIVE', confirmedAt: new Date(), lastUsedStep: BigInt(step) } }),
      this.db.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.db.prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256Hex(c) })) }),
      this.db.prisma.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: new Date() } }),
    ]);
    await this.audit.record({ action: 'mfa.enabled', actorUserId: userId });
    return { recoveryCodes: codes }; // shown exactly once
  }

  async disable(userId: string, password: string, code: string) {
    const user = await this.db.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await this.hasher.verify(user.passwordHash, password))) {
      await this.audit.record({ action: 'mfa.disable_failed', outcome: 'FAILURE', actorUserId: userId });
      throw unauthorized('Invalid credentials', 'invalid_credentials');
    }
    if (!(await this.verifySecondFactor(userId, code))) {
      await this.audit.record({ action: 'mfa.disable_failed', outcome: 'FAILURE', actorUserId: userId });
      throw badRequest('Invalid code', 'invalid_mfa_code');
    }
    await this.db.prisma.$transaction([
      this.db.prisma.mfaFactor.updateMany({ where: { userId }, data: { status: 'DISABLED' } }),
      this.db.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    ]);
    await this.audit.record({ action: 'mfa.disabled', actorUserId: userId });
  }

  /** TOTP (with replay protection) or a single-use recovery code. */
  async verifySecondFactor(userId: string, code: string): Promise<boolean> {
    const factor = await this.db.prisma.mfaFactor.findFirst({ where: { userId, status: 'ACTIVE' } });
    if (!factor) return false;
    const normalized = code.trim().toLowerCase();
    if (/^\d{6}$/.test(normalized)) {
      const last = factor.lastUsedStep === null ? undefined : Number(factor.lastUsedStep);
      const step = verifyTotp(this.crypto.decrypt(factor.secretEncrypted, userId), normalized, { minStepExclusive: last });
      if (step === null) return false;
      // Conditional update => a code (step) can be used once even under concurrent requests.
      const r = await this.db.prisma.mfaFactor.updateMany({
        where: { id: factor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
        data: { lastUsedStep: BigInt(step) },
      });
      return r.count === 1;
    }
    const r = await this.db.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: sha256Hex(normalized), usedAt: null }, data: { usedAt: new Date() },
    });
    if (r.count === 1) await this.audit.record({ action: 'mfa.recovery_code_used', actorUserId: userId });
    return r.count === 1;
  }

  currentStep = totpStep;
}
