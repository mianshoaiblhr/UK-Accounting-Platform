# V3 milestone V3-M3 - acceptance package (the Companies House filing workflow)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1).

The design is in DEC-095, recorded and pushed before code (`08fbc7b`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. **Nothing reaches Companies House:** the port's only adapter is a fake, refused in production.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| Statuses and request schemas; permission `ixbrl:file` (owner, admin, partner) | `packages/contracts/src/ixbrl.ts`, `permissions.ts` |
| The Companies House port and its fake adapter; `CH_ADAPTER` (`none` by default, `fake` refused in production) | `packages/adapters/src/companies-house.ts`, `packages/core/src/config.ts` |
| Tables `ch_filing` (the path guarded in the database, one live filing per document, second-person authority) and `ch_filing_event` (append-only evidence); RLS, grants, retention | `packages/db/prisma/migrations/20260206000000_v3_ch_filing` |
| Service: create, validate, authorise, submit (idempotent), read the status, record a filing made elsewhere; the accounts deadline on acceptance | `packages/accounting/src/ch-filing.ts` |
| API: 8 operations behind `ixbrl.filing`, documented in the OpenAPI contract | `apps/api/src/ixbrl/ixbrl.controller.ts`, `docs/api/openapi.json` |

## 3. Tests (`tests/api/ch-filing.test.ts`, 8 tests)
* A filing starts as a DRAFT of one document. Starting one needs `ixbrl:file`; a second live filing of the same document is refused; a step out of order is refused; a reader lists.
* Validation by one person. The authority is recorded by another person: refused for the validator, a future date, a person who is not a serving director, and evidence of another client.
* Submission through the fake port carries the document's SHA-256 and the filing id as the idempotency key; a retry returns the same submission.
* Reading the status gives ACCEPTED with the reference; every move is in the events; the accounts deadline becomes DONE with the reference; a further filing of the same accounts is refused.
* The database keeps the path, the recorded facts and the events.
* Production refuses the fake adapter; with no adapter, submission answers `filing_not_available`.
* A rejection is final with its reasons; a new filing of the same document may follow and be recorded as filed elsewhere (refused with a future date).
* **RBAC matrix:** a new probe for `ixbrl:file` across every system role.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| No automatic submission: it needs AUTHORISED and a person's request | the service; `chf_submitted_ck` |
| The authority is a second person's | the service; `chf_authority_ck` (`authorised_by_user_id <> validated_by_user_id`) |
| Evidence is the company's own document, readable and scanned clean | `evidence_invalid` in the test |
| Filings and their evidence cannot be changed or removed | `ch_filing_guard`, `forbid_mutation`, revoked privileges, `tests/db/privileges.test.ts` |

## 5. Local runs
* Unit and integration projects: 2,520 of 2,523 passed on the first full run. The three failures were architecture lists that did not yet name the new code:
  * the adapter factory `createCompaniesHouse`;
  * the filing service as a reader of evidence documents (it applies the actor's `canReadDocument`);
  * the filing service finding the year end of its accounts.

  They were updated in this commit, and the unit project passes (383 tests).
* `tests/api/ch-filing.test.ts`: 8 passed.
* Typecheck (every package) and lint: clean.

## 6. Known limitations (recorded in DEC-095)
* No real Companies House adapter (software filing interface, presenter credentials); a status is read when a person asks.
* The accounts deadline is found by its kind and year end; a deadline entered with another period end is not closed automatically.
