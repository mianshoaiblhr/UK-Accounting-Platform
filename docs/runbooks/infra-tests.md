# Real-infrastructure tests
Layered testing: **fast tests** use in-process adapters (Local storage, EICAR-only scanner); **infra tests** (`pnpm test:infra`) prove the real adapters against real services using the SAME contract suites (`tests/infra/contracts.ts`), plus the full document pipeline (API → presigned upload → queue → worker → clamd).

Architecture invariant (enforced by `tests/unit/architecture.test.ts`): `Application → StoragePort / AntivirusPort → Adapter`. AWS SDK, S3 and ClamAV code exist only in `packages/adapters`.

## CI (required before release)
Job `infra-integration` starts **moto** (an S3-protocol server; MinIO no longer publishes community binaries/images — HTTP 410) and **ClamAV with the official signature database**, and runs with `INFRA_REQUIRED=1`, so a missing service **fails** instead of skipping. moto does not validate request signatures, so the expired-presigned-URL test (`INFRA_ENFORCES_SIGNATURES=1`) only runs against real S3 in the staging smoke test below.

## Locally
```bash
docker compose -f infra/docker/docker-compose.yml up -d s3 clamav     # wait for clamd to load signatures (~1-2 min)
export INFRA_S3_ENDPOINT=http://localhost:5000 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export INFRA_CLAMAV_HOST=localhost
pnpm test:infra
```
Without Docker: `pip install 'moto[server]' && moto_server -p 5000` and any `clamd` listening on TCP work; unset variables cause the real-service suites to skip (never to pass vacuously in CI).
**Pre-production smoke against real AWS (required before the first production release):** run the same suites with `INFRA_S3_ENDPOINT` unset, `AWS_REGION=eu-west-2`, `INFRA_S3_BUCKET=<throw-away staging bucket>` and `INFRA_ENFORCES_SIGNATURES=1`. This is the only place real-S3 signature enforcement, KMS and Object Lock behaviour are exercised.
