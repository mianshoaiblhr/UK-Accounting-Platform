import { PERMISSION_SCOPE, type Permission, type PermissionScope } from './permissions';

/**
 * Central, pure authorisation rules. No I/O: the API builds an {@link AccessSnapshot} from the database once per
 * request and every decision goes through the functions below (see v0-hierarchy-and-authorisation-design.md §3).
 *
 * Deny by default. For a company the MOST SPECIFIC grant wins and replaces (never unions with) broader ones:
 *   company grant  >  practice grant (company belongs to that practice)  >  organisation role with reach ALL.
 */
export type Reach = 'ALL' | 'ASSIGNED';
export type PlatformRole = 'NONE' | 'SUPPORT' | 'ADMIN';

export interface RoleGrant { roleKey: string; permissions: ReadonlySet<Permission> }

export interface AccessSnapshot {
  userId: string;
  organisationId: string;
  membershipId: string;
  /** False when the membership or organisation is not ACTIVE: every decision is a denial. */
  active: boolean;
  platformRole: PlatformRole;
  orgRole: RoleGrant;
  reach: Reach;
  practiceGrants: ReadonlyMap<string, RoleGrant>;
  companyGrants: ReadonlyMap<string, RoleGrant>;
}

export interface CompanyRef { id: string; practiceId: string | null }
export type AccessTarget = { company?: CompanyRef; practiceId?: string | null };

const scopeOf = (p: Permission): PermissionScope => PERMISSION_SCOPE[p];
const EMPTY: ReadonlySet<Permission> = new Set();
const only = (grant: RoleGrant, ...scopes: PermissionScope[]): ReadonlySet<Permission> =>
  new Set([...grant.permissions].filter((p) => scopes.includes(scopeOf(p))));

/** Effective COMPANY-scope permissions for one company. */
export function companyPermissions(s: AccessSnapshot, c: CompanyRef): ReadonlySet<Permission> {
  if (!s.active) return EMPTY;
  const direct = s.companyGrants.get(c.id);
  if (direct) return only(direct, 'COMPANY');
  const viaPractice = c.practiceId ? s.practiceGrants.get(c.practiceId) : undefined;
  if (viaPractice) return only(viaPractice, 'COMPANY');
  if (s.reach === 'ALL') return only(s.orgRole, 'COMPANY');
  return EMPTY;
}

/** Effective PRACTICE-scope permissions for one practice. */
export function practicePermissions(s: AccessSnapshot, practiceId: string): ReadonlySet<Permission> {
  if (!s.active) return EMPTY;
  const g = s.practiceGrants.get(practiceId);
  if (g) return only(g, 'PRACTICE');
  if (s.reach === 'ALL') return only(s.orgRole, 'PRACTICE');
  return EMPTY;
}

/**
 * Decision for a single permission.
 *  - ORG scope: organisation role.
 *  - PRACTICE scope: needs `practiceId`; organisation-level PRACTICE permissions without a target use the organisation
 *    role with reach ALL (e.g. creating the first practice).
 *  - COMPANY scope with a company target: per-company resolution. Without a target (organisation-level resources such
 *    as a document that belongs to no company) the organisation role decides.
 */
export function can(s: AccessSnapshot, perm: Permission, target: AccessTarget = {}): boolean {
  if (!s.active) return false;
  switch (scopeOf(perm)) {
    case 'ORG':
      return s.orgRole.permissions.has(perm);
    case 'PRACTICE':
      if (target.practiceId) return practicePermissions(s, target.practiceId).has(perm);
      return s.reach === 'ALL' && s.orgRole.permissions.has(perm);
    case 'COMPANY':
      if (target.company) return companyPermissions(s, target.company).has(perm);
      return s.orgRole.permissions.has(perm);
  }
}

/** Does the user hold the permission for at least one target? Used as a cheap route-level pre-check only. */
export function holdsAnywhere(s: AccessSnapshot, perm: Permission): boolean {
  if (!s.active) return false;
  if (s.orgRole.permissions.has(perm)) return true;
  const scope = scopeOf(perm);
  if (scope === 'ORG') return false;
  for (const g of s.practiceGrants.values()) if (g.permissions.has(perm)) return true;
  if (scope === 'COMPANY') for (const g of s.companyGrants.values()) if (g.permissions.has(perm)) return true;
  return false;
}

/** The set of practices where the user holds a PRACTICE permission. */
export function accessiblePracticeIds(s: AccessSnapshot, perm: Permission, allPracticeIds: readonly string[]): string[] {
  return allPracticeIds.filter((id) => can(s, perm, { practiceId: id }));
}

/**
 * Companies (from the supplied organisation company list) on which the user holds `perm`. When the answer is
 * "every company" the function returns the literal 'ALL' so callers can skip an `IN (...)` filter.
 */
export function accessibleCompanyIds(s: AccessSnapshot, perm: Permission, companies: readonly CompanyRef[]): string[] | 'ALL' {
  if (!s.active) return [];
  const ids = companies.filter((c) => companyPermissions(s, c).has(perm)).map((c) => c.id);
  return ids.length === companies.length && companies.length > 0 ? 'ALL' : ids;
}

/** Anti-escalation: may the user hand out `role` at this level? They must hold every permission the grant confers there. */
export function canGrantRole(
  s: AccessSnapshot, role: ReadonlySet<Permission>,
  level: { type: 'ORG' } | { type: 'PRACTICE'; practiceId: string } | { type: 'COMPANY'; company: CompanyRef },
): boolean {
  if (!s.active) return false;
  for (const p of role) {
    const scope = scopeOf(p);
    let ok: boolean;
    if (level.type === 'ORG') {
      ok = s.orgRole.permissions.has(p);
    } else if (level.type === 'COMPANY') {
      if (scope !== 'COMPANY') continue; // a company grant confers COMPANY-scope permissions only
      ok = can(s, p, { company: level.company });
    } else {
      if (scope === 'ORG') continue; // a practice grant confers PRACTICE and COMPANY scope only
      if (scope === 'PRACTICE') ok = can(s, p, { practiceId: level.practiceId });
      else {
        const g = s.practiceGrants.get(level.practiceId);
        ok = g ? g.permissions.has(p) : s.reach === 'ALL' && s.orgRole.permissions.has(p);
      }
    }
    if (!ok) return false;
  }
  return true;
}

/** Platform roles never confer tenant access; they only qualify for (future) platform-level operations. */
export function hasPlatformRole(s: Pick<AccessSnapshot, 'platformRole'>, min: Exclude<PlatformRole, 'NONE'>): boolean {
  return s.platformRole === 'ADMIN' || (min === 'SUPPORT' && s.platformRole === 'SUPPORT');
}
