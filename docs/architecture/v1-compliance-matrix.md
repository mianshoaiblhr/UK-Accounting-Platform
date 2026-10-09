# V1 Core Bookkeeping - compliance matrix

Source requirements: docs/specifications/V1_Core_Bookkeeping.md, 00_MASTER_IMPLEMENTATION_MANIFEST.md (non-negotiable accounting controls), 13_CROSS_PLATFORM_PRODUCT_REQUIREMENTS.md.

Generated from `v1-compliance-matrix.json`. **Statuses change only with evidence (code and passing tests); a requirement is never marked implemented because a table or flag exists.**

## Summary

| Status | Rows |
|---|---|
| IMPLEMENTED | 26 (33% of applicable) |
| PARTIALLY IMPLEMENTED | 11 (14% of applicable) |
| MISSING | 40 (51% of applicable) |
| NOT APPLICABLE | 0 |
| **Total** | **77** |

## Milestones

| Milestone | Scope | Rows | Implemented |
|---|---|---|---|
| M1 | Ledger core: chart of accounts, period states, PostingService, journals, general ledger, trial balance | 34 | 26 |
| M2 | Contacts as customers/suppliers, VAT foundation, sales, credit notes, receipts | 12 | 0 |
| M3 | Purchases, debit notes, payments, cash | 7 | 0 |
| M4 | Bank accounts, statement import, transfers, charges, interest, reconciliation | 15 | 0 |
| M5 | Profit and loss, balance sheet, drill-down to documents, controls and alerts | 8 | 0 |
| M6 | V1 UI slices behind feature flags (DEC-002) | 1 | 0 |

A milestone is accepted by the product owner on an acceptance package: commit SHA, CI run (every job), test results, migrations, security/permission checks, matrix changes, known limitations (DEC-007).

