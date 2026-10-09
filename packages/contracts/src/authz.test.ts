import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS, PERMISSION_SCOPE, SYSTEM_ROLES, accessibleCompanyIds, can, canGrantRole, companyPermissions, hasPlatformRole, holdsAnywhere,
  practicePermissions, type AccessSnapshot, type Permission, type RoleGrant,
} from './index';

const role = (key: string): RoleGrant => ({ roleKey: key, permissions: new Set(SYSTEM_ROLES.find((r) => r.key === key)!.permissions) });
const custom = (...p: Permission[]): RoleGrant => ({ roleKey: 'custom', permissions: new Set(p) });

const P1 = 'p1', P2 = 'p2';
const A = { id: 'A', practiceId: P1 }, B = { id: 'B', practiceId: P1 }, C = { id: 'C', practiceId: P2 }, D = { id: 'D', practiceId: null };

function snap(o: Partial<AccessSnapshot> & { orgRole: RoleGrant }): AccessSnapshot {
  return { userId: 'u', organisationId: 'o', membershipId: 'm', active: true, platformRole: 'NONE', reach: 'ASSIGNED',
    practiceGrants: new Map(), companyGrants: new Map(), ...o };
}

describe('permission catalogue', () => {
  it('every permission has exactly one scope, and every scope is used', () => {
    expect(Object.keys(PERMISSION_SCOPE).sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(Object.values(PERMISSION_SCOPE))).toEqual(new Set(['ORG', 'PRACTICE', 'COMPANY']));
  });
});

describe('deny by default', () => {
  it('a member with reach ASSIGNED and no grants has no company or practice access at all', () => {
    const s = snap({ orgRole: role('accountant') });
    for (const c of [A, B, C, D]) expect(companyPermissions(s, c).size).toBe(0);
    expect(practicePermissions(s, P1).size).toBe(0);
    expect(accessibleCompanyIds(s, 'company:read', [A, B, C])).toEqual([]);
  });
  it('an inactive membership (suspended/removed/organisation suspended) is denied everything', () => {
    const s = snap({ orgRole: role('owner'), reach: 'ALL', active: false });
    for (const p of PERMISSIONS) { expect(can(s, p, { company: A }), p).toBe(false); expect(holdsAnywhere(s, p), p).toBe(false); }
  });
  it('a platform role never grants tenant access', () => {
    const s = snap({ orgRole: custom(), platformRole: 'ADMIN' });
    for (const p of PERMISSIONS) expect(can(s, p, { company: A }), p).toBe(false);
    expect(hasPlatformRole(s, 'SUPPORT')).toBe(true);
    expect(hasPlatformRole(snap({ orgRole: custom(), platformRole: 'NONE' }), 'SUPPORT')).toBe(false);
  });
});

describe('most specific grant wins (company > practice > organisation reach ALL)', () => {
  it('reach ALL gives the organisation role on every company', () => {
    const s = snap({ orgRole: role('accountant'), reach: 'ALL' });
    for (const c of [A, B, C, D]) expect(can(s, 'document:upload', { company: c })).toBe(true);
  });
  it('a practice grant covers only that practice\'s companies and nothing else', () => {
    const s = snap({ orgRole: role('client_viewer'), practiceGrants: new Map([[P1, role('accountant')]]) });
    expect(can(s, 'document:upload', { company: A })).toBe(true);
    expect(can(s, 'document:upload', { company: B })).toBe(true);
    expect(can(s, 'company:read', { company: C })).toBe(false); // other practice: no relationship, no access
    expect(can(s, 'company:read', { company: D })).toBe(false); // direct company (no practice)
  });
  it('a company grant replaces broader grants for that company only (it can restrict as well as extend)', () => {
    const s = snap({
      orgRole: role('admin'), reach: 'ALL',
      practiceGrants: new Map([[P1, role('partner')]]),
      companyGrants: new Map([['A', role('reviewer')], ['C', role('partner')]]),
    });
    expect(can(s, 'workflow:approve', { company: A })).toBe(false); // restricted below the practice role
    expect(can(s, 'document:upload', { company: A })).toBe(false);
    expect(can(s, 'workflow:approve', { company: B })).toBe(true);  // practice role still applies elsewhere in P1
    expect(can(s, 'workflow:approve', { company: C })).toBe(true);  // extended above the org default for C
    expect(can(s, 'workflow:approve', { company: D })).toBe(true);  // org-wide role (admin) on the direct company
  });
  it('company-level permissions never leak to another company', () => {
    const s = snap({ orgRole: role('client_viewer'), companyGrants: new Map([['A', role('partner')]]) });
    expect(can(s, 'workflow:approve', { company: A })).toBe(true);
    for (const c of [B, C, D]) expect(companyPermissions(s, c).size).toBe(0);
  });
  it('different roles for the same user on different companies', () => {
    const s = snap({ orgRole: role('client_viewer'), companyGrants: new Map([['A', role('partner')], ['B', role('reviewer')]]) });
    expect(can(s, 'workflow:approve', { company: A })).toBe(true);
    expect(can(s, 'workflow:approve', { company: B })).toBe(false);
    expect(can(s, 'workflow:review', { company: B })).toBe(true);
    expect(can(s, 'document:upload', { company: B })).toBe(false);
  });
  it('only COMPANY-scope permissions flow from a company or practice grant (a partner grant never confers org administration)', () => {
    const s = snap({ orgRole: custom('org:read'), companyGrants: new Map([['A', role('partner')]]), practiceGrants: new Map([[P1, role('partner')]]) });
    expect(can(s, 'member:manage', { company: A })).toBe(false);
    expect(can(s, 'org:manage')).toBe(false);
    expect(can(s, 'member:invite')).toBe(false);
  });
});

