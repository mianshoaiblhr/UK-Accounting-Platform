# UK Accounting, Tax, Compliance & AI Platform — V0 Architecture Plan

Status: **SUPERSEDED by `V0-foundation.md`** (approved with decisions: AWS UK, built-in auth, Redis+BullMQ, practice-first, Vitest). Kept for history; the ledger structures it proposed are out of V0 scope.
Scope: V0 technical foundation only. V1+ not started.

> **Input gap:** the *Master Implementation Manifest* and the V0–V12 specifications were not
> in the repository or the prompt. This plan is derived from the 17 architectural rules in the
> brief. Section N maps V1–V12 only as *placeholder capability slots*; it must be reconciled
> with the real manifest before approval.

---

## A. Current repository assessment

| Item | Finding |
|---|---|
| Commits | None. Branch `claude/adoring-cori-mra6ze` is unborn |
| Files | None (only `.git`) |
| Existing tests / CI / migrations / schema | None |
| Manifest / specs | Not present |

Consequences: greenfield. "Preserve existing functionality" has nothing to preserve yet, so the
V0 test suite becomes the baseline every later version must keep green. Nothing needs migrating.

---

## B. Proposed architecture

**Modular monolith, deployed as two processes from one codebase** (API and Worker), plus the web app.
Rationale: the ledger needs strong transactional consistency (Rules 9–11), and microservices would
turn every posting into a distributed transaction. Module boundaries are enforced in code so
modules can be extracted later if ever justified.

```
 Browser ── Next.js (apps/web, BFF-less, calls API only)
               │  HTTPS, /api/v1
          ┌────▼─────────────────────────────────────────────┐
          │ NestJS API (apps/api)                             │
          │  Guards: AuthN → Tenant → RBAC → Rate limit       │
          │  Domain modules (see E)                           │
          │  Posting Service  ← sole writer of posted ledger  │
          └───┬───────────────┬──────────────────┬───────────┘
              │ Prisma        │ outbox           │ S3 API
        ┌─────▼─────┐   ┌─────▼──────┐     ┌─────▼──────┐
        │ PostgreSQL │   │ Redis      │     │ Object     │
        │ (RLS)      │   │ (BullMQ)   │     │ storage    │
        └─────▲─────┘   └─────▲──────┘     └────────────┘
              │               │
          ┌───┴───────────────┴───────────┐
          │ NestJS Worker (apps/worker)    │── Adapters ──► HMRC / Companies House / Open Banking / AI providers
          └────────────────────────────────┘
```

Core principles:
1. **Ledger-centric.** Sub-ledgers (sales, purchases, bank, payroll, tax) produce *posting requests*; only `PostingService` converts them to posted journals.
2. **Command/Query separation inside modules**; reports read from ledger/projections, never recompute accounting logic.
3. **Everything external is behind a port + adapter** (HMRC, Companies House, banks, AI, email, storage, virus scan).
4. **Everything material is traceable**: `figure → ledger line → journal → source document/transaction → file hash`.
5. **Rules as data**: tax and accounting rules live in effective-dated, versioned tables/packages, never inline constants.

---

## C. Monorepo / project structure

pnpm workspaces + Turborepo. Node LTS, TypeScript strict everywhere.

```
/
├─ apps/
│  ├─ web/            Next.js (App Router), TS, generated API client
│  ├─ api/            NestJS HTTP API (versioned /api/v1)
│  └─ worker/         NestJS standalone app: queue consumers, schedulers, outbox relay
├─ packages/
│  ├─ db/             Prisma schema, migrations, tenant-aware client, DB roles/RLS SQL
│  ├─ contracts/      Zod schemas + OpenAPI DTOs shared by web/api (single source of API types)
│  ├─ domain-core/    Money, Decimal, dates (UK tax year/period maths), ids, Result, errors
│  ├─ rules/          Effective-dated rule engine + versioned rule packs (VAT, CT, PAYE, ...)
│  ├─ platform/       Cross-cutting Nest libs: auth, tenancy, audit, events, outbox, storage, config, logging, tracing
│  ├─ adapters/       hmrc/, companies-house/, banking/, ai/, email/, av-scan/ (each: port + impl + fake)
│  ├─ testing/        Factories, tenant test harness, fake adapters, ledger invariant assertions
│  └─ config/         Shared eslint, tsconfig, prettier, dependency-cruiser rules
├─ modules/           Business modules (Nest modules, imported by api & worker) — see E
│  ├─ identity/ tenancy/ ledger/ posting/ documents/ ...
├─ infra/
│  ├─ docker/         Compose (postgres, redis, minio, mailpit), Dockerfiles
│  └─ iac/            (Terraform) later phase
├─ docs/
│  ├─ architecture/   this plan, ADRs (docs/architecture/adr/NNNN-*.md), C4 diagrams
│  └─ specs/          manifest + V0–V12 specs (versioned, immutable once approved)
└─ .github/workflows/
```

