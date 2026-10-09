# UK Accounting, Tax, Compliance & AI Platform

Practice-first platform for UK accountancy practices (many client companies) and direct SMEs (one company) — **one architecture**.

**Status: V0 — technical foundation only.** No ledger, journals, bookkeeping, VAT/tax, accounts production, AI bookkeeping, iXBRL, Companies House or HMRC functionality exists yet (a regression test enforces this boundary). V0 provides what those modules will depend on.

| Area | V0 delivers |
|---|---|
| Tenancy | Organisation (PRACTICE/BUSINESS) → Practice (practice organisations) → Company → Accounting period; organisation / practice / company-level roles; PostgreSQL RLS (fail-closed) |
| Auth | Email/password (argon2id), email verification, password reset, sessions, lockout + Redis rate limits, TOTP MFA + recovery codes, login audit trail, `IdentityProvider` seam for Entra/Google/Auth0 |
| RBAC | Permission catalogue, system + custom roles, per-company (assigned-scope) access, anti-escalation rules |
| Jobs | BullMQ queues for every planned workload, retries/exponential backoff, DLQ, status/progress, idempotency, correlation IDs, sweeper |
| Documents | Presigned/streamed upload → async hash + content sniff + antivirus → AVAILABLE/QUARANTINED, immutable versions |
| Audit | Append-only (DB-enforced), same-transaction writes, redaction |
| API | `/api/v1`, problem+json, zod validation, cursor pagination, `Idempotency-Key`, CSRF origin checks, security headers |
| Outbox & events | Transactional outbox → relay → idempotent consumers (`docs/architecture/events.md`) |
| Foundations | Workflow engine (maker/checker), tasks, notifications, integration abstraction, AI gateway + human-approved proposals |
| OpenAPI | Generated contract `docs/api/openapi.json`; Swagger UI at `/api/docs` (non-production) |
| Infra | Docker compose, Dockerfile, Terraform for AWS **eu-west-2 (London)**, GitHub Actions CI, migration runner with destructive-change gate |

Docs: [`V0-foundation.md`](docs/architecture/V0-foundation.md) · [`security-architecture.md`](docs/architecture/security-architecture.md) · [`database-architecture.md`](docs/architecture/database-architecture.md) · [`events.md`](docs/architecture/events.md) · [`v0-completion-gate.md`](docs/architecture/v0-completion-gate.md) · [`v0-compliance-matrix.md`](docs/architecture/v0-compliance-matrix.md) · [`adr.md`](docs/architecture/adr.md) · runbooks in [`docs/runbooks/`](docs/runbooks) · API contract [`docs/api/openapi.json`](docs/api/openapi.json).

## Layout
```
apps/api  apps/worker  apps/web
packages/{core,contracts,db,jobs,adapters,platform}
infra/{docker,terraform,db}   tests/{db,jobs,api,e2e}
```
Rule: only `packages/db` may import `@prisma/client` (ESLint-enforced) so the tenant context can't be bypassed. Tenant data is accessed only via `db.tenant({organisationId,userId}, tx => …)`.

## Develop
```bash
pnpm install
bash scripts/dev-services.sh          # or: docker compose -f infra/docker/docker-compose.yml up -d
cp .env.example .env                   # set FIELD_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:generate && pnpm build
MIGRATION_DATABASE_URL=… pnpm db:migrate            # as the owner role
psql … -v app_password=… -f infra/db/bootstrap.sql  # enables login for the uk_app runtime role
node apps/api/dist/main.js & node apps/worker/dist/main.js & pnpm --filter @uk/web dev
```

## Test
```bash
pnpm test                 # unit + database + jobs + API + security + tenancy + permissions + regression
pnpm test:e2e             # real browser (Playwright library under Vitest) against api+worker+web
pnpm test:infra           # real S3 + ClamAV adapter contracts and pipeline (see docs/runbooks/infra-tests.md)
pnpm openapi              # regenerate docs/api/openapi.json after API changes (a test fails if it is stale)
pnpm test:regression      # tests tagged "regression": must stay green in every later version
pnpm typecheck && pnpm lint
```
Integration tests create a fresh `uk_test` database, apply the real migrations, and connect as the non-superuser `uk_app` role, so RLS is genuinely exercised. Env overrides: `TEST_PG_HOST`, `TEST_PG_ADMIN`, `TEST_REDIS`.
