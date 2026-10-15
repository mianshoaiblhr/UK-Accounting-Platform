# V1 milestone M7a - acceptance package (bank accounts, CSV statement import, statement lines, transfers)

Prepared under the product owner's delegation (DEC-019, DEC-038..041). This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `e100429` (branch `claude/adoring-cori-mra6ze`); decisions recorded before code in `11a5e9f`; later commits for M7a are documentation only |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38807269994> - **success** (all jobs) |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38807270010> - **success** |
| Clean clone of `e100429` | CLEAN_CLONE_RESULT |
| Local full run | `pnpm test` **93 files, 1825 tests passed, 0 failed, 0 skipped** (M6c: 89 / 1750), run alone |

## 2. What M7a delivers (DEC-038..041; plan sections 11.1 and 11.1a)
* **Bank accounts** over CURRENT_ASSET_BANK ledger accounts (one each): currency, bank name, sort code / account number / IBAN (checksum) / BIC **encrypted** with the platform field key and listed only masked; the full details through an audited read by `bank:manage`; the bank's statement opening date and balance (fixed once lines exist); charges and interest accounts; close with a reason. Each account shows its ledger balance, statement balance and unmatched-line count.
* **CSV statement import** as a background job (`bank.statement.import`, `imports` queue) with progress, retries and the outcome on the job record:
  * the file is an uploaded company document that passed the virus scan; the person must be able to read it;
  * mapping by header name or column position; six date formats; one signed amount column (optionally inverted) or separate money-in and money-out columns; optional reference and running-balance columns;
  * **all or nothing**: any invalid row fails the import and nothing is stored, with up to 100 row errors (bad date, future date, before the opening point, empty description, zero or malformed amount, both or neither in/out filled, running balance that does not follow);
  * a file in newest-first order is put in date order; the running balance is proved row by row;
  * the same file again is refused without a reason; overlapping statements skip only the lines already present; two genuine identical lines in one file are both kept;
  * an import made with a wrong mapping is **voided** with a reason while nothing is matched; its lines stay visible as void and the file can be imported again.
* **The worker never posts** (ADR-61): the importer is in the platform package and writes statement data only.
* **Statement lines** are facts from the bank: stored only by their import while it runs, never edited or deleted.
* **Transfers** between two bank or cash accounts of the same currency: one `BANK_TRANSFER` journal, the negative-cash rule on the paying side, overdraft warnings, same foreign currency at one rate, cross-currency refused, duplicate check, mirror reversal.
* **Permissions:** `bank:read`, `bank:manage` (bookkeepers and managers too: preparing records), `bank:transfer` (posts).
* **API:** 15 routes, all in OpenAPI.

## 3. Migration
`20260116000000_v1_bank_accounts` is additive: four tables with forced RLS and no DELETE/TRUNCATE, their guards (section 11.1a of the plan), `BANK_TRANSFER` journals in the sub-ledger reversal guard, permissions and retention classification.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Account details are never stored or audited in clear; full details only for `bank:manage`, audited | `tests/platform/bank.test.ts`, `tests/api/bank.test.ts` |
| Reviewers read; bookkeepers create accounts, import and void; only `bank:transfer` posts transfers; client viewers see nothing; another organisation gets 404 | `tests/api/bank.test.ts`, `tests/api/permissions.test.ts` (3 new probes x 8 roles) |
| Direct SQL refused: a bank account on a non-bank account, changing its ledger account, currency or opening point after lines exist; an import not starting QUEUED or from an unscanned file; rewriting a request or an outcome; a completed import that miscounts its lines; a failed import that stored lines; late line inserts, edits, voids outside an import void, matched-part moves outside a match; voiding with matched lines; transfer edits, a "reversal" that is not the mirror, a ledger reversal of a transfer; deletes | `tests/db/bank.test.ts` (6) |
| One writer per table; the importer cannot reach the posting code; only the bank service sees the encrypted details | `tests/unit/architecture.test.ts` |
| Classification, retention, privileges, version boundary | the classification, retention, privileges and regression suites |

## 5. Hand-calculated evidence
* A newest-first statement with a running balance: opening 50.00, +250.00, -12.40, closing 287.60, stored oldest first.
* An overlapping statement of three lines imports two (closing 282.60) and keeps both identical 2.50 coffees.
* A wrongly signed interest line (-0.40) is voided and re-imported as +0.40.
* A 100.00 float from the bank to petty cash, 40.00 banked back, 150.00 refused (the box holds 60.00).
* 100.00 EUR between two euro accounts at 0.85 posts 85.00 on both sides with the EUR amounts kept.

## 6. Compliance matrix (v3.1; 113 rows: Implemented 75, Partially 18, Missing 20)
* **Now Implemented:** V1-MOD-10 (bank accounts), V1-BANK-01 (accounts), V1-BANK-02 (statement imports), V1-BANK-03 (immutable lines), V1-BANK-06 (transfers).

## 7. Defect found by the tests
While simplifying the import's state check, the rule that an import's outcome is recorded once was dropped. The database test that rewrites a completed import's counts failed, and the rule was restored before the commit.

## 8. Known limitations and gates
1. **CSV only** (DEC-038); OFX, MT940/CAMT and Open Banking feeds are deferred.
2. **Cross-currency transfers** are refused (DEC-041).
3. **Performance:** a 20,000-line import runs in one transaction; real-volume timing is untested.
4. **Production gates unchanged:** qualified tax reviewer, privacy and retention review (DEC-013), security review, AWS apply and verification, real-volume performance.
