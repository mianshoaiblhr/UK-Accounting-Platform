# Real-infrastructure tests
Layered testing: **fast tests** use in-process adapters (Local storage, EICAR-only scanner); **infra tests** (`pnpm test:infra`) prove the real adapters against real services using the SAME contract suites (`tests/infra/contracts.ts`), plus the full document pipeline (API → presigned upload → queue → worker → clamd).

Architecture invariant (enforced by `tests/unit/architecture.test.ts`): `Application → StoragePort / AntivirusPort → Adapter`. AWS SDK, S3 and ClamAV code exist only in `packages/adapters`.

## CI (required before release)
Job `infra-integration` starts MinIO and ClamAV (official signature database) and runs with `INFRA_REQUIRED=1`, so a missing service **fails** instead of skipping. `INFRA_ENFORCES_SIGNATURES=1` enables the expired-presigned-URL test (MinIO enforces signatures).

## Locally
```bash
docker compose -f infra/docker/docker-compose.yml up -d minio clamav     # wait for clamd to load signatures (~1-2 min)
export INFRA_S3_ENDPOINT=http://localhost:9000 AWS_ACCESS_KEY_ID=minio AWS_SECRET_ACCESS_KEY=minio-secret
export INFRA_CLAMAV_HOST=localhost
pnpm test:infra
```
Without Docker: any S3-compatible server (e.g. `moto_server -p 5000`) and any `clamd` listening on TCP work; unset variables cause the real-service suites to skip (never to pass vacuously in CI).
Pre-production smoke against real AWS: run the same suites with `INFRA_S3_ENDPOINT` unset and `AWS_REGION=eu-west-2` pointing at a throw-away bucket in the staging account.
