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
| 14 | Deferred: OpenAPI generation, domain-event outbox, SSO providers, WebAuthn, Redis-backed web rate limits at the edge | Outbox arrives with V1 posting (needs transactional events). |

## Known limitations (honest list)
- Per-account login throttle (10/15 min) can be used to nuisance-lock a known email's sign-ins; lockout state is not revealed. Accepted for V0; add CAPTCHA/step-up later.
- Global tables (`user`, `session`, auth tokens) rely on application discipline, not RLS (only the auth module touches them).
- Terraform is unvalidated in this environment (no AWS/terraform available); CI runs `fmt`/`validate`. The one-off migration ECS task definition is not yet in Terraform (see deploy runbook).
- ClamAV adapter is tested against a protocol-faithful fake, not a live clamd.
- S3 adapter is not exercised against real S3/MinIO in tests.
