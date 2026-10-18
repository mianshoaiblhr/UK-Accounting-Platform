# V2 milestone V2-M1 - acceptance package (reporting framework as data)

Prepared under the product owner's delegation (DEC-019, DEC-051; decisions DEC-052..055). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, and so is every standard used in the tests. **No real FRS 102 or FRS 105 content was entered or verified** (DEC-052): until the firm names its qualified accountant and they verify a version, every statutory output is a preview.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `ae8e667` (code), `fd0f556` (CI fix to two tests, workings workbook) on branch `claude/adoring-cori-mra6ze`; specification recorded before code in `7718669` (v2-plan section 3) and DEC-055 in this commit |
| CI | **success**: run 39083312122 on `fd0f556` (migrations from scratch, terraform validate, S3/ClamAV, build/lint/typecheck/unit/integration/e2e, audit and secret scan, all images). The first run (39082469673 on `ae8e667`) failed two tests that sorted role permissions in SQL: CI's glibc collation orders `accounts:rule-verify` after `accounts:rules-manage`. The roles were correct; the tests now sort with the C collation |
| CodeQL | **success**: run 39083312143 on `fd0f556` |
| Clean clone of `fd0f556` | install, build, typecheck, lint: exit 0; **1977 tests passed** (104 files); e2e **21/21**; OpenAPI drift 0 |
| Local runs | unit + integration 1977 passed; the V2-M1 files (statutory API, framework DB, grammar unit, architecture, permissions) 574 passed after the last edits; typecheck and lint clean. Golden workings recomputed independently in `docs/architecture/v2-m1-golden-workings.xlsx` (generator `scripts/docs/gen_v2_golden_workbook.py`): 0 differences |

## 2. What V2-M1 delivers (v2-plan section 3)
| Part | What it is | Where |
|---|---|---|
| Standards and versions | An organisation's standards (code, name) and their effective-dated versions with source URL, instrument and paragraph, retrieval date, author and status UNVERIFIED / VERIFIED / SUPERSEDED; current versions of a standard never overlap | `reporting_standard`, `reporting_standard_version`; `StandardsService` |
| Version content | Statement lines (fed by accounts on a natural side, a signed total of other lines, or the retained profit); the map from V1 reporting lines, optionally narrowed by account subtype; validation rules in the closed grammar; disclosure rules (stored and shape-checked; rendered in V2-M5) | `statutory_line`, `statutory_map_entry`, `validation_rule`, `disclosure_rule` |
| Verification (DEC-052) | A holder of `accounts:rule-verify` other than the author verifies a consistent version (lines exist, totals and parents have no cycle, map entries and overrides land on accounts lines, every rule and note refers to lines of the version); the version and its content are then immutable; a change supersedes it with an unverified copy | service and database |
| Company framework | Per financial year: the version (in effect on the year start, not superseded) and the entity size, with a reason; years never overlap; a locked year never changes (locking arrives in V2-M6) | `company_reporting_framework`; `FrameworkService` |
| Account overrides | One account placed on an accounts line of a version for one company, with a reason; ended, never edited or deleted | `statutory_account_override` |
| Statutory preview | P&L for the year and balance sheet at its end from journal lines through the map and overrides; the prior year on the same version; each line's accounts with drill-down; unplaced accounts; validation results for the entity size; proofs (P&L lines against the ledger's profit, the balance sheet netting to zero, the trial balance); `verified` and a PREVIEW ONLY notice when the version is not verified | `StatutoryReportService.preview` |
| Expression grammar | `line`, `const`, `add`, `sub`, `neg`, `eq/ge/le/gt/lt` with tolerance, `and`, `or`; exact decimals at ledger scale; checked when written; evaluated by a small interpreter, never by code evaluation | `packages/contracts/src/statutory.ts`, `packages/accounting/src/statutory-report.ts` |
| API | 26 operations under `/organisations/{org}/companies/{company}/` (`reporting-standards`, `reporting-standard-versions/...`, `reporting-frameworks`, `statutory-overrides`, `statutory-preview`), all in OpenAPI, behind the new flag `accounts.production` (default off) | `apps/api/src/accounts/standards.controller.ts` |

**Migration:** `20260119000000_v2_reporting_framework` (additive): 8 tables, forced row-level security, DELETE and TRUNCATE revoked from the runtime role (and UPDATE on `reporting_standard`), guard triggers, the three permissions added to the system roles, retention classification `ACCOUNTING_RECORDS` for each table.

