# V1 milestone M4a - acceptance package (customers and suppliers as contact roles)

Prepared under the product owner's delegation of 2026-10-12 (DEC-019..024). Milestone evidence only - **not production approval** (DEC-006); development data is synthetic (DEC-003).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `206b14d` (branch `claude/adoring-cori-mra6ze`); `7f8a647` is the feature commit, `206b14d` regenerates the OpenAPI file after the VAT-number fix |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38309510568> - **success** (all jobs: build/lint/typecheck/unit/integration/e2e, real S3 + ClamAV, audit + gitleaks, migrations-from-scratch, terraform validate, images with Trivy) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38309510685> - **success** |
| Clean clone of `206b14d` | install, build, typecheck, lint exit 0; `pnpm test` **75 files, 1458 tests passed, 0 failed, 0 skipped** (M3: 72 / 1415); e2e 4/4; no OpenAPI drift |
| Local full run (before the OpenAPI fix) | 1473 passed, 1 failed - the stale OpenAPI file, fixed in `206b14d` |

## 2. What M4a delivers (DEC-011, DEC-023, DEC-024; ADR-57; plan 6.1 and 6.3)
Customers and suppliers are **roles of the shared contact** per company (one contact may be both, and a customer of several companies of the organisation); role-specific profiles (customer: terms, credit limit, default currency; supplier: terms, default currency, default expense account, bank details); roles end with a reason and are never deleted; a counterparty VAT number on the contact (format check only); a **snapshot** of the counterparty for documents. **Supplier bank details** are field-encrypted (AES-256-GCM, AAD = role id), shown only masked in lists and audit, readable through one audited endpoint with `contact:bank-details`, and a change is UNVERIFIED until a **different person** verifies it. API under `/companies/{companyId}/contact-roles` (flag `bookkeeping.core`).

## 3. Migration
`20260109000000_v1_contact_roles` (additive): `contact.vat_number` (check `NOT VALID`), `contact_role`, `customer_profile`, `supplier_profile` (composite FK binds each profile to a role of the right kind; triggers freeze role identity, keep a company-linked contact in its company, enforce the bank-detail verification rules; forced RLS; no `DELETE`/`TRUNCATE`), permission `contact:bank-details` (owner, admin, partner, accountant), retention rows (classification only).

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Role x capability matrix incl. `contact:bank-details` (8 roles) | `tests/api/permissions.test.ts`, `tests/api/contact-roles.test.ts` |
| Bank details: ciphertext only at rest (no digits stored), mask in lists/audit, full view only with the permission and audited, second-person verification (service and database), reset on change, change-and-verify in one step refused | `tests/api/contact-roles.test.ts`, `tests/db/contact-roles.test.ts` |
| Role identity frozen; company-linked contact cannot take a role elsewhere; profiles bound to the right role kind and company; no delete for the runtime role or the owner | `tests/db/contact-roles.test.ts`, `tests/db/privileges.test.ts` |
| Single writer of the three tables and the only code that touches the ciphertext | `tests/unit/architecture.test.ts` |
| Company and tenant isolation (another company's path 404; assigned-elsewhere member 404; outsider 404; another organisation sees zero rows) | `tests/api/contact-roles.test.ts`, `tests/db/contact-roles.test.ts` |

## 5. Tests for the new work
`tests/api/contact-roles.test.ts` (12), `tests/db/contact-roles.test.ts` (8), `tests/unit/contact-roles.test.ts` (4: IBAN mod-97, bank-detail and VAT-number rules, role request rules); updated: permissions, privileges, regression boundary, architecture.

## 6. Compliance matrix (v2.4)
V1-CON-01, -03, -05 -> **Implemented**; V1-CON-02 and -04 -> **Partially implemented** (refusing to end a role with open documents, and storing the snapshot on documents, need documents - M5/M6).

## 7. Defects found by the new tests and fixed before release
1. The "ending needs a reason" check accepted a NULL reason (a CHECK constraint treats NULL as satisfied) - now explicit.
2. The EU branch of the VAT-number pattern also matched short GB numbers such as `GB12` - it now excludes GB/XI and needs 8-12 characters.
3. A duplicate account code was reported as a duplicate role - explicit case-insensitive check; the unique index remains the backstop.

## 8. Known limitations
Payments (M6) must refuse UNVERIFIED bank details - the status exists, the payment rule does not yet; no confirmation-of-payee or bank-account validation service (external, would need its own decision); VAT numbers are not validated with HMRC; the snapshot is not yet stored on documents; API only. Production gates unchanged.
