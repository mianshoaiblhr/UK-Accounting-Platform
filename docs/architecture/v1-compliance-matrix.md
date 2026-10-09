# V1 Core Bookkeeping - compliance matrix

Source requirements: docs/specifications/V1_Core_Bookkeeping.md, 00_MASTER_IMPLEMENTATION_MANIFEST.md (non-negotiable accounting controls), 13_CROSS_PLATFORM_PRODUCT_REQUIREMENTS.md.

Generated from `v1-compliance-matrix.json`. **Statuses change only with evidence (code and passing tests); a requirement is never marked implemented because a table or flag exists.**

## Summary

| Status | Rows |
|---|---|
| IMPLEMENTED | 0 (0% of applicable) |
| PARTIALLY IMPLEMENTED | 2 (2% of applicable) |
| MISSING | 75 (97% of applicable) |
| NOT APPLICABLE | 0 |
| **Total** | **77** |

## Milestones

| Milestone | Scope | Rows | Implemented |
|---|---|---|---|
| M1 | Ledger core: chart of accounts, period states, PostingService, journals, general ledger, trial balance | 34 | 0 |
| M2 | Contacts as customers/suppliers, VAT foundation, sales, credit notes, receipts | 12 | 0 |
| M3 | Purchases, debit notes, payments, cash | 7 | 0 |
| M4 | Bank accounts, statement import, transfers, charges, interest, reconciliation | 15 | 0 |
| M5 | Profit and loss, balance sheet, drill-down to documents, controls and alerts | 8 | 0 |
| M6 | V1 UI slices behind feature flags (DEC-002) | 1 | 0 |

A milestone is accepted by the product owner on an acceptance package: commit SHA, CI run (every job), test results, migrations, security/permission checks, matrix changes, known limitations (DEC-007).

