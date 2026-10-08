import type { Request } from 'express';
import type { Permission } from '@uk/contracts';

export interface AuthInfo {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  mfaVerifiedAt: Date | null;
  viaCookie: boolean;
}

export interface OrgAccess {
  organisationId: string;
  membershipId: string;
  userId: string;
  roleKey: string;
  permissions: ReadonlySet<Permission>;
  companyScope: 'ALL' | 'ASSIGNED';
  assignedCompanyIds: readonly string[];
}

export interface AppRequest extends Request {
  auth?: AuthInfo;
  org?: OrgAccess;
}

export const canAccessCompany = (org: OrgAccess, companyId: string): boolean =>
  org.companyScope === 'ALL' || org.assignedCompanyIds.includes(companyId);
