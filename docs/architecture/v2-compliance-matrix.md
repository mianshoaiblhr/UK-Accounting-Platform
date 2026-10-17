# V2 Accounts Production - compliance matrix (plan version 1)

Source requirements: docs/specifications/V2_Accounts_Production_FRS102_FRS105.md, 00_MASTER_IMPLEMENTATION_MANIFEST.md, decision-log.md DEC-051..054.

Generated from `v2-compliance-matrix.json`. **Statuses change only with evidence (code and passing tests); a requirement is never marked implemented because a table or flag exists.** Owners are roles, not people: *Engineering* builds, *product owner* decides scope and policy, *qualified tax reviewer* / *DPO / legal* verify rules the product cannot verify itself.

## Plan history (append-only)

* v1.0 (2026-10-17, DEC-051..054): matrix created from the V2 specification at V2-M0; 60 rows, all MISSING; MAN-ACC-09 carried from the V1 matrix (decided in DEC-051, built in V2-M1).

## Summary

| Status | Rows |
|---|---|
| IMPLEMENTED | 0 (0% of applicable) |
| PARTIALLY IMPLEMENTED | 0 (0% of applicable) |
| MISSING | 60 (100% of applicable) |
| NOT APPLICABLE | 0 |
| **Total** | **60** |

## Milestones

| Milestone | Scope | Status | Owner | Depends on | Rows | Implemented |
|---|---|---|---|---|---|---|
| V2-M0 | Decisions, plan, matrix, ADRs | RECORDED 2026-10-17 (DEC-051..054, ADR-62..64) | Engineering | V2 approval (DEC-051) | 0 | 0 |
| V2-M1 | Reporting framework as data | specified (v2-plan.md section 3) | Engineering (build); qualified accountant (rules) | V2-M0 | 9 | 0 |
| V2-M2 | Fixed assets and depreciation | planned | Engineering | V2-M1 | 10 | 0 |
| V2-M3 | Year-end adjustments and the closing journal | planned | Engineering | V2-M2 | 4 | 0 |
| V2-M4 | Director balances and related parties | planned | Engineering | V2-M3 | 2 | 0 |
| V2-M5 | Statements and notes (FRS 105, FRS 102 1A, FRS 102) | planned | Engineering (build); qualified accountant (rules) | V2-M1; V2-M3; V2-M4 | 8 | 0 |
| V2-M6 | Year-end workflow, review, approval, filing-ready package | planned | Engineering | V2-M5 | 26 | 0 |
| V2-M7 | Screens behind accounts.production | planned | Engineering (front end) | each API milestone | 1 | 0 |

A milestone is accepted on an acceptance package: commit SHA, CI run (every job), test results, migrations, security/permission checks, matrix changes, known limitations (DEC-007). Under the delegation (DEC-019, DEC-051) engineering records acceptance; rules stay unverified until the named accountant verifies them (DEC-052).

## V2-M0 - Decisions, plan, matrix, ADRs

**Status:** RECORDED 2026-10-17 (DEC-051..054, ADR-62..64)  
**Owner:** Engineering  
**Depends on:** V2 approval (DEC-051)  
**Acceptance:** v2-plan.md section 2  
**Deferred scope:** -

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|

## V2-M1 - Reporting framework as data

