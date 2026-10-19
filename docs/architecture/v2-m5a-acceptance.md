# V2 milestone V2-M5a - acceptance package (the accounts document)

Prepared under the product owner's delegation (DEC-019, DEC-051). The split and the design are in DEC-063, recorded before code.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, and so is all wording: no FRS 105, FRS 102 or Companies Act text has been entered or verified. Entering and verifying real wording is the named accountant's work in the platform (DEC-052, DEC-056).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@SHA@@ (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5d and DEC-063 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M5a delivers (v2-plan section 5d)
| Part | What it is |
|---|---|
| Wording as version content | V2-M1's disclosure rules gain four fields:<ul><li>a section: POLICIES, NOTES, DIRECTORS_REPORT or BALANCE_SHEET_STATEMENTS;</li><li>an order;</li><li>a body template;</li><li>an omit-when-empty flag.</li></ul>The wording is written while the version is unverified, verified with it by a second person, and frozen after, by the service and the database alike. It is copied when a version is superseded, and the version's consistency check covers its line references |
| Template grammar | A closed grammar, checked when written. Placeholders:<ul><li>`{{line:KEY}}` and `{{line:KEY:prior}}`;</li><li>`{{fact:KEY}}`;</li><li>`{{table:KEY}}`, alone in its paragraph;</li><li>company name and number, the year's dates, standard and version, and the directors' names.</li></ul>There is no code, no expressions and no markup; the output is text and tables. Unknown constructs, facts, tables and lines are refused, and so are stray braces |
| Facts from the platform | <ul><li>**Fixed-asset movements**, read from the ledger by class: cost and depreciation brought forward, additions, disposals, charge, eliminated on disposals, other movements, carried forward, and net book value at both dates.</li><li>**Provisions**, from the V2-M3a register.</li><li>**Advances and credits to directors**, from the V2-M4 loan accounts: opening, advanced, credited or repaid, closing, most overdrawn.</li><li>**Related parties**, from the V2-M4 report.</li></ul> |
| Facts from the preparer | Average employees (this year and last), approval date, approving director, and free wording under `text.*`.<ul><li>Values are typed by both the service and the database.</li><li>Each change is a new row, kept with who, when and why; the latest applies.</li></ul> |
| The document | The header, then the statements with comparatives (V2-M1). Then the sections in order: rules for other sizes are left out and listed, and so are empty "omit when empty" items.<ul><li>A missing fact renders as `[missing: key]` and is reported.</li><li>`complete` is true only when the version is verified, no fact is missing, every account is placed, the error rules pass and the balance sheet balances.</li></ul> |
| API | 3 operations: `accounts-document`, and `accounts-facts` (GET and POST). The disclosure-rule operations take the new fields. All are in OpenAPI and behind `accounts.production`.<ul><li>The document needs `ledger:read`.</li><li>Facts need `accounts:prepare`.</li><li>Wording needs `accounts:rules-manage` and `accounts:rule-verify` (V2-M1).</li></ul> |

**Migration:** `20260124000000_v2_accounts_document` (additive).
* Four columns on `disclosure_rule`, with checks.
* The `accounts_fact` table:
  * forced row-level security;
  * UPDATE, DELETE and TRUNCATE revoked;
  * a guard trigger that checks types, the framework year and the approving director;
  * retention category ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m5a-document.json` was written by hand before the code. `docs/architecture/v2-m5a-golden-workings.xlsx` recomputes every figure, table and sentence independently in Python: 62 checks, 0 differences.

* **The company:** a synthetic micro-entity across 2025 and 2026. It has a fixed-asset class with laptops (bought 2025, sold 30.6.2026 at a gain of 100.00) and a printer (bought 2026), a warranty provision of 800.00, and a director's loan account that was 1,500.00 overdrawn and ends at 200.00 in credit.
* **Statements, 2026 (2025):**
  * Turnover 15,000.00 (12,000.00).
  * Profit 8,150.00 (6,800.00).
  * Fixed assets 1,350.00 (2,400.00).
  * Net assets 17,950.00 (9,800.00).
* **The document:**
  * two policies;
  * notes on employees, tangible fixed assets (the movement table reconciles to the balance sheet), provisions, advances and credits to directors, going concern and related parties;
  * the micro-entity balance-sheet statement, carrying the approval date and the director.
* **What is left out:** the empty note on long-term creditors, and the small-company directors' report, which does not apply to a micro-entity.
* **Going concern:** until its wording is entered, the document is not complete, and the problem is named. Once entered, the document is complete.
* **Hand figures and wording:** every sentence and figure matched on the first run that reached the document. Before that, one code defect was fixed: an SQL `GROUP BY` on a parameterised expression gave a server error. One mistake in my own workbook generator (the sign of the depreciation eliminated on disposal) was corrected; the hand-written figures were right.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Only rules managers write wording; the author cannot verify; verified wording is frozen in the service and the database | `tests/api/accounts-document.test.ts`, `tests/db/accounts-document.test.ts` |
| Facts need `accounts:prepare` (bookkeepers get 403); they are typed (service 422, database check); they are written once and never deleted; another organisation sees nothing; the document needs `ledger:read` and returns 404 to outsiders | `tests/api/accounts-document.test.ts`, `tests/db/accounts-document.test.ts`, `tests/db/privileges.test.ts` |
| The template grammar refuses unknown constructs, facts, tables and lines, tables inside text, and stray braces. Markup is never interpreted | `tests/unit/accounts-document.test.ts`, `tests/api/accounts-document.test.ts` |
| The document reads; its only write is a fact. Only the framework service and the statutory reports touch the framework tables. The V2-ARC-01 test is widened to the accounts document, recorded here | `tests/unit/architecture.test.ts` |
| The new table is classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v1.7 (61 rows: Implemented 30, Partially 3, Missing 28).
* **Missing -> Implemented:** V2-MOD-12, V2-OUT-01, V2-OUT-02, V2-OUT-04, V2-OUT-05, V2-OUT-07.
* **Missing -> Partially:** V2-MOD-13 (the cash flow statement is V2-M5b).
* Each of these rows records that the mechanism is proven on synthetic verified wording only.

## 6. Known limitations
1. **No real wording.** The platform renders whatever wording the named accountant enters and verifies; none exists yet. Until it does, real companies get previews only, marked unverified.
2. **Not in this milestone:**
   * the size test and the cash flow statement (V2-M5b);
   * approval, locking and the filing-ready package (V2-M6);
   * PDF and iXBRL (V3);
   * screens (V2-M7).
3. **Simple table layouts.** The tables have fixed columns per fact. The fixed-asset table shows one column per class, or per group of classes that share accounts. The note on advances shows figures; terms and interest come from the preparer's wording (`text.*`).
4. **Year-to-date.** The fixed-asset movements come from the ledger. Movements posted to the class accounts outside the fixed-asset register show as "other movements" (depreciation) or as additions (cost).
5. **Production gates unchanged:**
   * standard versions and wording verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
