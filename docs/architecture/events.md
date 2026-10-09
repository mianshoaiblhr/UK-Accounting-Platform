# Transactional outbox & domain events

```
HTTP/job handler ──(one DB transaction)──▶ business rows + outbox_event(PENDING)
                                                    │ commit
OutboxRelay (worker, polls, FOR UPDATE SKIP LOCKED) ─▶ events queue (BullMQ, job id = event id)
                                                    ▼
EventBus.dispatch ─▶ each consumer, ONE transaction: event_consumption marker + consumer effects
```
Guarantees: an event exists **iff** its business change committed (same transaction); publication failure leaves the row `PENDING` with `retry_count`, `last_error` and exponential backoff (max 10, then `FAILED` for operator replay `OutboxRelay.replayFailed()`); delivery is at-least-once; consumers are exactly-once in effect (marker + effects commit atomically; redelivery is a no-op; a failing consumer is retried without re-running those that succeeded).

Envelope (`outbox_event`): `id`, `event_type`, `event_version`, `aggregate_type`, `aggregate_id`, `organisation_id`, `actor_user_id`, `payload`, `occurred_at`, `correlation_id`, `causation_id`, `idempotency_key` (unique), `status`, `retry_count`, `last_error`, `next_attempt_at`, `published_at`. Content is immutable (trigger); tenants cannot read/alter it (RLS; only the system relay updates delivery fields).

## Ordering, cleanup and monitoring (hardening)
* **Per-aggregate ordering.** `seq` (identity) orders events; the relay publishes only the *head* event of an aggregate (no earlier event with `processed_at IS NULL`). `EventBus.dispatch` sets `processed_at` once all consumers committed and refuses to run an event ahead of an earlier unprocessed one (`OutOfOrderEventError` → job retry). Different aggregates are independent.
* **Poison events.** A `FAILED` head (retries exhausted) or a consumer that never succeeds blocks its aggregate by design; fix and `replayFailed()` / retry the `event.dispatch` job. Alarm on `failed > 0` and on `oldestUnprocessedAgeSeconds`.
* **Cleanup.** Processed events older than `OUTBOX_RETENTION_DAYS` are deleted with their consumer markers. A trigger makes deleting an unprocessed event impossible.

## Adding an event (V1+)
1. `defineEvent({ type, version, aggregateType, schema })` in `packages/contracts/src/events.ts` (e.g. `TransactionPosted`, `JournalPosted`, `FilingSubmitted`, `FilingAccepted`).
2. In the service, inside the business transaction: `await publishEvent(tx, Events.journalPosted, { aggregateId, organisationId, payload })`.
3. Subscribe with a stable consumer name: `bus.subscribe('reporting.refresh', [Events.journalPosted.type], async ({event, tx}) => …)` in the worker.
No infrastructure change is needed. Breaking payload changes bump `version`; consumers must accept older versions.

V0 emits: `company.created`, `organisation.member_added`, `document.uploaded`, `accounting_period.created`, `task.assigned`, `task.review_requested`, `task.reviewed`, `task.commented`, `workflow.transitioned`, `ai.proposal_created`, `ai.proposal_decided` (decision `ACCEPTED`\|`REJECTED`; `APPROVED` appears only on events emitted before the AI state-model change). Workflow `reassign` is published as `workflow.transitioned` with `from == to`. No accounting events exist yet.