## 3. Golden trial balance (DEC-054)
`tests/golden/v2-m1-micro-synthetic.json`. The postings, the synthetic layouts and the expected figures were written by hand before the code was run against them.
* A synthetic micro-entity with two financial years (2025, 2026): 24 postings through the public API (cash receipts and payments, manual journals: share capital, a bank loan and its repayment, sales, purchases, closing stock, rent with a prepayment, depreciation, accrued interest, corporation tax, costs paid by a director).
* **Layout 1** (shaped like a micro-entity layout, not FRS 105): 2026 profit 13,180.00 and net assets 21,080.00 = capital and reserves; 2025 comparative 7,800.00 and 7,900.00. Every line matched to the cent, with the comparative, statement order and nesting, the accounts on each line and the drill-down ranges.
* **Layout 2** (gross profit, operating profit, net interest; debtors with prepayments, creditors with accruals): the same ledger gives its own hand-calculated statements (gross profit 20,500.00, operating profit 15,380.00, net interest -200.00, profit 13,180.00, net assets 21,080.00) once the year switches to it. No code changed.
* **Override:** grant income (4100) moved from other income to turnover for this company: turnover 31,200.00, other income 50.00, profit unchanged; audited with its reason; ending it restores the map.
* **Broken map:** a superseding (unverified) version without the map entry for creditors due after one year. The bank loan (-8,000.00) is listed as unmapped, with -10,000.00 in the comparative. Net assets become 29,080.00 against capital and reserves of 21,080.00, so the ERROR rule "net assets = capital and reserves" fails. The balance-sheet proof shows a difference of 8,000.00, and the preview is marked unverified.
* **Earlier year unchanged:** after a later version replaced the one 2025 was prepared under, the 2025 preview still comes from the 2025 version (SUPERSEDED, still verified), with the same figures (net assets 7,900.00, profit 7,800.00).
* **Correction recorded:** on the first run, one hand figure disagreed with the engine: the broken-map net assets were written as 29,330.00. The hand calculation had left out the accruals line. The figure was recalculated by hand as 29,080.00, and the correction is noted in the golden file. Every other figure matched on the first run.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| The author cannot verify (service 403 `self_verification_not_allowed`; database CHECK `verified_by_user_id <> created_by_user_id`) | `tests/api/statutory.test.ts`, `tests/db/reporting-framework.test.ts` |
| A partner (holds `accounts:rules-manage`, not `accounts:rule-verify`) cannot verify; owner and admin can | `tests/api/statutory.test.ts`, RBAC matrix in `tests/api/permissions.test.ts`, system roles in `tests/db/reporting-framework.test.ts` |
| A verified version and its lines, map and rules cannot change: service 409 `version_not_editable`; database trigger even for the runtime role bypassing the service | both files above |
| Every route refuses without its permission (`accounts:rules-manage`, `accounts:rule-verify`, `accounts:prepare`, `ledger:read`); a client viewer reads nothing; another organisation sees nothing (404, forced RLS) | `tests/api/statutory.test.ts`, `tests/api/permissions.test.ts`, `tests/db/reporting-framework.test.ts` |
| The routes are behind `accounts.production` (403 `feature_disabled` when off) | `tests/api/statutory.test.ts` |
| No deletes: lines, entries and rules are removed by a flag while unverified; overrides are ended; DELETE and TRUNCATE are revoked | `tests/db/privileges.test.ts`, `tests/db/reporting-framework.test.ts` |
| The statutory report service reads ledger and framework tables only and writes nothing. Only the two framework services touch the framework tables, and nothing evaluates code | `tests/unit/architecture.test.ts` |
| Every new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts`, `docs/architecture/security-architecture.md` |

## 5. Compliance matrix
V2 matrix v1.1 (60 rows: Implemented 7, Partially 2, Missing 51).
* **Missing -> Implemented:** V2-ARC-01, V2-ARC-02, V2-ARC-03, MAN-ACC-09, V2-MOD-02, V2-MOD-11, V2-OUT-06.
* **Missing -> Partially:**
  * V2-ARC-04: the filing-ready refusal of unverified rules belongs to V2-M6.
  * V2-TEST-01: further scenarios come in V2-M2..M5, and the named accountant still has to review them.
* **MAN-ACC-09 (V1 matrix):** decided in DEC-051 and built here. The V1 matrix row stays as recorded in V1, with this package as the evidence that V2 carried it.

## 6. Known limitations and gates
1. **No real standard exists in the system:** the firm enters FRS 105 / FRS 102 versions from the current texts and its named accountant verifies them. Until then every preview says PREVIEW ONLY. The golden files prove the engine, not the standard (DEC-054).
2. Disclosure rules are stored and shape-checked only. The entity size is chosen, not computed from thresholds (the size test is V2-M5). There is no cash flow statement yet (V2-M5, full FRS 102 only).
3. Retained profit is the P&L of every year to the year end until the closing journal of V2-M3 exists. A V1 account mapped to the reserves line is presented separately from it.
4. Standards are organisation-wide and are authored through any company the author holds `accounts:rules-manage` for. This follows the VAT-code pattern (V1-M4b).
5. Two people changing the dates of versions of the same standard at the same instant could both pass the overlap check (the same trigger pattern as VAT rates). This is acceptable at the expected volume, and it is listed for the security review.
6. Values are exact to 20 significant digits: rule constants are limited to the ledger's scale (15 integer digits, 4 decimals).
7. No screens yet (V2-M7).
8. **Named accountant:** Shoaib (DEC-056, recorded 2026-10-18). Naming verifies nothing: each real standard version stays UNVERIFIED until Shoaib reviews the golden outputs and verifies it in the platform, under an account that holds `accounts:rule-verify`, and must not be the version's author.
9. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
