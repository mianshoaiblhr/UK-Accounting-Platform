# Decision log (append-only)

Decisions taken by the product owner about scope, risk and approvals. **Entries are never edited or deleted**; a later decision that changes an earlier one is a new entry that names it. The V0 readiness report and compliance matrix are frozen evidence at documentation commit `fe2e63f` (verified code commit `3b754e7`; a git tag could not be pushed through the session's git proxy, so the commit SHAs are the reference); decisions made after that point are recorded here and in the register addendum, not by rewriting history. Architecture consequences are in `adr.md` (ADR-40 onwards).

| Id | Date | Subject | Decision |
|---|---|---|---|
| DEC-001 | 2026-10-09 | V0 readiness | APPROVED to start V1 |
| DEC-002 | 2026-10-09 | UI strategy (S5) | APPROVED: API-first V1, V0 UI in parallel behind feature flags |
| DEC-003 | 2026-10-09 | Retention and privacy (S4(b), V0-8.3) | DEFERRED FOR APPROVAL: everything stays provisional |
| DEC-004 | 2026-10-09 | Naming deviations V0-1.5, V0-T2 | ACCEPTED as documented |
| DEC-005 | 2026-10-09 | S3 device identity, S7 embedding/search ports | DEFERRED to later tranches |
| DEC-006 | 2026-10-09 | Production | NOT approved; AWS and production hardening remain explicit gates |
| DEC-007 | 2026-10-09 | V1 conduct and milestone acceptance | Rules below |

## DEC-001 - V0 approved to start V1
V0 is approved for V1 development on the basis of the readiness report (commit evidence above). The pre-V1 bundle S1, S2, S4(a) and S6 is accepted as complete, subject to the reported passing checks and the evidence retained in the repository.
**This is not production approval.** V0 must not be described as production-approved, and no production deployment or live-customer processing may start on the strength of this decision alone (see DEC-006).

## DEC-002 - UI strategy (S5, MAN-DOD-05, XP-11): APPROVED
Proceed API-first for V1 while developing the V0 UI screens in parallel behind feature flags.
* Prioritise usable end-to-end bookkeeping workflows.
* Unfinished features stay disabled behind feature flags (registry in `packages/contracts/src/features.ts`; a flag exists only if declared there).
* UI is tested against the real API, the real authorisation rules and the real tenant boundaries (no mocked authorisation).
* Rows MAN-DOD-05 and XP-11 stay open (PARTIALLY IMPLEMENTED / MISSING) until the screens exist and pass accessibility checks; this decision schedules the work, it does not close the rows.

## DEC-003 - Retention and privacy: DEFERRED FOR APPROVAL
* **All retention periods stay PROVISIONAL.** No category may be set to CONFIRMED without a recorded decision from the product owner informed by the legal verification schedule.
* **S4(b) is frozen:** do not implement or enable purge jobs, irreversible erasure rules or production retention enforcement until the retention schedule and the lawful-basis decisions have been reviewed and approved.
* **A legal verification schedule has been prepared** (`docs/legal/retention-verification-schedule.md` and `.xlsx`): exact provisions, official sources, record/entity types, clock-start events, exceptions, review dates. It is **UNVERIFIED** - sources were not opened from the build environment - and no lawful basis or period in it is approved.
* **IP address and user agent in the audit trail are flagged for privacy review** (schedule section 2), together with the other places the platform stores them (sessions, MFA challenges, hashed trusted IPs, access logs, rate-limit keys). A finding recorded in the schedule: the `AUDIT_CAPTURE_DEVICE_METADATA` switch governs `audit_event` and the access log; it does **not** govern `session.ip`/`session.user_agent` or `auth_challenge.ip`, which are stored regardless. That is a question for the reviewer, not something decided here.
* **Development uses synthetic/test data only** until the applicable decisions are made. No real client or customer data in any environment.
* Do not mark provisional legal requirements as implemented because a schema or configuration exists: V0-S8, XP-10 and V0-8.3 stay PARTIALLY IMPLEMENTED.

## DEC-004 - Naming deviations V0-1.5 and V0-T2: ACCEPTED
Accepted as documented: the permission catalogue lives in code (V0-1.5); `contacts` exists, `permissions` is the code catalogue, **`job_record` is the integration job table (ADR-36)** and `ai_run` is the AI request log (V0-T2).
Conditions: implementation, tests, OpenAPI and architecture documents stay consistent with this; retry behaviour, idempotency, status/error tracking, tenant/company scoping and correlation/trace ids are preserved. The circumstances that would justify separating these models later are written down in ADR-42.

## DEC-005 - S3 and S7: DEFERRED
S3 (device identity, new-device alert, admin session kill-switch) and S7 (EmbeddingProvider/SearchProvider ports) move to later tranches. Baseline authentication, session revocation, authorisation, tenant isolation and the other agreed controls are unchanged and must not be weakened by the deferral. Each proposal is revisited when its implementation dependency and acceptance criteria are defined (S3 depends on the channel port delivered by S2; S7 on V6/V10 requirements).

## DEC-006 - Production gates
AWS deployment and production hardening remain explicit gates. Terraform `validate` passing in CI does **not** mean the infrastructure has been applied or verified in AWS. No production deployment until the applicable infrastructure, security, privacy and retention gates have each been separately reviewed and approved.

## DEC-007 - V1 conduct
* Start V1 following `README_IMPLEMENTATION_ORDER.md` and the master manifest; do not expand scope into deferred items without recording a decision here.
* **Before a V1 milestone is accepted** the acceptance package contains: commit SHA, CI run (every job), test results, migrations, security and permission checks, compliance-matrix changes, known limitations.
* The V0 readiness report and compliance matrix stay as versioned evidence (commit `fe2e63f`); V1 gets its own matrix (`docs/architecture/v1-compliance-matrix.md`) and V0 documents are not overwritten without an audit trail (this log).

---

## Decisions of 2026-10-09 (second batch, after the V1 M1 acceptance package)

| Id | Subject | Decision |
|---|---|---|
| DEC-008 | M1 acceptance | ACCEPTED |
| DEC-009 | Foreign currency | IN V1 (foundation milestone before VAT flows and reporting) |
| DEC-010 | VAT scope | Standard VAT accounting first; cash accounting and Flat Rate Scheme deferred behind an extensible model |
| DEC-011 | Contact model | Shared `contact` with roles |
| DEC-012 | Opening balances and control accounts | Dedicated permission and controlled (configurable second-person) approval |
| DEC-013 | Privacy finding (session / challenge IP and user agent) | Tracked separately; not resolved |
| DEC-014 | Production boundary | Unchanged; V1 continues on synthetic data |

### DEC-008 - M1 accepted
Commit `fae5270` is accepted as the **M1 code baseline** (ledger core). Later documentation-only commits are recorded separately (`defe69b` is the acceptance package and regenerated matrix). The CI run (<https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37923766068>, 9 of 9 jobs), CodeQL, the clean-clone result (64 files, 1170 tests, 4 end-to-end), the migration (`20260106000000_v1_ledger_core`) and the OpenAPI evidence are retained in `docs/architecture/v1-m1-acceptance.md`. **This is milestone acceptance, not production approval** (DEC-006).

### DEC-009 - Foreign currency is in V1
Plan the foreign-currency foundation in the next suitable ledger milestone, **before** the VAT transaction flows are finalised and before financial reporting. It must define: functional currency, transaction currency, exchange-rate source and date, original-currency values, functional-currency postings, rounding, realised FX gains and losses, and period-end revaluation; acceptance tests cover reconciliation and reporting. **Until it is implemented the single-currency limitation is explicit**: M1 journals are posted in the company's base currency only, and the API and documentation say so (V1-POST-06 stays PARTIALLY IMPLEMENTED). Design: `v1-plan.md` milestone M3 and ADR-50.

### DEC-010 - VAT: standard accounting first
M-VAT builds effective-dated tax codes and rates; standard, reduced, zero-rated, exempt and outside-scope treatments; sales and purchase VAT; credit notes; VAT-inclusive and exclusive calculations; tax-point handling; rounding; control-account reconciliation; and a VAT-return workpaper. The model accommodates applicable reverse-charge cases and **separates the VAT treatment/rate from the VAT accounting scheme**. **Cash accounting and the Flat Rate Scheme are deferred**, with an extensible model that can take them. Tax rules use verified official HMRC sources, and each rule records its source and effective dates (nothing is entered from memory; unverified rules stay marked UNVERIFIED and cannot be activated). Design: `v1-plan.md` milestone M4 and ADR-51.

### DEC-011 - Customers and suppliers are contacts with roles
`contact` is reused for customers and suppliers, with role-specific profile data for the fields that differ. One contact may hold both roles. Tenant and company scope stay enforced. Transactions keep the contact details as they were at the time (snapshot) where reporting and evidence need them. Design: ADR-52.

### DEC-012 - Opening balances and control accounts: permission plus approval
A distinct `ledger:opening-balance` permission is required for opening-balance journals. Control accounts stay protected from ordinary manual postings; narrowly authorised adjustments need a reason, evidence and an audit trail. Configurable second-person approval applies to material opening balances and exceptional control-account adjustments. Posted journals stay immutable; corrections stay reversals. Design: `v1-plan.md` milestone M2 and ADR-49. **Until M2 is delivered the M1 fence stays in place** (opening balances only on the first day of the first period).

### DEC-013 - Session / challenge IP and user agent: tracked separately
`session.ip`, `session.user_agent` and `auth_challenge.ip` are stored regardless of the audit switch and are not purged. They are investigated as their own item (collection, use, access, purpose, a policy-controlled retention and deletion proposal, tests). **Not resolved and not production-ready** until reviewed with evidence. Retention periods and lawful basis stay unapproved until the qualified privacy/legal review is complete (DEC-003). Evidence: `docs/legal/device-metadata-investigation.md`.

### DEC-014 - Production boundary
V1 continues on synthetic/test data. Unverified retention rules, untested real-volume performance and unapplied AWS infrastructure are not represented as production-ready; the privacy, security, deployment and operational checks stay explicit production gates (DEC-006).

### Process
The V1 plan and matrix carry, for every row: owner, dependencies, acceptance criteria and deferred scope. A milestone starts only when its specification and dependencies are written down and clear; scope is not silently expanded.


### DEC-013 update (investigation delivered; finding still UNRESOLVED)
The trace is in `docs/legal/device-metadata-investigation.md` with 6 findings: `auth_challenge.ip` is collected and never read (F-1); the audit switch does not cover sessions or challenges (F-2); nothing is purged (F-3); `login_trusted_ip` keeps a hashed IP per user indefinitely (F-4); the generic Redis rate-limit keys hold the raw IP for up to an hour (F-5, which corrects the earlier schedule statement that all Redis keys were hashed); access is narrow (F-6). Options A-F (stop collecting the challenge IP, a session switch, coarsening, a retention job, hashing rate-limit keys, transparency) are proposed and **not enabled**. 10 characterisation tests pin today's behaviour. The item stays unresolved until the qualified privacy review is recorded here.


## Decisions of 2026-10-12 (third batch, after the V1 M2 acceptance package)

| Id | Subject | Decision |
|---|---|---|
| DEC-015 | M2 acceptance | ACCEPTED, with the proposed defaults (approval always required, 14-day expiry) |
| DEC-016 | Exchange-rate source (M3) | Manual entry always allowed, plus importers for official published series (HMRC monthly, Bank of England daily); commercial provider deferred; lookup = transaction date, else latest earlier rate within 7 days, else refuse |
| DEC-017 | Rounding policy (M3) | Rate stored unrounded to 8 decimals; each functional amount rounded per line, half-up, to the currency's minor units; the difference to balance goes to a visible system FX-rounding line within one minor unit per line, else refuse |
| DEC-018 | Revaluation and realised FX (M3) | Foreign-currency monetary items only, at the period-end rate; unrealised difference to profit or loss by an explicit, previewed `revalue` action at period close, auto-reversed on the first day of the next period; realised difference posted at settlement |

### DEC-015 - M2 accepted
Commit `d98e3ed` is accepted as the **M2 code baseline** (ledger controls). Later documentation-only commits are recorded separately (`ad1bbf1`, `3ac8f46`, `aea1a2c` and the M3 brief commit `132c6da`). Evidence retained: CI run <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029493> (9 of 9 jobs), CodeQL <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029188>, clean clone (68 files, 1303 tests, 4 end-to-end, no OpenAPI drift), migration `20260107000000_v1_ledger_controls`, package `v1-m2-acceptance.md`. The proposed defaults (approval `ALWAYS`, request expiry 14 days, no built-in threshold) are confirmed. This is milestone acceptance, **not production approval** (DEC-006); the privacy finding DEC-013 remains unresolved.

### DEC-016 - Exchange-rate source
Rates are reference data with provenance. Manual entry is always allowed (rate, source text and date mandatory, audited). Official published series are loaded by importers behind an adapter port, never fetched at posting time; the named candidates are the HMRC monthly customs/VAT rates and the Bank of England daily spot rates. A commercial provider is deferred. Lookup: the rate for the transaction date; otherwise the latest earlier rate within 7 days; otherwise the posting is refused with a request for a manual rate; never a future rate. **Consequences recorded:** (1) no live fetching is enabled by this decision - it needs network access, a check of each publisher's terms of use and a reviewer's verification of the file formats (production-style gate); (2) no real exchange-rate figures enter the repository, tests use synthetic rates; (3) the legal basis for using a given rate for VAT is an M4 matter and stays UNVERIFIED until a qualified reviewer checks the sources in `docs/legal/m3-fx-sources.xlsx`. Design: ADR-55, plan section 5.

### DEC-017 - Rounding policy
The rate is stored as published, up to 8 decimal places, and is never rounded. Only the functional-currency amount is rounded, per line, half-up (half away from zero), to the functional currency's minor units, by one function that is property-tested. Where the converted lines do not balance, a visible system-owned **FX rounding** line is added to the journal; the permitted difference is one minor unit per line, otherwise the posting is refused. VAT rounding is decided in M4 from the verified VAT rule; M3 only provides the mechanism.

### DEC-018 - Revaluation and realised FX
Only foreign-currency monetary items are revalued (bank, receivables, payables, loans, accruals); non-monetary items at historical cost keep the transaction-date rate. The rate is the period-end rate from the company's chosen series, stored with its id and date. The unrealised difference is posted to profit or loss by an **explicit "revalue" action** at period close (preview first, `period:manage`, audited, idempotent per period, refused in locked periods) and is **automatically reversed on the first day of the next period**. Realised differences are posted at settlement through the PostingService. Hedge accounting, forwards, net investments and translation of foreign operations are out of scope. A period cannot be closed with an unrevalued foreign-currency monetary balance unless the user acknowledges it.


## Decisions of 2026-10-12 (fourth batch, taken under delegated authority)

On 2026-10-12 the product owner delegated the open product and engineering decisions: *"Go ahead and take decisions things that make our platform best of best most capable."* The decisions below were taken by the engineering agent under that delegation and are recorded as such. **Delegation does not extend to what no engineering decision can establish:** naming a qualified tax reviewer, confirming that HMRC/legislation text says what the platform assumes, the privacy lawful basis and retention periods (DEC-003, DEC-013), and production approval (DEC-006). Those remain explicit gates.

| Id | Subject | Decision |
|---|---|---|
| DEC-019 | M3 acceptance | ACCEPTED under delegation, including its as-built choices (second-person rate verification; on-request auto-reversal with the close block; FX accounts designated per company) |
| DEC-020 | M4 split | M4a contact roles (no external gate) is built now; M4b VAT foundation follows as a separate milestone |
| DEC-021 | VAT rule verification (M4b) | The platform enforces the control: a new COMPANY-level permission `tax:rule-verify`, a verifier who is not the person who entered the rule, and a fixed verification record; who holds the permission is the firm's choice |
| DEC-022 | Primary sources | Not read in this sandbox (network policy); rules stay UNVERIFIED and not activatable until verified by a holder of `tax:rule-verify`; building does not wait for it |
| DEC-023 | Customer / supplier data | Role-specific profiles as below; supplier bank details encrypted, masked everywhere, viewed only with a dedicated permission (each view audited), and **not usable for payments until a second person verifies a change** |
| DEC-024 | Counterparty VAT numbers | Stored on the contact with a format check only; no validation against HMRC (an external service, not in scope) |

### DEC-019 - M3 accepted under delegation
Commit `c8fd8c0` is the **M3 code baseline**; the documentation commit `81102ad` is recorded separately. Evidence retained: CI <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470095> (9 of 9), CodeQL <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/38265470019>, clean clone (72 files, 1415 tests, 4 end-to-end, no OpenAPI drift), migration `20260108000000_v1_fx_foundation`, package `v1-m3-acceptance.md`. **Acceptance by delegation is weaker evidence than acceptance by a person who did not build the milestone**; the product owner may revisit it at any time and the package stays the reference. Milestone acceptance only, not production approval.

### DEC-020 - M4 split
**M4a (contact roles, DEC-011)**: customers and suppliers as roles of the shared `contact`, with role-specific profiles, both roles on one contact, company scope, and a snapshot for documents. **M4b (VAT foundation, DEC-010)** follows with its own specification check and acceptance package. Rationale: M4a has no external gate and is needed by every document milestone; M4b's build can proceed but its activation is gated (DEC-021, DEC-022).

### DEC-021 - VAT rule verification record and control (for M4b)
A VAT code or rate is created UNVERIFIED and cannot be used on a posting or activated until verified. Verification needs permission `tax:rule-verify` (COMPANY scope; no system role holds it by default except owner/admin - the firm grants it to its named reviewer) and must be by a different person from the one who entered or last changed the rule. The verification record holds: official source URL; instrument and provision (for example, "VAT Act 1994, s.6"; "VAT Notice 700, para 4.4"); retrieval date; effective-from and effective-to; verifier and verification time; notes; optionally an evidence document. Changing a verified rule creates a new version that is UNVERIFIED again. **Naming the reviewer is the firm's act of granting the permission, not a decision taken here.**

### DEC-022 - Primary sources not read in this environment
The sandbox network policy blocks gov.uk, legislation.gov.uk, frc.org.uk and bankofengland.co.uk. Statements about HMRC rules in the code and documents remain UNVERIFIED. No real VAT rate or rule figure is seeded; tests use synthetic codes and rates. If the product owner opens network access, the agent may read the sources and propose verification records, but verifying them remains a human act under DEC-021.

### DEC-023 - Customer and supplier profiles
* `contact_role` (company-scoped; CUSTOMER or SUPPLIER; a contact may hold both; optional account code unique per company and role; ended, never deleted, with a reason). An organisation-level contact can take roles in any company of the organisation; a company-linked contact only in its own company.
* Customer profile: payment terms (0-365 days), credit limit in the company currency, default currency.
* Supplier profile: payment terms, default currency, default expense account (an active, non-control account of the company), **bank details** (account name, sort code, account number, optional IBAN/BIC) **encrypted at field level**; lists, logs and audit records show only a masked form; viewing full details needs `contact:bank-details` and every view is audited; **a change of bank details is UNVERIFIED until a different person with `contact:bank-details` verifies it** (payment-diversion fraud control; payments in M6 will refuse unverified details).
* Documents (M5+) store a **snapshot** of the counterparty (name, VAT number, primary address, account code) so later edits never rewrite history; M4a delivers and tests the snapshot function.
* Ending a role will be refused while open documents exist once documents exist (M5/M6); until then ending is always allowed and audited.

### DEC-024 - Counterparty VAT numbers
`contact.vat_number` is optional and format-checked (GB/XI + 9 or 12 digits, or another two-letter prefix + 8-12 characters, the length range of EU VAT numbers). It is not checked against HMRC's VAT number service (external integration; would be a separate decision with its own terms of use).


### DEC-025 - VAT engine choices for M4b (delegated; 2026-10-12)
Taken under the delegation recorded above. **The VAT figures themselves are not decided here and none are seeded.**
* **Rounding:** VAT is computed per line and rounded half-up to the currency's minor units; VAT-inclusive entry takes the VAT fraction `r / (100 + r)` of the gross. Whether this matches what HMRC permits for a given business is **UNVERIFIED** and is part of what the firm's reviewer confirms.
* **Tax point:** defaults to the journal date and can be given explicitly; it selects the rate version and the return period.
* **Direction:** a SALES code always uses the output VAT account (a debit on it is a credit note and reduces output VAT); a PURCHASES code the input account; a BOTH code uses output for credits and input for debits.
* **Reverse charge:** entered net; equal output and input VAT lines are added; inclusive entry is refused.
* **Box mapping** is part of each rate version (and therefore part of what is verified), not hard-coded.
* **Not in M4b:** VAT on foreign-currency journals (refused until the rule on the currency of VAT amounts is verified); credit notes linked to their original invoice (documents, M5); cash accounting and the Flat Rate Scheme (DEC-010); MTD submission (V5). The workpaper is not a return.
* **Reviewer permission:** `tax:rule-verify` is held by owner and admin by default; partners do not get it automatically (it is granted to the named reviewer by the firm).



## Decisions of 2026-10-12 (fifth batch: M5 Sales, under the same delegation)

Taken by the engineering agent under the product owner's delegation of 2026-10-12 (see the fourth batch). Recorded **before** any M5 code, as the start rule requires. Statements about VAT law below are **UNVERIFIED** (DEC-022) and are part of what the firm's reviewer checks; they are listed with their candidate sources in `docs/legal/m4b-vat-sources.xlsx`.

| Id | Subject | Decision |
|---|---|---|
| DEC-026 | M5 scope and split | M5a sales documents (invoices, credit notes); M5b receipts and allocations; M5c VAT on foreign-currency documents (V1-VAT-15). Deferred scope listed below - nothing beyond it is built |
| DEC-027 | Sales document lifecycle and numbering | DRAFT -> APPROVED (numbered without gaps, posted, immutable) or DRAFT -> DISCARDED; no voiding of an approved document - corrections are credit notes |
| DEC-028 | Tax point on sales documents | Explicit or the issue date; supply date stored; statutory derivation not automated until verified |
| DEC-029 | Credit notes and their VAT | Linked to one invoice, never more than its outstanding amount, VAT at the rate version the invoice used, reported at the credit note's tax point |
| DEC-030 | Allocations and realised FX | Every document at its own date's rate; each allocation releases prorated carried amounts and posts the difference as realised FX in its own journal |
| DEC-031 | Foreign-currency sales and VAT before M5c | A VAT-registered company cannot approve a foreign-currency sales document (tax point on or after registration) until M5c - otherwise the sale would be missing from the VAT workpaper silently |
| DEC-032 | Receipts (M5b) | Posted when recorded (Dr bank or cash / Cr receivables); allocated at entry or later; unallocated credit kept; duplicate check; reversal only while unallocated; statement and aged receivables |

### DEC-026 - M5 scope and split
* **M5a - sales documents:** invoices and credit notes (drafts, approval, posting through the PostingService, gapless numbering, contact snapshot, duplicate and credit-limit checks with reasoned override, attachments through the evidence graph, drafts created from an ACCEPTED AI proposal, credit-note allocation with realised FX, receivables sub-ledger reconciliation, a period-close control for drafts, refusal to end a customer role with open documents).
* **M5b - receipts:** receipt Dr bank (or cash) / Cr receivables; allocation to one or more invoices; part payments; overpayments held as unallocated credit and allocated later; realised FX end to end; customer statement; aged receivables.
* **M5c - VAT on foreign-currency documents (V1-VAT-15):** after M5b, with its own specification; the order of conversion and the rate series for VAT amounts are the unverified points the firm's reviewer must confirm (VATA 1994 Sch 6 para 11; HMRC VATREC5060).
* **Deferred (not built in M5):** recurring invoices, quotes, line discounts, invoice rendering (PDF) and sending (UI and notifications, M9), online payment, direct debit, refunds, bad-debt relief, deposits and payments on account before an invoice, write-offs, statutory tax-point derivation (DEC-028).

### DEC-027 - Sales document lifecycle and numbering
* **States:** a DRAFT has no number and no ledger effect and can be edited (optimistic version) or DISCARDED with a reason (never deleted). APPROVED is reached in one transaction that numbers the document, stores the contact snapshot, recomputes every amount with the verified VAT rates, posts the journal and records audit and outbox events; the document and its lines are then immutable (database trigger), except the outstanding amounts that only allocations change.
* **No voiding:** an approved invoice is corrected by a credit note (full or partial), so the VAT trail and the numbering stay intact; a credit note issued in error is corrected by a new invoice.
* **Numbering:** per company and kind, prefix plus number (defaults `INV-` and `CN-`, starting at 1). The prefix and start number can be changed until the first document of that kind is approved (continuing numbering from a previous system). The number is taken from a locked sequence row inside the approval transaction, and the database refuses a number that is not the next one, so numbers have no gaps.
* **Payment status** is derived from the outstanding amount: UNPAID, PART_PAID, PAID (credit notes: UNALLOCATED, PART_ALLOCATED, ALLOCATED).
* **Separation of duties:** a company policy may require the approver to be a different person from the preparer (default off; DEC-015 kept approval defaults for journals, this is the same kind of switch).
* **Due date:** given, else the issue date plus the customer's payment terms.
* **Checks at approval:** (a) duplicate - another approved invoice for the same customer with the same issue date, currency and total, or the same customer reference; (b) credit limit - the customer's open balance in the company currency plus this invoice exceeds the profile's credit limit. Either refuses approval unless a reason is given; the reason is stored and audited.
* **Amounts:** line amount = quantity x unit price, rounded half-up to the currency's minor units; VAT per line as DEC-025.
* **AI:** a draft may be created from an ACCEPTED AI proposal by a person, who is recorded with the proposal; AI never approves (the PostingService and the document service refuse non-person actors).
* **Permissions:** `sales:read`, `sales:manage` (drafts), `sales:approve` (approve, allocate). Owner, admin and partner hold all three; accountant all three; manager and bookkeeper read and manage (prepare, not approve); reviewer reads. Sales settings need `ledger:policy`.

### DEC-028 - Tax point on sales documents
A document carries its issue date, an optional supply date and an optional explicit tax point; the tax point is the explicit one or the issue date (as DEC-025 for journals). The statutory derivation (basic and actual tax points, the period allowed for issuing an invoice after supply, payments received in advance) is **not automated** until a reviewer has verified it; the document view flags `taxPointReview` when a supply date is given and differs from the tax point. V1-VAT-07 stays Partially implemented.

### DEC-029 - Credit notes and their VAT
A credit note references one APPROVED invoice of the same customer and currency, uses only VAT codes that the invoice used, and cannot exceed the invoice's outstanding amount at approval (the database refuses an outstanding amount below zero). Each VAT-coded line uses **the rate version the invoice used for that code**, while its tax point is the credit note's own (so the adjustment is reported in the period in which the credit note is issued). This follows our reading of VAT Regulations 1995 reg 38 and HMRC guidance on rate changes and is **UNVERIFIED**. The database proves it: a credit-note VAT line may use a rate version effective at the invoice's tax point (stored on the line) rather than its own, even if that version has since been superseded. On approval, the credit note is allocated to its invoice in the same transaction.

### DEC-030 - Allocations and realised foreign exchange
Every document is converted at its own date's rate (M3 lookup rules). An allocation of a credit (credit note in M5a; receipt in M5b) to an invoice releases a share of each side's carried functional amount - prorated and rounded half-up, or the whole remainder when the allocation clears it (the `settle` function of M3) - and the difference between the two is posted as realised FX in its own journal (`SALES_ALLOCATION_FX`): the receivables line carries `adjusts_currency` (functional only) and the other line uses the company's realised-FX account. Revaluation auto-reverses (DEC-018), so allocations always work from historical carried amounts. Allocations are immutable (an unallocate action is not in M5).

### DEC-031 - Foreign-currency sales documents and VAT before M5c
VAT on foreign-currency journals is refused (M4b). A foreign-currency sale by a VAT-registered company still belongs in the VAT return (for example in box 6), so allowing it without VAT codes would leave it out of the workpaper silently. Until M5c, approving a foreign-currency sales document is therefore **refused for a VAT-registered company** when the tax point is on or after its registration date (`vat_foreign_currency_not_supported`); drafts can be prepared. Companies that are not VAT registered may invoice in any currency with a rate.

### DEC-032 - Receipts (M5b; delegated, 2026-10-13; refines DEC-026/030)
Recorded before the M5b code.

**Posting**
* A receipt is a cash event, so it is **posted when recorded**; there are no draft receipts.
* It posts `SALES_RECEIPT`: Dr bank or cash (an active account of subtype CURRENT_ASSET_BANK or CURRENT_ASSET_CASH) / Cr trade receivables. The journal source may touch the TRADE_RECEIVABLES, BANK and CASH control kinds and nothing else.
* Recording a receipt needs `sales:approve`, because it posts. No new permission.

**Currency**
* A receipt is in one currency and is allocated only to invoices of the same customer and currency.
* A foreign receipt converts at its date's rate (M3 lookup, or an explicit rate).

**Allocation**
* A receipt may be allocated at entry or later, to one or more invoices, in part or in full.
* What is not allocated stays as the customer's unallocated credit. It reduces the open balance, credit-limit use and the ageing.
* Every allocation follows DEC-030: carried amounts are released and the difference is realised FX.

**Duplicate check**
* Another receipt from the same customer with the same date, currency and amount, or the same bank reference, needs a reason. The reason is stored and audited.

**Correction**
* A receipt that is **not allocated** can be reversed with a reason. A `SALES_RECEIPT_REVERSAL` journal mirrors it at the same rate, and the receipt becomes REVERSED.
* An allocated receipt cannot be reversed while unallocation is deferred (DEC-026). The ledger never reverses receipt journals directly.

**Reports**
* The **customer statement** covers a date range, per currency: the opening balance, each invoice, credit note, receipt and reversal in date order with a running balance, and the closing balance.
* **Aged receivables** are given as at a date, from documents and allocations dated on or before it. The buckets are by days past due: not due, 1-30, 31-60, 61-90 and over 90. Unallocated receipts are shown as a credit. Amounts are in the document currency and totalled per currency.

**Event**
* `sales_receipt.recorded` is published through the outbox.
