/**
 * Authoritative map of how every table is protected against cross-tenant access.
 * Documented in docs/architecture/security-architecture.md; enforced by tests/db/classification.test.ts, which fails
 * when a table is added without being classified here, or when its real database protection does not match.
 *
 *  RLS      : PostgreSQL row-level security only (infrastructure plumbing with no user-facing API)
 *  RLS+APP  : row-level security AND application-level authorisation (RBAC permission + company scope)
 *  APP      : application-level controls only — GLOBAL authentication-subsystem tables that are not tenant data
 */
export type Protection = 'RLS' | 'RLS+APP' | 'APP';

export const TABLE_PROTECTION: Record<string, { protection: Protection; why: string }> = {
  // ── Authentication subsystem (global; reached only through apps/api/src/auth) ──
  user: { protection: 'APP', why: 'Identity is global: one person can belong to many organisations.' },
  user_identity: { protection: 'APP', why: 'External IdP links (auth subsystem).' },
  session: { protection: 'APP', why: 'Looked up by hashed token BEFORE any tenant is known.' },
  auth_token: { protection: 'APP', why: 'Email-verification / password-reset tokens (hashed, single use).' },
  mfa_factor: { protection: 'APP', why: 'Per-user second factor.' },
  mfa_recovery_code: { protection: 'APP', why: 'Per-user recovery codes (hashed).' },
  auth_challenge: { protection: 'APP', why: 'Pre-session MFA challenge.' },
  login_trusted_ip: { protection: 'APP', why: 'Per-user hashed IPs used by login throttling.' },
  // ── Tenant data: RLS + application authorisation ──
  organisation: { protection: 'RLS+APP', why: 'Tenant root; visible to active members only.' },
  role: { protection: 'RLS+APP', why: 'System roles readable by all; custom roles per tenant.' },
  feature_flag_override: { protection: 'RLS+APP', why: 'Per-organisation feature toggles; changing them needs org:manage.' },
  organisation_membership: { protection: 'RLS+APP', why: 'A user sees own memberships everywhere; only the org context can change them.' },
  practice: { protection: 'RLS+APP', why: 'Practice inside a PRACTICE organisation; access via practice:* permissions.' },
  practice_membership: { protection: 'RLS+APP', why: 'Practice-level role grants.' },
  company_membership: { protection: 'RLS+APP', why: 'Company-level role grants (most specific grant).' },
  invitation: { protection: 'RLS+APP', why: 'Token lookup uses the audited system context.' },
  company: { protection: 'RLS+APP', why: 'Client company; company-scope enforced in services.' },
  accounting_period: { protection: 'RLS+APP', why: 'Company child; composite FK to company.' },
  document: { protection: 'RLS+APP', why: 'Business documents.' },
  document_version: { protection: 'RLS+APP', why: 'Immutable versions.' },
  audit_event: { protection: 'RLS+APP', why: 'Append-only; org events by org context, pre-tenant events only by their actor.' },
  job_record: { protection: 'RLS+APP', why: 'Job status API is permission-guarded.' },
  workflow_instance: { protection: 'RLS+APP', why: 'Approvals; company scope enforced in controller.' },
  workflow_transition: { protection: 'RLS+APP', why: 'Append-only history.' },
  task: { protection: 'RLS+APP', why: 'Work items; company scope enforced.' },
  notification: { protection: 'RLS+APP', why: 'Private to the recipient (RLS on user_id as well).' },
  integration_connection: { protection: 'RLS+APP', why: 'Encrypted provider credentials.' },
  ai_run: { protection: 'RLS+APP', why: 'Append-only AI invocation log.' },
  ai_proposal: { protection: 'RLS+APP', why: 'Human-reviewed AI output.' },
  // ── Plumbing: RLS only (no HTTP surface; infrastructure code uses tenant or system context) ──
  outbox_event: { protection: 'RLS', why: 'Transactional outbox; written in the business transaction, relayed by the system context.' },
  event_consumption: { protection: 'RLS', why: 'Consumer idempotency markers.' },
  idempotency_record: { protection: 'RLS', why: 'Per-tenant request replay cache.' },
};

export const TENANT_TABLES = Object.entries(TABLE_PROTECTION).filter(([, v]) => v.protection !== 'APP').map(([k]) => k);
export const GLOBAL_AUTH_TABLES = Object.entries(TABLE_PROTECTION).filter(([, v]) => v.protection === 'APP').map(([k]) => k);