describe('scopes', () => {
  it('ORG-scope permissions come only from the organisation role, regardless of reach or grants', () => {
    const s = snap({ orgRole: custom('member:read'), reach: 'ASSIGNED', practiceGrants: new Map([[P1, role('partner')]]) });
    expect(can(s, 'member:read')).toBe(true);
    expect(can(s, 'member:manage')).toBe(false);
  });
  it('PRACTICE-scope: practice grant or organisation role with reach ALL, per practice', () => {
    const s = snap({ orgRole: custom(), practiceGrants: new Map([[P1, role('partner')]]) });
    expect(can(s, 'practice:manage', { practiceId: P1 })).toBe(true);
    expect(can(s, 'practice:manage', { practiceId: P2 })).toBe(false);
    expect(can(s, 'company:create', { practiceId: P1 })).toBe(true);
    expect(can(s, 'company:create', { practiceId: P2 })).toBe(false);
    const all = snap({ orgRole: role('owner'), reach: 'ALL' });
    expect(can(all, 'practice:manage', { practiceId: P2 })).toBe(true);
    expect(can(all, 'practice:manage')).toBe(true);
    const assigned = snap({ orgRole: role('owner'), reach: 'ASSIGNED' });
    expect(can(assigned, 'practice:manage', { practiceId: P2 })).toBe(false);
    expect(can(assigned, 'practice:manage')).toBe(false);
  });
  it('organisation-level resources (no company) are governed by the organisation role', () => {
    expect(can(snap({ orgRole: role('accountant') }), 'document:upload')).toBe(true);
    expect(can(snap({ orgRole: role('client_viewer') }), 'document:upload')).toBe(false);
  });
  it('holdsAnywhere is a cheap pre-check: true if the org role OR any grant holds the permission', () => {
    const s = snap({ orgRole: role('client_viewer'), companyGrants: new Map([['A', role('partner')]]) });
    expect(holdsAnywhere(s, 'workflow:approve')).toBe(true);
    expect(holdsAnywhere(s, 'member:manage')).toBe(false);
    expect(holdsAnywhere(snap({ orgRole: custom(), practiceGrants: new Map([[P1, role('partner')]]) }), 'practice:manage')).toBe(true);
  });
});

describe('accessibleCompanyIds', () => {
  it('returns ALL only when every company is accessible, otherwise the explicit list', () => {
    expect(accessibleCompanyIds(snap({ orgRole: role('owner'), reach: 'ALL' }), 'company:read', [A, B, C])).toBe('ALL');
    const s = snap({ orgRole: role('client_viewer'), practiceGrants: new Map([[P1, role('reviewer')]]), companyGrants: new Map([['C', role('bookkeeper')]]) });
    expect(accessibleCompanyIds(s, 'company:read', [A, B, C, D]).toString()).toBe(['A', 'B', 'C'].toString());
    expect(accessibleCompanyIds(s, 'document:upload', [A, B, C, D])).toEqual(['C']);
  });
  it('a restricting company grant removes the company from the list', () => {
    const s = snap({ orgRole: role('owner'), reach: 'ALL', companyGrants: new Map([['B', custom('company:read')]]) });
    expect(accessibleCompanyIds(s, 'document:upload', [A, B, C])).toEqual(['A', 'C']);
  });
});

describe('anti-escalation: canGrantRole', () => {
  const partnerSnap = snap({ orgRole: role('client_viewer'), practiceGrants: new Map([[P1, role('partner')]]), companyGrants: new Map([['X', role('manager')]]) });
  const perms = (key: string) => new Set(SYSTEM_ROLES.find((r) => r.key === key)!.permissions);
  it('a granter cannot hand out more than they hold at that level', () => {
    expect(canGrantRole(partnerSnap, perms('accountant'), { type: 'PRACTICE', practiceId: P1 })).toBe(true);
    expect(canGrantRole(partnerSnap, perms('accountant'), { type: 'PRACTICE', practiceId: P2 })).toBe(false); // no relationship with P2
    expect(canGrantRole(partnerSnap, perms('partner'), { type: 'COMPANY', company: { id: 'X', practiceId: null } })).toBe(false); // manager cannot grant partner
    expect(canGrantRole(partnerSnap, perms('reviewer'), { type: 'COMPANY', company: { id: 'X', practiceId: null } })).toBe(true);
  });
  it('organisation-level grants require the full organisation role', () => {
    expect(canGrantRole(snap({ orgRole: role('admin'), reach: 'ALL' }), perms('owner'), { type: 'ORG' })).toBe(false);
    expect(canGrantRole(snap({ orgRole: role('owner'), reach: 'ALL' }), perms('owner'), { type: 'ORG' })).toBe(true);
  });
  it('a company grant only confers COMPANY-scope permissions, so only those are checked', () => {
    const s = snap({ orgRole: custom(), companyGrants: new Map([['X', role('partner')]]) });
    expect(canGrantRole(s, perms('partner'), { type: 'COMPANY', company: { id: 'X', practiceId: null } })).toBe(true);
  });
});

describe('system roles', () => {
  it('only owner holds org:manage; admin holds everything else', () => {
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes('org:manage')).map((r) => r.key)).toEqual(['owner']);
    expect(SYSTEM_ROLES.find((r) => r.key === 'admin')!.permissions).toHaveLength(PERMISSIONS.length - 1);
  });
  it('approval is held only by roles trusted to approve (owner, admin, partner)', () => {
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes('workflow:approve')).map((r) => r.key).sort()).toEqual(['admin', 'owner', 'partner']);
  });
  it('a client viewer is read-only', () => {
    const w = SYSTEM_ROLES.find((r) => r.key === 'client_viewer')!.permissions.filter((p) => /manage|create|upload|update|approve|review|archive/.test(p));
    expect(w).toEqual([]);
  });
});
