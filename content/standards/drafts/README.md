# Draft wording packs (DEC-064)

* `frs105-micro.json`: FRS 105, for micro-entities.
* `frs102-1a-small.json`: FRS 102 Section 1A, for small entities.

These are **engineering drafts**, written on 2026-10-19 at the product owner's instruction. They were written from engineering's knowledge: the FRC's and legislation.gov.uk's sites could not be reached from the build environment, so no text was retrieved. Every rule names the provision it is meant to reflect, with a note for the verifier. The review workbook is `docs/architecture/v2-draft-wording-review.xlsx`; regenerate it with `python3 scripts/docs/gen_wording_review.py`.

## Importing
Run the import as a person holding `accounts:rules-manage`:

    node scripts/standards/import-pack.mjs --api https://<host>/api/v1 --org <organisationId> --company <companyId> --token <bearer token> content/standards/drafts/frs105-micro.json

* The pack lands as an **UNVERIFIED** standard version. Nothing imports it automatically, and no migration seeds it.
* The tool never verifies.

## Verifying (DEC-052)
1. A holder of `accounts:rule-verify` who did not run the import checks each rule against the current text.
2. They correct or remove rules while the version is unverified.
3. They then verify it in the platform.

Until then, every document built from a pack is a preview marked unverified and is never complete.
