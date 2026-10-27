# Draft deadline rules (DEC-088)

`uk-deadline-rules.json` holds five **engineering draft** deadline rules for the compliance calendar (V7-M1):
* annual accounts to Companies House;
* Corporation Tax payment;
* the Company Tax Return;
* the confirmation statement;
* VAT returns.

They were written from engineering's knowledge on 2026-10-27. legislation.gov.uk and gov.uk could not be reached from the build environment, so nothing was retrieved, and every rule is **UNVERIFIED**. No migration seeds them.

## Importing
Run the import as a person holding `compliance:rules-manage`:

    node scripts/compliance/import-deadline-rules.mjs --api https://<host>/api/v1 --org <organisationId> --token <bearer token> content/compliance/drafts/uk-deadline-rules.json

* Each rule lands as an **UNVERIFIED** version and generates nothing.
* The tool never verifies.
* Each rule's `verifierNote` stays in the pack; it lists what the rule does not model.

## Verifying (DEC-088, the DEC-021 pattern)
1. A holder of `compliance:rule-verify` who did not run the import checks each rule against the provision named in its source. The checks are the period, the month-end treatment, the legal forms and the dates it governs.
2. A wrong rule is superseded with a corrected version, which is UNVERIFIED again.
3. The verifier then verifies each rule in the platform.

Until then, generation reports every deadline as skipped (`rule_unverified`). The worksheet `docs/legal/rule-verification-worksheet.xlsx` lists the rules on its "Deadline rules" sheet.
