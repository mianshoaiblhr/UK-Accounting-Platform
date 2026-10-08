# V0 Foundation — Architecture Assessment & Decisions

Supersedes the draft `V0-architecture-plan.md` where they differ. Key change: the draft put empty
ledger structures in V0; the V0 boundary forbids ledger/journal/bookkeeping, so **none** are created.
V0 provides only the infrastructure later versions depend on.

## 1. Architecture assessment
Greenfield repository (no commits when V0 started). No Master Manifest or V0–V12 specs were supplied;
V0 is derived from the 17 architectural rules and your decisions. Modular monolith: `api`, `worker`,
`web`, sharing packages. Business modules added in V1+ must plug into: tenant context, RBAC, audit,
jobs, documents, config, logging. Those are the V0 deliverables.

## 2. Repository structure
```
apps/api       NestJS REST API  (/api/v1)
apps/worker    NestJS standalone BullMQ worker
apps/web       Next.js UI (auth, org/company switcher, documents)
packages/core      config (zod env), errors, logger+correlation (AsyncLocalStorage), crypto, rate-limit
packages/contracts zod schemas, permission catalogue, queue/job definitions (shared by api/worker/web)
packages/db        Prisma schema + migrations + tenant-aware client (only place importing @prisma/client)
packages/jobs      BullMQ infrastructure: producer, consumer runtime, retry/DLQ/progress/idempotency
packages/storage   StoragePort + S3 + local adapters;  AV scan port (ClamAV/noop)
packages/testing   test DB/Redis bootstrap, factories
infra/docker       local compose;  infra/terraform  AWS eu-west-2;  infra/db  role bootstrap SQL
docs/              architecture, ADRs, runbooks
```

## 3. Technology choices
pnpm workspaces · Node 22 · TypeScript strict (CommonJS backend) · NestJS 11 · Next.js 15 / React 19 ·
PostgreSQL 16 · Prisma 6 (+ raw-SQL migrations for RLS/triggers) · Redis 7 + BullMQ 5 · zod · pino ·
argon2id · Vitest 3 (+ SWC for decorator metadata) · Playwright *library* driven from Vitest for E2E ·
AWS SDK v3 (S3, SES) · Terraform. Turborepo was dropped: `pnpm -r` topological ordering is sufficient (ADR-7 amended).

## 4. Database baseline
Migrations only (Prisma migrate; hand-written SQL appended for RLS/grants/triggers/constraints).
Tables — **global**: `user`, `user_identity`, `session`, `auth_token`, `mfa_factor`, `mfa_recovery_code`,
`auth_challenge`. **Tenant** (`organisation_id`, RLS): `organisation`, `role`, `membership`,
`company_assignment`, `invitation`, `company`, `accounting_period`, `document`, `document_version`,
`audit_event`, `job_record`, `idempotency_record`. UUID PKs, timestamptz, snake_case.
Composite FKs `(organisation_id, id)` make cross-tenant references structurally impossible.
`accounting_period` has a no-overlap exclusion constraint per company. Document versions are immutable
(trigger). Audit is append-only (grants + trigger).
DB roles: `uk_migrator` (owner; runs migrations), `uk_app` (runtime; RLS enforced, no BYPASSRLS, no DDL).

## 5. Multi-tenancy model (Practice-first)
`Organisation (PRACTICE | BUSINESS) → Memberships → Users`; `Organisation → Companies → Accounting Periods`.
One architecture: a BUSINESS org is a practice-shaped org with one company. Tenant key =
`organisation_id`. Practice staff may be scoped `ALL` companies or `ASSIGNED` companies only
(`company_assignment`). Enforcement layers: (1) route `:organisationId` validated against the caller's
active membership, (2) RBAC permission, (3) company-scope check, (4) PostgreSQL RLS driven by
transaction-local `app.organisation_id` / `app.user_id` set by `withTenant()`; no context ⇒ zero rows.

## 6. Authentication architecture
`AuthService` → `IdentityProvider` interface (`LocalPasswordProvider` now; `user_identity(provider, subject)`
ready for Entra/Google/Auth0 OIDC providers that return a verified principal). After a provider
authenticates, the **same** session + MFA policy applies. Argon2id hashing (OWASP params), email
verification, password reset (single-use hashed tokens, enumeration-safe), account lockout
(5 fails → exponential lock) + Redis rate limiting (per IP and per account), opaque server-side
sessions (hashed token, idle + absolute expiry, revocation, list/revoke), TOTP (RFC 6238) enrolment,
confirmation, login challenge and recovery codes (secrets AES-256-GCM encrypted), login audit trail.
Why opaque sessions, not JWT: instant revocation, no key-rotation burden, and still IdP-compatible.

## 7. RBAC model
Permission catalogue in code (`resource:action`). Roles are data: system roles (Owner, Admin, Accountant,
Bookkeeper, Reviewer, Client Viewer) seeded by migration + tenant-defined custom roles. Membership →
one role + company scope. Guard `@RequirePermissions()`; services re-check company scope.
Denials are audited.

