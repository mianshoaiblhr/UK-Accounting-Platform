# V4 milestone V4-M3 - acceptance package (capital allowances)

**Status:** CI GREEN (section 1); acceptance under the delegation (DEC-019, DEC-086) follows the named accountant's review of the golden workings (DEC-056), and the verifier's check of the draft rules.

The design is in DEC-100, recorded and pushed before code (`3b8dde9`). This is milestone evidence only, **not production approval** (DEC-085). All data is synthetic. The rates and limits in the tests are fixtures entered and verified in the test, not tax advice. **No rule is seeded:** the draft pack is imported through the API and lands UNVERIFIED.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `fd6f869` |
| CI | [ci run 207](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40789404387) on `a108998`, which contains it: every job green, including the real-browser tests and the image scans |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| Three CT rule kinds: `AIA_LIMIT`, `WDA_RATES`, `SMALL_POOL_LIMIT` | `packages/contracts/src/corporation-tax.ts` |
| The arithmetic: `computeCapitalAllowances` (pennies as integers; AIA in date order; pools; disposal values capped at cost; small pools; balancing allowances and charges; the fraction of a short period) | `packages/contracts/src/capital-allowances.ts` |
| Tables `ca_pool_opening` (a pool's written-down value at a date with evidence of the company; verified by a second person; immutable; superseded once; one current per pool and date) and `ca_computation` (a stored computation of a period with the prior one it opened from; never changed; superseded once; one current per period); RLS, grants, retention | `packages/db/prisma/migrations/20260209000000_v4_capital_allowances` |
| Service: openings (list, enter, supersede, verify); the computation worked live with its problems and fingerprint; storing as read; the list with stale marks | `packages/accounting/src/capital-allowances.ts` |
| API: 7 operations behind `corporation.tax`, documented in the OpenAPI contract | `apps/api/src/tax/corporation-tax.controller.ts`, `docs/api/openapi.json` |
| The draft pack: three rules added, each with a note for the verifier; the worksheet's legal references | `content/tax/drafts/uk-ct-rules.json`, `docs/legal/rule-verification-worksheet.xlsx` |
| The golden: two consecutive periods, worked by hand with formulas | `tests/golden/v4-m3-capital-allowances.json`, `docs/architecture/v4-m3-golden-workings.xlsx` (`scripts/docs/gen_capital_allowances_golden.py`) |

## 3. The golden
The fixtures are an AIA limit of £1,000,000, writing-down rates of 18% and 6%, and a small pools limit of £1,000.

**Period 1** (2027, 12 months, fraction 1). AIA: production line £900,000 in full, then £100,000 of the £300,000 packing machine; £200,000 goes into the main pool.

| Pool | Opening | Additions | Disposal values | WDA | BA | BC | Closing |
|---|---|---|---|---|---|---|---|
| Main | 10,000.00 | 205,000.00 | 2,500.00 (van sold for £3,000, cost £2,500) | 38,250.00 | | | 174,250.00 |
| Special rate | 2,000.00 | 30,000.00 | | 1,920.00 | | | 30,080.00 |
| Single: computer | | 4,000.00 | | 720.00 | | | 3,280.00 |
| Single: old machine | 3,000.00 | | 1,000.00 | | 2,000.00 | | 0.00 |

Allowances total £1,042,890.00 (AIA £1,000,000, WDA £40,890, balancing allowance £2,000); there are no charges. The artwork is listed as not qualifying.

**Period 2** (1 January to 30 June 2028, 182 days, fraction 182/365). The AIA available is £498,630.14, all given to the £600,000 robot cell; £101,369.86 goes into the main pool.

| Pool | Opening (from period 1) | Additions | Disposal values | WDA | BC | Closing |
|---|---|---|---|---|---|---|
| Main | 174,250.00 | 101,369.86 | 5,000.00 | 24,289.06 | | 246,330.80 |
| Special rate | 30,080.00 | | 30,000.00 (sold for £40,000, capped at cost) | 80.00 (small pool, limit £498.63) | | 0.00 |
| Single: computer | 3,280.00 | | 3,500.00 | | 220.00 | 0.00 |

Allowances total £522,999.20, and balancing charges £220.00. The workbook was recalculated in LibreOffice: both periods' Check rows are TRUE.

## 4. Tests
* **Unit** (`packages/contracts/src/capital-allowances.test.ts`, 4 tests):
  * both golden periods exactly, the second opening from the first's closings;
  * a negative pool as a balancing charge;
  * the opening schema.
* **API and database** (`tests/api/capital-allowances.test.ts`, 7 tests):
  * the computation is refused while a rule is unverified;
  * the problems name the missing openings and an asset with no tax category, which is then decided through the register;
  * openings:
    * need `ct:prepare` and evidence;
    * a single asset pool must name its asset;
    * there is one current opening per pool and date;
    * a mistyped one is superseded;
    * a second person verifies them, never the person who entered them;
    * the database refuses a change;
  * period 1 equals the golden:
    * a wrong fingerprint is refused;
    * a reviewer may not store it;
    * it is stored with no prior computation;
  * period 2 opens from the stored period 1 and equals the golden;
  * storing period 1 again supersedes it and marks period 2's computation stale. The database refuses a change or removal of a stored computation, and every store is audited;
  * a new AIA limit starting inside a period is refused (`ca_rule_change_in_period`).

## 5. For the verifier and the accountant (Shoaib)
Import the three new rules with `scripts/tax/import-ct-rules.mjs` and check each against its provision on the worksheet. Review the golden workbook.

| Rule | Draft | Provision | Link |
|---|---|---|---|
| `AIA_LIMIT` from 1 April 2023 | £1,000,000 | CAA 2001 s 51A(5); short periods s 51E | https://www.legislation.gov.uk/ukpga/2001/2/section/51A |
| `WDA_RATES` from 1 April 2019 | main 18%, special rate 6% | CAA 2001 s 56(1), s 104D | https://www.legislation.gov.uk/ukpga/2001/2/section/56 |
| `SMALL_POOL_LIMIT` | £1,000 | CAA 2001 s 56A | https://www.legislation.gov.uk/ukpga/2001/2/section/56A |
| Disposal values capped at cost | (built into the arithmetic) | CAA 2001 s 62 | https://www.legislation.gov.uk/ukpga/2001/2/section/62 |

## 6. Local runs
* `tests/api/capital-allowances.test.ts`: 7 passed. The first two runs stopped in setup on the register's own checks:
  * an asset class takes no residual value;
  * a taken-on asset needs its remaining life.
* `packages/contracts/src/capital-allowances.test.ts`: 4 passed on the first run.
* The architecture test named the new service as a reader of evidence documents. Its list was updated (46 passed).
* Unit and integration projects: 2,594 of 2,597 passed on the first full run. The three failures were database tests whose TRUNCATE lists did not yet name `ca_pool_opening`, which now references `fixed_asset`. They were updated and pass (47 tests).
* Typecheck (every package) and lint: clean.

## 7. Known limitations (recorded in DEC-100)
* First-year allowances (full expensing, the 50% special rate allowance) are not modelled. Neither are cars and private use, the structures and buildings allowance, cessation, AIA allocated other than by date order, or disclaiming allowances.
* A period across a change of rate or limit is refused, not apportioned.
* Category `AIA` is main-pool expenditure. AIA on special rate expenditure is not available until AIA allocation is a choice.
