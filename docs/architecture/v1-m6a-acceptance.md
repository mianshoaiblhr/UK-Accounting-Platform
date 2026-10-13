# V1 milestone M6a - acceptance package (supplier bills and debit notes)

Prepared under the product owner's delegation (DEC-019, DEC-033, DEC-034). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including every VAT rate and exchange rate. VAT statements are **UNVERIFIED** (DEC-022); the candidate sources are in `docs/legal/m4b-vat-sources.xlsx`.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `16c7f12` (branch `claude/adoring-cori-mra6ze`); specification and decisions recorded before code in `128c94f`; later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38344953160> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38344953209> - **success** |
| Clean clone of `16c7f12` | install, build, typecheck and lint exit 0; `pnpm test` **86 files, 1693 tests passed, 0 failed, 0 skipped** (M5b: 84 / 1637); end-to-end 4/4; no OpenAPI drift |

## 2. What M6a delivers
* **Bills:**
  * The **supplier's own invoice number is required**. It is the duplicate key: the same supplier with the same number, ignoring case and spaces, or the same date, currency and total, needs a reason, which is stored and audited.
  * Lines default to the supplier's default expense account.
  * Approval takes an **internal gapless number** (`BILL-n`), stores the supplier snapshot, recomputes VAT with verified rates and posts `PURCHASE_BILL`: Dr expense or asset / Dr input VAT, or the reverse-charge pair / Cr trade payables.
  * The bill is immutable after approval.
* **Debit notes:**
  * linked to one approved bill of the same supplier and currency, using only its VAT codes, at its rate versions, and never more than its outstanding amount;
  * allocated to the bill on approval, with realised FX. Payables are credit-normal, so a debit note at a higher rate is a loss.
* **Controls:**
  * separate approver;
  * DEC-031 for foreign-currency bills of a VAT-registered company;
  * supplier role-end refusal;
  * the period close control counts purchase drafts;
  * purchase journals cannot be reversed in the ledger.
* **Payables reconciliation** per currency.
* **API:** 14 routes, including attachments of the bill as received. All are in OpenAPI.

## 3. Migration
`20260113000000_v1_purchase_documents` is additive and mirrors the verified sales guards:
* lifecycle and identity, next number, posted journal of the right source and date, separation of duties, the DEC-031 refusal, and immutability after approval;
* lines written only for the current revision of a draft;
* allocations within one company, supplier and currency, to the debit note's own bill, never below zero.

It also adds:
* the supplier reference CHECK on bills and its normalised index;
* purchase journals in the sub-ledger reversal guard;
* `journal_vat_check` accepting the rate point on debit notes;
* `purchase_document` as an evidence-link entity type;
* permissions `purchases:read`, `purchases:manage` and `purchases:approve`;
* retention classification only.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Owner, admin, partner and accountant may prepare and approve; manager and bookkeeper may prepare only; reviewer reads; client viewer has no access; settings need `ledger:policy`; AI never approves | `tests/api/permissions.test.ts`, `tests/api/sales.test.ts` (purchases section), `tests/platform/purchases.test.ts` |
| The database refuses: a bill without a supplier reference, a customer role on a purchase document, edits to an approved bill, a jump in the sequence, line updates, allocations below zero or across suppliers, and a ledger reversal of a purchase journal | `tests/db/purchases.test.ts` (4) |
| One writer of the purchase tables, which never writes journals | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges and the version boundary include the purchase tables | `tests/db/classification.test.ts`, `tests/db/retention.test.ts`, `tests/db/privileges.test.ts`, `tests/api/regression.test.ts` |

## 5. Hand-calculated evidence
* **Bill** with four lines:
  * 2 x 40.00 at 12.5 % input VAT;
  * 33.33 zero-rated;
  * 7.00 exempt;
  * 200.00 reverse charge.
* **Bill totals:** net 320.33, VAT 10.00, gross 330.33. Reverse charge adds no VAT to what the supplier is owed.
* **Bill journal:** Cr 2100 330.33 / Dr 6100 80.00 / Dr 1150 10.00 / Dr 6100 33.33 / Dr 6100 7.00 / Dr 6100 200.00 / Cr 2200 25.00 (RC output) / Dr 1150 25.00 (RC input).
* **Workpaper** for the quarter: box 1 **25.00**, box 4 **35.00**, box 6 0.00, box 7 **320.33**.
* **Full debit note:** mirrors every line, including the reverse-charge pair (Dr 2200 25.00 / Cr 1150 25.00). Afterwards boxes 1, 4 and 7 are 0.00.
* **BOTH-direction code:** a bill of 100.00 + 12.50 VAT, then a debit note of 40.00 + 5.00 that **credits input VAT** (1150).
* **EUR bill** of 1000 at 0.85 (850.00), part-credited by 400 at 0.90: the bill releases 340.00 and the debit note took 360.00, so the result is a **realised loss of 20.00** (Dr 7910 / Cr 2100). The remaining open item is 600 EUR / 510.00, with a 0.00 difference in the reconciliation.
* **Duplicates:** "inv001" matches "INV 001", and a bill with the same date and total also matches.

## 6. Defects found while building M6a and fixed before acceptance
These are in code verified in M4b and M5a. They affect credits only; all data so far is synthetic. Both are regression-tested.
1. **BOTH-direction VAT codes:** the output or input account, and in the workpaper the sales or purchase box, were chosen from the debit/credit side alone. A sales credit note on such a code therefore posted to **input** VAT and fell into the purchase boxes. Document journals now fix the side by their source; manual journals keep the side rule. A sales regression test is in `tests/platform/sales.test.ts`.
2. **Reverse-charge pair on credits:** it was always output-credit / input-debit, whatever the side of the net line. It now follows the net line, so a debit note mirrors it.
3. **Rate pin on debit notes:** the pin was allowed only on sales credit notes. It is now also allowed on purchase debit notes, and the database check agrees.

## 7. Compliance matrix (v2.8; 113 rows: Implemented 64, Partially 20, Missing 29)
* **Now Implemented:**
  * V1-MOD-07 (debit notes);
  * V1-EX-02 (the purchase example);
  * V1-EX-05 (credit and debit notes in both ledgers);
  * V1-CTL-02 (duplicate documents in both ledgers).
* **Partially implemented:** V1-MOD-05 (paying bills is M6b).
* **Evidence extended:** V1-VAT-04/05/08, V1-CON-02 and MAN-ACC-08.

## 8. Known limitations and gates
1. **Paying bills:** there are no supplier payments yet (M6b). A bill becomes paid only by debit notes.
2. **Foreign currency and VAT:** no VAT on foreign-currency documents (M5c). A VAT-registered company cannot approve a foreign-currency bill.
3. **Deferred:** purchase orders, expense claims, OCR capture of bills (V6), payment runs and bank files.
4. **VAT rules:** the reverse-charge cases and the debit-note VAT rule are for the firm's reviewer to verify (DEC-029, DEC-034).
5. **Production gates unchanged:** privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
