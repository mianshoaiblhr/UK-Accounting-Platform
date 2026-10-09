import { CanActivate, Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureKey } from '@uk/contracts';
import { AppError } from '@uk/core';
import type { FeatureFlagService } from '@uk/platform';
import { FEATURE_KEY } from './decorators';
import { FEATURES } from './tokens';
import type { AppRequest } from './types';

/** Runs after OrgGuard (the organisation is known). A disabled feature is a clear 403, never a silent 404. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(FEATURES) private readonly features: FeatureFlagService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!key) return true;
    const org = ctx.switchToHttp().getRequest<AppRequest>().org;
    if (!org) throw new AppError(500, 'feature_without_organisation', 'RequireFeature needs an organisation-scoped route');
    if (await this.features.isEnabled(key, org.organisationId)) return true;
    throw new AppError(403, 'feature_disabled', `The "${key}" feature is not enabled for this organisation`);
  }
}