**Status:** specified (v2-plan.md section 3)  
**Owner:** Engineering (build); qualified accountant (rules)  
**Depends on:** V2-M0  
**Acceptance:** v2-plan.md section 3.5  
**Deferred scope:** Notes rendering, size test, cash flow (V2-M5); screens (V2-M7)

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-ARC-01** | V2 FRS Architecture | Reporting rules never hard-coded in transaction logic | **MISSING** | Engineering | ADR-62 | Statements, notes and validations come only from framework tables; an architecture test fails if transaction modules read them or if the report service reads source documents (ADR-63). | - |  |  |
| **V2-ARC-02** | V2 FRS Architecture | Standard -> effective date -> reporting map -> disclosure rules -> validation rules | **MISSING** | Engineering (build); qualified accountant (rules) | DEC-053 | Each layer is a table keyed to an effective-dated standard version; a company's financial year selects one version; changing the version changes the output without code. | - |  |  |
| **V2-ARC-03** | V2 FRS Architecture | Support FRS 102, FRS 105 and future standards without redesign | **MISSING** | Engineering (build); qualified accountant (rules) | V2-ARC-02 | Two synthetic standards with different layouts produce their own statements from the same ledger in tests; a third is added as data only. | - |  |  |
| **V2-ARC-04** | DEC-052 | Every standard rule sourced and verified by a second person; unverified rules give previews only | **MISSING** | Engineering (build); qualified accountant (rules) | DEC-052 | Author cannot verify (service and database); verified records immutable; a change supersedes; previews carry verified=false and a notice; filing-ready output refuses unverified rules (V2-M6). | - |  |  |
| **MAN-ACC-09** | Manifest accounting controls (carried from V1) | Tax and reporting rules are effective-dated/versioned | **MISSING** | Engineering (build); qualified accountant (rules) | V2-ARC-02 | Reporting maps effective-dated in the database with source and verification status (decided in DEC-051); a test proves a later version does not alter an earlier year's output. | - |  | Carried from the V1 matrix (VAT rates already effective-dated there) |
| **V2-MOD-02** | V2 Modules | Trial balance mapping | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Every account of the trial balance lands on exactly one statutory line through the map or an override; unmapped and doubly mapped accounts are listed. | - |  |  |
| **V2-MOD-11** | V2 Modules | Comparative periods | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Statements show the prior financial year on the same standard version, from the ledger. | - |  |  |
| **V2-OUT-06** | V2 Accounts Output | Comparatives | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-TEST-01** | V2 Tests | Golden trial balances and expected statutory outputs | **MISSING** | Engineering (build); qualified accountant (rules) | DEC-054 | Each scenario's expected statements and notes are hand-written data in tests/golden/ and matched to the cent; the named accountant reviews them before verifying the rules they exercise. | - |  |  |

## V2-M2 - Fixed assets and depreciation

**Status:** planned  
**Owner:** Engineering  
**Depends on:** V2-M1  
**Acceptance:** to be specified before code  
**Deferred scope:** Capital allowances (V4)

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-MOD-03** | V2 Modules | Fixed assets | **MISSING** | Engineering | V2-M1 | See V2-FA rows. | - |  |  |
| **V2-MOD-04** | V2 Modules | Depreciation | **MISSING** | Engineering | V2-M1 | Depreciation runs post through the PostingService per class and method, once per period, reversible only by its own mirror; registry entry with five test categories. | - |  |  |
| **V2-FA-01** | V2 Fixed Assets | Additions | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-02** | V2 Fixed Assets | Disposals (with gain or loss) | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-03** | V2 Fixed Assets | Depreciation methods (straight line, reducing balance) | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-04** | V2 Fixed Assets | Useful lives | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-05** | V2 Fixed Assets | Residual value | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-06** | V2 Fixed Assets | Asset classes | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |
| **V2-FA-07** | V2 Fixed Assets | Tax vs accounting treatment kept apart | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | Capital allowances computations (V4) |  |  |
| **V2-FA-08** | V2 Fixed Assets | Reconciliation of the register to the ledger | **MISSING** | Engineering | V2-M1 | Implemented with service, database and API tests and a hand-calculated golden example; postings through the PostingService with the five test categories; register reconciles to the cost and depreciation accounts to the cent. | - |  |  |

## V2-M3 - Year-end adjustments and the closing journal

**Status:** planned  
**Owner:** Engineering  
**Depends on:** V2-M2  
**Acceptance:** to be specified before code  
**Deferred scope:** -

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-MOD-05** | V2 Modules | Accruals | **MISSING** | Engineering | V2-M1 | Accruals post at period end and reverse on the first day of the next period (M3 pattern); listed with their evidence. | - |  |  |
| **V2-MOD-06** | V2 Modules | Prepayments | **MISSING** | Engineering | V2-M1 | Prepayments released over their period by schedule; balance reconciles to the ledger. | - |  |  |
| **V2-MOD-07** | V2 Modules | Provisions | **MISSING** | Engineering | V2-M1 | Provisions recorded with basis and movement (made, used, released) and reconciled to the ledger. | - |  |  |
| **V2-MOD-08** | V2 Modules | Deferred income | **MISSING** | Engineering | V2-M1 | Deferred income released by schedule; balance reconciles to the ledger. | - |  |  |

## V2-M4 - Director balances and related parties

**Status:** planned  
**Owner:** Engineering  
**Depends on:** V2-M3  
**Acceptance:** to be specified before code  
**Deferred scope:** -

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-MOD-09** | V2 Modules | Director/shareholder balances | **MISSING** | Engineering | V2-M1 | Director loan accounts per person with movements and the year-end balance; overdrawn balances and large movements flagged. | - |  |  |
| **V2-MOD-10** | V2 Modules | Related parties | **MISSING** | Engineering | V2-M1 | Related parties recorded with relationship and transactions for the year, available to the notes. | - |  |  |

## V2-M5 - Statements and notes (FRS 105, FRS 102 1A, FRS 102)

