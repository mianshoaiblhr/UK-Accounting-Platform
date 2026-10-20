# V2 milestone V2-M5b - acceptance package (the size test)

**Status:** ACCEPTED under the delegation on 2026-10-20 (DEC-019, DEC-051). The evidence is below. Thresholds and wording remain unverified until Shoaib verifies them in the platform (DEC-052).

Prepared under the product owner's delegation (DEC-019, DEC-051). The split and the design are in DEC-066, recorded before code; DEC-065 records the product owner's read of the draft wording packs.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, and so are the limits the golden uses. The draft UK thresholds in `content/standards/drafts/uk-size-thresholds.json` were written from engineering's knowledge, were not retrieved from legislation.gov.uk, and are UNVERIFIED. Verifying them is the named accountant's work in the platform (DEC-052, DEC-056).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `2277775711ed1381a380429701e51ca968a940f1` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5f and DEC-066 |
| CI | [run 39362598139](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39362598139): every job green (migrations from scratch; dependency audit and secret scan; build, lint, typecheck, unit, integration, e2e; terraform; real S3 protocol and ClamAV; images) |
| CodeQL | [run 39362598131](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39362598131): green |
| Clean clone | Fresh clone at 2277775: install, build, typecheck and lint clean; 126 test files, 2,204 tests passed; e2e 21/21; OpenAPI drift 0 |
| Local runs | Build, typecheck and lint clean; 126 test files, 2,204 tests passed (before the push; 2,175 before this milestone) |

