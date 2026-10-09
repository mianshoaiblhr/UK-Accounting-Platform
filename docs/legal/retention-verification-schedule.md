# Legal verification schedule - record retention and IP / user-agent data

**Status: UNVERIFIED and NOT APPROVED.** Prepared 2026-10-09 for the product owner's review (decision DEC-003 in `docs/architecture/decision-log.md`). This is an engineering working document, **not legal advice**. Every provision, period and link below must be checked by a qualified person against the official source before any period is marked CONFIRMED. The sources were **not opened** when this was written (the build environment cannot reach them), so citations are from memory of the legislation and may contain errors in paragraph numbers - they are flagged where known.

No retention period and no lawful basis in this document is approved. Until a decision is recorded: all periods stay PROVISIONAL, S4(b) (purge jobs, irreversible erasure rules, production retention enforcement) stays disabled, and development uses synthetic/test data only.

Review date for every row: Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance. Reviewer, decision and decision date are left blank on purpose.

## 1. Retention schedule
One row per category in `packages/contracts/src/retention.ts` (a test keeps this document and the registry in step).

### ACCOUNTING_RECORDS - Accounting and tax records

| Field | Content |
|---|---|
| Provisional period | **6 years** (PROVISIONAL) |
| Record / entity types | Document types BANK_STATEMENT, SALES_INVOICE, PURCHASE_INVOICE, CREDIT_NOTE, RECEIPT, VAT_WORKING, STATUTORY_ACCOUNTS; tables document, document_version, document_extraction, document_folder, document_access, evidence_link, accounting_period. V1 will add journals, ledger lines, invoices, bank transactions. |
| Statutory provisions | Companies Act 2006 s.386 (duty to keep accounting records) and s.388 (preservation: private company 3 years, public company 6 years); Finance Act 1998 Sch 18 para 21 (company tax return records: 6 years after the end of the accounting period); Value Added Tax Act 1994 Sch 11 para 6 (VAT records: up to 6 years) and HMRC VAT Notice 700/21 |
| Official sources | <https://www.legislation.gov.uk/ukpga/2006/46/section/386> ; <https://www.legislation.gov.uk/ukpga/2006/46/section/388> ; <https://www.legislation.gov.uk/ukpga/1998/36/schedule/18/paragraph/21> ; <https://www.legislation.gov.uk/ukpga/1994/23/schedule/11/paragraph/6> ; <https://www.gov.uk/guidance/vat-record-keeping> |
| Clock-start event | End of the accounting period the record relates to (corporation tax); date the record was made (Companies Act); VAT: the retention period runs per HMRC notice (reviewer to confirm start event) |
| Exceptions / extensions | HMRC may require records for longer in an enquiry; insolvency and liquidation rules; legal hold; records of transactions straddling periods; the Companies Act minimum differs for private (3) and public (6) companies - the platform uses the longest |
| Questions for the reviewer | Confirm the clock-start event per record type (period end vs transaction date); confirm whether to keep the longest period for all customers or let the controller choose. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### FILING_EVIDENCE - Statutory filing evidence

| Field | Content |
|---|---|
| Provisional period | **6 years** (PROVISIONAL) |
| Record / entity types | Document type FILING_EVIDENCE; later versions: submitted returns, receipts and acknowledgements (V3 Companies House, V4 corporation tax, V5 VAT). Enforced today: evidence is locked (database triggers) until its retention date; default 6 years. |
| Statutory provisions | Same provisions as ACCOUNTING_RECORDS (a filed return is part of the records supporting it); Taxes Management Act 1970 ss.34-36 for the assessment windows within which a filing may be challenged |
| Official sources | <https://www.legislation.gov.uk/ukpga/1998/36/schedule/18/paragraph/21> ; <https://www.legislation.gov.uk/ukpga/1970/9/section/34> ; <https://www.legislation.gov.uk/ukpga/1970/9/section/36> |
| Clock-start event | Date of filing in the platform today; the statutory period may run from the end of the accounting period instead - the two can differ |
| Exceptions / extensions | Enquiries and discovery assessments extend the exposure (4 / 6 / 20 years in TMA 1970); legal hold; the lock prevents deletion before the retention date |
| Questions for the reviewer | Which start event is correct (filing date vs period end)? The platform's lock uses filing date today. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### PAYROLL_RECORDS - Payroll records

