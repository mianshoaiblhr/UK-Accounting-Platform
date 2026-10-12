# V1 Core Bookkeeping - plan and design

Status: V1 started 2026-10-09 after DEC-001. **Plan version 2 (2026-10-09, DEC-008..014): M1 accepted; milestones re-sequenced; M2-M4 specified.** Authority: `docs/specifications/V1_Core_Bookkeeping.md`, the master manifest (non-negotiable accounting controls), `decision-log.md`. Requirement matrix: `v1-compliance-matrix.md|json|xlsx` (113 rows in plan version 2; each row has an owner, dependencies, acceptance criteria and deferred scope). Nothing here is production-approved (DEC-006). Development data is synthetic (DEC-003).

## 1. Principles carried from V0 (not re-decided)
Tenant isolation by forced row-level security; one central authoriser for company-level permissions; append-only records protected by privileges first and triggers second; additive migrations written for a non-superuser owner (ADR-27); audit events in the business transaction; outbox events; feature flags for unfinished functionality; OpenAPI is the contract and every route is documented; failures and retries visible; no raw SQL built from strings.

## 2. Milestones (plan version 2; each ends with an acceptance package, DEC-007)
| Milestone | Scope | Status | Owner | Depends on |
|---|---|---|---|---|
| M1 | Ledger core | **ACCEPTED** (code baseline `fae5270`, DEC-008) | Engineering | - |
| M2 | Ledger controls: opening-balance permission, control-account adjustments, second-person approval (DEC-012) | **ACCEPTED** (code baseline `d98e3ed`, DEC-015) | Engineering | M1 |
| M3 | Foreign-currency foundation (DEC-009) | **ACCEPTED under delegation** (code baseline `c8fd8c0`, DEC-019); live rate adapters gated | Engineering | M1, M2 accepted |
| M4a | Contact roles: customers and suppliers (DEC-011, DEC-023) | **verified** (code baseline `206b14d`; package `v1-m4a-acceptance.md`) | Engineering | M1-M3 |
| M4b | VAT foundation, standard accounting (DEC-010, DEC-021, DEC-025) | implemented (section 6.4); **every rule usable only after verification by a holder of `tax:rule-verify`**; no figures seeded | Engineering; the firm's qualified tax reviewer | M3, M4a |
| M5a | Sales documents: invoices, credit notes, numbering, checks, credit-note allocation (DEC-026..031) | **specified (section 9)**; in progress | Engineering | M2, M3, M4 |
| M5b | Receipts and allocations, realised FX end to end, statements, aged receivables | specified (section 9) | Engineering | M5a |
| M5c | VAT on foreign-currency documents (V1-VAT-15) | to be specified after M5b; unverified rule (DEC-031) | Engineering; the firm's tax reviewer | M5b |
| M6 | Purchases: bills, debit notes, payments, cash | planned | Engineering | M3, M4, M5 patterns |
| M7 | Bank accounts, statement import, transfers, charges, interest, reconciliation | planned | Engineering | M5, M6 |
| M8 | P&L, balance sheet, drill-down, controls and alerts, FX reporting | planned | Engineering | M3, M5-M7 |
| M9 | V1 UI slices behind feature flags (DEC-002) | planned, parallel from M2 | Engineering (front end) | the API each screen uses |
| Privacy track | Session / challenge IP and user agent (DEC-013) | investigation in progress, **never marked resolved without review** | Engineering; DPO / legal | DEC-003 |

**What changed from version 1 and why** (append-only history is also in the matrix): foreign currency is in V1 and VAT flows must be finalised after it (DEC-009), so M3 (currency) precedes M4 (VAT) and every document milestone; the opening-balance/control-account decision (DEC-012) is a ledger control and becomes M2 before any source document can need it; the old M2-M6 shifted to M5-M9. Order is by dependency: nothing posts before the PostingService, nothing documents before currency and VAT, nothing reconciles before bank data and documents, nothing reports before the ledger.

**A milestone starts only when its specification and dependencies are clear** (second batch of 2026-10-09). Today: M2 is accepted; M3 is specified with its decisions recorded and may start; M4 is specified but blocked by the verification listed in section 7.

## 3. M1 - ledger core (ACCEPTED, DEC-008; design and as-built kept as accepted)
_Section numbers quoted in `v1-m1-acceptance.md` refer to plan version 1; the open decisions it mentions are now answered or re-homed in section 7._

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

## 4. M2 - ledger controls (specification)
**Goal:** replace the M1 interim fence on opening balances with the decided controls (DEC-012) without making posted journals mutable.
**Decisions applied:** distinct permission `ledger:opening-balance`; ordinary manual journals cannot touch control accounts; narrowly authorised **control-account adjustments** with reason, evidence and audit trail; **configurable second-person approval** for material opening balances and exceptional control-account adjustments; reversal-based correction only.

