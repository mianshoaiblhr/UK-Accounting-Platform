# Backup & recovery
| Asset | Mechanism | Retention | Target |
|---|---|---|---|
| PostgreSQL | RDS automated backups + PITR; AWS Backup daily to UK vault | 35 days | RPO ≤ 5 min, RTO ≤ 4 h |
| Documents | S3 versioning + Object Lock (governance, 30d default; raise per retention class) | per class | no loss |
| Redis | Snapshots (7d) — **rebuildable**: `job_record` is the source of truth; the worker sweeper re-dispatches QUEUED jobs | — | — |
| Logs | CloudWatch (KMS, UK) | 400 days | — |
Optional DR: set `dr_region` (must be in `allowed_regions`) to copy backups cross-region. Application code is unchanged.

## Restore drill (quarterly)
1. `aws rds restore-db-instance-to-point-in-time` into a new instance (same KMS key).
2. Point a staging stack at it; run `GET /readyz`, sign in, open a recent document.
3. Verify audit continuity: `SELECT max(occurred_at) FROM audit_event`.
4. After restore: `UPDATE job_record SET status='QUEUED' WHERE status IN ('RUNNING','RETRYING')` and let the sweeper re-dispatch.
5. Record RTO achieved; destroy the staging copy.
