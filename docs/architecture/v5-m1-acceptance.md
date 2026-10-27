# V5 milestone V5-M1 - acceptance package (the VAT return)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1) and the named accountant's review of the golden workings (section 4).

The design is in DEC-090 and `docs/architecture/v5-plan.md`, recorded and pushed before code (`53c88b5`). This is milestone evidence only, **not production approval** (DEC-085 sets the go-live checklist). All data is synthetic. Nothing is filed: there is no HMRC connection (DEC-082, DEC-086).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 7 |

## 2. What was built
| Part | Where |
|---|---|
| Statuses, events, flag kinds, the status rule and request schemas | `packages/contracts/src/vat-return.ts` |
| Permissions `vat:prepare`, `vat:review` (company) | `packages/contracts/src/permissions.ts` |
| Feature flag `vat.returns` | `packages/contracts/src/features.ts` |
| Tables `vat_return` (frozen once approved) and `vat_return_event` (append-only, second-person review); the period lock on `journal_line`; forced RLS, grants, retention | `packages/db/prisma/migrations/20260202000000_v5_vat_return` |
| Service: open, prepare, explain a flag, review, client approval; the fingerprint and the flags | `packages/accounting/src/vat-return.ts` |
| The posting refusal in a locked VAT period (and the shared advisory lock the approval takes exclusively) | `packages/accounting/src/posting.ts` step 9b |
| API: 7 operations behind `vat.returns`, documented in the OpenAPI contract | `apps/api/src/ledger/vat-return.controller.ts`, `docs/api/openapi.json` |
| Golden workings of the synthetic quarter (formulas over the lines) | `docs/architecture/v5-m1-golden-workings.xlsx`, `scripts/docs/gen_vat_return_golden.py` |

## 3. The rules and where each is proven
| Rule (DEC-090) | Service | Database | Test |
|---|---|---|---|
| A return per client and VAT period, from the VAT settings; linked to the VAT obligation | `create` | unique (company, period start) | `tests/api/vat-return.test.ts` |
| The fingerprint changes when the ledger changes; a preparation lapses | `state`, `vatFingerprint` | | "a later posting into the period..." |
| Flags: reconciliation difference, superseded rate, repayment, zero return, late posting | `vatFlags` | | late posting and reconciliation in the API test; all five kinds in the code |
| Every flag explained on the live fingerprint before review | `review` | | "every flag is explained before review" |
| The reviewer is not the preparer | `review` | `vat_return_event_guard` | service and database, "a second person reviews" |
| Client approval: vat:review and period:lock, date after the period and not in the future, the client's contact, the client's clean evidence | `clientApproval` | | "the client's approval needs..." |
| Approval freezes the return and locks the period; the obligation moves to READY | `clientApproval` | `vat_return_guard`, `jl_vat_period_lock_trg` | "the approved period is locked...", "the database guards..." |
| Events are append-only; returns are never deleted | | triggers, revoked privileges | `tests/db/privileges.test.ts`, "the database guards..." |
| Every step is audited | `audit` | | audit actions in order |
| The routes are behind `vat.returns` | `@RequireFeature` | | "with the flag off the routes say so" |

## 4. Golden workings (for the named accountant)
`docs/architecture/v5-m1-golden-workings.xlsx` traces each box of the synthetic quarter to its lines with formulas, and states the reconciliation and the flags. Recalculated, every working agrees with what the platform returned (boxes 1 220.00, 3 220.00, 4 80.00, 5 140.00 payable, 6 1100.00, 7 400.00; reconciliation difference -20.00). The "Sign-off" sheet is for the accountant's review (the DEC-054 pattern). The rate and box mappings are synthetic fixtures, not the UK rules: those are verified in the platform by the named verifier (DEC-083).

## 5. Tests
* **API** (`tests/api/vat-return.test.ts`, 14 tests): permissions per role; opening, the linked obligation, the duplicate refused; preparing and lapsing; the flags and their explanations; second-person review in the service and the database; every refusal of the client approval; the lock on posting; the frozen return; the database guards; the feature flag.
* **RBAC matrix** (`tests/api/permissions.test.ts`): two new probes across every system role.
* **Database** (`tests/db/privileges.test.ts`, `tests/db/classification.test.ts`, `tests/db/retention.test.ts`): the two tables have no DELETE or TRUNCATE (events no UPDATE), are classified and carry their retention.

## 6. Security and permission checks
| Check | Evidence |
|---|---|
| Only a person acts on a return (not AI) | `need` in the service |
| Reading needs `ledger:read`; a client viewer cannot read | `tests/api/vat-return.test.ts` |
| Approval evidence must be readable by the recorder, of the same client and scanned clean | `tests/api/vat-return.test.ts` (another client's document refused) |
| A posting and an approval cannot interleave: the approval takes the company's VAT advisory lock exclusively, postings with VAT lines take it shared | `packages/accounting/src/vat-return.ts`, `packages/accounting/src/posting.ts` |

## 7. Local runs
* Unit and integration projects: 2,424 of 2,427 passed on the first run. The three failures:
  * the version-boundary regression test, which still forbade the VAT-return tables; widened for V5-M1 (DEC-090) in this commit;
  * two MFA tests, which timed out while a second test run shared the database. Rerun alone, the three files pass (49 tests).
* `tests/api/vat-return.test.ts`: 14 passed.
* Typecheck (every package) and lint: clean.
* The golden workbook recalculated in LibreOffice: every working agrees.

## 8. Known limitations (recorded in DEC-090)
* Nothing is filed and nothing is paid: the filing record, whole pounds in boxes 6 to 9 and the liability journal are V5-M2.
* There are no screens yet (V5-M3).
* Only the standard scheme (M4b); partial exemption is not handled; the firm's input-to-output threshold is not set.
* A correction to a locked period goes into a later return; the platform does not yet propose the error-correction entry.
