import { DOCUMENT_TYPES } from './documents';

/**
 * Retention classification (V0 section 8 / cross-platform section 10, ADR-39). Every document type and every table is assigned to exactly
 * one retention category, so data created by later versions is classified from day one. THIS IS CLASSIFICATION ONLY: nothing here deletes,
 * archives or anonymises anything (purge jobs and erasure-versus-retention rules are a separate, not yet approved item).
 *
 * `status: 'PROVISIONAL'` on every category: the periods below are working defaults drawn from the statutory anchors named in `basis`, but
 * the product's retention policy and lawful basis are a DPO / legal decision that is still open (specification V0-8.3). Do not read a
 * PROVISIONAL period as legal advice or as a confirmed policy. Mirrors the `retention_category` / `retention_rule` reference tables;
 * tests keep both identical (same pattern as DOCUMENT_TYPES).
 */
export const RETENTION_TRIGGERS = [
  'DOCUMENT_DATE', 'ACCOUNTING_PERIOD_END', 'TAX_YEAR_END', 'FILING_DATE', 'RELATIONSHIP_END', 'RECORD_CREATED', 'PROCESSING_COMPLETED', 'EXPIRY', 'NOT_APPLICABLE',
] as const;
export type RetentionTrigger = (typeof RETENTION_TRIGGERS)[number];
export const RETENTION_KINDS = ['PERIOD', 'WHILE_ACTIVE', 'NOT_APPLICABLE'] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export interface RetentionCategory {
  code: string; name: string; kind: RetentionKind;
  /** Exactly one of years / days for PERIOD; both null otherwise. */
  years: number | null; days: number | null;
  /** The event the period runs from. */
  trigger: RetentionTrigger;
  /** Statutory or policy anchor (human-readable; not legal advice). */
  basis: string;
  status: 'PROVISIONAL' | 'CONFIRMED';
}

const period = (code: string, name: string, p: { years?: number; days?: number }, trigger: RetentionTrigger, basis: string): RetentionCategory =>
  ({ code, name, kind: 'PERIOD', years: p.years ?? null, days: p.days ?? null, trigger, basis, status: 'PROVISIONAL' });

export const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  period('ACCOUNTING_RECORDS', 'Accounting and tax records', { years: 6 }, 'ACCOUNTING_PERIOD_END',
    'Companies Act 2006 ss.386-388 (accounting records: 3 years private / 6 years public company); Finance Act 1998 Sch 18 para 21 (corporation tax records: 6 years after the accounting period); VAT Act 1994 Sch 11 para 6 (VAT records: 6 years). The longest applies.'),
  period('FILING_EVIDENCE', 'Statutory filing evidence', { years: 6 }, 'FILING_DATE',
    'Evidence of submitted returns and receipts, kept with the accounting records; locked by the platform until its retention date (ADR-33).'),
  period('PAYROLL_RECORDS', 'Payroll records', { years: 6 }, 'TAX_YEAR_END',
    'Income Tax (PAYE) Regulations 2003 reg 97 (at least 3 years after the tax year); automatic-enrolment pension records 6 years (Occupational and Personal Pension Schemes (Automatic Enrolment) Regulations 2010). The longer is used.'),
  period('TAX_CORRESPONDENCE', 'Tax correspondence', { years: 6 }, 'TAX_YEAR_END',
    'Taxes Management Act 1970 ss.34-36 (assessment time limits 4 years, 6 years if careless, 20 if deliberate); 6 years as the working default.'),
  period('CONTRACTS_ENGAGEMENT', 'Contracts and engagement letters', { years: 6 }, 'RELATIONSHIP_END',
    'Limitation Act 1980 s.5 (contract claims 6 years); s.8 (deeds 12 years) is not assumed.'),
  period('IDENTITY_VERIFICATION', 'Identity verification (anti-money-laundering)', { years: 5 }, 'RELATIONSHIP_END',
    'Money Laundering, Terrorist Financing and Transfer of Funds (Information on the Payer) Regulations 2017 reg 40 (5 years after the business relationship ends).'),
  period('CORPORATE_RECORDS', 'Minutes and resolutions', { years: 10 }, 'DOCUMENT_DATE',
    'Companies Act 2006 s.248 (minutes of directors\' meetings kept for at least 10 years from the date of the meeting) and s.355 (members\' resolutions and meetings).'),
  period('GENERAL_BUSINESS', 'General business documents', { years: 6 }, 'DOCUMENT_DATE',
    'Policy default (Limitation Act 1980 s.5 as a backstop) for documents without a more specific category.'),
  period('AUDIT_TRAIL', 'Audit trail', { years: 7 }, 'RECORD_CREATED',
    'Policy: no statute prescribes a period for a software audit trail; kept at least as long as the accounting records it explains, plus one year.'),
  period('OPERATIONAL_JOBS', 'Background job and idempotency records', { days: 90 }, 'PROCESSING_COMPLETED',
    'Policy: operational diagnostics, kept long enough for support and incident review; contains no business content beyond identifiers (sensitive payloads are encrypted).'),
  // Matches what the platform actually enforces today (OUTBOX_RETENTION_DAYS, default 14; asserted by a test).
  period('OPERATIONAL_EVENTS', 'Outbox events and consumer markers', { days: 14 }, 'PROCESSING_COMPLETED',
    'Policy, enforced today by the outbox cleanup (OUTBOX_RETENTION_DAYS): processed events are removed after this window; unprocessed events are never removed.'),
  period('NOTIFICATIONS', 'Notifications, reminders and planned deliveries', { years: 1 }, 'RECORD_CREATED',
    'Policy: transient personal notices; one year.'),
  period('AUTH_TRANSIENT', 'Sessions, verification tokens and challenges', { days: 90 }, 'EXPIRY',
    'Policy: security records of expired credentials, kept for investigation of misuse and then removed.'),
  { code: 'WHILE_ACTIVE', name: 'Held while the relationship is active', kind: 'WHILE_ACTIVE', years: null, days: null, trigger: 'NOT_APPLICABLE', status: 'PROVISIONAL',
    basis: 'Master data and working records that are needed for as long as the organisation or user account exists. The period after termination (and the erasure-versus-retention rules) is decided with the purge work and the DPO; it is not set here.' },
  { code: 'REFERENCE_DATA', name: 'Reference data (no personal data)', kind: 'NOT_APPLICABLE', years: null, days: null, trigger: 'NOT_APPLICABLE', status: 'PROVISIONAL',
    basis: 'Global reference data (ISO tables, jurisdictions, document types, this classification): no personal data, no retention limit.' },
];

