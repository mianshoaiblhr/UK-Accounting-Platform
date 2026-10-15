# V1 milestone M8h - acceptance package (hygiene before the screens)

Prepared under the product owner's delegation (DEC-019, DEC-046, DEC-047). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, including the 12.5% VAT rate and the exchange rates.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | BASELINE (branch `claude/adoring-cori-mra6ze`); decisions recorded before code in `DECISIONS_SHA` |
| CI | CI_RESULT |
| CodeQL | CODEQL_RESULT |
| Clean clone | CLEAN_CLONE_RESULT |
| Local full run | LOCAL_RESULT |

## 2. What M8h delivers (plan section 12a)
* **Customer default VAT code (DEC-046, V1-MOD-02).** Migration `20260118000000_v1_customer_default_tax_code` (additive): `customer_profile.default_tax_code_id`, a foreign key to the organisation's VAT codes and a trigger that admits only a sales or both-direction code that is not reverse charge. The API takes `defaultTaxCodeId` on customer role create and update (refused for suppliers) and returns it; changes are audited before/after. An invoice line without `taxCodeId` takes the default when it is written (create, or replacement of the lines); `taxCodeId: null` keeps no code; the stored line is explicit, so a later change of the default never alters a document. Credit notes are unaffected. Foreign-currency drafts are not given the default (VAT on them is M5c) and say so in their warnings.
* **Posting-rule coverage registry (DEC-047, V1-TEST-01).** `tests/rules/posting-rules.ts` names the positive, negative, reversal, VAT and period-lock test for each of the 21 journal sources; `tests/unit/posting-rule-coverage.test.ts` fails when a source, a category, a file or an exact test title is missing (a deliberate wrong title was shown to fail). Only eight cells are `n/a`, all reversals of mirrors or of credit and debit notes, and the test pins that list.
* **VAT only where the design has it.** The journal-source registry gains `vatCodes` (MANUAL, the four document sources, the two cash sources). The PostingService now refuses a VAT code on every other source (`vat_not_applicable`); until now the receipt, payment, transfer and allocation services simply never passed one.
* **Gap tests** (`tests/platform/posting-rules.test.ts`): every source refused in a closed period through its own service (14 sources had no such test) and in a locked one, with nothing written; allocations whose realised difference would land in a closed period refused; allocation FX journals final in the ledger; VAT refused for all 14 sources without `vatCodes`; every sub-ledger source refused on a control kind outside its list; a cash-receipt reversal mirroring its VAT lines at the same rate version and tax point (the workpaper nets to nil); the audit trail of every source module (every journal has its `journal.posted` event by the person; each sub-ledger action its own event).
* **Evidence re-checked against acceptance criteria, no code change:** V1-ARC-01, V1-POST-06, XP-07, V1-CTL-06.

## 3. Security and permission checks
| Check | Evidence |
|---|---|
| A customer's default VAT code is a sales code of the same organisation (database trigger and foreign key; service check) | `tests/db/contact-roles.test.ts`, `tests/api/sales.test.ts` |
| A supplier cannot take a default VAT code; a purchase code is refused on create and update | `tests/api/sales.test.ts` |
| Changing the default is audited with before/after and reason | `tests/api/sales.test.ts` |
| VAT codes refused on every source without `vatCodes`, before anything is written | `tests/platform/posting-rules.test.ts` |
| Every journal and every sub-ledger action is attributed to a person in the audit trail | `tests/platform/posting-rules.test.ts` |

## 4. Compliance matrix (v3.4; 113 rows: Implemented 102, Partially 8, Missing 3)
* **Now Implemented:** V1-MOD-02, V1-TEST-01, V1-ARC-01, V1-POST-06, XP-07, V1-CTL-06.
* **Still open, by owner:** V1-MOD-12 and the partial VAT rows V1-VAT-04/05/07 (the firm's qualified tax reviewer); V1-VAT-15 (M5c, needs the verified rule); MAN-ACC-09 (report mappings are versioned in code, not effective-dated in the database: a V2 statutory-accounts decision); V1-PRIV-01 (DEC-013 privacy review); V1-DOD-01, V1-CTL-03, V1-CTL-04, V1-BANK-05 (screens, M9).

## 5. Known limitations and gates
1. No supplier default VAT code (not required by V1-MOD-03); suppliers keep the default expense account.
2. The registry proves that named tests exist, not what they assert; the titles and this package say what each proves, and review of the registry is part of accepting a new journal source.
3. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