| Field | Content |
|---|---|
| Provisional period | **6 years** (PROVISIONAL) |
| Record / entity types | Document type PAYROLL_RECORD; later versions: payroll journals and employee pay records if introduced. |
| Statutory provisions | Income Tax (PAYE) Regulations 2003 reg 97 (PAYE records: at least 3 years after the end of the tax year); automatic-enrolment record-keeping under the Occupational and Personal Pension Schemes (Automatic Enrolment) Regulations 2010 (6 years - exact regulation to be confirmed by the reviewer); National Minimum Wage Regulations 2015 (pay records - regulation to be confirmed) |
| Official sources | <https://www.legislation.gov.uk/uksi/2003/2682/regulation/97> ; <https://www.legislation.gov.uk/uksi/2010/772/contents> ; <https://www.legislation.gov.uk/uksi/2015/621/contents> |
| Clock-start event | End of the tax year the payments relate to |
| Exceptions / extensions | The longer of the PAYE and pension periods is used; employee personal data raises storage-limitation questions beyond the statutory minimum |
| Questions for the reviewer | Is payroll data in scope of the product at all (the specification names payroll only as an integration in V11)? Confirm exact regulations. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### TAX_CORRESPONDENCE - Tax correspondence

| Field | Content |
|---|---|
| Provisional period | **6 years** (PROVISIONAL) |
| Record / entity types | Document type TAX_CORRESPONDENCE. |
| Statutory provisions | Taxes Management Act 1970 ss.34 (ordinary time limit 4 years), 36 (6 years where loss of tax is brought about carelessly, 20 years if deliberately); Finance Act 1998 Sch 18 para 21 |
| Official sources | <https://www.legislation.gov.uk/ukpga/1970/9/section/34> ; <https://www.legislation.gov.uk/ukpga/1970/9/section/36> ; <https://www.legislation.gov.uk/ukpga/1998/36/schedule/18/paragraph/21> |
| Clock-start event | End of the tax year / accounting period the correspondence relates to |
| Exceptions / extensions | Open enquiries and appeals; 20-year deliberate-conduct window is NOT assumed |
| Questions for the reviewer | Should deliberate-conduct exposure (20 years) ever be reflected, or is 6 years the policy? |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### CONTRACTS_ENGAGEMENT - Contracts and engagement letters

| Field | Content |
|---|---|
| Provisional period | **6 years** (PROVISIONAL) |
| Record / entity types | Document types CONTRACT, LETTER_OF_ENGAGEMENT. |
| Statutory provisions | Limitation Act 1980 s.5 (contract: 6 years), s.8 (specialty/deeds: 12 years), s.2 (tort: 6 years), ss.14A-14B (latent damage in negligence: 3 years from knowledge, 15-year longstop), s.32 (concealment). Professional-body and professional-indemnity-insurer record requirements are outside the statute and must be checked separately. |
| Official sources | <https://www.legislation.gov.uk/ukpga/1980/58/section/5> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/8> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/2> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/14A> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/14B> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/32> |
| Clock-start event | End of the engagement / business relationship |
| Exceptions / extensions | Latent-damage and concealment rules can extend exposure to 15 years or more; deeds are 12 years |
| Questions for the reviewer | Does the controller (the accounting firm) need a longer period for professional-negligence exposure? Who decides: platform or firm? |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### IDENTITY_VERIFICATION - Identity verification (anti-money-laundering)

| Field | Content |
|---|---|
| Provisional period | **5 years** (PROVISIONAL) |
| Record / entity types | Document type IDENTITY_VERIFICATION; later versions: customer due diligence records. |
| Statutory provisions | Money Laundering, Terrorist Financing and Transfer of Funds (Information on the Payer) Regulations 2017 reg 40: records kept for 5 years from the end of the business relationship (or occasional transaction); the regulation also requires deletion of personal data after that period unless an exception applies (reviewer to confirm the exact paragraphs) |
| Official sources | <https://www.legislation.gov.uk/uksi/2017/692/regulation/40> |
| Clock-start event | End of the business relationship |
| Exceptions / extensions | Mandatory deletion after the period unless a legal requirement, proceedings or consent applies; HMRC may direct a longer period |
| Questions for the reviewer | This is the one category where deletion is a legal duty, not only a limit: confirm the process and the exceptions before S4(b). |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### CORPORATE_RECORDS - Minutes and resolutions

