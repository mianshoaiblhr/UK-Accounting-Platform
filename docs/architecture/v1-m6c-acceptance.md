# V1 milestone M6c - acceptance package (cash transactions and the negative-cash control)

Prepared under the product owner's delegation (DEC-019, DEC-036, DEC-037). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including the 12.5% VAT rate used in the tests.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `7f4adad` (branch `claude/adoring-cori-mra6ze`); DEC-036 specified before code in the M6 plan; DEC-037 records the build choices; later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38798396155> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38798395945> - **success** |
| Clean clone of `7f4adad` | install, build, typecheck and lint exit 0; `pnpm test` **89 files, 1750 tests passed, 0 failed, 0 skipped**; end-to-end 4/4; no OpenAPI drift |
| Local full run | `pnpm test` **89 files, 1750 tests passed, 0 failed, 0 skipped** (M6b: 87 / 1705), run alone |

## 2. What M6c delivers (DEC-036, DEC-037; plan sections 10.3 and 10.3a)
* **Cash transactions:** money in or out of a bank or cash account without an invoice or bill, posted when recorded:
  * money in: `CASH_RECEIPT` - Dr bank or cash / Cr income / Cr output VAT;
  * money out: `CASH_PAYMENT` - Dr expense or asset / Dr input VAT (or the reverse-charge pair) / Cr bank or cash;
  * VAT per line with verified rates: standard, zero, exempt, reverse charge (money out only); amounts exclusive or inclusive;
  * an optional contact or free-text counterparty, a reference, and the till receipt attached as evidence;
  * duplicate check (same account, direction, date and total, or the same reference) needs a reason.
* **Reversal:** once, with a reason, dated on or after the transaction. It is the exact mirror of the posted journal, line by line, at the same VAT rate versions and tax point. The database proves the mirror. The ledger never reverses a cash journal.
* **Negative cash (DEC-036, DEC-037):**
  * a posting by a person that takes **cash in hand** below zero on its date **or any later date** is refused (`negative_cash`, with the lowest balance and its date) unless a `negativeCashReason` is given;
  * the reason is stored on the journal and its audit event;
  * this covers every posting to cash in hand, not only cash transactions: supplier payments from cash, reversals of customer receipts paid in cash, cash transaction reversals and ledger reversals;
  * the database re-checks it at commit, so bypassing the PostingService does not get round it;
  * an **overdrawn bank account** is allowed and returned as `balanceWarnings` (also on the audit event);
  * not refused: journals from approved requests, system postings, and functional-only FX revaluation adjustments (they move no money).
* **Permissions:** `cash:read` (owner, admin, partner, accountant, manager, bookkeeper, reviewer) and `cash:record` (owner, admin, partner, accountant).
* **Event:** `cash_transaction.recorded`.
* **API:** 6 routes, all in OpenAPI (244 operations in total).

## 3. Migration
`20260115000000_v1_cash_transactions` is additive:
* `cash_transaction` and `cash_transaction_line`: forced RLS; no `DELETE` or `TRUNCATE`; lines have no `UPDATE` either;
* `cash_transaction_guard`: created POSTED by its own journal of its direction from a bank or cash account; immutable; REVERSED once by its own reversal journal, which must mirror the posted journal line by line (account, amounts swapped, VAT facts);
* `cash_transaction_line_guard`: lines are written only in the transaction that creates the record, to a non-control account that is not a bank or cash account;
* commit-time totals check: the lines, the totals and the bank or cash line of the journal agree;
* `journal.negative_cash_reason` (10 to 1,000 characters) and the commit-time `journal_cash_check`;
* the sub-ledger reversal guard and `journal_vat_check` cover the four cash journal sources;
* `cash_transaction` joins the evidence graph; permissions; retention classification only.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Recording and reversing need `cash:record`; bookkeepers, managers and reviewers read but cannot record; client viewers cannot read; AI cannot record | `tests/api/sales.test.ts` (cash section), `tests/api/permissions.test.ts` (2 new probes x 8 roles), `tests/platform/cash.test.ts` |
| Direct SQL is refused: a record pointing at another journal or direction; totals that do not match; a line added later or to a control account; editing a record or a line; deleting; a "reversal" that is not the mirror; un-reversing; a ledger reversal of a cash journal; a journal that takes cash in hand below zero without a reason (also on a later day) | `tests/db/cash.test.ts` (7) |
| One writer of the cash tables, and it never writes journals | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges and the version boundary include both tables | the classification, retention, privileges and regression suites |

## 5. Hand-calculated evidence (`tests/platform/cash.test.ts`)
* **Money in:** 200.00 standard (VAT 25.00) + 30.00 zero-rated = 255.00: Dr 1220 255.00 / Cr 4000 200.00 / Cr 2200 25.00 / Cr 4100 30.00.
* **Money out, inclusive:** 90.00 standard gives VAT 90 x 12.5 / 112.5 = 10.00 and net 80.00; plus 15.00 exempt = 105.00: Cr 1220 105.00 / Dr 6310 80.00 / Dr 1150 10.00 / Dr 8000 15.00. Cash 255.00 - 105.00 = 150.00.
* **Reverse charge from the bank:** 400.00 paid; pair 50.00 output / 50.00 input; the bank ends at -400.00, returned as a warning, not refused.
* **VAT workpaper:** box 1 75.00, box 4 60.00, box 5 15.00, box 6 230.00, box 7 495.00, reconciled. After reversing the 105.00 payment: box 4 50.00, box 7 400.00.
* **Back-dated payment:** 200.00 on 3 February leaves 55.00 that day but -50.00 on 5 February: refused with lowest balance -50.00 on 2026-02-05.
* **Override:** 200.00 on 10 February with a reason: cash -50.00, the reason stored on the journal, `negativeCashOverride` on the audit event. A 80.00 top-up brings it to 30.00.
* **Reversing spent takings:** reversing the 255.00 receipt on 21 February would leave -120.00: refused, then accepted with a reason.
* **Supplier payment and receipt reversal from cash** are refused without a reason in the same way (`tests/platform/purchase-payments.test.ts`, `tests/platform/cash.test.ts`).

## 6. Compliance matrix (v3.0; 113 rows: Implemented 70, Partially 18, Missing 25)
* **Now Implemented:** V1-MOD-11 (cash).
* **Now Partially implemented:** V1-CTL-04 (negative cash alerts): enforced at posting; the dashboard and alert list remain M8.

## 7. Known limitations and gates
1. **Company currency only.** Foreign-currency bank and cash accounts come with M7; VAT on foreign currency with M5c (DEC-031).
2. **Transfers** between bank and cash accounts are M7 (refused here with `transfer_not_supported`).
3. **For the tax reviewer:** a reversal keeps the original tax point, as a ledger reversal does. Whether a correction found after a VAT return was filed belongs in the current return instead (HMRC VAT Notice 700/45) is an open question; returns are not filed in V1.
4. **Dashboard alerts** for negative balances are M8 (V1-CTL-04).
5. **Performance:** the balance check reads the account's history for each posting that lowers a bank or cash account; it is untested at real volume (M7 bank balances may add a running-balance table).
6. **Production gates unchanged:** qualified tax reviewer and VAT rule verification, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
