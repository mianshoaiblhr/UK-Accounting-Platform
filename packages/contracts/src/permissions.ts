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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface SystemRoleDef { key: string; name: string; description: string; permissions: Permission[] }

const READ: Permission[] = ['org:read', 'member:read', 'role:read', 'company:read', 'period:read', 'document:read'];

/** Seeded by migration (system roles, organisation_id NULL). Kept in sync by a test. */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: 'owner', name: 'Owner', description: 'Full control including organisation settings', permissions: [...PERMISSIONS] },
  { key: 'admin', name: 'Administrator', description: 'Manage people, companies and documents',
    permissions: PERMISSIONS.filter((p) => p !== 'org:manage') },
  { key: 'accountant', name: 'Accountant', description: 'Work on assigned client companies',
    permissions: [...READ, 'company:create', 'company:update', 'period:manage', 'document:upload', 'document:archive', 'job:read', 'audit:read'] },
  { key: 'bookkeeper', name: 'Bookkeeper', description: 'Prepare records for assigned companies',
    permissions: [...READ, 'document:upload', 'job:read'] },
  { key: 'reviewer', name: 'Reviewer', description: 'Read-only review and audit access',
    permissions: [...READ, 'audit:read', 'job:read'] },
  { key: 'client_viewer', name: 'Client Viewer', description: 'Client read-only access to own company',
    permissions: ['org:read', 'company:read', 'period:read', 'document:read'] },
];

export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);