Rule: `apps/*` contain wiring only. Business logic lives in `modules/*`; shared primitives in `packages/*`.

---

## D. Database architecture

PostgreSQL, Prisma for schema, migrations (`prisma migrate`) and typed access. Raw SQL migrations
(inside Prisma migration files) are used for what Prisma cannot express: RLS policies, triggers,
constraints, partial/exclusion indexes, roles.

**Conventions**
- Every tenant-owned table: `tenant_id uuid not null`, composite FKs include `tenant_id` so cross-tenant references are structurally impossible.
- IDs: UUIDv7 (time-ordered). `created_at`, `created_by`, `updated_at` on all tables.
- Money: `numeric(19,4)` + `currency char(3)`; never floats. Computations use a Decimal library in `domain-core`.
- Effective dating: `valid_from date`, `valid_to date null`, with a Postgres **exclusion constraint** preventing overlaps per key. Plus `recorded_at` for bitemporal needs where restatement matters (rules, rates).
- Soft-delete is banned for financial records; use status + reversal.

**Schemas (Postgres schemas for logical separation)**
`platform` (tenants, users, roles, audit, outbox, jobs) · `ledger` (accounts, periods, journals, lines) ·
`docs` (documents, versions, links) · `rules` (rule sets/versions) · `tax`, `ar`, `ap`, `bank`, `payroll`, `filing` (added by later versions) · `ai` (runs, proposals, approvals).

**Ledger core (V0 creates the structure empty; V1 populates)**
- `chart_of_accounts`, `accounting_period` (open/closed/locked), `journal` (header: status `DRAFT|POSTED|REVERSED`, source ref, document ref, posting key), `journal_line` (account, debit/credit, currency, base amount, dimensions).
- **Immutability enforced in the database**, not just code:
  - App DB role has `INSERT/SELECT` on `journal`/`journal_line`; posted rows protected by `BEFORE UPDATE/DELETE` triggers that raise.
  - Only the `posting` DB role (used via a dedicated connection by `PostingService`) may insert rows with `status='POSTED'`; enforced by trigger + grants. Rule 10 is therefore enforced at DB level too.
  - Deferred constraint trigger: Σdebit = Σcredit per journal, ≥2 lines, period open.
  - Corrections: `reverses_journal_id` link + new journal; never edit.
  - Idempotency: unique `(tenant_id, posting_key)`.
- Optional hash chain (`prev_hash`, `row_hash`) per tenant journal sequence for tamper evidence.

**Audit & traceability**
- `audit_event` append-only (who, tenant, action, entity, before/after hash, request id, ip, ts). Insert-only grants.
- `source_link` generic table: `(figure/ledger_line) → (source_entity_type, id) → document_version_id`.

**Migrations**: forward-only, reviewed, run by a dedicated migrator role in CI/CD before deploy; expand/contract pattern for zero-downtime; every migration has an integration test applied on a prod-like snapshot.

---

## E. Module boundaries

Each module = Nest module with public `index.ts` API (facade + events + DTOs). Cross-module access only via the facade or domain events; no importing another module's internals or Prisma models. Enforced by `dependency-cruiser` / `eslint-plugin-boundaries` in CI.

| Layer | Modules |
|---|---|
| Platform | `identity` (users, sessions, MFA), `tenancy` (tenants, entities, memberships), `authz` (RBAC/policies), `audit`, `eventing` (outbox, bus), `jobs`, `observability`, `config` |
| Accounting kernel | `ledger` (read model, accounts, periods), **`posting`** (sole writer), `fx`, `periods` (close/lock) |
| Evidence | `documents` (storage, versions, hashing, OCR hooks, retention), `traceability` |
| Sub-ledgers (V1+) | `sales`, `purchases`, `bank`, `assets`, `payroll`, `inventory` — emit *posting requests* only |
| Tax & compliance (V1+) | `rules` (effective-dated engine), `vat`, `corporation-tax`, `paye-rti`, `self-assessment`, `accounts-filing`, `confirmation-statement` |
| Integrations | `integrations/hmrc`, `integrations/companies-house`, `integrations/banking` — adapters only, invoked by workflows |
| AI | `ai-gateway` (provider abstraction, prompt/versioning, logging, PII redaction), `ai-proposals` (suggestions stored as *proposals*), `workflows` (approval flow) |
| Reporting | `reporting` (TB, P&L, BS, VAT returns drill-down) — read-only over ledger |

