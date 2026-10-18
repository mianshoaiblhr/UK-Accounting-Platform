# V2 milestone V2-M2 - acceptance package (fixed assets and depreciation)

Prepared under the product owner's delegation (DEC-019, DEC-051), with the design in DEC-058 recorded before code. This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. Lives, rates and conventions in the tests are test choices, not policy advice: each firm sets its own accounting policies (FRS 102 s.17, FRS 105 s.12).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@SHA@@ (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 4 and DEC-058 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M2 delivers (v2-plan section 4)
| Part | What it is | Where |
|---|---|---|
| Classes | Four non-control accounts of the right kind (cost, accumulated depreciation, depreciation expense, disposal), and defaults for new assets (method, life or rate, residual %, convention). The code and accounts never move | `fixed_asset_class`; database trigger |
| Additions | POSTED: Dr cost / Cr a non-control offset (FIXED_ASSET_ADDITION). LINKED: to the supplier bill, cash payment or journal that already carries the cost; over-linking is refused. TAKE_ON: with accumulated depreciation at a take-on date | `FixedAssetService.addAsset` |
| Depreciation | Straight line or reducing balance, under a DAILY or MONTHLY convention. Exact decimals; each charge is the cumulative amount due less what was already charged | `depreciation-math.ts` |
| Changes of estimate | Prospective, from the day after the last charge, at the carrying amount then. Bases are append-only | `fixed_asset_basis` |
| Runs | One journal per run, with a pair of lines per class and one line per asset. Each run is later than every live run; only the latest live run is reversed, by its mirror. A preview posts nothing | `DepreciationService` |
| Disposals | Catch-up to the disposal date; cost and accumulated depreciation removed; carrying amount and proceeds on the disposal account; gain or loss recorded. Reversed by its mirror while no later run is live | `FixedAssetService.dispose` |
| Tax kept apart | Tax category and tax cost, stored for V4; depreciation never reads them | architecture test |
| Register and reconciliation | By class at a date. Per account, the register is set against the ledger, with every posting the register neither made nor linked listed as a reconciling item | `FixedAssetService.register` |
| API | 17 operations under `/organisations/{org}/companies/{company}/` (`fixed-asset-classes`, `fixed-assets/...`, `fixed-asset-register`, `depreciation-runs/...`), all in OpenAPI, behind `accounts.production` | `apps/api/src/accounts/fixed-assets.controller.ts` |

