# V3 milestone V3-M2 - acceptance package (the iXBRL document and its validation)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1) and the named accountant's review of the golden tagging (section 4).

The design is in DEC-094, recorded and pushed before code (`65e2ab8`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. Nothing is filed. **Full schema and taxonomy validation is not run in the platform:** it needs the FRC taxonomy files and an external validator, and it is a go-live step.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| The entity identifier scheme as data of the taxonomy version (frozen with it) | `packages/db/prisma/migrations/20260205000000_v3_ixbrl_document`, `packages/accounting/src/ixbrl.ts` |
| The builder (pure): facts from the package's lines, company details and preparer's facts; contexts and units; the XHTML document; the checks; the SHA-256 | `buildIxbrl` in `packages/accounting/src/ixbrl-document.ts` |
| Generation, listing and reading; append-only storage (`ixbrl_document`) | `IxbrlDocumentService`, same file |
| API: 4 operations behind `ixbrl.filing` (the document itself as `application/xhtml+xml`), documented in the OpenAPI contract | `apps/api/src/ixbrl/ixbrl.controller.ts`, `docs/api/openapi.json` |
| A test helper that builds the synthetic approved year with its package | `tests/helpers/approved-year.ts` |
| The sample document and its golden tagging | `docs/architecture/v3-m2-sample-ixbrl.xhtml`, `docs/architecture/v3-m2-golden-tagging.xlsx`, `scripts/docs/gen_ixbrl_golden.py` |

## 3. Tests (`tests/api/ixbrl-document.test.ts`, 6 tests)
* With no verified version, or a verified one without an entity scheme, generation is refused; superseding with the scheme makes it usable.
* Generation needs `accounts:prepare`; a year without a framework is refused; the first document is VALID and its SHA-256 is the SHA-256 of its content.
* The document is well-formed XML (`xmllint`); it carries the schema reference, the entity identifier with the version's scheme, the duration and instant contexts, the dimension member and the unit. The tagged turnover, net assets, company name, approval date and preparer's fact are those of the package; the stored counts equal the document's.
* The same package and mapping give the same SHA-256; a reader lists and reads; the database refuses changes.
* Two verified versions for the year: refused until one is named. A mandatory fact with no value and two different values for one concept and context make the document INVALID with those errors.
* The feature flag.

## 4. Golden tagging
`docs/architecture/v3-m2-golden-tagging.xlsx` lists the sample document's 3 contexts and 15 facts, each with its period, dimensions, unit, decimals and sign, and the figure the approved package states. Recalculated, all 15 agree. The concepts are synthetic test fixtures; the "Sign-off" sheet is for the named accountant.

## 5. Security and permission checks
| Check | Evidence |
|---|---|
| Only a person generates; it needs `accounts:prepare`; reading needs `ledger:read` | the service; the 403 in the test |
| The document reads the approved package only and writes no accounting record | `buildIxbrl` takes the package's content; the service writes only `ixbrl_document` and the audit event |
| Documents are append-only | `forbid_mutation` triggers; revoked privileges; `tests/db/privileges.test.ts` |
| Taxonomy concepts, namespaces, the entry point and the entity scheme come only from the verified version | `buildIxbrl`; a version may not reuse a prefix of the inline XBRL specification |

## 6. Local runs
* Unit and integration projects: 2,499 of 2,500 passed on the first full run. The one failure was the architecture rule that lists the modules allowed to read the reporting-framework tables; it now names the iXBRL document service, which only finds the year in order to read its approved package. The unit project then passes (382 tests).
* `tests/api/ixbrl-document.test.ts`: 6 passed.
* Typecheck (every package) and lint: clean.
* The golden tagging workbook recalculated in LibreOffice: all 15 facts agree with the package.

## 7. Known limitations (recorded in DEC-094)
* No schema or taxonomy validation in the platform (go-live step with the FRC taxonomy and an external validator).
* The accounts' tables in the text sections are not rendered in the document yet (shown as a placeholder); the statements are.
* Directors other than the approving director are not tagged.
* Comparatives of a company's first framework year are shown untagged.
