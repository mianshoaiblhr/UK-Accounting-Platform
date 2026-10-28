# Draft taxonomy mappings (V3-M1, DEC-093)

`frc-frs105.json` maps the FRS 105 micro-entity pack (`content/standards/drafts/frs105-micro.json`) and the company details to FRC taxonomy concepts.

* **It is an engineering draft, written without reading the taxonomy.** Every concept, namespace and the entry point is a proposal. The named verifier checks each against the FRC taxonomy files before use (DEC-083, DEC-093).
* **Import** it with `node scripts/ixbrl/import-taxonomy.mjs --api https://host/api/v1 --org <organisationId> --token <bearer> content/ixbrl/drafts/frc-frs105.json`. The importer needs `ixbrl:rules-manage`, and the version lands UNVERIFIED.
* **Verify** it in the platform. A holder of `ixbrl:rule-verify` who is not the importer corrects entries while the version is UNVERIFIED, then verifies it, which freezes it.
* **Notes for the verifier:** each entry's `verifierNote` stays in this file and on the worksheet (`docs/legal/rule-verification-worksheet.xlsx`, sheet "iXBRL mapping"); the platform stores the mapping only.
