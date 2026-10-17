# V2 proposal - Accounts Production (FRS 102 / FRS 105)

**Status: APPROVED by the product owner on 2026-10-17 as written (DEC-051).** The plan is `v2-plan.md`; the decisions are DEC-051..054. This proposal is kept unchanged as the approved text. Source requirement: `docs/specifications/V2_Accounts_Production_FRS102_FRS105.md`.

## 1. Objective
Turn the V1 bookkeeping engine into a statutory accounts production system: year-end adjustments, a fixed-asset register, a guided year-end, statutory statements with notes and policies under FRS 105 and FRS 102, review controls, partner review and client approval, ending in a filing-ready package. Filing to Companies House (iXBRL) is V3, corporation tax is V4.

## 2. What V1 already gives V2
| V1 asset | Use in V2 |
|---|---|
| PostingService, journal sources registry, posting-rule coverage registry (DEC-047) | Each new V2 posting (depreciation, accruals, closing journal) is a new journal source, with its five test categories named before it is accepted |
| Period states and close/lock controls (M1, M8) | The year-end locks the financial year; adjustments are posted into it before the lock |
| Revaluation with auto-reversal (M3) | The same pattern for accruals and prepayments that reverse on the first day of the next period |
| Reporting-line registry (versioned, ADR-48) and statements reconciling to the trial balance (M8) | The starting point for statutory formats; V2 moves the mappings into the database, effective-dated (closes MAN-ACC-09) |
| Drill-down from every figure to its document (M8) | Every note and statement line drills to its accounts and documents |
| Alerts (M8), reconciliation sign-off (M7b), VAT reconciliation (M4b) | The year-end checklist reads them instead of recomputing |
| Rule verification by a second person (DEC-021) | The same control for accounting-standard rules: formats, disclosures and thresholds usable only once a qualified accountant verifies them |
| Workflow engine and tasks (V0) | Partner review and client approval steps, with deadlines |

## 3. Architecture principle (from the specification)
Never hard-code reporting rules into transaction logic: **standard -> effective date -> taxonomy / reporting map -> disclosure rules -> validation rules**, all data, effective-dated and versioned, each version carrying its source and its verifier. Supporting FRS 102, FRS 105 and later standards is then data, not a redesign. Statements are computed from the ledger only (as in M8), never from documents.

## 4. Proposed milestones (order by dependency)
| Milestone | Scope | Depends on |
|---|---|---|
| V2-M0 | Decisions, V2 plan, V2 requirement matrix, ADRs; name the qualified accountant who verifies the standard rules | Approval of this proposal |
| V2-M1 | Reporting framework: standards and their effective-dated versions, reporting maps in the database (MAN-ACC-09), disclosure and validation rules as data, rule verification | V2-M0 |
| V2-M2 | Fixed assets: classes, register, additions, disposals, depreciation methods, useful lives, residual values, tax vs accounting treatment kept apart, reconciliation to the ledger, depreciation runs posting through the PostingService | V2-M1 (mappings) |
| V2-M3 | Year-end adjustments: accruals, prepayments, deferred income, provisions, with reversal; the year-end closing journal to retained earnings | V2-M2 |
| V2-M4 | Director and shareholder balances (director loan account movements flagged), related parties | V2-M3 |
| V2-M5 | Statements and notes, FRS 105 micro-entity first (smallest disclosure set), then FRS 102 Section 1A small entities, then full FRS 102: profit and loss, balance sheet, cash flow where applicable, accounting policies, notes, comparatives, directors' sections | V2-M1, V2-M3, V2-M4 |
| V2-M6 | Year-end workflow (the specification's 14 steps) built on V1 controls, review checklist and flags, partner review, client approval, filing-ready package | V2-M5 |
| V2-M7 | Screens for V2-M2 to V2-M6 behind a `accounts.production` flag, real-browser tests | each API milestone |

**Tests:** golden trial balances with expected statutory outputs for each standard and entity size, written and checked by hand before the code that must reproduce them (the specification's requirement), plus the V1 test categories for every new posting rule.

## 5. Decisions needed before V2-M0 (product owner)
1. Approve, amend or reorder this proposal (in particular FRS 105 before FRS 102).
2. Name the qualified accountant who verifies formats, disclosures and size thresholds (as the tax reviewer does for VAT). Without one, V2 rules stay unverified and unusable, exactly as V1's VAT rates do.
3. Decide MAN-ACC-09 as proposed: reporting maps move into the database, effective-dated, in V2-M1.
4. Confirm V2 continues under the delegation of DEC-019 (engineering decides within the approved scope, records each decision before code, and stops at the human gates).
5. Confirm V1's production gates are not a precondition for starting V2 on synthetic data (they remain a precondition for production).

## 6. Legal and standards context (pointers, not advice; to be verified by the named accountant)
| Reference | Why it matters | Link | Check status |
|---|---|---|---|
| Companies Act 2006 s.393 | Directors must not approve accounts unless they give a true and fair view | <https://www.legislation.gov.uk/ukpga/2006/46/section/393> | confirmed by search 2026-10-17 |
| Companies Act 2006 s.396 | Content of Companies Act individual accounts; form and content set by regulations under s.396(3) | <https://www.legislation.gov.uk/ukpga/2006/46/section/396> | confirmed by search 2026-10-17 |
| Small Companies and Groups (Accounts and Directors' Report) Regulations 2008 (SI 2008/409) | Formats and notes for small and micro-entity accounts | <https://www.legislation.gov.uk/uksi/2008/409/contents> | standard address; open before relying on it |
| Large and Medium-sized Companies and Groups (Accounts and Reports) Regulations 2008 (SI 2008/410) | Formats for larger companies | <https://www.legislation.gov.uk/uksi/2008/410/contents> | standard address; open before relying on it |
| FRS 102, Periodic Review 2024 amendments | Effective for periods beginning on or after 1 January 2026 (early application permitted), so golden outputs must follow the amended standard | ICAEW and ICAS summaries: <https://www.icaew.com/insights/viewpoints-on-the-news/2026/mar-2026/frc-issues-amendments-to-frs-102-and-frs105>, <https://icas.com/news-insights-events/news/corporate-financial-reporting/frc-issues-targeted-amendments-to-uk-gaap-to-maintain-international-alignment/> | secondary sources; confirm on the FRC's site |
| FRS 102 / FRS 105 targeted amendments, February 2026 | Effective for periods beginning on or after 1 January 2027 (alignment with IFRS 18) | same as above | secondary sources; confirm on the FRC's site |

## 7. Not in V2
iXBRL tagging and Companies House filing (V3); corporation tax computations and returns (V4); VAT returns and MTD (V5); audit; consolidation and group accounts unless the product owner adds them; charities SORP.