## M1 - Ledger core: chart of accounts, period states, PostingService, journals, general ledger, trial balance

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-01** | V1 Modules | Chart of Accounts | **MISSING** |  |  |
| **V1-MOD-13** | V1 Modules | Journals | **MISSING** |  |  |
| **V1-MOD-14** | V1 Modules | General Ledger | **MISSING** |  |  |
| **V1-MOD-15** | V1 Modules | Trial Balance | **MISSING** |  |  |
| **V1-MOD-19** | V1 Modules | Accounting Periods (explicit states and close controls) | **PARTIALLY IMPLEMENTED** | V0: accounting_period table with OPEN/CLOSED/LOCKED enum, no-overlap constraint, create/list API. No transition rules, no enforcement on postings. |  |
| **V1-ARC-01** | V1 Accounting Architecture | Source document -> transaction service -> PostingService -> journal -> journal lines -> ledger | **MISSING** |  | M1 delivers PostingService + journals + ledger with manual and reversal sources; each later milestone adds a transaction service |
| **V1-ARC-02** | V1 Accounting Architecture | Financial statements are never calculated from source transactions (Trial Balance -> P&L / Balance Sheet) | **MISSING** |  | Trial balance in M1; statements in M5, both from journal lines only |
| **V1-COA-01** | V1 Chart of Accounts | Account code | **MISSING** |  |  |
| **V1-COA-02** | V1 Chart of Accounts | Account name | **MISSING** |  |  |
| **V1-COA-03** | V1 Chart of Accounts | Account type | **MISSING** |  |  |
| **V1-COA-04** | V1 Chart of Accounts | Account subtype | **MISSING** |  |  |
| **V1-COA-05** | V1 Chart of Accounts | Control account flag | **MISSING** |  |  |
| **V1-COA-06** | V1 Chart of Accounts | Tax treatment | **MISSING** |  | Account-level treatment in M1; VAT codes on lines arrive with the VAT foundation (M2) |
| **V1-COA-07** | V1 Chart of Accounts | Reporting mapping | **MISSING** |  |  |
| **V1-COA-08** | V1 Chart of Accounts | Active dates | **MISSING** |  |  |
| **V1-POST-01** | V1 Posting Engine | PostingService is the sole service authorised to post ledger entries | **MISSING** |  | Enforced by an architecture test, a database guard (transaction flag) and privileges |
| **V1-POST-02** | V1 Posting Engine | Validate: balanced journal | **MISSING** |  |  |
| **V1-POST-03** | V1 Posting Engine | Validate: valid accounts | **MISSING** |  |  |
| **V1-POST-04** | V1 Posting Engine | Validate: valid period | **MISSING** |  |  |
| **V1-POST-06** | V1 Posting Engine | Validate: currency | **MISSING** |  | Base currency of the company only; foreign-currency postings and FX revaluation are not in V1 scope until a decision is recorded |
| **V1-POST-07** | V1 Posting Engine | Validate: source reference | **MISSING** |  |  |
| **V1-POST-08** | V1 Posting Engine | Validate: permissions | **MISSING** |  |  |
| **V1-CTL-01** | V1 Controls | Locked periods | **MISSING** |  |  |
| **V1-CTL-03** | V1 Controls | Suspense account visibility | **MISSING** |  | Trial balance warning in M1; dashboard alert in M5 |
| **V1-CTL-06** | V1 Controls | Audit trail | **PARTIALLY IMPLEMENTED** | V0 audit framework (append-only, before/after, reason, source workflow). Ledger actions are not yet audited. |  |
| **V1-TEST-01** | V1 Tests | Every posting rule: positive, negative, reversal, VAT and period-lock tests | **MISSING** |  | Applied per rule as each milestone adds rules; the matrix lists the rule set tested |
| **MAN-ACC-01** | Manifest accounting controls | Only the central PostingService can create posted ledger entries | **MISSING** |  | Same as V1-POST-01 |
| **MAN-ACC-02** | Manifest accounting controls | Posted journals are immutable | **MISSING** |  | Privileges, triggers, tests |
| **MAN-ACC-03** | Manifest accounting controls | Corrections use reversal/adjustment journals | **MISSING** |  |  |
| **MAN-ACC-04** | Manifest accounting controls | Debits must equal credits | **MISSING** |  | Application and deferred database check |
| **MAN-ACC-05** | Manifest accounting controls | Every posted journal has source, user/system actor, timestamp and audit metadata | **MISSING** |  |  |
| **MAN-ACC-08** | Manifest accounting controls | Accounting periods have explicit states and close controls | **MISSING** |  | Same as V1-MOD-19 |
| **MAN-ACC-10** | Manifest accounting controls | AI cannot silently post accounting entries or submit filings | **MISSING** |  | PostingService refuses AI actors; architecture test keeps the AI module away from the posting code |
| **XP-07** | Cross-platform 7 | Events: TransactionPosted, BankImported, InvoiceCreated | **MISSING** |  | TransactionPosted in M1; BankImported M4; InvoiceCreated M2 |

## M2 - Contacts as customers/suppliers, VAT foundation, sales, credit notes, receipts

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-02** | V1 Modules | Customers | **MISSING** |  | V0 contacts exist (master data); customer role/terms are V1 |
| **V1-MOD-04** | V1 Modules | Sales | **MISSING** |  |  |
| **V1-MOD-06** | V1 Modules | Credit Notes | **MISSING** |  |  |
| **V1-MOD-08** | V1 Modules | Receipts | **MISSING** |  |  |
| **V1-MOD-12** | V1 Modules | VAT foundation | **MISSING** |  | Foundation only; MTD returns are V5 |
| **V1-POST-05** | V1 Posting Engine | Validate: VAT treatment | **MISSING** |  | Validator chain exists from M1; the VAT validator ships with the VAT foundation |
| **V1-EX-01** | V1 Sales Example | Sale: Dr Trade Receivables / Cr Revenue / Cr Output VAT | **MISSING** |  |  |
| **V1-EX-03** | V1 Receipt | Receipt: Dr Bank / Cr Trade Receivables | **MISSING** |  |  |
| **V1-EX-05** | V1 Credit Notes | Credit notes reverse or adjust the original economic effect with full source linkage | **MISSING** |  | Sales credit notes M2; purchase (debit) notes M3. The reversal primitive and source linkage ship in M1 |
| **V1-CTL-02** | V1 Controls | Duplicate document checks | **MISSING** |  |  |
| **MAN-ACC-06** | Manifest accounting controls | Every source transaction is traceable to its journal | **MISSING** |  | Journal -> source in M1 (source_type/source_id); source -> journal per module |
| **MAN-ACC-09** | Manifest accounting controls | Tax and reporting rules are effective-dated/versioned | **MISSING** |  | Reporting mappings versioned in M1; VAT rates effective-dated in M2 |

