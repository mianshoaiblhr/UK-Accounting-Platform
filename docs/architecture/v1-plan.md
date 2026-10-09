# V1 Core Bookkeeping - plan and design

Status: V1 started 2026-10-09 after DEC-001. **Plan version 2 (2026-10-09, DEC-008..014): M1 accepted; milestones re-sequenced; M2-M4 specified.** Authority: `docs/specifications/V1_Core_Bookkeeping.md`, the master manifest (non-negotiable accounting controls), `decision-log.md`. Requirement matrix: `v1-compliance-matrix.md|json|xlsx` (113 rows in plan version 2; each row has an owner, dependencies, acceptance criteria and deferred scope). Nothing here is production-approved (DEC-006). Development data is synthetic (DEC-003).

## 1. Principles carried from V0 (not re-decided)
Tenant isolation by forced row-level security; one central authoriser for company-level permissions; append-only records protected by privileges first and triggers second; additive migrations written for a non-superuser owner (ADR-27); audit events in the business transaction; outbox events; feature flags for unfinished functionality; OpenAPI is the contract and every route is documented; failures and retries visible; no raw SQL built from strings.

## 2. Milestones (plan version 2; each ends with an acceptance package, DEC-007)
| Milestone | Scope | Status | Owner | Depends on |
|---|---|---|---|---|
| M1 | Ledger core | **ACCEPTED** (code baseline `fae5270`, DEC-008) | Engineering | - |
| M2 | Ledger controls: opening-balance permission, control-account adjustments, second-person approval (DEC-012) | specified (section 4) | Engineering; product owner sets thresholds | M1 |
| M3 | Foreign-currency foundation (DEC-009) | specified (section 5); **open decisions block the start** | Engineering; product owner decides rate source and policies | M1 |
| M4 | Contact roles (customers/suppliers) and VAT foundation, standard accounting (DEC-010, DEC-011) | specified (section 6); **external gate: tax rules verified from official sources** | Engineering; qualified tax reviewer | M1, M3 |
| M5 | Sales: invoices, credit notes, receipts, duplicate check | planned | Engineering | M2, M3, M4 |
| M6 | Purchases: bills, debit notes, payments, cash | planned | Engineering | M3, M4, M5 patterns |
| M7 | Bank accounts, statement import, transfers, charges, interest, reconciliation | planned | Engineering | M5, M6 |
| M8 | P&L, balance sheet, drill-down, controls and alerts, FX reporting | planned | Engineering | M3, M5-M7 |
| M9 | V1 UI slices behind feature flags (DEC-002) | planned, parallel from M2 | Engineering (front end) | the API each screen uses |
| Privacy track | Session / challenge IP and user agent (DEC-013) | investigation in progress, **never marked resolved without review** | Engineering; DPO / legal | DEC-003 |

**What changed from version 1 and why** (append-only history is also in the matrix): foreign currency is in V1 and VAT flows must be finalised after it (DEC-009), so M3 (currency) precedes M4 (VAT) and every document milestone; the opening-balance/control-account decision (DEC-012) is a ledger control and becomes M2 before any source document can need it; the old M2-M6 shifted to M5-M9. Order is by dependency: nothing posts before the PostingService, nothing documents before currency and VAT, nothing reconciles before bank data and documents, nothing reports before the ledger.

**A milestone starts only when its specification and dependencies are clear** (second batch of 2026-10-09). Today: M2 is specified and unblocked; M3 and M4 are specified but blocked by decisions/verification listed in section 7.

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

## 5. M3 - foreign-currency foundation (specification; open decisions block the start)
**Goal (DEC-009):** post foreign-currency transactions correctly and prove it reconciles, before VAT flows and reporting are finalised.

### 5.1 Concepts and rules to implement
* **Functional currency** = the company's base currency (immutable once postings exist). **Transaction currency** = ISO 4217 code of a document or line. **Original-currency values** (amount, currency, rate, rate id) are kept on every foreign line and are immutable.
* **Functional-currency postings:** every journal balances in the functional currency; a conversion that does not round cleanly produces an explicit line to a system rounding account within a tolerance.
* **Exchange rates:** a `exchange_rate` table (from, to, rate date, rate, source, retrieved-at, verification status). Lookup rule: the rate for the transaction date; otherwise the latest earlier rate within a configured number of days; otherwise the posting is refused. Manual rates are audited; a rate source is an adapter port with a fake for tests. **No live source is enabled without a recorded decision.**
* **Rounding:** rate precision, rounding mode and level (line vs document) are written down once, implemented in one function and covered by property tests.
* **Realised FX:** settling a foreign invoice or bill at a different rate posts the difference to realised gain/loss accounts exactly once (engine in M3, used by receipts and payments in M5/M6).
* **Period-end revaluation:** unrealised gain/loss on foreign-currency monetary items (receivables, payables, bank) at the closing rate, posted as an auto-reversing journal, idempotent per period, refused in locked periods.
* **Until delivered:** the single-currency limitation is explicit. A journal request naming a currency other than the company's is refused with code `foreign_currency_not_supported` (delivered with this plan update, V1-FX-10), and the OpenAPI description and the plan say so.

### 5.2 Acceptance criteria
Property tests for conversion and rounding (reverse conversion within tolerance; totals independent of line order); journals balance in functional currency and per currency; realised FX on full, partial and multiple settlements; revaluation posts, reverses and is idempotent; locked periods refuse; the sub-ledger in original currency revalued at the closing rate equals the control account; trial balance and FX report drill to journals; rate-lookup rule boundaries (exact date, earlier within window, outside window); unverified rates flagged and blockable by policy.
**Deferred:** hedge accounting, forward contracts, intercompany eliminations, multi-currency statements beyond the account currency.

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

## 7. Decisions still needed before specific milestones
| # | Decision | Needed before | Owner | Status |
|---|---|---|---|---|
| 1 | M2 defaults: default approval mode (ALWAYS is the proposed default), default expiry of a pending request (14 days proposed), default materiality threshold | M2 start (proposed values are used if you do not object) | Product owner | proposed |
| 2 | **Exchange-rate source** (manual entry only, an official published series such as HMRC monthly rates or the Bank of England, a commercial provider) and the lookup window | M3 | Product owner | **open - blocks M3** |
| 3 | Rounding policy (precision, mode, line vs document) and revaluation policy (which items, which rate, auto-reverse) | M3 | Product owner with accountant input | **open - blocks M3** |
| 4 | Who verifies the VAT rules and sources (a named qualified tax reviewer), and the verification record format | M4 | Product owner | **open - blocks M4 activation** |
| 5 | Bank statement formats beyond CSV | M7 | Product owner | later |
| 6 | Whether a firm may relax the control-account rule further | later | Product owner | closed by DEC-012 (permission + approval) |
Decided: foreign currency in V1 (DEC-009); standard VAT first (DEC-010); contact roles (DEC-011); opening balances/control accounts (DEC-012).

## 8. Known limitations (current)
No UI (M9); single currency only until M3 (explicit: `foreign_currency_not_supported`); no VAT until M4; no source documents until M5; trial balance and general ledger computed on demand and posting serialised per company (untested at real volume, a production gate); the posting switch is application-asserted (same trust boundary as the tenant context); the M1 opening-balance fence stays until M2 replaces it; development uses synthetic data and retention is provisional (DEC-003, DEC-014); nothing is production-approved (DEC-006).
