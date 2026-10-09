# V0 readiness report (final review gate)

**Recommendation: NOT READY FOR V1 - as the open-requirements register stands.** Six rows (four distinct pieces of work, about 8-9 engineer-days) are classified MUST FIX BEFORE V1 and need your approval or your written waiver. Everything else open is a production-gate item or belongs to a later version. No Critical finding exists; the code that is there is verified. V1 has not been started and will not be until you approve.

## 1. Verified commit and results
| Item | Result |
|---|---|
| Verified code commit | `a57ebb3fc678789f83fda6af0c8ebe6adcdef999` (branch `claude/adoring-cori-mra6ze`). Later commits change documentation only; their own CI result is reported in the hand-over message |
| CI run (all jobs) | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37901071296> - **success** |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37901071300> - **success** |
| Clean-clone verification | fresh `git clone` of the commit; `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`: exit 0; `pnpm test`: **51 files, 956 tests passed, 0 failed, 0 skipped**; `pnpm test:e2e`: **4/4 passed** (real Chromium); `pnpm openapi`: no drift in `docs/api/openapi.json` |
| Dependency audit (local) | `pnpm audit --prod --audit-level=high`: no known vulnerabilities |
| Migrations from scratch | all 16 migrations applied to an empty database with the production script `infra/db/migrate.sh` in the CI job `migrations-from-scratch`, and by the test suites' global setup on every run; an earlier local run of the script (12 migrations at the time) left 0 unfinished; populated-database upgrades as a non-superuser owner are tested (`tests/db/upgrade.test.ts`, 6) |
| Terraform | `fmt -check` local and CI; `init -backend=false` and `validate` in CI (including `observability.tf`). Local `validate` is impossible in this sandbox (provider registry blocked). **Nothing has been planned or applied** |

### CI jobs on `a57ebb3`
| Job | Result |
|---|---|
| build, lint, typecheck, unit, integration, e2e | success |
| real S3 protocol (moto) + real ClamAV | success |
| dependency audit + secret scan (gitleaks) | success |
| migrations-from-scratch | success |
| terraform (fmt, init, validate) | success |
| images (api), (worker), (web), (migrate) - build + Trivy HIGH/CRITICAL gate | success x4 |
| codeql | success |
(`dependency-review` runs on pull requests only.)

### CI history during this phase (for the record)
* `7bc2ad5` pushed with a **type error in a new test file** (I had checked typecheck through a pipe that hid the exit code); fixed in `048b6bf`, which was fully green.
* `9bb10ff` **failed CI**: my evidence-graph integrity test wrongly flagged organisation-level documents cited as evidence for a company workflow. Reproduced in a clean clone, fixed in `0a69b86`.
* The full local suite on `0a69b86` failed one **existing** test (the `/readyz` response contract); fixed in `a57ebb3`, which was the head of that push, so `0a69b86` itself never ran in CI.
No test was skipped, weakened or deleted to obtain green.

## 2. Compliance counts (144 rows)
| Status | Rows | Share of applicable (138) |
|---|---|---|
| IMPLEMENTED | 100 | 72% |
| PARTIALLY IMPLEMENTED | 32 | 23% |
| MISSING | 6 | 4% |
| NOT APPLICABLE | 6 | - |
Before Tranche A: 80 / 39 / 19 / 6. Rows were closed only with code paths and passing tests; rows whose remaining gap is production infrastructure were **not** closed. Matrix: `docs/architecture/v0-compliance-matrix.md` and `.xlsx` (sheets: Matrix, Summary, High-risk findings, Decision register, Scope proposals).

## 3. Critical and high-risk findings
* **Critical: none.** No cross-tenant leak, authentication bypass, data-loss path or exposed secret at any point.
* **High findings of the original review:** master data, feature flags, task/document/audit fields, evidence graph, supply chain - closed. Observability - closed to the V0 minimum. **Still open (all production-gate or UI):** UI slices (MAN-DOD-05), ClamAV in AWS (REV-08), real-AWS verification (MAN-TECH-09, V0-6.1, V0-S6, V0-S7, REV-04, REV-05).
* **Defects found and fixed during Tranche A, each with a test that failed first:** audit trail and document versions protected only by triggers (F1, privileges revoked); poisoned reminders starving newer ones (F2); the assignee could remove their own reviewer and self-complete (F3); concurrent review decisions could both win (F4); unrestricted reviewer nomination (F5); **foreign-key validation under forced row security silently checked nothing for the migration owner** (G1; found by the populated-database upgrade test; fixed in two migrations and the runbook).