## 2. What V2-M5b delivers (v2-plan section 5f)
| Part | What it is |
|---|---|
| Threshold sets | Organisation data: a label, the financial years governed (by the date a year begins), micro, small and medium limits for turnover, balance-sheet total and average employees, the transitional "prior year on first year" rule, a source, notes, author and verifier.<ul><li>Created UNVERIFIED; verified once by a holder of `accounts:rule-verify` who is not the author; frozen after; changed by superseding.</li><li>Limits positive and nested; current sets never overlap.</li><li>The service and the database enforce the same rules.</li></ul> |
| The turnover line | A standard version names its turnover line, a P&L line, while unverified. It is checked when verified, frozen with the version, copied when superseded or copied, and the line cannot be removed while named |
| Figures of a year | Read from the year's own statutory statements (V2-M1):<ul><li>turnover from the turnover line, closing journals left out (DEC-060);</li><li>balance-sheet total as the sum of the balance-sheet accounts lines with a DEBIT natural side;</li><li>employees from the year's `employees.average` fact (V2-M5a).</li></ul>Unplaced accounts, a missing line or fact are reported |
| Conditions and status | Two or more of three, three-valued (a missing figure is unknown). A year that is not twelve months has its turnover limit adjusted by days, compared exactly. The two-consecutive-years rule per class: agreeing years decide, differing years carry the preceding status. The preceding year comes from the platform (recursively) or, for the earliest year, from two facts: `size.priorMet` and `size.priorStatus` (FIRST_YEAR for a company's first year) |
| Result | The class the company qualifies as (or LARGE, or UNKNOWN), whether the chosen entity size fits, whether every set used is verified, each year used with its figures, limits, conditions and the basis of each status, problems, and a notice that exclusions and groups are not tested |
| Draft thresholds | Two draft sets of the Companies Act 2006 limits (from 2016, and from 6 April 2025), importable as UNVERIFIED sets with the same script as the wording packs; on a "Size thresholds" sheet of `v2-draft-wording-review.xlsx` with a Verdict column. The wording packs now name their turnover line |
| API | 7 operations, all in OpenAPI and behind `accounts.production`:<ul><li>`size-threshold-sets` GET (`ledger:read`) and POST (`accounts:rules-manage`);</li><li>`size-threshold-sets/{id}` GET and PATCH;</li><li>`.../verify` (`accounts:rule-verify`, not the author) and `.../supersede`;</li><li>`size-test?yearStart` (`ledger:read`).</li></ul>The version PATCH takes `turnoverLineKey`; `accounts-facts` takes the two size facts |

**Migration:** `20260125000000_v2_size_test` (additive).
* The `size_threshold_set` table:
  * forced row-level security;
  * DELETE and TRUNCATE revoked;
  * a guard trigger for status, immutability and overlap;
  * checks for nesting, positive limits and verification by another person;
  * retention category ACCOUNTING_RECORDS.
* `reporting_standard_version.turnover_line_key`, with the version guard extended: frozen once verified, a P&L line when verified.
* Two typed fact keys on `accounts_fact`.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m5b-size.json` was written by hand before the code. `docs/architecture/v2-m5b-golden-workings.xlsx` recomputes every figure, limit, condition and status independently in Python (Decimal, exact fractions, calendar dates): 139 checks, 0 differences.

* **The company:** a synthetic company with framework years 2024, 2025, 2026 and a six-month 2027, on a verified synthetic version.
  * Turnover 25,000, 22,000, 28,000 and 16,000. The 2026 other income of 5,000 is left out.
  * Gross assets 8,000, 12,000, 14,000 and 14,000. Employees 2, 2, 3 and 4.
  * The years 2024 and 2025 are closed; the figures are unchanged.
* **The limits:** two verified synthetic sets. Set A governs 2020 to 2025. Set B governs from 2026 and tests the preceding year against itself for its first year.
* **Results:**
  * **2024:** SMALL. It meets the micro conditions, but the preparer's facts say the preceding year did not, so the preceding status carries. MICRO was chosen: **does not fit**.
  * **2025:** SMALL. It exceeds two micro limits; the status carries again.
  * **2026:** MICRO on both years, because set B tests 2025 against itself. Without that transitional rule it would be SMALL; the workbook proves this.
  * **2027:** a short year. The micro turnover limit is 14,876.71 (30,000 x 181/365), so 16,000 exceeds it. The conditions are not met, the status carries, and the company is still MICRO.
* **Without the earliest facts** (a second synthetic company): 2026 is still decided, because it needs no history; 2025 is UNKNOWN, with both missing facts named. With FIRST_YEAR, 2024 is MICRO on its own result.
* **Hand figures:** every figure and status matched on the first run of the code. Two of my own test expectations were wrong and were corrected:
  * the HTTP status of a refused request (the platform answers 422, not 400);
  * an 18-month example in a unit test (30,000 x 546/365 = 44,876.71, so 45,000 does exceed it).

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Only rules managers write threshold sets; the author cannot verify; a verified set is frozen and changed only by superseding; a superseded set is final; nested limits and non-overlap are refused in the service and the database | `tests/api/size-test.test.ts`, `tests/db/size-test.test.ts` |
| The turnover line is a P&L line, frozen with the version, protected from removal; the size facts are typed by the service (422) and the database | `tests/api/size-test.test.ts`, `tests/db/size-test.test.ts` |
| The test needs `ledger:read`; outsiders get 404; another organisation sees no sets and cannot write into this one; DELETE and TRUNCATE are revoked | `tests/api/size-test.test.ts`, `tests/db/size-test.test.ts`, `tests/db/privileges.test.ts` |
| Threshold sets have one writer; the size test reads and writes nothing; V2-ARC-01 widened to the size test reading a version's lines, recorded here | `tests/unit/architecture.test.ts` |
| The draft thresholds pass the API's schema, say they are unverified drafts, and import UNVERIFIED; the importer cannot verify them | `tests/unit/standard-packs.test.ts`, `tests/api/standard-packs.test.ts` |
| The new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v1.9 (61 rows: Implemented 30, Partially 3, Missing 28).
* **No row changes status.** The specification has no row of its own for the size test.
* **V2-MOD-13** (statutory statements) gains the size test's evidence. It stays Partially implemented until the cash flow statement is built (V2-M5c).
* **V2-TEST-01** gains the goldens of V2-M2 to V2-M5b.

## 6. Known limitations
1. **No verified thresholds.** The platform tests against whatever sets the named accountant verifies; none is verified yet. The draft UK sets are engineering's understanding, including the transitional rule, and must be checked against SI 2015/980 and SI 2024/1303.
2. **Not tested:**
   * exclusions: public companies, banking, insurance, e-money and investment firms, the micro-entity exclusions;
   * groups: the parent and group tests;
   * LLPs' own regulations, and charities.

   The result says so in a notice.
3. **Gross assets follow the version's layout.** The balance-sheet total is the sum of the debit balance-sheet lines as shown. A negative asset line (an overdraft left on a cash line) is counted as shown; the map should place it with the creditors.
4. **Facts at the earliest year.** The preceding year's status and conditions come from the preparer when the platform does not hold that year.
5. **Not in this milestone:**
   * the cash flow statement (V2-M5c);
   * using the result to gate approval or filing (V2-M6);
   * screens (V2-M7).
6. **Production gates unchanged:**
   * standard versions, wording and thresholds verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
