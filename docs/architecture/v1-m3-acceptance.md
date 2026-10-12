# V1 milestone M3 - acceptance package (foreign-currency foundation)

Submitted for the product owner's acceptance (DEC-007). **Not accepted until the product owner says so.** M4 has not been started. Nothing here is production approval (DEC-006); development data is synthetic (DEC-003) and **no real exchange-rate figure is in the repository**.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `c8fd8c0` (branch `claude/adoring-cori-mra6ze`). Later commits are documentation only (this package) |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470095> - **success, 9 of 9 jobs** (build/lint/typecheck/unit/integration/e2e, real S3 + ClamAV, dependency audit + gitleaks, migrations-from-scratch, terraform validate, images api/worker/web/migrate with the Trivy gate) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470019> - **success** |
| Clean clone of `c8fd8c0` | install, build, typecheck, lint exit 0; `pnpm test` **72 files, 1415 tests passed, 0 failed, 0 skipped** (M2: 68 / 1303); `pnpm test:e2e` 4/4; `pnpm openapi` no drift |
| Terraform | validation only: **no infrastructure has been applied or verified in AWS** |

## 2. What M3 delivers (plan section 5; DEC-009, DEC-016, DEC-017, DEC-018; ADR-55, ADR-56)
* **Rates (DEC-016):** `exchange_rate` is sourced, immutable reference data. Manual entry (source text mandatory, audited) is always allowed; a published series is loaded from a **CSV file** (publisher, series, URL, retrieved-at and batch kept; rows start UNVERIFIED; all-or-nothing). Lookup: the rate for the transaction date, else the latest earlier daily rate within **7 days**, else `exchange_rate_not_found`; never a later rate; a company default series resolves ambiguity. Corrections supersede (old rate stays for the journals that used it). A rate is verified once by someone other than the person who entered it; a company policy can refuse postings that use an unverified rate.
* **Conversion (DEC-017):** one function; rate stored to 8 decimals and never rounded; each functional amount rounded **per line, half-up**; a visible system **FX-rounding line** absorbs up to one minor unit per line (else refused). The database re-proves every converted line (`functional = round(original x rate)`, stored rate for the pair, not dated after the journal).
* **Journals:** `POST /journals` takes `currency` (transaction currency), amounts in it, and `rateId` or `manualRate` or the lookup; lines keep original currency, original amounts, rate and rate id (immutable; reversals copy them). The company currency cannot change once a journal exists.
* **Revaluation and realised FX (DEC-018):** explicit, previewed revaluation per period (`period:manage`) of foreign-currency **monetary** accounts at the closing rate to a designated unrealised account, with an auto-reversal the next day; idempotent; concurrent runs post once; refused in closed/locked periods; closing a period with unrevalued balances needs `acknowledgeUnrevaluedFx`. The realised-FX engine (`settle`) is delivered and unit-tested.
* New API (flag `bookkeeping.core`): `exchange-rates` (list/create/import/get/supersede/verify), `fx-settings` (get/put), `periods/{id}/revaluation[/preview]`, `revaluation-runs` (list, reverse). New permission `fx:rate-manage` (owner/admin/partner/accountant).

## 3. Migration
`20260108000000_v1_fx_foundation` (additive; applied from scratch in CI and by the populated-database upgrade test as a non-superuser owner): tables `exchange_rate`, `company_fx_setting`, `fx_revaluation_run` (forced RLS; `DELETE`/`TRUNCATE` revoked; delete/truncate triggers; immutability triggers); `journal_line` gains `original_currency`, `original_debit`, `original_credit`, `rate`, `exchange_rate_id`, `adjusts_currency` with check constraints; `journal_line_insert_guard` extended; `ledger_policy.fx_block_unverified_rates`; trigger freezing `company.base_currency` after the first journal; role permission update; retention rows for the new tables (classification only - **no retention period is approved or enforced**).

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Role x capability: `fx:rate-manage` (8 roles) through the API and in the global RBAC matrix; settings need `ledger:policy`; revaluation needs `period:manage` | `tests/api/fx.test.ts`, `tests/api/permissions.test.ts` |
| The database defends conversion even if code is bypassed: exact `round(original x rate)`, half-up boundary, stored-rate match, no future rate, minor units of both currencies, side of the original amount, all-or-none, adjustment-line rules | `tests/db/fx.test.ts` (17) |
| Rates cannot be edited or deleted (runtime role and table owner); verified once, not withdrawn; superseded once; one current rate per key; tenant isolation | `tests/db/fx.test.ts`, `tests/db/privileges.test.ts` |
| Functional currency frozen after the first journal | `tests/db/fx.test.ts` |
| Single writers: only `fx.ts` writes rates and settings, only `revaluation.ts` writes runs, neither inserts a journal; platform/AI/worker cannot import the accounting package | `tests/unit/architecture.test.ts` |
| AI actors refused before anything is converted or stored; manual rates need `fx:rate-manage`; manual journals cannot use the reserved FX accounts or control accounts | `tests/platform/fx.test.ts` |
| Company scope and tenancy: another company's path gives 404, an outsider 404, another organisation sees zero rows | `tests/api/fx.test.ts`, `tests/db/fx.test.ts` |
| Audit: `fx.rate_created/superseded/verified`, `fx.rates_imported`, `fx.settings_changed`, `fx.revaluation_posted/reversed` with before/after and reasons | `tests/platform/fx.test.ts`, `tests/api/fx.test.ts` |

