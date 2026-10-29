# V4 milestone V4-M4 - acceptance package (losses, the computation and the canonical CT600)

**Status:** PREPARED; acceptance under the delegation (DEC-019, DEC-086) follows a green CI run on the code baseline (section 1). The golden workings wait for the named accountant's review (DEC-056).

The design is in DEC-101, recorded and pushed before code (`a108998`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. The rates and limits in the tests are fixtures entered and verified in the test, not tax advice. **Nothing is filed**: the canonical CT600 is an internal model.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | recorded when CI has run |
| CI | recorded when CI has run |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| The arithmetic: `financialYearParts` and `computeCorporationTax` (pennies as integers): trading profit or loss; losses brought forward, carried back and forward; taxable total profits; profits apportioned to financial years by days; limits for short periods and associated companies; small profits rate, main rate or marginal relief per part | `packages/contracts/src/ct-computation.ts` |
| Permission `ct:approve` (owner, admin, partner) | `packages/contracts/src/permissions.ts`, the migration |
| Tables `ct_loss_opening` (losses brought forward at a date with evidence; verified by a second person; immutable; superseded once) and `ct_computation` (prepared as read; approved once by another person while current; never changed; superseded once; the neighbours' figures it used); RLS, grants, retention | `packages/db/prisma/migrations/20260210000000_v4_ct_computation` |
| Service: loss openings; the computation worked live with its problems, neighbours and fingerprint; prepare; approve (refused if the figures changed); the list with stale marks; the canonical CT600; turnover for the CT600 | `packages/accounting/src/ct-computation.ts`, `corporation-tax.ts` |
| API: 9 operations behind `corporation.tax`, documented in the OpenAPI contract | `apps/api/src/tax/corporation-tax.controller.ts`, `docs/api/openapi.json` |
| The golden, worked by hand with formulas | `tests/golden/v4-m4-computation.json`, `docs/architecture/v4-m4-golden-workings.xlsx` (`scripts/docs/gen_ct_computation_golden.py`) |

## 3. The golden
Rates (fixtures): main 25%, small profits 19%, limits £50,000 and £250,000, marginal relief fraction 3/200, no associated companies.

| | A: 2027 (12 months), before carry back | B: 1 Jan - 30 Jun 2028 (182 days) | A after B's carry back |
|---|---|---|---|
| Adjusted profit | 150,000.00 | (30,000.00) | 150,000.00 |
| Capital allowances | 20,000.00 (18% of 111,111.11) | 8,177.53 (18% x 182/365 of 91,111.11) | 20,000.00 |
| Trading profit / (loss) | 130,000.00 | (38,177.53) | 130,000.00 |
| Losses brought forward used | 10,000.00 | | 10,000.00 |
| Loss carried back | | 38,177.53 claimed to A | (38,177.53) from B |
| Taxable total profits | 120,000.00 | 0.00 | 81,822.47 |
| FY2026 part (90 days) | 29,589.04: tax 7,397.26 less relief 480.82 = 6,916.44 | | 20,175.40: 5,043.85 less 622.03 = 4,421.82 |
| FY2027 part (275 days) | 90,410.96: 22,602.74 less 1,469.18 = 21,133.56 | 0.00 | 61,647.07: 15,411.77 less 1,900.64 = 13,511.13 |
| **Corporation tax** | **28,050.00** | **0.00** | **17,932.95** |

Cross-check for A: a whole year at 25% less 3/200 x (250,000 - TTP) gives the same totals:
* 30,000.00 - 1,950.00 = 28,050.00;
* 20,455.62 - 2,522.66 = 17,932.95 (to the penny).

The workbook was recalculated in LibreOffice: all three Check rows are TRUE. The unit test caught one slip in the first draft of the golden: trading profit had been written before capital allowances. It was corrected to 130,000.00.

## 4. Tests
* **Unit** (`packages/contracts/src/ct-computation.test.ts`, 5 tests):
  * financial-year parts (across 1 April, and a leap-year 366-day year in one part);
  * the three golden results;
  * a carry back above the loss refused;
  * associated companies halving the limits (marginal relief appears at £50,000);
  * the small profits rate, the main rate and zero profits;
  * a loss carried forward with unused losses.
* **API and database** (`tests/api/ct-computation.test.ts`, 6 tests):
  * unknown losses brought forward are a problem until a loss opening is entered with evidence and verified by a second person; the database keeps the opening as entered;
  * A equals the golden, with turnover £200,000;
  * preparing:
    * the computation is prepared only as read (`fingerprint_mismatch`);
    * a reviewer may not prepare;
    * an accountant may not approve (`ct:approve`);
    * the owner approves;
  * the CT600 is refused before approval (`computation_not_approved`) and without a UTR (`utr_missing`), then carries the company, the UTR and the figures;
  * B: a carry back above the loss is refused; with the claim B equals the golden; the preparer may not approve their own computation (`self_approval_not_allowed`); an admin approves;
  * A's approved computation becomes stale. Prepared and approved again, A equals golden A2, and neither period is stale. The CT600s show the carry back on both sides;
  * a computation whose figures change after preparation is refused at approval (`computation_changed`); the database refuses a change or removal; every step is audited, in order.
* **RBAC matrix:** a new probe for `ct:approve` across every system role (623 tests pass).

## 5. For the accountant (Shoaib)
Review `docs/architecture/v4-m4-golden-workings.xlsx`. The provisions the computation follows:

| Matter | Provision | Link |
|---|---|---|
| Profits apportioned between financial years by time | CTA 2009 s 8(5); CTA 2010 s 1172 | https://www.legislation.gov.uk/ukpga/2009/4/section/8 |
| Small profits rate, limits, associated companies, marginal relief | CTA 2010 Part 3A, ss 18A-18N | https://www.legislation.gov.uk/ukpga/2010/4/part/3A |
| Trading losses carried back 12 months | CTA 2010 s 37 | https://www.legislation.gov.uk/ukpga/2010/4/section/37 |
| Trading losses carried forward | CTA 2010 ss 45, 45A | https://www.legislation.gov.uk/ukpga/2010/4/section/45A |
| Restriction on losses carried forward (not modelled) | CTA 2010 Part 7ZA, s 269ZB | https://www.legislation.gov.uk/ukpga/2010/4/part/7ZA |
| The company tax return | FA 1998 Sch 18 | https://www.legislation.gov.uk/ukpga/1998/36/schedule/18 |

## 6. Local runs
* `tests/api/ct-computation.test.ts`: 6 passed on the first run.
* `packages/contracts/src/ct-computation.test.ts`: 5 passed after the golden slip in section 3 was corrected.
* The architecture test named the new service as a reader of evidence documents. Its list was updated (46 passed).
* Unit and integration projects: 156 files, 2,623 tests, all passed.
* Typecheck (every package) and lint: clean.

## 7. Known limitations (recorded in DEC-101)
* All adjusted profit is trading profit: non-trading loan relationships, property income, chargeable gains and distributions are zero on the CT600.
* Not modelled:
  * the deductions allowance and the restriction on losses brought forward;
  * terminal loss relief;
  * group relief;
  * a carry back other than to the immediately preceding period lying wholly within the 12 months;
  * instalment payments;
  * R&D and other reliefs.
* The canonical CT600 uses named fields; the form's boxes and HMRC's schema are mapped in V4-M5.
