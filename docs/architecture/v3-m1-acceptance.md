# V3 milestone V3-M1 - acceptance package (the taxonomy and its mapping)

**Status:** ACCEPTED under the delegation (DEC-019, DEC-086) on 2026-10-28, on the green CI run recorded in section 1.

The design is in DEC-093 and `docs/architecture/v3-plan.md`, recorded and pushed before code (`27e2819`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. **The draft mapping is not verified:** every concept in it is a proposal written without reading the FRC taxonomy, for the named verifier to check (DEC-083).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `48f841c` |
| CI | [ci run 203](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40783514135) on `17d53a8`, which contains it: every job green, including the real-browser tests and the image scans |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| Source kinds, company details, data and period types, request schemas, `mappingProblems` | `packages/contracts/src/ixbrl.ts` (unit tests in `ixbrl.test.ts`) |
| Permissions `ixbrl:rules-manage`, `ixbrl:rule-verify` (organisation); feature flag `ixbrl.filing` | `packages/contracts/src/permissions.ts`, `features.ts` |
| Tables `xbrl_taxonomy_version` (frozen once verified, never deleted) and `xbrl_concept_map` (changed only while UNVERIFIED); RLS, grants, retention | `packages/db/prisma/migrations/20260204000000_v3_taxonomy_mapping` |
| Service: versions, entries, verification, supersession by copy | `packages/accounting/src/ixbrl.ts` |
| API: 9 operations behind `ixbrl.filing`, documented in the OpenAPI contract | `apps/api/src/ixbrl/ixbrl.controller.ts`, `docs/api/openapi.json` |
| Draft mapping for FRS 105 (30 entries: 7 company details, 23 statutory lines) and its import tool | `content/ixbrl/drafts/`, `scripts/ixbrl/import-taxonomy.mjs` |
| The draft on the verifier's worksheet (sheet "iXBRL mapping", step 8) with the legal references | `docs/legal/rule-verification-worksheet.xlsx` |

## 3. Tests
* **API** (`tests/api/ixbrl-taxonomy.test.ts`, 6 tests):
  * who may create and read;
  * the entry checks (decimals for money only, qualified names, one entry per source) and the problems a version reports;
  * the draft pack imports UNVERIFIED with no problem, and importing needs `ixbrl:rules-manage`;
  * self-verification refused; an inconsistent version refused with its problems; verification by another holder freezes the version and its entries (service and database);
  * supersession by copy, the superseded version left out of the list, the audit trail;
  * the feature flag.
* **Unit** (`packages/contracts/src/ixbrl.test.ts`, 2 tests): `mappingProblems` and the entry schema.
* **RBAC matrix** (`tests/api/permissions.test.ts`): two new probes across every system role.
* **Database** (`tests/db/privileges.test.ts`, `classification.test.ts`, `retention.test.ts`): the versions have no DELETE or TRUNCATE; entries no TRUNCATE (own guard, since an UNVERIFIED version's entries may be removed); both classified and retained.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Only a person changes the mapping; `ixbrl:*` are organisation permissions held by owner and admin | the service's `need`; the migration's grants; RBAC probes |
| A version is used only once someone other than its creator verified it | `self_verification_not_allowed`; the database constraint `verified_by_user_id <> created_by_user_id` |
| A verified version and its entries cannot change, even for the table owner | `xbrl_taxonomy_version_guard`, `xbrl_concept_map_guard` |

## 5. Local runs
* Unit and integration projects: 2,490 passed (147 files).
* Typecheck (every package) and lint: clean.

## 6. Known limitations (recorded in DEC-093)
* The mapping is used from V3-M2 on (the iXBRL document); nothing is tagged yet.
* Directors other than the approving director are not mapped: the officer dimension needs one member per director, decided in V3-M2.
* The FRS 102 Section 1A pack has no draft mapping yet.
