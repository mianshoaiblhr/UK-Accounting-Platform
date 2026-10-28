# V3 milestone V3-M4 - acceptance package (the iXBRL and filing screens)

**Status:** ACCEPTED under the delegation (DEC-019, DEC-086) on 2026-10-28, on the green CI run recorded in section 1.

The design is in DEC-096, recorded and pushed before code (`c94daf2`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. The screens show what the API returns and compute nothing (DEC-048, DEC-071). **Nothing reaches Companies House:** the connection is a test stand-in, and the screen says so.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `217fd6c` |
| CI | [ci run 203](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40783514135) on `17d53a8`, which contains it: every job green, including the real-browser tests and the image scans |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| "Accounts filing" in the client workspace (Accounts production group, feature `ixbrl.filing`) | `apps/web/src/lib/workspace.tsx`, `apps/web/src/app/org/[orgId]/companies/[companyId]/filing/page.tsx` |
| The year chooser; the latest iXBRL document with its status, counts, SHA-256, errors and warnings, and a link to the document; "Generate the iXBRL document" (`accounts:prepare`) | `apps/web/src/components/filing/Filing.tsx` |
| The Companies House filing: the path with the current step marked, the reference or the rejection reasons, the events; actions by status and `ixbrl:file` (start, validate, the authority, submit, read the status, record a filing made elsewhere) | same file |
| "Taxonomy mapping" in the practice shell: the versions, a version's entry point, scheme, namespaces, entries and problems; "Verify this version" for a holder of `ixbrl:rule-verify` | `apps/web/src/app/org/[orgId]/taxonomy/page.tsx`, `apps/web/src/components/PracticeShell.tsx` |
| Notices written for users (no internal references) on the iXBRL document, the filing and the VAT package | `packages/accounting/src/ixbrl-document.ts`, `ch-filing.ts`, `vat-filing.ts` |
| Screenshots of both screens (synthetic data) | `docs/architecture/v3-m4-accounts-filing-screen.png`, `v3-m4-taxonomy-screen.png` |

## 3. Screens and the routes each uses (DEC-050)
| Screen | Actions (permission) | API routes |
|---|---|---|
| Accounts filing | Generate (`accounts:prepare`); start, validate, authorise, submit, read the status, record (`ixbrl:file`) | `GET reporting-frameworks`; `GET/POST ixbrl-documents`, `GET ixbrl-documents/{id}/content`; `GET/POST ch-filings`, `POST ch-filings/{id}/validate`, `/authorise`, `/submit`, `/status`, `/record`; `GET officers`, `GET documents` |
| Taxonomy mapping | Verify (`ixbrl:rule-verify`) | `GET ixbrl/taxonomy-versions`, `GET ixbrl/taxonomy-versions/{id}`, `POST .../verify`, `GET me` |

## 4. Tests (`tests/e2e/filing.test.ts`, 5 tests, real browser over the real stack)
* A reviewer reads the mapping with no verification; the owner verifies it (status VERIFIED); the practice shell marks the page.
* An accountant generates the document ("Checks passed", the link to the document); the filing is not offered to them.
* A partner starts and validates the filing and is refused the authority in the API's words ("someone other than the person who validated").
* The owner records the authority from the director, submits, reads the status: ACCEPTED with the reference, and five steps in the events.
* A reviewer reads the accepted filing with no action.

## 5. Local runs
* Real-browser suite (every e2e file): 51 passed, 1 skipped (a test the suite skips by design, not one of these).
* `tests/e2e/filing.test.ts`: 5 passed on the first run.
* Web typecheck and lint: clean.
* Full-page screenshots of both screens were checked against the visual system. That check rewrote the notices so they no longer name internal decision numbers.

## 6. Known limitations (recorded in DEC-096)
* Mapping entries are entered with the import tool or the API; the page reads them.
* The screen shows the latest document of the year; earlier documents are listed by the API.
* Documents for evidence are chosen from the first 100 of the client's.
