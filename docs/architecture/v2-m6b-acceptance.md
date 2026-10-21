# V2 milestone V2-M6b - acceptance package (the 14-step year-end workflow)

**Status:** ACCEPTED under the delegation on 2026-10-21 (DEC-019, DEC-051). The evidence is below.

Prepared under the product owner's delegation (DEC-019, DEC-051). The design is in DEC-069, recorded before code.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `9868fbc85f147bb2f5a7d022b7771b6863dc8aa2` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5i and DEC-069 |
| CI | [run 39595091384](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39595091384): every job green (migrations from scratch; dependency audit and secret scan; build, lint, typecheck, unit, integration, e2e; terraform; real S3 protocol and ClamAV; images) |
| CodeQL | [run 39595091437](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39595091437): green |
| Clean clone | Fresh clone at 9868fbc: install, build, typecheck and lint clean; 135 test files, 2,275 tests passed; e2e 21/21; OpenAPI drift 0 |
| Local runs | Build, typecheck and lint clean; 135 test files, 2,275 tests passed (2,256 before this milestone) |

## 2. What V2-M6b delivers (v2-plan section 5i)
| Part | What it is |
|---|---|
| The steps | The specification's 14 steps for a framework year. Each step reads its control from an existing service; nothing is recomputed:<ul><li>**1 Lock/confirm period:** the periods cover the year; no drafts or pending requests in it.</li><li>**2 Bank reconciliation:** RC-08.</li><li>**3 and 4 Receivables and payables:** RC-05 by party.</li><li>**5 Fixed assets:** the register reconciles, with a year-end depreciation run when an asset is in use.</li><li>**6 Accruals and prepayments:** the register reconciles.</li><li>**7 Director balances:** RC-06.</li><li>**8 VAT:** the workpaper has no unexplained difference, or the step is not applicable.</li><li>**9 Suspense:** RC-07.</li><li>**10 Review adjustments:** the review checklist is complete.</li><li>**11 Generate accounts:** the accounts document is complete and the size test is verified and fits.</li><li>**12 to 14:** LATER, in V2-M6c.</li></ul> |
| Order | Step 1 first; 2 to 9 after it in any order; 10 after 1 to 9; 11 after 10 |
| Sign-off | By a preparer (`accounts:prepare`), with a note, only when the control is ready and the step's dependencies are DONE. The sign-off stores the control at the time. A reopen needs a reason. Rows are written once |
| States | LATER, DONE, LAPSED (signed off, but the control is no longer ready), BLOCKED, TODO, ATTENTION; and the current step |
| API | 3 operations, all in OpenAPI and behind `accounts.production`: `year-end-workflow`, `year-end-workflow/sign-off` and `year-end-workflow/reopen` |

**Migration:** `20260128000000_v2_year_end_workflow` (additive).
* The `year_end_step_signoff` table:
  * forced row-level security;
  * UPDATE, DELETE and TRUNCATE revoked;
  * checks on the step, the action and the note;
  * a trigger: the framework year belongs to the company, a reopen needs a live sign-off, and a step cannot be signed off twice;
  * retention category ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m6b-workflow.json` was written by hand before the code. `docs/architecture/v2-m6b-golden-workings.xlsx` re-derives every control and state in Python, with an independent implementation of the rules: 79 checks, 0 differences.

* **The company:** a synthetic company's 2026 year with:
  * a draft invoice;
  * a bank balance with no bank account set up (RC-08);
  * laptops in the register without a year-end depreciation run;
  * no review settings;
  * no VAT registration.

  It also has a verified synthetic version, verified thresholds and the size facts.
* **The five phases**, with all 14 states each:
  1. **The start:** step 1 needs attention; everything else is blocked; 12 to 14 are later.
  2. **The invoice approved and step 1 signed off:** steps 6 to 9 are TODO; 2 to 5 need attention. Step 2 is refused as not ready, and step 10 as blocked.
  3. **Settings set, the laptops depreciated (1,200) and the bank flag explained and signed off:** steps 2 to 9 are TODO.
  4. **Steps 2 to 11 signed off:** step 12 is refused as later.
  5. **A draft bill:** step 1 lapses; step 9 is reopened and is BLOCKED behind it; a second reopen is refused.
* **Hand figures:** every state matched on the first run of the code.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Signing off and reopening need `accounts:prepare`; a reviewer gets 403; refused when not ready, blocked, later, already signed off, or not signed off | `tests/api/year-end-workflow.test.ts` |
| Rows are written once; the step is 1 to 14; a reopen needs a reason and a live sign-off; a step is not signed off twice; the framework year belongs to the company; another organisation sees nothing | `tests/db/year-end-workflow.test.ts`, `tests/db/privileges.test.ts` |
| The state rules on 2,000 random combinations, and the VAT difference rule | `tests/unit/year-end-workflow.test.ts` |
| The workflow writes only its sign-offs, in one place, and never posts; V2-ARC-01 widened to the workflow finding the framework year, recorded here | `tests/unit/architecture.test.ts` |
| The new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v2.2 (61 rows: Implemented 53, Partially 3, Missing 5).
* **Missing -> Implemented:** V2-YE-01 to V2-YE-11.
* **Missing -> Partially:** V2-MOD-01 (steps 12 to 14 arrive with V2-M6c).
* **V2-TEST-01** gains the V2-M6b golden.

## 6. Known limitations
1. **Step 1 does not lock the periods.** The year-end adjustments still post into the year, so the periods are locked at approval (V2-M6c).
2. **Step sign-off is the preparer's.** Second-person control stays where it already is:
   * the review flags (`accounts:review`);
   * the verified rules and thresholds;
   * partner review and client approval (V2-M6c).
3. **The VAT step is tested only as not applicable through the API.** The registered path's difference rule is unit-tested.
4. **Not in this milestone:**
   * steps 12 to 14, locking and the package (V2-M6c);
   * screens (V2-M7).
5. **Production gates unchanged:**
   * standard content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
