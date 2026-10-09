# Observability runbook

## What exists
* **Access log**: one JSON line per request (`msg":"request"`): `method`, `route` (template), `status`, `durationMs`, `correlationId`, `traceId`, `userId`, `organisationId`. Search CloudWatch Logs Insights by `correlationId` (also the `x-request-id` response header) or `traceId` (W3C `traceparent`, carried API -> job -> worker).
* **Metrics** (CloudWatch namespace `UkPlatform`, from EMF log lines; `METRICS_EMF=true` in ECS): `worker_heartbeat`, `outbox_pending|failed|in_flight|oldest_unprocessed_seconds`, `jobs{status}`, `task_reminders_due`, `http_requests_total{status_class}`, `auth_login_failures_total{reason}`, `process_*`.
* **Prometheus** (local/diagnostics): set `METRICS_TOKEN` (>= 16 chars) and `GET /api/v1/metrics` with `Authorization: Bearer <token>`. Without a token the endpoint is 404.
* **Probes**: `/healthz` (liveness, no dependencies) and `/readyz` (503 only if the database or Redis is down; `status: degraded` lists background trouble).

## Alarms and first response
| Alarm | Meaning | First steps |
|---|---|---|
| `worker_silent` | no worker heartbeat for 10 minutes | check ECS worker service events and logs; database/Redis reachable? restart the service |
| `outbox_failed` | events gave up after retries | find the cause in the worker log (`outbox`); fix, then replay (`OutboxRelay.replayFailed`) |
| `outbox_lag` | oldest unprocessed event > 10 min | a head event of some aggregate is stuck (per-aggregate ordering, ADR-29): look for a failing consumer; other aggregates continue |
| `jobs_dead` | jobs exhausted their retries | `GET /jobs?status=DEAD`; read `error`; fix the dependency; `POST /jobs/{id}/retry` |
| `jobs_failing` | many FAILED jobs for 15 min | a dependency is down (S3, ClamAV, SES) |
| `api_5xx`, `alb_5xx`, `unhealthy_targets` | server errors / unhealthy web targets | recent deploy? roll back (circuit breaker may already have); logs by `route` and `status` |
| `login_rejected_burst`, `login_throttled_burst` | credential stuffing / brute force | review `login_trusted_ip` and audit `auth.login_failed`; consider WAF rate rules |
| `ecs_*`, `rds_*` | capacity | scale tasks / instance class; check connection pools (`rds_connections`) |

## Rules for adding metrics
Labels come from small fixed sets (route templates, methods, status classes, queue/status names) - never ids, e-mails or free text. The registry drops (and counts in `metrics_dropped_series_total`) any label that looks like an id or query string. A new alarm needs its metric emitted by the code: `tests/unit/observability-infra.test.ts` fails when they drift apart.
