import { CanActivate, Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden, patchContext, unauthorized, type AppConfig } from '@uk/core';
import { IS_PUBLIC, RATE_KEY, type RateLimitMeta } from './decorators';
import { CONFIG, RATE_LIMITER } from './tokens';
import type { Limits } from './infra.module';
import { SessionService } from '../auth/session.service';
import type { AppRequest } from './types';

export const SESSION_COOKIE = 'uk_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global guard: (1) rate limits, (2) CSRF origin check, (3) session authentication unless @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMITER) private readonly limits: Limits,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const handler = ctx.getHandler();
    const cls = ctx.getClass();

    const rate = this.reflector.getAllAndOverride<RateLimitMeta | undefined>(RATE_KEY, [handler, cls]);
    if (rate) await this.limits.enforce(`${rate.name}:ip:${req.ip}`, rate.limit, rate.windowSeconds);

    const bearer = req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];

    if (UNSAFE.has(req.method)) {
      const origin = req.header('origin');
      if (origin && !this.config.corsOrigins.includes(origin)) throw forbidden('Origin not allowed', 'origin_not_allowed');
      if (!origin && cookie && !bearer) throw forbidden('Origin header required for cookie-authenticated requests', 'origin_required');
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls]);
    const token = bearer ?? cookie;
    if (!token) {
      if (isPublic) return true;
      throw unauthorized();
    }
    const resolved = await this.sessions.resolve(token);
    if (!resolved) {
      if (isPublic) return true;
      throw unauthorized('Session expired or invalid', 'session_invalid');
    }
    req.auth = { ...resolved, viaCookie: !bearer };
    patchContext({ userId: resolved.userId });
    return true;
  }
}