## M1 - Ledger core: chart of accounts, period states, PostingService, journals, general ledger, trial balance

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-MOD-01** | V1 Modules | Chart of Accounts | **IMPLEMENTED** | account table + AccountService + /accounts API + default UK chart (UK_SMALL_COMPANY v1). migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: tests/api/ledger.test.ts (chart), tests/db/ledger.test.ts (account guards), packages/contracts/src/ledger.test.ts |  |
| **V1-MOD-13** | V1 Modules | Journals | **IMPLEMENTED** | POST /journals (manual and opening-balance sources), GET /journals[/id], POST /journals/{id}/reverse; all through the PostingService. Tests: tests/platform/posting-service.test.ts, tests/api/ledger.test.ts | Posting only: no draft or approval step for manual journals (open decision 5 in v1-plan.md) |
| **V1-MOD-14** | V1 Modules | General Ledger | **IMPLEMENTED** | GET /ledger (general ledger per account, running balance, keyset paging recomputed per page). Tests: tests/platform/posting-service.test.ts (one page equals paged), tests/api/ledger.test.ts |  |
| **V1-MOD-15** | V1 Modules | Trial Balance | **IMPLEMENTED** | GET /reports/trial-balance (as at a date or a period with movement; journal lines only; balanced flag; suspense warning; drill-down parameters). Tests: tests/platform/posting-service.test.ts, tests/api/ledger.test.ts (independent SQL check) |  |
| **V1-MOD-19** | V1 Modules | Accounting Periods (explicit states and close controls) | **IMPLEMENTED** | OPEN<->CLOSED->LOCKED->CLOSED with database-enforced graph, period:manage / period:lock, mandatory reasons, audit before/after, events, concurrency-safe. Tests: tests/platform/posting-service.test.ts (period controls), tests/db/ledger.test.ts, tests/api/ledger.test.ts | Close controls beyond 'ledger balances' are added by M2-M5 as their data exists (see MAN-ACC-08) |
| **V1-ARC-01** | V1 Accounting Architecture | Source document -> transaction service -> PostingService -> journal -> journal lines -> ledger | **PARTIALLY IMPLEMENTED** | PostingService -> journal -> journal_line -> ledger exists with MANUAL, OPENING_BALANCE and REVERSAL sources. No source-document transaction services yet (M2+). Tests: tests/platform/posting-service.test.ts | M1 delivers PostingService + journals + ledger with manual and reversal sources; each later milestone adds a transaction service |
| **V1-ARC-02** | V1 Accounting Architecture | Financial statements are never calculated from source transactions (Trial Balance -> P&L / Balance Sheet) | **PARTIALLY IMPLEMENTED** | Trial balance and general ledger aggregate journal_line only (architecture: no report reads source tables). P&L and balance sheet are M5. Tests: tests/platform/posting-service.test.ts, tests/api/ledger.test.ts | Trial balance in M1; statements in M5, both from journal lines only |
| **V1-COA-01** | V1 Chart of Accounts | Account code | **IMPLEMENTED** | account.code (unique per company, 1-20 chars). migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-02** | V1 Chart of Accounts | Account name | **IMPLEMENTED** | account.name. migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-03** | V1 Chart of Accounts | Account type | **IMPLEMENTED** | account.type (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE). migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-04** | V1 Chart of Accounts | Account subtype | **IMPLEMENTED** | account.subtype (registry constrained to the type). migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-05** | V1 Chart of Accounts | Control account flag | **IMPLEMENTED** | account.is_control + control_kind (receivables, payables, VAT, bank, cash, suspense, retained earnings); manual journals cannot post to control accounts. migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-06** | V1 Chart of Accounts | Tax treatment | **IMPLEMENTED** | account.tax_treatment (account level). migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts | Account-level treatment in M1; VAT codes on lines arrive with the VAT foundation (M2) |
| **V1-COA-07** | V1 Chart of Accounts | Reporting mapping | **IMPLEMENTED** | account.reporting_mapping from a versioned report-line registry, checked against the type. migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-COA-08** | V1 Chart of Accounts | Active dates | **IMPLEMENTED** | account.active_from / active_to enforced on every posting date; deactivation cannot precede the last posting. migration 20260106000000_v1_ledger_core; packages/accounting; apps/api/src/ledger; ADR-44..48. Tests: packages/contracts/src/ledger.test.ts, tests/api/ledger.test.ts, tests/db/ledger.test.ts |  |
| **V1-POST-01** | V1 Posting Engine | PostingService is the sole service authorised to post ledger entries | **IMPLEMENTED** | Single writer enforced three ways: architecture test (only packages/accounting/src/posting.ts writes journal/journal_line/ledger_sequence; only it sets app.posting; platform/AI/worker cannot import the package), database guard (insert refused without the transaction flag), privileges. Tests: tests/unit/architecture.test.ts, tests/db/ledger.test.ts | Honest limit: the flag is application-asserted (same trust boundary as tenant context) |
| **V1-POST-02** | V1 Posting Engine | Validate: balanced journal | **IMPLEMENTED** | Application check + deferred constraint trigger at commit (header agrees with lines, contiguous numbering, reversal mirrors original). Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts |  |
| **V1-POST-03** | V1 Posting Engine | Validate: valid accounts | **IMPLEMENTED** | Accounts must exist in the company (composite FK), be active on the journal date, and not be control accounts for manual sources. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts, tests/api/ledger.test.ts |  |
| **V1-POST-04** | V1 Posting Engine | Validate: valid period | **IMPLEMENTED** | Period must exist, contain the date and be OPEN; period row locked FOR SHARE so a concurrent close cannot race. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts (race test), tests/api/ledger.test.ts |  |
| **V1-POST-06** | V1 Posting Engine | Validate: currency | **PARTIALLY IMPLEMENTED** | Currency validated: journals are in the company base currency and amounts respect its minor units (application + database). Foreign-currency documents, FX rates and revaluation are NOT supported (open decision 1). Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts | Base currency of the company only; foreign-currency postings and FX revaluation are not in V1 scope until a decision is recorded |
| **V1-POST-07** | V1 Posting Engine | Validate: source reference | **IMPLEMENTED** | Registered source type required; REVERSAL must name the reversed journal; other sources require a source id; idempotency key per company with content hash. Tests: tests/platform/posting-service.test.ts, packages/contracts/src/ledger.test.ts |  |
| **V1-POST-08** | V1 Posting Engine | Validate: permissions | **IMPLEMENTED** | Source-specific permission evaluated for the journal's company through the central authoriser; AI actors refused; system actors limited to system sources. Tests: tests/platform/posting-service.test.ts, tests/api/ledger.test.ts (roles x posting), tests/api/permissions.test.ts |  |
| **V1-CTL-01** | V1 Controls | Locked periods | **IMPLEMENTED** | Closed and locked periods refuse postings (service + database); lock needs period:lock. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts, tests/api/ledger.test.ts |  |
| **V1-CTL-03** | V1 Controls | Suspense account visibility | **PARTIALLY IMPLEMENTED** | Trial balance warns about a non-zero suspense balance (account with control kind SUSPENSE). Dashboard alert is M5. Tests: tests/platform/posting-service.test.ts | Trial balance warning in M1; dashboard alert in M5 |
| **V1-CTL-06** | V1 Controls | Audit trail | **PARTIALLY IMPLEMENTED** | journal.posted/reversed, account.created/updated/chart_initialised and period.closed/reopened/locked/unlocked are audited in the business transaction (before/after, reason, actor, source workflow where relevant). Source modules add their own events in M2+. Tests: tests/platform/posting-service.test.ts, tests/api/ledger.test.ts |  |
| **V1-TEST-01** | V1 Tests | Every posting rule: positive, negative, reversal, VAT and period-lock tests | **PARTIALLY IMPLEMENTED** | Positive, negative, reversal and period-lock tests exist for every M1 posting rule; the VAT test arrives with the VAT validator (M2). Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts | Applied per rule as each milestone adds rules; the matrix lists the rule set tested |
| **MAN-ACC-01** | Manifest accounting controls | Only the central PostingService can create posted ledger entries | **IMPLEMENTED** | Single writer enforced three ways: architecture test (only packages/accounting/src/posting.ts writes journal/journal_line/ledger_sequence; only it sets app.posting; platform/AI/worker cannot import the package), database guard (insert refused without the transaction flag), privileges. Tests: tests/unit/architecture.test.ts, tests/db/ledger.test.ts | Same as V1-POST-01 |
| **MAN-ACC-02** | Manifest accounting controls | Posted journals are immutable | **IMPLEMENTED** | No UPDATE/DELETE/TRUNCATE privilege for the runtime role and append-only triggers (the table owner is refused too). Tests: tests/db/ledger.test.ts, tests/db/privileges.test.ts | Privileges, triggers, tests |
| **MAN-ACC-03** | Manifest accounting controls | Corrections use reversal/adjustment journals | **IMPLEMENTED** | Reversal journals: linked both ways, mirror enforced per account at commit, at most once, a reversal cannot be reversed, dated on/after the original, in an open period. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts, tests/api/ledger.test.ts |  |
| **MAN-ACC-04** | Manifest accounting controls | Debits must equal credits | **IMPLEMENTED** | Application validation and a deferred database check at commit. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts | Application and deferred database check |
| **MAN-ACC-05** | Manifest accounting controls | Every posted journal has source, user/system actor, timestamp and audit metadata | **IMPLEMENTED** | journal: source_type/source_id/source_reference, actor_type + posted_by_user_id, posted_at, correlation id, idempotency key; audit event and transaction.posted outbox event in the same transaction. Tests: tests/platform/posting-service.test.ts |  |
| **MAN-ACC-08** | Manifest accounting controls | Accounting periods have explicit states and close controls | **PARTIALLY IMPLEMENTED** | Explicit period states and the transition graph are delivered and enforced; the close controls so far are 'posting stops' and 'ledger balances'. Unposted documents and unreconciled bank items are added by M2-M4. Tests: tests/platform/posting-service.test.ts, tests/db/ledger.test.ts | Same as V1-MOD-19 |
| **MAN-ACC-10** | Manifest accounting controls | AI cannot silently post accounting entries or submit filings | **IMPLEMENTED** | PostingService refuses AI actors (ai_cannot_post); no journal source lists AI; architecture test forbids platform, the AI module and the worker from importing the accounting package. Tests: tests/platform/posting-service.test.ts, packages/contracts/src/ledger.test.ts, tests/unit/architecture.test.ts | PostingService refuses AI actors; architecture test keeps the AI module away from the posting code |
| **XP-07** | Cross-platform 7 | Events: TransactionPosted, BankImported, InvoiceCreated | **PARTIALLY IMPLEMENTED** | transaction.posted and accounting_period.state_changed events are published through the outbox; BankImported and InvoiceCreated arrive with M4 and M2. | TransactionPosted in M1; BankImported M4; InvoiceCreated M2 |

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
| **MAN-ACC-06** | Manifest accounting controls | Every source transaction is traceable to its journal | **PARTIALLY IMPLEMENTED** | Journal -> source via source_type/source_id/source_reference (done); source transaction -> journal is delivered per source module (M2+). | Journal -> source in M1 (source_type/source_id); source -> journal per module |
| **MAN-ACC-09** | Manifest accounting controls | Tax and reporting rules are effective-dated/versioned | **PARTIALLY IMPLEMENTED** | Report mappings are a versioned registry (REPORT_MAPPING_VERSION = 1, returned with every account) but not yet effective-dated in the database; VAT rates are M2. | Reporting mappings versioned in M1; VAT rates effective-dated in M2 |

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
| **V1-RPT-02** | V1 Reporting | Drill-down: Report -> account -> journal -> source transaction -> document | **PARTIALLY IMPLEMENTED** | Report -> account -> journal -> source reference works (trial balance rows carry drill-down parameters; ledger lines carry journal and source). Source transaction and document links arrive with each source module. Tests: tests/api/ledger.test.ts | Report -> account -> journal in M1; source transaction and document links arrive with each source module |
| **V1-CTL-04** | V1 Controls | Negative cash alerts | **MISSING** |  |  |
| **V1-CTL-05** | V1 Controls | Unposted transaction alerts | **MISSING** |  |  |
| **MAN-ACC-07** | Manifest accounting controls | Every report number is drillable to ledger/source evidence | **MISSING** |  | Same as V1-RPT-02 |
| **XP-01** | Cross-platform 1 | Universal drill-down | **MISSING** |  |  |

## M6 - V1 UI slices behind feature flags (DEC-002)

| ID | Reference | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|---|
| **V1-DOD-01** | Manifest definition of done | UI workflows are usable (V1 screens) | **MISSING** |  | DEC-002: parallel behind feature flags |
