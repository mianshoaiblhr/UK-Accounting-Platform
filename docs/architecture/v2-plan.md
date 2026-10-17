# V2 Accounts Production (FRS 102 / FRS 105) - plan and design

Status: V2 approved 2026-10-17 (DEC-051). Authority: `docs/specifications/V2_Accounts_Production_FRS102_FRS105.md`, the master manifest, `decision-log.md` (DEC-051..054), ADR-62..64. Requirement matrix: `v2-compliance-matrix.md|json|xlsx`. Nothing here is production-approved (DEC-006); development data is synthetic (DEC-003). **No accounting-standard rule is verified until the firm names its qualified accountant (DEC-052): until then V2 produces previews only.**

## 1. Principles carried from V0 and V1 (not re-decided)
Everything in V1 plan section 1, plus: only the PostingService writes the ledger (every new V2 posting is a journal source with its five test categories in the posting-rule registry, DEC-047); statements are computed from journal lines only (ADR-63); rules that come from law or standards are data with a source and a second-person verification (DEC-021, DEC-052); screens show what the API computes (DEC-048).

## 2. Milestones (each ends with an acceptance package, DEC-007)
| Milestone | Scope | Status | Owner | Depends on |
|---|---|---|---|---|
| V2-M0 | Decisions DEC-051..054, ADR-62..64, this plan, the V2 matrix | **recorded** (2026-10-17) | Engineering | V2 approval |
| V2-M1 | Reporting framework as data (section 3) | specified (section 3) | Engineering; the named accountant verifies | V2-M0 |
| V2-M2 | Fixed assets: classes, register, additions, disposals, depreciation methods, useful lives, residual values, tax vs accounting treatment, reconciliation to the ledger, depreciation runs | planned | Engineering | V2-M1 |
| V2-M3 | Year-end adjustments: accruals, prepayments, deferred income, provisions with reversal; the year-end closing journal to retained earnings | planned | Engineering | V2-M2 |
| V2-M4 | Director and shareholder balances (director loan movements flagged), related parties | planned | Engineering | V2-M3 |
| V2-M5 | Statements and notes: FRS 105 micro-entity, then FRS 102 Section 1A, then full FRS 102; policies, comparatives, directors' sections; the size test | planned | Engineering; the named accountant | V2-M1, V2-M3, V2-M4 |
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

### 3.4 Not in V2-M1
Rendering notes and policies (V2-M5); the size test from turnover, balance-sheet total and employees (V2-M5); cash flow statements (V2-M5, full FRS 102 only); screens (V2-M7); seeding any real standard content (never: DEC-052).

### 3.5 Acceptance
* Golden trial balance (DEC-054): a synthetic micro-entity year with a hand-written expected P&L and balance sheet under a synthetic version shaped like an FRS 105 layout, matched to the cent with the comparative; an unmapped account reported; an override moving an account between lines (audited); a validation rule (net assets = capital and reserves) passing and a deliberately broken map making it fail.
* Verification: the author cannot verify; a verified version and its children cannot change (service and database); a change supersedes; previews from an unverified version say so.
* Grammar: every construct evaluated exactly; unknown constructs, cycles and foreign keys refused.
* Tenancy and permissions: another organisation sees nothing; each route refuses without its permission.
* Architecture: the statutory report service reads ledger and framework tables only.
* CI green, clean clone, OpenAPI regenerated, the matrix rows for V2-M1 moved with evidence.

## 4. Legal and standards context
See `v2-proposal.md` section 6. The rules entered into the framework are the firm's, from the current text of FRS 102 and FRS 105 and the Companies Act 2006 accounts regulations, verified by its named accountant; engineering builds the mechanism and tests it on synthetic data.
