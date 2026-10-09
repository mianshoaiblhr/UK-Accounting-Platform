# V1 milestone M1 - acceptance package (ledger core)

Submitted for the product owner's acceptance (DEC-007). **Not accepted until the product owner says so.** M2 has not been started.

## 1. Commit and CI
| Item | Result |
|---|---|
| Verified commit | `fae5270` (branch `claude/adoring-cori-mra6ze`). Later commits change documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37923766068> - **success, 9 of 9 jobs**: build/lint/typecheck/unit/integration/e2e, real S3 (moto) + real ClamAV, dependency audit + gitleaks, migrations-from-scratch, terraform (fmt/init/validate), images api/worker/web/migrate with the Trivy gate |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37923766153> - **success** |
| Clean clone of `fae5270` | install, build, typecheck, lint exit 0; `pnpm test` **64 files, 1170 tests passed, 0 failed, 0 skipped** (V0 final: 59 / 1034); `pnpm test:e2e` 4/4 passed; `pnpm openapi` no drift |
| Local full run before the last push | 1170 tests; 3 failed and were fixed (see section 7) |

## 2. What M1 delivers (V1 plan section 3)
Chart of accounts (default UK chart, versioned), accounting-period states and close controls, the **PostingService**, journals (manual, opening balance, reversal), general ledger with running balance, trial balance (as at a date or a period), all behind feature flag `bookkeeping.core` (default off). API-first (DEC-002): no UI in M1.

## 3. Migrations
`20260106000000_v1_ledger_core` (additive): enum `AccountType`; tables `account`, `ledger_sequence`, `journal`, `journal_line`; three nullable columns on `accounting_period` (who/when/why the state changed); forced row-level security and composite foreign keys on all four tables; `UPDATE`/`DELETE`/`TRUNCATE` revoked on the ledger tables and `DELETE`/`TRUNCATE` on accounts; guard triggers (posting switch, period, currency, line rules, commit-time integrity, immutability, account identity freeze, period state graph); five new permissions added to the system roles; retention rules for the four new tables. Applied from scratch in CI and by the populated-database upgrade test as a non-superuser owner.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Only the PostingService writes the ledger; only it sets the database posting switch; the AI module, platform package and worker cannot import the accounting package | `tests/unit/architecture.test.ts` (4 new rules) |
| The database defends the ledger when the service is bypassed: inserts refused without the switch; period/date/currency/company enforced; lines only in their journal's own transaction; commit-time balance, header and reversal-mirror checks; immutability for the runtime role and the owner; account freeze; period state graph | `tests/db/ledger.test.ts` (17) |
| Privilege matrix: no `UPDATE`/`DELETE`/`TRUNCATE` on journals and lines, no `DELETE`/`TRUNCATE` on accounts and the counter | `tests/db/privileges.test.ts` |
| A concurrent close cannot let a journal land in a period closed a moment earlier | `tests/db/ledger.test.ts` (row-lock test) |
| Role x capability matrix for the five new permissions (8 roles x 5 probes, allowed iff the role holds the permission) | `tests/api/permissions.test.ts` |
| Company scope and tenancy: a member assigned to another company gets 404; an outsider gets 404; another organisation sees zero rows | `tests/api/ledger.test.ts`, `tests/db/ledger.test.ts` |
| AI actors are refused whatever they can do; system actors cannot use user-only sources; the actor always comes from the session, never the request body | `tests/platform/posting-service.test.ts`, `tests/api/ledger.test.ts` |
| Feature flag off = clear 403 `feature_disabled` for the whole ledger API | `tests/api/ledger.test.ts` |
| Money is a decimal string everywhere (JSON numbers, negatives, exponents, extra decimals rejected) | `packages/contracts/src/ledger.test.ts`, `tests/api/ledger.test.ts` |
| Mutation checks: disabling the balance and period checks made 8 tests fail | run during the build |

## 5. Test results for the new work
| File | Tests |
|---|---|
| `tests/platform/posting-service.test.ts` | 32 (positive, negative, reversal, period-lock, idempotency, concurrency, atomicity, validator chain, reads) |
| `tests/db/ledger.test.ts` | 17 |
| `tests/api/ledger.test.ts` | 16 |
| `packages/contracts/src/ledger.test.ts` | 9 |
| `tests/unit/architecture.test.ts` | 20 (4 new) |
The VAT test of "every posting rule needs a VAT test" is not possible yet: there is no VAT rule until M2; the validator slot is exercised with a stand-in.

## 6. Compliance-matrix changes (`v1-compliance-matrix.md|json|xlsx`, 77 rows)
IMPLEMENTED 0 -> **26**, PARTIALLY IMPLEMENTED 2 -> **11**, MISSING 75 -> **40**. Closed with evidence: chart of accounts and its 8 fields, journals, general ledger, trial balance, accounting periods, PostingService as sole writer, balance/account/period/source/permission validation, locked periods, manifest controls 1-5 and 10. Left PARTIAL on purpose: currency validation (foreign currency unsupported), suspense visibility (dashboard is M5), audit trail (source modules add events), the architecture rows (source-document services and statements come with M2-M5), close controls (grow with M2-M4), effective-dated mappings, universal drill-down, events, test coverage (VAT). V0 documents were not touched.

## 7. Findings and fixes during the milestone
* **Design review found two gaps before any code was released, both fixed with tests:** (1) closing a period could race an in-flight posting and let a journal land in the closed period - fixed with a `FOR SHARE` lock on the period row in the service and the database guard; (2) `OPENING_BALANCE`, the one manual source allowed onto control accounts, would have been a bypass of the control-account rule - it is now only accepted on the first day of the company's earliest period (a dedicated permission or approval is an open decision).
* **The full local run found 3 failures**, none a product defect: the V0 boundary regression test asserted that no ledger tables exist (a V0-era guard; updated to the approved M1 tables and still forbidding invoicing, VAT, tax, payroll and filing tables - an intentional, recorded change), the feature-flag listing test needed the new flag, and the OpenAPI file needed regenerating after a lint fix to the account-code pattern.
* No test was skipped, weakened to pass, or deleted.

## 8. Known limitations (carried forward)
1. No UI (M6); no foreign currency, FX or revaluation (open decision 1); no VAT validator yet (M2); no source documents yet (M2+).
2. The posting switch is application-asserted: code able to run arbitrary SQL as the runtime role could set it (same trust boundary as the tenant context; mitigations in `security-architecture.md`).
3. Trial balance and general ledger are computed on demand (no materialised balances); journal numbering serialises postings per company. Both are fine for synthetic data and must be measured before production.
4. `OPENING_BALANCE` and control-account policy are open decisions (v1-plan.md section 4, items 6 and 7).
5. Trial balance is cumulative from the first posting: no year-end closing of profit and loss to retained earnings (V2).
6. Nothing here is production-approved (DEC-006); development data is synthetic (DEC-003); retention remains provisional (DEC-003).

## 9. Decisions needed from the product owner before M2
1. Accept M1 (or list changes).
2. Foreign currency in V1: out of scope, or in scope (and when).
3. VAT foundation scope for M2: schemes (standard / cash accounting / flat rate), rate source, effective dating.
4. Customers/suppliers: reuse `contact` with a role (recommended) or separate tables.
5. Opening-balance and control-account policy (permission or approval step).
