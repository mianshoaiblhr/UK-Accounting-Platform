import { Inject, Injectable } from '@nestjs/common';
import { JobTypes } from '@uk/contracts';
import type { RegisterInput } from '@uk/contracts';
import {
  AppError, badRequest, forbidden, generateToken, getContext, sha256Hex, unauthorized, uuidv7, type AppConfig, type Logger,
} from '@uk/core';
import { Prisma, type Database } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import { AuditService } from '../audit/audit.service';
import type { Limits } from '../common/infra.module';
import { CONFIG, DB, JOBS, LOGGER, RATE_LIMITER } from '../common/tokens';
import { IDENTITY_PROVIDERS, type IdentityProvider } from './identity-provider';
import { MfaService } from './mfa.service';
import { PasswordHasher } from './password-hasher';
import { SessionService } from './session.service';

const HOUR = 3600_000;
const GENERIC_LOGIN_ERROR = 'Invalid credentials, or the account is temporarily locked';

export type SignInResult =
  | { mfaRequired: true; challengeToken: string }
  | { mfaRequired: false; token: string; expiresAt: Date; userId: string };

@Injectable()
export class AuthService {
  private readonly providers: Map<string, IdentityProvider>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(JOBS) private readonly jobs: JobProducer,
    @Inject(RATE_LIMITER) private readonly limits: Limits,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(IDENTITY_PROVIDERS) providers: IdentityProvider[],
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  private mail(to: string, subject: string, text: string, key: string) {
    return this.jobs.enqueue(JobTypes.emailSend, { to, subject, text }, { idempotencyKey: key });
  }

  // ───────────── Registration & email verification ─────────────
  async register(input: RegisterInput): Promise<void> {
    const existing = await this.db.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // Enumeration-safe: identical response; the real owner is told by email.
      await this.audit.record({ action: 'auth.register_existing_email', outcome: 'FAILURE', actorUserId: existing.id });
      await this.mail(existing.email, 'You already have an account',
        `Someone tried to register ${existing.email} again. If this was you, sign in or reset your password at ${this.config.APP_BASE_URL}/login.`,
        `reg-exists:${existing.id}:${Math.floor(Date.now() / HOUR)}`);
      return;
    }
    const passwordHash = await this.hasher.hash(input.password);
    const organisationId = uuidv7();
    let userId: string;
    try {
      const user = await this.db.prisma.user.create({
        data: { email: input.email, displayName: input.displayName, passwordHash, passwordChangedAt: new Date() },
      });
      userId = user.id;
      await this.db.prisma.userIdentity.create({ data: { userId, provider: 'local', subject: userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // lost a race: behave as above
      throw e;
    }
    const ownerRole = await this.db.prisma.role.findFirstOrThrow({ where: { organisationId: null, key: 'owner' } });
    await this.db.tenant({ organisationId, userId }, async (tx) => {
      await tx.organisation.create({ data: { id: organisationId, type: input.organisationType, name: input.organisationName } });
      const m = await tx.membership.create({ data: { organisationId, userId, roleId: ownerRole.id, companyScope: 'ALL' } });
      await this.audit.record({ action: 'organisation.created', organisationId, actorUserId: userId, entityType: 'organisation', entityId: organisationId, metadata: { type: input.organisationType, membershipId: m.id } }, tx);
    });
    await this.audit.record({ action: 'auth.registered', actorUserId: userId });
    await this.sendVerification(userId, input.email);
  }

  private async sendVerification(userId: string, email: string) {
    const token = generateToken();
    await this.db.prisma.authToken.create({
      data: { userId, purpose: 'EMAIL_VERIFICATION', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 24 * HOUR) },
    });
    await this.mail(email, 'Verify your email address',
      `Welcome. Confirm your email address: ${this.config.APP_BASE_URL}/verify-email?token=${token}\nThis link expires in 24 hours.`,
      `verify:${sha256Hex(token)}`);
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.db.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.status === 'ACTIVE') await this.sendVerification(user.id, user.email);
  }

