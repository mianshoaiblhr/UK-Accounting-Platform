# V1 milestone M9a - acceptance package (workspace screens)

Prepared under the product owner's delegation (DEC-019, DEC-048..050). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | BASELINE (branch `claude/adoring-cori-mra6ze`); decisions and specification recorded before code in `b428b35` |
| CI | CI_RESULT |
| CodeQL | CODEQL_RESULT |
| Clean clone | CLEAN_CLONE_RESULT |
| Local runs | LOCAL_RESULT |

## 2. What M9a delivers (plan section 13.1)
* **API:** `GET /organisations/{org}/companies/{company}/my-access` (DEC-049) returns the caller's effective permissions on the company, resolved as the guards resolve them, and every feature flag resolved for the organisation. Read-only; a company outside the caller's reach is 404. In OpenAPI. (The path `.../access` already lists company role grants, so the new one is `my-access`; recorded in DEC-049 before code.)
* **Screens** under `/org/{orgId}/companies/{companyId}`, all behind `bookkeeping.core`, each using only the routes listed:

| Screen | API routes | Actions (shown only with the permission) |
|---|---|---|
| Dashboard | `my-access`, `GET alerts` | - |
| Chart of accounts | `GET accounts` | `POST accounts`, `POST accounts/initialise` (`account:manage`) |
| Journals | `GET journals` | - |
| Journal | `GET journals/{id}/source` | - |
| Trial balance | `GET reports/trial-balance` | - |
| General ledger | `GET ledger` | - |
| Profit and loss | `GET reports/profit-and-loss` | - |
| Balance sheet | `GET reports/balance-sheet` | - |
| Periods | `GET periods` | close, reopen (`period:manage`); lock, unlock (`period:lock`) |

* **Display rule (DEC-048):** every amount, total, balance and reconciliation is the API's string; the screens add no money. The only arithmetic is a count of alert items on the dashboard.
* **Controls in the screen:** closing or locking shows the API's refusal (draft documents, unreconciled bank lines, unrevalued FX, suspense balance) and offers the acknowledgement that refusal names; reasons are passed through.
* **Navigation:** company names on the home page open the workspace; the workspace shows only the sections the person may read; with `bookkeeping.core` off it says so and calls no gated route.
* **Harness:** the real-browser setup moved to `tests/helpers/web.ts` (shared by the V0 and M9 browser tests); it rebuilds the web app when any web source is newer than the build, so a stale build cannot hide a new screen.

## 3. Security and permission checks
| Check | Evidence |
|---|---|
| `my-access` matches the guards: a permission it lacks is refused by the route itself; outside reach 404; another organisation 404 | `tests/api/my-access.test.ts` |
| A reviewer sees the books without any action button; the API refuses the action when called directly (403) | `tests/e2e/workspace.test.ts` |
| With `bookkeeping.core` off, the workspace shows no bookkeeping navigation | `tests/e2e/workspace.test.ts`, `tests/api/my-access.test.ts` |

## 4. Real-browser evidence (`tests/e2e/workspace.test.ts`; synthetic books built through the API)
* The owner opens the company from the home page; the dashboard shows cash or bank below zero = 1 and suspense = 0 as at 30 June 2026; the negative-cash alert (HIGH, account 1220) opens that account's ledger at -20.00.
* Journals list five entries; the rent payment opens its lines (6100, 250.00) and its source cash transaction.
* P&L 1 January to 30 June 2026: every line equals the API's (profit 330.00 = 600.00 - 250.00 - 20.00), reconciled; administrative expenses expand to their accounts. Balance sheet at 30 June balanced, trial balance balanced.
* Closing January to June is refused for the draft invoice with the API's message; the acknowledgement closes it (recorded as `acknowledgedDraftDocuments: 1`); locking without a reason shows the API's refusal, with a reason it locks.
* The owner adds account 6150 modelled on 6100.

## 5. Compliance matrix
MATRIX_RESULT

## 6. Known limitations and gates
1. M9b (sales and purchases) and M9c (bank, cash, reconciliation) screens are not built yet; V1-DOD-01 stays partial until they are.
2. The screens are functional, not designed: existing styles, no design system, usable at narrow widths but not tuned for mobile.
3. No accessibility audit beyond labelled controls and roles used by the tests.
4. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
