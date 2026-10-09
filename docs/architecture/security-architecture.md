# Security Architecture (V0)

Defence in depth. A request must pass **authentication → tenant membership → RBAC permission → company scope → PostgreSQL row-level security**. Each layer assumes the one above it may have a bug.

## 1. Table protection model
Authoritative source: `packages/db/src/classification.ts`. `tests/db/classification.test.ts` fails if a table is added without a decision, or if the real database protection differs from what is declared here. `tests/unit/architecture.test.ts` fails if code bypasses the model.

| Protection | Meaning | Tables |
|---|---|---|
| **RLS + application authorisation** (both) | Tenant business data. PostgreSQL RLS (forced, fail-closed) **and** RBAC permission + company-scope checks in code. | `organisation`, `role`, `organisation_membership`, `practice`, `practice_membership`, `company_membership`, `feature_flag_override`, `contact`, `address`, `company_officer`, `task_attachment`, `task_comment`, `task_reminder`, `notification_preference`, `document_folder`, `document_access`, `document_extraction`, `evidence_link`, `invitation`, `company`, `accounting_period`, `document`, `document_version`, `audit_event`, `job_record`, `workflow_instance`, `workflow_transition`, `task`, `notification`, `integration_connection`, `ai_run`, `ai_proposal` |
| **RLS only** | Infrastructure plumbing with no user-facing API. Written inside the business transaction or by the system relay; RLS stops any tenant context seeing another tenant's rows. | `outbox_event`, `event_consumption`, `idempotency_record`, `notification_delivery` |
| **Reference data** (global, read-only for the runtime role; changed only by migrations) | ISO currency/country lists and effective-dated tax jurisdictions: no tenant data, no `organisation_id`. | `currency`, `country`, `tax_jurisdiction`, `document_type`, `retention_category`, `retention_rule` |
| **Application-level only** (documented exception) | Global **authentication subsystem**. Not tenant data. | `user`, `user_identity`, `session`, `auth_token`, `mfa_factor`, `mfa_recovery_code`, `auth_challenge`, `login_trusted_ip` |

### 1.1 The authentication-subsystem exception — explicit and deliberate
Authentication tables are **not** under tenant RLS because:
- identity is global (one person belongs to many organisations; a session is resolved by hashed token *before* any tenant is known), so there is no `organisation_id` to filter on;
- forcing RLS here would require a pseudo-context for login/MFA/reset flows, adding complexity and new failure modes to the most security-critical code, for no isolation benefit — these rows hold no tenant business data.

Compensating controls (all tested):
1. **Single gatekeeper.** Only `apps/api/src/auth/*` touches these tables. `tests/unit/architecture.test.ts` forbids any other module from using `prisma.<model>` for a tenant table, and `classification.test.ts` asserts these tables carry **no** `organisation_id` (so tenant data can never be added to them unnoticed).
2. **Secrets are never stored raw:** passwords are Argon2id hashes; session, reset, verification, challenge and recovery tokens are SHA-256 hashes (a database leak yields no usable credential); TOTP secrets are AES-256-GCM encrypted with a per-user AAD.
3. **No API exposes them cross-user.** Every auth endpoint operates on the authenticated caller (`/auth/me`, `/auth/sessions`, `/auth/login-history`); sessions can only be revoked by their owner (`WHERE id AND user_id`).
4. Tenant-facing queries that need user identity (member lists) select only `id/email/displayName` through relations.

## 2. Application-level authorisation for tenant data
- **Tenant comes from the authenticated membership, not the request.** `OrgGuard` resolves `:organisationId` against an ACTIVE membership of the session user; non-members get `404` (existence not revealed) and the attempt is audited as `access.denied`.
- **RBAC.** Routes declare `@RequirePermissions(...)`; a test asserts every org-scoped route has one. A full role × capability matrix test runs for every system role. Custom roles cannot exceed their creator's permissions.
- **Layered, central authorisation (ADR-24).** Four levels - platform role (never grants tenant access), organisation membership (role + reach), practice membership, company membership - resolved by ONE pure module (`packages/contracts/src/authz.ts`) behind ONE request facade (`AccessContext`, `apps/api/src/common/access.ts`). Permissions carry a scope (ORG / PRACTICE / COMPANY). For a company the most specific grant wins and *replaces* broader ones (company > practice > organisation role with reach ALL); no grant means no access (deny by default, 404 so existence is not revealed; 403 + audit when the caller has some access but lacks the permission). Granting a role at any level is bounded by what the granter holds at that level. An architecture test forbids controllers/services from inspecting roles or scopes themselves.
- **Practice ↔ company.** A practice reaches a company only through the explicit `company.practice_id` relationship *and* a `practice_membership` (or an explicit `company_membership`); belonging to the organisation is never enough. Ownership integrity (company/practice in the same organisation, practice only for PRACTICE organisations) is enforced by composite foreign keys and triggers, not just code.
- **Segregation of duties** is a workflow rule (`requireDifferentFromStarter`, `requireDistinctFrom` across all attempts). **No silent transitions:** a database trigger rejects any workflow state change that is not accompanied, in the same transaction, by its recorded transition.
- **No service can query another tenant's data:** all tenant access goes through `db.tenant({organisationId,userId}, tx => …)`, which sets transaction-local settings read by RLS. A context-free query returns **zero rows** and writes are rejected. The only cross-tenant context, `db.system()`, is used in exactly six reviewed files (asserted by a test).