  async verifyEmail(token: string): Promise<void> {
    const rec = await this.consumeToken(token, 'EMAIL_VERIFICATION');
    await this.db.prisma.user.update({ where: { id: rec.userId }, data: { emailVerifiedAt: new Date() } });
    await this.audit.record({ action: 'auth.email_verified', actorUserId: rec.userId });
  }

  /** Atomic single-use: only one concurrent caller can flip usedAt. */
  private async consumeToken(token: string, purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') {
    const tokenHash = sha256Hex(token);
    const rec = await this.db.prisma.authToken.findUnique({ where: { tokenHash } });
    const invalid = new AppError(400, 'invalid_token', 'This link is invalid or has expired');
    if (!rec || rec.purpose !== purpose || rec.usedAt || rec.expiresAt <= new Date()) throw invalid;
    const r = await this.db.prisma.authToken.updateMany({ where: { id: rec.id, usedAt: null }, data: { usedAt: new Date() } });
    if (r.count !== 1) throw invalid;
    return rec;
  }

  // ───────────── Sign-in ─────────────
  async signIn(providerId: string, input: Record<string, unknown>): Promise<SignInResult> {
    const ctx = getContext();
    const provider = this.providers.get(providerId);
    if (!provider) throw badRequest('Unknown identity provider', 'unknown_provider');
    const emailKey = sha256Hex(String(input.email ?? '').toLowerCase()).slice(0, 32);
    await this.limits.enforce(`login:acct:${emailKey}`, 10, 900); // per-account, independent of IP

    const result = await provider.authenticate(input);
    const meta = { emailHash: emailKey, provider: providerId };

    if (result.status !== 'ok') {
      if (result.status === 'invalid' && result.userId) await this.registerFailure(result.userId);
      else await this.audit.record({ action: 'auth.login_failed', outcome: 'FAILURE', metadata: { ...meta, reason: 'unknown_account' } });
      throw unauthorized(GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }

    const user = await this.db.prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({ action: 'auth.login_blocked_locked', outcome: 'DENIED', actorUserId: user.id, metadata: { lockedUntil: user.lockedUntil } });
      throw unauthorized(GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }
    if (!user.emailVerifiedAt) {
      await this.audit.record({ action: 'auth.login_unverified_email', outcome: 'DENIED', actorUserId: user.id });
      throw forbidden('Please verify your email address before signing in', 'email_not_verified');
    }
    if (await this.mfa.isEnabled(user.id)) {
      const challengeToken = generateToken();
      await this.db.prisma.authChallenge.create({
        data: { userId: user.id, tokenHash: sha256Hex(challengeToken), expiresAt: new Date(Date.now() + 5 * 60_000), ip: ctx?.ip },
      });
      await this.audit.record({ action: 'auth.mfa_challenge_issued', actorUserId: user.id });
      return { mfaRequired: true, challengeToken };
    }
    return this.openSession(user.id, `${providerId}`, false);
  }

  async completeMfa(challengeToken: string, code: string): Promise<SignInResult> {
    const ctx = getContext();
    await this.limits.enforce(`mfa:ip:${ctx?.ip}`, 30, 900);
    const ch = await this.db.prisma.authChallenge.findUnique({ where: { tokenHash: sha256Hex(challengeToken) } });
    const invalid = unauthorized('Invalid or expired verification code', 'invalid_mfa');
    if (!ch || ch.usedAt || ch.expiresAt <= new Date() || ch.attempts >= 5) throw invalid;
    const ok = await this.mfa.verifySecondFactor(ch.userId, code);
    if (!ok) {
      const upd = await this.db.prisma.authChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
      await this.audit.record({ action: 'auth.mfa_failed', outcome: 'FAILURE', actorUserId: ch.userId, metadata: { attempts: upd.attempts } });
      if (upd.attempts >= 5) await this.registerFailure(ch.userId);
      throw invalid;
    }
    const claimed = await this.db.prisma.authChallenge.updateMany({ where: { id: ch.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid;
    return this.openSession(ch.userId, 'local', true);
  }

  private async openSession(userId: string, provider: string, mfaVerified: boolean): Promise<SignInResult> {
    const ctx = getContext();
    await this.db.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null, lockoutLevel: 0, lastLoginAt: new Date() } });
    const s = await this.sessions.create(userId, { ip: ctx?.ip, userAgent: ctx?.userAgent, authMethod: mfaVerified ? `${provider}+totp` : provider, mfaVerified });
    await this.audit.record({ action: 'auth.login_succeeded', actorUserId: userId, entityType: 'session', entityId: s.session.id, metadata: { mfa: mfaVerified, provider } });
    return { mfaRequired: false, token: s.token, expiresAt: s.expiresAt, userId };
  }

  /** 5 consecutive failures => lock with exponential duration (15m, 30m, 60m ... capped at 24h). */
  private async registerFailure(userId: string): Promise<void> {
    const u = await this.db.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } });
    await this.audit.record({ action: 'auth.login_failed', outcome: 'FAILURE', actorUserId: userId, metadata: { failures: u.failedLoginCount } });
    if (u.failedLoginCount >= this.config.LOGIN_MAX_FAILURES) {
      const minutes = Math.min(15 * 2 ** u.lockoutLevel, 24 * 60);
      const lockedUntil = new Date(Date.now() + minutes * 60_000);
      await this.db.prisma.user.update({ where: { id: userId }, data: { lockedUntil, failedLoginCount: 0, lockoutLevel: { increment: 1 } } });
      await this.audit.record({ action: 'auth.account_locked', outcome: 'DENIED', actorUserId: userId, metadata: { lockedUntil, minutes } });
    }
  }

  async logout(userId: string, sessionId: string) {
    await this.sessions.revoke(sessionId, userId, 'logout');
    await this.audit.record({ action: 'auth.logout', actorUserId: userId, entityType: 'session', entityId: sessionId });
  }

  // ───────────── Password reset / change ─────────────
  async requestPasswordReset(email: string): Promise<void> {
    await this.limits.enforce(`reset:acct:${sha256Hex(email).slice(0, 32)}`, 3, HOUR / 1000);
    const user = await this.db.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') {
      await this.audit.record({ action: 'auth.password_reset_requested', metadata: { known: false } });
      return;
    }
    const token = generateToken();
    await this.db.prisma.authToken.create({
      data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + HOUR) },
    });
    await this.audit.record({ action: 'auth.password_reset_requested', actorUserId: user.id, metadata: { known: true } });
    await this.mail(user.email, 'Reset your password',
      `Reset your password: ${this.config.APP_BASE_URL}/reset-password?token=${token}\nThis link expires in 1 hour. If you did not request it, ignore this email.`,
      `reset:${sha256Hex(token)}`);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const rec = await this.consumeToken(token, 'PASSWORD_RESET');
    const passwordHash = await this.hasher.hash(newPassword);
    await this.db.prisma.user.update({
      where: { id: rec.userId },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, lockoutLevel: 0, emailVerifiedAt: new Date() },
    });
    await this.sessions.revokeAll(rec.userId, 'password_reset');
    await this.db.prisma.authToken.updateMany({ where: { userId: rec.userId, purpose: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date() } });
    await this.audit.record({ action: 'auth.password_reset', actorUserId: rec.userId });
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string): Promise<void> {
    const user = await this.db.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await this.hasher.verify(user.passwordHash, current))) {
      await this.audit.record({ action: 'auth.password_change_failed', outcome: 'FAILURE', actorUserId: userId });
      throw unauthorized('Current password is incorrect', 'invalid_credentials');
    }
    await this.db.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hasher.hash(next), passwordChangedAt: new Date() } });
    await this.sessions.revokeAll(userId, 'password_changed', sessionId);
    await this.audit.record({ action: 'auth.password_changed', actorUserId: userId });
  }
}
