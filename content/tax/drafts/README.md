# Draft tax rules (DEC-097)

These files are **drafts for verification**, not rules in force. Each one is imported through the public API by a person with `ct:manage`, and every rule lands **UNVERIFIED**. A holder of `tax:rule-verify` who did not import it checks each rule against the source it names (the `verifierNote` says what to check) and verifies it in the platform. Nothing here is seeded by a migration, and nothing is used until it is verified.

| File | Rules | Import |
|---|---|---|
| `uk-ct-rules.json` | `CT_RATES` from financial year 2023; `PERIOD_MAX_MONTHS` (12); `AIA_LIMIT`, `WDA_RATES` and `SMALL_POOL_LIMIT` (capital allowances, V4-M3) | `node scripts/tax/import-ct-rules.mjs --api <url> --org <id> --company <id> --token <bearer> content/tax/drafts/uk-ct-rules.json` |

The verifier's worksheet (`docs/legal/rule-verification-worksheet.xlsx`) has a sheet for these rules.
