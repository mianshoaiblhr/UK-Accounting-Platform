# V2 Accounts Production (FRS 102 / FRS 105) - plan and design

Status: V2 approved 2026-10-17 (DEC-051). Authority: `docs/specifications/V2_Accounts_Production_FRS102_FRS105.md`, the master manifest, `decision-log.md` (DEC-051..054), ADR-62..64. Requirement matrix: `v2-compliance-matrix.md|json|xlsx`. Nothing here is production-approved (DEC-006); development data is synthetic (DEC-003). **The qualified accountant is named: Shoaib (DEC-056). No accounting-standard rule is verified until Shoaib verifies it in the platform (DEC-052): until then V2 produces previews only.**

## 1. Principles carried from V0 and V1 (not re-decided)
Everything in V1 plan section 1, plus: only the PostingService writes the ledger (every new V2 posting is a journal source with its five test categories in the posting-rule registry, DEC-047); statements are computed from journal lines only (ADR-63); rules that come from law or standards are data with a source and a second-person verification (DEC-021, DEC-052); screens show what the API computes (DEC-048).

## 2. Milestones (each ends with an acceptance package, DEC-007)
| Milestone | Scope | Status | Owner | Depends on |
|---|---|---|---|---|
| V2-M0 | Decisions DEC-051..054, ADR-62..64, this plan, the V2 matrix | **recorded** (2026-10-17) | Engineering | V2 approval |
| V2-M1 | Reporting framework as data (section 3) | **built** (2026-10-18; `v2-m1-acceptance.md`); rules unverified until the named accountant | Engineering; the named accountant verifies | V2-M0 |
| V2-M2 | Fixed assets: classes, register, additions, disposals, depreciation methods, useful lives, residual values, tax vs accounting treatment, reconciliation to the ledger, depreciation runs | **built** (2026-10-18; `v2-m2-acceptance.md`) | Engineering | V2-M1 |
| V2-M3 | Year-end adjustments: accruals, prepayments, deferred income, provisions with reversal; the year-end closing journal to retained earnings | split (DEC-059): **V2-M3a built** (2026-10-18; `v2-m3a-acceptance.md`); **V2-M3b built** (2026-10-19; `v2-m3b-acceptance.md`) | Engineering | V2-M2 |
| V2-M4 | Director and shareholder balances (director loan movements flagged), related parties | **built** (2026-10-19; `v2-m4-acceptance.md`) | Engineering | V2-M3 |
| V2-M5 | Statements and notes: FRS 105 micro-entity, then FRS 102 Section 1A, then full FRS 102; policies, comparatives, directors' sections; the size test | split (DEC-063, DEC-066): **V2-M5a built** (2026-10-19; `v2-m5a-acceptance.md`); **V2-M5b built** (2026-10-20; `v2-m5b-acceptance.md`, the size test, section 5f); **V2-M5c built** (2026-10-20; `v2-m5c-acceptance.md`, the cash flow statement, section 5g) | Engineering; the named accountant | V2-M1, V2-M3, V2-M4 |
| V2-M6 | Year-end workflow (the specification's 14 steps), review checklist and flags, partner review, client approval, filing-ready package | planned | Engineering | V2-M5 |
| V2-M7 | Screens behind `accounts.production` | planned | Engineering (front end) | each API milestone |

## 3. V2-M1 - Reporting framework (specification; DEC-052, DEC-053)
Recorded before code.

### 3.1 Data (one migration, additive)
| Table | Holds | Rules (service and database) |
|---|---|---|
| `reporting_standard` | Organisation-scoped code (`FRS105`, `FRS102-1A`, `FRS102`, ...) and name | Unique per organisation; never deleted |
| `reporting_standard_version` | Label, effective-from/to, source URL, instrument and paragraph, retrieval date, status UNVERIFIED / VERIFIED / SUPERSEDED, author, verifier, verification time, notes; optionally copied from an earlier version | Versions of one standard do not overlap in effect; VERIFIED needs a verifier other than the author holding `accounts:rule-verify`; a VERIFIED or SUPERSEDED version and everything under it is immutable |
| `statutory_line` | Per version: key, statement (`PL`, `BS`), parent key, order, name, kind `ACCOUNTS` (fed by the map, natural side DEBIT or CREDIT), `TOTAL` (a signed sum of other lines) or `RETAINED_PROFIT` (the P&L cumulated to the date, until the closing journal of V2-M3 exists) | Keys unique per version; a total refers only to lines of its version, with no cycle |
| `statutory_map_entry` | Per version: V1 reporting line (optionally narrowed by account subtype) -> statutory line key | One target per (version, V1 line, subtype); the most specific entry wins |
| `statutory_account_override` | Per company and version: account -> statutory line key, with reason | Audited; ended with a reason, never deleted |
| `validation_rule` | Per version: key, description, severity ERROR / WARNING, applies-to entity sizes, expression | The expression is checked against the closed grammar (3.3) when written |
| `disclosure_rule` | Per version: key, title, applies-to entity sizes, the lines and facts the note needs | Stored and shape-checked in V2-M1; rendered in V2-M5 |
| `company_reporting_framework` | Per company and financial year: year start and end, standard version, entity size (MICRO, SMALL, MEDIUM, LARGE), reason | One per company and year start; changed with a reason (audited); locked once the year's accounts are approved (V2-M6) |

All tables: forced row-level security by organisation; the runtime role has no DELETE or TRUNCATE; the guard lists of V1 (classification, retention, security architecture, privileges, regression and architecture tests) gain each table.

### 3.2 Services and API
* `StandardsService`: create a standard and its versions (optionally copying an earlier version's lines, map and rules), add or change lines, map entries and rules while UNVERIFIED (author: `accounts:rules-manage`), verify (`accounts:rule-verify`, not the author), supersede. Audited with before/after.
* `FrameworkService`: choose the standard version and entity size for a company's financial year (`accounts:prepare`); set or end an account override with a reason.
* `StatutoryReportService.preview(company, financial year, comparative?)`: computes the P&L for the year and the balance sheet at its end from journal lines through the map (ADR-63), with the prior year alongside on the same version; each line lists its accounts and drills to the general ledger; returns unmapped and doubly mapped accounts, the validation results, and `verified: false` with a notice whenever any rule used is not verified.
* Permissions: new `accounts:rules-manage`, `accounts:rule-verify`, `accounts:prepare`; reading needs `ledger:read`. Owner and admin hold all three; partner and accountant hold `accounts:prepare`; nobody holds `accounts:rule-verify` by default except owner and admin (the firm grants it to its named accountant, as with `tax:rule-verify`).
* Routes under `/organisations/{org}/companies/{company}/`: `reporting-standards` (list, create), `reporting-standards/{id}/versions` (list, create), `reporting-standard-versions/{id}` (get with lines, map and rules; patch while unverified), `.../lines`, `.../map-entries`, `.../validation-rules`, `.../disclosure-rules` (create, update, delete while unverified), `.../verify`, `.../supersede`; `reporting-frameworks` (list, set per year); `statutory-overrides` (list, set, end); `statutory-preview?yearStart&compare`. All in OpenAPI.

### 3.3 Expression grammar (validation rules)
JSON only: `{"line":"<key>"}`, `{"const":"<decimal>"}`, `{"add":[e,...]}`, `{"sub":[a,b]}`, `{"neg":e}`, and the comparisons `{"eq"|"ge"|"le"|"gt"|"lt":[a,b], "tolerance":"<decimal>"?}`, combined with `{"and":[...]}` / `{"or":[...]}`. Exact decimals, no floating point; an unknown key, a reference to a line outside the version, or a non-boolean top level is refused when the rule is written. No other construct exists.

### 3.3a How it is built (DEC-055, recorded before code)
Totals are lists of signed line references; values follow each line's natural side, P&L over the year and balance sheet at its end; retained profit is the P&L of every year to the year end until V2-M3; an account lands on exactly one line (override, else the most specific map entry) and the preview proves it; only a verified version is superseded, by a copy; content is removed by a flag while unverified; rule constants keep the ledger's scale (4 decimals); the routes are behind `accounts.production`.

### 3.4 Not in V2-M1
Rendering notes and policies (V2-M5); the size test from turnover, balance-sheet total and employees (V2-M5); cash flow statements (V2-M5, full FRS 102 only); screens (V2-M7); seeding any real standard content (never: DEC-052).

### 3.5 Acceptance
* Golden trial balance (DEC-054): a synthetic micro-entity year with a hand-written expected P&L and balance sheet under a synthetic version shaped like an FRS 105 layout, matched to the cent with the comparative; an unmapped account reported; an override moving an account between lines (audited); a validation rule (net assets = capital and reserves) passing and a deliberately broken map making it fail.
* Verification: the author cannot verify; a verified version and its children cannot change (service and database); a change supersedes; previews from an unverified version say so.
* Grammar: every construct evaluated exactly; unknown constructs, cycles and foreign keys refused.
* Tenancy and permissions: another organisation sees nothing; each route refuses without its permission.
* Architecture: the statutory report service reads ledger and framework tables only.
* CI green, clean clone, OpenAPI regenerated, the matrix rows for V2-M1 moved with evidence.

## 4. V2-M2 - Fixed assets and depreciation (specification; DEC-058)
Recorded before code.

### 4.1 Data (one migration, additive)
| Table | Holds | Rules (service and database) |
|---|---|---|
| `fixed_asset_class` | Per company: code, name, cost / accumulated depreciation / expense / disposal accounts, default method, life (months) or rate (%), residual, convention | Accounts of the right type and subtype, non-control, in the company; code unique per company; changed with a reason (defaults apply to new assets only) |
| `fixed_asset` | Per company: number (sequence), class, description, acquisition date, in-use date, cost, addition kind (POSTED / LINKED / TAKE_ON), addition journal, take-on accumulated depreciation and date, status (ACTIVE / DISPOSED / VOID), disposal date, proceeds, proceeds account, disposal journal, gain or loss; tax category and tax cost | Cost > 0; in-use date not before acquisition; DISPOSED and VOID final; a disposed asset's figures immutable (trigger) |
| `fixed_asset_basis` | Per asset, append-only: effective from, carrying amount at that date, method, remaining life (months) or rate, residual, convention, reason, author | First basis at the in-use date (or the day after take-on); a new basis only after the last charged date; never edited or deleted |
| `depreciation_run` | Per company: as-at date, status (POSTED / REVERSED), journal, reversal journal, total, author | One live run per as-at date; a new run later than every live run; reversal only of the latest live run |
| `depreciation_run_line` | Per run and asset: class, amount, cumulative after the run | Written once with its run |

All tables: forced row-level security, no DELETE or TRUNCATE for the runtime role, classified, retention ACCOUNTING_RECORDS, in every V1 guard list.

### 4.2 Arithmetic (exact; DEC-058)
* Depreciable amount since the basis: SL = carrying amount at basis - residual; RB works on the carrying amount.
* SL, DAILY: due(d) = depreciable x min(1, (d - basis + 1 day) / days of the remaining life). SL, MONTHLY: due(d) = depreciable x min(1, months counted / remaining months), where a month counts once d reaches its last day; the month of the basis counts in full; at disposal the disposal month does not count.
* RB: after n whole asset years and a fraction f of the current one (days / days of that asset year, or months / 12), carrying(d) = carrying at basis x (1 - r)^n x (1 - r x f), never below the residual. due(d) = carrying at basis - carrying(d).
* Charge at d = round_half_up(cumulative before the basis + due(d), 2) - already charged. A run charges only assets ACTIVE and in use on d.

### 4.3 Services and API
* `FixedAssetService`:
  * classes: create, update, list;
  * assets: add, get, list, change estimate, change tax fields;
  * disposals: dispose, reverse disposal;
  * reverse a POSTED addition;
  * register report and reconciliation as at a date.
  `DepreciationService`: preview, post and reverse runs. Both go through the PostingService only.
* Journal sources (contracts): FIXED_ASSET_ADDITION, FIXED_ASSET_ADDITION_REVERSAL, FIXED_ASSET_DEPRECIATION, FIXED_ASSET_DEPRECIATION_REVERSAL, FIXED_ASSET_DISPOSAL and FIXED_ASSET_DISPOSAL_REVERSAL. All are `subLedger`, with no control accounts and no VAT, under permission `assets:manage`. Each has its five posting-rule test categories in `tests/rules/posting-rules.ts`.
* Permissions: `assets:read`, `assets:manage` (DEC-058).
* Routes under `/organisations/{org}/companies/{company}/`, behind `accounts.production`:
  * `fixed-asset-classes` (list, create, patch);
  * `fixed-assets` (list, add, get), with `.../estimate`, `.../tax`, `.../dispose`, `.../reverse-disposal` and `.../reverse-addition`;
  * `depreciation-runs` (list, preview, post), with `.../{id}/reverse`;
  * `fixed-asset-register?asAt` (register and reconciliation).
  All are in OpenAPI.

### 4.4 Acceptance
* Golden (DEC-054): `tests/golden/v2-m2-fixed-assets.json`, written by hand before the code. Two classes:
  * four assets: straight line monthly, straight line daily, reducing balance daily, and a take-on;
  * two years of runs, and a disposal at a gain;
  * a prospective change of estimate.
  Every charge, the disposal journal, the carrying amounts and the reconciliation are matched to the cent. The workbook recomputes every figure independently.
* The five categories for each new source: positive; negative (including a non-control or wrong-type account); the mirror reversal and the refused ones; VAT refused; a closed period refused.
* Database: immutability, append-only basis, one live run per date, no deletes.
* Permissions and tenancy, as in V2-M1.
* Architecture: depreciation never reads the tax fields; only the asset services write the asset tables and post the asset sources.
* CI green, clean clone, OpenAPI regenerated, matrix rows V2-MOD-03, V2-MOD-04 and V2-FA-01..08 moved with evidence.

## 5. V2-M3a - Year-end adjustments (specification; DEC-059)
Recorded before code.

### 5.1 Data (one migration, additive)
| Table | Holds | Rules |
|---|---|---|
| `year_end_item` | Per company: kind (ACCRUAL, ACCRUED_INCOME, PREPAYMENT, DEFERRED_INCOME), description, amount, P&L account, balance account, date, service period and convention (schedules), set-up kind (POSTED or LINKED) and journal, accrual and auto-reversal journals, status (ACTIVE, CANCELLED), evidence documents, basis, author | Accounts of the kind's types, non-control; amount > 0; a schedule's end not before its start; facts immutable; ACTIVE -> CANCELLED once |
| `release_run` / `release_run_line` | As at date, status, journal, reversal journal, total; per schedule amount and released after | As for depreciation runs (DEC-058): one live run per date, later than every live run, only the latest reversed; lines written once |
| `provision` / `provision_movement` | Provision: name, liability and expense accounts, basis, evidence. Movement: kind (MADE, USED, RELEASED), date, amount, offset account (USED), reason, journal, status (POSTED, REVERSED) | Balance never below zero (database); only the latest live movement reversed; movements never edited |

### 5.2 API (behind `accounts.production`; writes `accounts:prepare`, reads `ledger:read`)
* `year-end-items`: list; create an accrual, accrued income, prepayment or deferred income; get; cancel.
* `release-runs`: list; preview; post; get; reverse.
* `provisions`: list; create; get, with its movements.
* `provisions/{id}/movements`: create (made, used or released).
* `provision-movements/{id}/reverse`.
* `provisions/report?from&to`: the movement report.
* `year-end-register?asAt`: every item and provision, and the reconciliation by balance account.

All are in OpenAPI.

### 5.3 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m3a-adjustments.json`, written by hand before the code and recomputed independently in a workbook:
  * an accrual and accrued income at 31.12.2026, each reversed on 1.1.2027;
  * a posted monthly prepayment and a linked daily prepayment;
  * monthly deferred income;
  * two release runs;
  * a provision made, used and released;
  * the reconciliation at both dates, and the P&L effect per account.
* **Tests:** the five categories for each of the nine sources; database guards; permissions and tenancy; an architecture test (only the year-end service writes its tables and posts its sources); CI green; clean clone; matrix rows V2-MOD-05..08 moved with evidence.

## 5b. V2-M3b - Year-end closing journal (specification; DEC-060)
Recorded before code. Matrix row V2-YEC-01.

### 5b.1 Data (one migration, additive)
| Table / object | Holds | Rules |
|---|---|---|
| `year_end_close` | Company, year start and end, retained-earnings account, journal, profit (credit to retained earnings positive), status (POSTED, REVERSED), reversal journal, who, when and why | Start <= end; at most 18 months; no overlapping live close (database); facts immutable; POSTED -> REVERSED once with a reason; never deleted |
| `journal_line` trigger | - | An income or expense line dated in the year of a live close is refused unless its journal is the close or the close's mirror |

### 5b.2 Posting and statements
* **Sources:**
  * YEAR_END_CLOSE: Dr each income account / Cr each expense account by its net for the year, and the difference to retained earnings.
  * YEAR_END_CLOSE_REVERSAL: its mirror.
  * Both are `accounts:prepare`, `subLedger`, reach only the RETAINED_EARNINGS control account, and carry no VAT.
* **PostingService:** a journal with an income or expense line takes a shared company close lock; one dated in a closed year is refused (`year_closed`), including journal requests at request time.
* **Management P&L:** closing journals are left out of the lines, the totals and the reconciliation to the ledger. Drill-downs carry `excludeClosing: true`.
* **Balance sheet:** the lines and both P&L-reserve figures leave out closing journals, so they are the same before and after the close. The trial-balance proof includes them. The reconciliation reports `closedToRetainedEarnings`.
* **Statutory preview:** the lines and proofs leave out closing journals, and the trial-balance proof includes them. The notice about the closing journal is replaced.
* **FX report:** closing journals are not exchange differences.
* **General ledger:** `excludeClosing=true` leaves out closing lines, including from the opening balance and the running balance.
* **Trial balance:** unchanged; it includes closes.

### 5b.3 API (behind `accounts.production`; writes `accounts:prepare`, reads `ledger:read`)
* `year-end-closes/preview?yearStart&yearEnd`: the lines, the profit, any warnings, and the reasons it cannot post.
* `year-end-closes` (POST): close the year.
* `year-end-closes` (GET): list.
* `year-end-closes/{id}`: one close, with its journal lines and the year's income and expense net with the close included (zero while live).
* `year-end-closes/{id}/reverse`: post the mirror, with a reason.

All are in OpenAPI.

### 5b.4 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m3b-close.json`, written by hand before the code and recomputed independently in a workbook:
  * two years of manual postings and a V2-M3a accrual auto-reversed into the third year;
  * closing 2025 and 2026, with each closing journal's lines and profit;
  * the trial balance after the close;
  * the balance sheet at both year ends and mid-2027, identical before and after the closes;
  * the 2026 and multi-year P&L, identical before and after;
  * the reversal and the re-close.
* **Tests:**
  * the five categories for both sources;
  * `year_closed` from the service and from the database;
  * the year rules (alignment, gaps, 18 months, overlap, nothing to close), a loss year, and a year spanning two periods;
  * the statutory preview and the FX report the same before and after;
  * general-ledger `excludeClosing`;
  * permissions and tenancy;
  * an architecture test (only the close service writes `year_end_close` and posts its sources);
  * CI green; clean clone; matrix row V2-YEC-01 moved with evidence.

## 5c. V2-M4 - Director and shareholder loan accounts, related parties (specification; DEC-062)
Recorded before code. Matrix rows V2-MOD-09 and V2-MOD-10. No journal source and no ledger writes: V2-M4 reads the ledger.

### 5c.1 Data (one migration, additive)
| Table | Holds | Rules |
|---|---|---|
| `director_loan_account` | Company, person (contact), kind (DIRECTOR, SHAREHOLDER, DIRECTOR_AND_SHAREHOLDER), ledger account, opened on, notes, status (ACTIVE, CLOSED), closed on and reason, author | Non-control ASSET or LIABILITY account, not bank or cash; one live loan account per ledger account and per person; DIRECTOR kinds need a DIRECTOR appointment; facts immutable; ACTIVE -> CLOSED once |
| `director_loan_threshold` | Company, large-movement threshold, overdrawn threshold (each optional, above zero), reason, who and when | Written once; the latest row applies; the history is the audit trail |
| `related_party` | Company, counterparty (contact), relationship, description, from and to dates, status (ACTIVE, ENDED), ended reason, author | One live entry per counterparty and relationship; facts immutable; ended once |

### 5c.2 API (behind `accounts.production`; writes `accounts:prepare`, reads `ledger:read`)
* `director-loan-accounts`:
  * list;
  * create;
  * get, with its statement for `from`/`to`;
  * close.
* `director-loan-accounts/report?from&to`: every account with its opening, movements by category, closing, lowest balance, days overdrawn and flags.
* `director-loan-thresholds`:
  * get the current thresholds and their history;
  * set new ones, with a reason.
* `related-parties`: list; create; get; end.
* `related-parties/report?from&to`: per party, sales, purchases, cash paid and received, owed by and owed to at the end, and the loan account, each with its journals.

All are in OpenAPI.

### 5c.3 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m4-directors.json`, written by hand before the code and recomputed independently in a workbook:
  * one director's loan account through a year: a loan in by bank, money drawn by bank, expenses paid personally, a dividend credited, an asset taken over, a transfer to another loan account and a mixed journal; overdrawn mid-year, then back in credit (the rule that VAT lines are ignored is unit-tested);
  * a second person, a shareholder, overdrawn at the year end;
  * the statements, categories, lowest balances, days overdrawn and flags under set thresholds and under none;
  * a related company that is both customer and supplier, with an invoice, a credit note, a receipt, a bill, a part payment and a cash payment;
  * the related-party report figures and journals.
* **Tests:**
  * database guards;
  * permissions and tenancy;
  * an architecture test (only the V2-M4 service writes its tables; it never writes the ledger);
  * CI green;
  * clean clone;
  * matrix rows V2-MOD-09 and V2-MOD-10 moved, with evidence.

## 5d. V2-M5a - The accounts document (specification; DEC-063)
Recorded before code. V2-M5 is split (DEC-063): V2-M5a is the document; V2-M5b is the size test and the cash flow statement.

### 5d.1 Data (one migration, additive)
| Object | Holds | Rules |
|---|---|---|
| `disclosure_rule` (V2-M1, new columns) | section (POLICIES, NOTES, DIRECTORS_REPORT, BALANCE_SHEET_STATEMENTS), sort, body template, omit when empty | Version content: written while the version is unverified, verified with it, frozen after; the template grammar is checked when written |
| `accounts_fact` | Framework year, key, value, reason, who and when | Keys from the catalogue (`employees.average`, `employees.averagePrior`, `approval.date`, `approval.director`, `text.*`); values typed; written once; the latest row per key applies |

### 5d.2 API (behind `accounts.production`)
* Disclosure rules, under `accounts:rules-manage`, take `section`, `sort`, `body` and `omitWhenEmpty`.
* `accounts-facts?yearStart` (GET, `ledger:read`): the current facts and their history.
* `accounts-facts` (POST, `accounts:prepare`): set a fact, with a reason.
* `accounts-document?yearStart` (GET, `ledger:read`): the header (company, year, standard, version, verified), the statements with comparatives (V2-M1), the sections in order with each item's text and table blocks, omitted items, problems, and `complete`.

All are in OpenAPI.

### 5d.3 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m5a-document.json`, written by hand before the code and recomputed independently in a workbook.
  * **The company:** a synthetic micro-entity across two years, with:
    * a fixed-asset class, an addition in each year, a depreciation run each year and a disposal;
    * a provision made;
    * a director's loan account overdrawn during the year;
    * a related party.
  * **The version:** a verified synthetic version, shaped like FRS 105, holding policies, notes and balance-sheet statements. One small-company rule is not applied to the micro-entity.
  * **Expected output:**
    * the exact rendered text and tables of every item;
    * the fixed-asset movement table reconciled to the balance sheet;
    * a missing fact reported;
    * an empty note omitted.
* **Tests:**
  * the template grammar (refused constructs and unknown keys);
  * verified wording frozen;
  * facts typed and versioned;
  * permissions and tenancy;
  * an architecture test (the document reads; it writes nothing but facts);
  * CI green;
  * clean clone;
  * the matrix rows moved with evidence.

## 5e. Draft wording packs (DEC-064)
At the product owner's instruction, engineering drafted two packs in `content/standards/drafts/`, each reviewable in `v2-draft-wording-review.xlsx`:
* FRS 105 for micro-entities: 6 wording rules.
* FRS 102 Section 1A for small entities: 22 wording rules, with format 1 statements.

How a pack is used:
* It is imported through the API by `scripts/standards/import-pack.mjs` and lands as an UNVERIFIED version.
* It was drafted from engineering's knowledge. Nothing was retrieved from the source.
* It is verified only by the named accountant (DEC-052).
* `tests/unit/standard-packs.test.ts` checks that it is well formed.
* `tests/api/standard-packs.test.ts` checks that it imports and renders.

## 5f. V2-M5b - The size test (specification; DEC-066)
Recorded before code. DEC-066 splits V2-M5b again: V2-M5b is the size test; V2-M5c is the cash flow statement, with its own specification.

### 5f.1 Data (one migration, additive)
| Object | Holds | Rules (service and database) |
|---|---|---|
| `size_threshold_set` | Organisation-scoped. Label; governs years beginning from `effective_from` to `effective_to` (inclusive, open-ended when empty); limits for MICRO, SMALL and MEDIUM (turnover and balance-sheet total to 4 decimals, average employees as a whole number); `prior_year_on_first` (the preceding year is tested against this set when testing the first year it governs); source URL, provision and retrieval date; notes; status UNVERIFIED / VERIFIED / SUPERSEDED; author, verifier, verification time and notes; copied from, superseded by | Starts UNVERIFIED. Changes only while UNVERIFIED. Verified once, by a holder of `accounts:rule-verify` who is not the author, with notes of at least 10 characters. Only a VERIFIED set is superseded, by an UNVERIFIED copy. Current sets of an organisation never overlap. Limits are positive and nested (micro <= small <= medium per measure). Never deleted |
| `reporting_standard_version.turnover_line_key` (new column) | The key of the version's turnover line | A P&L line of the version. Set while UNVERIFIED; frozen with the version; copied when superseded. A line that is the turnover line cannot be removed. Without one, the size test reports that the version names no turnover line |
| `accounts_fact` (V2-M5a, two new keys) | `size.priorMet` (MICRO, SMALL, MEDIUM, LARGE) and `size.priorStatus` (MICRO, SMALL, MEDIUM, LARGE, FIRST_YEAR) | Typed by the service and the database; used only for the earliest framework year |

All new objects: forced row-level security, no DELETE or TRUNCATE for the runtime role, and the V1 guard lists.

### 5f.2 The test (DEC-066)
For a framework year *n*, with the set *S(n)* governing its start date:
1. **Figures**, from the statutory statements of the year on its own version (V2-M1):
   * turnover is the turnover line;
   * the balance-sheet total is the sum of the balance-sheet ACCOUNTS lines with natural side DEBIT;
   * employees is the year's `employees.average`.
2. **Turnover limit:** a year of exactly twelve months uses the set's limit. Any other length compares `turnover x D12 <= limit x D`, where D is the year's days and D12 is the days of the twelve months from its start. The adjusted limit is shown to 2 decimals.
3. **met(C, n)**, for each class C, is three-valued:
   * TRUE when at least two figures are within C's limits;
   * FALSE when at least two exceed them;
   * otherwise UNKNOWN (a missing figure).
4. **The preceding year *n-1*:**
   * **When the platform holds it** (a framework year ending the day before): its figures as in step 1, tested against S(n) if S(n) has `prior_year_on_first` and does not govern *n-1*, otherwise against S(n-1). Its status comes from the same test, recursively.
   * **When it does not:** the facts `size.priorMet` and `size.priorStatus` of year *n*. FIRST_YEAR makes status(n) = met(n).
5. **status(C, n)** = met(C, n) when met(C, n) = met(C, n-1); otherwise status(C, n-1). Either side UNKNOWN gives UNKNOWN. Each status records its basis: BOTH_YEARS, CARRIED_FORWARD or FIRST_YEAR.
6. **Result:**
   * `qualifiesAs` is the smallest class whose status is TRUE; LARGE when none is; UNKNOWN when it cannot be decided.
   * `fits` is false when the chosen `entitySize` is smaller than `qualifiesAs` (MICRO < SMALL < MEDIUM < LARGE).
   * A larger choice than needed fits, with a notice.
   * `verified` is true only when every set used is verified.
   * Problems name every missing set, fact or turnover line, and every unplaced account.

### 5f.3 API (behind `accounts.production`)
* `size-threshold-sets` GET (`ledger:read`) and POST (`accounts:rules-manage`).
* `size-threshold-sets/{id}` GET (`ledger:read`) and PATCH (`accounts:rules-manage`, while unverified).
* `size-threshold-sets/{id}/verify` POST (`accounts:rule-verify`, not the author).
* `size-threshold-sets/{id}/supersede` POST (`accounts:rules-manage`).
* The standard version PATCH and the version view take `turnoverLineKey`.
* `size-test?yearStart` GET (`ledger:read`): the year and the preceding years used, each with figures, limits, conditions, met and status per class and basis, plus `qualifiesAs`, `chosen`, `fits`, `verified`, problems and notices.
* All in OpenAPI; audited with before and after.

### 5f.4 Draft thresholds (DEC-064 pattern)
`content/standards/drafts/uk-size-thresholds.json` holds two draft sets, written from engineering's knowledge of the Companies Act 2006 sections 382, 384A and 465 as amended. They are imported by the same script as UNVERIFIED sets. The verifier checks the figures, dates and the transitional rule against the instruments.

### 5f.5 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m5b-size.json`, written by hand before the code and recomputed independently in a workbook.
  * **The company:** a synthetic company with four framework years, 2024 to 2026 and a six-month 2027, on a verified synthetic version.
  * **The thresholds:** two verified synthetic sets, the second testing the preceding year on its first year.
  * **Expected output:**
    * the earliest year carried from the preparer's facts (qualifies as SMALL, while MICRO was chosen: does not fit);
    * a year exceeding the micro limits once, which carries the status;
    * the transitional rule turning the company into a micro-entity;
    * the short year's adjusted turnover limit deciding a condition;
    * other income left out of turnover;
    * closed years giving the same figures.
* **Tests:**
  * the three-valued conditions and the two-year rule (unit, every combination);
  * thresholds verified by a second person and frozen (service and database);
  * nesting and overlap refused;
  * missing facts, sets and turnover line reported;
  * permissions and tenancy;
  * the draft thresholds import as UNVERIFIED;
  * an architecture test (the size test reads, writes nothing);
  * CI green, clean clone, the matrix rows moved with evidence.

## 5g. V2-M5c - The cash flow statement (specification; DEC-067)
Recorded before code.

### 5g.1 Data (one migration, additive; version content, verified and frozen with the version, copied when superseded)
| Object | Holds | Rules |
|---|---|---|
| `cash_flow_class` | Per version: key, section (OPERATING, INVESTING, FINANCING), sort, caption, non-cash caption (investing and financing), optional inflow and outflow captions | Key unique per version and never `CASH`; the non-cash caption is required for investing and financing; inflow and outflow captions both or neither, investing and financing only |
| `cash_flow_map_entry` | Per version: V1 reporting line, optional account subtype, target (a class key or `CASH`) | One per (line, subtype); the most specific wins |
| `reporting_standard_version` (two columns) | `cash_flow_applies_to` (entity sizes) and `cash_flow_captions` (profit, operating, investing, financing, netChange, opening, closing) | When any size is listed, every caption is set and some entry maps to CASH |

### 5g.2 The computation (DEC-067)
For a year and its comparative on the year's version, closing journals left out. For each non-cash account:
* E = -(net debit movement);
* C = the same over journals with a cash line;
* N = E - C.

The profit line is the E of the P&L accounts the map does not place.

The statement:
* **Operating:**
  * profit;
  * then, per investing or financing class, the sum of N, under its non-cash caption;
  * then, per operating class, the sum of E;
  * then the section total.
* **Investing and financing:** per class, the sum of C (gross by direction when the class has inflow and outflow captions), then the total.
* **Net change, opening and closing cash.** A line that is zero in both years is left out.
* **Each line** lists its accounts and amounts.
* **Unplaced accounts:** a balance-sheet account with a movement and no target goes to an "Unclassified movements" line in operating and is reported as a problem.
* **Proof:** the net change equals the cash accounts' movement, and opening plus the change equals closing.

### 5g.3 API (behind `accounts.production`)
* Under `reporting-standard-versions/{id}` (`accounts:rules-manage`, while unverified):
  * `cash-flow-classes`: create, update, remove;
  * `cash-flow-map-entries`: create, update, remove.
* The version PATCH takes `cashFlowAppliesTo` and `cashFlowCaptions`; the version view shows the classes and the map.
* `cash-flow?yearStart&compare` (`ledger:read`): the statement with comparatives, accounts per line, the proof, unplaced accounts, problems and notices.
* The accounts document includes the statement when the year's size is listed.
* All in OpenAPI.

### 5g.4 Acceptance
* **Golden (DEC-054):** `tests/golden/v2-m5c-cash-flow.json`, written by hand before the code and recomputed independently in a workbook.
  * **The company:** a synthetic medium-sized company over 2025 and 2026, with credit sales and purchases, stock, fixed-asset purchases, depreciation and a disposal with proceeds, a loan raised and repaid, interest paid and accrued, interest received, tax charged and paid, shares issued, and a dividend paid; 2025 is closed.
  * **The version:** a verified synthetic version with synthetic classes and captions.
  * **Expected output:** every line of 2026 with its 2025 comparative, the proof, and the direct check that operating cash equals receipts less payments.
* **Tests:**
  * the identity on generated ledgers (unit);
  * content verified and frozen (service and database);
  * an unplaced account shown and reported;
  * a small company's document without the statement;
  * permissions and tenancy;
  * an architecture test (reads only);
  * CI green, clean clone, the matrix rows moved with evidence.

## 6. Legal and standards context
See `v2-proposal.md` section 6. The rules entered into the framework are the firm's, from the current text of FRS 102 and FRS 105 and the Companies Act 2006 accounts regulations, verified by its named accountant; engineering builds the mechanism and tests it on synthetic data.
