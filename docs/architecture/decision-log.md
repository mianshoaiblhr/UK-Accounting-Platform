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

