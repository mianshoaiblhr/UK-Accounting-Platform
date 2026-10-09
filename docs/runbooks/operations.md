# Operations
- **Failed/dead jobs:** `GET /organisations/:id/jobs` (status DEAD/FAILED) → `POST …/jobs/:jobId/retry`. Dead-letter queue `dead-letter` holds identifiers only.
- **Locked-out user:** they can unlock by password reset; locks expire (15m ×2ⁿ, max 24h).
- **Rotate field-encryption key:** ciphertext is versioned (`v1:`); add `v2` + re-encrypt MFA secrets before retiring the old key.
- **New tenant table:** must include `organisation_id`, enable+force RLS and a policy in its migration — `tests/db/rls.test.ts` fails otherwise.
- **New permission:** append to `PERMISSIONS`; update role seeds via a *new* migration (never edit applied ones).

## Development data policy (decision DEC-003)
Until the retention schedule and the lawful-basis decisions are approved (`docs/legal/retention-verification-schedule.md`), every environment other than a reviewed production gate uses **synthetic or test data only**: no real client, customer, employee or bank data, and no real IP addresses or user agents in shared environments. Nothing in the platform purges data yet (S4(b) is frozen), so real data entered by mistake cannot be assumed removable.

