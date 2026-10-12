# V1 milestone M4b - acceptance package (VAT foundation, standard VAT accounting)

Prepared under the product owner's delegation of 2026-10-12 (DEC-019..025). Milestone evidence only - **not production approval** (DEC-006). **The platform contains no VAT rate, code or box mapping**: each firm enters its own rules with their official source, and a different person holding `tax:rule-verify` verifies each version before it can be used (DEC-021, DEC-022). Development data, including every rate in the tests, is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `6fb1938` (branch `claude/adoring-cori-mra6ze`); later commits are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38311897860> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38311897755> - **success** |
| Clean clone of `6fb1938` | install, build, typecheck, lint exit 0; `pnpm test` **79 files, 1529 tests passed, 0 failed, 0 skipped** (M4a: 75 / 1458); e2e 4/4; no OpenAPI drift |
| Local full run | 81 files, 1545 passed, 0 failed (19 skipped: the real-S3/ClamAV infrastructure tests, which run in their own CI job) |

## 2. What M4b delivers (DEC-010, DEC-021, DEC-025; ADR-51, ADR-58; plan 6.2 and 6.4)
* **Rules as data:** `tax_code` (treatment STANDARD/REDUCED/ZERO/EXEMPT/OUTSIDE_SCOPE, direction SALES/PURCHASES/BOTH, reverse charge for purchases; immutable) and `tax_rate` versions (effective-dated; no overlap among current versions; official source URL, provision and retrieval date; nine-box mapping; UNVERIFIED until verified by another person with `tax:rule-verify`; changed only by supersession, which is UNVERIFIED again).
* **Scheme separate from treatment:** STANDARD implemented; CASH and FLAT_RATE registered and refused (service and database check).
* **Company VAT settings:** registration, VRN, registration date, return-period length and stagger, output and input VAT accounts.
* **VAT on postings:** a line with a VAT code gets the verified version covering its tax point; VAT exclusive or inclusive, per line half-up; visible VAT lines on the VAT accounts; reverse charge as equal output and input lines; credit notes as debits on sales codes. **Every VAT line is proven by the database at commit** (verified, current version of the right code covering the tax point; exact amount).
* **Workpaper:** nine boxes by tax point with drill-down, the verified rules used, and a reconciliation of the VAT accounts to the VAT lines with every difference explained. Labelled as a workpaper, not a return or submission.
* New API (flag `bookkeeping.core`): `tax-codes`, `tax-codes/{id}/rates`, `tax-rates/{id}/supersede|verify`, `vat-settings`, `vat/period`, `vat/workpaper`; journals accept `taxCodeId` per line, `amountsIncludeVat` and `taxPoint`.

## 3. Migration
`20260110000000_v1_vat_foundation` (additive): the three tables (forced RLS, no `DELETE`/`TRUNCATE`, `tax_code` without `UPDATE`), version guard (treatment fit, start UNVERIFIED, no overlap, verification once by another person, supersession once, immutability), journal-line VAT columns with all-or-none and link checks and a ban on VAT for foreign-currency lines, `journal_vat_check` at commit, permissions `vat:manage` and `tax:rule-verify`, retention rows (classification only).

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| `vat:manage` (owner, admin, partner, accountant) and `tax:rule-verify` (owner, admin; partners deliberately excluded by default) across roles; reading needs `ledger:read` | `tests/api/vat.test.ts`, `tests/api/permissions.test.ts` |
| An UNVERIFIED, superseded (except on reversals), wrong-code or out-of-date version, or a wrong VAT amount, cannot commit - even when the service is bypassed | `tests/db/vat.test.ts` (8) |
| Self-verification refused (service and database); verification evidence must be readable by the verifier (restricted documents included) | `tests/platform/vat.test.ts`, `tests/db/vat.test.ts` |
| Single writer of the VAT tables, which never posts a journal; VAT lines only through the PostingService | `tests/unit/architecture.test.ts` |
| Tenant isolation | `tests/db/vat.test.ts`, `tests/platform/vat.test.ts`, `tests/api/vat.test.ts` |

## 5. Tests for the new work
`tests/unit/vat-math.test.ts` (7: exclusive/inclusive boundaries, net + VAT = gross, return-period stagger incl. leap year, request rules), `tests/db/vat.test.ts` (8), `tests/platform/vat.test.ts` (16, including **all nine boxes against a hand-calculated synthetic scenario** and the reconciliation), `tests/api/vat.test.ts` (13); updated permission matrix, privileges, version boundary (now allowing exactly `tax_code`, `tax_rate`, `company_vat_setting`), architecture.

## 6. Compliance matrix (v2.5; 113 rows: Implemented 54, Partially 19, Missing 40)
Implemented: V1-VAT-01, -02, -03, -06, -08, -09, -10, -11, -12, -13, -14 and V1-POST-05. Partial: V1-VAT-04 (invoices/bills are M5/M6), -05 (credit-note linkage needs documents), -07 (tax point from supply/invoice/payment dates needs documents). **Missing by design:** V1-VAT-15 (VAT on foreign-currency journals refused until the rule is verified).

## 7. Defects found while building and testing, fixed before release
1. Foreign-currency conversion rebuilt journal lines and would have **dropped VAT codes silently**; VAT on foreign journals is refused before any conversion or rate is stored (tested, including that no rate row is created).
2. The supersede request intersected a strict schema and rejected its own `reason`.
3. Verification evidence was looked up without per-document visibility (caught by the architecture rule on document reads); it now uses the verifier's `canReadDocument`.

## 8. Known limitations and gates
1. **Rules are the firm's:** until a firm's reviewer enters and verifies its codes and rates, no VAT can be posted. Whether the platform's rounding (DEC-025) and the box mappings a firm enters are right for that business is verified by the firm, not asserted here; the primary sources could not be read in this sandbox (DEC-022).
2. No invoices/bills (M5/M6): no document-level rounding option, no tax point derived from document dates, no credit-note linkage.
3. No VAT on foreign-currency journals; no cash accounting or Flat Rate Scheme; no partial exemption or other special schemes; no presentation rounding of boxes 6-9; **no submission** (MTD is V5).
4. API only. Production gates unchanged (privacy/retention review DEC-013, security review, AWS apply and verification, real-volume performance).
