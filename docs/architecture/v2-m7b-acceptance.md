# V2 milestone V2-M7b - acceptance package (the register screens)

**Status:** ACCEPTED under the delegation on 2026-10-22 (DEC-019, DEC-051). The evidence is below.

Prepared under the product owner's delegation (DEC-019, DEC-051). The design is in DEC-074 and v2-plan section 5k.3, recorded and pushed before code (b8d8445).

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. The screens show what the API returns; they compute no figure (DEC-048, DEC-071).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `2d53914f2c34d0a47ce57934fa06a26169d84d2b` (branch `claude/adoring-cori-mra6ze`) |
| CI | [run 39776060443](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39776060443): every job green (migrations from scratch; dependency audit and secret scan; build, lint, typecheck, unit, integration, e2e; terraform; real S3 protocol and ClamAV; images) |
| CodeQL | [run 39776060387](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39776060387): green |
| Clean clone | Fresh clone at 2d53914: install, build, typecheck and lint clean; 2,302 tests passed; e2e 32/32 (26 before this slice); OpenAPI drift 0 |
| Local runs | Web and repository typecheck and lint clean; e2e 32/32 (`tests/e2e/registers.test.ts` 6/6). No API code changed, so the unit and integration suites are unchanged (2,302) |

## 2. Screens and the routes each uses (DEC-050)
"Registers" sits in the company workspace, shown only while `accounts.production` is on and the person holds `ledger:read`. Each screen also has its own read permission:
* fixed assets and depreciation: `assets:read`;
* the others: `ledger:read`.

An action button shows only to a person holding the route's permission. A reversal, cancellation, closure or end asks for the reason the API requires.

