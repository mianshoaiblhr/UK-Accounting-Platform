# V2 milestone V2-M3a - acceptance package (year-end adjustments)

Prepared under the product owner's delegation (DEC-019, DEC-051), with the split and the design in DEC-059 recorded before code. This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. The amounts, service periods and the provision's basis in the tests are test choices, not estimates for any business (FRS 102 s.21 requires the best estimate of the obligation).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `f7351495085990bb736be8d2408f4d0587691ccc` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5 and DEC-059 |
| CI | [run 39178258465](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39178258465): every job green |
| CodeQL | [run 39178258477](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39178258477): green |
| Clean clone | Fresh clone at f735149: install, build, typecheck and lint clean; 2,091 tests passed; e2e 21/21; OpenAPI drift 0 |
| Local runs | Build, typecheck and lint clean; 111 test files, 2,091 tests passed (before the push) |

## 2. What V2-M3a delivers (v2-plan section 5)
| Part | What it is |
|---|---|
| Accruals and accrued income | Posted at the date (ACCRUAL) together with the reversal on the next day (ACCRUAL_AUTO_REVERSAL), which must fall in an open period. Evidence documents are linked to the item. A wrong item is cancelled by mirrors of both journals at their own dates (ACCRUAL_CANCELLATION) |
| Prepayments and deferred income | Set up from the P&L account (ADJUSTMENT_SETUP) or linked to the payment or receipt that already carries the amount (never over-linked). Released straight line by day or by month through release runs (ADJUSTMENT_RELEASE): each run is later than every live run, the latest is reversed by its mirror, and each release is the cumulative amount due less what was released, rounded once. A schedule nothing has been released from is cancelled by the mirror of its set-up |
| Provisions (FRS 102 s.21) | Accounts and basis recorded once. Movements (PROVISION_MOVEMENT) are made, used against the account the actual cost went to, or released; they are dated in order and never take the balance below zero; the latest is reversed by its mirror. The movement report gives opening, made, used, released and closing for any date range |
| Register and reconciliation | Items and provisions standing at a date. Per balance account, the register is set against the ledger, and postings the register neither made nor linked are listed as reconciling items |
| API | 16 operations (`year-end-items`, `release-runs`, `provisions`, `provision-movements`, `year-end-register`), all in OpenAPI, behind `accounts.production`. Writes need `accounts:prepare`, reads `ledger:read` |

**Journal sources:** nine, all `subLedger` (the ledger's REVERSAL refuses them). None touches a control account or carries VAT, and each has its five posting-rule categories in `tests/rules/posting-rules.ts`. Every one is resolved by the journal drill-down.

**Migration:** `20260121000000_v2_year_end_adjustments` (additive): 5 tables; forced row-level security; DELETE and TRUNCATE revoked, and UPDATE also revoked on run lines and provisions; guard triggers; retention ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m3a-adjustments.json`, written and added up by hand before the code. `docs/architecture/v2-m3a-golden-workings.xlsx` recomputes all 51 figures independently in Python, with 0 differences.
* **Accruals at 31.12.2026, reversed on 1.1.2027:** electricity 450.00 and accrued interest 120.00.
* **Prepayments and deferred income:**
  * Insurance 1,200.00 for 1.10.2026-30.9.2027: set up from the expense account, released monthly.
  * Software 730.00 for 1.11.2026-31.10.2027: linked to its payment, released daily.
  * Support contract income 2,400.00 for 1.7.2026-30.6.2027: deferred, released monthly.
* **Release runs:**
  * 31.12.2026: 1,622.00 (300.00 + 122.00, from 730 × 61/365, + 1,200.00).
  * 31.3.2027: 1,080.00 (300.00 + 180.00 + 600.00).
* **Provision:** 800.00 made at 31.12.2026, 300.00 used and 100.00 released in 2027, leaving 400.00. Movement report for Q1 2027: opening 800.00, used 300.00, released 100.00, closing 400.00.
* **Reconciliation to the ledger:** on all five balance accounts at both dates. At 31.12.2026: 1110 120.00, 1120 1,508.00, 2110 450.00, 2150 1,200.00, 2160 800.00. At 31.3.2027: 0.00, 1,028.00, 0.00, 600.00, 400.00. The P&L effect per account matches for 2026 and for Q1 2027.
* **Hand figures in the golden file:** all matched on the first run. Two expectations in the platform test were mine and wrong: a mirror keeps the original line order, and a company with later runs refuses an earlier run before reaching the period check. Both were corrected in the test; the engine was right.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Writes need `accounts:prepare`; reads need `ledger:read`. A client viewer gets 403; another organisation gets 404 or sees nothing; an AI actor and a person without the permission are refused | `tests/api/year-end.test.ts`, `tests/platform/year-end.test.ts`, `tests/db/year-end.test.ts` |
| Accounts suit the kind and are never control accounts (service 422 and database trigger) | the three files above |
| Items, runs and movements are never edited; provisions and run lines are written once; only the latest run or movement is reversed; a provision never goes below zero; nothing is deleted (database, even bypassing the service) | `tests/db/year-end.test.ts`, `tests/db/privileges.test.ts` |
| The ledger cannot reverse a year-end journal (`subledger_journal`); a closed period refuses every year-end posting and its reversal, and nothing is written | `tests/platform/year-end.test.ts`, `tests/api/year-end.test.ts` |
| Only the year-end service writes these tables and posts these sources | `tests/unit/architecture.test.ts` |
| Every new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v1.4 (61 rows: Implemented 21, Partially 2, Missing 38).
* **Missing -> Implemented:** V2-MOD-05, V2-MOD-06, V2-MOD-07, V2-MOD-08.
* **Row added: V2-YEC-01**, the year-end closing journal. It was in the approved V2-M3 scope (v2-proposal section 4) but had no matrix row, and is built in V2-M3b. The addition is recorded in the matrix history.

## 6. Known limitations
1. Accruals always reverse on the next day. Accruals that do not reverse, and releases by usage or milestone rather than time, are not covered.
2. Provisions are not discounted (FRS 102 s.21.7). Contingent liabilities and assets are disclosures (V2-M5).
3. The balance accounts are not control accounts, so other postings can reach them. The reconciliation lists such postings rather than refusing them.
4. The year-end closing journal is V2-M3b. Until then, retained profit in statements is still the P&L cumulated to the date.
5. **Production gates unchanged:** standard versions verified by Shoaib (DEC-056), qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