| Field | Content |
|---|---|
| Provisional period | **10 years** (PROVISIONAL) |
| Record / entity types | Document type MINUTES. |
| Statutory provisions | Companies Act 2006 s.248 (minutes of directors' meetings: at least 10 years from the date of the meeting) and s.355 (records of members' resolutions and meetings: 10 years) |
| Official sources | <https://www.legislation.gov.uk/ukpga/2006/46/section/248> ; <https://www.legislation.gov.uk/ukpga/2006/46/section/355> |
| Clock-start event | Date of the meeting or resolution |
| Exceptions / extensions | The duty is the company's; the platform holds copies on its behalf |
| Questions for the reviewer | Confirm the platform is not the statutory record and that 10 years is the minimum a firm should apply. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### GENERAL_BUSINESS - General business documents

| Field | Content |
|---|---|
| Provisional period | **6 years (policy)** (PROVISIONAL) |
| Record / entity types | Document types GENERAL, OTHER; any document type later added without a specific rule. |
| Statutory provisions | No specific statutory period. UK GDPR Art 5(1)(e) (storage limitation) requires a defined period and a justification; Limitation Act 1980 s.5 used only as a backstop |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> ; <https://www.legislation.gov.uk/ukpga/1980/58/section/5> |
| Clock-start event | Document date |
| Exceptions / extensions | None identified |
| Questions for the reviewer | Is a blanket 6-year default defensible under storage limitation, or should uncategorised documents have a shorter period? |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### AUDIT_TRAIL - Audit trail

| Field | Content |
|---|---|
| Provisional period | **7 years (policy)** (PROVISIONAL) |
| Record / entity types | Table audit_event (append-only). Contains actor, action, entity, before/after snapshots (redacted), reason, correlation id, and - unless the privacy switch is off - IP address and user agent. |
| Statutory provisions | No statute prescribes a period for a software audit trail. Accountability and storage limitation: UK GDPR Art 5(1)(e) and Art 5(2). The period was chosen as the accounting-records period plus one year (policy, not law). |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> |
| Clock-start event | Date of the event |
| Exceptions / extensions | Security investigations; legal hold |
| Questions for the reviewer | Is 7 years proportionate for the personal-data parts of the trail (IP, user agent, names)? See section 2: it may justify a shorter period for those fields only. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### OPERATIONAL_JOBS - Background job and idempotency records

| Field | Content |
|---|---|
| Provisional period | **90 days (policy)** (PROVISIONAL) |
| Record / entity types | Tables job_record, idempotency_record. Payloads of sensitive jobs are encrypted; records carry organisation/company/trace ids. |
| Statutory provisions | Policy only (diagnostics). UK GDPR Art 5(1)(c),(e) data minimisation and storage limitation. |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> |
| Clock-start event | Job completion / record creation |
| Exceptions / extensions | Incident review; dead-lettered jobs awaiting an operator |
| Questions for the reviewer | Confirm 90 days; no purge exists yet (S4(b)). |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### OPERATIONAL_EVENTS - Outbox events and consumer markers

| Field | Content |
|---|---|
| Provisional period | **14 days (policy, enforced)** (PROVISIONAL) |
| Record / entity types | Tables outbox_event, event_consumption. Enforced today: processed events are deleted after OUTBOX_RETENTION_DAYS (default 14); unprocessed events are never deleted. |
| Statutory provisions | Policy only. UK GDPR Art 5(1)(e). |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> |
| Clock-start event | Event processed |
| Exceptions / extensions | Unprocessed or FAILED events are kept for an operator |
| Questions for the reviewer | None expected. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### NOTIFICATIONS - Notifications, reminders and planned deliveries