## 4. Security and tenancy assessment
**Verified (code + tests):**
* *Tenant isolation:* forced row-level security on every tenant table, registry equals database, composite `(organisation_id, id)` foreign keys, runtime role is not superuser / BYPASSRLS and owns nothing, no `SECURITY DEFINER` helpers (`tests/db/rls.test.ts`, `classification.test.ts`, `privileges.test.ts`, `tenancy.test.ts`).
* *Authorisation:* one central authoriser; organisation -> practice -> company grants, deny by default, anti-escalation, per-document visibility (restricted documents are a 404 on every path) (`authz.test.ts`, `hierarchy.test.ts`, `permissions.test.ts` 8 roles x 32 probes, `document-management.test.ts`).
* *Integrity:* append-only records protected by privileges first and triggers second; reviewer completion enforced by a database trigger that reads the acting user from the tenant context; irreversible filing-evidence lock; immutable evidence links (`task-review-security.test.ts`, `privileges.test.ts`, `document-management.test.ts`, `evidence-graph.test.ts`).
* *Reliability:* reminders exactly-once under concurrent workers, a crash after the notification was written, a killed database connection mid-transaction and cancel races; per-aggregate ordered outbox; job retry/backoff/dead-letter (`task-reminders.test.ts`, `outbox-hardening.test.ts`, `jobs.test.ts`).
* *Supply chain:* audit gate, CodeQL, gitleaks, dependency-review, Dependabot, Trivy on four images; no unsafe raw SQL anywhere (architecture test).
* *Privacy:* device metadata switch for IP and user agent in the audit trail and the access log; OCR and AI off per organisation by default; extracted text never logged or audited.

**Residual risks (honest list):**
1. The database trusts the application to assert tenant and user for row-level security. Code that could run arbitrary SQL as the runtime role could claim any identity. Mitigated by the absence of raw SQL, by privileges, and by tests; production hardening: separate DB credentials for API and worker, `pgaudit`.
2. Object-level immutability of filing evidence (S3 Object Lock COMPLIANCE) is unproven; today only the application and database refuse changes.
3. Everything AWS-side is configured, not verified (section 5).
4. UI exists for authentication, security settings and companies only.
5. GitHub push protection and branch protection are repository settings I cannot verify from code.

## 5. Outstanding production-only validation
Real S3 (signatures, SSE-KMS, key policy, CORS, Object Lock mode) - ClamAV service in AWS (not provisioned; uploads would stay SCANNING) - Redis `noeviction` parameter group (not set) - first Terraform plan/apply and destroy/recreate - SES sandbox exit, DKIM, bounces - TLS on every hop - IAM review in a real account - restore drill (RDS PITR, S3, Redis) - connection pool sizing and RDS Proxy - alarm delivery and EMF extraction (game-day) - load and performance tests - privacy documentation (lawful basis and retention for IP data, DPIA, privacy notice) - accessibility checks with the UI.

## 6. Open requirements: decisions needed
Full register with ID, specification reference, status, risk, blocks V1 / production, action, effort, dependencies and milestone: `docs/architecture/v0-open-requirements-register.md` (also in the Excel workbook). Summary: **6 MUST FIX BEFORE V1**, **25 MUST FIX BEFORE PRODUCTION**, **7 DEFER TO A LATER VERSION**, **6 NOT APPLICABLE (justified)**.

### Scope proposals (not implemented; each needs your approval)
| # | Proposal | Effort | When |
|---|---|---|---|
| S1 | Workflow deadlines / SLA (V0-4.7): `due_at`, overdue filter, gauge, one-time overdue notification | S (2 d) | before V1 |
| S2 | Notification channel port + preferences (V0-7.3): in-app and e-mail adapters, SMS/WhatsApp as disabled stubs | S-M (3 d) | before V1 |
| S3 | Device identity, new-device alert, admin kill-switch (V0-1.9) | M (4 d) | Tranche B / V7 |
| S4 | Retention: (a) policy table + classification before V1; (b) purge jobs + erasure rules before production (V0-S8, XP-10) | S-M + M-L | (a) before V1, (b) before production |
| S5 | UI slices for the V0 foundations with accessibility checks (MAN-DOD-05, XP-11) | XL (3-4 w) | decision: V1 API-first with UI in parallel, or UI first |
| S6 | Integration retry test + ADR that `job_record` is the integration job table (V0-9.4, V0-TEST-6) | S (1 d) | before V1 |
| S7 | Embedding/Search provider ports with fakes (V0-10.3) | S (1-2 d) | optional now, otherwise V6 |
**Recommended pre-V1 bundle: S1 + S2 + S4(a) + S6 = about 8-9 engineer-days.**

## 7. Deliberately deferred (nothing started)
Tranche B: OpenTelemetry spans, dashboards, SLOs, k6 tests, UI slices, connection pooling, privacy consent record. Tranche C: all real-AWS validation. Later versions: named integration adapters (V3/V4/V5/V11), client portal and cross-organisation engagement (V7), search technology decision, accounting controls (V1).

## 8. Where to look
Matrix and register: `docs/architecture/v0-compliance-matrix.md|xlsx`, `v0-open-requirements-register.md` - Tranche A design and as-built: `v0-tranche-a.md` (sections 1-8) - decisions: `adr.md` (ADR-22..35) - Increment 6 verification: `v0-increment-6-verification.md` - runbooks: `docs/runbooks/` (migrations, supply-chain, observability).
