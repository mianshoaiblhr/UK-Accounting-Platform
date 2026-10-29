# V4 milestone V4-M5 - acceptance package (CT iXBRL and the HMRC submission)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1). The draft CT600 box map waits for the named verifier, and the CT computation taxonomy mapping is entered by the verifier (DEC-102).

The design is in DEC-102, recorded and pushed before code (`a962d8c`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. The box numbers and concepts in the tests are fixtures. **Nothing reaches HMRC:** the port's only adapter is a fake, refused in production.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| The canonical CT600 field list; the `CT600_FORM` rule kind (canonical fields only, each box once); the return schemas; permission `ct:file` (owner, admin, partner) | `packages/contracts/src/corporation-tax.ts`, `permissions.ts` |
| Two totals added to the canonical CT600 (tax at the rates, marginal relief), which the form shows in single boxes | `packages/accounting/src/ct-computation.ts` |
| The HMRC Corporation Tax port and its fake adapter. `HMRC_CT_ADAPTER` is `none` by default, and `fake` is refused in production | `packages/adapters/src/hmrc-ct.ts`, `packages/core/src/config.ts` |
| The builder of the computation as inline XBRL (pure; contexts for the period and each financial-year part; the UTR under the version's scheme) | `packages/accounting/src/ct-return.ts` (`buildCtIxbrl`) |
| Tables `ct_return` (the package frozen at creation; the path guarded in the database; one live return per computation; a second-person declaration) and `ct_return_event` (append-only); RLS, grants, retention | `packages/db/prisma/migrations/20260211000000_v4_ct_return` |
| Service: create (refused while anything needs attention), validate, authorise, submit (idempotent), read the status, record a return filed elsewhere; the CT return deadline on acceptance | `packages/accounting/src/ct-return.ts` |
| API: 9 operations behind `corporation.tax`, documented in the OpenAPI contract | `apps/api/src/tax/corporation-tax.controller.ts`, `docs/api/openapi.json` |
| The draft CT600 box map (UNVERIFIED), with a note for the verifier; the worksheet row and legal reference | `content/tax/drafts/uk-ct-rules.json`, `docs/legal/rule-verification-worksheet.xlsx` |

## 3. Tests
* **Unit:**
  * `packages/accounting/src/ct-return.test.ts` (2 tests):
    * a deterministic, well-formed document (xmllint) tagging each value in the period or its financial-year part;
    * the five refusals (a reserved prefix, no UTR, no scheme, an unknown key, a missing mandatory value);
  * `packages/contracts/src/corporation-tax.test.ts`: the box map takes canonical fields only, each box once.
* **API and database** (`tests/api/ct-return.test.ts`, 7 tests):
  * starting a return is refused with the reason while there is no verified CT-COMP taxonomy version;
  * it needs `ct:file`, and holds the CT600 with its boxes, the company and the UTR;
  * the tagged computation is served as XHTML, well-formed (xmllint), with the UTR as the entity identifier;
  * a second live return of the computation is refused;
  * validation; the declaration:
    * is refused for the validator and for a future date;
    * is recorded by the owner with a serving director and evidence;
  * submission is idempotent (the same submission id). The status is ACCEPTED with HMRC's reference (fake), with the five events in order. The CT_RETURN obligation of the period end becomes DONE with the reference, and a further return of the period is refused (`already_filed`);
  * the database refuses a change of what a return files, its removal, and a change of an event;
  * a UTR starting 99 is REJECTED with reasons. A new return of the same computation follows, and is recorded as filed elsewhere (refused with a future date);
  * production refuses the fake adapter; `none` is the default.
* **RBAC matrix:** a new probe for `ct:file` across every system role.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| No automatic submission: it needs AUTHORISED and a person's request | the service; `ctr2_submitted_ck` |
| The declaration is a second person's, from a serving director, with evidence | the service; `ctr2_authority_ck` |
| A return files an approved computation of its period, and what it files never changes | `ct_return_guard` |
| Returns and their events cannot be changed or removed | `ct_return_guard`, `forbid_mutation`, revoked privileges, `tests/db/privileges.test.ts` |
| Nothing reaches HMRC | the only adapter is a fake, refused in production |

## 5. For the verifier (Shoaib)
* **The CT600 box map** is in the draft pack. Check every box against the current form and guide, then supersede it with corrections and verify it. Fields left unmapped stop a return that has a value in them from starting: the loss fields and the per-year marginal relief.
  * HMRC CT600 (2015) version 3: https://www.gov.uk/government/publications/corporation-tax-company-tax-return-ct600-2015-version-3
  * FA 1998 Sch 18 (the company tax return): https://www.legislation.gov.uk/ukpga/1998/36/schedule/18
* **The computation's iXBRL mapping:** create a taxonomy version with standard code `CT-COMP` from HMRC's computation taxonomy (DPL/CT), with FACT entries keyed `ct.<field>`, and verify it. No draft is shipped, because the taxonomy was not read from this environment.

## 6. Local runs
* `tests/api/ct-return.test.ts`: 7 passed. The first run stopped at its first test, which read the problems from the wrong place in the error body (they are under `errors`); the later tests failed in a cascade. The test was corrected.
* `packages/accounting/src/ct-return.test.ts`: 2 passed on the first run.
* The architecture test named the new adapter factory and the new reader of evidence documents. Its lists were updated (46 passed).
* Unit and integration projects: 158 files, 2,648 tests, all passed.
* Typecheck (every package) and lint: clean.

## 7. Known limitations (recorded in DEC-102)
* There is no GovTalk envelope or HMRC XML schema, no real HMRC credentials, no amendments and no payment.
* The CT_RETURN obligation is closed only when its period end equals the CT period's end (a long accounts year has two CT returns).
