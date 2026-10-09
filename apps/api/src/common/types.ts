import type { Request } from 'express';
import type { Permission } from '@uk/contracts';
import type { AccessContext } from './access';

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
  /** Organisation-level role permissions only. Company/practice decisions MUST use `access`. */
  permissions: ReadonlySet<Permission>;
  /** Reach of the organisation membership (ALL = organisation-wide default access). */
  companyScope: 'ALL' | 'ASSIGNED';
  /** Companies with an explicit company-level grant. */
  assignedCompanyIds: readonly string[];
  organisationType: 'PRACTICE' | 'BUSINESS';
  /** Central authorisation facade: every company/practice-level decision goes through this. */
  access: AccessContext;
}

export interface AppRequest extends Request {
  auth?: AuthInfo;
  org?: OrgAccess;
}

