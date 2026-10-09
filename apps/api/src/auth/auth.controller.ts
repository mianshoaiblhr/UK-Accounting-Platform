import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  changePasswordSchema, forgotPasswordSchema, loginSchema, mfaConfirmSchema, mfaDisableSchema, mfaLoginSchema,
  registerSchema, resendVerificationSchema, resetPasswordSchema, verifyEmailSchema,
} from '@uk/contracts';
import type { z } from 'zod';
import { notFound, type AppConfig } from '@uk/core';
import type { Database } from '@uk/db';
import { Auth, Public, RateLimit } from '../common/decorators';
import { SESSION_COOKIE } from '../common/auth.guard';
import { CONFIG, DB } from '../common/tokens';
import type { AuthInfo } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService, type SignInResult } from './auth.service';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Database,
  ) {}

  private respond(res: Response, r: SignInResult, bearer: boolean) {
    if (r.mfaRequired) return { mfaRequired: true, challengeToken: r.challengeToken };
    res.cookie(SESSION_COOKIE, r.token, {
      httpOnly: true, secure: this.config.isProduction, sameSite: 'strict', path: '/', expires: r.expiresAt,
    });
    return { mfaRequired: false, expiresAt: r.expiresAt, ...(bearer ? { sessionToken: r.token } : {}) };
  }

  @Public() @Post('register') @HttpCode(202) @RateLimit({ name: 'register', limit: 10, windowSeconds: 3600 })
  async register(@Body(new ZodPipe(registerSchema)) body: z.output<typeof registerSchema>) {
    await this.auth.register(body);
    return { message: 'If the address can be registered, a verification email is on its way.' };
  }

  @Public() @Post('verify-email') @HttpCode(200) @RateLimit({ name: 'verify', limit: 20, windowSeconds: 900 })
  async verify(@Body(new ZodPipe(verifyEmailSchema)) b: z.output<typeof verifyEmailSchema>) {
    await this.auth.verifyEmail(b.token);
    return { verified: true };
  }

  @Public() @Post('resend-verification') @HttpCode(202) @RateLimit({ name: 'resend', limit: 5, windowSeconds: 900 })
  async resend(@Body(new ZodPipe(resendVerificationSchema)) b: z.output<typeof resendVerificationSchema>) {
    await this.auth.resendVerification(b.email);
    return { message: 'If the account exists and is unverified, an email has been sent.' };
  }

  @Public() @Post('login') @HttpCode(200) @RateLimit({ name: 'login', limit: 30, windowSeconds: 300 })
  async login(
    @Body(new ZodPipe(loginSchema)) b: z.output<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.signIn('local', b), false);
  }

  @Public() @Post('login/bearer') @HttpCode(200) @RateLimit({ name: 'login', limit: 30, windowSeconds: 300 })
  async loginBearer(@Body(new ZodPipe(loginSchema)) b: z.output<typeof loginSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.signIn('local', b);
    return this.respond(res, r, true);
  }

  @Public() @Post('login/mfa') @HttpCode(200) @RateLimit({ name: 'mfa', limit: 30, windowSeconds: 300 })
  async loginMfa(@Body(new ZodPipe(mfaLoginSchema)) b: z.output<typeof mfaLoginSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.completeMfa(b.challengeToken, b.code), false);
  }

  @Public() @Post('login/mfa/bearer') @HttpCode(200) @RateLimit({ name: 'mfa', limit: 30, windowSeconds: 300 })
  async loginMfaBearer(@Body(new ZodPipe(mfaLoginSchema)) b: z.output<typeof mfaLoginSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.completeMfa(b.challengeToken, b.code), true);
  }

  @Post('logout') @HttpCode(204)
  async logout(@Auth() a: AuthInfo, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(a.userId, a.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Public() @Post('forgot-password') @HttpCode(202) @RateLimit({ name: 'forgot', limit: 10, windowSeconds: 900 })
  async forgot(@Body(new ZodPipe(forgotPasswordSchema)) b: z.output<typeof forgotPasswordSchema>) {
    await this.auth.requestPasswordReset(b.email);
    return { message: 'If an account exists, a reset email has been sent.' };
  }

  @Public() @Post('reset-password') @HttpCode(200) @RateLimit({ name: 'reset', limit: 10, windowSeconds: 900 })
  async reset(@Body(new ZodPipe(resetPasswordSchema)) b: z.output<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(b.token, b.newPassword);
    return { reset: true };
  }

  @Post('change-password') @HttpCode(200)
  async change(@Auth() a: AuthInfo, @Body(new ZodPipe(changePasswordSchema)) b: z.output<typeof changePasswordSchema>) {
    await this.auth.changePassword(a.userId, a.sessionId, b.currentPassword, b.newPassword);
    return { changed: true };
  }

  @Get('me')
  async me(@Auth() a: AuthInfo) {
    const memberships = await this.db.asUser(a.userId, (tx) =>
      tx.organisationMembership.findMany({
        where: { userId: a.userId, status: 'ACTIVE' },
        include: { organisation: { select: { id: true, name: true, type: true } }, role: { select: { key: true, name: true } } },
      }));
    return {
      user: { id: a.userId, email: a.email, displayName: a.displayName },
      mfa: await this.mfa.status(a.userId),
      organisations: memberships.map((m) => ({ ...m.organisation, role: m.role.key, roleName: m.role.name, membershipId: m.id })),
    };
  }

  // ───────────── Sessions ─────────────
  @Get('sessions')
  async listSessions(@Auth() a: AuthInfo) {
    return { items: (await this.sessions.list(a.userId)).map((s) => ({ ...s, current: s.id === a.sessionId })) };
  }

  @Delete('sessions/:sessionId') @HttpCode(204)
  async revokeSession(@Auth() a: AuthInfo, @Param('sessionId') id: string) {
    const r = await this.sessions.revoke(id, a.userId, 'user_revoked');
    if (r.count === 0) throw notFound('Session not found');
  }

  // ───────────── MFA ─────────────
  @Get('mfa') mfaStatus(@Auth() a: AuthInfo) { return this.mfa.status(a.userId); }

  @Post('mfa/enroll') @HttpCode(200)
  mfaEnroll(@Auth() a: AuthInfo) { return this.mfa.beginEnrollment(a.userId, a.email); }

  @Post('mfa/confirm') @HttpCode(200)
  mfaConfirm(@Auth() a: AuthInfo, @Body(new ZodPipe(mfaConfirmSchema)) b: z.output<typeof mfaConfirmSchema>) {
    return this.mfa.confirmEnrollment(a.userId, b.code, a.sessionId);
  }

  @Post('mfa/disable') @HttpCode(204)
  async mfaDisable(@Auth() a: AuthInfo, @Body(new ZodPipe(mfaDisableSchema)) b: z.output<typeof mfaDisableSchema>) {
    await this.mfa.disable(a.userId, b.currentPassword, b.code);
  }
}
