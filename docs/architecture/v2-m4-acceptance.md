# V2 milestone V2-M4 - acceptance package (director and shareholder loan accounts, related parties)

Prepared under the product owner's delegation (DEC-019, DEC-051), with the design in DEC-062 recorded before code. DEC-061 records Shoaib's review of the V2-M2, V2-M3a and V2-M3b golden workings ("All verified", 2026-10-19). That review covers synthetic expected figures only and verifies no standard version (DEC-052). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@SHA@@ (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5c and DEC-062 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M4 delivers (v2-plan section 5c)
| Part | What it is |
|---|---|
| Loan accounts | One per director or shareholder:<ul><li>on a dedicated, non-control asset or liability ledger account that is not bank or cash;</li><li>one live loan account per ledger account and per person;</li><li>a DIRECTOR kind needs a DIRECTOR appointment in the company's officers.</li></ul>Facts never change; an account is closed once and never deleted |
| Statements | For any range: opening, every movement and closing.<ul><li>Balances are credit-positive; negative means overdrawn.</li><li>Each movement shows its category (CASH_AND_BANK, EXPENSES, INCOME, DIVIDENDS, OTHER_LOAN_ACCOUNT, OTHER, MIXED), taken from the journal's other lines with VAT lines ignored.</li><li>Also shown: the running balance, the lowest day-end balance and the first day it holds, and the days ending overdrawn.</li><li>A report covers every account open in the range.</li></ul> |
| Review flags | OVERDRAWN_AT_END and OVERDRAWN_IN_PERIOD.<br>LARGE_MOVEMENT and OVERDRAWN_ABOVE_THRESHOLD, measured against the firm's own review thresholds:<ul><li>The thresholds are versioned rows, each with a reason.</li><li>The latest applies, and the history is kept.</li><li>An unset threshold is reported as "not evaluated", never as passed.</li></ul>No legal amount is encoded |
| Related parties | A register: counterparty, relationship, description, from and to dates. A party is ended once.<br>A report per party for any range, each figure with its journals:<ul><li>sales and purchases net of VAT, from its documents;</li><li>cash paid and received, from its cash transactions; a loan account's own lines are never counted as cash;</li><li>owed by and owed to at the end, from the control-account lines of all its sub-ledger journals;</li><li>its loan accounts.</li></ul> |
| API | 13 operations, all in OpenAPI and behind `accounts.production`:<ul><li>`director-loan-accounts`, with `report`, `statement` and `close`;</li><li>`director-loan-thresholds`;</li><li>`related-parties`, with `report` and `end`.</li></ul>Writes need `accounts:prepare`; reads need `ledger:read` |

**No journal source:** V2-M4 reads the ledger and never writes it. An architecture test proves this.

**Migration:** `20260123000000_v2_director_loans_related_parties` (additive).
* 3 tables, with forced row-level security.
* DELETE and TRUNCATE are revoked, and UPDATE as well on thresholds.
* Guard triggers and partial unique indexes enforce the rules in the table above.
* Retention category: ACCOUNTING_RECORDS.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m4-directors.json` was written and added up by hand before the code. `docs/architecture/v2-m4-golden-workings.xlsx` recomputes all 79 figures independently in Python, with 0 differences.

* **Alex Director's loan account for 2026:** seven movements, from a 1,000.00 loan in to a mixed journal of 250.00.
  * Overdrawn from 15.3 to 29.6 (107 days), with a lowest balance of -1,500.00 on 15.3.
  * Closing balance 50.00.
  * By category: cash -1,500.00, expenses 300.00, dividends 2,000.00, other -400.00, other loan account -100.00, mixed -250.00.
  * For the second half alone: opening 800.00, three movements, lowest 50.00, never overdrawn.
* **Blair Holder's loan account (shareholder):** overdrawn from 1.2 to the year end (334 days), lowest -700.00, closing -550.00.
* **Flags:**
  * With no thresholds, the size flags are "not evaluated".
  * With thresholds of 2,000.00 (large movement) and 1,000.00 (overdrawn):
    * Alex: overdrawn in the period, two large movements (2,500.00 and 2,000.00), and overdrawn beyond the threshold.
    * Blair: overdrawn at the end and in the period.
* **Related company, Alex Holdings Ltd (both customer and supplier):**
  * Sales 4,500.00 (an invoice of 5,000.00 less a credit note of 500.00).
  * Purchases 1,200.00.
  * Cash paid 300.00.
  * Owed by it at the end 1,500.00; owed to it 500.00.
  * Each figure lists the journals behind it.
* **The two people as related parties:** their loan accounts' closing and lowest balances. Their loan accounts' own cash is not counted as cash paid or received.
* **Hand figures:** all matched on the first run of the API test.
* **Screen defect found by the clean clone, fixed:** the first clean-clone run of `bc3dc03` failed one browser test (CI on the same commit was green). The balance-sheet screen showed the answer for its default date (31.12) after the user had already chosen 30.6. The screens' data hook let a slower answer for an earlier request overwrite a newer one.
  * The defect dates from V1-M9a; it was not caused by V2-M4.
  * The hook (`apps/web/src/lib/workspace.tsx`, `useApi`) now shows only the answer to the latest request.
  * The browser suite then passed twice in a row (21/21 each).
* **Test expectation corrected:** in the database test, Prisma reports a unique-index refusal as "Unique constraint failed" rather than by the index name. The test now accepts either wording; the database refused correctly.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Writes need `accounts:prepare`: bookkeepers and reviewers get 403. Reads need `ledger:read`. Another organisation gets 404 or sees nothing. An AI actor and a person without the permission are refused | `tests/api/directors.test.ts`, `tests/platform/directors.test.ts`, `tests/db/directors.test.ts` |
| A loan account cannot sit on bank, cash, a control account or a P&L account. A director needs an appointment. Duplicate live accounts or parties are refused. Facts never change. Status moves once. Nothing is deleted. Thresholds are written once and above zero. All of this holds in the database, even when the service is bypassed | `tests/db/directors.test.ts`, `tests/db/privileges.test.ts` |
| Only the V2-M4 service writes these tables, and it never writes or posts to the ledger | `tests/unit/architecture.test.ts` |
| The new tables are classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v1.6 (61 rows: Implemented 24, Partially 2, Missing 35).
* **Missing -> Implemented:** V2-MOD-09, V2-MOD-10.
* **DEC-061:** the review of the golden workings is recorded in the matrix history. No row changes status because of it.

## 6. Known limitations
1. **Legal amounts not encoded.** The flags are review prompts on the firm's thresholds. These belong to the verified framework (DEC-052) or to V4 tax:
   * the Companies Act 2006 ss.197-214 approval of loans to directors, including the s.207 amounts;
   * the s.413 note on advances and credits to directors;
   * the CTA 2010 s.455 charge and the s.464C "bed and breakfasting" rule.
2. **Manual journals are not attributed.** Related-party transactions posted only by manual journal are not attributed to the counterparty. Only its documents, receipts, payments, cash transactions and loan accounts are.
3. **Not in this milestone:**
   * disclosure wording, materiality and which parties appear in the notes (V2-M5);
   * share registers and shareholdings.
4. **Production gates unchanged:**
   * standard versions verified by Shoaib (DEC-056);
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
