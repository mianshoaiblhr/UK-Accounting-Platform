# V7 milestone V7-M2 - acceptance package (the practice overview and the client list)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline, recorded in section 1.

The design is in DEC-089, recorded and pushed before code (`b8324ff`). This is milestone evidence only, **not production approval** (DEC-085 sets the go-live checklist). All data is synthetic. The screens show what the API returns and compute nothing (DEC-048, DEC-071).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| The client manager on the compliance profile (optional, an active member; partial profile updates) | `packages/contracts/src/compliance.ts`, `packages/db/prisma/migrations/20260201000000_v7_client_manager` |
| The client list query (search, legal form, manager, cursor by name) | `clientListQuerySchema` in `packages/contracts/src/compliance.ts` |
| Service: open work by status and kind; the client list | `ComplianceService.work`, `ComplianceService.clients` in `packages/accounting/src/compliance.ts` |
| API: `GET compliance/work`, `GET compliance/clients`, documented in the OpenAPI contract | `apps/api/src/compliance/compliance.controller.ts`, `docs/api/openapi.json` |
| The practice shell (sidebar: organisation, Overview, Clients, Deadlines, the person) | `apps/web/src/components/PracticeShell.tsx` |
| Screens: the overview; the client list; the V7-M1 deadlines page moved into the shell | `apps/web/src/app/org/[orgId]/overview`, `apps/web/src/app/org/[orgId]/clients`, `apps/web/src/app/org/[orgId]/deadlines` |

## 3. Screens and the routes each uses (DEC-050)
| Screen | Shows | Actions (permission) | API routes |
|---|---|---|---|
| Overview (`/org/{org}/overview`) | The four counts; the deadlines overdue or due in 14 days with the API's status; open work by status and by kind; the connections as the decisions stand ("Not connected", DEC-082, DEC-086) | None | `GET compliance/summary`, `GET compliance/obligations?due=soon`, `GET compliance/work` |
| Clients (`/org/{org}/clients`) | Each readable client: name, company number, legal form, year end, VAT and its period, the next open deadline with the API's overdue flag, open and overdue counts, the client manager | Search, filter by legal form, "Only clients I manage", "Show more" (all read-only) | `GET compliance/clients` |

**What the screens choose themselves:** labels, the filter values sent, and when to ask for the next page. **What they do not compute:** no count, due date, overdue flag or next deadline. A search typed quickly shows only the answer to the latest request.

## 4. Tests
* **API** (`tests/api/practice-overview.test.ts`, 5 tests):
  * the manager is set with `compliance:manage` and a reason, must be an active member, and setting it keeps the confirmation date;
  * open work is counted over the readable clients only;
  * the list shows year end, VAT, next deadline, counts and manager;
  * an assigned accountant sees only their clients; search, legal form and manager filters narrow it;
  * cursor pages by name, and a bad cursor is refused.
* **Browser** (`tests/e2e/practice.test.ts`, 3 tests):
  * the overview shows the API's counts, the deadlines due soon, the work by status and "Not connected", with Overview marked current in the shell;
  * the client list shows each client's next deadline and overdue flag; search and "Only clients I manage" narrow the rows through the API;
  * a client viewer is told by the API that they may not read the deadlines.
* **V7-M1 browser tests** (`tests/e2e/compliance.test.ts`, 5 tests) pass with the deadlines page in the shell, including the feature switched off.

## 5. Security and permission checks
| Check | Evidence |
|---|---|
| The work counts and the client list include only clients where the caller holds `compliance:read` | `tests/api/practice-overview.test.ts` (assigned accountant) |
| The manager must be an active member of the organisation; setting it needs `compliance:manage` and a reason, and is audited | `tests/api/practice-overview.test.ts` |
| No new permission; the new routes sit behind `practice.management` | `apps/api/src/compliance/compliance.controller.ts`, `tests/api/feature-flags.test.ts` |
| The new column refers to `user` and is covered by the table's existing RLS and classification | migration `20260201000000_v7_client_manager`, `tests/db` |

## 6. Local runs
* `tests/api/practice-overview.test.ts`, `tests/api/compliance.test.ts`, `tests/api/openapi.test.ts`, `tests/api/permissions.test.ts`, `tests/db/privileges.test.ts` and the unit project: 921 tests passed.
* `tests/db`, `tests/api/retention.test.ts`, `tests/api/feature-flags.test.ts`: 566 tests passed.
* `tests/e2e/practice.test.ts` and `tests/e2e/compliance.test.ts`: 8 tests passed.
* Web typecheck and lint: clean.

## 7. Known limitations (recorded in DEC-089)
* Work in progress is the open obligations by status and kind, not the year-end workflow's stage per client.
* Services, the engagement and the anti-money-laundering status on the client list wait for V7-M3.
* Overdue tasks, filings and the review queue on the overview wait for the task and filing records (V7-M3, V5-M2).
* No HMRC or Companies House connection is built (DEC-082, DEC-086).
