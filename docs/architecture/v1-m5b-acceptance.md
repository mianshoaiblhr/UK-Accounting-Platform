# V1 milestone M5b - acceptance package (customer receipts)

Prepared under the product owner's delegation (DEC-019, DEC-032). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including the exchange rates.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `376aec6` (branch `claude/adoring-cori-mra6ze`); decisions recorded before code in `2dbc6d7`; later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38342847878> - **success** (all jobs, including images) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38342847887> - **success** |
| Clean clone of `376aec6` | install, build, typecheck and lint exit 0; `pnpm test` **84 files, 1637 tests passed, 0 failed, 0 skipped** (M5a: 83 / 1620); end-to-end 4/4; no OpenAPI drift |
| Also in this range | `6f40c39`: the add-company form asks for the type of entity (an LLP was stored as LTD). Found while capturing the web UI; covered by the end-to-end journey |

## 2. What M5b delivers (DEC-032; plan sections 9.2 and 9.5)
* **Receipts:** posted when recorded (`SALES_RECEIPT`: Dr bank or cash / Cr trade receivables), in the company currency or a foreign currency at the receipt date's rate.
* **Allocation:**
  * at entry or later, to one or more invoices of the same customer and currency;
  * part payments are allowed;
  * an overpayment stays unallocated credit, which lowers the open balance, credit-limit use and the ageing.
* **Realised FX on every allocation** (DEC-030), shared with credit notes.
* **Duplicate check:** the same customer with the same date, currency and amount, or the same bank reference, needs a reason, which is stored and audited.
* **Reversal:** a receipt can be reversed only while unallocated (`SALES_RECEIPT_REVERSAL`). The reversal mirrors the posted lines, so it is at the original rate whatever the date. The ledger never reverses receipt journals.
* **Customer statement:** opening balance, items in date order with a running balance, and closing balance, per currency.
* **Aged receivables as at a date:** not due, 1-30, 31-60, 61-90 and over 90 days, plus unallocated credits. Only documents, receipts and allocations dated on or before that date count.
* **Receivables reconciliation:** now includes receipts and reversals.
* **Ending a customer role:** refused while the role has unallocated receipts.
* **Event:** `sales_receipt.recorded`.
* **API:** 7 routes (receipts, allocations, reverse, statement and aged receivables), all in OpenAPI.

## 3. Migration
`20260112000000_v1_sales_receipts` is additive.
* **`sales_receipt`:** forced RLS and no `DELETE` or `TRUNCATE`.
* **`sales_receipt_guard`:**
  * a receipt starts POSTED and unallocated, with its own journal of the right source and date, into a bank or cash account;
  * it is otherwise immutable, and its unallocated amount moves only through an allocation;
  * POSTED -> REVERSED happens once, only while unallocated, with its own reversal journal.
* **`sales_allocation`:** now takes a credit note **or** a receipt, exactly one of the two. `sales_allocation_apply` checks both cases: one company, customer and currency; not before either document; never below zero.
* **Reversal guard:** receipt journals are added to the sub-ledger reversal guard.
* **Retention:** classification only.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Recording, allocating and reversing receipts need `sales:approve` (they post); reading needs `sales:read`; a client viewer cannot read the ageing | `tests/api/sales.test.ts`, `tests/platform/sales-receipts.test.ts` |
| Direct SQL is refused: changing a receipt, moving its unallocated amount without an allocation, allocating across customers, marking an allocated receipt reversed, deleting | `tests/db/sales.test.ts` (10, 2 new) |
| One writer of the sales tables, including `sales_receipt`, and it never writes journals | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges and the version boundary include `sales_receipt` | `tests/db/classification.test.ts`, `tests/db/retention.test.ts`, `tests/db/privileges.test.ts`, `tests/api/regression.test.ts` |

## 5. Tests and hand-calculated figures
* **Test files:** `tests/platform/sales-receipts.test.ts` (9); additions to `tests/db/sales.test.ts` (2) and `tests/api/sales.test.ts` (2).
* **Receipt of 400.00** posts Dr 1200 400.00 / Cr 1100 400.00:
  * 100.00 and 200.00 are allocated at entry, which leaves invoice A paid, invoice B part-paid (50.00) and 100.00 unallocated;
  * the open balance is -50.00;
  * a later allocation of 50.00 pays B;
  * an allocation dated before the documents is refused.
* **EUR invoice of 1000 at 0.85** (850.00):
  * 600 at 0.90 (540.00) against 510.00 released is a **gain of 30.00**;
  * 400 at 0.80 (320.00) against the remaining 340.00 is a **loss of 20.00**;
  * the realised FX account nets to **10.00** = 860.00 cash less 850.00 carried, and no residue is left.
* **Unallocated EUR receipt** of 100 at 0.90, reversed on a date when the rate is 0.80, reverses at **90.00**.
* **Statement:** opening 100.00; then +250.00 -> 350.00; then -400.00 -> **-50.00**.
* **Ageing:**
  * as at 15 Feb: 300.00 in 1-30;
  * as at 15 Apr: 300.00 in 61-90, 120.00 in 1-30, -100.00 unallocated, total 320.00;
  * an allocation dated 20 Apr leaves the 15 Apr ageing unchanged;
  * as at 30 Apr: 200.00 in 61-90 and nothing unallocated.

## 6. Compliance matrix (v2.7; 113 rows: Implemented 60, Partially 21, Missing 32)
* **Now Implemented:**
  * V1-MOD-08 (receipts);
  * V1-EX-03 (the receipt example);
  * V1-MOD-04 (sales, now paid by receipts).
* **Evidence extended:** V1-FX-07 (end to end on receipts; supplier payments are M6), V1-CON-02 and XP-07.

## 7. Defects found and fixed before acceptance
1. A foreign receipt reversed on a later date looked up a new rate, and failed outside the 7-day window. The reversal now mirrors the posted lines.
2. The add-company form stored every company as LTD (`6f40c39`).

## 8. Known limitations and gates
1. **No unallocating:** an allocated receipt cannot be reversed (DEC-026). A receipt allocated to the wrong invoice cannot be corrected yet.
2. **Ageing and statement amounts** are in the document currency, totalled per currency. Converting them to the company currency is M8 reporting.
3. **Performance:** ageing and statements read all of a company's documents. They are untested at real volume, which is a production gate.
4. **No refunds of overpayments**, no direct debit and no online payment (deferred).
5. **Production gates unchanged:** privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
