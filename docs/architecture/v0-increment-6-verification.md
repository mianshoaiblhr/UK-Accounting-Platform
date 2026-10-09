# V0 Tranche A - Increment 6 (task engine): verification report

Scope: verification only, no V1 functionality. Verified code commit: **`048b6bfdedd8c0603d65a426b41fd7077fc791c3`** (branch `claude/adoring-cori-mra6ze`). This document is committed afterwards as a docs-only change; no code differs from the verified commit.

## 1. Result in one table
| Check | Result | Evidence |
|---|---|---|
| CI on the verified commit | **All 9 `ci` jobs and CodeQL succeeded** (see section 2) | GitHub Actions run 37894034170 (ci), 37894034113 (codeql) |
| Clean, reproducible environment | **PASS** - fresh `git clone` of the verified SHA, `pnpm install --frozen-lockfile`, build, typecheck, lint, 846 unit+integration tests, 4 real-browser E2E tests, OpenAPI regeneration produced no diff | section 3 |
| Migrations from scratch | **PASS** - production script `infra/db/migrate.sh` applied all 12 migrations to an empty database (0 unfinished); populated-database upgrade and non-superuser-owner application covered by `tests/db/upgrade.test.ts` | section 3 |
| Reviewer enforcement cannot be bypassed | **PASS after fixes F3-F5** | section 4 |
| Reminder processing safe under concurrency, retries, crashes | **PASS after fix F2** | section 5 |
| Append-only records protected by effective privileges | **PASS after fix F1** | section 6 |
| Compliance matrix updated | **DONE** - V0-5.1 ... V0-5.8 now IMPLEMENTED with evidence (matrix 144 rows: 70 implemented, 42 partial, 26 missing, 6 n/a - the remaining rows are refreshed at the final V0 gate) | `docs/architecture/v0-compliance-matrix.md` / `.xlsx` |

## 2. CI on the verified commit (all jobs)
| Job | Result |
|---|---|
| build, lint, typecheck, unit, integration, e2e | success (E2E: 4 tests, real Chromium) |
| real S3 protocol (moto) + real ClamAV | success |
| dependency audit + secret scan (gitleaks) | success |
| migrations-from-scratch | success |
| terraform (fmt, init, validate) | success |
| images (api), (worker), (web), (migrate) - build + Trivy HIGH/CRITICAL gate | IMAGES_PLACEHOLDER |
| codeql | success |

Not run on a push (by design): `dependency-review` (pull requests only).

## 3. Checks run locally on a clean clone of the verified commit
`install` exit 0 - `build` exit 0 - `typecheck` exit 0 - `lint` exit 0 - `pnpm test` **44 files / 846 tests passed** - `pnpm test:e2e` **4 passed** - `pnpm openapi` produced **no change** to `docs/api/openapi.json`. Terraform `fmt -check` passes locally; `init`/`validate` cannot run in this sandbox (the provider registry is blocked), so they are evidenced by the CI `terraform` job only. `pnpm test:infra` (real S3/ClamAV) is evidenced by the CI job only.

## 4. Reviewer enforcement - adversarial results
Tests: `tests/api/task-review-security.test.ts` (13), `tests/api/task-engine.test.ts` (17), `tests/db/task-engine.test.ts` (6), `tests/db/privileges.test.ts` (18), architecture rule "only the task service writes tasks".

| Attack / path | Outcome |
|---|---|
| Name the reviewer in the request body (`reviewerUserId`, `userId`, `actorUserId`, `reviewer`) | 422 (strict schema); identity comes only from the session |
| Identity-looking headers (`X-User-Id`, `X-Reviewer-Id`, `X-Forwarded-User`, `X-Actor`, `X-Impersonate`, `X-Auth-User`) | ignored; 403 `not_reviewer` |
| Another organisation's session (including a user's own other organisation) | 404, no existence leak |
| Self-approval by the assignee; direct `PATCH status=DONE` by anyone | 403 `not_reviewer` / 409 `review_required` |
| **Assignee clears or swaps the reviewer, then completes directly** | **found (F3)** - now 403 `assignee_cannot_change_reviewer` (API) and refused by the trigger |
| Anyone with `task:manage` nominates any colleague as reviewer | **found (F5)** - reviewer must hold `workflow:review` at nomination and again at decision time |
| Two simultaneous decisions (approve + return, 3x approve) | **found (F4)** - read-then-write let both win; now a conditional update: exactly one 200, others 409, one comment, one audit row |
| Completion through the database from: another organisation's context, the system context, a user-only context, no context, a different user in the right organisation, skipping `IN_REVIEW` | all refused (0 rows or trigger error) |
| Comment posing as approval (`kind: REVIEW_APPROVED`) | 422; a posted comment is always kind COMMENT |
| Reviewer left the organisation / lost the review permission | cannot decide; the owner returns the task to `IN_PROGRESS` and nominates someone else (no dead end) |
| Other application code writing tasks | architecture test: only `tasks.service.ts` writes `task`; `$queryRawUnsafe` / `$executeRawUnsafe` are forbidden everywhere |

