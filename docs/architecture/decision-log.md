# Decision log (append-only)

Decisions taken by the product owner about scope, risk and approvals. **Entries are never edited or deleted**; a later decision that changes an earlier one is a new entry that names it. The V0 readiness report and compliance matrix are frozen evidence at documentation commit `fe2e63f` (verified code commit `3b754e7`; a git tag could not be pushed through the session's git proxy, so the commit SHAs are the reference); decisions made after that point are recorded here and in the register addendum, not by rewriting history. Architecture consequences are in `adr.md` (ADR-40 onwards).

| Id | Date | Subject | Decision |
|---|---|---|---|
| DEC-001 | 2026-10-09 | V0 readiness | APPROVED to start V1 |
| DEC-002 | 2026-10-09 | UI strategy (S5) | APPROVED: API-first V1, V0 UI in parallel behind feature flags |
| DEC-003 | 2026-10-09 | Retention and privacy (S4(b), V0-8.3) | DEFERRED FOR APPROVAL: everything stays provisional |
| DEC-004 | 2026-10-09 | Naming deviations V0-1.5, V0-T2 | ACCEPTED as documented |
| DEC-005 | 2026-10-09 | S3 device identity, S7 embedding/search ports | DEFERRED to later tranches |
| DEC-006 | 2026-10-09 | Production | NOT approved; AWS and production hardening remain explicit gates |
| DEC-007 | 2026-10-09 | V1 conduct and milestone acceptance | Rules below |

## DEC-001 - V0 approved to start V1
V0 is approved for V1 development on the basis of the readiness report (commit evidence above). The pre-V1 bundle S1, S2, S4(a) and S6 is accepted as complete, subject to the reported passing checks and the evidence retained in the repository.
**This is not production approval.** V0 must not be described as production-approved, and no production deployment or live-customer processing may start on the strength of this decision alone (see DEC-006).

## DEC-002 - UI strategy (S5, MAN-DOD-05, XP-11): APPROVED
Proceed API-first for V1 while developing the V0 UI screens in parallel behind feature flags.
* Prioritise usable end-to-end bookkeeping workflows.
* Unfinished features stay disabled behind feature flags (registry in `packages/contracts/src/features.ts`; a flag exists only if declared there).
* UI is tested against the real API, the real authorisation rules and the real tenant boundaries (no mocked authorisation).
* Rows MAN-DOD-05 and XP-11 stay open (PARTIALLY IMPLEMENTED / MISSING) until the screens exist and pass accessibility checks; this decision schedules the work, it does not close the rows.

## DEC-003 - Retention and privacy: DEFERRED FOR APPROVAL
* **All retention periods stay PROVISIONAL.** No category may be set to CONFIRMED without a recorded decision from the product owner informed by the legal verification schedule.
* **S4(b) is frozen:** do not implement or enable purge jobs, irreversible erasure rules or production retention enforcement until the retention schedule and the lawful-basis decisions have been reviewed and approved.
* **A legal verification schedule has been prepared** (`docs/legal/retention-verification-schedule.md` and `.xlsx`): exact provisions, official sources, record/entity types, clock-start events, exceptions, review dates. It is **UNVERIFIED** - sources were not opened from the build environment - and no lawful basis or period in it is approved.
* **IP address and user agent in the audit trail are flagged for privacy review** (schedule section 2), together with the other places the platform stores them (sessions, MFA challenges, hashed trusted IPs, access logs, rate-limit keys). A finding recorded in the schedule: the `AUDIT_CAPTURE_DEVICE_METADATA` switch governs `audit_event` and the access log; it does **not** govern `session.ip`/`session.user_agent` or `auth_challenge.ip`, which are stored regardless. That is a question for the reviewer, not something decided here.
* **Development uses synthetic/test data only** until the applicable decisions are made. No real client or customer data in any environment.
* Do not mark provisional legal requirements as implemented because a schema or configuration exists: V0-S8, XP-10 and V0-8.3 stay PARTIALLY IMPLEMENTED.

## DEC-004 - Naming deviations V0-1.5 and V0-T2: ACCEPTED
Accepted as documented: the permission catalogue lives in code (V0-1.5); `contacts` exists, `permissions` is the code catalogue, **`job_record` is the integration job table (ADR-36)** and `ai_run` is the AI request log (V0-T2).
Conditions: implementation, tests, OpenAPI and architecture documents stay consistent with this; retry behaviour, idempotency, status/error tracking, tenant/company scoping and correlation/trace ids are preserved. The circumstances that would justify separating these models later are written down in ADR-42.

## DEC-005 - S3 and S7: DEFERRED
S3 (device identity, new-device alert, admin session kill-switch) and S7 (EmbeddingProvider/SearchProvider ports) move to later tranches. Baseline authentication, session revocation, authorisation, tenant isolation and the other agreed controls are unchanged and must not be weakened by the deferral. Each proposal is revisited when its implementation dependency and acceptance criteria are defined (S3 depends on the channel port delivered by S2; S7 on V6/V10 requirements).

## DEC-006 - Production gates
AWS deployment and production hardening remain explicit gates. Terraform `validate` passing in CI does **not** mean the infrastructure has been applied or verified in AWS. No production deployment until the applicable infrastructure, security, privacy and retention gates have each been separately reviewed and approved.

## DEC-007 - V1 conduct
* Start V1 following `README_IMPLEMENTATION_ORDER.md` and the master manifest; do not expand scope into deferred items without recording a decision here.
* **Before a V1 milestone is accepted** the acceptance package contains: commit SHA, CI run (every job), test results, migrations, security and permission checks, compliance-matrix changes, known limitations.
* The V0 readiness report and compliance matrix stay as versioned evidence (commit `fe2e63f`); V1 gets its own matrix (`docs/architecture/v1-compliance-matrix.md`) and V0 documents are not overwritten without an audit trail (this log).

---

## Decisions of 2026-10-09 (second batch, after the V1 M1 acceptance package)

| Id | Subject | Decision |
|---|---|---|
| DEC-008 | M1 acceptance | ACCEPTED |
| DEC-009 | Foreign currency | IN V1 (foundation milestone before VAT flows and reporting) |
| DEC-010 | VAT scope | Standard VAT accounting first; cash accounting and Flat Rate Scheme deferred behind an extensible model |
| DEC-011 | Contact model | Shared `contact` with roles |
| DEC-012 | Opening balances and control accounts | Dedicated permission and controlled (configurable second-person) approval |
| DEC-013 | Privacy finding (session / challenge IP and user agent) | Tracked separately; not resolved |
| DEC-014 | Production boundary | Unchanged; V1 continues on synthetic data |

### DEC-008 - M1 accepted
Commit `fae5270` is accepted as the **M1 code baseline** (ledger core). Later documentation-only commits are recorded separately (`defe69b` is the acceptance package and regenerated matrix). The CI run (<https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37923766068>, 9 of 9 jobs), CodeQL, the clean-clone result (64 files, 1170 tests, 4 end-to-end), the migration (`20260106000000_v1_ledger_core`) and the OpenAPI evidence are retained in `docs/architecture/v1-m1-acceptance.md`. **This is milestone acceptance, not production approval** (DEC-006).

### DEC-009 - Foreign currency is in V1
Plan the foreign-currency foundation in the next suitable ledger milestone, **before** the VAT transaction flows are finalised and before financial reporting. It must define: functional currency, transaction currency, exchange-rate source and date, original-currency values, functional-currency postings, rounding, realised FX gains and losses, and period-end revaluation; acceptance tests cover reconciliation and reporting. **Until it is implemented the single-currency limitation is explicit**: M1 journals are posted in the company's base currency only, and the API and documentation say so (V1-POST-06 stays PARTIALLY IMPLEMENTED). Design: `v1-plan.md` milestone M3 and ADR-50.

### DEC-010 - VAT: standard accounting first
M-VAT builds effective-dated tax codes and rates; standard, reduced, zero-rated, exempt and outside-scope treatments; sales and purchase VAT; credit notes; VAT-inclusive and exclusive calculations; tax-point handling; rounding; control-account reconciliation; and a VAT-return workpaper. The model accommodates applicable reverse-charge cases and **separates the VAT treatment/rate from the VAT accounting scheme**. **Cash accounting and the Flat Rate Scheme are deferred**, with an extensible model that can take them. Tax rules use verified official HMRC sources, and each rule records its source and effective dates (nothing is entered from memory; unverified rules stay marked UNVERIFIED and cannot be activated). Design: `v1-plan.md` milestone M4 and ADR-51.

### DEC-011 - Customers and suppliers are contacts with roles
`contact` is reused for customers and suppliers, with role-specific profile data for the fields that differ. One contact may hold both roles. Tenant and company scope stay enforced. Transactions keep the contact details as they were at the time (snapshot) where reporting and evidence need them. Design: ADR-52.

### DEC-012 - Opening balances and control accounts: permission plus approval
A distinct `ledger:opening-balance` permission is required for opening-balance journals. Control accounts stay protected from ordinary manual postings; narrowly authorised adjustments need a reason, evidence and an audit trail. Configurable second-person approval applies to material opening balances and exceptional control-account adjustments. Posted journals stay immutable; corrections stay reversals. Design: `v1-plan.md` milestone M2 and ADR-49. **Until M2 is delivered the M1 fence stays in place** (opening balances only on the first day of the first period).

### DEC-013 - Session / challenge IP and user agent: tracked separately
`session.ip`, `session.user_agent` and `auth_challenge.ip` are stored regardless of the audit switch and are not purged. They are investigated as their own item (collection, use, access, purpose, a policy-controlled retention and deletion proposal, tests). **Not resolved and not production-ready** until reviewed with evidence. Retention periods and lawful basis stay unapproved until the qualified privacy/legal review is complete (DEC-003). Evidence: `docs/legal/device-metadata-investigation.md`.

### DEC-014 - Production boundary
V1 continues on synthetic/test data. Unverified retention rules, untested real-volume performance and unapplied AWS infrastructure are not represented as production-ready; the privacy, security, deployment and operational checks stay explicit production gates (DEC-006).

### Process
The V1 plan and matrix carry, for every row: owner, dependencies, acceptance criteria and deferred scope. A milestone starts only when its specification and dependencies are written down and clear; scope is not silently expanded.


### DEC-013 update (investigation delivered; finding still UNRESOLVED)
The trace is in `docs/legal/device-metadata-investigation.md` with 6 findings: `auth_challenge.ip` is collected and never read (F-1); the audit switch does not cover sessions or challenges (F-2); nothing is purged (F-3); `login_trusted_ip` keeps a hashed IP per user indefinitely (F-4); the generic Redis rate-limit keys hold the raw IP for up to an hour (F-5, which corrects the earlier schedule statement that all Redis keys were hashed); access is narrow (F-6). Options A-F (stop collecting the challenge IP, a session switch, coarsening, a retention job, hashing rate-limit keys, transparency) are proposed and **not enabled**. 10 characterisation tests pin today's behaviour. The item stays unresolved until the qualified privacy review is recorded here.


## Decisions of 2026-10-12 (third batch, after the V1 M2 acceptance package)

| Id | Subject | Decision |
|---|---|---|
| DEC-015 | M2 acceptance | ACCEPTED, with the proposed defaults (approval always required, 14-day expiry) |
| DEC-016 | Exchange-rate source (M3) | Manual entry always allowed, plus importers for official published series (HMRC monthly, Bank of England daily); commercial provider deferred; lookup = transaction date, else latest earlier rate within 7 days, else refuse |
| DEC-017 | Rounding policy (M3) | Rate stored unrounded to 8 decimals; each functional amount rounded per line, half-up, to the currency's minor units; the difference to balance goes to a visible system FX-rounding line within one minor unit per line, else refuse |
| DEC-018 | Revaluation and realised FX (M3) | Foreign-currency monetary items only, at the period-end rate; unrealised difference to profit or loss by an explicit, previewed `revalue` action at period close, auto-reversed on the first day of the next period; realised difference posted at settlement |

### DEC-015 - M2 accepted
Commit `d98e3ed` is accepted as the **M2 code baseline** (ledger controls). Later documentation-only commits are recorded separately (`ad1bbf1`, `3ac8f46`, `aea1a2c` and the M3 brief commit `132c6da`). Evidence retained: CI run <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029493> (9 of 9 jobs), CodeQL <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029188>, clean clone (68 files, 1303 tests, 4 end-to-end, no OpenAPI drift), migration `20260107000000_v1_ledger_controls`, package `v1-m2-acceptance.md`. The proposed defaults (approval `ALWAYS`, request expiry 14 days, no built-in threshold) are confirmed. This is milestone acceptance, **not production approval** (DEC-006); the privacy finding DEC-013 remains unresolved.

### DEC-016 - Exchange-rate source
Rates are reference data with provenance. Manual entry is always allowed (rate, source text and date mandatory, audited). Official published series are loaded by importers behind an adapter port, never fetched at posting time; the named candidates are the HMRC monthly customs/VAT rates and the Bank of England daily spot rates. A commercial provider is deferred. Lookup: the rate for the transaction date; otherwise the latest earlier rate within 7 days; otherwise the posting is refused with a request for a manual rate; never a future rate. **Consequences recorded:** (1) no live fetching is enabled by this decision - it needs network access, a check of each publisher's terms of use and a reviewer's verification of the file formats (production-style gate); (2) no real exchange-rate figures enter the repository, tests use synthetic rates; (3) the legal basis for using a given rate for VAT is an M4 matter and stays UNVERIFIED until a qualified reviewer checks the sources in `docs/legal/m3-fx-sources.xlsx`. Design: ADR-55, plan section 5.

### DEC-017 - Rounding policy
The rate is stored as published, up to 8 decimal places, and is never rounded. Only the functional-currency amount is rounded, per line, half-up (half away from zero), to the functional currency's minor units, by one function that is property-tested. Where the converted lines do not balance, a visible system-owned **FX rounding** line is added to the journal; the permitted difference is one minor unit per line, otherwise the posting is refused. VAT rounding is decided in M4 from the verified VAT rule; M3 only provides the mechanism.

### DEC-018 - Revaluation and realised FX
Only foreign-currency monetary items are revalued (bank, receivables, payables, loans, accruals); non-monetary items at historical cost keep the transaction-date rate. The rate is the period-end rate from the company's chosen series, stored with its id and date. The unrealised difference is posted to profit or loss by an **explicit "revalue" action** at period close (preview first, `period:manage`, audited, idempotent per period, refused in locked periods) and is **automatically reversed on the first day of the next period**. Realised differences are posted at settlement through the PostingService. Hedge accounting, forwards, net investments and translation of foreign operations are out of scope. A period cannot be closed with an unrevalued foreign-currency monetary balance unless the user acknowledges it.


## Decisions of 2026-10-12 (fourth batch, taken under delegated authority)

On 2026-10-12 the product owner delegated the open product and engineering decisions: *"Go ahead and take decisions things that make our platform best of best most capable."* The decisions below were taken by the engineering agent under that delegation and are recorded as such. **Delegation does not extend to what no engineering decision can establish:** naming a qualified tax reviewer, confirming that HMRC/legislation text says what the platform assumes, the privacy lawful basis and retention periods (DEC-003, DEC-013), and production approval (DEC-006). Those remain explicit gates.

| Id | Subject | Decision |
|---|---|---|
| DEC-019 | M3 acceptance | ACCEPTED under delegation, including its as-built choices (second-person rate verification; on-request auto-reversal with the close block; FX accounts designated per company) |
| DEC-020 | M4 split | M4a contact roles (no external gate) is built now; M4b VAT foundation follows as a separate milestone |
| DEC-021 | VAT rule verification (M4b) | The platform enforces the control: a new COMPANY-level permission `tax:rule-verify`, a verifier who is not the person who entered the rule, and a fixed verification record; who holds the permission is the firm's choice |
| DEC-022 | Primary sources | Not read in this sandbox (network policy); rules stay UNVERIFIED and not activatable until verified by a holder of `tax:rule-verify`; building does not wait for it |
| DEC-023 | Customer / supplier data | Role-specific profiles as below; supplier bank details encrypted, masked everywhere, viewed only with a dedicated permission (each view audited), and **not usable for payments until a second person verifies a change** |
| DEC-024 | Counterparty VAT numbers | Stored on the contact with a format check only; no validation against HMRC (an external service, not in scope) |

### DEC-019 - M3 accepted under delegation
Commit `c8fd8c0` is the **M3 code baseline**; the documentation commit `81102ad` is recorded separately. Evidence retained: CI <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470095> (9 of 9), CodeQL <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470019>, clean clone (72 files, 1415 tests, 4 end-to-end, no OpenAPI drift), migration `20260108000000_v1_fx_foundation`, package `v1-m3-acceptance.md`. **Acceptance by delegation is weaker evidence than acceptance by a person who did not build the milestone**; the product owner may revisit it at any time and the package stays the reference. Milestone acceptance only, not production approval.

### DEC-020 - M4 split
**M4a (contact roles, DEC-011)**: customers and suppliers as roles of the shared `contact`, with role-specific profiles, both roles on one contact, company scope, and a snapshot for documents. **M4b (VAT foundation, DEC-010)** follows with its own specification check and acceptance package. Rationale: M4a has no external gate and is needed by every document milestone; M4b's build can proceed but its activation is gated (DEC-021, DEC-022).

### DEC-021 - VAT rule verification record and control (for M4b)
A VAT code or rate is created UNVERIFIED and cannot be used on a posting or activated until verified. Verification needs permission `tax:rule-verify` (COMPANY scope; no system role holds it by default except owner/admin - the firm grants it to its named reviewer) and must be by a different person from the one who entered or last changed the rule. The verification record holds: official source URL; instrument and provision (for example, "VAT Act 1994, s.6"; "VAT Notice 700, para 4.4"); retrieval date; effective-from and effective-to; verifier and verification time; notes; optionally an evidence document. Changing a verified rule creates a new version that is UNVERIFIED again. **Naming the reviewer is the firm's act of granting the permission, not a decision taken here.**

### DEC-022 - Primary sources not read in this environment
The sandbox network policy blocks gov.uk, legislation.gov.uk, frc.org.uk and bankofengland.co.uk. Statements about HMRC rules in the code and documents remain UNVERIFIED. No real VAT rate or rule figure is seeded; tests use synthetic codes and rates. If the product owner opens network access, the agent may read the sources and propose verification records, but verifying them remains a human act under DEC-021.

### DEC-023 - Customer and supplier profiles
* `contact_role` (company-scoped; CUSTOMER or SUPPLIER; a contact may hold both; optional account code unique per company and role; ended, never deleted, with a reason). An organisation-level contact can take roles in any company of the organisation; a company-linked contact only in its own company.
* Customer profile: payment terms (0-365 days), credit limit in the company currency, default currency.
* Supplier profile: payment terms, default currency, default expense account (an active, non-control account of the company), **bank details** (account name, sort code, account number, optional IBAN/BIC) **encrypted at field level**; lists, logs and audit records show only a masked form; viewing full details needs `contact:bank-details` and every view is audited; **a change of bank details is UNVERIFIED until a different person with `contact:bank-details` verifies it** (payment-diversion fraud control; payments in M6 will refuse unverified details).
* Documents (M5+) store a **snapshot** of the counterparty (name, VAT number, primary address, account code) so later edits never rewrite history; M4a delivers and tests the snapshot function.
* Ending a role will be refused while open documents exist once documents exist (M5/M6); until then ending is always allowed and audited.

### DEC-024 - Counterparty VAT numbers
`contact.vat_number` is optional and format-checked (GB/XI + 9 or 12 digits, or another two-letter prefix + 8-12 characters, the length range of EU VAT numbers). It is not checked against HMRC's VAT number service (external integration; would be a separate decision with its own terms of use).

