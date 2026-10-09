import {
  accessibleCompanyIds, can as canPure, companyPermissions, isPermission, PERMISSION_SCOPE,
  type AccessSnapshot, type CompanyRef, type Permission, type RoleGrant,
} from '@uk/contracts';
import { forbidden, notFound } from '@uk/core';
import type { Database, Tx } from '@uk/db';

/**
 * Request-scoped authorisation facade over the pure rules in @uk/contracts/authz. This is the ONLY place the API
 * turns "who is this user in this organisation" into decisions; controllers and services call it instead of
 * re-implementing role/scope logic (docs/architecture/v0-hierarchy-and-authorisation-design.md §3).
 */
export interface DocumentRef { id: string; companyId: string | null; visibility: string; createdByUserId: string }
export interface DeniedInfo { permission: Permission; target: { companyId?: string; practiceId?: string } }

export class AccessContext {
  private readonly companies = new Map<string, CompanyRef | null>();
  private everyCompany?: CompanyRef[];

  constructor(
    readonly snapshot: AccessSnapshot,
    readonly organisationType: 'PRACTICE' | 'BUSINESS',
    private readonly db: Database,
    private readonly onDenied?: (d: DeniedInfo) => Promise<void>,
  ) {}

  private run<T>(fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: this.snapshot.organisationId, userId: this.snapshot.userId }, fn); }

  async companyRef(companyId: string): Promise<CompanyRef | null> {
    if (this.companies.has(companyId)) return this.companies.get(companyId)!;
    const c = await this.run((tx) => tx.company.findUnique({ where: { id: companyId }, select: { id: true, practiceId: true } }));
    this.companies.set(companyId, c);
    return c;
  }

  private async allCompanies(): Promise<CompanyRef[]> {
    this.everyCompany ??= await this.run((tx) => tx.company.findMany({ select: { id: true, practiceId: true } }));
    return this.everyCompany;
  }

  /** Non-throwing decision. A target company that does not exist (or is in another organisation) is never allowed. */
  async can(perm: Permission, target: { companyId?: string | null; practiceId?: string | null } = {}): Promise<boolean> {
    if (target.companyId) {
      const c = await this.companyRef(target.companyId);
      return !!c && canPure(this.snapshot, perm, { company: c });
    }
    return canPure(this.snapshot, perm, { practiceId: target.practiceId });
  }

  /**
   * Requires `perm` for a resource that belongs to `companyId`, or to the organisation itself when null.
   * Someone with no access at all to the target gets 404 (`hidden` message, existence not revealed); someone with
   * some access who lacks this permission gets 403 and the denial is audited.
   */
  async requireResource(perm: Permission, companyId: string | null, hidden: string): Promise<CompanyRef | null> {
    if (companyId) {
      const c = await this.companyRef(companyId);
      if (!c || companyPermissions(this.snapshot, c).size === 0) throw notFound(hidden);
      if (!canPure(this.snapshot, perm, { company: c })) {
        await this.onDenied?.({ permission: perm, target: { companyId } });
        throw forbidden('You do not have permission to perform this action', 'permission_denied');
      }
      return c;
    }
    if (!(this.snapshot.active && this.snapshot.orgRole.permissions.has(perm))) {
      await this.onDenied?.({ permission: perm, target: {} });
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
    return null;
  }

  async requireCompany(perm: Permission, companyId: string): Promise<CompanyRef> {
    return (await this.requireResource(perm, companyId, 'Company not found'))!;
  }

  async requirePractice(perm: Permission, practiceId: string): Promise<void> {
    const p = await this.run((tx) => tx.practice.findUnique({ where: { id: practiceId }, select: { id: true } }));
    const anyAccess = canPure(this.snapshot, 'practice:read', { practiceId }) || this.snapshot.practiceGrants.has(practiceId);
    if (!p || !anyAccess) throw notFound('Practice not found');
    if (!canPure(this.snapshot, perm, { practiceId })) {
      await this.onDenied?.({ permission: perm, target: { practiceId } });
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
  }

  /** Company ids on which the user holds `perm`: 'ALL' (no filter needed) or an explicit list. */
  async companyIds(perm: Permission): Promise<string[] | 'ALL'> {
    return accessibleCompanyIds(this.snapshot, perm, await this.allCompanies());
  }

  /**
   * Prisma `where` fragment restricting rows that carry a nullable `companyId`. Rows with no company are
   * organisation-level and governed by the organisation role.
   */
  async companyWhere(perm: Permission, field = 'companyId'): Promise<Record<string, unknown>> {
    const orgLevel = this.snapshot.orgRole.permissions.has(perm) && this.snapshot.active;
    const ids = await this.companyIds(perm);
    if (ids === 'ALL') return orgLevel ? {} : { [field]: { not: null } };
    const parts: Record<string, unknown>[] = [{ [field]: { in: ids } }];
    if (orgLevel) parts.push({ [field]: null });
    return parts.length === 1 ? parts[0]! : { OR: parts };
  }

  /** Narrowing for the `company` table itself. */
  async companyTableWhere(perm: Permission): Promise<Record<string, unknown>> {
    const ids = await this.companyIds(perm);
    return ids === 'ALL' ? {} : { id: { in: ids } };
  }

  /**
   * Per-document visibility (ADR-32). A document is readable when the caller may read documents of its company AND it is STANDARD,
   * or RESTRICTED and the caller created it, holds `document:confidential` for its company, or has an explicit grant.
   * Every code path that reads a document must go through this (or {@link documentWhere}); an invisible document is a 404.
   */
  async canReadDocument(doc: DocumentRef): Promise<boolean> {
    if (!(await this.can('document:read', { companyId: doc.companyId }))) return false;
    if (doc.visibility !== 'RESTRICTED') return true;
    if (doc.createdByUserId === this.snapshot.userId) return true;
    if (await this.can('document:confidential', { companyId: doc.companyId })) return true;
    return !!(await this.run((tx) => tx.documentAccess.findFirst({ where: { documentId: doc.id, userId: this.snapshot.userId }, select: { id: true } })));
  }

  /** The same rule as {@link canReadDocument}, as a Prisma `where` fragment for lists. */
  async documentWhere(): Promise<Record<string, unknown>> {
    const readable = await this.companyWhere('document:read');
    const confidential = await this.companyWhere('document:confidential');
    return { AND: [readable, { OR: [{ visibility: 'STANDARD' }, { createdByUserId: this.snapshot.userId }, { access: { some: { userId: this.snapshot.userId } } }, confidential] }] };
  }

  /** Workflow/AI engines ask this to authorise a transition for the instance's company. */
  actor() {
    return {
      userId: this.snapshot.userId,
      can: (perm: string, companyId: string | null) => this.can(perm as Permission, { companyId }),
      canReadDocument: (doc: DocumentRef) => this.canReadDocument(doc),
    };
  }

  /** Effective permissions on one company (for API responses / UI). */
  async effectivePermissions(companyId: string): Promise<Permission[]> {
    const c = await this.companyRef(companyId);
    return c ? [...companyPermissions(this.snapshot, c)] : [];
  }
}

export interface LoadedAccess { access: AccessContext; membershipId: string; roleKey: string }

const toGrant = (role: { key: string; permissions: string[] }): RoleGrant => ({ roleKey: role.key, permissions: new Set(role.permissions.filter(isPermission)) });

/** Builds the snapshot for (organisation, user) inside the tenant context; null when there is no ACTIVE membership. */
export async function loadAccess(db: Database, organisationId: string, userId: string, onDenied?: (d: DeniedInfo) => Promise<void>): Promise<LoadedAccess | null> {
  const m = await db.tenant({ organisationId, userId }, (tx) => tx.organisationMembership.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    include: {
      role: true, organisation: { select: { status: true, type: true } }, user: { select: { platformRole: true } },
      practiceMemberships: { include: { role: true } }, companyMemberships: { include: { role: true } },
    },
  }));
  if (!m || m.status !== 'ACTIVE' || m.organisation.status !== 'ACTIVE') return null;
  const snapshot: AccessSnapshot = {
    userId, organisationId, membershipId: m.id, active: true, platformRole: m.user.platformRole,
    orgRole: toGrant(m.role), reach: m.companyScope,
    practiceGrants: new Map(m.practiceMemberships.map((p) => [p.practiceId, toGrant(p.role)])),
    companyGrants: new Map(m.companyMemberships.map((c) => [c.companyId, toGrant(c.role)])),
  };
  return { access: new AccessContext(snapshot, m.organisation.type, db, onDenied), membershipId: m.id, roleKey: m.role.key };
}

export const scopeOfPermission = (p: Permission) => PERMISSION_SCOPE[p];