**Residual trust boundary (honest limit):** PostgreSQL trusts the application to assert tenant and user (`app.organisation_id`, `app.user_id`) - the same model row-level security relies on. Code that can run arbitrary SQL as the runtime role could claim any identity. The role owns nothing, has no `SECURITY DEFINER` helper and cannot disable triggers/RLS/grants (tested); no unsafe raw SQL exists (tested). Production-only hardening: separate DB credentials for API and worker, `pgaudit`.

## 5. Reminder processing - concurrency, retries, crashes
Tests: `tests/platform/task-reminders.test.ts` (10) plus API reminder cases.

| Scenario | Outcome |
|---|---|
| 6 sweepers at once, then 3 rounds of 4 more, over 25 due reminders | each delivered exactly once (25 notifications) |
| Crash after the notification was written but before commit | notification and marker both roll back; reminder stays pending, counted, backed off; next sweep delivers once |
| Database connection killed (`pg_terminate_backend`) mid-transaction while holding the row lock | a second worker neither waits nor duplicates (SKIP LOCKED); lock released; after the backoff the reminder is delivered once |
| **Poisoned reminder** | **found (F2)** - was retried on every sweep and could starve newer reminders; now backoff 30 s ... 1 h, abandoned after 8 attempts (cancelled, audited `task.reminder_failed`), newer reminders still delivered with batch size 1 |
| Cancel racing with sweepers (12 reminders, 3 sweepers) | never both sent and cancelled; no notification for a cancelled reminder (DB check + trigger) |
| Task finished before the reminder was due | reminder cancelled, nothing sent |
| Another tenant | notification created only in the reminder's own tenant; other tenants cannot read reminders |

Not covered (honest limit): a real operating-system kill of a worker *process* (the equivalent database-side failure - lost connection mid-transaction - is tested); multi-instance behaviour on ECS is production-only validation.

## 6. Effective database privileges for append-only records
`tests/db/privileges.test.ts` asserts, using `has_table_privilege` / `has_any_column_privilege` (default privileges, PUBLIC and role membership resolved) and real runtime-connection attempts:
`uk_app` is not superuser / BYPASSRLS / CREATEROLE / CREATEDB / replication, belongs to no role, owns no table, function or schema, and no `SECURITY DEFINER` function exists. It holds **no UPDATE/DELETE/TRUNCATE** on `audit_event`, `workflow_transition`, `ai_run`, `task_comment`; **no DELETE/TRUNCATE** on `document_version` and `task_reminder`; **no UPDATE/TRUNCATE** on `task_attachment`; **no TRUNCATE** on `outbox_event`. It cannot `DISABLE TRIGGER`, `DROP TRIGGER`, `DISABLE`/`NO FORCE` RLS, `DROP POLICY`, replace `forbid_mutation()`, `SET session_replication_role`, `SET ROLE`, `ALTER ROLE ... BYPASSRLS`, and a `GRANT` to PUBLIC is a no-op. PUBLIC holds no table privileges. A matrix test fails when a new table with the append-only trigger is not covered.

**Finding F1 (fixed in migration `20260104000500`):** before this pass `audit_event` (UPDATE, DELETE) and `document_version` (DELETE) were protected **only by triggers**, because default privileges grant full DML to every new table. A trigger is the second line of defence; privileges are now the first.

## 7. Findings summary
| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | Audit trail and document versions protected by triggers only (runtime role held UPDATE/DELETE) | Fixed, tested |
| F2 | Medium | Poisoned reminder could spin and starve newer reminders | Fixed, tested |
| F3 | High | Assignee could remove their own reviewer and self-complete | Fixed (API + trigger), tested |
| F4 | Medium | Concurrent review decisions could both win | Fixed, tested |
| F5 | Medium | Reviewer nomination unrestricted | Fixed, tested |
| F6 | Process | A push (`7bc2ad5`) had a typecheck error in a new test file because a pipeline hid the exit code | Fixed in `048b6bf`; all later checks use exit codes |

**Skipped tests:** the unit+integration run reports 0 skipped (846 passed). The `infra` project (`pnpm test:infra`: real S3 protocol via moto, real ClamAV) skips its real-service cases when those services are absent (this sandbox) and is required, not skipped, in CI (`INFRA_REQUIRED=1`; green on the verified commit). No test was skipped or disabled by this increment. Known limits: reminders are one-shot and in-app; real-AWS validation, separate DB credentials and `pgaudit` remain production-only.
