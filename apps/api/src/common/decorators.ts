import { SetMetadata, applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiExtension, ApiHeader } from '@nestjs/swagger';
import type { FeatureKey, Permission } from '@uk/contracts';
import type { AppRequest } from './types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC, true), ApiExtension('x-public', true));

export const PERMS_KEY = 'requiredPermissions';
/** Marks a route as organisation-scoped and lists the permissions the caller's role must hold (ALL of them). */
export const RequirePermissions = (...p: Permission[]) => applyDecorators(SetMetadata(PERMS_KEY, p), ApiExtension('x-required-permissions', p));

export const FEATURE_KEY = 'requiredFeature';
/** The route is available only while the feature flag is enabled for the caller's organisation (403 `feature_disabled` otherwise). */
export const RequireFeature = (key: FeatureKey) => applyDecorators(SetMetadata(FEATURE_KEY, key), ApiExtension('x-required-feature', key));

export const RATE_KEY = 'rateLimit';
export interface RateLimitMeta { name: string; limit: number; windowSeconds: number }
export const RateLimit = (meta: RateLimitMeta) => SetMetadata(RATE_KEY, meta);

export const IDEMPOTENT = 'idempotent';
export const Idempotent = () => applyDecorators(SetMetadata(IDEMPOTENT, true), ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Makes retries safe: a repeated request with the same key and body replays the first response (24h).' }));

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Org = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().org!);
