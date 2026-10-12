# V1 milestone M5a - acceptance package (sales documents: invoices and credit notes)

Prepared under the product owner's delegation of 2026-10-12 (DEC-019, DEC-026..031). This is milestone evidence only, **not production approval** (DEC-006). Development data is synthetic, including every VAT rate and exchange rate in the tests. The VAT rules applied to credit notes (DEC-029) and the tax-point handling (DEC-028) are **UNVERIFIED** and are for the firm's tax reviewer to confirm; the candidate sources are in `docs/legal/m4b-vat-sources.xlsx`.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `e698562` (branch `claude/adoring-cori-mra6ze`); M5a code is `965d89d` plus the fixes in `e698562`; later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38318917124> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38318917096> - **success** |
| Clean clone of `e698562` | install, build, typecheck and lint exit 0; `pnpm test` **83 files, 1620 tests passed, 0 failed, 0 skipped** (M4b: 79 / 1529); end-to-end 4/4; no OpenAPI drift |
| Local full run | 83 files, 1620 passed |
| CI on `965d89d` | **failed**: the 7 test failures listed in section 7 below; fixed in `e698562` |

## 2. What M5a delivers (DEC-026..031; ADR-59; plan section 9.1 and 9.4)
* **Drafts:** an invoice draft has no number and no ledger effect. Editing a draft needs its current revision and writes a new append-only revision of its lines. A draft can be discarded with a reason; it is never deleted.
* **Approval** happens in one transaction:
  * the next number is taken from the locked sequence (prefix and start number are configurable until the first approval);
  * the customer snapshot is stored;
  * every amount is recomputed with verified VAT rates;
  * the document is posted as `SALES_INVOICE` (Dr trade receivables / Cr revenue / Cr output VAT), and the journal and document are linked both ways;
  * audit and outbox events (`invoice.created`) are written.
* **After approval** the document is immutable. Corrections are credit notes; there is no void.
* **Checks at approval:**
  * A possible duplicate needs a reason: same customer with the same date, currency and total, or the same customer reference.
  * Going over the customer's credit limit needs a reason. The limit is checked in the company currency, including this invoice.
  * Both reasons are stored on the document and audited.
  * Optional policy: a different person must approve than the one who prepared the document.
* **Credit notes:**
  * linked to one approved invoice of the same customer and currency, using only that invoice's VAT codes;
  * VAT at the **rate version the invoice used**, reported at the credit note's own tax point;
  * never more than the invoice's outstanding amount;
  * allocated to the invoice in the same transaction.
* **Allocation and realised FX:**
  * each document converts at its own date's rate;
  * an allocation releases a prorated share of each side's carried amount, or the whole remainder when it clears the document;
  * any difference is posted as realised FX in its own `SALES_ALLOCATION_FX` journal.
* **Receivables reconciliation**, per currency: open items against the receivables control account, in both the original currency and the company currency. Every other posting on the account is named by its journal source.
* **Fences:**
  * sales journals cannot be reversed in the ledger;
  * sales journals reach the trade-receivables control account and no other control account;
  * a customer role with open documents cannot be ended;
  * a period with draft sales documents dated in it cannot be closed unless someone acknowledges it;
  * a VAT-registered company cannot approve a foreign-currency sale until M5c (DEC-031);
  * a draft can come from an ACCEPTED AI proposal, but only a person can approve it.
* **API:** 14 routes behind the `bookkeeping.core` flag: sales settings, invoices, credit notes, documents, approve, discard, attachments (through the evidence graph) and reconciliation. All are in the OpenAPI description.

## 3. Migration
`20260111000000_v1_sales_documents` is additive:
* **New tables:** `sales_setting`, `sales_sequence`, `sales_document`, `sales_document_line` and `sales_allocation`. All have forced RLS and no `DELETE` or `TRUNCATE`; lines and allocations also have no `UPDATE`.
* **Triggers:**
  * `sales_setting_guard` and `sales_sequence_guard`: numbering freezes after the first approval, and the sequence moves forward by one only;
  * `sales_document_guard`: lifecycle, identity, the next number, the journal of the right source and date, separation of duties, the DEC-031 refusal, and immutability after approval;
  * `sales_document_line_guard`: lines are written only for the current revision of a draft;
  * `sales_allocation_apply`: one company, customer and currency; a credit note goes to its own invoice; both outstanding amounts move and never go below zero;
  * `journal_subledger_reversal_guard`: no ledger reversal of a sales journal.
* **Other changes:**
  * new column `journal_line.vat_rate_point`, which `journal_vat_check` (replaced) accepts only on credit notes and reversals;
  * `sales_document` added as an evidence-link entity type;
  * permissions `sales:read`, `sales:manage` and `sales:approve`;
  * retention classification only.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Roles. Owner, admin, partner and accountant: read, prepare, approve. Manager and bookkeeper: read and prepare, not approve. Reviewer: read only. Client viewer: none. Sales settings need `ledger:policy`. | `tests/api/sales.test.ts`, `tests/api/permissions.test.ts` |
