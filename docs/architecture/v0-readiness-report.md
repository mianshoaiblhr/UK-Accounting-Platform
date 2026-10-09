# V0 readiness report (final review gate, after the pre-V1 bundle)

**Recommendation: V0 IS READY FOR V1 - subject to your explicit approval.** The approved pre-V1 bundle (S1 workflow deadlines, S2 notification channel port, S4(a) retention classification, S6 integration retry test) is implemented and verified, no row is left MUST FIX BEFORE V1, and every test and CI job passed on the final code commit. V1 has not been started and will not be until you approve this report.

## 1. Verified commit and results
| Item | Result |
|---|---|
| Verified code commit | `3b754e7` (branch `claude/adoring-cori-mra6ze`). Later commits change documentation only; their own CI result is in the hand-over message |
| CI run (all jobs) | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37913579987> - **success**, 9 of 9 jobs |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37913579949> - **success** |
| Clean-clone verification | fresh `git clone` of `3b754e7`; `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`: exit 0; `pnpm test`: **59 files, 1034 tests passed, 0 failed, 0 skipped** (was 51 / 956); `pnpm test:e2e`: **4/4 passed** (real Chromium); `pnpm openapi`: no drift |
| Migrations from scratch | all 19 migrations applied to an empty database by the CI job `migrations-from-scratch` and by the suites' global setup on every run; the populated-database upgrade as a non-superuser owner (`tests/db/upgrade.test.ts`) now also covers the retention classification of a carried-over legacy document type |
| Terraform | `fmt -check` local and CI; `init -backend=false` and `validate` in CI. Nothing planned or applied |

### CI jobs on `3b754e7`
| Job | Result |
|---|---|
| build, lint, typecheck, unit, integration, e2e | success |
| real S3 protocol (moto) + real ClamAV | success |
| dependency audit + secret scan (gitleaks) | success |
| migrations-from-scratch | success |
| terraform (fmt, init, validate) | success |
| images (api), (worker), (web), (migrate) - build + Trivy HIGH/CRITICAL gate | success x4 |
| codeql | success |

### CI and test history during this phase (for the record - nothing was skipped, weakened or deleted)
* A full-suite run found a defect **in one of my new tests**: it counted e-mail deliveries across the whole database and picked up one created by another test file's worker. Scoped to its own recipient (`91a0bd6`).
* A clean-clone run then failed once on a **race in another new test**: the e-mail job is marked COMPLETED just after the mail is written, and the test asserted too early. The test now waits for it (`60b75b4`).
* CI on `60b75b4` failed because **my retention test compared rows ordered by the database collation with a JavaScript sort**; the CI database's collation sorts `_` differently from the local `C.UTF-8`. Fixed by sorting on both sides in the test (`3b754e7`), which is green. No product code was involved in any of the three.
* `526e329` was pushed with the first of these defects; its CI run was superseded by the fix.

## 2. Compliance counts (144 rows)
| Status | Rows | Share of applicable (138) |
|---|---|---|
| IMPLEMENTED | 104 | 75% |
| PARTIALLY IMPLEMENTED | 29 | 21% |
| MISSING | 5 | 4% |
| NOT APPLICABLE | 6 | - |
Previous report (end of Tranche A): 100 / 32 / 6 / 6. Before Tranche A: 80 / 39 / 19 / 6. This bundle closed **V0-4.7, V0-7.3, V0-9.4 and V0-TEST-6**. **V0-S8 and XP-10 stay PARTIALLY IMPLEMENTED on purpose:** only the classification half (S4(a)) was approved; purge jobs, runtime configuration and enforcement are not built, and every retention period is PROVISIONAL. Rows were closed only with code paths and passing tests; rows whose remaining gap is production infrastructure were **not** closed. Matrix: `docs/architecture/v0-compliance-matrix.md` and `.xlsx` (sheets: Matrix, Summary, High-risk findings, Decision register, Scope proposals).

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
1. **Retention periods are provisional and unenforced:** nothing is purged; operational tables grow until S4(b). Periods and lawful basis need the DPO/legal decision.
2. The database trusts the application to assert tenant and user for row-level security. Code that could run arbitrary SQL as the runtime role could claim any identity. Mitigated by the absence of raw SQL, by privileges, and by tests; production hardening: separate DB credentials for API and worker, `pgaudit`.
3. Object-level immutability of filing evidence (S3 Object Lock COMPLIANCE) is unproven; today only the application and database refuse changes.
4. Everything AWS-side is configured, not verified (section 5).
5. UI exists for authentication, security settings and companies only.
6. GitHub push protection and branch protection are repository settings I cannot verify from code.

## 5. Outstanding production-only validation
Real S3 (signatures, SSE-KMS, key policy, CORS, Object Lock mode) - ClamAV service in AWS (not provisioned; uploads would stay SCANNING) - Redis `noeviction` parameter group (not set) - first Terraform plan/apply and destroy/recreate - SES sandbox exit, DKIM, bounces - TLS on every hop - IAM review in a real account - restore drill (RDS PITR, S3, Redis) - connection pool sizing and RDS Proxy - alarm delivery and EMF extraction (game-day) - load and performance tests - privacy documentation (lawful basis and retention for IP data, DPIA, privacy notice) - accessibility checks with the UI.