## 5. Test results for the new work
| File | Tests |
|---|---|
| `tests/unit/fx-math.test.ts` (conversion, rounding, settle, CSV parser, schemas; deterministic property-style checks) | 19 |
| `tests/db/fx.test.ts` | 17 |
| `tests/platform/fx.test.ts` (lookup, rates, rounding line, idempotency, reversal, import, revaluation, close controls, concurrency) | 31 |
| `tests/api/fx.test.ts` | 24 |
| `packages/contracts/src/ledger.test.ts` | +2 |
| Updated for the new behaviour: `tests/platform/posting-service.test.ts`, `tests/api/ledger.test.ts`, `tests/db/ledger.test.ts`, `tests/db/ledger-controls.test.ts`, `tests/db/privileges.test.ts`, `tests/api/permissions.test.ts`, `tests/api/regression.test.ts`, `tests/unit/architecture.test.ts` | |

## 6. Compliance-matrix changes (113 rows, plan version 2.3)
IMPLEMENTED 32 -> **39**, PARTIALLY IMPLEMENTED 12 -> **14**, MISSING 69 -> **60**. Implemented with evidence: V1-FX-01 (functional currency), -02 (transaction currency), -03 (rate source, date and lookup), -04 (original values), -05 (functional postings and rounding line), -06 (rounding rules), -08 (revaluation and auto-reversal), -10 (limitation now only for opening balances and control adjustments). **Partial on purpose:** V1-FX-07 (realised FX: the engine is tested but nothing can settle a foreign invoice until M5/M6) and V1-FX-09 (reconciliation and drill-down are proven; a dedicated FX gain/loss report is M8). No row added or removed; V0 documents untouched.

## 7. Findings and fixes during the milestone
* **Real defect found by the new tests and fixed:** the rule "manual journals cannot use the reserved FX accounts" also rejected the visible rounding line the service itself adds; only lines a person typed are checked now.
* **Design constraint found and recorded:** the AI/worker boundary (a test forbids the worker importing the accounting package) means a worker sweeper cannot post the auto-reversal as the specification sketched. It is posted at once when the next day is in an open period; otherwise it stays due, `POST revaluation-runs/{id}/reverse` posts it, and closing the period that contains its date is refused. Recorded in plan section 5.4 and ADR-56.
* The first full run had 2 failures, both in older tests: the "TRUNCATE is refused" assertions listed tables explicitly and the new `fx_revaluation_run` table also references `journal`. The tests now name it; no product code changed. No test was skipped, weakened to pass, or deleted. Test-design corrections made along the way (revaluation scenarios in their own company so unrelated currencies do not need closing rates; a due reversal blocks the period that contains its date, not the revalued one) reflect the design, not defects.
* The sandbox could not read gov.uk, legislation.gov.uk, frc.org.uk or bankofengland.co.uk, so the legal and rate-publisher sources behind this milestone were **not verified against primary texts**.

## 8. Known limitations
1. **No live rate adapters.** Rates arrive by manual entry or CSV file. Fetching the HMRC monthly or Bank of England series needs network access, each publisher's terms of use and a reviewer's check of the file formats - an explicit gate. The CSV layout (`from,to,valid_from,valid_to,rate`) is this platform's own, not a publisher format.
2. **The legal basis for converting amounts for VAT is unverified** (`docs/legal/m3-fx-sources.xlsx`, `m3-decision-brief.md`) and is an M4 matter for a qualified reviewer. The 7-day window and the monthly-rate handling are product policy (DEC-016), not a statement of what HMRC permits.
3. The list of monetary accounts is by subtype (`MONETARY_SUBTYPES`) and has not been reviewed by an accountant. Revaluation works per account and currency; per-document revaluation arrives with documents (M5/M6).
4. Realised FX is not yet exercised end to end (no settlement path before M5/M6). No hedge accounting, forwards, net investments or translation of foreign operations. Opening balances and control adjustments remain in the company currency.
5. API only (no screens); a due auto-reversal must be posted by a person when the next period was not yet open. Posting is still serialised per company and balances are computed on demand (untested at real volume - a production gate).
6. Privacy finding DEC-013 remains **unresolved**; retention periods and lawful basis remain unapproved (DEC-003, DEC-014); S3, S7 and S4(b) remain deferred/frozen. Production gates are unchanged: privacy/retention review, security review, AWS apply and verification, real-volume performance, live-source terms and format checks.

## 9. Decisions needed from the product owner before M4
1. Accept M3 (or list changes), including: a rate is verified by someone other than its enterer; the auto-reversal is posted on request when the next period is not yet open (no worker sweeper); FX accounts are designated per company, not by a column on the chart.
2. M4 (contact roles and VAT foundation) has an **external gate**: the named qualified reviewer who verifies the HMRC/VAT rules and sources, and the verification record format (v1-plan.md section 7 item 4). M4's contact-roles half (DEC-011) has no such gate; say whether to build it first and defer the VAT half until the reviewer is named, or to wait and build M4 as one milestone.
3. Whether to allow network access to `www.gov.uk`, `www.legislation.gov.uk`, `www.frc.org.uk` and `www.bankofengland.co.uk` so that the primary sources can be read here, or to have the reviewer verify them elsewhere.