### 4.1 Permissions (COMPANY scope; system roles seeded by migration, kept in sync by tests)
| Permission | Meaning | Owner / admin / partner | Manager / accountant | Bookkeeper / reviewer / client viewer |
|---|---|---|---|---|
| `ledger:opening-balance` | request or post opening balances | yes | no | no |
| `ledger:control-adjustment` | request a control-account adjustment | yes | accountant only | no |
| `ledger:approve` | approve or reject requests (never your own) | yes | no | no |
| `ledger:policy` | change the approval policy (weakening a control) | yes | no | no |
Behaviour change by design: `OPENING_BALANCE` no longer needs `journal:post`; holders of only `journal:post` (manager, accountant) can no longer post opening balances.

### 4.2 Data (additive migration)
* `journal_request`: `kind` (OPENING_BALANCE | CONTROL_ADJUSTMENT), `status` (PENDING | APPROVED | REJECTED | CANCELLED), proposed journal (date, description, lines as validated JSON, total), `reason`, `evidence_document_ids`, requester, decider, decision reason, `expires_at`, `posted_journal_id`, `policy_snapshot` (what rule applied at request time), content hash. Proposed content is immutable; status moves once (PENDING -> a final state); a database check makes approver != requester for APPROVED requests; **pending requests are not ledger entries**: reports never read them.
* `ledger_policy` (per company): `opening_balance_approval` and `control_adjustment_approval` each `ALWAYS` (default) or `ABOVE_THRESHOLD`, `materiality_threshold` (decimal, functional currency). There is deliberately no `NEVER`: permission, reason, evidence and audit always apply. Changes are audited with before/after and a mandatory reason.
* `journal` gains `request_id`, `requested_by_user_id`, `approved_by_user_id` (nullable, set only by the PostingService), so a posted journal links to its request, its requester and its approver; evidence documents are linked to the journal in the evidence graph on posting.

### 4.3 Flow
Create request (own endpoint per kind, permission checked for the company) -> validated like a journal (balanced, accounts, period, currency) **but not posted** -> if the policy requires approval (always, or the total exceeds the threshold) it stays PENDING, otherwise it is posted at once with the requester recorded as both requester and decider and `self_approved = true` in the snapshot -> approver (`ledger:approve`, different person) approves -> the PostingService posts with `fromApprovedRequest` (it re-validates everything at posting time; a period that closed meanwhile refuses) -> the request is marked APPROVED with `posted_journal_id` in the same transaction. Reject/cancel/expiry leave the ledger untouched. The journal source types are `OPENING_BALANCE` and `CONTROL_ADJUSTMENT`; **neither can be posted without an approved or policy-exempt request**, and the M1 `POST /journals` no longer accepts `OPENING_BALANCE`.
Rules: reason at least 20 characters; control adjustments need at least one readable evidence document of the same company; opening balances need evidence when approval is required; the first-day-of-first-period rule for opening balances stays; AI actors can neither request nor approve; the requester is notified of the decision (in-app channel, no amounts in the notification).

### 4.4 API (flag `bookkeeping.core`)
`POST /opening-balance-requests`, `POST /control-adjustment-requests`, `GET /journal-requests[?status&kind]`, `GET /journal-requests/{id}`, `POST /journal-requests/{id}/approve|reject|cancel`, `GET|PUT /ledger-policy`.

### 4.5 Acceptance criteria (tests are the evidence)
Permission matrix over all roles for the four permissions; request validation (unbalanced, closed period, wrong company, missing evidence, short reason); approval by a different person only (service and database); self-approval refused; below-threshold direct posting only when configured; threshold boundary values (equal, one penny above); idempotent approval (concurrent approvals post once); concurrent approve vs reject vs cancel (one wins); expiry; period closed between request and approval; reversal of an approved adjustment works and links; ordinary MANUAL still refused on control accounts; AI actor refused; tenant and company isolation; trial balance ignores pending requests; audit before/after on every transition; policy changes audited with reason.
**Deferred:** per-account rules, delegation of approval, multi-step chains, approver notifications and a dashboard of pending requests (M9/M8), integration with the workflow engine.

