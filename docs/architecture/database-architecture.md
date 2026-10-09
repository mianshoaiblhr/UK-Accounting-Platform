# Database Architecture (V0)

PostgreSQL 16 (RDS, Multi-AZ, UK). Prisma 6 owns table definitions; hand-written SQL migrations add what Prisma cannot express. Migrations are **forward-only and non-destructive by default** (see `docs/runbooks/migrations.md`).

## Roles
| Role | Used by | Rights |
|---|---|---|
| `uk_migrator` (owner) | `prisma migrate deploy` only | DDL; `lock_timeout 10s`, `statement_timeout 15min` |
| `uk_app` | api, worker | DML only; **no** BYPASSRLS, not owner, no DDL; `UPDATE/DELETE/TRUNCATE` revoked on append-only tables |

## Conventions
UUID keys; `timestamptz`; snake_case; every tenant table has `organisation_id` and composite FKs `(organisation_id, id)` so cross-tenant references are structurally impossible; money (from V1) `numeric(19,4)`.

## Tables (see security-architecture.md for protection per table)
- **Identity (global):** user, user_identity, session, auth_token, mfa_factor, mfa_recovery_code, auth_challenge, login_trusted_ip
- **Tenancy & ownership** (ADR-22/23): `organisation` (PRACTICE|BUSINESS, immutable type; tenant + billing owner) → `practice` (PRACTICE organisations only) → `company` (`organisation_id` = owner, `practice_id` = managing practice, trigger-enforced); access grants at three levels: `organisation_membership` (role + reach ALL|ASSIGNED), `practice_membership` (role), `company_membership` (role); `role` (system or per-organisation); `invitation`. Composite FKs `(organisation_id, id)` make cross-organisation links impossible.
- **Period model:** company → accounting_period (no-overlap exclusion constraint)
- **Documents:** document → document_version (immutable trigger, SHA-256, scan status)
- **Audit:** audit_event (append-only)
- **Async platform:** job_record (+BullMQ), outbox_event, event_consumption, idempotency_record
- **Collaboration foundations:** workflow_instance, workflow_transition (append-only), task, notification
- **Abstractions:** integration_connection (encrypted credentials), ai_run (append-only), ai_proposal

## Integrity mechanisms in the database (not just in code)
RLS fail-closed; append-only triggers (audit, workflow history, AI runs); immutable document versions and outbox event content; membership↔role tenant scope trigger; exclusion constraint on periods; lowercase-email check; unique partial indexes (system role keys, company numbers per tenant).

## Migration history
1. `v0_baseline` — tables from Prisma schema. 2. `v0_security` — roles, RLS, triggers, seed system roles. 3. `v0_foundations` — outbox, workflow, task, notification, integration, AI tables, trusted IPs (additive). 4. `v0_foundations_security` — RLS/grants/triggers for them + new permissions on system roles.
