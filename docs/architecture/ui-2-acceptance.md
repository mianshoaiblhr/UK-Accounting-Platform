# UI-2 - acceptance package (closing the gaps between the screens and the approved design)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline. The design is in DEC-103, recorded and pushed before code (`7ad3fa6`). All data is synthetic.

## What changed
| Gap (screenshots of 2026-11-01 against the design artifact) | Now | Where |
|---|---|---|
| Amounts without thousands separators | Every amount in a numeric table cell, and the depreciation total, through one display helper that only inserts separators (no arithmetic, no rounding; DEC-048) | `apps/web/src/lib/format.ts`; 32 screens |
| No date or action on the overview | Today's date in UK form; "Add client" for a holder of `company:create`, linking to the existing form | `apps/web/src/app/org/[orgId]/overview/page.tsx`, `apps/web/src/app/page.tsx` |
| Work in progress by status | By stage (bookkeeping to ready to file), counted by the API over the readable clients | `GET compliance/work` `byStage` (`packages/accounting/src/compliance.ts`) |
| Connections said "not built yet" | Says what is true everywhere: no live connection, filings made elsewhere recorded, test stand-ins reach nobody | the overview |
| Screenshots from an empty test company | A named firm, six clients, deadlines in each state, one client ready to file | `tests/e2e/screens.test.ts`; `docs/design/screens/ui-2/` |

## Tests
* API: `tests/api/practice-overview.test.ts` checks the stages:
  * every client in Bookkeeping at first, only the readable ones for an assigned accountant;
  * an approved year with its package counts as Ready to file.
* Real browser:
  * the overview test checks the date, "Add client" and the stages table;
  * the register, VAT return, year-end and workspace tests check the amounts with separators.

  All 11 files pass (51 tests, 1 skipped by design).
* Unit and integration projects: 2,648 of 2,649 passed on the first full run. The failure was the architecture list of readers of the accounts year, which now names the compliance service (46 passed).
* OpenAPI regenerated (`byStage`); typecheck and lint clean.

## Still different from the design (each needs its own decision, DEC-103)
* the Tax and Firm sections of the practice sidebar (VAT across clients, Self Assessment, HMRC connection, team and roles);
* tasks ("New task");
* the deadline range tabs;
* dates shown as 2026-11-13 rather than 13 Nov 2026.

The date boxes in the screenshots read mm/dd/yyyy because the screenshot browser runs with a US setting; a UK browser shows dd/mm/yyyy.
