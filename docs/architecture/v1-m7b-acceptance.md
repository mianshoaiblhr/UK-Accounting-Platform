# V1 milestone M7b - acceptance package (bank reconciliation)

Prepared under the product owner's delegation (DEC-019, DEC-042). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `b8c0e0a` (branch `claude/adoring-cori-mra6ze`): the reconciliation code in `cca6855` plus the test-list fix below; DEC-042 recorded before code in `11a5e9f` |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38811610801> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38811610867> - **success** |
| Clean clone of `b8c0e0a` | CLEAN_CLONE_RESULT |
| Local full run | `pnpm test` **95 files, 1853 tests passed, 0 failed, 0 skipped** (M7a: 93 / 1825), run alone |
| CI on `cca6855` | **failed** (run 38810219217): three older database tests check that the journal tables cannot be truncated, and `bank_match` now references `journal`, so PostgreSQL refused the TRUNCATE for the foreign key before the append-only trigger could. Reproduced locally on `cca6855`, fixed in `b8c0e0a` by adding `bank_match` to those lists, and shown passing. CodeQL on `cca6855` passed |

## 2. What M7b delivers (DEC-042; plan sections 11.2 and 11.2a)
* **Matching** a statement line to a ledger entry on the bank account's own ledger account, in the account currency (original amounts of foreign entries), in full or in parts, one-to-many both ways. The database proves the same account, the same direction (money in to a debit) and that neither side is matched for more than it holds; the statement line's matched part moves only through a match.
* **Unmatch** with a reason (10+ characters); the row stays; flagged (`afterSignOff`) and audited when a signed-off reconciliation covered it.
* **Override:** a match whose dates are more than 14 days apart needs a reason, stored on the match.
* **Suggestions**, computed on request: same remaining amount, same direction, within 7 days; score 100, less 5 per day apart, plus 50 when the entry's reference is in the bank narrative; ties and an entry suggested for two lines are flagged ambiguous. Charge and interest lines are proposed for posting. A suggestion never matches or posts.
* **Charges and interest from the statement:** a person posts what is left of a line as a cash transaction dated on the line (the account's charges, interest-received or interest-paid account, or any account and VAT code), through `CashService` and the PostingService, and it is matched in the same step. Needs `bank:reconcile` and `cash:record`.
* **Unmatched items** as at a date with ages and buckets (0-7, 8-30, 31-60, 61+ days), for statement lines and for ledger entries.
* **Proof and sign-off:** as at a date, statement balance less unmatched statement items against ledger balance less unmatched ledger items; the difference is exactly the disagreement of the opening points and must be zero. A sign-off also requires the bank's printed closing balance to equal the imported statement (a missing statement is caught). It is recorded once.
* A bank account with unmatched lines **cannot close**; statement lines must be dated after the statement opening date.
* **Permission:** `bank:reconcile` (owner, administrator, partner, accountant, manager, bookkeeper).
* **API:** 9 routes, all in OpenAPI.

## 3. Migration
`20260117000000_v1_bank_reconciliation` is additive: `bank_match` (guard, matched-part trigger, per-entry lock, partial unique index on the live pair) and `bank_reconciliation` (proof CHECK; no UPDATE, DELETE or TRUNCATE), the `bank_line_value` function, RLS, permission and retention classification.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Reviewers read suggestions, unmatched items and the proof but cannot match or sign off; bookkeepers reconcile and sign off but cannot post a charge without `cash:record` | `tests/api/bank.test.ts` (reconciliation section), `tests/api/permissions.test.ts` (1 new probe x 8 roles) |
| Direct SQL refused: a match to another ledger account, the wrong direction or sign, over the ledger entry's amount, a second live match on the same pair, editing a match, a short unmatch reason, re-activating an undone match, deleting; moving a line's matched part outside a match; a sign-off that does not prove or whose closing balance differs; editing or deleting a sign-off | `tests/db/reconciliation.test.ts` (3) |
| One writer per table; reconciliation never writes journals or statement lines directly | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges, version boundary | the classification, retention, privileges and regression suites |

## 5. Hand-calculated evidence (`tests/platform/reconciliation.test.ts`)
* Statement opening 28 Feb 100.00 (the ledger holds 100.00 from a transfer on 15 Feb).
* Bank: +250.00 ACME INV-1001, +200.00 counter credit, -30.00 to petty cash, -6.50 service charge, +1.25 gross interest = **514.75**.
* Ledger: 100.00 + 250.00 - 40.00 (cheque 101, unpresented) + 120.00 + 80.00 - 30.00 - 6.50 + 1.25 = **474.75**.
* The 200.00 counter credit is matched in parts to the 120.00 and 80.00 lodgements (PARTIAL, then MATCHED).
* The charge and interest are posted from the statement on 10 and 12 March and matched.
* Proof at 31 March: 514.75 - 0.00 = 474.75 - (-40.00); difference **0.00**; the cheque is 26 days old (bucket 8-30).
* Sign-off refused at a bank closing balance of 520.00 and accepted at 514.75.
* Undoing the 250.00 match after sign-off is flagged; the proof still holds: 514.75 - 250.00 = 474.75 - 210.00.
* The ACME suggestion scores 145 (100 - 5 for one day + 50 for the reference).

## 6. Compliance matrix (v3.2; 113 rows: Implemented 84, Partially 19, Missing 10)
* **Now Implemented:** V1-MOD-18, V1-BANK-04, V1-BANK-07, V1-BANK-08, V1-REC-01, V1-REC-02, V1-REC-03, V1-REC-04, V1-REC-05.
* **Now Partially implemented:** V1-BANK-05 (unmatched counts through the API; the dashboard screen is M9).

## 7. Known limitations and gates
1. **No screens** yet (M9); the dashboard count is in the API only.
2. **Posting from foreign-currency statements** waits for M5c; record the entry and match it.
3. **Suggestions** are one-to-one; one-to-many splits are matched by hand. AI suggestions are V6.
4. **Performance:** suggestions and unmatched lists read the account's history on each request; untested at real volume.
5. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
