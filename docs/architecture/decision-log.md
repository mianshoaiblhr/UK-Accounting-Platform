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