## 6. Open requirements: decisions needed
Full register: `docs/architecture/v0-open-requirements-register.md` (also in the Excel workbook). Summary: **0 MUST FIX BEFORE V1**, **27 MUST FIX BEFORE PRODUCTION**, **7 DEFER TO A LATER VERSION**, **6 NOT APPLICABLE (justified)**.

### What the pre-V1 bundle delivered (all approved by you)
| # | Item | Result |
|---|---|---|
| S6 | Integration retry test + ADR-36 (`job_record` is the integration job table) | A call through the real worker fails transiently, is retried with exponential backoff (>= 15 s over three attempts) and succeeds; client errors fail at once; credentials never reach the record. `tests/jobs/integration-retry.test.ts` (5) |
| S1 | Workflow deadlines (V0-4.7), ADR-37, migration `20260105000000` | `due_at` + optional per-definition SLA, set/move/clear endpoint recorded in history and audit, overdue flag and filter, one-time overdue notification (exactly once under 6+ concurrent sweepers, crash-safe, back-off and audited abandonment), `workflows_overdue` gauge. `tests/platform/workflow-overdue.test.ts` (10), `tests/api/workflow-deadlines.test.ts` (9) |
| S2 | Notification channel port (V0-7.3), ADR-38, migration `20260105000100` | Port + registry; in-app inline, e-mail planned in the business transaction and executed by a sweeper through the existing `email.send` job (idempotency key = delivery id); SMS/WhatsApp are unavailable stubs that cannot be enabled; per-user opt-in preferences (e-mail off by default, in-app mandatory, audited); content-free e-mail. `tests/platform/notification-channels.test.ts` (18), `tests/api/notification-preferences.test.ts` (7) |
| S4(a) | Retention classification (V0-S8, XP-10), ADR-39, migration `20260105000200` | 15 categories with provisional periods and statutory basis; a rule for every document type and every table (adding a table without a rule fails the build); `GET /reference/retention-categories`. **No purge, no erasure rule, no enforcement.** `tests/db/retention.test.ts`, `packages/contracts/src/retention.test.ts`, `tests/api/retention.test.ts` |

Defects found while building: the overdue filter's `NOT` over nullable columns dropped instances without a deadline (SQL three-valued logic; found by the API test, fixed); `INSERT ... RETURNING` on `notification` is refused by the recipient-private read policy when someone else notifies (the in-app channel now generates the id itself); event consumers run with the event's *actor* as database user, so notification preferences are tenant-scoped in the database and personal in the API.

### Still open - decisions only you can make (none blocks starting V1)
1. **S5 UI strategy:** V1 API-first with the V0 UI slices in parallel under feature flags (recommended), or hold V1 until they exist (MAN-DOD-05, XP-11; the Manifest's definition of done mentions usable UI).
2. **Retention periods and lawful basis (V0-8.3):** confirm or change every PROVISIONAL period in the classification and record the lawful basis for IP address / user agent; this also unblocks S4(b).
3. **Accept the documented deviations** V0-1.5 and V0-T2 (table naming; `integration_jobs` is `job_record` by ADR-36).
4. **Timing of S3** (device identity, new-device alert; now unblocked by S2) **and S7** (embedding/search ports), and approval of **S4(b)** (purge jobs and erasure rules, before production).

## 7. Deliberately deferred (nothing started)
Tranche B: OpenTelemetry spans, dashboards, SLOs, k6 tests, UI slices, connection pooling, privacy consent record. Tranche C: all real-AWS validation. Later versions: named integration adapters (V3/V4/V5/V11), client portal and cross-organisation engagement (V7), search technology decision, accounting controls (V1).

## 8. Where to look
Matrix and register: `docs/architecture/v0-compliance-matrix.md|xlsx`, `v0-open-requirements-register.md` - Tranche A design and as-built: `v0-tranche-a.md` (sections 1-8; section 9 = pre-V1 bundle) - decisions: `adr.md` (ADR-22..39) - Increment 6 verification: `v0-increment-6-verification.md` - runbooks: `docs/runbooks/` (migrations, supply-chain, observability).

## 9. Addendum (2026-10-09) - decisions recorded after this report
The sections above are unchanged evidence of what was presented for approval (documentation commit `fe2e63f`, verified code commit `3b754e7`). The product owner then decided (full text in `decision-log.md`, architecture consequences in ADR-40..43): **V0 approved to start V1 - not production approval** (DEC-001); UI API-first with the V0 screens in parallel behind feature flags (DEC-002); retention and privacy **deferred for approval**, all periods provisional, S4(b) frozen, legal verification schedule prepared (`docs/legal/`), IP address and user agent flagged, synthetic data only (DEC-003); naming deviations V0-1.5 and V0-T2 accepted (DEC-004); S3 and S7 deferred (DEC-005); AWS and production hardening remain gates (DEC-006); V1 conduct and milestone acceptance rules (DEC-007). Row statuses in section 2 were not changed by these decisions.
