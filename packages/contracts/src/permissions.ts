/** Permission catalogue. Add new permissions here only (later versions append). */
export const PERMISSIONS = [
  'org:read', 'org:manage',
  'member:read', 'member:invite', 'member:manage',
  'role:read', 'role:manage',
  'company:read', 'company:create', 'company:update',
  'period:read', 'period:manage',
  'document:read', 'document:upload', 'document:archive',
  'audit:read',
  'job:read', 'job:manage',
  'task:read', 'task:manage',
  'workflow:read', 'workflow:manage',
  'integration:read', 'integration:manage',
  'ai:use', 'ai:approve',
  'practice:read', 'practice:manage', 'practice:member:manage',
  'company:access:manage',
  'workflow:review', 'workflow:approve',
] as const;
export type Permission = (typeof PERMISSIONS)[number];


/**
 * Where a permission applies (docs/architecture/v0-hierarchy-and-authorisation-design.md §3):
 *  ORG      – organisation-wide; comes from the organisation membership role only.
 *  PRACTICE – a practice; from the practice membership role, or the organisation role when reach is ALL.
 *  COMPANY  – one client company; resolved per company (company grant > practice grant > organisation role with reach ALL).
 */
export type PermissionScope = 'ORG' | 'PRACTICE' | 'COMPANY';
export const PERMISSION_SCOPE: Record<Permission, PermissionScope> = {
  'org:read': 'ORG', 'org:manage': 'ORG', 'member:read': 'ORG', 'member:invite': 'ORG', 'member:manage': 'ORG',
  'role:read': 'ORG', 'role:manage': 'ORG', 'job:read': 'ORG', 'job:manage': 'ORG',
  'integration:read': 'ORG', 'integration:manage': 'ORG',
  'practice:read': 'PRACTICE', 'practice:manage': 'PRACTICE', 'practice:member:manage': 'PRACTICE', 'company:create': 'PRACTICE',
  'company:read': 'COMPANY', 'company:update': 'COMPANY', 'company:access:manage': 'COMPANY', 'audit:read': 'COMPANY',
  'period:read': 'COMPANY', 'period:manage': 'COMPANY',
  'document:read': 'COMPANY', 'document:upload': 'COMPANY', 'document:archive': 'COMPANY',
  'task:read': 'COMPANY', 'task:manage': 'COMPANY',
  'workflow:read': 'COMPANY', 'workflow:manage': 'COMPANY', 'workflow:review': 'COMPANY', 'workflow:approve': 'COMPANY',
  'ai:use': 'COMPANY', 'ai:approve': 'COMPANY',
};
export const permissionsOfScope = (...scopes: PermissionScope[]): Permission[] => PERMISSIONS.filter((p) => scopes.includes(PERMISSION_SCOPE[p]));

export interface SystemRoleDef { key: string; name: string; description: string; permissions: Permission[] }

const ORG_READ: Permission[] = ['org:read', 'member:read', 'role:read'];
const COMPANY_READ: Permission[] = ['company:read', 'period:read', 'document:read'];
const READ: Permission[] = [...ORG_READ, ...COMPANY_READ];
const COMPANY_ALL = permissionsOfScope('COMPANY');

/** Seeded by migration (system roles, organisation_id NULL). Kept in sync by a test. */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: 'owner', name: 'Owner', description: 'Full control including organisation settings', permissions: [...PERMISSIONS] },
  { key: 'admin', name: 'Administrator', description: 'Manage people, practices, companies and documents',
    permissions: PERMISSIONS.filter((p) => p !== 'org:manage') },
  { key: 'partner', name: 'Partner', description: 'Leads a practice or client company: full company control including review, approval and access management',
    permissions: [...ORG_READ, 'job:read', 'practice:read', 'practice:manage', 'practice:member:manage', 'company:create', ...COMPANY_ALL] },
  { key: 'manager', name: 'Manager', description: 'Manages day-to-day work on a company: can review but not approve or manage access',
    permissions: [...ORG_READ, 'job:read', 'practice:read', 'company:read', 'company:update', 'period:read', 'period:manage',
      'document:read', 'document:upload', 'document:archive', 'task:read', 'task:manage', 'workflow:read', 'workflow:manage', 'workflow:review', 'ai:use'] },
  { key: 'accountant', name: 'Accountant', description: 'Work on assigned client companies',
    permissions: [...READ, 'practice:read', 'company:create', 'company:update', 'period:manage', 'document:upload', 'document:archive', 'job:read', 'audit:read',
      'task:read', 'task:manage', 'workflow:read', 'workflow:manage', 'workflow:review', 'ai:use', 'ai:approve'] },
  { key: 'bookkeeper', name: 'Bookkeeper', description: 'Prepare records for assigned companies',
    permissions: [...READ, 'practice:read', 'document:upload', 'job:read', 'task:read', 'task:manage', 'workflow:read', 'ai:use'] },
  { key: 'reviewer', name: 'Reviewer', description: 'Read-only review and audit access',
    permissions: [...READ, 'practice:read', 'audit:read', 'job:read', 'task:read', 'workflow:read', 'workflow:review'] },
  { key: 'client_viewer', name: 'Client Viewer', description: 'Client read-only access to own company',
    permissions: ['org:read', 'company:read', 'period:read', 'document:read'] },
];

export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);