## 8. Queue architecture
BullMQ/Redis. Queues pre-declared for every listed workload (documents, imports, exports, ai, reconciliation,
notifications, reports, integrations, scheduled) + `dead-letter`. Each job type is a typed *definition*
(queue, name, zod payload, retry policy). Producer writes `job_record` (idempotency unique key) then
enqueues; a sweeper re-enqueues records stuck in QUEUED (Redis outage between the two writes).
Consumer wrapper: tenant context restore, correlation id, status RUNNING/RETRYING/COMPLETED/FAILED/DEAD,
exponential backoff, `UnrecoverableError` for non-retryable, progress reporting, structured logs,
DLQ on exhaustion, manual retry endpoint. Real handlers in V0: `email.send`, `document.process`
(hash + AV scan), `system.echo`. Heavy work never runs in HTTP requests.

## 9. Document storage architecture
`StoragePort` (S3 adapter in AWS; local-disk adapter for dev/test). Key: `org/{orgId}/doc/{docId}/v{n}-{versionId}`.
Flow: create document → presigned upload (S3) / API upload (local) → `complete` → `document.process` job
(SHA-256, ClamAV scan) → `AVAILABLE` or `QUARANTINED`. Versions immutable; downloads only via
short-lived presigned URLs after authz + audit; downloads blocked unless `AVAILABLE`. Bucket: SSE-KMS,
versioning, Object Lock, no public access, eu-west-2. No OCR/extraction in V0 (queues ready).

## 10. Audit architecture
Append-only `audit_event`, written in the same transaction as the change where one exists. Covers auth,
MFA, sessions, membership/role changes, company/period/document actions, permission denials, job
retries. Metadata passes through a redactor (no secrets/tokens/passwords). Org admins read via API;
users read their own login history.

## 11. API structure
`/api/v1`; org-scoped resources under `/organisations/:organisationId/...`; RFC 9457 problem+json;
zod validation (unknown fields rejected); cursor pagination; `Idempotency-Key` on mutating org routes;
correlation id (`x-request-id`) echoed; helmet headers; CORS allow-list; cookie sessions with
Origin check for unsafe methods, or Bearer tokens; `/healthz`, `/readyz`.

## 12. AWS deployment (eu-west-2 London)
VPC (3 AZ, private subnets, VPC endpoints), ALB + WAF, ECS Fargate (api, worker, web), RDS PostgreSQL
Multi-AZ (KMS, PITR, 35-day backups), ElastiCache Redis (encrypted, TLS), S3 documents + backups
(KMS, Object Lock), Secrets Manager, CloudWatch Logs (KMS, UK region, retention), SES (eu-west-2),
AWS Backup vault in eu-west-2. Region is a variable; a **residency guard** in terraform and in app
config rejects non-approved regions. DR: optional `dr_region` variable adds cross-region backup copy
and S3 replication without code change (application only sees endpoints via env).

## 13. CI/CD
GitHub Actions: install → typecheck → lint → unit/integration (Postgres + Redis service containers) →
migration apply-from-scratch check → security scan (audit) → web build → E2E → container build.
Deploy via image tags + `migrate deploy` task before service rollout (manual approval for prod).

## 14. Security model
Argon2id; AES-256-GCM field encryption; RLS fail-closed; DB least-privilege roles; rate limits; lockout;
CSRF defence (SameSite=Strict + Origin check); strict validation; secure headers; audit; log redaction;
SSRF-safe adapters; secrets only via env/Secrets Manager; UK-residency guard; AV scanning; no AI/filing code in V0.

## 15. Testing strategy
Vitest everywhere. Unit (crypto, TOTP, policies, retry), database (RLS, triggers, constraints), integration
(auth, org, jobs), API (supertest), security (headers, enumeration, lockout, rate limit, CSRF origin),
tenancy isolation (two-tenant matrix across all endpoints + RLS direct SQL), permission matrix, regression
suite (tag `regression`, must stay green in every later version), E2E (Playwright lib + Chromium against
running api+worker+web).

## 16. Environment/configuration
12-factor env vars validated by zod at boot (fail fast). No infra-specific logic in code: drivers selected by
`STORAGE_DRIVER`, `EMAIL_DRIVER`, `AV_DRIVER`; AWS specifics only in adapters. `.env.example` documents all.

## 17. Backup/recovery
RDS automated backups + PITR (35 d), daily AWS Backup to a UK vault with vault lock, S3 versioning + Object Lock,
Redis treated as rebuildable (job_record is source of truth; sweeper re-enqueues). Targets RPO ≤ 5 min, RTO ≤ 4 h.
Restore drill documented in `docs/runbooks/backup-restore.md`. Optional DR region copy by variable.

## 18. Risks and decisions
| Risk | Mitigation |
|---|---|
| Manifest/specs absent | Reconcile before V1; ADRs recorded |
| Prisma + RLS | tenant client wrapper, DB tests, lint rule banning direct `@prisma/client` imports |
| Redis/DB dual write | `job_record` + sweeper |
| Terraform unvalidated here (no terraform binary / AWS) | CI runs `terraform validate`; treat as reviewed draft |
| Local ClamAV unavailable here | AV port with noop+fake; clamd adapter covered by unit test with mock socket |
| Rate-limit/lockout DoS of real users | per-account backoff, unlock by reset |
Decisions: modular monolith; pooled DB + RLS; opaque sessions; BullMQ + `job_record`; ports/adapters for storage, email, AV, identity.
Deferred beyond V0: OpenAPI generation, domain-event outbox (needed with V1 posting), SSO providers, WebAuthn.