export type RetentionSubjectKind = 'DOCUMENT_TYPE' | 'TABLE';
export interface RetentionRule { kind: RetentionSubjectKind; subject: string; category: string }

const docRule = (subject: string, category: string): RetentionRule => ({ kind: 'DOCUMENT_TYPE', subject, category });
const tableRules = (category: string, tables: string[]): RetentionRule[] => tables.map((subject) => ({ kind: 'TABLE', subject, category }));

const DOCUMENT_TYPE_CATEGORY: Record<(typeof DOCUMENT_TYPES)[number]['code'], string> = {
  GENERAL: 'GENERAL_BUSINESS', OTHER: 'GENERAL_BUSINESS',
  BANK_STATEMENT: 'ACCOUNTING_RECORDS', SALES_INVOICE: 'ACCOUNTING_RECORDS', PURCHASE_INVOICE: 'ACCOUNTING_RECORDS', CREDIT_NOTE: 'ACCOUNTING_RECORDS',
  RECEIPT: 'ACCOUNTING_RECORDS', VAT_WORKING: 'ACCOUNTING_RECORDS', STATUTORY_ACCOUNTS: 'ACCOUNTING_RECORDS',
  FILING_EVIDENCE: 'FILING_EVIDENCE', PAYROLL_RECORD: 'PAYROLL_RECORDS', TAX_CORRESPONDENCE: 'TAX_CORRESPONDENCE',
  CONTRACT: 'CONTRACTS_ENGAGEMENT', LETTER_OF_ENGAGEMENT: 'CONTRACTS_ENGAGEMENT', IDENTITY_VERIFICATION: 'IDENTITY_VERIFICATION', MINUTES: 'CORPORATE_RECORDS',
};

/** Every table must appear here exactly once (tests compare with the table-protection registry, so a new table without a rule fails the build). */
export const RETENTION_RULES: readonly RetentionRule[] = [
  ...Object.entries(DOCUMENT_TYPE_CATEGORY).map(([code, category]) => docRule(code, category)),
  ...tableRules('AUDIT_TRAIL', ['audit_event']),
  ...tableRules('OPERATIONAL_JOBS', ['job_record', 'idempotency_record']),
  ...tableRules('OPERATIONAL_EVENTS', ['outbox_event', 'event_consumption']),
  ...tableRules('NOTIFICATIONS', ['notification', 'notification_delivery', 'notification_preference', 'task_reminder']),
  ...tableRules('AUTH_TRANSIENT', ['session', 'auth_token', 'auth_challenge', 'login_trusted_ip']),
  // Documents and what explains them follow the document's own category (looked up per document type), not a table-wide period.
  ...tableRules('ACCOUNTING_RECORDS', ['document', 'document_version', 'document_extraction', 'document_folder', 'document_access', 'evidence_link', 'accounting_period']),
  ...tableRules('WHILE_ACTIVE', [
    'user', 'user_identity', 'mfa_factor', 'mfa_recovery_code', 'organisation', 'role', 'organisation_membership', 'practice', 'practice_membership', 'company_membership', 'invitation',
    'company', 'company_officer', 'contact', 'address', 'feature_flag_override', 'task', 'task_attachment', 'task_comment', 'workflow_instance', 'workflow_transition',
    'integration_connection', 'ai_run', 'ai_proposal',
  ]),
  ...tableRules('REFERENCE_DATA', ['currency', 'country', 'tax_jurisdiction', 'document_type', 'retention_category', 'retention_rule']),
];

export const retentionCategoryFor = (kind: RetentionSubjectKind, subject: string): RetentionCategory | undefined => {
  const code = RETENTION_RULES.find((r) => r.kind === kind && r.subject === subject)?.category;
  return RETENTION_CATEGORIES.find((c) => c.code === code);
};

/**
 * The date until which a record must be kept, given the date its period starts from. null for categories without a fixed period.
 * Calendar arithmetic in UTC; 29 February + n years lands on 28 February when the target year is not a leap year.
 */
export function retainUntil(category: RetentionCategory, anchor: Date): Date | null {
  if (category.kind !== 'PERIOD') return null;
  if (category.days != null) return new Date(anchor.getTime() + category.days * 86_400_000);
  const y = anchor.getUTCFullYear() + (category.years ?? 0);
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}
