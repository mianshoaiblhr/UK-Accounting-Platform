# V1 milestone M9b - acceptance package (sales and purchases screens)

Prepared under the product owner's delegation (DEC-019, DEC-048..050). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `5854a0d` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in `3248338` (plan section 13.2) |
| CI | CI_RESULT |
| CodeQL | CODEQL_RESULT |
| Clean clone of `5854a0d` | CLEAN_CLONE_RESULT |
| Local runs | e2e **17/17** (V0 journeys 4, M9a workspace 7, M9b sales and purchases 6); unit 248; typecheck and lint clean. No API change, so the API suite and OpenAPI are unchanged from M9a |

## 2. What M9b delivers (plan section 13.2)
One set of components (`apps/web/src/components/subledger`) configured per side, because the sales and purchases APIs mirror each other (DEC-033).

| Screen (`/org/{org}/companies/{company}/sales` or `/purchases`) | API routes | Actions (shown only with the permission) |
|---|---|---|
| Documents | `GET sales/documents` / `GET purchases/documents`, `GET contact-roles` | - |
| New invoice / new bill | `GET contact-roles`, `GET accounts`, `GET tax-codes`, `POST sales/invoices` / `POST purchases/bills` | `*:manage` |
| Document | `GET .../documents/{id}`, `GET accounts`, `GET tax-codes` | approve (`*:approve`), discard (`*:manage`), full credit or debit note (`*:manage`) |
| Receipts / payments | `GET sales/receipts` / `GET purchases/payments`, `GET .../documents` (open items of the party), `GET accounts` | record with allocations, reverse an unallocated one (`*:approve`) |
| Aged receivables / payables | `GET sales/aged-receivables` / `GET purchases/aged-payables` | - |
| Statement | `GET sales/customers/{id}/statement` / `GET purchases/suppliers/{id}/statement` | - |

* **Customer default VAT code (DEC-046) on screen:** the customer's default is named on the new-invoice form; a line can take it ("customer default": the field is left out), have none (`null`) or name a code. Bills have no default: "no VAT code" leaves the field out.
* **Refusals that take a reason:** `possible_duplicate`, `credit_limit_exceeded` and `negative_cash` show the API's message and a reason box; the request is repeated with the reason in the field the API names. Every other refusal is shown as the API words it.
* **Draft warnings:** the API returns them when a draft is written; the document page shows them when the person arrives from the form.
* **Display rule (DEC-048):** totals, VAT, outstanding amounts, ageing and statement balances are the API's strings; the screens add nothing up.

## 3. Security and permission checks
| Check | Evidence |
|---|---|
| A bookkeeper (sales:manage, not sales:approve) drafts but sees no Approve button | `tests/e2e/subledger.test.ts` |
| A reviewer reads documents, receipts and payments without any action button or recording form; the API refuses the approval called directly (403) | `tests/e2e/subledger.test.ts` |
| Override reasons reach the API and are recorded on the document | `tests/e2e/subledger.test.ts` (the duplicate reason is shown back from the approved invoice) |

## 4. Real-browser evidence (`tests/e2e/subledger.test.ts`)
* A bookkeeper's invoice line takes the customer default VAT code (DEFS; the API stores it on the line) and the draft shows the API's warning (the code has no verified rate); no Approve button.
* An accountant approves an invoice of 500.00; an identical second one meets the duplicate refusal and is approved with a reason.
* A receipt of 500.00 into the bank allocated to the first invoice pays it; a full credit note on the second, once approved, leaves it 0.00 outstanding.
* With one invoice of 80.00 left open, the aged-receivables total and the customer statement's closing balance on screen equal the API's.
* A bill of 120.00 (supplier's number SUP-77) is approved; paying it from the empty cash box meets the negative-cash refusal and is recorded with a reason; the bill is paid.

## 5. Compliance matrix
No status changes: V1-DOD-01 stays partially implemented until the M9c bank, cash and reconciliation screens. Evidence added to V1-DOD-01.

## 6. Known limitations and gates
1. Editing a draft's lines after creation is API-only (discard and recreate in the screen); partial credit and debit notes and attachments are API-only; foreign-currency entry uses the API's defaults.
2. Contact roles are listed up to 100 per screen (no paging in the picker).
3. M9c (bank, cash, reconciliation) screens are not built yet.
4. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
