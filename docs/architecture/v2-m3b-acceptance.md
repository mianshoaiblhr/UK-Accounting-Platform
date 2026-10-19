# V2 milestone V2-M3b - acceptance package (year-end closing journal)

Prepared under the product owner's delegation (DEC-019, DEC-051). The design (DEC-060) and the golden figures were recorded before the code. This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@SHA@@ (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5b and DEC-060 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M3b delivers (v2-plan section 5b)
| Part | What it is |
|---|---|
| The close | For a financial year [start, end], one journal dated the year end (YEAR_END_CLOSE). It reverses each income and expense account's net for the year, in account-code order, and puts the difference (the year's profit, or a loss) on the retained-earnings account last.<br>The year must:<ul><li>start on the first day of an accounting period and end on the last day of one;</li><li>be covered by periods without a gap;</li><li>be at most 18 months long;</li><li>not overlap a live close;</li><li>have something to close.</li></ul>The preview lists every reason a close cannot post, and warns when earlier income or expense is not covered by a live close |
| The closed year | While a close is live, nothing posts income or expense dated in its year (`year_closed`), including journal requests at request time.<ul><li>The PostingService refuses it.</li><li>The database refuses it again on `journal_line`, even when the service is bypassed.</li><li>A shared/exclusive advisory lock orders every posting against a close: a posting either lands before the close reads the year's balances or is refused after it.</li></ul> |
| Correction | A close is reversed only by its mirror (YEAR_END_CLOSE_REVERSAL), dated the year end, with a reason; the year then takes income and expense again and can be closed again. The ledger's REVERSAL refuses both sources (`subledger_journal`) |
| Statements | Closing journals are left out of every P&L figure:<ul><li>the management P&L and its reconciliation to the ledger;</li><li>the balance sheet's profit for the year to date and brought forward;</li><li>the statutory preview;</li><li>the FX report's exchange differences.</li></ul>The balance sheet's lines leave them out too, so the statements read the same before and after a close. The trial balance, and the balance sheet's trial-balance proof, take the whole ledger. The balance sheet reports `closedToRetainedEarnings` |
| Drill-down | The general ledger takes `excludeClosing=true`, which leaves closing journals out of the opening balance, the lines and the running balance. Every P&L drill-down carries it, so the ledger it opens adds up to the figure. The web ledger screen passes it on and says so. The journal drill-down resolves both sources to their close |
| API | 5 operations (`year-end-closes`: list, preview, close, get, reverse) and the general-ledger parameter, all in OpenAPI and behind `accounts.production`. Writes need `accounts:prepare`; reads need `ledger:read` |

**Journal sources:** YEAR_END_CLOSE and YEAR_END_CLOSE_REVERSAL.
* Both are `subLedger`, reach only the RETAINED_EARNINGS control account, and carry no VAT.
* Each has its five posting-rule categories in `tests/rules/posting-rules.ts`.
* The shared test that no other sub-ledger source reaches retained earnings still covers the other 31.

**Migration:** `20260122000000_v2_year_end_close` (additive):
* one table, `year_end_close`;
* forced row-level security, with DELETE and TRUNCATE revoked;
* a guard trigger: at most 18 months, the retained-earnings account, no overlapping live close, immutable facts, POSTED -> REVERSED once;
* the closed-year trigger on `journal_line`;
* retention category ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m3b-close.json` was written and added up by hand before the code. `docs/architecture/v2-m3b-golden-workings.xlsx` recomputes all 152 figures independently in Python, with 0 differences.
* **Data:** two years of manual postings, and a 400.00 V2-M3a accrual at 31.12.2026 that is auto-reversed into 2027.
* **Closes:**
  * 2025: profit 4,500.00 (12,000.00 - 7,500.00).
  * 2026: profit 8,265.44 (12,000.00 - 3,734.56), closing five accounts.
  * The 2026 preview warns until 2025 is closed.
* **Before and after the closes:** exactly the same figures.
  * P&L for 2026: profit 8,265.44.
  * P&L for 1.1.2025-30.6.2027: profit 14,165.44.
  * Balance sheet at 31.12.2025: net assets 9,500.00.
  * Balance sheet at 31.12.2026: net assets 17,765.44 (brought forward 4,500.00, year 8,265.44).
  * Balance sheet at 30.6.2027: net assets 19,165.44 (brought forward 12,765.44, year 1,400.00).
  * Only the trial balance changes: 29,400.00 before, 18,165.44 after, with retained earnings at 12,765.44.
* **General ledger for 4000 in 2026:** the close nets it to 0.00. With `excludeClosing` it opens at 12,000.00 and runs to 21,000.00.
* **The closed year:** an expense dated 20.12.2026 is refused (`year_closed`), and closing 2026 again is refused (`year_already_closed`).
* **Reopening 2026:** the close is reversed by its mirror and the late 50.00 expense posts. The re-close comes to 8,215.44. The balance sheet at 31.12.2026 then shows net assets 17,715.44 and 12,715.44 closed to retained earnings.
* **Statutory preview (V2-M1 golden company):** identical before and after closing both years, and after reversing them. The one exception is the trial-balance proof, which takes the whole ledger and still balances.
* **Hand figures:** every figure in the golden file matched on the first run. Three expectations in the tests were mine and wrong; in each case the engine was right and the test was corrected:
  1. The balance sheet's trial-balance proof changes with a close, as DEC-060 says. I had compared it as unchanged.
  2. A preview of a year overlapping a live close still finds balances, namely the close's own lines. So "nothing to close" does not apply there.
  3. An outsider gets 404, not 403, as everywhere else in the API.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Writes need `accounts:prepare` (bookkeepers and reviewers get 403); reads need `ledger:read`; another organisation gets 404 or sees nothing; an AI actor and a person without the permission are refused | `tests/api/year-end-close.test.ts`, `tests/platform/year-end-close.test.ts`, `tests/db/year-end-close.test.ts` |
| A closed year refuses income and expense, in the service and in the database even when the PostingService is bypassed; balance-sheet postings still post | `tests/platform/year-end-close.test.ts`, `tests/db/year-end-close.test.ts` |
| A close is never edited or deleted; it is reversed once; overlapping and over-long years, and any account but retained earnings, are refused by the database | `tests/db/year-end-close.test.ts`, `tests/db/privileges.test.ts` |
| A closing source reaches no control account but retained earnings and carries no VAT; a closed or locked period refuses a close and its reversal, and nothing is written | `tests/platform/year-end-close.test.ts` |
| Only the close service writes `year_end_close` and posts the closing sources; every statement and the PostingService name the closing sources | `tests/unit/architecture.test.ts` |
| The new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v1.5 (61 rows: Implemented 22, Partially 2, Missing 37). One row moved from Missing to Implemented: V2-YEC-01.

## 6. Known limitations
1. **Year to date:** the balance sheet's "profit for the financial year to date" starts at the accounting period that contains the date (V1 rule, unchanged). A company with monthly periods sees the month to date. Using the reporting-framework year is left to V2-M5.
2. **Earlier years:** they are not closed automatically. The preview only warns about them.
3. **Not covered:** dividends, transfers between reserves and tax on profit (V2-M4/M5), and closing automatically when a period is locked.
4. **Concurrency:** the lock order between a close and concurrent postings is by design (shared and exclusive advisory locks). It is backed by the database trigger. No test runs two transactions racing.
5. **Production gates unchanged:**
   * standard versions verified by Shoaib (DEC-056);
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
