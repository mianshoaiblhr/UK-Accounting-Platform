# V1 Core Bookkeeping - plan and design

Status: V1 started 2026-10-09 after DEC-001. Authority: `docs/specifications/V1_Core_Bookkeeping.md`, the master manifest (non-negotiable accounting controls), `decision-log.md`. Requirement matrix: `v1-compliance-matrix.md|json|xlsx` (77 rows). Nothing here is production-approved (DEC-006). Development data is synthetic (DEC-003).

## 1. Principles carried from V0 (not re-decided)
Tenant isolation by forced row-level security; one central authoriser for company-level permissions; append-only records protected by privileges first and triggers second; additive migrations written for a non-superuser owner (ADR-27); audit events in the business transaction; outbox events; feature flags for unfinished functionality; OpenAPI is the contract and every route is documented; failures and retries visible; no raw SQL built from strings.

## 2. Milestones (each ends with an acceptance package, DEC-007)
| Milestone | Scope | Status |
|---|---|---|
| M1 | Ledger core: chart of accounts, period states and close controls, **PostingService**, journals (manual + reversal), general ledger, trial balance | in progress |
| M2 | Customers (contacts with a customer role), VAT foundation (codes, rates effective-dated, scheme basics), sales invoices, credit notes, receipts, duplicate-document check | planned |
| M3 | Suppliers, purchases, debit notes, payments, cash | planned |
| M4 | Bank accounts, statement import (async job), transfers, charges, interest, reconciliation (matched / partial / unmatched / suggested / manual override) | planned |
| M5 | Profit and loss, balance sheet (from the trial balance only), drill-down to source transaction and document, controls and alerts (suspense, negative cash, unposted) | planned |
| M6 | V1 UI slices behind feature flags, tested against the real API (DEC-002) | planned, runs in parallel from M1 |

Order is by dependency: nothing can post before the PostingService; nothing reports before the ledger; reconciliation needs bank transactions and the ledger.

## 3. M1 design

