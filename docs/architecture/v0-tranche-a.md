# V0 Tranche A — completion log

Approved scope (V0 completion only, no V1): supply-chain scanning, audit framework, feature flags, outbox hardening, master data, task engine, document management, observability. Each increment records what was built, the design decisions (with the reason), behaviour changes and known limits. Decisions follow ADR-22…27; new ones are ADR-28 onwards in `adr.md`.

## 1. Supply-chain security scanning
See `docs/runbooks/supply-chain.md`. `pnpm audit --audit-level=high` is a CI gate (zero known advisories after the fix), gitleaks scans the full history, CodeQL runs on push/PR/weekly, Trivy scans every image, dependency-review blocks risky PRs, Dependabot opens update PRs. Overrides: `postcss`, `deepmerge-ts`; Vitest upgraded to 4.1.x (removes `tinypool`).

## 2. Audit framework (specification §8)
| Requirement | Implementation |
|---|---|
| actor, action, entity, timestamp | unchanged (`audit_event`, append-only) |
| before / after | `before`/`after` JSONB, **changed fields only** (`changeSet`), redacted, ≤ 16 KB in code (oversize → marker) and ≤ 32 KB by DB check |
| reason | `reason` (≤ 1000). Accepted on: member suspend (body) and remove (query), document archive (body), practice/company access removal (query), integration revoke (query). Optional, to stay backward compatible; workflow comments are recorded as the reason of their transition |
| source workflow | `source_workflow_id`. The workflow engine writes an audit event for every start / transition / reassignment; `ai.proposal_applied` carries the proposal's workflow. Filter: `?sourceWorkflowId=` |
| IP / device where lawful | captured by default for security events; `AUDIT_CAPTURE_DEVICE_METADATA=false` removes IP and user agent from **every** audit event (actor, time, correlation id are kept) |
| company dimension | `company_id` on events (DB trigger: must be a company of the event's organisation; no FK so the trail outlives its subjects) |

**Decision (ADR-28): `audit:read` moved from ORG to COMPANY scope.** Previously anyone with `audit:read` saw the whole organisation's trail, which defeated per-company least privilege. Now a company-level auditor sees only that company's events; organisation-level events (no company) need `audit:read` on the organisation role. Role contents are unchanged. Consequence for anti-escalation: only someone who holds `audit:read` on a company can grant a role containing it there.
Limits: events written before this change keep `company_id = NULL` (the trail is immutable, so they are not back-filled) and are therefore treated as organisation-level.