Key invariants:
- Nothing but `posting` imports the posting DB connection.
- `ai-*` modules have **no** dependency on `posting` or `integrations/*`; they can only create `Proposal` records. Execution happens in `workflows` after a human with permission approves (Rule 12). Filing submissions require an `authorised_filing` workflow state, signed off by a role with `filing:submit` and recorded in audit.

---

## F. Authentication / RBAC architecture

- **AuthN**: OIDC-compatible. V0 ships a first-party local provider (email + argon2id password, TOTP MFA, mandatory for privileged roles) behind an `IdentityProvider` port so an external IdP (Entra/Auth0/Keycloak) can be swapped in without touching modules. Accountant/practice SSO is expected.
- **Tokens**: short-lived access JWT (≈10 min, asymmetric, `kid` rotation) + rotating refresh tokens (httpOnly, secure, SameSite cookies for web; reuse detection revokes the family). Sessions listable/revocable.
- **Service identity**: workers/adapters use separate machine credentials; no human token reuse.
- **RBAC with scoped permissions**:
  - Permissions are fine-grained strings: `ledger:read`, `journal:draft`, `journal:post`, `period:close`, `vat:prepare`, `filing:submit`, `ai:approve`, `user:admin`…
  - Roles = named permission sets, tenant-configurable, with seeded defaults (Owner, Accountant, Bookkeeper, Reviewer, Approver, Client-Viewer, Auditor-ReadOnly, Platform-Support).
  - Membership scope: tenant → optionally entity (company) level, so a practice user sees only assigned clients.
  - Optional ABAC checks layered on top (amount thresholds, segregation of duties: preparer ≠ approver ≠ submitter).
- **Enforcement**: Nest guard evaluates `@RequirePermission()` per route; domain services re-check via `AuthzService` (defence in depth); DB RLS is the last line.
- **Break-glass/support access**: time-boxed, tenant-consented, fully audited; never default.

---

## G. Multi-tenancy strategy

Hierarchy: **Tenant (practice or business group) → Entity (legal entity: company, sole trader, partnership) → data.**

- **Pooled database, shared schema, `tenant_id` on every row, enforced by PostgreSQL Row-Level Security** (`FORCE ROW LEVEL SECURITY`; app role is not owner and has no `BYPASSRLS`).
- Per request/job: transaction begins with `SELECT set_config('app.tenant_id', $1, true)` (and `app.user_id`), set by a Prisma client extension in `packages/db`. A query without tenant context returns zero rows / fails closed.
- Tenant derived from the authenticated membership, never from client-supplied body/query; path may carry `entityId` which is validated against membership.
- Composite FKs `(tenant_id, id)` prevent cross-tenant joins. Unique constraints include `tenant_id`.
- Object storage keys prefixed `tenant/{id}/…`; presigned URLs minted per request after authz. Queue payloads carry `tenantId`, and workers re-establish context before any DB work. Caches/keys namespaced by tenant. Logs and traces carry `tenant_id`.
- **Automated isolation tests** (in `packages/testing`): a harness that seeds two tenants and asserts every endpoint and repository cannot read/write across them; a CI check fails if a new table lacks `tenant_id` + RLS policy.
- Escape hatch: design permits promoting a large tenant to a dedicated database/schema later (connection resolver is abstracted) — not built in V0.
- Alternative considered: schema-per-tenant — rejected (migration fan-out, Prisma poor fit, connection overhead).

---

## H. API architecture

