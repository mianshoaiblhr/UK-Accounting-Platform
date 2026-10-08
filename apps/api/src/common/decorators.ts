import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@uk/contracts';
import type { AppRequest } from './types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMS_KEY = 'requiredPermissions';
/** Marks a route as organisation-scoped and lists the permissions the caller's role must hold (ALL of them). */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMS_KEY, p);

export const RATE_KEY = 'rateLimit';
export interface RateLimitMeta { name: string; limit: number; windowSeconds: number }
export const RateLimit = (meta: RateLimitMeta) => SetMetadata(RATE_KEY, meta);

export const IDEMPOTENT = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Org = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().org!);