| AI never approves; approval is by people only; drafts from AI proposals only when the proposal is ACCEPTED and of kind `sales_invoice`, and the application is recorded on the proposal | `tests/platform/sales.test.ts` |
| The database refuses, even when the service is bypassed: a number other than the next, a jump in the sequence, numbering changes after approval, edits to an approved document, line updates or late lines, allocations below zero or across customers, a credit note against a draft or another customer's invoice, and a ledger reversal of a sales journal | `tests/db/sales.test.ts` (8) |
| One writer of the sales tables, which never writes journals | `tests/unit/architecture.test.ts` |
| Tenant isolation (database, service, API) | `tests/db/sales.test.ts`, `tests/platform/sales.test.ts`, `tests/api/sales.test.ts` |
| Every new table classified (retention, protection) and documented in `security-architecture.md` | `tests/db/classification.test.ts`, `tests/db/retention.test.ts`, `tests/db/privileges.test.ts` |

## 5. Tests for the new work, with hand-calculated figures
* **Test files:**
  * `tests/platform/sales.test.ts` (24);
  * `tests/db/sales.test.ts` (8);
  * `tests/api/sales.test.ts` (14);
  * `tests/unit/sales-math.test.ts` (4): line amounts half-up, and allocations that release carried amounts with no residue whatever the split.
* **Invoice:** 2 x 40.00 at 12.5 % plus 33.33 zero-rated plus 7.00 exempt = net 120.33, VAT 10.00, gross 130.33. It posts exactly Dr 1100 130.33 / Cr 4000 80.00 / Cr 2200 10.00 / Cr 4010 33.33 / Cr 4010 7.00.
* **VAT-inclusive entry:** 112.50 = net 100.00 + VAT 12.50.
* **Numbering:** gapless from the start number 1001. A refused approval takes no number. Five concurrent approvals take five consecutive numbers.
* **EUR partial credit:** invoice 1000 at 0.85 (850.00), credit note 400 at 0.90. The invoice releases 340.00, the credit carries 360.00, so the realised gain is 20.00. The invoice is left at 600 EUR / 510.00, and the reconciliation shows 0.00 difference.
* **EUR full credit:** 333.33 at 0.85 = 283.33 carried, against 300.00 at 0.90. The realised gain is 16.67 and no residue is left.
* **Credit note across a rate change:** VAT at the invoice's 12.5 %, not the 15 % in force on the credit note's date. The VAT line carries tax point 2026-07-10 and rate point 2026-06-15, and the third-quarter workpaper's box 1 shows -12.50.
* **Snapshot:** unchanged after the contact is renamed.
* **Period lock:** approval into a closed period is refused and takes no number.

## 6. Compliance matrix (v2.6; 113 rows: Implemented 57, Partially 22, Missing 34)
* **Now Implemented:**
  * V1-MOD-06 (credit notes);
  * V1-EX-01 (the sales example);
  * V1-CON-04 (the snapshot on documents).
* **Now Partially implemented:**
  * V1-MOD-04: being paid by a receipt is M5b;
  * V1-EX-05: debit notes are M6;
  * V1-CTL-02: supplier bills are M6;
  * V1-CTL-05: the age threshold and alerts are M8.
* **Evidence extended** on V1-CON-02, V1-ARC-01, MAN-ACC-06, MAN-ACC-08, XP-07, V1-VAT-04/05/07, V1-FX-07, V1-CTL-06 and V1-RPT-02.
* **V1-VAT-15 stays Missing**: VAT on foreign-currency documents is M5c (DEC-031).

## 7. Defects found while building and testing, fixed before acceptance
1. plpgsql read the `THEN` of a `CASE` inside an `IF` condition as the end of the condition. The migration failed to apply until the expressions were wrapped in parentheses.
2. The approval guard compared `journal.source_id` (text) with a uuid; now cast explicitly.
3. The full run on `965d89d` found that the five sales tables were not classified for retention or protection, that three TRUNCATE probes needed the new tables that reference journals and rates, and that a negative posting test used `SALES_INVOICE` as an unknown source. All were fixed in `e698562`. The classification tests did what they exist for: a new table without a decision failed CI.

## 8. Known limitations and gates
1. **No receipts yet (M5b).** An invoice becomes PAID only by credit notes; realised FX is exercised only on credit-note allocations.
2. **No VAT on foreign-currency documents (M5c).** A VAT-registered company cannot approve a foreign-currency sale; it can prepare the draft.
3. **Tax point** is explicit or the issue date. The statutory derivation is not automated (DEC-028), and the credit-note VAT rule (DEC-029) is unverified.
4. **Deferred (DEC-026):** invoice rendering and sending, recurring invoices, quotes, line discounts, deposits before an invoice, refunds, bad-debt relief, write-offs and unallocating.
5. **No UI (M9).** Approval and reconciliation have no screens.
6. **Production gates unchanged:** privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance (numbering and posting are serialised per company and untested at volume).
