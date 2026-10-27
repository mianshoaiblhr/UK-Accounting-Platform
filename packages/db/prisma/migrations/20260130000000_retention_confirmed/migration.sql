-- DEC-084 (amends DEC-003): the product owner confirmed every retention period on 2026-10-27. Reference data only: nothing is deleted,
-- archived or anonymised here (purge and erasure are milestone PRIV-1). WHILE_ACTIVE becomes a 6-year period from the end of the
-- relationship. tests/db/retention.test.ts keeps these rows identical to packages/contracts/src/retention.ts.

UPDATE "retention_category"
SET "name" = 'Held while the relationship is active, then 6 years',
    "kind" = 'PERIOD',
    "period_years" = 6,
    "period_days" = NULL,
    "period_trigger" = 'RELATIONSHIP_END',
    "basis" = 'Master data and working records needed for as long as the organisation or user account exists, then kept for the Limitation Act 1980 s.5 period (6 years) after the relationship ends (DEC-084).'
WHERE "code" = 'WHILE_ACTIVE';

UPDATE "retention_category" SET "status" = 'CONFIRMED';
