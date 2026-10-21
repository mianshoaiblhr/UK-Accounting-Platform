# V2 milestone V2-M6a - acceptance package (review flags and the review checklist)

**Status:** ACCEPTED under the delegation on 2026-10-21 (DEC-019, DEC-051). The evidence is below.

Prepared under the product owner's delegation (DEC-019, DEC-051). The split and the design are in DEC-068, recorded before code.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. The review settings are the firm's choices, not legal values.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `8646c7e0db1b3a63d7645738727a4f2c8ffc1f10` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5h and DEC-068 |
| CI | [run 39575388052](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39575388052): every job green (migrations from scratch; dependency audit and secret scan; build, lint, typecheck, unit, integration, e2e; terraform; real S3 protocol and ClamAV; images) |
| CodeQL | [run 39575387880](https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/39575387880): green |
| Clean clone | Fresh clone at 8646c7e: install, build, typecheck and lint clean; 132 test files, 2,256 tests passed; e2e 21/21; OpenAPI drift 0 |
| Local runs | Build, typecheck and lint clean; 132 test files, 2,256 tests (one V2-M1 test that lists the system roles' accounts permissions updated on purpose for accounts:review, then passing); 2,225 before this milestone |

## 2. What V2-M6a delivers (v2-plan section 5h)
| Part | What it is |
|---|---|
| The nine controls | Raised live each time the checklist is read, from the ledger (closing journals left out), the registers and the documents:<ul><li>**RC-01** unexplained movements: manual and control-adjustment journals at or above the setting;</li><li>**RC-02** material changes: lines with accounts, and the retained profit, against the comparative by amount and percentage;</li><li>**RC-03** unusual balances: P&L accounts on the wrong side for the year;</li><li>**RC-04** negative balances: assets in credit and liabilities in debit at the year end;</li><li>**RC-05** old receivables and payables: overdue beyond 30, 60 or 90 days, from the V1 aged reports;</li><li>**RC-06** director loan movements: any V2-M4 flag;</li><li>**RC-07** suspense balances;</li><li>**RC-08** unreconciled bank: no signed year-end reconciliation, a difference, or a bank ledger account with no bank account set up;</li><li>**RC-09** missing evidence: manual journals, purchase bills and cash payments at or above the setting without a live evidence link to a document.</li></ul> |
| Settings | The firm's, per company, versioned with a reason (`accounts:prepare`). A control whose setting is not set is NOT_EVALUATED and is never treated as passed |
| Responses | Written once and never changed:<ul><li>**EXPLAIN** (`accounts:prepare`);</li><li>**SIGN_OFF** (the new `accounts:review`, never the person who explained it);</li><li>**REOPEN** (`accounts:review`).</li></ul>Each response stores the flag's figures. An explanation lapses when the figures change, and the flag is OPEN again, marked as changed. The database repeats the second-person rule |
| The checklist | Each control is CLEAR, OPEN, EXPLAINED, SIGNED_OFF or NOT_EVALUATED, with its flags, figures, drill-down and responses. Flags no longer raised keep their history under "resolved". The checklist is `complete` when every control is evaluated and every flag is signed off |
| API | 6 operations, all in OpenAPI and behind `accounts.production`:<ul><li>`review-settings` (GET, POST);</li><li>`review-checklist`;</li><li>`review-flags/explain`, `sign-off` and `reopen`.</li></ul> |

**Migration:** `20260127000000_v2_review_checklist` (additive).
* `review_setting` and `review_flag_response`:
  * forced row-level security;
  * UPDATE, DELETE and TRUNCATE revoked;
  * checks on amounts, days, keys and notes;
  * a trigger for the framework year and the second-person sign-off;
  * retention category ACCOUNTING_RECORDS.
* The `accounts:review` permission is granted to owner, admin and partner.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m6a-review.json` was written by hand before the code. `docs/architecture/v2-m6a-golden-workings.xlsx` recomputes every flag and figure independently in Python from the postings: 38 checks, 0 differences.

* **The company:** a synthetic company over 2025 and 2026. It has:
  * a suspense balance from approved opening balances;
  * sales, rent and a director's advance;
  * three manual journals, one with evidence;
  * an invoice and two bills, one of each overdue;
  * the director's loan account.
* **The settings:** 1,000 unexplained; 5,000 and 20% material; 60 days; 500 evidence.
* **The flags (16):**
  * RC-01: the 1,200 travel journal.
  * RC-02: turnover +12,400 (62%), current assets +23,750 (166.08%), retained profit +22,550 (161.07%).
  * RC-03: other income -150.
  * RC-04: other debtors -150 and the director's account -800.
  * RC-05: the customer 2,400 and the supplier 900.
  * RC-06: the loan account, overdrawn at the end and in the period: lowest -2,000, 320 days.
  * RC-07: suspense 300.
  * RC-08: bank 1200 with no bank account set up.
  * RC-09: two cash payments, the travel journal and a bill. The journal with evidence is not raised.
* **Without settings:** RC-01, RC-02, RC-05 and RC-09 are NOT_EVALUATED; the others are OPEN.
* **The response flow:**
  * explained and signed off by a second person;
  * the reviewer and the person who explained refused as signers;
  * an explanation lapsing when a further journal changes the figures;
  * a reopen;
  * a bank account raised and then cleared by a signed reconciliation;
  * a flag resolved by a change of setting, keeping its history.
* **Hand figures:** every flag and figure matched on the first run of the code. Three test set-ups of mine were wrong and were corrected:
  * the sales and purchase control accounts were not set;
  * a bill line was given a null tax code;
  * the API test's helper named subjects by label instead of key.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Explaining needs `accounts:prepare`; signing off and reopening need `accounts:review`; the person who explained cannot sign off (service and database); an unexplained or changed flag cannot be signed off; responses are written once | `tests/api/review.test.ts`, `tests/db/review.test.ts`, `tests/api/permissions.test.ts` |
| Settings are written once with a reason; positive amounts and 30, 60 or 90 days (service and database) | `tests/db/review.test.ts`, `tests/unit/review.test.ts` |
| Reading needs `ledger:read`; outsiders get 404; another organisation sees nothing | `tests/api/review.test.ts`, `tests/db/review.test.ts`, `tests/db/privileges.test.ts` |
| Settings and responses have one writer; the checklist never posts; V2-ARC-01 widened to the checklist finding the framework year, recorded here | `tests/unit/architecture.test.ts` |
| The new tables are classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v2.1 (61 rows: Implemented 42, Partially 2, Missing 17).
* **Missing -> Implemented:** V2-RC-01 to V2-RC-09, V2-MOD-14.
* **V2-TEST-01** gains the V2-M6a golden.

## 6. Known limitations
1. **Settings are the firm's.** The platform has no default materiality and no default thresholds. Until they are set, four controls are not evaluated, and the checklist cannot be complete.
2. **Rules are simple and stated:**
   * material change compares with the comparative only (no analytical review);
   * unusual balances are wrong-side P&L accounts;
   * evidence means any live link to a document.
3. **Not in this milestone:**
   * the year-end steps (V2-M6b);
   * approval, locking and the filing-ready package (V2-M6c);
   * screens (V2-M7).
4. **Production gates unchanged:**
   * standard content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
