import { CanActivate, Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { holdsAnywhere, PERMISSION_SCOPE, type Permission } from '@uk/contracts';
import { forbidden, notFound, patchContext, unauthorized } from '@uk/core';
import type { Database } from '@uk/db';
import { loadAccess } from './access';
import { PERMS_KEY } from './decorators';
import { DB } from './tokens';
import { AuditService } from '../audit/audit.service';
import type { AppRequest } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant guard for routes declaring @RequirePermissions(). The organisation comes from the path but is
 * only trusted after matching an ACTIVE membership of the authenticated user; PostgreSQL RLS is the backstop.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest & { params: Record<string, string> }>();
    const auth = req.auth;
    if (!auth) throw unauthorized();
    const organisationId = req.params.organisationId;
    if (!organisationId || !UUID.test(organisationId)) throw notFound('Organisation not found');

    const deny = (d: { permission: Permission; target: object }) =>
      this.audit.record({ action: 'access.denied', outcome: 'DENIED', organisationId, companyId: (d.target as { companyId?: string }).companyId ?? null, actorUserId: auth.userId, metadata: { reason: 'missing_permission', missing: [d.permission], target: d.target, path: req.path } });
    const loaded = await loadAccess(this.db, organisationId, auth.userId, deny);
    if (!loaded) {
      await this.audit.record({ action: 'access.denied', outcome: 'DENIED', organisationId, actorUserId: auth.userId, metadata: { reason: 'not_a_member', path: req.path } });
      throw notFound('Organisation not found'); // do not reveal whether the organisation exists
    }
    const { access } = loaded;
    // Route-level gate: the user must hold every required permission for at least one target...
    const missing = required.filter((p) => !holdsAnywhere(access.snapshot, p));
    if (missing.length) {
      // Attribute the denial to the company named in the path - only if it really is one of this organisation's companies.
      const named = req.params.companyId && UUID.test(req.params.companyId) ? await access.companyRef(req.params.companyId) : null;
      await this.audit.record({ action: 'access.denied', outcome: 'DENIED', organisationId, companyId: named?.id ?? null, actorUserId: auth.userId, metadata: { reason: 'missing_permission', missing, path: req.path } });
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
    // ...and when the route names a company or practice, for exactly that target.
    const { companyId, practiceId } = req.params;
    for (const p of required) {
      const scope = PERMISSION_SCOPE[p];
      // Malformed ids are left to ParseUUIDPipe (400); they can never match a row.
      if (scope === 'COMPANY' && companyId && UUID.test(companyId)) await access.requireCompany(p, companyId);
      if (scope === 'PRACTICE' && practiceId && UUID.test(practiceId)) await access.requirePractice(p, practiceId);
    }
    req.org = {
      organisationId, membershipId: loaded.membershipId, userId: auth.userId, roleKey: loaded.roleKey,
      permissions: access.snapshot.orgRole.permissions, companyScope: access.snapshot.reach,
      assignedCompanyIds: [...access.snapshot.companyGrants.keys()], organisationType: access.organisationType, access,
    };
    patchContext({ organisationId });
    return true;
  }
}