- Versioned REST: `/api/v1/...`; URI versioning, additive-only within a version, deprecation headers; breaking changes → `/v2`.
- OpenAPI generated from NestJS + Zod DTOs (`packages/contracts`); the web client is generated from the spec (no hand-written fetchers). Contract tests in CI detect breaking diffs.
- Conventions: resource-oriented; cursor pagination; filter/sort whitelists; RFC 9457 problem+json errors with stable error codes; `Idempotency-Key` header required on all mutating financial endpoints; `ETag`/`If-Match` optimistic concurrency on drafts; request id propagated (`X-Request-Id` + W3C `traceparent`).
- Commands that change accounting state are explicit actions (`POST /journals/{id}/post`, `/periods/{id}/close`) rather than generic PATCH of status.
- Rate limiting per tenant/user/route; separate stricter limits for expensive/AI endpoints. Global validation (whitelist, forbid unknown fields).
- Health: `/healthz` (liveness), `/readyz` (db, redis, storage).
- Async operations return `202` + operation resource with status polling (and later SSE/webhooks).

---

## I. Event / queue architecture

- **Transactional outbox** in Postgres: domain events are written in the same DB transaction as state changes; a relay in `apps/worker` publishes them. Guarantees no lost/phantom events.
- **BullMQ on Redis** for jobs (retries with backoff, delay/schedule, concurrency, per-queue rate limit — needed for HMRC/CH throttling). Alternative considered: pg-boss (one less piece of infra); retained as a fallback ADR if we want to avoid Redis.
- Event envelope: `{id, type, version, tenantId, entityId, occurredAt, actor, correlationId, causationId, payload}`; schema-versioned and validated with Zod.
- Consumers are **idempotent** (inbox/dedupe table keyed by event id + handler).
- Queues (initial): `outbox-relay`, `documents` (scan/OCR/extract), `integrations-hmrc`, `integrations-ch`, `ai`, `notifications`, `reports`, `scheduled`. Dead-letter queues with alerting and an admin replay tool.
- Posting is **synchronous and transactional** (API → PostingService), not queue-driven, to preserve atomic user feedback; downstream effects (projections, notifications) are event-driven.
- Long-running filings are modelled as durable **workflow state machines** persisted in DB (draft → reviewed → approved → submitted → acknowledged), not in-memory jobs.

---

## J. Document storage architecture

- S3-compatible object storage (MinIO locally; S3/GCS/Azure Blob in prod via a `StoragePort`). Region: UK/EU data residency.
- Upload flow: API creates `document` + pending `document_version`, returns presigned PUT → client uploads → worker: size/type sniff, **antivirus scan (ClamAV adapter)**, SHA-256, metadata extraction → status `AVAILABLE`/`QUARANTINED`.
- Documents are **immutable and versioned**; replacing = new version. Content-addressed hash stored in DB and (optionally) in ledger link for tamper evidence.
- Server-side encryption (KMS), per-tenant key prefix; optional per-tenant envelope keys later. Object versioning enabled; **Object Lock/WORM** for filing evidence and retention-bound records (UK: typically ≥6 years for company records — retention policy table is configurable per document class, legal-hold supported).
- Access only via short-lived presigned GETs minted after authz + audit event; no public buckets.
- `document_link` binds a document version to any source entity (invoice, bank line, journal, filing); the traceability module resolves figure → source → document.
- OCR/AI extraction output is stored as *derived data* with confidence + model/version, and never auto-promoted to accounting truth (Rule 12).

---

## K. Testing strategy

| Level | Tooling | Notes |
|---|---|---|
| Unit | Vitest (or Jest for Nest) | Pure domain logic, Money, date/tax-year maths, rule evaluation |
| Property-based | fast-check | Ledger invariants: balanced, immutable, reversal nets to zero, rounding |
| Integration | Testcontainers (real Postgres + Redis + MinIO) | Repositories, RLS, triggers, outbox, migrations |
| Tenant isolation | Shared harness | Mandatory for every module; CI gate |
| API/contract | Supertest + OpenAPI diff | No breaking changes within `/v1` |
| Adapter contract | Recorded fixtures + fake servers; HMRC sandbox in nightly | Adapters must pass a shared port-contract suite incl. the fake |
| E2E | Playwright | Critical journeys only |
| Security | Semgrep, dependency audit, secret scan, ZAP baseline | In CI |
| Golden/regression | Versioned fixtures of statutory calculations (VAT, CT, PAYE) by effective date | Cross-version regression guard |
| Non-functional | k6 smoke/load on posting and reports | Later phases |

**Version-gate rule:** every version PR must keep the full prior suite green; a `regression` tag collects each version's acceptance tests and runs on every PR from then on. Coverage thresholds on `domain-core`, `posting`, `rules` (≥90% lines/branches).

---

## L. CI/CD strategy

GitHub Actions, Turborepo remote cache.

