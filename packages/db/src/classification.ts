/**
 * Authoritative map of how every table is protected against cross-tenant access.
 * Documented in docs/architecture/security-architecture.md; enforced by tests/db/classification.test.ts, which fails
 * when a table is added without being classified here, or when its real database protection does not match.
 *
 *  RLS      : PostgreSQL row-level security only (infrastructure plumbing with no user-facing API)
 *  RLS+APP  : row-level security AND application-level authorisation (RBAC permission + company scope)
 *  APP      : application-level controls only — GLOBAL authentication-subsystem tables that are not tenant data
 *  REFERENCE: global reference data (currencies, countries, tax jurisdictions): no tenant data, READ-ONLY for the runtime role;
 *             changed only by migrations
 */
export type Protection = 'RLS' | 'RLS+APP' | 'APP' | 'REFERENCE';

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
  currency: { protection: 'REFERENCE', why: 'ISO 4217; global, read-only for the runtime role.' },
  country: { protection: 'REFERENCE', why: 'ISO 3166-1; global, read-only for the runtime role.' },
  tax_jurisdiction: { protection: 'REFERENCE', why: 'Effective-dated jurisdictions; global, read-only for the runtime role.' },
  document_type: { protection: 'REFERENCE', why: 'Controlled document types; global, read-only for the runtime role.' },
  retention_category: { protection: 'REFERENCE', why: 'Retention classification categories (provisional periods); global, read-only for the runtime role.' },
  retention_rule: { protection: 'REFERENCE', why: 'Maps every document type and table to a retention category; global, read-only for the runtime role.' },
  contact: { protection: 'RLS+APP', why: 'Master data; company-linked contacts follow company access, organisation-level ones the organisation role.' },
  address: { protection: 'RLS+APP', why: 'Owned by exactly one company or contact; follows the owner\'s access rules.' },
  company_officer: { protection: 'RLS+APP', why: 'Directors/officers of a company; follows company access.' },
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
  document_folder: { protection: 'RLS+APP', why: 'Document folders; follow the folder company (document permissions).' },
  document_extraction: { protection: 'RLS+APP', why: 'OCR output (data only); visibility follows the document.' },
  evidence_link: { protection: 'RLS+APP', why: 'Evidence graph; ends are validated against each end\'s own permission and company.' },
  document_access: { protection: 'RLS+APP', why: 'Explicit grants on restricted documents; managed with document:confidential.' },
  task_attachment: { protection: 'RLS+APP', why: 'Task-to-document links; follow the task company.' },
  task_comment: { protection: 'RLS+APP', why: 'Append-only task conversation; follows the task company.' },
  task_reminder: { protection: 'RLS+APP', why: 'Scheduled task reminders; delivered per tenant by the worker sweeper.' },
  notification: { protection: 'RLS+APP', why: 'Private to the recipient (RLS on user_id as well).' },
  notification_preference: { protection: 'RLS+APP', why: 'Per-user channel opt-ins; the API only ever reads and writes the caller\'s own rows.' },
  notification_delivery: { protection: 'RLS', why: 'Planned out-of-band deliveries (outbox-like); no HTTP surface, written with the notification and executed by the worker sweeper.' },
  integration_connection: { protection: 'RLS+APP', why: 'Encrypted provider credentials.' },
  ai_run: { protection: 'RLS+APP', why: 'Append-only AI invocation log.' },
  ai_proposal: { protection: 'RLS+APP', why: 'Human-reviewed AI output.' },
  // ── Plumbing: RLS only (no HTTP surface; infrastructure code uses tenant or system context) ──
  outbox_event: { protection: 'RLS', why: 'Transactional outbox; written in the business transaction, relayed by the system context.' },
  event_consumption: { protection: 'RLS', why: 'Consumer idempotency markers.' },
  idempotency_record: { protection: 'RLS', why: 'Per-tenant request replay cache.' },
};

export const TENANT_TABLES = Object.entries(TABLE_PROTECTION).filter(([, v]) => v.protection === 'RLS' || v.protection === 'RLS+APP').map(([k]) => k);
export const REFERENCE_TABLES = Object.entries(TABLE_PROTECTION).filter(([, v]) => v.protection === 'REFERENCE').map(([k]) => k);
export const GLOBAL_AUTH_TABLES = Object.entries(TABLE_PROTECTION).filter(([, v]) => v.protection === 'APP').map(([k]) => k);