### 4.6 As built (M2)
* **Migration** `20260107000000_v1_ledger_controls` (additive): tables `journal_request` and `ledger_policy` (forced RLS, `DELETE`/`TRUNCATE` revoked, delete/truncate triggers, request-content immutability and one-way status trigger, check constraints for outcome/separation/cancel/self-approval consistency); `journal` gains `request_id`, `requested_by_user_id`, `approved_by_user_id` (check `journal_request_link_ck` added `NOT VALID`: it applies to every new journal; pre-M2 development rows are not rescanned); `journal_insert_guard` now refuses an `OPENING_BALANCE` / `CONTROL_ADJUSTMENT` journal unless it matches a PENDING, unexpired request of the same kind, company, total, date and requester, approved by someone else (or by the requester when the request was policy-exempt); `evidence_link` type checks accept `journal`; four permissions added to the system roles; retention rows for the new tables (classification only).
* **Code:** `packages/accounting/src/requests.ts` (`JournalRequestService`, `LedgerPolicyService` - the only writers of the two tables, architecture-tested); `PostingService` gains `validateForRequest` and the `request` reference (sources flagged `requiresRequest`); the API exposes the endpoints in 4.4; the worker notifies the requester of the decision.
* **Behaviour changes versus M1 (by design, recorded):** `POST /journals` no longer accepts `OPENING_BALANCE` (422); `OPENING_BALANCE` needs `ledger:opening-balance` instead of `journal:post`; control accounts accept only `OPENING_BALANCE`, `CONTROL_ADJUSTMENT` and `REVERSAL`.
* **Proposed defaults, awaiting confirmation (section 7 item 1):** approval `ALWAYS`, 14-day expiry; `ABOVE_THRESHOLD` needs a threshold that the company configures - there is no built-in threshold, and no mode skips permission, reason, evidence or audit.
* **Not in M2 (deferred as specified):** per-account rules, delegation, multi-step chains, approver notifications and a pending-requests dashboard (M8/M9), workflow-engine integration. Foreign currency is still refused (`foreign_currency_not_supported`, M3).

## 5. M3 - foreign-currency foundation (specification; decisions recorded, DEC-016..018)
**Goal (DEC-009):** post foreign-currency transactions correctly and prove it reconciles, before VAT flows and reporting are finalised. **Decisions applied:** rate source and lookup (DEC-016), rounding (DEC-017), revaluation and realised FX (DEC-018). Design: ADR-55.