**Status:** planned  
**Owner:** Engineering (build); qualified accountant (rules)  
**Depends on:** V2-M1; V2-M3; V2-M4  
**Acceptance:** to be specified before code  
**Deferred scope:** iXBRL (V3)

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-MOD-12** | V2 Modules | Notes | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Notes rendered from verified disclosure rules with their figures from the ledger; required notes per size present. | - |  |  |
| **V2-MOD-13** | V2 Modules | Statutory statements | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | P&L and balance sheet in the layout of the chosen standard version; cash flow where the standard requires it. | - |  |  |
| **V2-OUT-01** | V2 Accounts Output | Profit and loss | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-OUT-02** | V2 Accounts Output | Balance sheet | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-OUT-03** | V2 Accounts Output | Cash flow where applicable | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-OUT-04** | V2 Accounts Output | Notes | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-OUT-05** | V2 Accounts Output | Accounting policies | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |
| **V2-OUT-07** | V2 Accounts Output | Directors/reporting sections where applicable | **MISSING** | Engineering (build); qualified accountant (rules) | V2-M1 | Produced from the ledger through the verified framework and matched to the golden output to the cent. | - |  |  |

## V2-M6 - Year-end workflow, review, approval, filing-ready package

**Status:** planned  
**Owner:** Engineering  
**Depends on:** V2-M5  
**Acceptance:** to be specified before code  
**Deferred scope:** Filing (V3)

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-MOD-01** | V2 Modules | Year-end wizard | **MISSING** | Engineering | V2-M1 | The 14-step workflow (V2-YE rows) guides a financial year from lock to filing-ready package, each step showing its status from the underlying control. | - |  |  |
| **V2-MOD-14** | V2 Modules | Review checklist | **MISSING** | Engineering | V2-M1 | Checklist built from the review flags (V2-RC rows) with sign-off per item. | - |  |  |
| **V2-MOD-15** | V2 Modules | Accounts approval | **MISSING** | Engineering | V2-M1 | Partner review then client approval recorded with person and time; approval locks the year's framework and figures. | - |  |  |
| **V2-YE-01** | V2 Year-End Workflow | Lock/confirm period | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-02** | V2 Year-End Workflow | Bank reconciliation | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-03** | V2 Year-End Workflow | Receivables review | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-04** | V2 Year-End Workflow | Payables review | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-05** | V2 Year-End Workflow | Fixed asset review | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-06** | V2 Year-End Workflow | Accrual/prepayment review | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-07** | V2 Year-End Workflow | Director balances | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-08** | V2 Year-End Workflow | VAT reconciliation | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-09** | V2 Year-End Workflow | Suspense clearance | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-10** | V2 Year-End Workflow | Review adjustments | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-11** | V2 Year-End Workflow | Generate accounts | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-12** | V2 Year-End Workflow | Partner review | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-13** | V2 Year-End Workflow | Client approval | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | - |  |  |
| **V2-YE-14** | V2 Year-End Workflow | Filing-ready package | **MISSING** | Engineering | V2-M1..M5 | The step reads its status from the existing control (V1 reconciliation sign-off, ageing, VAT reconciliation, alerts, V2 registers), records the reviewer's sign-off with time and notes, and blocks the next step where the specification requires it. | iXBRL and Companies House filing (V3) |  |  |
| **V2-RC-01** | V2 Review Controls | Unexplained movements | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-02** | V2 Review Controls | Material changes | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-03** | V2 Review Controls | Unusual balances | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-04** | V2 Review Controls | Negative balances | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-05** | V2 Review Controls | Old receivables/payables | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-06** | V2 Review Controls | Director loan movements | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-07** | V2 Review Controls | Suspense | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-08** | V2 Review Controls | Unreconciled bank | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |
| **V2-RC-09** | V2 Review Controls | Missing supporting evidence | **MISSING** | Engineering | V1-M8 alerts, V2-M2..M4 | Raised on the year-end review with its figures and drill-down, thresholds as data, cleared or explained with a reason by a named reviewer. | - |  |  |

## V2-M7 - Screens behind accounts.production

**Status:** planned  
**Owner:** Engineering (front end)  
**Depends on:** each API milestone  
**Acceptance:** to be specified before code  
**Deferred scope:** -

| ID | Reference | Requirement | Status | Owner | Dependencies | Acceptance criteria | Deferred scope | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **V2-DOD-01** | Manifest definition of done | V2 workflows usable in screens | **MISSING** | Engineering | V2-M1..M6 | Every V2 module has screens behind accounts.production, real-browser tested (DEC-050 pattern). | - |  |  |