| Field | Content |
|---|---|
| Provisional period | **1 year (policy)** (PROVISIONAL) |
| Record / entity types | Tables notification, notification_delivery, notification_preference, task_reminder. |
| Statutory provisions | Policy only. UK GDPR Art 5(1)(e); notification preferences are consent-like settings (Privacy and Electronic Communications Regulations 2003 apply to marketing, not to transactional notices - reviewer to confirm). |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> ; <https://www.legislation.gov.uk/uksi/2003/2426/contents> |
| Clock-start event | Record creation |
| Exceptions / extensions | None identified |
| Questions for the reviewer | Confirm 1 year; confirm that e-mail notices are service messages, not marketing. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### AUTH_TRANSIENT - Sessions, verification tokens and challenges

| Field | Content |
|---|---|
| Provisional period | **90 days (policy)** (PROVISIONAL) |
| Record / entity types | Tables session, auth_token, auth_challenge, login_trusted_ip. See section 2 for the IP and user-agent fields. |
| Statutory provisions | Policy only. UK GDPR Art 5(1)(e) and Art 32 (security of processing). |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/5> ; <https://www.legislation.gov.uk/eur/2016/679/article/32> |
| Clock-start event | Expiry or revocation of the credential |
| Exceptions / extensions | Security investigations |
| Questions for the reviewer | Confirm 90 days after expiry; see section 2. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### WHILE_ACTIVE - Held while the relationship is active

| Field | Content |
|---|---|
| Provisional period | **UNDEFINED** (PROVISIONAL) |
| Record / entity types | Master data and working records: users, organisations, memberships, roles, companies, contacts, addresses, officers, tasks, comments, workflows, integration connections, AI runs and proposals. |
| Statutory provisions | UK GDPR Art 5(1)(e), Art 17 (erasure, with the Art 17(3)(b) exception for legal obligations) and Art 28 (processor duties on termination). Where the platform acts as processor for an accounting firm, retention instructions come from the firm (the controller). |
| Official sources | <https://www.legislation.gov.uk/eur/2016/679/article/17> ; <https://www.legislation.gov.uk/eur/2016/679/article/28> ; <https://www.legislation.gov.uk/eur/2016/679/article/5> |
| Clock-start event | Termination of the customer relationship (not defined) |
| Exceptions / extensions | Statutory records inside these tables (e.g. company officers) may need to outlive the account |
| Questions for the reviewer | Define the after-termination period and the controller/processor split BEFORE S4(b): this category has no period at all today. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

### REFERENCE_DATA - Reference data (no personal data)

| Field | Content |
|---|---|
| Provisional period | **No limit** (PROVISIONAL) |
| Record / entity types | Tables currency, country, tax_jurisdiction, document_type, retention_category, retention_rule. |
| Statutory provisions | None: no personal data. |
| Official sources |  |
| Clock-start event | n/a |
| Exceptions / extensions | None |
| Questions for the reviewer | None. |
| Verification status | UNVERIFIED |
| Review date | Before the production retention gate (date to be set by the reviewer), then every 12 months and on any change in law or guidance |
| Reviewer / decision / date | (blank) |

## 2. IP address and user agent - flagged for privacy review
Where the platform stores them (from the code, 2026-10-09):

