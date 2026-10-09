# V0 Completion Gate

Evidence for each criterion. **Do not start V1 until every row is ✅ and the compliance matrix is complete.**
Legend: ✅ met and verified here · ⚠️ met with a stated limitation · ⏳ cannot be verified until an external input arrives.

## Architecture
| Criterion | Status | Evidence |
|---|---|---|
| Multi-tenancy | ✅ | Organisation(PRACTICE\|BUSINESS)→Memberships→Companies→Periods; RLS on every tenant table; `tests/api/tenancy.test.ts`, `tests/db/rls.test.ts`, `tests/db/classification.test.ts` (sweep of every tenant table) |
| Authentication | ✅ | `tests/api/auth.test.ts` (30), `login-throttle.test.ts`, e2e |
| RBAC | ✅ | `tests/api/permissions.test.ts` — role × capability matrix over all 6 system roles, escalation guards |
| Audit | ✅ | append-only trigger tests; audited denials, logins, MFA, workflow, AI, integrations |
| Document storage | ✅ | `tests/api/documents-jobs.test.ts`; real S3/clamd in `tests/infra/pipeline.infra.test.ts` |
| Workflow foundation | ✅ | `packages/platform/src/workflow.ts`; `foundations.test.ts` (maker/checker, concurrency, history) |
| Task foundation | ✅ | `apps/api/src/tasks`; assignment rules, scope, events, notifications |
| Notification foundation | ✅ | in-app (RLS private to recipient) + e-mail channel via queue; driven by outbox consumers |
| Integration abstraction | ✅ | `IntegrationAdapter` + registry + SSRF-safe HTTP + encrypted credentials; mock adapter only (no HMRC/CH) |
| AI abstraction | ✅ | `AiProvider`/`AiGateway` (PII redaction, hashed run log) + proposals gated by human approval workflow |
| Queue infrastructure | ✅ | `tests/jobs/jobs.test.ts` (retry/backoff/DLQ/idempotency/progress/sweeper) |
| Transactional outbox | ✅ | `tests/platform/outbox.test.ts` (13) + end-to-end consumer tests; `docs/architecture/events.md` |
| OpenAPI | ✅ | `tests/api/openapi.test.ts`; committed `docs/api/openapi.json`; Swagger UI at `/api/docs` outside production |

## Security
| Criterion | Status | Evidence |
|---|---|---|
| Tenant isolation | ✅ | RLS + app checks + static architecture tests; automated sweep |
| Authentication security | ✅ | Argon2id, hashed tokens, enumeration safety, CSRF origin, session expiry/revocation |
| MFA-ready architecture | ✅ | TOTP + recovery codes implemented; factor type enum; `IdentityProvider` seam |
| Login throttling | ✅ | layered (pair/IP/account), progressive delay, anti-lockout-DoS, generic responses, logging |
| Secrets management | ⚠️ | Design + code complete (Secrets Manager injection, KMS, field encryption, redaction, config guards). The AWS wiring is `terraform validate`d but not applied in a real account. |
| Secure document access | ✅ | AVAILABLE-only, presigned/short-lived, audited, quarantine |
| Audit trail | ✅ | see above |

## Infrastructure
| Criterion | Status | Evidence |
|---|---|---|
| Terraform validates | ✅ | `terraform fmt -check` and `terraform validate` pass (Terraform 1.9.8, AWS provider 5.82.2); also a CI job |
| CI passes | see `README` / latest run | workflow `.github/workflows/ci.yml`; result recorded in the hand-off report |
| Database migration process documented | ✅ | `docs/runbooks/migrations.md`, `infra/db/migrate.sh` (destructive gate verified), `tests/unit/migrations.test.ts` |
| Backup/recovery documented | ✅ | `docs/runbooks/backup-restore.md` |
| Environment configuration documented | ✅ | `.env.example`, zod-validated config, `docs/runbooks/deploy.md` |

## Testing
Unit ✅ · Integration ✅ · API ✅ · Authentication ✅ · Authorisation ✅ · Tenant isolation ✅ · Security ✅ · Regression ✅ (`tests/api/regression.test.ts`, run with `pnpm test:regression`) · Real-infrastructure ✅ (`pnpm test:infra`) · E2E ✅.

## Documentation
Architecture (`V0-foundation.md`) ✅ · Database architecture ✅ · Security model ✅ · Deployment runbook ✅ · Migration runbook ✅ · **V0 compliance matrix ✅ completed (see findings; readiness: CONDITIONAL, remediation awaiting approval)** · API/OpenAPI ✅.

## Open items before V1
1. ✅ Compliance matrix populated (`v0-compliance-matrix.md`); ✅ the 3 `CONFLICTING` items resolved by the approved architecture change set (D1–D6, ADR-22…27); ⏳ remaining Tranche A (master data, feature flags, observability, supply-chain scanning, outbox hardening, remaining task/document/audit fields) must be approved and delivered before V1.
2. ⚠️ First real AWS apply in a non-production account (Terraform validated, not applied).
3. ⚠️ Run `pnpm test:infra` once against **real AWS S3** (staging bucket, `INFRA_ENFORCES_SIGNATURES=1`) before the first production release; CI runs it against moto (S3 protocol) and the official ClamAV image.
