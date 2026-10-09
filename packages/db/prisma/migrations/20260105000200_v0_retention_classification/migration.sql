-- V0 pre-V1 bundle / S4(a) (V0-S8, XP-10, ADR-39): retention CLASSIFICATION. Reference data only - nothing is deleted, archived or anonymised by this
-- migration or by any code that reads it (purge jobs and erasure-versus-retention rules are a separate, not yet approved item).
-- Every document type and every table is mapped to exactly one category. All periods are PROVISIONAL until the DPO/legal decision (V0-8.3) is recorded.
-- The seed below is generated from packages/contracts/src/retention.ts; tests/db/retention.test.ts keeps both identical.

CREATE TABLE "retention_category" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period_years" INTEGER,
    "period_days" INTEGER,
    "period_trigger" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROVISIONAL',
    CONSTRAINT "retention_category_pkey" PRIMARY KEY ("code"),
    CONSTRAINT retention_category_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{1,59}$'),
    CONSTRAINT retention_category_kind_ck CHECK (kind IN ('PERIOD','WHILE_ACTIVE','NOT_APPLICABLE')),
    CONSTRAINT retention_category_status_ck CHECK (status IN ('PROVISIONAL','CONFIRMED')),
    CONSTRAINT retention_category_trigger_ck CHECK (period_trigger IN ('DOCUMENT_DATE','ACCOUNTING_PERIOD_END','TAX_YEAR_END','FILING_DATE','RELATIONSHIP_END','RECORD_CREATED','PROCESSING_COMPLETED','EXPIRY','NOT_APPLICABLE')),
    -- a PERIOD has exactly one of years / days (positive) and a real trigger; the other kinds have neither
    CONSTRAINT retention_category_period_ck CHECK (
      (kind = 'PERIOD' AND num_nonnulls(period_years, period_days) = 1 AND coalesce(period_years, period_days) > 0 AND period_trigger <> 'NOT_APPLICABLE')
      OR (kind <> 'PERIOD' AND period_years IS NULL AND period_days IS NULL AND period_trigger = 'NOT_APPLICABLE'))
);

