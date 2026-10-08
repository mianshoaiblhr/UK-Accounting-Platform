import { CanActivate, Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isPermission, type Permission } from '@uk/contracts';
import { forbidden, notFound, patchContext, unauthorized } from '@uk/core';
import type { Database } from '@uk/db';
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

    const m = await this.db.tenant({ organisationId, userId: auth.userId }, (tx) =>
      tx.membership.findUnique({
        where: { organisationId_userId: { organisationId, userId: auth.userId } },
        include: { role: true, assignments: { select: { companyId: true } }, organisation: { select: { status: true } } },
      }));
    if (!m || m.status !== 'ACTIVE' || m.organisation.status !== 'ACTIVE') {
      await this.audit.record({ action: 'access.denied', outcome: 'DENIED', organisationId, actorUserId: auth.userId, metadata: { reason: 'not_a_member', path: req.path } });
      throw notFound('Organisation not found'); // do not reveal whether the organisation exists
    }
    const permissions = new Set(m.role.permissions.filter(isPermission));
    const missing = required.filter((p) => !permissions.has(p));
    if (missing.length) {
      await this.audit.record({ action: 'access.denied', outcome: 'DENIED', organisationId, actorUserId: auth.userId, metadata: { reason: 'missing_permission', missing, path: req.path } });
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
    req.org = {
      organisationId, membershipId: m.id, userId: auth.userId, roleKey: m.role.key, permissions,
      companyScope: m.companyScope, assignedCompanyIds: m.assignments.map((a) => a.companyId),
    };
    patchContext({ organisationId });
    return true;
  }
}