## 3. Authentication security
Argon2id (64 MiB, t=3); email verification required; enumeration-resistant register/forgot/login; single-use hashed tokens with expiry; opaque server-side sessions (idle + absolute expiry, revocable, listed to the user; password reset revokes all, password change revokes others); **MFA-ready**: `mfa_factor.type` enum, TOTP implemented per RFC 6238 with replay protection and hashed single-use recovery codes, challenge token with 5 attempts and 5-minute life, `IdentityProvider` interface so Entra/Google/Auth0 reuse the same lockout/MFA/session policy; cookie `httpOnly; SameSite=Strict; Secure` (prod) plus Origin checks on unsafe methods (CSRF).

## 4. Login throttling (layered; brute-force **and** lockout-DoS resistant)
| Layer | Key | Reaction |
|---|---|---|
| IP + account pair | `(ipHash, emailHash)` | after 3 failures a **progressive wait** (2 s, 4 s, 8 s … up to 15 min) is enforced with `429 + Retry-After` (no server sleeping); at 10 failures the pair is **temporarily blocked** for 15 min |
| Per IP | `ipHash` | ≥100 failures in 15 min **or** ≥20 distinct accounts tried (password spraying) ⇒ IP blocked 15 min |
| Per account | `emailHash` | ≥30 failures from ≥3 distinct IPs ⇒ *account under attack*: sign-ins from IPs that **never succeeded** for this account are refused with the same generic 401; the owner's usual IPs still work |

Properties: counters key on the **hash of the submitted email whether or not the account exists** → identical behaviour for real and unknown addresses; generic `401 invalid_credentials` (never "locked"); throttled responses contain no account information; the attacker's own (IP, email) pair is what gets penalised, so they cannot lock out the owner; a successful login clears the pair counter and records the IP as trusted. **Security logging:** structured `warn` log for every throttle decision (hashes only) and audit events on transitions (`auth.pair_blocked`, `auth.ip_blocked`, `auth.account_under_attack`, `auth.login_blocked_account_pressure`). Redis outage ⇒ sign-in fails closed (5xx, never open).

## 5. Secrets management
- No secret in the repository or images. Runtime secrets come from environment variables injected by ECS from **AWS Secrets Manager** (KMS-encrypted): `DATABASE_URL`, `REDIS_URL`, `FIELD_ENCRYPTION_KEY`. The RDS master credential is generated and rotated by RDS/Secrets Manager (`manage_master_user_password`).
- Field-level encryption (AES-256-GCM, versioned `v1:`) for TOTP seeds, integration credentials and sensitive job payloads; AAD binds ciphertext to its owner/tenant.
- Integration credentials are validated, encrypted, **never returned or audited**, and wiped on revoke (tested).
- Logs redact password/token/secret/cookie keys; audit metadata passes through the same redactor.
- Config validation refuses unsafe production settings (non-UK region, local storage, console/file e-mail, no antivirus, rate limiting off).

## 6. Secure document access
Upload via presigned URL (S3) or API stream → async hash + magic-byte sniff + antivirus; only `AVAILABLE` versions can be downloaded; downloads use short-lived presigned URLs after RBAC + company scope + audit; storage keys are server-generated and tenant-prefixed; versions are immutable (DB trigger) and never deleted; legal hold blocks archiving; bucket: SSE-KMS, versioning, Object Lock, no public access, TLS-only.

## 7. Audit trail
`audit_event` is append-only (grants + triggers, even for the owner), written in the same transaction as the change, with actor, organisation, outcome, IP, user-agent and correlation id; denials and security events are recorded; workflow history (`workflow_transition`) and AI runs (`ai_run`) are append-only too.

## 8. AI and integration boundaries
AI output is only a **proposal** (`ai_proposal`) approved by a human holding `ai:approve` through the workflow engine; prompts are PII-redacted before leaving the platform; runs are logged as hashes; the AI module's imports are asserted by a test. External systems are reached only through `IntegrationAdapter` with an SSRF-safe HTTP client (https, host allow-list, no private ranges, no redirects); calls execute in background jobs.

## 9. Known limitations
Nuisance rate limits (per-IP volume cap on login) can affect users behind a shared NAT during an attack; global auth tables rely on the controls in §1.1; the local ClamAV stand-in used in development has a minimal signature set (CI uses the official database).


## Append-only records and the runtime role (verified, V0 Tranche A)
Append-only and immutable records are protected twice: **privileges first** (the runtime role `uk_app` holds no `UPDATE`/`DELETE`/`TRUNCATE` on `audit_event`, `workflow_transition`, `ai_run`, `task_comment`; no `DELETE`/`TRUNCATE` on `document_version` and `task_reminder`; no `UPDATE` on `task_attachment`) and **triggers second** (`forbid_mutation`, content-immutability triggers). The role owns no table or function, has no `SECURITY DEFINER` helper and cannot disable triggers or RLS. The trusted system context has read-only (`SELECT`) policies on `task_reminder` and `workflow_instance` for the sweepers and gauges; every write runs in the owning tenant's context. `tests/db/privileges.test.ts` asserts the *effective* privileges (default privileges, PUBLIC and role membership resolved) and fails when a new append-only table is added without being covered. Residual trust boundary: the database trusts the application to assert tenant and user for RLS - see `v0-tranche-a.md` section 6.1.
