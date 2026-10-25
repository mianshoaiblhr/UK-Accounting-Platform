# UI-1 - acceptance package (the platform's visual system)

**Status:** Built and pushed. Acceptance waits on the CI, CodeQL and clean-clone evidence below

Prepared under the product owner's delegation (DEC-019). The plan is DEC-076 and `docs/design/visual-system.md`, recorded and pushed before code (ff85ed8). What building it refined is DEC-078 (section 9 of the plan). The dependency advisories found on the way are DEC-077.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. No figure, word or state a screen shows from the API has changed (DEC-048, DEC-071).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@COMMIT@@ (branch `claude/adoring-cori-mra6ze`) |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | Repository typecheck and lint clean; web production build clean; unit and integration 2,305 passed (2,302 before, plus the 3 DEC-077 guard tests); e2e 35 passed with `SCREENS_OUT` set (the 32 existing, the 2 visual checks and the screenshot run); contrast check 41 of 41 |

## 2. What changed
| Area | Change | Files |
|---|---|---|
| Type | Geist and Geist Mono, bundled from the `geist` package (1.8.2, SIL Open Font Licence). No font is fetched from a third party | `apps/web/package.json`, `apps/web/src/app/layout.tsx` |
| Tokens and rules | The stylesheet is rewritten, from 27 lines of defaults, to the plan's tokens, type scale, sheets, forms, buttons, pills, tables and ruled totals, in light and dark | `apps/web/src/app/globals.css` |
| Shell | The company workspace is an open plane. A 256px sidebar holds the product mark, the company and its base currency, the sections in four groups (Books, Reports, Money, Accounts production), and the person, Security and Sign out. The sidebar is outside `main`. On a phone it becomes a block at the top, with the sections as one scrolling row | `apps/web/src/lib/workspace.tsx`, `apps/web/src/components/Nav.tsx` |
| Sub-navigation | The year end's, the registers', the sales and purchases', and the bank's rows of links: the current one is ruled in ink, and there are no middle dots. Each is a named `nav` and keeps its test id | `components/yearend/year.tsx`, `components/registers/common.tsx`, `components/subledger/SideNav.tsx`, `components/bank/BankAccounts.tsx`, `app/login/page.tsx` |
| Ruled totals | A 1px ink rule over each total's figures, and a 3px double rule under the final total of a statement and the trial balance | `globals.css`; `components/Statement.tsx` (the disclosure button) |
| The one hue | The year end's current step is in signal blue, with `aria-current="step"` | `components/yearend/Workflow.tsx` |
| Contrast | 41 pairs, all at least 4.5:1, in light and dark | `scripts/docs/check_contrast.py` |
| Screenshots | 8 screens at 1440x900 and 390x844, before and after, over the real stack | `tests/e2e/screens.test.ts` (runs only with `SCREENS_OUT`), `docs/design/screens/before/`, `docs/design/screens/after/` |

## 3. Acceptance (DEC-076)
| Criterion | Evidence |
|---|---|
| The 32 existing e2e tests pass unchanged | No existing e2e test file changed (`git diff ff85ed8 -- tests/e2e` adds only `visual.test.ts` and `screens.test.ts`). The e2e project: 34 passed, 1 skipped (the screenshots). That is the 32 existing tests and the 2 new visual ones |
| The web typecheck, lint and production build | Clean (section 1) |
| The contrast check passes | `python3 scripts/docs/check_contrast.py`: failures 0 of 41 |
| Screenshots before and after, at 1440 and 390, over the real stack | `docs/design/screens/before/*.png` and `docs/design/screens/after/*.png` (16 each). The synthetic "Northwind Joinery Ltd" is built through the API |
| Keyboard focus visible; reduced motion respected | `tests/e2e/visual.test.ts`: the first Tab on the sign-in page lands on a field with a 2px solid outline. Under `reducedMotion: 'reduce'` a button's transition is 0s. The stylesheet defines no animation or transition, and its reduced-motion rule is a guard for later ones |
| CI green and a clean clone | Section 1 |

The same visual test also checks the shell:
* the Bookkeeping navigation is not inside `main`;
* Sign out is in the sidebar;
* the current section has `aria-current="page"`;
* the trial balance does not scroll sideways at 390 or 1440 wide.

## 4. Security and permissions
* **No route, permission check or action changed.**
  * The sidebar shows the same sections, under the same permission and feature rules, as the tab row it replaces (`SECTIONS` keeps each entry's permission and feature).
  * The reviewer tests still find no action button in `main`.
* **The font is served by the platform itself.** Neither a font request nor any other third-party request is added.
* **DEC-077, in this push** (its own commit, before this one):
  * `next` 15.5.28 fixes a critical remote code execution and a denial of service;
  * `body-parser`, `multer`, `undici`, `fast-uri` and `vitest` are updated;
  * the API refuses any request array over 5,000 items before validation, against Zod's unbounded issue list (GHSA-mrhx-c7xc-m3w5);
  * `pnpm audit --audit-level=high` passes, with only that advisory listed in the ignore list against its record.
  * the CI image scan (Trivy) flagged the same packages on the spec commit's run (ff85ed8, run 40225726782): `next`, `body-parser`, `multer`, `undici` and Zod's CVE-2023-54404. The updates fix all but Zod. `.trivyignore` lists Zod's two identifiers against DEC-077 and is mounted into the scan; nothing else is ignored.

## 5. Compliance matrix and migrations
* No requirement in the V2 matrix changes status; UI-1 is not a matrix milestone. The matrix stays at v2.5a: 59 Implemented, 1 Partially (V2-TEST-01) and 1 Missing (V2-DOD-01, until V2-M7c).
* No migration. No API contract changes, so no OpenAPI drift. The one API change is the DEC-077 refusal, inside the existing 422 `validation_error`.

## 6. Known limitations
* **The date fields** follow the browser's locale. The screenshots were taken in Playwright's default en-US, so they show mm/dd/yyyy. A UK browser shows dd/mm/yyyy, and the API always receives ISO dates.
* **Sideways scrolling on a phone:**
  * the sidebar's sections scroll sideways as one row;
  * wide tables (four or more columns) scroll inside their sheet. That keeps every figure whole, but a phone shows only part of a wide table at once.
* **Middle dots inside data lines stay**, such as a document's status and dates, or a bank account's summary. They are what the screens say, and the tests read them. Only the navigation rows lost theirs.
* **Dark mode** follows the system setting. There is no in-app switch. The dark screens were checked by contrast, not by screenshot.
* **Zod 4:** moving to it is not done here (DEC-077). The guard covers the advisory meanwhile.
* **Production:** this is not production approval, and no deployment is started (DEC-006).
