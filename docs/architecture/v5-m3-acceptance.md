# V5 milestone V5-M3 - acceptance package (the VAT return screens)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1).

The design is in DEC-092, recorded and pushed before code (`09f2821`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. The screens show what the API returns and compute nothing (DEC-048, DEC-071). **No screen submits to HMRC** (DEC-082, DEC-086).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| "Tax" group with "VAT returns" in the client workspace sidebar (`ledger:read`, feature `vat.returns`) | `apps/web/src/lib/workspace.tsx` |
| The list of returns and "Open the return for a period" (`vat:prepare`) | `apps/web/src/app/org/[orgId]/companies/[companyId]/vat-returns/page.tsx` |
| The return screen, laid out as the prototype: the nine boxes with drill-down to lines and the filed figures; checks against the ledger; review flags and their explanations; sign-off with names and lapsed steps; the client's approval; the filing record | `.../vat-returns/[returnId]/page.tsx`, `apps/web/src/components/vat/common.tsx` |
| API: each event of a return carries `byName` | `packages/accounting/src/vat-return.ts`, `docs/api/openapi.json` |

## 3. Screens and the routes each uses (DEC-050)
| Screen | Shows | Actions (permission) | API routes |
|---|---|---|---|
| VAT returns | Period, status, flags to explain, the lock | Open a return for a period (`vat:prepare`) | `GET/POST vat-returns` |
| A VAT return | The nine boxes and their lines; boxes as filed (once approved, by the verified rule); the reconciliation and its entries; flags; sign-off; filings | Mark as prepared (`vat:prepare`); explain a flag (`vat:prepare` or `vat:review`); record the review (`vat:review`); record the client's approval (`vat:review` and `period:lock`); record the filing (`vat:file`) | `GET vat-returns/{id}`, `POST .../prepare`, `.../flag-explanations`, `.../review`, `.../client-approval`, `GET .../package`, `GET/POST .../filings`; `GET contacts`, `GET documents` for the choices |

**What the screens choose themselves:** labels, box descriptions (HMRC's wording, as in the prototype), and which actions to offer from the person's permissions and the API's status. **What they do not compute:** no amount, status, flag, lapse or whole-pound figure.

## 4. Tests
* **Browser** (`tests/e2e/vat-return.test.ts`, 4 tests), over the real stack:
  * an accountant opens the quarter, sees box 1 at 220.00 and its two lines, the reconciliation difference -20.00 and two flags, prepares the return and explains both flags. The review button is not offered to them;
  * a partner reviews. An approval dated inside the period is refused in the API's words; they then record the approval (status "Approved by the client", box 6 filed as 1100) and record the filing ("liability posted");
  * a reviewer reads the return and its three sign-off steps, with no action;
  * with `vat.returns` off, the page says so.
* **API:** `tests/api/vat-return.test.ts` asserts `byName` on events.

## 5. Local runs
* Real-browser suite (every e2e file): 46 passed, 1 skipped (a test the suite skips by design, not one of these).
* `tests/api/vat-return.test.ts`, `tests/api/vat-filing.test.ts`, `tests/api/openapi.test.ts` and the unit project: 281 passed.
* Web typecheck and lint: clean.
* A full-page screenshot of an approved and filed return was checked against the prototype's layout. That check fixed two things: dates wrapping in the narrow tables, and an API notice that named internal decision numbers.

## 6. Known limitations
* The return screen does not show the client's VAT deadline (it needs `practice.management`). The deadline page shows it, and the filing marks it done.
* Documents and contacts are chosen from the first 100 of the client's.
* No simulated submission from the screen (an API route for testing the HMRC seam).
