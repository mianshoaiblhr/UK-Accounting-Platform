# Architecture Decision Records (V0)

| # | Decision | Why / alternatives |
|---|---|---|
| 1 | **Modular monolith** (api + worker + web, shared packages) | Future ledger needs transactional consistency; microservices rejected. |
| 2 | **Pooled DB + RLS**, tenant = `organisation_id`, transaction-local `app.organisation_id`/`app.user_id` | Schema/DB-per-tenant rejected (ops cost). Fails closed without context; composite FKs stop cross-tenant references. |
| 3 | **Practice-first single model**: Organisation(PRACTICE\|BUSINESS)→Companies; `company_scope ALL\|ASSIGNED` | Direct business = one-company org. No second product architecture. |
| 4 | **Prisma 6** + hand-written SQL appended to migrations (RLS, grants, triggers, exclusion constraint, seed) | Prisma 7/8 not adopted (driver-adapter churn, release candidates). Schema is source of truth; custom SQL is documented drift. |
| 5 | **Opaque server-side sessions** (hashed, idle+absolute expiry), not JWT | Instant revocation, no key rotation; works unchanged with future OIDC logins because providers only prove identity. |
| 6 | **IdentityProvider interface**; lockout/MFA/session policy applied by `AuthService` for every provider | Entra/Google/Auth0 = one new class + `user_identity` row. |
| 7 | **TOTP implemented in-house** (RFC 6238, tested against RFC vectors), secrets AES-256-GCM, replay protection, recovery codes | Avoids a dependency for ~40 lines; MFA type is an enum, so WebAuthn adds a verifier, not a flow change. |
| 8 | **BullMQ + `job_record`** as durable source of truth + sweeper | Redis may lose data; Postgres record lets us re-dispatch. Sensitive payloads encrypted in Redis and Postgres. |
| 9 | **Ports/adapters** for storage, email, antivirus, identity. AWS knowledge only in `createStorage/createEmail` and Terraform | Moving cloud or adding DR changes env vars, not code. |
| 10 | **Residency guard** in app config and Terraform (`allowed_regions`) | Production refuses to boot outside approved regions; DR region must also be approved. |
| 11 | **Audit append-only in DB** (grants + triggers), written in the business transaction | Cannot be altered by the app role or the owner without disabling triggers. |
| 12 | **Vitest everywhere**; Playwright *library* inside Vitest for E2E | One runner. Integration files run serially (shared DB/Redis). |
| 13 | Turborepo dropped; `pnpm -r` topological build | Not needed at this size. |
| 14 | **OpenAPI in V0**: contract generated from the running Nest app; request schemas ARE the runtime zod validators; route docs table enforced complete by tests; spec committed and drift-checked | Contract is a first-class asset. |
| 15 | **Transactional outbox in V0**: event row written in the business transaction; polling relay with `SKIP LOCKED`; BullMQ hand-off; consumer idempotency via `event_consumption` in the consumer's transaction | Guarantees no lost/phantom events; at-least-once delivery, exactly-once effect. |
| 16 | **Layered login throttling** (IP+account pair, IP, account-under-attack with trusted-IP carve-out) replaces per-account lockout | Stops brute force without enabling lockout DoS; no account enumeration. |
| 17 | **Auth tables outside tenant RLS** is a documented, tested exception (`security-architecture.md` §1.1) | RLS there adds complexity/failure modes with no isolation benefit. |
| 18 | **Real-infrastructure test layer**: shared adapter contract suites run against fakes and real S3/ClamAV; CI requires them (`INFRA_REQUIRED=1`) | Fakes cannot drift from reality. |
| 19 | **Workflow engine, tasks, notifications, integration + AI abstractions** are V0 foundations; AI output is proposal-only behind a human-approval workflow | Reusable by V1+ without re-implementing approvals or leaking vendor SDKs. |
| 20 | Migrations non-destructive by default; destructive ones need an approval marker + verified backup id | `docs/runbooks/migrations.md`. |
| 21 | Deferred: SSO providers, WebAuthn, outbox retention/cleanup job, Redis-backed edge rate limits | Not needed for V0. |

## Known limitations (honest list)
- Login volume cap per IP can affect users behind a shared NAT during an attack (pair/IP/account layers otherwise target the attacker only).
- Global auth tables are protected by application-level controls only — see `security-architecture.md` §1.1 (tested).
- Terraform passes `fmt` + `validate` but has not been applied to a real AWS account. The migration runs as a pipeline step (`infra/db/migrate.sh`), deliberately not provisioned as infrastructure.
- Real S3/ClamAV tests run in the `infra` layer (`pnpm test:infra`); locally against a stand-in S3 server and a minimal-signature clamd, in CI against MinIO + official ClamAV.
