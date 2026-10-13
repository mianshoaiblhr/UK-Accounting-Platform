# V1 milestone M6b - acceptance package (supplier payments)

Prepared under the product owner's delegation (DEC-019, DEC-035). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including the exchange rates.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `a753db0` (branch `claude/adoring-cori-mra6ze`); decisions recorded before code in `128c94f`; later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38361606618> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38361606615> - **success** |
| Clean clone of `a753db0` | install, build, typecheck and lint exit 0; `pnpm test` **87 files, 1705 tests passed, 0 failed, 0 skipped** (M6a: 86 / 1693); end-to-end 4/4; no OpenAPI drift |
| Local full run | 87 files, 1705 passed, run alone. An earlier attempt overlapped a second run on the same test database and Redis; the platform's login rate-limit then refused test logins (HTTP 429), so that attempt is void and is not counted |

## 2. What M6b delivers (DEC-035; plan sections 10.2 and 10.2a)
* **Payments:** posted when recorded (`PURCHASE_PAYMENT`: Dr trade payables / Cr bank or cash), in the company currency or a foreign currency.
* **Allocation:**
  * at entry or later, to one or more bills of the same supplier and currency;
  * part payments are allowed;
  * an overpayment stays a prepayment (unallocated debit);
  * realised FX on every allocation (DEC-030, credit-normal).
* **Unverified bank details (DEC-035):** when a payment is recorded while the supplier's stored bank details are UNVERIFIED (changed and not yet verified by a second person), the payment is **flagged** (`bankDetailsUnverified`). The flag is recorded on its audit event, and flagged payments can be listed for review. The payment is never blocked: the platform records payments that have already been made.
* **Duplicate check:** the same supplier with the same date, currency and amount, or the same reference, needs a reason.
* **Reversal:** only while unallocated, mirroring the posted lines at the original rate. The ledger never reverses payment journals.
* **Supplier statement:** what is owed, with a running balance, per currency.
* **Aged payables as at a date:** by days past due, with unallocated payments and debit notes apart. A later allocation does not rewrite the past.
* **Payables reconciliation:** now includes payments.
* **Ending a supplier role:** refused while the role has an unallocated payment.
* **Event:** `purchase_payment.recorded`.
* **API:** 7 routes, all in OpenAPI.

## 3. Migration
`20260114000000_v1_purchase_payments` is additive:
* `purchase_payment` with `bank_details_unverified`, forced RLS, and no `DELETE` or `TRUNCATE`;
* `purchase_payment_guard`: created POSTED and unallocated with its own journal into or out of a bank or cash account; otherwise immutable; the unallocated amount moves only through an allocation; reversed once, only while unallocated;
* `purchase_allocation` takes a debit note **or** a payment, exactly one of the two;
* payment journals are added to the sub-ledger reversal guard;
* retention classification only.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Recording, allocating and reversing payments need `purchases:approve`; a bookkeeper cannot record a payment; reviewers read statements and ageing | `tests/api/sales.test.ts` (payments section), `tests/platform/purchase-payments.test.ts` |
| Direct SQL is refused: changing a payment, including its flag; moving its unallocated amount without an allocation; allocating across suppliers; marking an allocated payment reversed; deleting | `tests/db/purchases.test.ts` (5, 1 new) |
| One writer of the purchase tables, including `purchase_payment`, and it never writes journals | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges and the version boundary include `purchase_payment` | the classification, retention, privileges and regression suites |

## 5. Hand-calculated evidence
* **Payment of 400.00** posts Dr 2100 400.00 / Cr 1200 400.00:
  * 100.00 and 200.00 are allocated at entry, and 50.00 later;
  * a 50.00 prepayment remains;
  * the payables open items show -50.00, reconciled.
* **EUR bill of 1000 at 0.85** (850.00):
  * 600 at 0.90 = 540.00 paid against 510.00 released is a **loss of 30.00** (Cr 2100 / Dr 7910);
  * 400 at 0.80 = 320.00 against the remaining 340.00 is a **gain of 20.00**;
  * net **10.00 loss** = 860.00 paid less 850.00 carried, with no residue.
* **Flag:** a payment of 12.34 recorded after the stored bank details were changed carries `bankDetailsUnverified = true`, is flagged on its audit event, and is the one payment returned by the review filter.
* **Statement:** opening 100.00; then +250.00 -> 350.00; then -400.00 -> **-50.00**.
* **Ageing:**
  * as at 15 Apr: 300.00 in 61-90, 120.00 in 1-30, -100.00 unallocated;
  * an allocation dated 20 Apr leaves the 15 Apr ageing unchanged;
  * as at 30 Apr: 200.00 in 61-90.

## 6. Compliance matrix (v2.9; 113 rows: Implemented 69, Partially 17, Missing 27)
* **Now Implemented:**
  * V1-MOD-09 (payments);
  * V1-EX-04 (the payment example);
  * V1-MOD-05 (purchases, now paid);
  * V1-FX-07 (realised FX on receipts and payments end to end);
  * V1-CON-02 (role ending refused for open items of either role).
* **Evidence extended:** XP-07.

## 7. Known limitations and gates
1. **No unallocating:** an allocated payment cannot be reversed (DEC-026).
2. **Deferred:** payment runs and bank files, which will **refuse** unverified bank details (DEC-035). Supplier refunds of prepayments are also deferred.
3. **Currency:** ageing and statements are in the document currency (M8 converts).
4. **Performance:** ageing and statements are untested at real volume.
5. **Production gates unchanged:** privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