- **PR pipeline**: install → typecheck → lint (incl. boundary rules) → unit → integration (Testcontainers) → migration check (apply on empty DB **and** on previous-version snapshot; `prisma migrate diff` must be clean) → OpenAPI breaking-change check → build → security scans → preview env (optional).
- **Main**: build immutable container images (api, worker, web), SBOM + signing (cosign), push to registry, deploy to **staging** automatically, run smoke/E2E; **production** by manual approval with migrate-then-deploy and automatic rollback on failed readiness.
- Environments: local (Compose) → dev → staging → prod; config through env + secret manager; no secrets in repo.
- Branching: trunk-based with short-lived branches, conventional commits, required reviews (CODEOWNERS for `posting`, `packages/db`, `rules`, auth).
- Release/versioning: platform version tagged per spec version (`v0.x`, `v1.x`…); DB migrations are versioned independently and never edited after merge.

---

## M. Security architecture

- **Threat model first** (STRIDE) documented in V0; revisited per version. Data classes: financial, personal (PII, NI numbers, payroll), government credentials (HMRC/CH tokens) — highest sensitivity.
- Encryption: TLS 1.2+ everywhere; at-rest encryption (DB, object store, backups); application-level field encryption (envelope) for NI numbers, bank details, UTRs, third-party OAuth tokens. Secrets in a manager (never DB plaintext).
- **Integration credentials** (HMRC OAuth, Gateway tokens, CH keys) stored encrypted, scoped per tenant/entity, accessible only to adapter modules; rotation and revocation flows.
- Input validation (Zod) at the boundary; output encoding; strict CSP, CORS allow-list, CSRF protection for cookie flows, secure headers (helmet), SSRF guard on outbound adapters (allow-listed hosts).
- **Audit**: append-only, tamper-evident; covers auth events, permission changes, posting, period close, exports, AI approvals, filing submissions, support access.
- **AI safety**: PII redaction/minimisation before provider calls; provider contract with no-training/zero-retention; prompt-injection treatment of all document text as untrusted data; AI outputs validated against schemas; AI service account has no ledger/filing permissions; all runs logged (inputs hash, model, version, outputs).
- Segregation of duties enforced in workflows (preparer/approver/submitter).
- Supply chain: lockfile, Renovate, pinned base images, Dependabot-style alerts, SBOM, signed artifacts.
- Compliance posture to design toward: UK GDPR/DPA 2018 (DSAR export, erasure vs. statutory retention conflict handled by retention policy), HMRC software recognition & fraud-prevention headers (required for MTD), ISO 27001-aligned controls. Penetration test before first production tenant.
- Backups: PITR, encrypted, tested restores; RPO ≤ 5 min, RTO ≤ 4 h targets (to confirm).
- **Observability**: OpenTelemetry traces/metrics/logs, structured JSON logs with `tenant_id`/`request_id` (no PII/amounts in logs), RED + queue + DB metrics, SLO dashboards, alerting on DLQ growth, failed postings, unbalanced-journal detector, and filing-deadline monitors.

---

## N. Development phases

**V0 — Technical foundation (this deliverable, after approval)** — *no business features*
1. Monorepo scaffold, tooling, lint/type/boundary rules, commit hooks, Docker Compose (Postgres, Redis, MinIO, Mailpit, ClamAV).
2. `packages/db`: Prisma baseline; platform tables (tenant, entity, user, membership, role, permission, audit_event, outbox, inbox); RLS framework + CI check; DB roles (`app`, `posting`, `migrator`, `readonly`).
3. Ledger **structure only** + immutability/balance triggers + PostingService skeleton with invariant tests (tests drive the design before V1 features).
4. Auth (local IdP + MFA), tenancy context, RBAC guard, audit interceptor.
5. API skeleton: `/api/v1`, OpenAPI, problem+json, idempotency, health, rate limiting.
6. Eventing: outbox relay, BullMQ, worker app, DLQ.
7. Documents: storage port, upload/scan/hash/version flow, presigned access.
8. Observability + logging + tracing; security headers.
9. Web skeleton: auth, tenant/entity switcher, generated client, layout shell.
10. CI/CD pipelines, ADR set, runbook, threat model.