CREATE TABLE "retention_rule" (
    "subject_kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    CONSTRAINT "retention_rule_pkey" PRIMARY KEY ("subject_kind", "subject"),
    CONSTRAINT retention_rule_kind_ck CHECK (subject_kind IN ('DOCUMENT_TYPE','TABLE')),
    CONSTRAINT "retention_rule_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "retention_category"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "retention_category"(code, name, kind, period_years, period_days, period_trigger, basis, status) VALUES
('ACCOUNTING_RECORDS', 'Accounting and tax records', 'PERIOD', 6, NULL, 'ACCOUNTING_PERIOD_END', 'Companies Act 2006 ss.386-388 (accounting records: 3 years private / 6 years public company); Finance Act 1998 Sch 18 para 21 (corporation tax records: 6 years after the accounting period); VAT Act 1994 Sch 11 para 6 (VAT records: 6 years). The longest applies.', 'PROVISIONAL'),
('FILING_EVIDENCE', 'Statutory filing evidence', 'PERIOD', 6, NULL, 'FILING_DATE', 'Evidence of submitted returns and receipts, kept with the accounting records; locked by the platform until its retention date (ADR-33).', 'PROVISIONAL'),
('PAYROLL_RECORDS', 'Payroll records', 'PERIOD', 6, NULL, 'TAX_YEAR_END', 'Income Tax (PAYE) Regulations 2003 reg 97 (at least 3 years after the tax year); automatic-enrolment pension records 6 years (Occupational and Personal Pension Schemes (Automatic Enrolment) Regulations 2010). The longer is used.', 'PROVISIONAL'),
('TAX_CORRESPONDENCE', 'Tax correspondence', 'PERIOD', 6, NULL, 'TAX_YEAR_END', 'Taxes Management Act 1970 ss.34-36 (assessment time limits 4 years, 6 years if careless, 20 if deliberate); 6 years as the working default.', 'PROVISIONAL'),
('CONTRACTS_ENGAGEMENT', 'Contracts and engagement letters', 'PERIOD', 6, NULL, 'RELATIONSHIP_END', 'Limitation Act 1980 s.5 (contract claims 6 years); s.8 (deeds 12 years) is not assumed.', 'PROVISIONAL'),
('IDENTITY_VERIFICATION', 'Identity verification (anti-money-laundering)', 'PERIOD', 5, NULL, 'RELATIONSHIP_END', 'Money Laundering, Terrorist Financing and Transfer of Funds (Information on the Payer) Regulations 2017 reg 40 (5 years after the business relationship ends).', 'PROVISIONAL'),
('CORPORATE_RECORDS', 'Minutes and resolutions', 'PERIOD', 10, NULL, 'DOCUMENT_DATE', 'Companies Act 2006 s.248 (minutes of directors'' meetings kept for at least 10 years from the date of the meeting) and s.355 (members'' resolutions and meetings).', 'PROVISIONAL'),
('GENERAL_BUSINESS', 'General business documents', 'PERIOD', 6, NULL, 'DOCUMENT_DATE', 'Policy default (Limitation Act 1980 s.5 as a backstop) for documents without a more specific category.', 'PROVISIONAL'),
('AUDIT_TRAIL', 'Audit trail', 'PERIOD', 7, NULL, 'RECORD_CREATED', 'Policy: no statute prescribes a period for a software audit trail; kept at least as long as the accounting records it explains, plus one year.', 'PROVISIONAL'),
('OPERATIONAL_JOBS', 'Background job and idempotency records', 'PERIOD', NULL, 90, 'PROCESSING_COMPLETED', 'Policy: operational diagnostics, kept long enough for support and incident review; contains no business content beyond identifiers (sensitive payloads are encrypted).', 'PROVISIONAL'),
('OPERATIONAL_EVENTS', 'Outbox events and consumer markers', 'PERIOD', NULL, 14, 'PROCESSING_COMPLETED', 'Policy, enforced today by the outbox cleanup (OUTBOX_RETENTION_DAYS): processed events are removed after this window; unprocessed events are never removed.', 'PROVISIONAL'),
('NOTIFICATIONS', 'Notifications, reminders and planned deliveries', 'PERIOD', 1, NULL, 'RECORD_CREATED', 'Policy: transient personal notices; one year.', 'PROVISIONAL'),
('AUTH_TRANSIENT', 'Sessions, verification tokens and challenges', 'PERIOD', NULL, 90, 'EXPIRY', 'Policy: security records of expired credentials, kept for investigation of misuse and then removed.', 'PROVISIONAL'),
('WHILE_ACTIVE', 'Held while the relationship is active', 'WHILE_ACTIVE', NULL, NULL, 'NOT_APPLICABLE', 'Master data and working records that are needed for as long as the organisation or user account exists. The period after termination (and the erasure-versus-retention rules) is decided with the purge work and the DPO; it is not set here.', 'PROVISIONAL'),
('REFERENCE_DATA', 'Reference data (no personal data)', 'NOT_APPLICABLE', NULL, NULL, 'NOT_APPLICABLE', 'Global reference data (ISO tables, jurisdictions, document types, this classification): no personal data, no retention limit.', 'PROVISIONAL');

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
('DOCUMENT_TYPE', 'GENERAL', 'GENERAL_BUSINESS'),
('DOCUMENT_TYPE', 'OTHER', 'GENERAL_BUSINESS'),
('DOCUMENT_TYPE', 'BANK_STATEMENT', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'SALES_INVOICE', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'PURCHASE_INVOICE', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'CREDIT_NOTE', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'RECEIPT', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'VAT_WORKING', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'STATUTORY_ACCOUNTS', 'ACCOUNTING_RECORDS'),
('DOCUMENT_TYPE', 'FILING_EVIDENCE', 'FILING_EVIDENCE'),
('DOCUMENT_TYPE', 'PAYROLL_RECORD', 'PAYROLL_RECORDS'),
('DOCUMENT_TYPE', 'TAX_CORRESPONDENCE', 'TAX_CORRESPONDENCE'),
('DOCUMENT_TYPE', 'CONTRACT', 'CONTRACTS_ENGAGEMENT'),
('DOCUMENT_TYPE', 'LETTER_OF_ENGAGEMENT', 'CONTRACTS_ENGAGEMENT'),
('DOCUMENT_TYPE', 'IDENTITY_VERIFICATION', 'IDENTITY_VERIFICATION'),
('DOCUMENT_TYPE', 'MINUTES', 'CORPORATE_RECORDS'),
('TABLE', 'audit_event', 'AUDIT_TRAIL'),
('TABLE', 'job_record', 'OPERATIONAL_JOBS'),
('TABLE', 'idempotency_record', 'OPERATIONAL_JOBS'),
('TABLE', 'outbox_event', 'OPERATIONAL_EVENTS'),
('TABLE', 'event_consumption', 'OPERATIONAL_EVENTS'),
('TABLE', 'notification', 'NOTIFICATIONS'),
('TABLE', 'notification_delivery', 'NOTIFICATIONS'),
('TABLE', 'notification_preference', 'NOTIFICATIONS'),
('TABLE', 'task_reminder', 'NOTIFICATIONS'),
('TABLE', 'session', 'AUTH_TRANSIENT'),
('TABLE', 'auth_token', 'AUTH_TRANSIENT'),
('TABLE', 'auth_challenge', 'AUTH_TRANSIENT'),
('TABLE', 'login_trusted_ip', 'AUTH_TRANSIENT'),
('TABLE', 'document', 'ACCOUNTING_RECORDS'),
('TABLE', 'document_version', 'ACCOUNTING_RECORDS'),
('TABLE', 'document_extraction', 'ACCOUNTING_RECORDS'),
('TABLE', 'document_folder', 'ACCOUNTING_RECORDS'),
('TABLE', 'document_access', 'ACCOUNTING_RECORDS'),
('TABLE', 'evidence_link', 'ACCOUNTING_RECORDS'),
('TABLE', 'accounting_period', 'ACCOUNTING_RECORDS'),
('TABLE', 'user', 'WHILE_ACTIVE'),
('TABLE', 'user_identity', 'WHILE_ACTIVE'),
('TABLE', 'mfa_factor', 'WHILE_ACTIVE'),
('TABLE', 'mfa_recovery_code', 'WHILE_ACTIVE'),
('TABLE', 'organisation', 'WHILE_ACTIVE'),
('TABLE', 'role', 'WHILE_ACTIVE'),
('TABLE', 'organisation_membership', 'WHILE_ACTIVE'),
('TABLE', 'practice', 'WHILE_ACTIVE'),
('TABLE', 'practice_membership', 'WHILE_ACTIVE'),
('TABLE', 'company_membership', 'WHILE_ACTIVE'),
('TABLE', 'invitation', 'WHILE_ACTIVE'),
('TABLE', 'company', 'WHILE_ACTIVE'),
('TABLE', 'company_officer', 'WHILE_ACTIVE'),
('TABLE', 'contact', 'WHILE_ACTIVE'),
('TABLE', 'address', 'WHILE_ACTIVE'),
('TABLE', 'feature_flag_override', 'WHILE_ACTIVE'),
('TABLE', 'task', 'WHILE_ACTIVE'),
('TABLE', 'task_attachment', 'WHILE_ACTIVE'),
('TABLE', 'task_comment', 'WHILE_ACTIVE'),
('TABLE', 'workflow_instance', 'WHILE_ACTIVE'),
('TABLE', 'workflow_transition', 'WHILE_ACTIVE'),
('TABLE', 'integration_connection', 'WHILE_ACTIVE'),
('TABLE', 'ai_run', 'WHILE_ACTIVE'),
('TABLE', 'ai_proposal', 'WHILE_ACTIVE'),
('TABLE', 'currency', 'REFERENCE_DATA'),
('TABLE', 'country', 'REFERENCE_DATA'),
('TABLE', 'tax_jurisdiction', 'REFERENCE_DATA'),
('TABLE', 'document_type', 'REFERENCE_DATA'),
('TABLE', 'retention_category', 'REFERENCE_DATA'),
('TABLE', 'retention_rule', 'REFERENCE_DATA');

-- Document types that exist only because a legacy database carried them over (20260104000600) are not in the registry: classify them as general business documents.
INSERT INTO "retention_rule"(subject_kind, subject, category_code)
  SELECT 'DOCUMENT_TYPE', t.code, 'GENERAL_BUSINESS' FROM "document_type" t
   WHERE NOT EXISTS (SELECT 1 FROM "retention_rule" r WHERE r.subject_kind = 'DOCUMENT_TYPE' AND r.subject = t.code);

-- REFERENCE class: global, read-only for the runtime role, changed by migrations.
GRANT SELECT ON "retention_category", "retention_rule" TO uk_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "retention_category", "retention_rule" FROM uk_app;