### 5.1 Concepts and rules
* **Functional currency** = the company's base currency; it becomes **immutable once a journal exists** (database trigger on `company.base_currency`). **Transaction currency** = ISO 4217 code from the `currency` table (known, active).
* **`exchange_rate`** (tenant-scoped reference data, immutable): `from_currency`, `to_currency` (the company's functional currency), `kind` (DAILY | PERIOD), `rate_date` or `effective_from`/`effective_to` (PERIOD rates such as a monthly series), `rate NUMERIC(19,8)` as published and never rounded, `source_kind` (MANUAL | IMPORT), `publisher`, `series`, `source_url`, `source_ref`, `retrieved_at`, `entered_by_user_id`, `import_batch_id`, `verification_status` (UNVERIFIED | VERIFIED, with verifier and date), `supersedes_id`. Corrections add a row that supersedes; nothing is updated or deleted. Manual entry needs a source text and a date and is audited.
* **Lookup (DEC-016):** the rate for the transaction date (DAILY on that date, or a PERIOD rate covering it); otherwise the latest earlier DAILY rate within **7 days**; otherwise the posting is refused with `exchange_rate_not_found` and a request for a manual rate; never a future rate. The company chooses its default series per currency (`company_fx_setting`); a rate id given explicitly must be a rate for that currency and date range.
* **Conversion and rounding (DEC-017):** original amount x rate, rounded **per line, half-up, to the functional currency's minor units**, by one function (`convert`) with property tests. If the converted debits and credits differ, one **FX rounding** line is added to the system account with role `FX_ROUNDING`; the permitted difference is one minor unit per line, else `rounding_tolerance_exceeded`. VAT rounding is M4.
* **Original-currency values on lines:** `journal_line` gains `original_currency`, `original_debit`, `original_credit`, `rate`, `exchange_rate_id` (all or none; the original amount sits on the same side as the functional amount; immutable like the rest of the ledger; a reversal copies them). Reports read functional amounts; original amounts feed revaluation and reconciliation.
* **System account roles:** `account.system_role` (FX_ROUNDING, FX_REALISED, FX_UNREALISED; unique per company, only used by system sources, never by MANUAL journals). The default chart template gains these accounts (new template version; existing charts are not rewritten - a company designates accounts explicitly).
* **Posting foreign-currency journals:** `POST /journals` accepts `currency` other than the base together with `rateId` (or a manual `rate` + `rateSource` text, which is stored as a MANUAL rate and audited); line amounts are in the transaction currency; the server converts and balances. Control accounts remain closed to MANUAL.
* **Realised FX (DEC-018):** `FxService.settle` computes the difference between the functional value carried for the settled original amount and its value at the settlement rate, to `FX_REALISED`; partial settlements prorate; the engine is delivered here and exercised by tests; receipts/payments (M5/M6) call it.
* **Revaluation (DEC-018):** for each (account, currency) of foreign-currency monetary accounts (bank and trade receivables/payables control kinds, plus accounts flagged monetary), compare the functional carrying amount with `original net x closing rate`; the difference goes to `FX_UNREALISED` as one journal (source `FX_REVALUATION`, permission `period:manage`), dated the period end; an **auto-reversal** journal is dated the first day of the next period (posted at once if that period exists and is open, otherwise by a sweeper when it opens). `fx_revaluation_run` (company, period, status PREVIEWED | POSTED | REVERSED, journal ids) makes it idempotent per period; a re-run posts a reversal and a new journal. Locked periods refuse. Closing a period with an unrevalued foreign-currency monetary balance needs an explicit acknowledgement in the close request.
* **Importers (DEC-016):** an `ExchangeRateSource` port (fake for tests) and a CSV importer with a documented column layout; imported rows are stored as IMPORT/UNVERIFIED with publisher, series, URL and batch. **Live HTTP adapters for the HMRC monthly and Bank of England series are not part of M3**: they need network access, each publisher's terms of use and a reviewer's check of the file formats. No real rate figures are committed; tests use synthetic rates.
* **Policy:** `ledger_policy.fx_block_unverified_rates` (default false) blocks postings that would use an UNVERIFIED rate.
* **Permissions:** `fx:rate-manage` (new, COMPANY scope: owner/admin/partner/accountant) to enter or supersede rates and import files; reading rates needs `ledger:read`; revaluation needs `period:manage`.

### 5.2 API (flag `bookkeeping.core`)
`GET|POST exchange-rates`, `POST exchange-rates/{id}/supersede`, `POST exchange-rates/import` (CSV), `POST exchange-rates/{id}/verify` (records verifier and date), `GET|PUT fx-settings`, `POST periods/{id}/revaluation/preview`, `POST periods/{id}/revaluation`, `GET revaluation-runs`, and `POST journals` with `currency`/`rateId`. OpenAPI for all; the single-currency limitation text is replaced by the new behaviour in the same commit.

### 5.3 Acceptance criteria (tests are the evidence)
Property tests for conversion and rounding (reverse conversion within tolerance; totals independent of line order; half-up at the boundary); journals balance in functional currency with an explicit rounding line within and refused beyond tolerance; rate-lookup boundaries (exact date, earlier within 7 days, 8th day refused, weekend gap, PERIOD rate covering, future rate never used); manual rate audited and immutable, correction supersedes; unverified rates flagged and blockable by policy; original-currency values stored, immutable (database), copied by reversal, all-or-none; base-currency change refused after the first journal; realised FX on full, partial and multiple settlements at different rates; revaluation previews without posting, posts once, reverses on the first day of the next period (immediately or via the sweeper), is idempotent, refuses a locked period, ignores non-monetary accounts; the original-currency balance revalued at the closing rate equals the functional carrying amount after revaluation; FX gain/loss and trial balance drill to journals; permission matrix for `fx:rate-manage`/`period:manage`; tenant and company isolation; AI actors refused; architecture rules (only `FxService` writes rates, runs and revaluation journals; only the PostingService writes journals).
**Deferred:** live rate adapters (gate above), hedge accounting, forward contracts, net investments and translation of foreign operations, intercompany eliminations, multi-currency statements beyond the account currency, VAT-specific rate rules (M4, after the sources are verified).

### 5.4 As built (M3)
* **Migration** `20260108000000_v1_fx_foundation` (additive): `exchange_rate` (immutable; only verification and supersession ever update a row - trigger; a partial unique index allows one current rate per pair/kind/publisher/series/dates; deferred self-reference for supersession), `company_fx_setting`, `fx_revaluation_run` (one move, POSTED -> REVERSED), `journal_line` original-currency columns (`original_currency/debit/credit`, `rate`, `exchange_rate_id`, all-or-none) and `adjusts_currency`, `ledger_policy.fx_block_unverified_rates`, a trigger that freezes `company.base_currency` once a journal exists, permission `fx:rate-manage`, retention rows (classification only). The line guard proves in the database that the functional amount is exactly `round(original x rate)` in the functional currency's minor units (PostgreSQL `round`, half away from zero), that the rate is the stored rate for that pair and not dated after the journal, and that original amounts respect their own currency's minor units.
* **Code:** `fx.ts` (`convert`, `roundingTolerance`, `settle`, `RateService`, CSV parser/importer, `FxSettingsService`), `revaluation.ts` (`RevaluationService`), `PostingService.toFunctional` (foreign journals), `PeriodService` close controls. Rates, settings and runs have one writer each (architecture-tested); no FX code inserts a journal.
* **Differences from the specification above (recorded):**
  1. The three FX accounts are designated in `company_fx_setting` (rounding, realised, unrealised: active income/expense, non-control, three different accounts) instead of an `account.system_role` column; MANUAL journals are refused on them (`system_account_restricted`); only the visible rounding line the service adds may use the rounding account. The default chart template was not changed; a company creates and designates its accounts (no account numbers are assumed).
  2. **No worker sweeper for auto-reversals.** The architecture rules forbid the worker and AI code from importing the accounting package (nothing but the PostingService path may post). The reversal is therefore posted at once when the day after the period end is in an OPEN period; otherwise the run stays `POSTED` ("due"), `POST revaluation-runs/{id}/reverse` posts it once such a period exists, and **closing the period that contains the due date is refused (`fx_reversal_pending`), even with the acknowledgement**, so a reversal is never skipped.
  3. Re-running a revaluation is idempotent by arithmetic, not by a stored key: it compares the functional carrying amount (which includes earlier revaluation adjustments, `adjusts_currency` lines, and excludes the next-period reversals) with `original x closing rate`; no difference means `NOTHING_TO_DO`; new activity gets its own delta journal. Concurrent runs serialise on a `FOR UPDATE` of the period row (tested: three at once post one journal).
  4. A rate is verified by a person other than the one who entered it (not in the original text; recorded here, tested).
  5. Rates are organisation-level reference data (company default series are per company). Revaluation and journals use the company's functional currency as the `to` currency.
  6. Opening balances and control adjustments are still requested and posted in the company currency only (`foreign_currency_not_supported`, message updated).
  7. `settle` (realised FX) is delivered as a tested pure function; it has no endpoint and no posting path until receipts and payments exist (M5/M6), so realised FX is **not yet exercised end to end** (V1-FX-07 stays partial).
  8. The "FX report" of the acceptance criteria is met by the existing general ledger of the FX accounts (drill-down to the revaluation journal and its reversal) and the functional-currency trial balance; a dedicated FX gain/loss report belongs with financial reporting (M8) (V1-FX-09 stays partial).
* **Known limitations:** no live rate adapters (network, publisher terms, format verification - a gate); the legal basis for converting amounts for VAT is **unverified** (`docs/legal/m3-fx-sources.xlsx`) and is an M4 matter; the sandbox could not read the primary sources; no hedge accounting, forwards, net investments or translation of foreign operations; the monetary-account list is by subtype (`MONETARY_SUBTYPES`) and has not been reviewed by an accountant; revaluation lines are posted per account and currency without a per-document breakdown (documents arrive in M5/M6).

## 6. M4 - contact roles and VAT foundation (specification; external gate)
### 6.1 Contacts with roles (DEC-011)
`contact` stays the shared party record. `contact_role` rows (CUSTOMER, SUPPLIER; a contact may hold both) with role-specific profile tables for differing fields (customer: payment terms, credit limit, default currency and tax treatment; supplier: payment terms, default expense account, bank details **encrypted at field level**, never in lists, logs or audit snapshots). Tenant and company scope as for contacts today. Documents (M5+) keep a **snapshot** of the contact details used (name, address, VAT number) so edits never rewrite history. Removing a role is refused while open documents exist. Acceptance: API, permission, isolation and audit tests; both-role contact; snapshot behaviour proved with an edit after posting.

### 6.2 VAT foundation, standard accounting first (DEC-010)
* **Model:** effective-dated `tax_code` (treatment: STANDARD, REDUCED, ZERO, EXEMPT, OUTSIDE_SCOPE; direction: SALES, PURCHASES, or both; reverse-charge capability) and effective-dated `tax_rate` (no overlap per code). Each rate and each rule records its **official source (URL and reference), retrieval date, effective dates and verification status**. An UNVERIFIED rate cannot be activated or used on a posting; verification names the person and the date. **Nothing is entered from memory**; the figures are not part of this plan until a qualified reviewer has checked them against HMRC and legislation.gov.uk.
* **Separation:** the **VAT accounting scheme** is its own concept (`vat_scheme`: STANDARD active; CASH and FLAT_RATE registered as not implemented and not selectable) so that treatment and rate never encode the scheme.
* **Calculations:** VAT-inclusive and exclusive entry; exact decimal arithmetic; the rounding rule (per line or per document) documented, implemented once and property-tested.
* **Tax point:** basic and actual tax point handling per the verified rules; the rate and the return period are those of the tax point.
* **Flows:** sales output VAT, purchase input VAT, credit notes and debit notes linked to the original supply; **reverse-charge** cases accommodated by letting one line account for output and input VAT together (the applicable cases listed and verified before use).
* **Control and workpaper:** the VAT control account must equal the sum of VAT lines by period (breaks listed); a VAT-return workpaper produces the nine-box figures with drill-down to transactions. It is a workpaper, **not a submission** (HMRC filing is V5).
* **Posting:** the VAT validator joins the PostingService chain (V1-POST-05); foreign-currency VAT follows M3 and the verified rule for the VAT amount currency.
* **Candidate official sources to verify (not yet verified):** Value Added Tax Act 1994 (time of supply s.6, rates and schedules, reverse charge s.55A), VAT Regulations 1995 (SI 1995/2518), HMRC VAT Notice 700 "The VAT guide", VAT Notice 735 (domestic reverse charge, building and construction), HMRC VAT rates page. Links go into the rule records when a reviewer verifies them.
* **Acceptance:** boundary tests on effective dates (day before, day of, day after a rate change); tax-point cases; inclusive/exclusive round trips; credit-note linkage; reconciliation of control account to lines; workpaper figures against hand-calculated fixtures; an UNVERIFIED rule cannot be activated; scheme registry refuses CASH and FLAT_RATE.
**Deferred:** cash accounting, Flat Rate Scheme, partial exemption, capital goods scheme, margin schemes, OSS/import schemes, MTD submission (V5).

### 6.3 As built (M4a)
* **Migration** `20260109000000_v1_contact_roles` (additive): `contact.vat_number` (format check, `NOT VALID` so existing rows are not rescanned); `contact_role` (company-scoped; unique per company+contact+role; account code unique per company+role ignoring case; ended with a reason, never deleted; identity frozen by trigger; a company-linked contact cannot take a role in another company); `customer_profile` and `supplier_profile` tied to a role of the right kind by a composite foreign key and to the role's company by trigger; supplier bank-detail rules in the database (a change is UNVERIFIED; VERIFIED needs a different verifier; no change-and-verify in one step; no plain digits); forced RLS; `DELETE`/`TRUNCATE` revoked; permission `contact:bank-details` (owner, admin, partner, accountant); retention rows (classification only).
* **Code:** `ContactRolesService` (the only writer of the three tables and the only code that touches the ciphertext - architecture-tested) and `ContactRolesController` under `/companies/{companyId}/contact-roles` (flag `bookkeeping.core`).
* **Defects found by the new tests and fixed before release:** (1) the "ending needs a reason" check accepted a NULL reason (a CHECK treats NULL as satisfied) - now explicit; (2) the EU branch of the VAT-number pattern also matched short GB numbers - it now excludes GB/XI and requires 8-12 characters (DEC-024 text corrected before it was committed); (3) a duplicate account code was reported as a duplicate role - the service now checks explicitly, the unique index stays the backstop.
* **Not yet possible (needs documents, M5/M6):** refusing to end a role with open documents; storing the snapshot on documents and proving it survives a later edit (the function is delivered and tested). Payments refusing UNVERIFIED bank details is an M6 rule; the status exists now.

### 6.4 As built (M4b)
* **Migration** `20260110000000_v1_vat_foundation`: `tax_code`, `tax_rate`, `company_vat_setting`; journal-line VAT facts (`tax_code_id`, `tax_rate_id`, `vat_role` NET/VAT/RC_OUTPUT/RC_INPUT, `tax_point`, `vat_net_line_no`, `vat_inclusive`; all-or-none; never on a foreign-currency line); `journal_vat_check` at commit; permissions `vat:manage` (owner, admin, partner, accountant) and `tax:rule-verify` (owner, admin); retention rows (classification only). **No VAT rate, code or box mapping is seeded.**
* **Code:** `VatService` (codes, versions, verification, settings, return periods, workpaper; the only writer of the VAT tables), `PostingService.withVat` (VAT lines), `VatController`.
* **Defects found while writing the tests and fixed before any run:** foreign-currency conversion rebuilt journal lines and would have dropped their VAT codes silently - VAT on foreign journals is now refused before any conversion or rate is stored; the supersede request intersected a strict schema and rejected its own `reason` - it is now its own schema.
* **Not yet:** credit/debit notes linked to the original supply (M5/M6 documents); foreign-currency VAT (V1-VAT-15); tax point by supply/invoice/payment date (documents carry those dates; journals take an explicit tax point now); cash accounting and Flat Rate Scheme (deferred, refused); presentation rounding of boxes 6-9 (not applied - unverified); submission (V5).

## 7. Decisions still needed before specific milestones
| # | Decision | Needed before | Owner | Status |
|---|---|---|---|---|
| 1 | M2 defaults: default approval mode (ALWAYS is the proposed default), default expiry of a pending request (14 days proposed), default materiality threshold | M2 start (proposed values are used if you do not object) | Product owner | **confirmed (DEC-015)**: approval `ALWAYS`, 14 days, no built-in threshold |
| 2 | **Exchange-rate source** (manual entry only, an official published series such as HMRC monthly rates or the Bank of England, a commercial provider) and the lookup window | M3 | Product owner | **decided (DEC-016)**: manual always + official importers (HMRC monthly, Bank of England daily), 7-day window; live adapters gated |
| 3 | Rounding policy (precision, mode, line vs document) and revaluation policy (which items, which rate, auto-reverse) | M3 | Product owner | **decided (DEC-017, DEC-018)**: per-line half-up with visible rounding line; monetary items, explicit revaluation, auto-reverse |
| 4 | Who verifies the VAT rules and sources (a named qualified tax reviewer), and the verification record format | M4 | Product owner | **open - blocks M4 activation** |
| 5 | Bank statement formats beyond CSV | M7 | Product owner | later |
| 6 | Whether a firm may relax the control-account rule further | later | Product owner | closed by DEC-012 (permission + approval) |
Decided: foreign currency in V1 (DEC-009); standard VAT first (DEC-010); contact roles (DEC-011); opening balances/control accounts (DEC-012).

## 8. Known limitations (current)
No UI (M9; M2 is API-only, approvers have no screen or dashboard yet); single currency only until M3 (explicit: `foreign_currency_not_supported`); no VAT until M4; no source documents until M5; trial balance and general ledger computed on demand and posting serialised per company (untested at real volume, a production gate); the posting switch is application-asserted (same trust boundary as the tenant context); the M1 interim opening-balance fence is replaced by the M2 request/approval controls (the first-day rule stays); development uses synthetic data and retention is provisional (DEC-003, DEC-014); nothing is production-approved (DEC-006).

## 9. M5 - Sales (specification; DEC-026..031, ADR-59)
Recorded before code under the delegation of 2026-10-12. Statements about VAT law are UNVERIFIED (DEC-022).

### 9.1 M5a - sales documents
* **Data (additive migration):**
  * `sales_setting` per company: receivables control account (a control account of kind TRADE_RECEIVABLES), invoice and credit-note prefixes and start numbers (changeable until the first document of the kind is approved), `require_separate_approver`.
  * `sales_sequence` (company, kind, last number).
  * `sales_document` (kind INVOICE or CREDIT_NOTE; status DRAFT, APPROVED, DISCARDED; number and display number once approved; customer role and contact; issue date, optional supply date and tax point, due date; currency; amounts-include-VAT; customer reference; notes; net, VAT and gross totals; outstanding and functional outstanding; rate used; journal; contact snapshot; duplicate and credit-limit override reasons; origin MANUAL or AI_PROPOSAL with the proposal; preparer, approver, timestamps; version).
  * `sales_document_line` (line number, description, quantity, unit price, account, VAT code, net, VAT, gross).
  * `sales_allocation` (invoice, credit document, amount, carried functional released on each side, FX difference and its journal, date, actor).
  * `journal_line.vat_rate_point` (credit-note VAT lines; DEC-029).
  * Forced RLS; no `DELETE`/`TRUNCATE`; permissions `sales:read`, `sales:manage`, `sales:approve`; retention rows (classification only); evidence-link entity type `sales_document`.
* **Database rules:**
  * approved documents and their lines are immutable except outstanding amounts;
  * numbers are the next of the sequence;
  * the outstanding amount moves only through allocations and never below zero;
  * an allocation joins documents of the same company, customer and currency, an approved invoice and an approved credit;
  * a credit note's original is an approved invoice of the same customer and currency;
  * the VAT check accepts a superseded or earlier rate version only on a credit-note line that names the rate point it adjusts.
* **PostingService:**
  * new sources `SALES_INVOICE`, `SALES_CREDIT_NOTE` and `SALES_ALLOCATION_FX` (person actors, `sales:approve`);
  * `controlKinds` on a source limits which control accounts its typed lines may touch (TRADE_RECEIVABLES for these);
  * a trusted `vatRate` pin on a line (rate version and rate point) for credit notes.
* **Journals:**
  * An invoice posts Dr trade receivables (gross) and Cr each line's account (net, VAT code), and the service adds the output VAT lines (V1-EX-01).
  * A credit note posts the mirror, then allocates itself to its invoice. When the two rates differ, a realised-FX journal follows (DEC-030).
* **Flows and checks:**
  * duplicate and credit-limit checks with a stored, audited override reason (DEC-027);
  * separate approver when the company policy says so;
  * foreign currency refused at approval for VAT-registered companies until M5c (DEC-031);
  * a customer role cannot be ended while it has drafts or approved documents with an outstanding amount;
  * closing a period is refused while drafts dated in it exist, unless acknowledged (`acknowledgeDraftDocuments`, MAN-ACC-08).
* **Events:** `invoice.created` (InvoiceCreated, XP-07) on approval of an invoice and `credit_note.created` on approval of a credit note, each through the outbox, plus `transaction.posted`.
* **Read models:**
  * document list (filters: kind, status, payment status, customer, dates) and document detail with its lines, journal, allocations and attachments;
  * receivables reconciliation by currency: open items vs the control account, with the control balance broken down by journal source so opening balances, adjustments and revaluation are visible.
* **API** (flag `bookkeeping.core`; under `/organisations/{org}/companies/{company}`):
  * `sales-settings` (GET, PUT);
  * `sales/invoices` and `sales/credit-notes` (POST draft, GET list);
  * `sales/documents/{id}`: GET, PATCH draft, `approve`, `discard`, `attachments` (GET, POST);
  * `sales/reconciliation`.
* **Acceptance (tests are the evidence):**
  * Postings: positive, negative, VAT (standard, zero, exempt; exclusive and inclusive), period-lock, effective-date and reversal-free correction cases, with hand-calculated figures.
  * Numbering: gapless numbering under concurrency.
  * Database checks proven against direct SQL: immutability, the outstanding amount floor, the credit note limit, and the credit-note rate pin.
  * Approval controls: the duplicate and credit-limit overrides, the separate approver, the AI-origin draft (approval only by a person) and the snapshot surviving a later contact edit.
  * Lifecycle controls: the role-end refusal, the close control, and the reconciliation figures.
  * Access: permissions per role and tenant isolation.

### 9.2 M5b - receipts and allocations
* **Receipts** (`sales_receipt`) to a bank or cash account of the company (subtype CURRENT_ASSET_BANK or CURRENT_ASSET_CASH, not a control account), in any currency with a rate. A receipt posts Dr bank / Cr trade receivables (`SALES_RECEIPT`, V1-EX-03).
* **Allocation:** allocated at creation to one or more invoices, or later from its unallocated balance. Part payments are allowed; an overpayment stays unallocated credit on the customer.
* **Realised FX:** each allocation follows DEC-030, so realised FX is exercised end to end (V1-FX-07).
* **Reports:** customer statement (open items and movements for a date range) and aged receivables (buckets by days past due as at a date) from documents and allocations, reconciled to the control account by the 9.1 reconciliation.
* **Acceptance:**
  * receipts in functional and foreign currency;
  * allocation across several invoices, part payment, overpayment then later allocation;
  * realised FX gains and losses hand-calculated with different rates, with a full settlement leaving no residue;
  * period lock, permission and isolation tests.

### 9.4 As built (M5a)
* **Migration** `20260111000000_v1_sales_documents`, additive. It adds the five sales tables with forced RLS and no `DELETE`/`TRUNCATE`; lines and allocations also have no `UPDATE`.
* **Draft lines** are append-only revisions. Editing a draft writes a new revision, so nothing is updated or deleted and the history of a draft is kept.
* **Database guards:**
  * `sales_document_guard` covers the lifecycle and identity, the next number, the posted journal of the right source and date, and the separate-approver policy. It also enforces the DEC-031 refusal and freezes approved documents except through an allocation.
  * `sales_allocation_apply` keeps an allocation to one company, customer and currency, and to a credit note's own invoice. It moves both outstanding amounts and refuses anything below zero.
  * `journal_subledger_reversal_guard` stops sales journals being reversed in the ledger.
  * `journal_vat_check` is updated for `vat_rate_point`, which only credit notes and reversals may carry.
* **Settings and permissions:** sales settings freeze the numbering once a document of the kind is numbered, and the receivables account once any document is approved. Permissions are `sales:read`, `sales:manage` and `sales:approve`.
* **Code:**
  * `SalesService` (`packages/accounting/src/sales.ts`) is the only writer of the sales tables and never writes a journal (architecture-tested).
  * `PostingService` gains `controlKinds` per source, the `subLedger` reversal refusal and the trusted `vatRate` pin.
  * `ContactRolesService` refuses to end a role that has open documents and stores snapshots through the shared `buildContactSnapshot`.
  * `PeriodService` adds the draft close control.
  * `EvidenceService` resolves `sales_document`.
  * The API adds `SalesController`, with 14 routes, all in OpenAPI.
* **Hand-calculated evidence:**
  * Invoice: 2 x 40.00 at 12.5 % plus 33.33 zero-rated plus 7.00 exempt = net 120.33, VAT 10.00, gross 130.33.
  * EUR invoice of 1000 at 0.85, part-credited 400 at 0.90: the invoice releases 340.00 and the credit carries 360.00, so the realised gain is 20.00.
  * EUR full credit: 333.33 at 0.85 = 283.33 against 300.00, a gain of 16.67 with no residue.
  * Credit note across a rate change: VAT at the invoice's 12.5 %, not the 15 % in force at the credit note's date; the workpaper's box 1 for the credit note's quarter shows -12.50.
* **Defects found while testing and fixed before commit:**
  * plpgsql read a `CASE ... THEN` inside an `IF` condition as the end of the condition. Fixed by wrapping the expression in parentheses.
  * The approval guard compared the text `journal.source_id` with a uuid. Fixed with an explicit cast.

### 9.3 Deferred (DEC-026)
Recurring invoices, quotes, line discounts, invoice rendering and sending (M9 and notifications), online payment, direct debit, refunds, bad-debt relief, deposits before an invoice, write-offs, statutory tax-point derivation (DEC-028), unallocating, VAT on foreign-currency documents until M5c.
