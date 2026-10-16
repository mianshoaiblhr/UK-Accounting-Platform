# V1 milestone M9c - acceptance package (bank, cash and reconciliation screens)

Prepared under the product owner's delegation (DEC-019, DEC-048..050). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `c0cad12` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in `45b2289` (plan section 13.3) |
| CI | CI_RESULT |
| CodeQL | **success**: run 38973214250 on `c0cad12` |
| Clean clone of `c0cad12` | install, build, typecheck, lint: exit 0; **1881 tests passed**; e2e **21/21**; OpenAPI drift 0 |
| Local runs | e2e **21/21** (V0 journeys 4, M9a 7, M9b 6, M9c 4) with the real worker; unit 248; typecheck and lint clean. No API change. The first local runs found one product fault, fixed before the push: the matched-lines list on the reconcile screen did not refresh after an action. The other failures were test-side (a wait for the VAT codes to load; two status messages on one screen) |

## 2. What M9c delivers (plan section 13.3)
| Screen (`/org/{org}/companies/{company}/...`) | API routes | Actions (shown only with the permission) |
|---|---|---|
| `bank` - bank accounts | `GET bank-accounts`, `GET accounts` | add one over a bank ledger account, with optional encrypted details and the account for bank charges (`bank:manage`) |
| `bank/{id}` - bank account | `GET bank-accounts/{id}`, `GET .../statement-lines`, `GET .../statement-imports`, `POST documents` + upload, `GET documents/{id}`, `POST .../statement-imports`, `GET statement-imports/{id}` | import a CSV statement, void an import with reason (`bank:manage`) |
| `bank/{id}/reconcile` | `GET .../suggestions`, `GET .../unmatched`, `GET .../reconciliation`, `GET .../reconciliations`, `GET .../statement-lines`, `GET statement-lines/{id}` | match from a suggestion or by choosing the pair, post a charge or interest from a line, undo a match with reason, sign off with the bank's closing balance (`bank:reconcile`) |
| `cash` - cash transactions | `GET cash-transactions`, `GET accounts`, `GET tax-codes` | record money in or out with VAT codes of its direction, reverse with reason (`cash:record`) |
| `bank/transfers` | `GET bank-transfers`, `GET accounts` | record a transfer between two bank or cash accounts, reverse with reason (`bank:transfer`) |

* **CSV import in the screen:** the file is uploaded as a document (through the API, or to the presigned URL the API returns in production), waits for the virus scan, then the import job runs in the worker; the screen shows its result and row errors. The browser reads only the header row, to offer the column names (guessed by name, changeable); the API parses the file.
* **Bank details:** sent once, stored encrypted by the API; the screens only ever show the API's mask (tested: neither the sort code nor the account number appears).
* **Reasons the API can ask for:** the M9b prompt now also covers a match whose dates are far apart (`override_reason_required`) and a statement file imported before (`statement_already_imported`), as well as possible duplicates and cash in hand below zero.
* **Display rule (DEC-048):** the proof, balances, unmatched totals and ageing are the API's figures.

## 3. Security and permission checks
| Check | Evidence |
|---|---|
| Full bank details never shown after entry (mask only) | `tests/e2e/bank.test.ts` |
| A reviewer reads bank accounts, lines, the proof and cash without any import form, match, post, sign-off or record control; the API refuses a match called directly (403) | `tests/e2e/bank.test.ts` |
| A bookkeeper (bank:manage) imports; an accountant (bank:reconcile, cash:record, bank:transfer) reconciles, records and transfers | `tests/e2e/bank.test.ts` |

## 4. Real-browser evidence (`tests/e2e/bank.test.ts`)
* A bookkeeper adds "Main account" over 1200 with the charges account 6800, then imports a two-line April statement through the screen; the worker imports 2 lines.
* An accountant records money in of 500.00 (the VAT list offers the sales code and not the purchase code); on the reconcile screen as at 30 April 2026 the receipt line is matched from its suggestion and the 5.00 bank charge is posted from its line; the proof shows statement 495.00, ledger 495.00, difference 0.00 (equal to the API's); the reconciliation is signed off against 495.00; a match is then undone with a reason and the line returns to the unmatched list.
* A transfer of 50.00 to cash in hand is recorded and reversed with a reason.

## 5. Compliance matrix
MATRIX_RESULT

## 6. Known limitations and gates
1. Editing or closing a bank account, attachments on cash transactions and cross-currency transfers stay API-only (or are not in the API).
2. The CSV header is split on commas to offer column names; a file with another delimiter is mapped by position through the API, not the screen.
3. The screens are functional, not designed; no accessibility audit beyond labelled controls.
4. In production the upload goes to S3 through the presigned URL: the bucket's CORS policy is part of the AWS gate (not applied).
5. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
