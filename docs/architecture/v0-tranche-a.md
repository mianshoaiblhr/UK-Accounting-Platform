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

## 3. Transactional outbox hardening
| Concern | Implementation | Verified by |
|---|---|---|
| Ordering | `seq` identity column; the relay publishes only an aggregate's **head** (no earlier unprocessed event of the same `aggregate_type`+`aggregate_id`); the event bus refuses (`OutOfOrderEventError`, retried with backoff) to run an event while an earlier one is unprocessed. `processed_at` is set when every consumer committed | `tests/platform/outbox-hardening.test.ts` (head-only publication, failing head blocks only its aggregate, FAILED blocks until replay, concurrent relays, consumer guard) |
| Cleanup | `OutboxRelay.cleanup(retentionDays)` deletes events processed more than `OUTBOX_RETENTION_DAYS` (default 14, min 1) ago and their `event_consumption` markers, in bounded batches, every `OUTBOX_CLEANUP_MS` | same file (retention, batches, markers kept for recent events) |
| Safety of cleanup | `DELETE` is system-context only (RLS) and a trigger rejects deleting any event with `processed_at IS NULL`, whatever its age | same file + `tests/platform/outbox.test.ts` |
| Lag / backlog | `OutboxRelay.stats()` → pending, failed, in-flight, oldest unprocessed age (the *outbox lag*), oldest pending age. Exposed as metrics/alarms in increment 8 | same file (`stats`) |
| Bookkeeping | `processed_at` allowed only on `PUBLISHED` rows (check); `seq` immutable (identity `GENERATED ALWAYS` + trigger) | same file |

**Decision (ADR-29): ordering is guaranteed per aggregate, not globally.** Events of one aggregate are produced one after another because the business change holds the aggregate's row lock / optimistic version until commit, so insertion order is business order. Global order across aggregates is not promised (and not needed). **Liveness trade-off:** a poisoned head event (FAILED, or a consumer that keeps failing) blocks *its own aggregate* until an operator replays it (`replayFailed`) or retries the dispatch job; other aggregates continue and the blocked state is visible as `failed` / `oldestUnprocessedAgeSeconds`. Behaviour change: the app role may now `DELETE` outbox rows through RLS (system context only) instead of never.

## 4. Feature flags (Manifest cross-version rule; cross-platform §9)
* **Registry in code** (`@uk/contracts/features`): `ai.beta`, `documents.ocr`, `tax.rules.next`, `hmrc.endpoints.new`, `filing.formats.new`, `reporting.standards.new` - every flag has a description and defaults **off**. A flag that is not declared cannot be read, set or configured (typos fail at boot or return 404).
* **Resolution:** per-organisation override (table `feature_flag_override`, RLS) > environment default (`FEATURE_FLAG_DEFAULTS="key=true,..."`, validated at startup) > registry default. Per-process cache `FEATURE_FLAG_CACHE_MS` (default 5 s): a switch-off reaches every instance within that window; local changes invalidate immediately.
* **API:** `GET /feature-flags` (any member), `PUT|DELETE /feature-flags/{key}` (`org:manage`, i.e. owner), audited with before/after and reason. `@RequireFeature(key)` guards routes (403 `feature_disabled`); background work re-checks at execution time (queued AI requests stop when `ai.beta` is switched off).
* **Behaviour change:** `POST /ai/suggestions` now requires `ai.beta`, which is off by default in production (AI is "beta" per the specification). Tests enable it through `FEATURE_FLAG_DEFAULTS`. No production AI provider is configured today, so no live capability is lost.
* **Scope decision (documented, not a limitation of the model):** flags are organisation-wide; per-company flags can be added without changing the registry if a later version needs them.
