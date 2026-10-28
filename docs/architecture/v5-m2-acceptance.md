# V5 milestone V5-M2 - acceptance package (the VAT filing record)

**Status:** CI GREEN (section 1); acceptance under the delegation (DEC-019, DEC-086) waits only for the named accountant's review of the golden workings (sheet "Filing (V5-M2)").

The design is in DEC-091, recorded and pushed before code (`c99b353`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. **Nothing is sent to HMRC:** the platform records filings made elsewhere, and it simulates its own submission only through a fake adapter, which production refuses (DEC-082, DEC-086).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `c839dc3` |
| CI | [ci run 190](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40665265963) on `7f77217`, which contains it: every job green, including the real-browser tests and the image scans |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| Presentation methods, the whole-pound function, request schemas | `packages/contracts/src/vat-return.ts` (unit tests in `vat-return.test.ts`) |
| Permission `vat:file`; journal source `VAT_RETURN`; the VAT liability account on the VAT settings | `packages/contracts/src/permissions.ts`, `ledger.ts`, `vat.ts`; `packages/accounting/src/vat.ts` |
| Tables `vat_presentation_rule` (verified versions) and `vat_filing` (append-only, approved returns only, one recorded filing per return); the liability column; RLS, grants, retention | `packages/db/prisma/migrations/20260203000000_v5_vat_filing` |
| The HMRC VAT port and its fake adapter; `HMRC_VAT_ADAPTER` (`none` by default, `fake` refused in production) | `packages/adapters/src/hmrc-vat.ts`, `packages/core/src/config.ts` |
| Service: rules, the package, the recorded filing (liability journal, obligation DONE), the simulated submission | `packages/accounting/src/vat-filing.ts` |
| Drill-down from the liability journal to its filing | `packages/accounting/src/drilldown.ts` |
| API: 8 operations behind `vat.returns`, documented in the OpenAPI contract | `apps/api/src/ledger/vat-return.controller.ts`, `docs/api/openapi.json` |
| The draft presentation rule on the verifier's worksheet ("VAT presentation" sheet, step 7) | `docs/legal/rule-verification-worksheet.xlsx` |
| Golden workings of the filing quarter | `docs/architecture/v5-m1-golden-workings.xlsx`, sheet "Filing (V5-M2)" |

## 3. The rules and where each is proven (`tests/api/vat-filing.test.ts`, 15 tests)
| Rule (DEC-091) | Test |
|---|---|
| No package without a verified presentation rule; none of an unapproved return | "without a verified rule there is no package..." |
| A rule is entered with `vat:manage`, starts UNVERIFIED, is verified once by another person; versions do not overlap | "a rule is entered with vat:manage..." |
| Boxes 1 to 5 as approved; 6 to 9 in whole pounds by the method | "the package shows boxes 1 to 5 as approved..." (ROUND: 1001/401); "a superseding version..." (TRUNCATE: 1000/400) |
| A simulated submission records the fake receipt and changes nothing else; with no adapter the route answers `filing_not_available`; production refuses `fake` | "a simulated submission" (3 tests) |
| Recording needs `vat:file` and the liability account, which differs from the output and input accounts | "needs vat:file and the VAT liability account..." |
| Date not before the approval nor in the future; a 12-digit receipt; the declaration; the client's clean evidence | "refuses a date before the approval..." |
| The liability journal (Dr 2200 200.11 / Cr 1150 80.14 / Cr 2202 119.97) at the period end; the obligation DONE with the receipt; once only | "posts the liability journal at the period end..." |
| The journal carries no VAT; the ledger cannot reverse it; it drills to its filing | "the liability journal carries no VAT code...", "VAT_RETURN is corrected in a later return..." |
| A closed accounting period refuses the filing; nothing is written | "a filing whose liability journal falls in a closed accounting period..." |
| Filings are append-only and of approved returns only; rule versions are immutable | "the database keeps filings append-only..." |

The posting-rule coverage registry (`tests/rules/posting-rules.ts`) lists `VAT_RETURN` with a test in every category.

## 4. Golden workings
The "Filing (V5-M2)" sheet works the filing quarter from its two net amounts, with formulas: VAT per line, boxes 3 to 5, boxes 6 and 7 by both methods, and the journal and its balance. Recalculated, every working agrees with the platform. The 20% rate and the methods are synthetic test fixtures. The real presentation rule is entered and verified in the platform (worksheet step 7).

## 5. Security and permission checks
| Check | Evidence |
|---|---|
| Only a person files; `vat:file` is held by owner, admin and partner | RBAC probe in `tests/api/permissions.test.ts`; the migration's grants |
| The filing evidence must be readable by the recorder, of the same client and scanned clean | another client's document refused |
| No route reaches HMRC; the fake adapter cannot run in production | config test; `filing_not_available` with the default driver |
| New tables are classified, retained and protected from DELETE/TRUNCATE (filings also from UPDATE) | `tests/db/privileges.test.ts`, `classification.test.ts`, `retention.test.ts` |

## 6. Local runs
* Unit and integration projects: 2,458 of 2,460 passed on the first full run. The two failures were registry lists in `tests/platform/posting-rules.test.ts` that did not yet include the new `VAT_RETURN` source. They were updated in this commit and the file passes (6 tests).
* `tests/api/vat-filing.test.ts`: 15 passed.
* Typecheck (every package) and lint: clean.
* The golden workbook recalculated in LibreOffice: every working agrees.

## 7. Known limitations (recorded in DEC-091)
* No real HMRC adapter, no fraud-prevention headers, no HMRC obligations lookup (period keys).
* The VAT payment or repayment through the bank is recorded with the existing cash and bank tools; the platform does not match it to the filing yet.
* A zero return posts no journal (there is nothing to move).
* There are no screens yet (V5-M3).