**V1–V12 (placeholders — to be replaced by real specs):** foundation build-out will proceed one version at a time, each as a vertical increment on the same codebase. Likely sequence (assumption): V1 chart of accounts/journals/posting & periods → V2 sales/purchases sub-ledgers → V3 bank & reconciliation → V4 VAT/MTD → V5 payroll/RTI → V6 corporation tax → V7 Companies House/statutory accounts → V8 self-assessment/other tax → V9 reporting & traceability UI → V10 AI assistants & proposal workflow → V11 practice management/multi-client → V12 hardening/scale/compliance certification. Each version: migrations only (no schema rewrites), full regression gate, ADR for any deviation from the manifest.

---

## O. Risks and architectural decisions

### Architectural decisions (to be recorded as ADRs on approval)
| # | Decision | Alternatives rejected |
|---|---|---|
| ADR-1 | Modular monolith (api + worker + web) | Microservices (distributed ledger consistency, ops cost) |
| ADR-2 | Postgres pooled multi-tenancy with RLS | Schema/DB-per-tenant (ops/migrations), app-only filtering (single-bug leak) |
| ADR-3 | Prisma ORM + raw SQL migrations for RLS/triggers | Drizzle/TypeORM: no compelling gain. *Caveat:* Prisma lacks native RLS/deferred constraints, handled via SQL migrations + client extension; high-throughput posting path may use a thin parameterised-SQL repository inside `posting` only |
| ADR-4 | DB-enforced ledger immutability + dedicated posting role | Code-only enforcement (bypassable) |
| ADR-5 | Transactional outbox + BullMQ | Direct publish (dual-write loss), Kafka (overkill now) |
| ADR-6 | Rules as effective-dated data/versioned packs | Hard-coded rates; mutable config |
| ADR-7 | pnpm + Turborepo | Nx (heavier), npm workspaces |
| ADR-8 | Zod contracts → OpenAPI → generated client | Hand-maintained DTOs on both sides |
| ADR-9 | Money = Decimal/`numeric(19,4)`, rounding policy centralised | Floats / integer pence only (kept as view option) |
| ADR-10 | Externalisable IdP behind port; local IdP in V0 | Mandating a vendor now |

### Key risks
| Risk | Impact | Mitigation |
|---|---|---|
| **Manifest/specs not yet supplied** | Plan may diverge from constitution | Approval is conditional on reconciliation; provide manifest before V0 build |
| Prisma limitations (RLS, triggers, Decimal perf, interactive-tx overhead) | Isolation/perf gaps | RLS via client extension + SQL; CI check; contained raw-SQL escape in `posting` |
| Tenant leakage | Critical | RLS fail-closed, composite FKs, isolation test harness as CI gate |
| Ledger immutability bypass | Critical | DB triggers/grants, separate role, property tests, hash chain |
| Rounding/penny differences vs HMRC | Filing errors | Central rounding policy, golden statutory fixtures, per-rule documented rounding |
| Statutory change (rates, MTD scope, Companies House reforms) | Wrong computations | Effective-dated rule packs, change-log process, monitor GOV.UK/HMRC |
| HMRC/CH API instability, sandbox ≠ production, recognition process lead time | Delivery delay | Adapters + fakes + contract tests; start HMRC software recognition & fraud-prevention header work early |
| AI hallucination / prompt injection | Wrong or malicious postings/filings | Proposal-only AI, schema validation, human approval, redaction, full run logging |
| Scope creep across 12 versions | Rework | Strict module boundaries, versioned contracts, regression gate |
| GDPR vs retention conflicts | Compliance | Retention classes, legal holds, pseudonymisation rather than deletion for ledger-linked PII |
| Single-tenant "noisy neighbour" | Performance | Per-tenant rate limits, queue fairness, option to isolate big tenants |
| Regulatory exposure (not a regulated adviser; liability for outputs) | Legal | Disclaimers/review workflows; legal review before launch |

### Open questions for you
1. Please supply the **Master Implementation Manifest** and V0 spec so I can reconcile this plan.
2. Hosting target (AWS / Azure / GCP) and data-residency requirement?
3. External IdP preference (or local auth for now)?
4. Redis acceptable as infrastructure, or prefer Postgres-only queueing (pg-boss)?
5. Primary users: practices managing many clients, direct SMEs, or both (affects tenant/entity model weight)?
6. Test runner preference: Vitest vs Jest for Nest packages (default proposed: Jest in `apps/api`/`modules`, Vitest elsewhere).

---

**Next step on your approval:** I will build V0 steps 1–10 above (foundation only, no V1 features), committing incrementally to `claude/adoring-cori-mra6ze`.