| Screen | Shows | Actions (permission) | API routes |
|---|---|---|---|
| Fixed assets (`/registers`) | The register as at a date by class and asset, with its reconciliation to the ledger; the classes; the assets | Create a class; add an asset, as POSTED, LINKED (choosing the posting on the class's cost account) or TAKE_ON (`assets:manage`) | `GET fixed-asset-register`, `GET/POST fixed-asset-classes`, `GET/POST fixed-assets`, `GET ledger` (the postings to link) |
| Asset (`/registers/assets/{id}`) | Cost, accumulated depreciation, carrying amount, bases, charges, disposal, tax fields | Change the estimate; dispose; reverse the addition or the disposal; change the tax fields (`assets:manage`) | `GET fixed-assets/{id}`, `POST /estimate`, `/dispose`, `/reverse-addition`, `/reverse-disposal`, `/tax` |
| Depreciation (`/registers/depreciation`) | The API's preview to a date by asset; the runs | Post the run; reverse a run (`assets:manage`) | `GET depreciation-runs/preview`, `GET/POST depreciation-runs`, `POST depreciation-runs/{id}/reverse` |
| Adjustments (`/registers/adjustments`) | Accruals, accrued income, prepayments and deferred income with what is released; the release preview and runs; the year-end register with its reconciliation | Create an item; cancel it; post or reverse a release run (`accounts:prepare`) | `GET/POST year-end-items`, `POST /{id}/cancel`, `GET release-runs/preview`, `GET/POST release-runs`, `POST /{id}/reverse`, `GET year-end-register` |
| Provisions (`/registers/provisions`) | Each provision with its balance and movements; the movements report for a range | Create a provision; make, use or release (a movement); reverse a movement (`accounts:prepare`) | `GET/POST provisions`, `POST provisions/{id}/movements`, `POST provision-movements/{id}/reverse`, `GET provisions/report` |
| Closing journal (`/registers/close`) | The API's preview for a year: profit, lines, warnings, blockers, notice; the closes | Post the close when the API says it can be posted; reverse a close (`accounts:prepare`) | `GET year-end-closes/preview`, `GET/POST year-end-closes`, `POST year-end-closes/{id}/reverse`, `GET reporting-frameworks` (the default year) |
| Directors (`/registers/directors`) | The loan accounts; a statement for a range (opening, closing, most overdrawn, days overdrawn, review prompts, flags not evaluated, movements with category and running balance); the report; the firm's thresholds | Open an account; close one; set the thresholds (`accounts:prepare`) | `GET/POST director-loan-accounts`, `GET /{id}/statement`, `POST /{id}/close`, `GET director-loan-accounts/report`, `GET/PUT director-loan-thresholds`, `GET contacts` |
| Related parties (`/registers/related-parties`) | The parties; the transactions report for a range | Record a party; end one (`accounts:prepare`) | `GET/POST related-parties`, `POST /{id}/end`, `GET related-parties/report`, `GET contacts` |

**What the screens choose themselves:**
* which choices to offer: the accounts filtered by type, the contacts, and the postings on a cost account;
* which actions to offer, from the API's status and the person's permissions;
* the default range: the current calendar year;
* labels.

**What they do not compute:** no figure, balance, schedule, preview, reconciliation or flag.

## 3. Real-browser tests (DEC-050)
`tests/e2e/registers.test.ts` runs over the real stack on synthetic 2026 books built through the API: shares of 10,000.00, and laptops of 3,600.00 paid from the bank to office equipment. Six tests:

1. **Fixed assets:**
   * the accountant creates the OFFICE class (straight line, 36 months) and adds the laptops LINKED to the payment;
   * the register shows 3,600.00 and reconciles to the ledger;
   * a disposal dated 31.12.2025, before the laptops were in use, is **refused, with the API's words shown on the screen**, and the asset stays ACTIVE.
2. **Depreciation:** the API's preview to 31.12.2026 shows 1,200.00 (3,600 / 36 x 12). The run is posted and the laptops' carrying amount is 2,400.00.
3. **Adjustments and provisions:**
   * a 1,200.00 prepayment for October 2026 to September 2027 is released to 31.12.2026: the preview shows 300.00 (3 of 12 months), the run is posted and the year-end register reconciles;
   * a 500.00 provision is made, and its balance shows 500.00.
4. **Directors and related parties:**
   * a director's loan account is opened, and its statement shows the API's closing balance;
   * a related party is recorded and appears in the report.
5. **The closing journal:**
   * the preview for 2026 shows the API's profit, and the test checks it against the hand figure: a loss of 800.00, shown as -800.00. That is depreciation 1,200.00 plus the provision 500.00, plus insurance at a net credit of 900.00 (released 300.00 less the 1,200.00 the prepayment set-up credited to it);
   * the close is posted.
6. **A reviewer** opens all seven register screens and sees no action button.

The first run passed four of six:
* **Disposal:** the test filled the wrong "Reason" box (the change-of-estimate form's), so the browser blocked the disposal form. The lookup is now scoped to the disposal card.
* **Loan account:** the API correctly refused it because the synthetic director had no DIRECTOR appointment; the test setup now records one.

While re-reading the test, engineering also found that a comment stated the close's figure wrongly (a loss of 2,000.00). It now states the hand figure, -800.00, and the test asserts it.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| No action button for a reviewer on any register screen | `tests/e2e/registers.test.ts` |
| A refusal by the API is shown in its words (a disposal before use) | `tests/e2e/registers.test.ts` |
| The screens are behind `accounts.production` (the shell takes the feature, as in V2-M7a, whose e2e tests the feature off) | `tests/e2e/year-end.test.ts`, `apps/web/src/lib/workspace.tsx` |
| The API remains the only enforcement: no API change in this slice | `tests/api/*` unchanged |

## 5. Compliance matrix
V2 matrix v2.5. **V2-DOD-01 stays Missing** until V2-M7c, the reporting framework (DEC-071). Its note records the V2-M7b screens and their proof.

## 6. Known limitations
1. **The reporting framework has no screens yet** (V2-M7c): standards, versions, verification, thresholds, the framework of each year, overrides, the statutory preview and cash flow.
2. **No document picker for evidence.** Year-end items and provisions accept evidence documents through the API; the screens do not offer a picker yet.
3. **The default range is the current calendar year.** The person changes it on the screen; the screens do not read a company's financial year for the range.
4. **The contact list is the first 100 contacts.** A larger organisation needs a search, which the contacts API supports.
5. **Production gates unchanged:**
   * standard content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