| Location | Purpose (as built) | Covered by the AUDIT_CAPTURE_DEVICE_METADATA switch? | Current retention | Question for the reviewer |
|---|---|---|---|---|
| audit_event.ip, audit_event.user_agent | Audit trail for security and accountability (who did what, from where) | YES - AUDIT_CAPTURE_DEVICE_METADATA (default on) | AUDIT_TRAIL (7 years, provisional); no purge exists | Is capturing IP and user agent in every audit row necessary and proportionate? Should the personal fields have a shorter period than the row (e.g. truncated or removed after N months)? |
| API access log lines (ip, userAgent fields) | Operations and incident triage | YES - same switch | CloudWatch log group retention: Terraform variable log_retention_days, default 400 days (infrastructure setting, not applied) | Is 400 days justified for logs containing IPs? (Not yet applied to any AWS account.) |
| session.ip, session.user_agent | Session list shown to the user ("where am I signed in") and security review | NO - stored regardless of the switch | AUTH_TRANSIENT (90 days after expiry, provisional); rows are not purged today so they currently persist | Why is this not under the same switch? Is storing it needed beyond the session lifetime? Needs an explicit decision and, if kept, a purge. |
| login_trusted_ip.ip_hash | Login throttling: IPs that previously succeeded for the account (SHA-256 hash) | NO - not governed by the switch | AUTH_TRANSIENT category by analogy; kept per user with no expiry today | A hashed IP is still personal data (pseudonymised). Is indefinite retention justified, or should entries expire? |
| Redis login-throttle keys (lt:ip, lt:pair, lt:acct: SHA-256 hashes of IP and e-mail, truncated) | Brute-force protection | NO | Keys expire within minutes (TTL about 15 minutes; verified in code and test) | Probably fine; confirm that short-lived hashed keys need no further treatment. |
| Redis rate-limit keys (rl:<route>:ip:<IP> and rl:mfa:ip:<IP> - the RAW IP address in the key name; added by the DEC-013 investigation, correcting an earlier statement that all Redis keys were hashed) | Per-IP request rate limiting on authentication routes | NO | Keys expire after their window (seconds to one hour; verified by test) | Raw IPs in Redis for up to an hour: acceptable for rate limiting, or should the key be hashed like the login-throttle keys? Redis persistence/backup settings are an input. |
| auth_challenge.ip - written at the password step when MFA is required; NEVER READ by any code (found by the DEC-013 investigation) | None found in the code: collection without a use | NO | Row not purged | Data-minimisation question: stop collecting it? (A proposal, not a change.) |

**Finding:** the privacy switch covers `audit_event` and the access log only. `session.ip`/`session.user_agent` and `auth_challenge.ip` are stored regardless, and none of these rows is purged today. This is reported, not changed: whether to extend the switch, shorten retention or remove fields is a decision for the reviewer (DEC-003).

**Lawful basis:** not decided. See the candidate bases and the questions in section 3; selecting one is the controller's decision, with a documented assessment.

## 3. Legal sources for the privacy questions
| Source | Official link | Relevance |
|---|---|---|
| UK GDPR Art 5(1)(e) storage limitation; Art 5(2) accountability | <https://www.legislation.gov.uk/eur/2016/679/article/5> | Personal data kept no longer than necessary; the controller must be able to demonstrate compliance |
| UK GDPR Art 6 lawfulness of processing | <https://www.legislation.gov.uk/eur/2016/679/article/6> | Candidate bases for IP/user-agent processing (for the reviewer to assess; NONE is selected or approved here): Art 6(1)(f) legitimate interests (security, fraud prevention) with a documented balancing test; Art 6(1)(c) legal obligation where a duty applies |
| UK GDPR Art 17 erasure and Art 17(3)(b) | <https://www.legislation.gov.uk/eur/2016/679/article/17> | Erasure requests versus statutory retention |
| UK GDPR Art 28 processors | <https://www.legislation.gov.uk/eur/2016/679/article/28> | Who is controller of client data held in the platform |
| Data Protection Act 2018 | <https://www.legislation.gov.uk/ukpga/2018/12/contents> | UK implementation and exemptions |
| ICO guidance: storage limitation and retention schedules | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/the-principles/storage-limitation/> | Regulator guidance (not law) |
| Case law (retained EU case law, persuasive/binding status for the reviewer): Breyer v Bundesrepublik Deutschland, CJEU C-582/14 (19 Oct 2016) | <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62014CJ0582> | A dynamic IP address can be personal data when the controller has legal means to identify the person. Relevant to treating IP addresses in logs and the audit trail as personal data. Status of this authority in UK law after 2020 is for the reviewer. |

## 4. Open decisions this schedule needs
1. Who is the controller of client data in the platform (the firm, or the platform operator), and therefore who sets each period?
2. Confirm or change every PROVISIONAL period above; record the decision in `decision-log.md` and set the category status in a new migration (periods are reference data).
3. The after-termination period for WHILE_ACTIVE data (currently undefined).
4. IP/user-agent: necessity, lawful basis, period, and whether the switch should cover sessions and challenges.
5. Erasure versus statutory retention process (Art 17(3)(b)) and the mandatory-deletion duty in MLR 2017 reg 40.
6. Only after 1-5: approve (or amend) S4(b).