### 3.1 Data (migration `20260106000000_v1_ledger_core`, additive)
* `account`: company-scoped chart of accounts. `code` (unique per company), `name`, `type` (ASSET | LIABILITY | EQUITY | INCOME | EXPENSE), `subtype` (registry, constrained to the type), `is_control` + `control_kind` (TRADE_RECEIVABLES, TRADE_PAYABLES, VAT, BANK, CASH, SUSPENSE, RETAINED_EARNINGS ...), `tax_treatment` (NOT_APPLICABLE | VATABLE | EXEMPT | OUT_OF_SCOPE | VAT_CONTROL), `reporting_mapping` (versioned report-line registry), `active_from` / `active_to`, `is_system`. Never deleted (deactivated); `code`, `type`, control flags immutable once the account has postings.
* `journal`: one posted accounting event. `journal_number` (per company, gapless within committed work), `journal_date`, `period_id`, `source_type` + `source_id` (+ `source_reference`), `description`, `currency` (the company's base currency), `total` (debits), `line_count`, `actor_type` (USER | SYSTEM), `posted_by_user_id`, `posted_at`, `correlation_id`, `idempotency_key` (unique per company), `reverses_journal_id` (unique: a journal is reversed at most once).
* `journal_line`: `account_id`, `debit`, `credit` (both `NUMERIC(19,4)`, non-negative, exactly one positive), `description`; carries `company_id` so a composite foreign key proves the account belongs to the journal's company.
* `ledger_sequence`: per-company counter (row lock serialises numbering).
* Permissions (company scope): `account:read`, `account:manage`, `ledger:read`, `journal:post`, `period:lock`.
* Feature flag `bookkeeping.core` (default off while V1 is incomplete).

### 3.2 PostingService (`packages/accounting`)
The only code that writes `journal` / `journal_line` (architecture test, like the task rule). One transaction, in this order, each step a validator that fails with a typed error:
1. **actor** - USER or SYSTEM only; an AI actor is refused (manifest control 10); the source type must be one the actor kind may use.
2. **permission** - the source type's required permission (`journal:post` for manual and reversal) evaluated for the company through the central authoriser.
3. **source** - registered source type; `source_id`/reference present; idempotency key (a repeat with the same key and the same content returns the existing journal; the same key with different content is a conflict).
4. **period** - the period containing the journal date exists and is OPEN.
5. **accounts** - every account exists in this company, is active on the journal date, and (for MANUAL sources) is not a control account.
6. **currency / amounts** - company base currency; amounts non-negative, one side per line, no more decimals than the currency's minor units; at least two lines.
7. **balance** - total debits equal total credits.
8. **tax** - validator chain slot; the VAT validator is added in M2 (V1-POST-05 stays open until then).
Then it numbers the journal, inserts it and its lines with the database posting flag set (`set_config('app.posting','on',true)`), writes the audit event and the `transaction.posted` outbox event, and returns the journal.

**Database defence in depth** (each tested by writing around the service): inserts into `journal`/`journal_line` are refused without the posting flag; lines can only be added in the transaction that created their journal (xmin check, the V0 workflow-guard technique); a deferred constraint trigger re-checks balance and line count at commit; period must be OPEN and contain the date; account must be active; no `UPDATE`/`DELETE`/`TRUNCATE` privilege on either table and mutation triggers as the second line. **Honest limit (as in V0):** the flag is asserted by the application; code that can run arbitrary SQL as the runtime role could set it. Mitigations: no raw SQL anywhere (architecture test), the runtime role owns nothing, and the architecture test names the single writer.

**Reversal:** `reverse(journalId, date, reason)` posts a mirror journal (`source_type = REVERSAL`, `source_id` = the original, `reverses_journal_id` set), in an open period, once per original; a reversal cannot itself be reversed (post a new journal instead). Corrections are always new journals.

### 3.3 Period states
`OPEN -> CLOSED` (`period:manage`), `CLOSED -> OPEN` (reopen, `period:manage`, reason), `CLOSED -> LOCKED` (`period:lock`, reason), `LOCKED -> CLOSED` (unlock, `period:lock`, reason). `OPEN -> LOCKED` and any other jump are refused (database trigger + API). Posting needs OPEN. Each transition is audited with before/after and reason and emits an outbox event. Close checks in M1: the period's trial balance is balanced (always true by construction, asserted) - further close controls (unposted documents, unreconciled bank items) are added by M2-M5 as their data exists.

### 3.4 API (all under `/organisations/{org}/companies/{company}`; flag `bookkeeping.core`)
`GET/POST /accounts`, `GET/PATCH /accounts/{id}`, `POST /accounts/initialise` (default UK chart, only when empty); `POST /journals`, `GET /journals`, `GET /journals/{id}`, `POST /journals/{id}/reverse`; `GET /ledger?accountId&from&to` (general ledger with running balance); `GET /reports/trial-balance?periodId|asOf`; `POST /periods/{id}/close|reopen|lock|unlock`.
Money is a decimal string everywhere ("1234.50"), never a JSON number.

### 3.5 Reports come from the ledger only
The trial balance sums `journal_line`; it never reads source documents. It returns per-account debit/credit/balance, totals, `balanced`, and warnings (non-zero suspense balance). Every row carries the drill-down parameters of the general-ledger query; every ledger line carries its journal and source reference (report -> account -> journal -> source). Source-transaction and document links per source module arrive with M2+.

### 3.6 As built (M1)
Migration `20260106000000_v1_ledger_core`; package `packages/accounting` (`PostingService`, `AccountService`, `PeriodService`, `LedgerQueries`); API controller `apps/api/src/ledger` (flag `bookkeeping.core`, default off; the test environment turns it on); permissions `account:read`, `account:manage`, `ledger:read`, `journal:post`, `period:lock` added to the catalogue and the system roles (partner/admin/owner: all; manager/accountant: all but lock; bookkeeper/reviewer: read; client viewer: none).
Two hardening decisions made during the build (found by reviewing the design against the manifest, each with a test):
1. **Closing cannot race a posting.** The PostingService (and the database guard) take `FOR SHARE` on the period row; a concurrent close/lock is an `UPDATE` of that row and waits for the posting to commit, and a close that committed first is seen. Without this a journal could land in a period closed a moment earlier.
2. **Opening balances are fenced.** `OPENING_BALANCE` is the one manual source allowed onto control accounts (a company must be able to start with debtors, creditors and bank), so it is only accepted dated on the first day of the company's earliest period. It is audited like any journal; a dedicated permission or approval step for it is an open decision (section 4).
Verified by `tests/platform/posting-service.test.ts` (positive, negative, reversal, period-lock, idempotency, concurrency, atomicity, reads), `tests/db/ledger.test.ts` (the database defends the ledger when the service is bypassed), `tests/api/ledger.test.ts` (roles, tenants, feature flag, periods, drill-down), `packages/contracts/src/ledger.test.ts`, the architecture rules (single writer of the ledger, single setter of the posting switch, AI/platform/worker cannot import the accounting package), the privilege matrix and the populated-database upgrade.

## 4. Open V1 decisions (none blocks M1; each needs a recorded decision before its milestone)
1. **Foreign currency** (V1-POST-06): M1 posts in the company's base currency only. Multi-currency invoices, FX rates and revaluation need a decision on scope and rate source before M2.
2. **VAT scope** (M2): schemes supported in the "foundation" (standard accounting, cash accounting, flat rate?), rate source and effective-dating; MTD returns are V5.
3. **Customers/suppliers model** (M2/M3): reuse `contact` with a role (recommended) versus separate tables.
4. **Bank statement formats** (M4): CSV first; OFX/MT940/Open Banking are V11.
5. **Manual-journal review**: M1 posts on `journal:post`; a maker/checker workflow for manual journals can reuse the V0 workflow engine and is a candidate for M5 controls.
6. **Opening balances / migration from other systems**: `OPENING_BALANCE` exists (fenced to the first day of the first period); whether it needs its own permission or an approval step, and the import path (V11), are open.
7. **Control-account policy**: manual journals may not touch control accounts (ADR-46). Whether a firm may relax that with an explicit permission is open.

## 5. Known limitations carried into M1 (to be listed again in its acceptance package)
Trial balance is computed on demand (no materialised balances; fine for synthetic and small data, to be measured before production); journal numbering serialises postings per company; no UI (M6); no foreign currency; the VAT validator is not yet present.
