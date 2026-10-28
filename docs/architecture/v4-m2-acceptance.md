# V4 milestone V4-M2 - acceptance package (tax adjustments and the adjusted profit of a CT period)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1). The golden workings wait for the named accountant's review (DEC-056).

The design is in DEC-099, recorded and pushed before code (`4e7dff5`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic, and the rules in the tests are fixtures, not tax advice. **No tax is computed:** the statement is the profit adjusted for tax before capital allowances (V4-M3) and losses (V4-M4).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| Categories, request schemas and the rule arithmetic `ruleAdjustment` (exact, in minor units, half away from zero) | `packages/contracts/src/corporation-tax.ts` |
| Tables `ct_adjustment_rule` (an income or expense account, a category, a percentage, dates; verified once by a second person; immutable; superseded once; no overlap per account) and `ct_adjustment` (a manual adjustment of a period with evidence of the company; withdrawn once; never changed or removed); RLS, grants, retention | `packages/db/prisma/migrations/20260208000000_v4_ct_adjustments` |
| Service: rules (list, enter, supersede, verify), manual adjustments (list, enter, withdraw), the adjusted profit read from the ledger with drill-downs, problems and a fingerprint | `packages/accounting/src/corporation-tax.ts` |
| API: 8 operations behind `corporation.tax`, documented in the OpenAPI contract | `apps/api/src/tax/corporation-tax.controller.ts`, `docs/api/openapi.json` |
| The golden: a synthetic 12-month period, worked by hand with formulas | `tests/golden/v4-m2-adjusted-profit.json`, `docs/architecture/v4-m2-golden-workings.xlsx` (`scripts/docs/gen_ct_adjustments_golden.py`) |

## 3. The golden period (2027-01-01 to 2027-12-31)
| Line | Amount (GBP) |
|---|---|
| Accounting profit (the tax charge and a journal before the period left out) | 23,565.43 |
| Add: client entertaining (8000, 100%) | 1,234.57 |
| Add: depreciation (6900, 100%) | 3,000.00 |
| Add: professional fees from 1 July (6600, 25% of 2,000.00; the February fees are before the rule) | 500.00 |
| Add: a parking fine (manual, with evidence) | 350.00 |
| Deduct: a grant treated as not taxable (4100, 100%) | (800.00) |
| A manual deduction of 100.00, withdrawn | not counted |
| **Adjusted profit before capital allowances and losses** | **27,850.00** |

The workbook was recalculated in LibreOffice: every workings cell equals its expected cell (the "Check" row is TRUE).

## 4. Tests
* **Unit** (`packages/contracts/src/corporation-tax.test.ts`, 6 tests in all): the rule arithmetic (an expense added back, income deducted, rounding of half a penny either way, partial percentages, a zero-decimal currency) and the schema checks.
* **API and database** (`tests/api/ct-adjustments.test.ts`, 5 tests):
  * a rule is entered with `ct:prepare` and starts UNVERIFIED; a reviewer may not enter one; a balance-sheet account or the tax charge account is refused (`account_not_profit_and_loss`); overlapping rules of one account are refused;
  * a manual adjustment needs evidence of the same company (`invalid_evidence` for another company's document); a withdrawal keeps the adjustment, is made once, and the database refuses a change or removal;
  * the statement equals the golden to the penny, with the drill-down of a rule limited to its dates and the evidence of a manual adjustment; it lists each unverified rule and the unset associated companies as problems;
  * verification needs `tax:rule-verify` and a second person; once every rule is verified and the associated companies are set with a reason, nothing needs attention and the figures are unchanged;
  * a superseded rule gives way to its new UNVERIFIED version (the adjusted profit becomes 28,350.00 at 50%, with one problem); the database keeps rules as entered; every step is audited.

## 5. Local runs
* `tests/api/ct-adjustments.test.ts`: 5 passed (the first run stopped in setup: the test posted to the bank control account, which manual journals may not touch; it now uses the directors' loan account).
* `packages/contracts/src/corporation-tax.test.ts`: 6 passed.
* Unit and integration projects: 152 files, 2,579 tests, all passed on the first full run.
* Typecheck (every package) and lint: clean.

## 6. For the accountant (Shoaib)
Review `docs/architecture/v4-m2-golden-workings.xlsx`. It shows how the platform reads the ledger and applies each kind of adjustment. Whether a particular expense is disallowable is the firm's judgement, entered as a rule with its reason and verified by a second person. Provisions you may want to cite in rules:

| Matter | Provision | Link |
|---|---|---|
| Expenses not wholly and exclusively for the trade | CTA 2009 s 54 | https://www.legislation.gov.uk/ukpga/2009/4/section/54 |
| Capital expenditure not deductible | CTA 2009 s 53 | https://www.legislation.gov.uk/ukpga/2009/4/section/53 |
| Business entertainment and gifts | CTA 2009 ss 1298-1300 | https://www.legislation.gov.uk/ukpga/2009/4/section/1298 |
| Depreciation: replaced by capital allowances | CAA 2001; HMRC Business Income Manual BIM35000 | https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35000 |
| Provisions: deductible only when FRS 102 / IAS 37 compliant | HMRC Business Income Manual BIM46500 | https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46500 |

## 7. Known limitations (recorded in DEC-099)
* The statement is read from the ledger each time; V4-M4 stores the computation it approves.
* Rule adjustments apply to the account as a whole; a single disallowable item inside an otherwise allowable account is a manual adjustment.
* Closing journals are left out with the same list as the profit and loss account (`CLOSING_SOURCES`); the test does not post one.
