# V2 milestone V2-M7a - acceptance package (the year-end workspace screens)

**Status:** ACCEPTED under the delegation on 2026-10-21 (DEC-019, DEC-051). The evidence is below.

Prepared under the product owner's delegation (DEC-019, DEC-051). The design is in DEC-071 and v2-plan section 5k, recorded and pushed before code (760daaf).

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. The screens show what the API returns; they compute no figure, state or fingerprint (DEC-048 applied to V2).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `23b366fdaf7c16c353fa019e60a55a23ac6cedf1` (branch `claude/adoring-cori-mra6ze`) |
| CI | [run 39660002000](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39660002000): every job green (migrations from scratch; dependency audit and secret scan; build, lint, typecheck, unit, integration, e2e; terraform; real S3 protocol and ClamAV; images) |
| CodeQL | [run 39660002001](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39660002001): green |
| Clean clone | Fresh clone at 23b366f: install, build, typecheck and lint clean; 2,302 tests passed; e2e 26/26 (21 before this slice); OpenAPI drift 0 |
| Local runs | Web typecheck and lint clean; repository typecheck and lint clean; e2e 26/26 (`tests/e2e/year-end.test.ts` 5/5). No API code changed, so the unit and integration suites are unchanged (2,302) |

## 2. Screens and the routes each uses (DEC-050)
Every screen sits in the company workspace under "Year end", which shows only while `accounts.production` is on and the person holds `ledger:read`. Each screen reads with `ledger:read`. An action button shows only to a person holding the route's permission, and the API enforces every route.

| Screen | Shows | Actions (permission) | API routes |
|---|---|---|---|
| Year end (`/year-end?year=`) | The years from the reporting frameworks, with the version and whether the year is approved and locked; the 14 steps with control, state, dependencies and sign-offs; the current step | Sign off or reopen steps 1 to 11 (`accounts:prepare`), only while the year is not locked; steps 12 to 14 link to Approval | `GET reporting-frameworks`, `GET year-end-workflow`, `POST year-end-workflow/sign-off`, `POST year-end-workflow/reopen` |
| Review (`/year-end/review?year=`) | The nine controls with status and what they need; each flag with its subject, figures, state, lapse and responses; whether the checklist is complete; the review settings and their notice | Explain (`accounts:prepare`); sign off or reopen (`accounts:review`); save the settings with a reason (`accounts:prepare`) | `GET review-checklist`, `POST review-flags/explain`, `POST review-flags/sign-off`, `POST review-flags/reopen`, `GET/POST review-settings` |
| Accounts (`/year-end/accounts?year=`) | The accounts document: complete or not, problems, notices (a PREVIEW ONLY notice in red), the profit and loss account, the balance sheet, the cash flow statement when present, the sections with their text and tables, and omitted items; the facts; the size test | Set a fact with a reason (`accounts:prepare`); the approving director is chosen from the company's directors | `GET accounts-document`, `GET/POST accounts-facts`, `GET size-test`, `GET officers` |
| Approval (`/year-end/approval?year=`) | Steps 12 to 14 with state and control; the fingerprint of the accounts as they stand; the partner reviews (live or lapsed); the client approval; the package summary | Record the partner review (`accounts:review`). Record the client approval (`accounts:review` and `period:lock`), choosing the director from the officers and the evidence from the company's documents. Generate the package (`accounts:prepare`). View the package and save its JSON exactly as stored | `GET accounts-approval`, `POST accounts-approval/partner-review`, `POST accounts-approval/client-approval`, `GET/POST accounts-package`, `GET officers`, `GET documents` |

**What the screens choose themselves:**
* which action buttons to offer, from the API's state and the person's permissions;
* labels;
* the order of the API's lists as returned.

**What they do not compute:** no screen adds, compares or derives a figure, state, fingerprint or verdict.

**Shared parts:**
* the workspace shell takes a `feature` and says "Accounts production is not enabled" when it is off;
* the year chooser keeps the year in the address;
* notices are shown in the API's words.

## 3. Real-browser tests (DEC-050)
`tests/e2e/year-end.test.ts` runs over the real stack: Next.js production build, NestJS, Postgres, Redis and the worker. It uses the V2-M6c golden company (DEC-070), built through the API up to the review. Five tests:

1. **Review:**
   * the accountant explains the bank flag (RC-08) and sees no "Sign off" button;
   * the partner signs it off;
   * the settings show the API's values.
2. **Accounts:**
   * the document shows "not complete";
   * the accountant sets the employees fact in the browser;
   * the document becomes complete and shows the API's wording (the employees note and the approval statement), the balance sheet and the size test.
3. **Workflow, approval and package:**
   * steps 1 to 10 are signed off through the API;
   * the partner signs off step 11 in the browser, then is **refused as partner reviewer, with the API's words shown on the screen**;
   * the owner records the review and closes the period on the periods screen;
   * the partner records the client approval, choosing the director, the date and the evidence, and the year shows as approved and locked;
   * the accountant generates the package, and its SHA-256 on screen equals the API's;
   * the workflow says every step is done and offers no action.
4. **A reviewer** opens all four screens and sees no action button.
5. **With `accounts.production` off,** the page says so and the navigation has no "Year end".

All five passed. The first run failed twice, both from test or display issues, not from the API:
* Next.js's own route announcer also has the alert role, so the refusal check is now scoped to the page's main area.
* The year bar's "approved and locked" badge read the framework list loaded before the approval. The approval and workflow screens now pass their own lock state to it, so the badge follows the API's answer after the action.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| No action button for a person without the route's permission (the reviewer role on all four screens; the accountant without `accounts:review` on a flag) | `tests/e2e/year-end.test.ts` |
| A refusal by the API is shown in its words (the second-person rule of the partner review) | `tests/e2e/year-end.test.ts` |
| With the feature off, no V2 page renders its content or calls a V2 route, and the navigation hides "Year end" | `tests/e2e/year-end.test.ts` |
| The API remains the only enforcement: every route keeps its guards and the API test suites are unchanged | `tests/api/*` |

## 5. Compliance matrix
V2 matrix v2.4. **V2-DOD-01 stays Missing** until V2-M7b (the registers) and V2-M7c (the reporting framework) are accepted (DEC-071). Its note records the V2-M7a screens and their proof.

## 6. Known limitations
1. **Screens are not yet built for:**
   * the registers: fixed assets, year-end adjustments, the closing journal, director loan accounts and related parties (V2-M7b);
   * the reporting framework and rule administration: standards, versions, verification, thresholds, the framework of each year, overrides, the statutory preview and cash flow (V2-M7c).
   Those still work through the API.
2. **The accounts are shown as data:** statements, wording and tables, not as a formatted set of accounts. A rendered PDF and iXBRL are V3.
3. **No screen for review history:** the review screen lists only the flags raised now. Resolved flags and their history stay in the API response and are not shown.
4. **The package is saved as JSON exactly as stored.** There is no human-readable package document yet.
5. **Production gates unchanged:**
   * standard content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
