import { Inject, Injectable } from '@nestjs/common';
import { Events, JobTypes, isPermission, PERMISSIONS, type Permission } from '@uk/contracts';
import { publishEvent } from '@uk/platform';
import { badRequest, conflict, forbidden, generateToken, notFound, sha256Hex, unprocessable, type AppConfig } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import { AuditService } from '../audit/audit.service';
import { CONFIG, DB, JOBS } from '../common/tokens';
import type { OrgAccess } from '../common/types';

interface InviteInput { email: string; roleId: string; companyScope: 'ALL' | 'ASSIGNED'; companyIds: string[] }
interface UpdateMemberInput { roleId?: string; companyScope?: 'ALL' | 'ASSIGNED'; companyIds?: string[]; status?: 'ACTIVE' | 'SUSPENDED' }

@Injectable()
export class OrganisationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: JobProducer,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  get(org: OrgAccess) {
    return this.t(org, (tx) => tx.organisation.findUniqueOrThrow({ where: { id: org.organisationId } }));
  }

  // ───────────── Roles ─────────────
  listRoles(org: OrgAccess) {
    return this.t(org, (tx) => tx.role.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] }));
  }

  async createRole(org: OrgAccess, input: { key: string; name: string; description: string; permissions: Permission[] }) {
    // A custom role can never exceed the creator's own permissions (no privilege escalation).
    const excess = input.permissions.filter((p) => !org.permissions.has(p));
    if (excess.length) throw forbidden(`Cannot grant permissions you do not hold: ${excess.join(', ')}`, 'privilege_escalation');
    return this.t(org, async (tx) => {
      const exists = await tx.role.findFirst({ where: { key: input.key, OR: [{ organisationId: org.organisationId }, { organisationId: null }] } });
      if (exists) throw conflict('A role with this key already exists', 'role_exists');
      const role = await tx.role.create({ data: { organisationId: org.organisationId, key: input.key, name: input.name, description: input.description, permissions: input.permissions } });
      await this.audit.record({ action: 'role.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'role', entityId: role.id, metadata: { permissions: input.permissions } }, tx);
      return role;
    });
  }

  // ───────────── Members ─────────────
  listMembers(org: OrgAccess) {
    return this.t(org, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { status: { not: 'REMOVED' } }, orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, email: true, displayName: true } }, role: { select: { id: true, key: true, name: true } }, assignments: { select: { companyId: true } } },
      });
      return rows.map((m) => ({ id: m.id, user: m.user, role: m.role, status: m.status, companyScope: m.companyScope, companyIds: m.assignments.map((a) => a.companyId) }));
    });
  }

  private async assertRoleUsable(tx: Tx, org: OrgAccess, roleId: string) {
    const role = await tx.role.findUnique({ where: { id: roleId } }); // RLS: system roles + this org's roles only
    if (!role) throw unprocessable('Unknown role', 'unknown_role');
    const unmet = role.permissions.filter(isPermission).filter((p) => !org.permissions.has(p));
    if (unmet.length) throw forbidden('Cannot assign a role with permissions you do not hold', 'privilege_escalation');
    return role;
  }

  private async assertCompanies(tx: Tx, ids: string[]) {
    if (!ids.length) return;
    const n = await tx.company.count({ where: { id: { in: ids } } });
    if (n !== new Set(ids).size) throw unprocessable('One or more companies do not exist in this organisation', 'unknown_company');
  }

  private async assertNotLastOwner(tx: Tx, membershipId: string) {
    const target = await tx.membership.findUnique({ where: { id: membershipId }, include: { role: true } });
    if (target?.role.key !== 'owner' || target.status !== 'ACTIVE') return;
    const owners = await tx.membership.count({ where: { status: 'ACTIVE', role: { key: 'owner' } } });
    if (owners <= 1) throw conflict('An organisation must keep at least one active owner', 'last_owner');
  }

  async updateMember(org: OrgAccess, membershipId: string, input: UpdateMemberInput) {
    return this.t(org, async (tx) => {
      const m = await tx.membership.findUnique({ where: { id: membershipId } });
      if (!m || m.status === 'REMOVED') throw notFound('Member not found');
      if (input.roleId) {
        await this.assertRoleUsable(tx, org, input.roleId);
        if (input.roleId !== m.roleId) await this.assertNotLastOwner(tx, membershipId);
      }
      if (input.status === 'SUSPENDED') await this.assertNotLastOwner(tx, membershipId);
      if (input.companyIds) await this.assertCompanies(tx, input.companyIds);
      const scope = input.companyScope ?? m.companyScope;
      await tx.membership.update({ where: { id: membershipId }, data: { roleId: input.roleId, status: input.status, companyScope: scope } });
      if (input.companyIds || input.companyScope === 'ALL') {
        await tx.companyAssignment.deleteMany({ where: { membershipId } });
        if (scope === 'ASSIGNED' && input.companyIds?.length) {
          await tx.companyAssignment.createMany({ data: input.companyIds.map((companyId) => ({ organisationId: org.organisationId, membershipId, companyId })) });
        }
      }
      await this.audit.record({ action: 'member.updated', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'membership', entityId: membershipId, metadata: { ...input } }, tx);
      return { id: membershipId };
    });
  }

  async removeMember(org: OrgAccess, membershipId: string) {
    return this.t(org, async (tx) => {
      const m = await tx.membership.findUnique({ where: { id: membershipId } });
      if (!m || m.status === 'REMOVED') throw notFound('Member not found');
      await this.assertNotLastOwner(tx, membershipId);
      await tx.membership.update({ where: { id: membershipId }, data: { status: 'REMOVED' } });
      await tx.companyAssignment.deleteMany({ where: { membershipId } });
      await this.audit.record({ action: 'member.removed', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'membership', entityId: membershipId }, tx);
    });
  }

  // ───────────── Invitations ─────────────
  async invite(org: OrgAccess, input: InviteInput) {
    const token = generateToken();
    const inv = await this.t(org, async (tx) => {
      await this.assertRoleUsable(tx, org, input.roleId);
      if (input.companyScope === 'ASSIGNED') await this.assertCompanies(tx, input.companyIds);
      const dup = await tx.membership.findFirst({ where: { status: { not: 'REMOVED' }, user: { email: input.email } } });
      if (dup) throw conflict('This person is already a member', 'already_member');
      const row = await tx.invitation.create({
        data: {
          organisationId: org.organisationId, email: input.email, roleId: input.roleId, companyScope: input.companyScope,
          companyIds: input.companyScope === 'ASSIGNED' ? input.companyIds : [], tokenHash: sha256Hex(token),
          invitedByUserId: org.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        },
      });
      await this.audit.record({ action: 'invitation.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'invitation', entityId: row.id, metadata: { email: input.email, roleId: input.roleId } }, tx);
      return row;
    });
    const orgRow = await this.get(org);
    await this.jobs.enqueue(JobTypes.emailSend, {
      to: input.email, subject: `You have been invited to ${orgRow.name}`,
      text: `You've been invited to join ${orgRow.name}. Accept: ${this.config.APP_BASE_URL}/accept-invitation?token=${token}\nThis invitation expires in 7 days.`,
    }, { organisationId: org.organisationId, userId: org.userId, idempotencyKey: `invite:${inv.id}` });
    return { id: inv.id, email: inv.email, expiresAt: inv.expiresAt };
  }

  listInvitations(org: OrgAccess) {
    return this.t(org, (tx) => tx.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, roleId: true, companyScope: true, expiresAt: true, createdAt: true },
    }));
  }

  async revokeInvitation(org: OrgAccess, id: string) {
    await this.t(org, async (tx) => {
      const r = await tx.invitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (r.count !== 1) throw notFound('Invitation not found');
      await this.audit.record({ action: 'invitation.revoked', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'invitation', entityId: id }, tx);
    });
  }

  /** Possession of the emailed token + a matching verified account is the authority. */
  async acceptInvitation(userId: string, userEmail: string, token: string) {
    const bad = badRequest('This invitation is invalid or has expired', 'invalid_invitation');
    const inv = await this.db.system((tx) => tx.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } }));
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date() || inv.email !== userEmail) throw bad;
    return this.db.tenant({ organisationId: inv.organisationId, userId }, async (tx) => {
      const claimed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw bad;
      const existing = await tx.membership.findUnique({ where: { organisationId_userId: { organisationId: inv.organisationId, userId } } });
      const data = { roleId: inv.roleId, status: 'ACTIVE' as const, companyScope: inv.companyScope };
      const m = existing
        ? await tx.membership.update({ where: { id: existing.id }, data })
        : await tx.membership.create({ data: { ...data, organisationId: inv.organisationId, userId } });
      await tx.companyAssignment.deleteMany({ where: { membershipId: m.id } });
      if (inv.companyScope === 'ASSIGNED' && inv.companyIds.length) {
        const valid = await tx.company.findMany({ where: { id: { in: inv.companyIds } }, select: { id: true } });
        await tx.companyAssignment.createMany({ data: valid.map((c) => ({ organisationId: inv.organisationId, membershipId: m.id, companyId: c.id })) });
      }
      await this.audit.record({ action: 'invitation.accepted', organisationId: inv.organisationId, actorUserId: userId, entityType: 'membership', entityId: m.id }, tx);
      const role = await tx.role.findUniqueOrThrow({ where: { id: inv.roleId } });
      await publishEvent(tx, Events.userAddedToOrganisation, { aggregateId: m.id, organisationId: inv.organisationId, actorUserId: userId, payload: { membershipId: m.id, userId, roleKey: role.key } });
      return { organisationId: inv.organisationId, membershipId: m.id };
    });
  }

  permissionCatalogue() { return [...PERMISSIONS]; }
}
