import { Inject, Injectable } from '@nestjs/common';
import { canGrantRole, isPermission } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Database, type Tx } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/** Practices (PRACTICE organisations only) plus the two explicit grant kinds below organisation level. */
@Injectable()
export class PracticesService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  async create(org: OrgAccess, input: { name: string }) {
    if (org.organisationType !== 'PRACTICE') throw unprocessable('Direct business organisations do not have practices', 'practice_not_allowed');
    // Creating a practice is organisation-level: practice:manage with organisation-wide reach (a practice grant cannot create siblings).
    if (!(await org.access.can('practice:manage'))) throw forbidden('You do not have permission to perform this action', 'permission_denied');
    try {
      return await this.t(org, async (tx) => {
        const p = await tx.practice.create({ data: { organisationId: org.organisationId, name: input.name } });
        await this.audit.record({ action: 'practice.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'practice', entityId: p.id, metadata: { name: p.name } }, tx);
        return p;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A practice with this name already exists', 'practice_exists');
      throw e;
    }
  }

  async list(org: OrgAccess) {
    const rows = await this.t(org, (tx) => tx.practice.findMany({ orderBy: { name: 'asc' } }));
    const items: typeof rows = [];
    for (const p of rows) if (await org.access.can('practice:read', { practiceId: p.id })) items.push(p);
    return { items };
  }

  async get(org: OrgAccess, practiceId: string) {
    const p = await this.t(org, (tx) => tx.practice.findUnique({ where: { id: practiceId } }));
    if (!p) throw notFound('Practice not found');
    return p;
  }

  async update(org: OrgAccess, practiceId: string, input: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' }) {
    return this.t(org, async (tx) => {
      const p = await tx.practice.update({ where: { id: practiceId }, data: input });
      await this.audit.record({ action: 'practice.updated', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'practice', entityId: practiceId, metadata: { ...input } }, tx);
      return p;
    });
  }

  async listMembers(org: OrgAccess, practiceId: string) {
    return {
      items: await this.t(org, async (tx) => (await tx.practiceMembership.findMany({
        where: { practiceId },
        include: { role: { select: { id: true, key: true, name: true } }, membership: { select: { id: true, status: true, user: { select: { id: true, email: true, displayName: true } } } } },
      })).map((m) => ({ membershipId: m.membershipId, user: m.membership.user, status: m.membership.status, role: m.role }))),
    };
  }

  private async loadGrantRole(tx: Tx, roleId: string) {
    const role = await tx.role.findUnique({ where: { id: roleId } }); // RLS: system roles + this organisation's roles
    if (!role) throw unprocessable('Unknown role', 'unknown_role');
    return role;
  }

  private async activeMembership(tx: Tx, membershipId: string) {
    const m = await tx.organisationMembership.findUnique({ where: { id: membershipId } });
    if (!m || m.status !== 'ACTIVE') throw notFound('Member not found');
    return m;
  }

  /** Grants (or changes) a practice-level role. Needs practice:member:manage on the practice and may not exceed the granter's own rights there. */
  async setMember(org: OrgAccess, practiceId: string, membershipId: string, roleId: string) {
    return this.t(org, async (tx) => {
      await this.activeMembership(tx, membershipId);
      const role = await this.loadGrantRole(tx, roleId);
      if (!canGrantRole(org.access.snapshot, new Set(role.permissions.filter(isPermission)), { type: 'PRACTICE', practiceId })) {
        throw forbidden('Cannot grant a role with permissions you do not hold in this practice', 'privilege_escalation');
      }
      const row = await tx.practiceMembership.upsert({
        where: { practiceId_membershipId: { practiceId, membershipId } },
        create: { organisationId: org.organisationId, practiceId, membershipId, roleId }, update: { roleId },
      });
      await this.audit.record({ action: 'practice.member_set', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'practice', entityId: practiceId, metadata: { membershipId, roleId } }, tx);
      return { practiceId, membershipId, roleId: row.roleId };
    });
  }

  async removeMember(org: OrgAccess, practiceId: string, membershipId: string) {
    await this.t(org, async (tx) => {
      const r = await tx.practiceMembership.deleteMany({ where: { practiceId, membershipId } });
      if (r.count !== 1) throw notFound('Practice member not found');
      await this.audit.record({ action: 'practice.member_removed', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'practice', entityId: practiceId, metadata: { membershipId } }, tx);
    });
  }

  // ───────────── Company-level grants ─────────────
  async listCompanyAccess(org: OrgAccess, companyId: string) {
    return {
      items: await this.t(org, async (tx) => (await tx.companyMembership.findMany({
        where: { companyId },
        include: { role: { select: { id: true, key: true, name: true } }, membership: { select: { id: true, status: true, user: { select: { id: true, email: true, displayName: true } } } } },
      })).map((m) => ({ membershipId: m.membershipId, user: m.membership.user, status: m.membership.status, role: m.role }))),
    };
  }

  /** Grants (or changes) a company-level role: the most specific grant, replacing broader ones for this company only. */
  async setCompanyAccess(org: OrgAccess, companyId: string, membershipId: string, roleId: string) {
    const ref = await org.access.companyRef(companyId);
    if (!ref) throw notFound('Company not found');
    return this.t(org, async (tx) => {
      await this.activeMembership(tx, membershipId);
      const role = await this.loadGrantRole(tx, roleId);
      if (!canGrantRole(org.access.snapshot, new Set(role.permissions.filter(isPermission)), { type: 'COMPANY', company: ref })) {
        throw forbidden('Cannot grant a role with permissions you do not hold on this company', 'privilege_escalation');
      }
      const row = await tx.companyMembership.upsert({
        where: { membershipId_companyId: { membershipId, companyId } },
        create: { organisationId: org.organisationId, membershipId, companyId, roleId }, update: { roleId },
      });
      await this.audit.record({ action: 'company.access_set', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'company', entityId: companyId, metadata: { membershipId, roleId } }, tx);
      return { companyId, membershipId, roleId: row.roleId };
    });
  }

  async removeCompanyAccess(org: OrgAccess, companyId: string, membershipId: string) {
    await this.t(org, async (tx) => {
      const r = await tx.companyMembership.deleteMany({ where: { companyId, membershipId } });
      if (r.count !== 1) throw notFound('Company access grant not found');
      await this.audit.record({ action: 'company.access_removed', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'company', entityId: companyId, metadata: { membershipId } }, tx);
    });
  }
}
