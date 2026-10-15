# V1 milestone M8 - acceptance package (statements, drill-down, alerts, close controls, FX report)

Prepared under the product owner's delegation (DEC-019, DEC-043..045). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including the 12.5% VAT rate and the exchange rates.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `b1e69af` (branch `claude/adoring-cori-mra6ze`) = M8 code `08f226c` + a test-typing fix; decisions recorded before code in `3b5af9b` |
| CI on `08f226c` | **failed** at `pnpm typecheck` (run 38816514884): the new report tests read `accounts` on a union of statement-line types (vitest does not typecheck). Reproduced locally, fixed in the tests only (`b1e69af`), no product code changed |
| CI | **success**: run 38817306319 on `b1e69af` (migrations from scratch, terraform validate, S3/ClamAV, build/lint/typecheck/unit/integration/e2e, audit and secret scan, all images) |
| CodeQL | **success**: run 38817306283 on `b1e69af` |
| Clean clone of `b1e69af` | install, build, typecheck, lint: exit 0; **1864 tests passed**; e2e **4/4**; OpenAPI drift 0 |
| Local full run | `pnpm test` **98 files, 1864 tests passed, 0 failed, 0 skipped** (M7b: 95 / 1853), run alone |

## 2. What M8 delivers (DEC-043..045; plan section 12)
* **Profit and loss** for any range with a comparative range, and **balance sheet** as at any date with a comparative date, computed from journal lines only through the versioned reporting mapping. Each statement returns its proof: the P&L equals income less expenses from the ledger; net assets equal capital and reserves and the trial balance balances, to the cent. Capital and reserves include the P&L cumulated to the date, shown as brought forward and year to date.
* **Drill-down everywhere:** every line lists its accounts with general-ledger parameters; every journal opens its source transaction through one resolver per journal source (21 sources) and from there its attached documents and bank matches. A reader without the module's permission sees that a source exists, not its content.
* **Alert list** as at a date: suspense balance, negative cash, overdrawn bank, sales and purchase drafts older than a threshold, statement lines unmatched for longer than a threshold, journal requests awaiting approval, unverified VAT rate versions, supplier bank details awaiting verification, payments made while they were unverified. Each alert is shown only to readers of its module, sorted by severity.
* **Close and lock controls:** closing a period with unreconciled bank lines dated in it needs `acknowledgeUnreconciledBank`; locking with a suspense balance needs `acknowledgeSuspenseBalance` and a reason. Both are recorded with their figures.
* **FX report:** realised and unrealised exchange differences for a range by currency with drillable journals; open foreign-currency balances against the closing rate with the difference a revaluation would post.
* **API:** 5 routes, all in OpenAPI (273 operations in total).
* **No migration**: M8 reads what M1-M7 record.

## 3. Security and permission checks
| Check | Evidence |
|---|---|
| Statements, drill-down, FX report and alerts need `ledger:read`; client viewers are refused; another organisation gets 404; malformed ranges are 422 | `tests/api/reports.test.ts` |
| Alerts and drill-down respect module permissions (sales drafts need `sales:read`, bank lines `bank:read`; a sales document behind a journal is "restricted" without `sales:read`) | `tests/platform/reports.test.ts` |
| Statements read the ledger only and write nothing | `tests/unit/architecture.test.ts` |
| Every journal source has a drill-down resolver | `tests/unit/drilldown.test.ts` |

## 4. Hand-calculated evidence (`tests/platform/reports.test.ts`)
* **Report Co, 2026 with 2025 alongside:**
  * P&L: turnover 3,000.00 (400.00); cost of sales 300.00; gross profit 2,700.00 (400.00); administrative expenses 1,025.00 = 800.00 + 200.00 + 25.00; operating profit 1,675.00; interest receivable 10.00; profit 1,685.00 (400.00); reconciled to the ledger.
  * Balance sheet at 31 December 2026 (2025): debtors 1,287.50 = 1,125.00 + VAT recoverable 162.50; cash 2,447.50 = bank 2,347.50 + petty cash 100.00 (1,450.00); creditors 650.00 = 225.00 + VAT 425.00 (50.00); net assets 3,085.00 (1,400.00) = share capital 1,000.00 + P&L brought forward 400.00 + year to date 1,685.00.
  * Drill-down from every journal to its source: bank transfer, cash payment and receipt, purchase bill and payment, sales invoice and receipt.
* **FX Co:** realised gain 30.00 on EUR 600 received at 0.90 against 0.85; open balances at 0.80: receivable EUR 400 (340.00 -> 320.00, -20.00) and bank EUR 600 (540.00 -> 480.00, -60.00); after the revaluation unrealised -80.00 and nothing left unrevalued; with the next-day reversal the range shows 0.00; the P&L shows 850.00 - 50.00 = 800.00 and reconciles.
* **Alerts Co:** suspense -50.00, cash -20.00, a draft from 5 February, an unmatched line from 2 February; a narrower reader sees two of the four; at 10 February the draft is not yet old. Closing is refused for one unreconciled line and accepted with the acknowledgement; locking is refused for the suspense balance and accepted with the acknowledgement and a reason, recorded as -50.0000.

## 5. Compliance matrix (v3.3; 113 rows: Implemented 96, Partially 13, Missing 4)
* **Now Implemented:** V1-MOD-16, V1-MOD-17, V1-ARC-02, V1-RPT-01, V1-RPT-02, MAN-ACC-06, MAN-ACC-07, XP-01, V1-CTL-05, MAN-ACC-08, V1-FX-09.
* **Partially:** V1-CTL-03 (the dashboard screen is M9); evidence extended on V1-CTL-04 and V1-BANK-05.
* **Correction:** V1-MOD-03 (suppliers) marked implemented; it was delivered by M4a (`206b14d`) and its row had not been updated. No code changed for it.

## 6. Known limitations and gates
1. **Management accounts, not statutory accounts:** exact amounts, no rounding, notes or FRS 102/105 layout, no year-end closing journal (V2).
2. **Screens** for statements, drill-down and the dashboard are M9.
3. **Performance:** statements and alerts aggregate journal lines on each request; untested at real volume.
4. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