**Journal sources (contracts):** FIXED_ASSET_ADDITION, FIXED_ASSET_ADDITION_REVERSAL, FIXED_ASSET_DEPRECIATION, FIXED_ASSET_DEPRECIATION_REVERSAL, FIXED_ASSET_DISPOSAL and FIXED_ASSET_DISPOSAL_REVERSAL. All are `subLedger` (the ledger's REVERSAL refuses them), never touch a control account, carry no VAT, and need `assets:manage`. Each has its five posting-rule categories in `tests/rules/posting-rules.ts`.

**Migration:** `20260120000000_v2_fixed_assets` (additive): 5 tables; forced row-level security; DELETE and TRUNCATE revoked, and UPDATE also revoked on the bases and the run lines; guard triggers; `assets:read` and `assets:manage` added to the system roles; retention classification ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m2-fixed-assets.json`, written and added up by hand before the code; `docs/architecture/v2-m2-golden-workings.xlsx` recomputes all 37 figures independently in Python, with 0 differences.
* **Classes:** OFFICE (straight line, 36 months, monthly) and MOTOR (reducing balance 25%, daily).
* **Assets:**
  * Printer: linked to its cash payment, 24 months daily.
  * Furniture: taken on with 2,000.00 depreciated and 30 months remaining, residual 500.00.
  * Laptops: linked to their cash payment.
  * Van: 12,000.00 posted against the director's loan account, residual 1,000.00.
* **Runs:**
  * 31.12.2025: 1,200.00.
  * 30.6.2026: 900.00.
  * 31.12.2026: 2,612.33, including the van's 1,512.33 (12,000 × 25% × 184/365).
  * 31.1.2027 after the change of estimate: 538.12.
* **Disposal of the printer on 30.6.2026 for 1,000.00:** catch-up 595.07 (2,400 × 546/730 = 1,795.07, less the 1,200.00 already charged), carrying amount 604.93, gain 395.07. The journal was matched line by line.
* **Register at 31.12.2026:** reconciles to the ledger on all four accounts (0030 8,600.00; 0031 4,000.00; 0040 12,000.00; 0041 1,512.33). Depreciation expense is 1,200.00 for 2025 and 4,107.40 for 2026.
* **Change of estimate:** the laptops' remaining life becomes 13 months from 1.1.2027, at a carrying amount of 2,600.00, so the next run charges 200.00 a month.
* **Two of my hand figures were wrong on the first run, both in tests outside the golden file.** The engine was right both times; I recalculated the figures by hand and corrected the tests:
  * Platform test: a chair added after the March run had never been charged, so the catch-up is 300.00, not 100.00.
  * Unit test: a 36-month life from 1.1.2026 runs 1,096 days because 2028 is a leap year, not 1,095.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| `assets:read` reads; `assets:manage` changes. Owner, admin, partner, manager and accountant manage; bookkeeper and reviewer read; a client viewer gets 403; another organisation gets 404 or sees nothing | `tests/api/fixed-assets.test.ts`, `tests/api/permissions.test.ts`, `tests/db/fixed-assets.test.ts` |
| An AI actor cannot post; a person without the permission cannot | `tests/platform/fixed-assets.test.ts` |
| No control account in a class, an offset or proceeds (service 422 and database trigger) | the three test files above |
| Acquisition facts immutable; a disposal never edited; VOID final; bases append-only; runs never edited; only the latest live run reversible (database, even bypassing the service) | `tests/db/fixed-assets.test.ts` |
| The ledger cannot reverse a register journal (`subledger_journal`) | `tests/api/fixed-assets.test.ts`, `tests/platform/fixed-assets.test.ts` |
| A closed period refuses additions, runs, disposals and the reversal of each; nothing is written | `tests/platform/fixed-assets.test.ts` |
| Only the asset services write the asset tables and post the asset sources; depreciation never reads the tax fields | `tests/unit/architecture.test.ts` |
| Every new table is classified, documented, given a retention category and has least privilege | `tests/db/classification.test.ts`, `tests/db/retention.test.ts`, `tests/db/privileges.test.ts` |

## 5. Compliance matrix
V2 matrix v1.3 (60 rows: Implemented 17, Partially 2, Missing 41).
* **Missing -> Implemented:** V2-MOD-03, V2-MOD-04, V2-FA-01..08.
* **Recorded:** DEC-057, Shoaib's review of the V2-M1 golden workings. It does not change any row's status: V2-TEST-01 stays Partially until the later scenarios are reviewed too.

## 6. Known limitations
1. Only full disposals: no part disposals, revaluation or impairment (the FRS 102 options; FRS 105 forbids revaluation), components, or transfers between classes.
2. Proceeds already recorded on the disposal account by the cash module are given as an amount without an account: they are counted in the gain or loss, not posted twice. Bank and payables movements stay in their own modules.
3. The fixed-asset accounts are not control accounts, so a manual journal can still post to them. The register's reconciliation lists every such posting as a reconciling item instead of refusing it.
4. Two runs started at the same moment are serialised by an advisory lock; the database also enforces one live run per date.
5. The monthly convention charges a full month in the month an asset comes into use. Under it, a disposal in a month that a run has already charged keeps that charge, so the catch-up is never negative.
6. Capital allowances are V4; the tax fields are stored only. There are no screens yet (V2-M7).
7. **Production gates unchanged:** standard versions verified by Shoaib (DEC-056), qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