## M3 - Purchases, debit notes, payments, cash

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-03** | V1 Modules | Suppliers | **MISSING** |  |  |
| **V1-MOD-05** | V1 Modules | Purchases | **MISSING** |  |  |
| **V1-MOD-07** | V1 Modules | Debit Notes | **MISSING** |  |  |
| **V1-MOD-09** | V1 Modules | Payments | **MISSING** |  |  |
| **V1-MOD-11** | V1 Modules | Cash | **MISSING** |  |  |
| **V1-EX-02** | V1 Purchase Example | Purchase: Dr Expense/Asset / Dr Input VAT / Cr Trade Payables | **MISSING** |  |  |
| **V1-EX-04** | V1 Payment | Payment: Dr Trade Payables / Cr Bank | **MISSING** |  |  |

## M4 - Bank accounts, statement import, transfers, charges, interest, reconciliation

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-10** | V1 Modules | Bank Accounts | **MISSING** |  |  |
| **V1-MOD-18** | V1 Modules | Reconciliation | **MISSING** |  |  |
| **V1-BANK-01** | V1 Bank | Bank accounts | **MISSING** |  |  |
| **V1-BANK-02** | V1 Bank | Statement imports | **MISSING** |  | Asynchronous job with progress; file formats to be decided in the M4 design |
| **V1-BANK-03** | V1 Bank | Transactions | **MISSING** |  |  |
| **V1-BANK-04** | V1 Bank | Reconciliation | **MISSING** |  |  |
| **V1-BANK-05** | V1 Bank | Unmatched items | **MISSING** |  |  |
| **V1-BANK-06** | V1 Bank | Transfers | **MISSING** |  |  |
| **V1-BANK-07** | V1 Bank | Bank charges | **MISSING** |  |  |
| **V1-BANK-08** | V1 Bank | Interest | **MISSING** |  |  |
| **V1-REC-01** | V1 Reconciliation | Matched | **MISSING** |  |  |
| **V1-REC-02** | V1 Reconciliation | Partially matched | **MISSING** |  |  |
| **V1-REC-03** | V1 Reconciliation | Unmatched | **MISSING** |  |  |
| **V1-REC-04** | V1 Reconciliation | Suggested matches | **MISSING** |  | Rule-based suggestions; AI suggestions are V6 and may only propose |
| **V1-REC-05** | V1 Reconciliation | Manual override with audit | **MISSING** |  |  |

## M5 - Profit and loss, balance sheet, drill-down to documents, controls and alerts

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-16** | V1 Modules | P&L | **MISSING** |  |  |
| **V1-MOD-17** | V1 Modules | Balance Sheet | **MISSING** |  |  |
| **V1-RPT-01** | V1 Reporting | Trial Balance -> P&L / Balance Sheet | **MISSING** |  | Trial balance in M1 |
| **V1-RPT-02** | V1 Reporting | Drill-down: Report -> account -> journal -> source transaction -> document | **MISSING** |  | Report -> account -> journal in M1; source transaction and document links arrive with each source module |
| **V1-CTL-04** | V1 Controls | Negative cash alerts | **MISSING** |  |  |
| **V1-CTL-05** | V1 Controls | Unposted transaction alerts | **MISSING** |  |  |
| **MAN-ACC-07** | Manifest accounting controls | Every report number is drillable to ledger/source evidence | **MISSING** |  | Same as V1-RPT-02 |
| **XP-01** | Cross-platform 1 | Universal drill-down | **MISSING** |  |  |

## M6 - V1 UI slices behind feature flags (DEC-002)

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-DOD-01** | Manifest definition of done | UI workflows are usable (V1 screens) | **MISSING** |  | DEC-002: parallel behind feature flags |
