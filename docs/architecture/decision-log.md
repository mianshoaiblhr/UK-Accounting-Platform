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


## Decisions of 2026-10-13 (sixth batch: M6 Purchases, under the same delegation)

Recorded before any M6 code. Statements about VAT law remain **UNVERIFIED** (DEC-022).

| Id | Subject | Decision |
|---|---|---|
| DEC-033 | M6 scope and split | M6a bills and debit notes; M6b supplier payments; M6c cash transactions (money in and out without a document) with the negative-cash control. Mirrors M5 with the differences below |
| DEC-034 | Bills and debit notes | The supplier's own invoice number is required and is the duplicate key; an internal number for audit; input VAT and reverse charge; a debit note at the bill's VAT rate version |
| DEC-035 | Supplier payments and stored bank details | Payments mirror receipts. A payment to a supplier whose stored bank details are not verified is flagged, not blocked (the money has already gone); payment files and runs stay deferred, and they will require verified details |
| DEC-036 | Cash transactions and negative cash | Direct money-in and money-out entries with VAT per line. A bank account may go overdrawn with a warning; a cash-in-hand account may not go below zero without a reason |
| DEC-038 | M7 scope and split | M7a bank accounts, CSV statement import (async), statement lines, transfers; M7b reconciliation, charges and interest from statements, unmatched ageing. CSV only in V1 (open decision 5 closed) |
| DEC-039 | Bank accounts | A bank-account record over a ledger account of subtype CURRENT_ASSET_BANK, with its currency, encrypted account details shown masked, and the bank's opening statement balance; new `bank:*` permissions |
| DEC-040 | Statement import | CSV document (AV-scanned) imported by an asynchronous job, all or nothing, with row errors; duplicate file refused without a reason; overlapping lines skipped by fingerprint; lines immutable; an import can be voided while nothing is matched |
| DEC-041 | Transfers | Between two bank or cash accounts of the company in the same currency: one balanced journal, negative-cash rule applies, mirror reversal with reason; cross-currency transfers deferred |
| DEC-042 | Reconciliation (M7b) | Matches link statement lines to journal lines on the account, in parts, never above either side (database-proven); unmatch with reason; deterministic suggestions that never post; charges and interest posted from a statement line as cash transactions; unmatched ageing; a signed-off reconciliation proof |
| DEC-043 | M8 financial statements and drill-down | P&L and balance sheet built only from journal lines through the reporting mapping, with comparatives, reconciling to the trial balance to the cent; one drill-down resolver per journal source down to the document |
| DEC-044 | Alerts and close controls | One alert list per company (suspense, negative cash and bank, old drafts, old unmatched bank lines, pending approvals, unverified VAT rates and supplier bank details, flagged payments), filtered by what the reader may see; locking with a suspense balance and closing with unmatched bank lines need an acknowledgement |
| DEC-045 | FX reporting | Realised and unrealised exchange differences for a range with journal drill-down, and open foreign-currency balances revalued at the closing rate against their carrying amount |
| DEC-046 | M8h: customer default VAT code (V1-MOD-02) | A customer may carry a default sales VAT code; an invoice line that does not name a VAT code takes it at the time the line is written (`taxCodeId: null` means no code); the stored line is explicit, so a later change to the default never alters a document |
| DEC-047 | M8h: posting-rule test coverage registry (V1-TEST-01) | Every journal source lists, per category (positive, negative, reversal, VAT, period lock), the test that proves it or a stated reason why the category does not apply; a test fails when a source is missing, a category is blank, or a named test does not exist |
| DEC-048 | M9 scope and split: V1 screens behind `bookkeeping.core` | M9a workspace (company home with the alert dashboard, chart of accounts, journals with drill-down, trial balance, P&L, balance sheet, periods with close and lock controls); M9b sales and purchases; M9c bank, cash and reconciliation. Every screen shows what the API returns and computes no accounting figure |
| DEC-049 | M9: what the screen may show and do | A new read-only endpoint returns the caller's effective permissions in a company and the resolved feature flags; screens hide what the caller may not do, the API stays the only enforcement. With the flag off the bookkeeping screens are not reachable |
| DEC-050 | M9: how screens are proven | Each slice is accepted on a real-browser test against the real stack (the V0 Playwright harness): the main path, a refusal shown to the person, and a reader who sees no action buttons; plus the web typecheck and production build in CI |
| DEC-051 | V2 approved: Accounts Production (2026-10-17) | The product owner approved `v2-proposal.md` as written: milestones V2-M0..M7 in that order, FRS 105 before FRS 102, reporting maps into the database in V2-M1 (MAN-ACC-09), V2 under the DEC-019 delegation, development on synthetic data without waiting for V1's production gates. The qualified accountant is not yet named |
| DEC-052 | V2: accounting-standard rules are verified by a second person | Every standard version, reporting map, disclosure rule, validation rule and size threshold is created UNVERIFIED with its source; a holder of `accounts:rule-verify` other than its author verifies it; changes create a new UNVERIFIED version. Unverified rules produce only previews marked as such; nothing filing-ready is produced from them (V2-M6). Nothing is seeded from memory |
| DEC-053 | V2-M1 scope: the reporting framework as data | Standards and effective-dated versions; per-version statement lines with totals as data; a map from V1 reporting lines (and account subtypes) to statutory lines with per-account overrides; disclosure and validation rules as a closed expression language (no code evaluation); the framework a company reports under per financial year; statutory statements computed from the ledger through it |
| DEC-054 | V2: golden trial balances | Each statement, note and size test is proven on a hand-calculated synthetic trial balance with its expected output written first; the expected figures are reviewed by the named accountant before a rule version is verified |
| DEC-057 | V2-M1 golden outputs reviewed | Shoaib, the named accountant, reviewed the V2-M1 golden workings (`v2-m1-golden-workings.xlsx`) on 2026-10-18. This review covers the synthetic expected figures only; it verifies no standard version |
| DEC-059 | V2-M3 split and V2-M3a design (delegated, DEC-019; recorded before code) | V2-M3a covers accruals and accrued income (auto-reversed on the first day of the next period), prepayments and deferred income (released by schedule) and provisions (made, used, released). V2-M3b covers the closing journal to retained earnings, which every P&L figure excludes. Every posting goes through the PostingService under its own source with a mirror; each balance account reconciles to the ledger |
| DEC-060 | How V2-M3b is built: the year-end closing journal (delegated, DEC-019; recorded before code) | One closing journal per financial year moves every income and expense balance of the year to retained earnings; while it is live nothing posts income or expense into the year (PostingService and database). Every P&L figure leaves closing journals out; the balance sheet's lines are the same before and after the close, and its trial-balance proof includes the closing journal. Refines DEC-059's "balance sheets include them" without changing DEC-059 |
| DEC-061 | Golden outputs of V2-M2, V2-M3a and V2-M3b reviewed | On 2026-10-19 the product owner (Shoaib, the named accountant, DEC-056) answered "All verified" after receiving the V2-M3a and V2-M3b acceptance packages and golden workings (V2-M2's were delivered earlier). Recorded as the review of the synthetic golden figures of V2-M2, V2-M3a and V2-M3b. It verifies no standard version: that happens in the platform under DEC-052 |
| DEC-062 | How V2-M4 is built: director and shareholder loan accounts, related parties (delegated, DEC-019; recorded before code) | Read-only registers over the ledger, no new journal source: a loan account per person on a dedicated non-control ledger account, its statement and review flags (thresholds are the firm's review settings, versioned, never legal values); a related-party register whose year report reads the counterparty's sales, purchase and cash journals and its year-end balances from the ledger |
| DEC-063 | V2-M5 split; how V2-M5a is built: the accounts document (delegated, DEC-019; recorded before code) | V2-M5a renders the accounts document (statements, accounting policies, notes, directors' report and balance-sheet statements) from wording held as data in the standard version (verified like all its content) and from facts drawn from the ledger, the registers and a few facts the preparer enters. V2-M5b adds the size test (company-law thresholds as verified data) and the cash flow statement (full FRS 102) |
| DEC-064 | Draft wording packs written by engineering at the product owner's instruction | On 2026-10-19 the product owner said "go add wordings yourself". Engineering drafts FRS 105 (micro-entity) and FRS 102 Section 1A (small) packs: statement lines, the map from V1 reporting lines, validation rules and wording. The packs live in the repository and are imported through the API as UNVERIFIED versions authored by the person running the import. They are never seeded by a migration and never verified by engineering. This amends DEC-052's "nothing is seeded" only to the extent of keeping importable drafts; DEC-052's verification rule is unchanged |
| DEC-065 | Draft wording packs reviewed by the product owner | On 2026-10-20 the product owner (Shoaib, DEC-056) said "I have gone through documents" after receiving the DEC-064 packs and `v2-draft-wording-review.xlsx`. Recorded as the product owner's read of the drafts. No verdicts were returned and nothing is verified: the packs stay UNVERIFIED until a holder of `accounts:rule-verify` who is not the importer verifies them in the platform (DEC-052) |
| DEC-066 | V2-M5b split again; how V2-M5b is built: the size test (delegated, DEC-019; recorded before code) | V2-M5b is the size test only; the cash flow statement moves to V2-M5c. Company-law size thresholds are organisation data in effective-dated threshold sets, each with a source, created UNVERIFIED and verified by a second person, never seeded. The test of a framework year applies the "two or more of three" conditions and the two-consecutive-years rule per class, with turnover adjusted for a year that is not twelve months, and reports whether the entity size chosen for the year fits. Amends DEC-063's split only; DEC-063 is not rewritten |
| DEC-067 | How V2-M5c is built: the cash flow statement (delegated, DEC-019; recorded before code) | The cash flow statement is version content verified with the version (DEC-052): cash-flow classes (operating, investing, financing, with their captions), a map from V1 reporting lines to the classes or to cash, the sizes that need the statement and its captions. The figures come from the ledger by one exact identity: the change in cash equals minus the movement of every other account; investing and financing classes show their cash part (from journals that move cash), their non-cash part is an operating adjustment, and operating classes show their whole movement (the indirect method). The statement always reconciles to the ledger's cash; an account the map does not place is shown as unclassified and keeps the statement incomplete |
| DEC-068 | V2-M6 split; how V2-M6a is built: review flags and the review checklist (delegated, DEC-019; recorded before code) | V2-M6a raises the nine review flags of a framework year live from the ledger, the registers and the documents, with the firm's review settings as versioned data; each flag is explained by a preparer and signed off by a second person holding a new `accounts:review` permission, and an explanation lapses when the flag's figures change. V2-M6b is the 14-step year-end workflow; V2-M6c partner review, client approval, locking and the filing-ready package |
| DEC-069 | How V2-M6b is built: the 14-step year-end workflow (delegated, DEC-019; recorded before code) | Each step of the specification's year-end workflow reads its status from an existing control (bookkeeping cut-off, the review checklist's flags, the fixed-asset and year-end registers, the VAT workpaper, the accounts document and the size test). A preparer signs a step off with a note only when its control is ready and the steps it depends on are done; a sign-off lapses when its control stops being ready. Steps 12 to 14 are V2-M6c |
| DEC-070 | How V2-M6c is built: partner review, client approval, locking and the filing-ready package (delegated, DEC-019; recorded before code) | A fingerprint of the accounts document ties the three records together. A second person holding `accounts:review` records the partner review of the accounts as signed off at step 11. The client's approval is recorded against the document's approval facts (the approving director and the date), with evidence. It needs a live partner review and every period of the year closed, and it locks the periods and the year's framework. Facts, flag responses and workflow sign-offs for the year are then refused. A preparer generates the filing-ready package once; it is refused unless the approved figures are unchanged and every rule it uses was verified by a second person (V2-ARC-04) |
| DEC-071 | V2-M7 split; how V2-M7a is built: the year-end workspace screens (delegated, DEC-019; recorded before code) | V2-M7 is split like V1-M9: V2-M7a the year-end workspace (the 14-step workflow, the review checklist, the accounts document with its facts and size test, partner review, client approval and the package); V2-M7b the registers (fixed assets, year-end adjustments, the closing journal, director loan accounts and related parties); V2-M7c the reporting framework (standards and their content, verification, thresholds, the framework of each year, the statutory preview and cash flow). Each screen shows what the API returns and computes nothing; each slice is proven in a real browser (DEC-050) |
| DEC-072 | Engineering's data check of V2, a review not a verification (2026-10-21) | At the product owner's request ("Check data yourself"), engineering checked the V2 data: the goldens re-derived, invariants recomputed, the draft size thresholds against the reachable sources, every reference in the wording packs, and the matrix evidence. One finding (NOTE.CREDLONG discloses after one year where the requirement cited is after five years and secured debts), five items to check, one limitation; nothing in the platform changed. Under DEC-052 this verifies nothing: engineering wrote the data |
| DEC-073 | Draft wording packs 0.2: findings F1 to F3 of the data check reworded (2026-10-22) | After the data check (DEC-072), engineering reworded three rules of the draft packs. NOTE.CREDLONG now discloses the debts payable after more than five years and the secured debts, from facts. NOTE.EMPLOYEES no longer says "(including directors)". POL.FININST no longer asserts only basic financial instruments. Both packs are now draft 0.2 and still UNVERIFIED; nothing is imported or verified by this |
| DEC-074 | How V2-M7b is built: the register screens (delegated, DEC-019; recorded before code) | A "Registers" section behind `accounts.production` with the fixed-asset register, classes and assets (add, estimate, tax fields, dispose, reverse), depreciation runs, year-end adjustments and release runs, provisions and their movements, the closing journal, director loan accounts (statements, report, thresholds) and related parties (report). The screens show what the API returns and compute nothing; proven in a real browser (DEC-050) |
| DEC-075 | The product owner's design stack installed in the repository (2026-10-25) | The product owner attached their design-stack file and the frontend-design skill and chose to install the stack and redesign the screens. Five skills were installed into `.claude/skills/` and committed: design-taste-frontend v2, frontend-design, senior-frontend, ui-design-system and ui-ux-pro-max. The file is saved as `CLAUDE.md`, with what was and was not installed. The vendored skill code is excluded from lint and CodeQL. framer-motion and gsap are added only if a screen needs them; the MCP servers are per machine and need the owner's key or sign-in |
| DEC-076 | UI-1: the platform's visual system (delegated, DEC-019; recorded before code) | Following the owner's frontend-design skill and the dealt Achromatic-ledger style, every screen gets one visual system: a ledger blue-grey ground, blue-black ink, Geist bundled with the app, one signal-blue hue on the main data element, red ink only for what is wrong, an open-plane sidebar with the product, the company and the sections, and the accountant's ruled totals (a single rule above a total, a double rule under the final one). Nothing a screen shows changes; the 32 browser tests pass unchanged |
| DEC-077 | October 2026 dependency advisories (2026-10-25) | CI's dependency audit began failing on advisories published after the last green run, none from UI-1. Updated next to 15.5.28 (a critical remote-code-execution and a denial of service), vitest to 4.1.12, and through overrides body-parser 2.4, multer 2.5, undici 8.12.3 and fast-uri 3.1.9. Zod's advisory (GHSA-mrhx-c7xc-m3w5) is patched only in Zod 4; the platform uses Zod 3, which has the same unbounded issue list. The API now refuses any request array over 5,000 items before validation, a test proves no limited schema allows more, and the advisory is listed in the audit's ignore list with this record. Moving to Zod 4 is left for its own milestone |
| DEC-078 | UI-1 build record (2026-10-25) | Building DEC-076 refined it without changing its intent: the ruled total sits over the figures only; the mark is an "=" (the ledger in balance); the sidebar groups are Books, Reports, Money and Accounts production; dark-mode pills added (41 contrast pairs pass); wide tables keep a minimum width on a phone. Three pieces of the platform's own chrome changed wording ("Dashboard" to "Companies" in the top bar; the breadcrumb became the sidebar's company block; middle dots left the sub-navigation). No word, figure or state from the API changed. A new browser test holds the quality floor |
| DEC-079 | The look: the design prototype is the reference (2026-10-27) | The product owner decided the platform should look "just like" the design prototype (six screens, `docs/design/prototype/`). The prototype applies DEC-076 unchanged and extends it to screens not yet built: practice overview, clients, client workspace, VAT return, MTD Income Tax and the CT600. The AccLedger/shadcn look proposed in the AccLedger blueprint is not adopted |
| DEC-080 | Sage-style nominal codes: chart templates version 2 (2026-10-27) | The product owner chose Sage-style codes. Chart templates version 2 use the Sage 50 ranges, one template per business type (limited company, sole trader, partnership, landlord), drafted in `chart-templates-v2.xlsx` for the owner's review before code. Version 1 stays for existing companies. One VAT control account (2200). HMRC categories and SA103F/SA105 boxes are UNVERIFIED (DEC-022) |
| DEC-081 | MTD Income Tax and Self Assessment: specification V13, built against HMRC's sandbox (2026-10-27) | No specification covered Income Tax for individuals. V13 (`docs/specifications/V13_MTD_Income_Tax_Self_Assessment.md`) is written now and built against HMRC's sandbox only, after V5's HMRC adapter, which it shares. Production access is an explicit gate. Blocked on HMRC sandbox credentials and network access to HMRC's sandbox |
| DEC-082 | HMRC's test environment set aside (2026-10-27) | The product owner said "ignore hmrc test environment". Amends DEC-081: V13 is not built or tested against HMRC's sandbox; it is built against the fake HMRC adapter only, and nothing calls HMRC, sandbox or live, until the owner decides on HMRC access. The sandbox credentials and network blockers are withdrawn |
| DEC-083 | Verification of the VAT rules and the accounting-standard versions directed (2026-10-27) | The product owner approved going ahead with verification. It is done in the platform by a holder of `tax:rule-verify` / `accounts:rule-verify` who did not enter the rule (DEC-021, DEC-052); the owner's approval verifies nothing, and AI never verifies. Engineering supplies `docs/legal/rule-verification-worksheet.xlsx`. Verification needs a running environment: staging (DEC-085) |
| DEC-084 | Retention and privacy approved (2026-10-27) | Amends DEC-003. Every period in the retention schedule is CONFIRMED as written; WHILE_ACTIVE data is kept 6 years after the relationship ends. The accounting practice is the controller of its clients' data and the platform operator its processor. IP address and user agent: legitimate interests, minimised. S4(b) is unfrozen; erasure and purge are built as milestone PRIV-1 before real client data |
| DEC-085 | Production gate approved: staging first, then live (2026-10-27) | Amends DEC-006 and DEC-014. The owner approved going live on AWS London. A person with AWS access applies the Terraform: staging first, where the rules are verified (DEC-083) on synthetic data; then production with real client data, once PRIV-1 is built and the go-live checklist in this entry is met |
| DEC-086 | Build order: V7, then V5, then V3 and V4 (2026-10-27) | The owner asked to build. V7 (practice layer) is split into five milestones, starting with the compliance calendar; V5 (VAT) follows, with the HMRC connection built against the fake adapter only, as DEC-082 does for V13; then V3 (iXBRL, Companies House) and V4 (Corporation Tax) |
| DEC-087 | Correction to DEC-080: VAT accounts in chart templates version 2 (2026-10-27) | DEC-080 said the VAT engine posts to one control account. It does not: the VAT settings name an output and an input account, which may differ (M4b). The templates therefore use Sage's three VAT accounts: 2200 output VAT, 2201 input VAT, 2202 VAT liability. Account counts become 111, 105, 106 and 38 |
| DEC-088 | How V7-M1 is built: the compliance calendar (delegated, DEC-019; recorded before code) | Deadline rules are sourced, versioned organisation data, verified by a second person before use. Obligations per client are generated from its accounting periods, VAT settings and confirmation-statement date, or entered by hand; each has a status, an owner and filing evidence. A practice-wide list and counts cover only the clients the caller may read. Behind the new flag `practice.management` and four new permissions |
| DEC-089 | How V7-M2 is built: the practice overview and the client list (delegated, DEC-019; recorded before code) | A practice shell with the prototype's sidebar (DEC-079); an overview of the counts, the deadlines due soon and the open work by status; a client list with year end, VAT, the next deadline and the client manager, over the clients the caller may read. A client manager is set on the compliance profile. Behind `practice.management` |
| DEC-090 | How V5-M1 is built: the VAT return (delegated, DEC-019; recorded before code) | A VAT return per client and period, prepared from the M4b workpaper and tied to it by a fingerprint; review flags explained before review; a second-person review and a recorded client approval that freeze the return and lock the period against new VAT lines. Filing (fake HMRC adapter only) is V5-M2, the screens V5-M3. Behind the new flag `vat.returns` and two new permissions |
| DEC-091 | How V5-M2 is built: the VAT filing record (delegated, DEC-019; recorded before code) | An approved return becomes a filing package (boxes 6 to 9 in whole pounds by a verified presentation rule). A filing made outside the platform is recorded with HMRC's receipt and evidence: it posts the liability journal and marks the obligation done. A simulated submission through the HMRC port (fake adapter only, refused in production) exercises the seam and changes nothing else. New permission `vat:file` |
| DEC-092 | How V5-M3 is built: the VAT return screens (delegated, DEC-019; recorded before code) | A Tax group in the client workspace with VAT returns: the list, opening a return, and the return screen of the prototype (nine boxes with drill-down, checks and flags, sign-off, the client's approval, the filing package and the filing record). Events carry the person's name from the API. Behind `vat.returns` |
| DEC-093 | V3 plan and how V3-M1 is built: the taxonomy and its mapping (delegated, DEC-019; recorded before code) | V3 in four milestones (`docs/architecture/v3-plan.md`). V3-M1 holds taxonomy versions and their concept maps as versioned organisation data, verified by a second person; nothing of the taxonomy is in code. A draft pack lands UNVERIFIED. Behind the new flag `ixbrl.filing` and two new permissions |
| DEC-094 | How V3-M2 is built: the iXBRL document and its validation (delegated, DEC-019; recorded before code) | From the year's approved accounts package and the verified taxonomy version for its standard and year end, the platform builds the contexts, units and facts and renders an inline XBRL (XHTML) document of the accounts. The in-platform checks are stored with it; a document with an error is INVALID. Full taxonomy validation by an external validator is a go-live step |
| DEC-095 | How V3-M3 is built: the Companies House filing workflow (delegated, DEC-019; recorded before code) | A filing of a VALID iXBRL document moves DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED or REJECTED, with append-only evidence of each step. Submission needs a person's explicit authority and goes through the Companies House port, whose only adapter is a fake refused in production; a filing made elsewhere is recorded with its evidence. Acceptance marks the accounts deadline done. New permission `ixbrl:file` |
| DEC-096 | How V3-M4 is built: the iXBRL and filing screens (delegated, DEC-019; recorded before code) | An "Accounts filing" page in the client workspace (the year's iXBRL documents and their checks, the document itself, and the Companies House filing step by step with its evidence) and a "Taxonomy mapping" page for the practice (versions, entries, problems, verification). Screens compute nothing. Behind `ixbrl.filing` |
| DEC-097 | V4 plan and how V4-M1 is built: Corporation Tax rules, tax periods and the tax profile (delegated, DEC-019; recorded before code) | V4 in six milestones (`docs/architecture/v4-plan.md`). V4-M1: CT rules (rates and limits by financial year, the maximum length of a CT accounting period) as sourced, effective-dated, verified organisation data; the company's tax profile; CT accounting periods derived from the accounts year and split by the verified maximum, each with its associated companies. Behind the new flag `corporation.tax` and two new permissions |
| DEC-098 | V4-M1 details settled while building (delegated, DEC-019) | Any current CT rule version, verified or not, is changed by superseding it (a version is never edited); a new version keeps its kind. Deriving periods answers 200 with `created`. If the accounts year changed after its periods were derived, deriving refuses with `ct_periods_stale` instead of re-splitting |
| DEC-099 | How V4-M2 is built: tax adjustments and the profit of each CT period (delegated, DEC-019; recorded before code) | Account adjustment rules (an account, a category and the share of its movement that is added back or deducted) as company data, verified by a second person; manual adjustments with evidence, withdrawn but never removed; the profit of a CT period from the ledger (profit before tax), each adjustment and the adjusted profit, each adjustment drilling to its ledger lines or its evidence, with what still needs attention. Nothing is stored as a result |
| DEC-100 | How V4-M3 is built: capital allowances (delegated, DEC-019; recorded before code) | Three new CT rule kinds (the AIA limit, the writing-down rates, the small pools limit) as verified data; pool opening balances entered with evidence and verified by a second person; the capital allowances of a CT period worked from the fixed-asset register's tax category and cost (AIA in date order, main and special rate pools, single asset pools, disposal values capped at cost, balancing charges and allowances, small pools), shown live and stored as a computation that the next period starts from. First-year allowances (full expensing) are left for a later milestone |
| DEC-101 | How V4-M4 is built: losses, the computation and the canonical CT600 (delegated, DEC-019; recorded before code) | The tax computation of a CT period from the adjusted profit (V4-M2) and the stored capital allowances (V4-M3): trading losses brought forward and carried back one period, taxable total profits, tax by financial year with the small profits rate and marginal relief from verified rules, associated companies and short periods. Prepared and approved by two people (new permission `ct:approve`); the canonical CT600 is built from the approved computation. Non-trading income, group relief and instalments are not modelled |
| DEC-102 | How V4-M5 is built: CT iXBRL and the HMRC submission (delegated, DEC-019; recorded before code) | The CT600 box map as a verified CT rule kind; the tax computation tagged as inline XBRL from a verified taxonomy version of the V3 kind; a CT return of an approved computation, with the accounts' iXBRL, moving DRAFT, VALIDATED, AUTHORISED (a director's declaration recorded by a second person), SUBMITTED, then ACCEPTED or REJECTED, through an HMRC port whose only adapter is a fake refused in production; acceptance closes the CT return deadline. New permission `ct:file` |
| DEC-058 | V2-M2 scope and design (delegated, DEC-019; recorded before code) | A fixed-asset register per company, with classes, additions (posted, linked to an existing posting, or taken on with accumulated depreciation), straight-line and reducing-balance depreciation under a daily or monthly convention, prospective changes of estimate, depreciation runs, and disposals with gain or loss. Each posting goes through the PostingService under its own journal source with a mirror reversal. Tax treatment is stored apart and never read by depreciation. The register reconciles to the ledger by account |
| DEC-056 | V2 qualified accountant named | The product owner named **Shoaib** (2026-10-18) as the firm's qualified accountant for V2: reviews the golden expected outputs and verifies standard versions with `accounts:rule-verify`. Naming verifies nothing; DEC-052 applies unchanged |
| DEC-055 | How V2-M1 is built (delegated, DEC-019) | Totals are a list of signed line references; only a verified version is superseded; an account lands on exactly one line by construction (override, else the most specific map entry), proved by a reconciliation in every preview; the V2 API is gated by a new `accounts.production` flag; content is removed by a flag while unverified, never deleted |
| DEC-037 | How M6c is built (delegated, DEC-019) | The negative-cash rule lives in the PostingService and the database, so it covers every posting a person makes to cash in hand (not only cash transactions), checks every later day, and stores the reason on the journal. Cash transactions are in the company currency, have new `cash:*` permissions and a proven mirror reversal |

### DEC-033 - M6 scope and split
* **M6a - purchase documents:** bills and debit notes. The design is the same as M5a (drafts, approval, sequences, snapshot, immutability, allocation, realised FX, reconciliation) on its own tables (`purchase_*`) and journal sources (`PURCHASE_BILL`, `PURCHASE_DEBIT_NOTE`, `PURCHASE_ALLOCATION_FX`).
  * The controls reach TRADE_PAYABLES.
  * The verified sales code is not refactored. Shared arithmetic (`lineAmount`, `releaseShare`, the VAT functions) is reused.
* **M6b - supplier payments:** Dr trade payables / Cr bank or cash, as DEC-032 mirrored. The same applies to allocation, overpayment (a prepayment held as unallocated debit), realised FX, reversal while unallocated, the supplier ledger statement and aged payables.
* **M6c - cash transactions (V1-MOD-11):** money out (Dr expense or asset / Dr input VAT / Cr bank or cash) and money in (Dr bank or cash / Cr income / Cr output VAT) without a source document, with the negative-cash control (DEC-036).
* **Deferred:** purchase orders, expense claims, payment runs and bank file export, supplier refunds, petty-cash float management, recurring bills, and OCR capture of bills (V6).

### DEC-034 - Bills and debit notes
* **Supplier reference:** a bill records the supplier's invoice number. It is required: it is what the supplier and HMRC see.
* **Duplicates:** another approved bill from the same supplier with the same supplier reference (case and spaces ignored), or with the same date, currency and total, refuses approval unless a reason is given (V1-CTL-02).
* **Internal numbering:** approval also takes an internal gapless number (`BILL-` and `DN-` by default) for the audit trail.
* **Lines:**
  * go to expense or asset (non-control) accounts;
  * default to the supplier profile's default expense account;
  * VAT codes must be PURCHASES or BOTH, and reverse charge is allowed (M4b).
* **VAT on approval:** input VAT, or the reverse-charge pair, is posted by the PostingService and proved by the database.
* **Debit notes:**
  * credit one approved bill of the same supplier and currency;
  * use only its VAT codes, at its rate versions, at the debit note's own tax point (DEC-029 mirrored, UNVERIFIED);
  * never more than the bill's outstanding amount;
  * are allocated to the bill when approved.
* **Foreign currency:** as for sales (DEC-031), a VAT-registered company does not approve a foreign-currency bill with a tax point on or after its registration date until M5c's rule covers documents in both directions. Foreign purchases (imported services under reverse charge, for example) belong in boxes 1, 4 and 7, so approving them without VAT would understate the return without anyone seeing it.

### DEC-035 - Supplier payments and stored bank details
* **Posting:** a payment is posted when recorded (Dr trade payables / Cr bank or cash) and follows DEC-032 mirrored.
* **Duplicates:** the same supplier with the same date, currency and amount, or the same reference, needs a reason.
* **Stored bank details:** DEC-023 said stored details are "not usable for payments until a second person verifies a change". In V1 the platform records payments that have already been made; it does not send money.
  * A payment recorded while the supplier's stored details are UNVERIFIED is **flagged** (`bankDetailsUnverified: true`) on the payment and in its audit event, so a review can catch payment-diversion fraud.
  * When payment runs and bank files are built (deferred), they will **refuse** unverified details.

### DEC-036 - Cash transactions and the negative-cash control
* **Money in and out:** a transaction posts `CASH_PAYMENT` or `CASH_RECEIPT` with VAT per line, with the same VAT rules as documents.
* **Bank accounts:** after posting, if the account's balance on that date is below zero, the response and the audit event carry a `negativeBalance` warning. Overdrafts exist.
* **Cash in hand:** for a cash-in-hand account (subtype CURRENT_ASSET_CASH), a posting that takes the balance below zero is **refused** unless a reason is given. Cash cannot be negative, so it is either an error or a missing entry.
* **Alerts:** the dashboard and alert list for negative balances are M8 (V1-CTL-04).

### DEC-037 - How M6c is built (recorded before acceptance under the delegation, DEC-019)
These choices refine DEC-036. None of them is a tax rule; the VAT arithmetic is the verified M4b arithmetic.
* **Where the negative-cash rule lives.** DEC-036 says "a posting that takes the balance below zero is refused". The rule is therefore enforced by the PostingService for **every** posting by a person, not only by cash transactions: a supplier payment from cash in hand, the reversal of a customer receipt paid in cash, a cash transaction or its reversal, and a ledger reversal. The database re-checks it at commit (`journal_cash_check`), so code that bypasses the PostingService cannot leave cash in hand negative either.
* **Which days are checked.** The lowest balance on the posting date **or any later date** once the journal is included. A back-dated payment that leaves its own day positive but overdraws a later day is caught; checking the posting date alone would miss it.
* **The reason.** `negativeCashReason` (10 to 1,000 characters) is stored on the journal itself (`journal.negative_cash_reason`, immutable like the rest of the journal) and on its audit event. It is stored only when it was needed.
* **What is not a movement of money.** A functional-only FX revaluation adjustment (and its automatic reversal) revalues a foreign-currency balance; it is never the posting that is refused, so period-end revaluation cannot be blocked by an earlier shortfall.
* **Who is exempt.** A journal posted from an approved journal request (opening balance, control adjustment) carries its second-person approval as its authority. A system posting (none touch cash today) warns only, so a background job can never be blocked.
* **Bank accounts.** An account of subtype CURRENT_ASSET_BANK that ends below zero on the date or a later date produces a `balanceWarnings` entry in the response and the audit event. It is never refused (overdrafts exist). Dashboards and alert lists stay with M8 (V1-CTL-04).
* **Concurrency.** Postings of one company are already serialised by the journal number; the cash check also takes a per-account transaction lock in the application and in the database.
* **Scope of cash transactions in M6c.**
  * The company's currency only. Foreign-currency bank accounts come with M7; VAT on foreign currency with M5c (DEC-031).
  * Lines go to non-control accounts that are not bank, cash, VAT or FX accounts. A transfer between bank and cash accounts is M7. Receivables and payables stay with their sub-ledgers.
  * VAT codes must fit the direction: money out uses purchases codes (reverse charge allowed, entered net); money in uses sales codes (no reverse charge).
  * Duplicate check: the same account, direction, date and total, or the same reference, needs a reason.
  * An optional contact (organisation-level or of the company) or a free-text counterparty.
  * The till receipt or slip can be attached as evidence (`cash_transaction` joins the evidence graph).
* **Permissions.** `cash:read` (every role that reads the ledger) and `cash:record` (roles that may approve purchases: owner, administrator, partner, accountant). A cash transaction posts at once, so recording it is an approval-level act.
* **Reversal.** One reversal per transaction, dated on or after it, with a reason. It is the exact mirror of the posted journal, line by line and in the same order. The VAT facts and rate versions are kept, so each VAT line still points at its net line. The database proves the mirror before the transaction can become REVERSED. The reversal keeps the original tax point, as a ledger reversal does (M4b). Whether a correction found after a VAT return was filed should instead go in the current return (HMRC VAT Notice 700/45) is listed for the tax reviewer; returns are not filed in V1.

### DEC-038 - M7 scope and split (delegated, DEC-019)
* **M7a:** bank accounts (V1-MOD-10, V1-BANK-01), CSV statement import as an asynchronous job (V1-BANK-02), immutable statement lines (V1-BANK-03) and transfers (V1-BANK-06).
* **M7b:** reconciliation (V1-MOD-18, V1-BANK-04, V1-REC-01..05), charges and interest from statements (V1-BANK-07/08), unmatched items with ageing (V1-BANK-05).
* **Formats:** CSV only in V1; it is what every UK bank exports. OFX, MT940/CAMT and Open Banking feeds stay deferred (plan section 7, decision 5, now closed). The column mapping is given with each import and remembered per bank account.
* **Deferred:** Open Banking (V11), AI match suggestions (V6), payment files, cross-currency transfers, bank rules that post automatically.

### DEC-039 - Bank accounts
* **What it is:** a `bank_account` record over exactly one ledger account of subtype CURRENT_ASSET_BANK of the same company. The ledger account stays the place where money is booked; the record adds what the bank knows. Cash in hand has no statements and gets no bank-account record.
* **Fields:** a name; the bank's name; the account currency (the company's currency or a foreign one; it cannot change once a statement line exists); account details (sort code, account number, IBAN, BIC) **encrypted** with the platform field key and shown only masked (`**-**-56 ****5678`); full details only through an audited read by a holder of `bank:manage`.
* **Statement opening point:** `statementOpeningDate` and `statementOpeningBalance` (the balance on the bank's own statement at the start of record keeping on the platform). The reconciliation proof (M7b) starts from it. The ledger's opening balance is still posted through the M2 request and approval.
* **Status:** ACTIVE or CLOSED; closing needs a reason (and, from M7b, no unmatched lines).
* **Permissions:** `bank:read` (every role that reads the ledger), `bank:manage` (create and edit accounts, import and void statements: owner, administrator, partner, accountant, manager, bookkeeper - preparing records), `bank:reconcile` (match and unmatch, M7b: the same roles). Posting from the bank module still needs the posting permission of what is posted (`cash:record` for a charge, `bank:transfer` for a transfer: owner, administrator, partner, accountant).

### DEC-040 - Statement import
* **Input:** a CSV uploaded as a company document (size limit and virus scan as for every upload; only an AVAILABLE version can be imported) and a column mapping: date column and format (`DD/MM/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY`, `MM/DD/YYYY`, `DD MMM YYYY`), description, either one signed amount column or separate money-in and money-out columns (with an option to flip the sign), optional reference and running-balance columns, header row, delimiter.
* **Processing:** an asynchronous job (`bank.statement.import`, `imports` queue) with progress, retries and failures visible through the job record (V1-BANK-02). The import's own record says QUEUED, COMPLETED or FAILED, with counts (rows read, imported, duplicates skipped) and up to 100 row errors.
* **All or nothing:** one invalid row fails the whole import; nothing is stored. Rows are checked for: a valid date, not after today; a decimal amount (thousands separators, a currency symbol and parentheses for negatives are accepted) with no more decimals than the account currency; a non-zero amount; when a balance column is mapped, every balance equals the previous balance plus the amount (a broken file or a wrong mapping is caught); at most 20,000 rows.
* **Duplicates:**
  * the same file (same SHA-256) imported again into the same bank account is refused unless a reason is given;
  * each line gets a fingerprint from the account, date, amount, normalised description, reference and its occurrence number among identical lines in the file. A line whose fingerprint already exists is skipped and counted, so overlapping statements import cleanly while two genuine identical payments on one day are both kept.
* **Immutable lines:** statement lines are never edited or deleted (V1-BANK-03). An import made with a wrong mapping is **voided** with a reason while none of its lines is matched; its lines are marked void, stay visible, and their fingerprints are released so the file can be imported again correctly.
* **The worker never posts** (ADR-61): it writes statement data only.

### DEC-041 - Transfers between bank and cash accounts
* **What:** money moved between two bank or cash accounts of the company in the **same currency** (bank to bank, bank to petty cash, cash to bank). It posts one `BANK_TRANSFER` journal through the PostingService: Dr the receiving account / Cr the paying account. The negative-cash rule (DEC-037) applies to the paying account; an overdrawn bank is a warning.
* **Foreign currency:** a transfer between two accounts in the same foreign currency posts in that currency at one rate, so no exchange difference arises. A transfer between different currencies needs two amounts and a realised difference; it is **deferred** and refused with a clear error.
* **Duplicates:** the same accounts, date and amount, or the same reference, need a reason.
* **Correction:** a mirror reversal with a reason, once (`BANK_TRANSFER_REVERSAL`); the ledger does not reverse transfer journals.
* **Reconciliation (M7b):** the money-out line on one statement and the money-in line on the other each match one side of the transfer's journal.
* **Permission:** `bank:transfer` (owner, administrator, partner, accountant), because it posts.

### DEC-042 - Reconciliation (M7b; recorded now so M7a's data fits it)
* **A match** links one statement line to one journal line on the bank account's ledger account, in the same direction, for an amount in the account currency (the original amount of a foreign line, otherwise the functional amount). A statement line can be matched to several journal lines and the reverse (partial matching, V1-REC-02); the database proves that matched totals never exceed either side.
* **Never edited:** a match is undone by an **unmatch** with a reason, audited; the row stays (V1-REC-01).
* **Override:** a manual match whose dates are more than 14 days apart needs a reason (V1-REC-05).
* **Suggestions** (V1-REC-04) are deterministic and computed on request: an unmatched journal line with exactly the remaining amount, in the same direction, within 7 days, ranked by reference match and date distance, with ambiguous ties shown as such. Lines that read like bank charges or interest are proposed for posting. A suggestion never matches or posts by itself.
* **Charges and interest from the statement** (V1-BANK-07/08): from an unmatched line a person posts a cash transaction (to the bank account's charges, interest-received or interest-paid account, or any other account and VAT code) dated on the line's date, and it is matched in the same transaction.
* **Unmatched items** (V1-BANK-05, V1-REC-03): statement lines and ledger lines not fully matched, with age buckets (0-7, 8-30, 31-60, over 60 days) as at a date, and counts per account for the dashboard.
* **Proof and sign-off:** as at a date, statement balance (opening point plus lines) against ledger balance, explained by unmatched items; the difference must be zero. A person signs off a reconciliation (immutable record of the figures). Unmatching anything dated on or before a signed-off date needs a reason and is flagged on the audit event.

### DEC-043 - M8 financial statements and drill-down (delegated, DEC-019)
* **Source of every figure:** journal lines, summed by account and mapped through the versioned reporting-line registry (ADR-48). No report reads a source-document table; an architecture test enforces it (V1-ARC-02).
* **Profit and loss** for a date range, with an optional comparative range: turnover, cost of sales, gross profit, administrative expenses (including depreciation and other expenses as separate lines), other operating income, operating profit, interest receivable and payable, profit before tax, tax, profit for the period.
* **Balance sheet** as at a date, with an optional comparative date: fixed assets, current assets, creditors within and after one year, net current assets, net assets; capital and reserves = share capital + reserves + **profit and loss account** (the P&L cumulated to the date, shown as brought forward to the start of the financial year plus profit for the year to date). The financial year is the accounting period that contains the date. There is no year-end closing journal yet (V2); the presentation does it.
* **Proof:** each statement carries its reconciliation to the trial balance (the P&L equals the net of P&L accounts for the range; total assets equal liabilities plus equity to the cent, otherwise the statement says so).
* **Presentation:** amounts are exact (no rounding to pounds; that is V2 with FRS 102/105 statements, notes and filing). Lines without amounts are omitted unless asked for.
* **Drill-down (V1-RPT-02, MAN-ACC-06/07, XP-01):** every line lists its accounts; every account opens its general ledger for the same range; every journal opens its source through one resolver per journal source type (sales and purchase documents, receipts and payments, allocations, cash transactions, transfers, journal requests, revaluation runs, reversals) and from there its attached documents. A test enumerates every journal source and fails if one has no resolver.

### DEC-044 - Alerts and close controls
* **One alert list per company** as at a date, each alert with a severity, a count, the oldest item and drill links: suspense balance (V1-CTL-03); cash in hand below zero and overdrawn bank accounts (V1-CTL-04); sales and purchase drafts older than a threshold (default 14 days; V1-CTL-05); statement lines unmatched for longer than a threshold (default 30 days; V1-BANK-05); journal requests awaiting approval; unverified VAT rate versions (postings with them are refused); suppliers whose bank details are unverified, and payments recorded while they were (DEC-035).
* **Who sees what:** the list needs `ledger:read`; each alert appears only to people who may read its module (sales drafts need `sales:read`, and so on).
* **Close and lock controls:** closing a period with statement lines dated in it that are not fully matched needs `acknowledgeUnreconciledBank` (MAN-ACC-08); locking a period whose end shows a suspense balance needs `acknowledgeSuspenseBalance` (V1-CTL-03). Both are recorded on the audit event with the figures.
* **Screens:** the dashboard that shows these is M9; the API is complete now.

### DEC-045 - FX reporting (V1-FX-09)
* **Exchange differences for a range:** realised (allocation journals) and unrealised (revaluations and their reversals) totals in the functional currency, by currency, each with its journals.
* **Open foreign-currency balances as at a date:** for each monetary account and currency, the original-currency balance, its functional carrying amount, the closing rate (the lookup rule of M3) and the amount at that rate, and the difference that a revaluation would post. With the revaluation posted, the difference is zero.
* Multi-currency presentation of the statements stays V2.

### DEC-046 - Customer default VAT code (M8h; delegated, DEC-019; V1-MOD-02)
* **Field:** `customer_profile.default_tax_code_id`, optional. It must be a VAT code of the organisation whose direction is SALES or BOTH and that is not reverse charge (the same rule a sales line applies). The service and the database (foreign key to the organisation's codes and a trigger on the direction) both check it. Setting or changing it is audited before/after like the other profile fields.
* **Use:** when an invoice draft is created or its lines are replaced, a line whose `taxCodeId` is **absent** takes the customer's default; `taxCodeId: null` states "no VAT code" and is kept. The resolved code is stored on the line, so the document is explicit and later changes of the default never alter it. Credit notes are unaffected (they use only their invoice's codes, DEC-029).
* **Foreign-currency invoices:** VAT on them is M5c (DEC-031), so the default is not applied to a document in a currency other than the company's; the draft's warnings say so rather than the draft being refused.
* **Not in scope:** a supplier default VAT code (V1-MOD-03 does not require one; suppliers keep the default expense account). The default is a convenience: the VAT rule itself still needs a verified rate version at approval (DEC-021).

### DEC-047 - Posting-rule coverage registry (M8h; delegated, DEC-019; V1-TEST-01)
* **Registry:** `tests/rules/posting-rules.ts` maps every journal source of `JOURNAL_SOURCES` to five categories: positive, negative, reversal, VAT, period lock. Each entry names a test file and the exact title of a test in it, or `n/a` with a reason (for example: an FX revaluation never carries VAT).
* **Enforcement:** `tests/unit/posting-rule-coverage.test.ts` fails when a journal source has no entry, an entry has a blank category, a named file does not exist, or the file has no test with the named title. A new journal source cannot be added without its tests being named.
* **VAT only where the design has it:** the registry gains `vatCodes`, true for MANUAL, the four document sources and the two cash sources. The PostingService refuses a VAT code on any other source (`vat_not_applicable`); until now the receipt, payment, transfer and allocation services simply never passed one. Mirrors (reversals) keep carrying the original's VAT facts, not codes. One test proves the refusal for every source without `vatCodes`, and that is their VAT entry in the registry.
* **Gaps found while building the registry are filled with tests, not marked n/a.** An `n/a` needs a reason that follows from the design (recorded in the registry), not from a missing test.

### DEC-048 - M9 scope and split (delegated, DEC-019; DEC-002; V1-DOD-01)
* **One flag:** every bookkeeping screen sits behind `bookkeeping.core` (the flag that already gates the API). No new flag per screen: a half-enabled bookkeeping UI is worse than none.
* **M9a - workspace:** company home with the alert dashboard (counts and severities from `GET alerts`, each alert linking to its list: suspense balance V1-CTL-03, negative cash and overdrawn bank V1-CTL-04, unmatched statement lines V1-BANK-05, old drafts, pending approvals, unverified VAT rates and supplier bank details); chart of accounts (read, create); journals list and journal page with lines and the drill-down to its source; trial balance; general ledger per account; P&L and balance sheet with comparatives and their reconciliation line; periods with close, reopen, lock and unlock and the acknowledgements the API asks for, shown as the API's own message.
* **M9b - sales and purchases:** invoice and bill drafts (lines, VAT code per line, the customer's default VAT code shown), approval with the API's warnings and override reasons, credit and debit notes, receipts and payments with allocation, customer and supplier statements and ageing.
* **M9c - bank and cash:** bank accounts, CSV import with its job status and row errors, statement lines, suggestions, match and unmatch with reason, post from statement, the reconciliation proof and sign-off; cash transactions and transfers.
* **Not in M9:** document rendering and sending, dashboards across companies, mobile layouts beyond a usable narrow width, design system work beyond the existing components, any screen for a gated or unverified rule (VAT returns, MTD).
* **Rule for every screen:** it displays amounts, totals, balances and statuses exactly as the API returns them; it never adds, rounds or derives an accounting figure. Errors are the API's RFC 9457 title and field errors.

### DEC-049 - What a screen may show and do
* **Endpoint:** `GET /organisations/{org}/companies/{company}/my-access` (the existing `.../access` lists company role grants) returns the caller's effective permissions for that company (the same resolution the API's guards use) and the resolved feature flags. Read-only, needs only membership; another organisation's company is 404.
* **Use:** screens hide actions the caller may not take and say why a section is empty. The API remains the only enforcement; a test proves a forbidden action is still refused by the API when called directly.
* **Flag off:** navigation hides the bookkeeping entries and their pages say the feature is not enabled for the organisation; nothing is fetched from the gated API.

### DEC-050 - How the screens are proven
* **Real browser, real stack:** each slice adds Playwright tests to the existing e2e harness (Next.js production build behind the same-origin proxy, NestJS, Postgres, Redis, the worker): the main path end to end with synthetic data, one refusal shown to the person, and a reader without the permission who sees no action button.
* **CI:** the web typecheck and production build already run; the e2e job runs the new tests.
* **Acceptance per slice:** the e2e tests, the access endpoint's API tests, and a list of the screens with the API routes each uses, so it is visible that no screen computes a figure.

### DEC-051 - V2 approved (product owner, 2026-10-17)
* Approved as written in `v2-proposal.md`: V2-M0 (decisions, plan, matrix), V2-M1 reporting framework, V2-M2 fixed assets, V2-M3 year-end adjustments and the closing journal, V2-M4 director balances and related parties, V2-M5 statements and notes (FRS 105 micro-entity first, then FRS 102 Section 1A, then full FRS 102), V2-M6 year-end workflow to the filing-ready package, V2-M7 screens behind `accounts.production`.
* MAN-ACC-09 is decided: reporting maps move into the database, effective-dated and verified, in V2-M1. V1's management statements keep the code registry (ADR-48) unchanged.
* V2 runs under the DEC-019 delegation: engineering records each decision before code and stops at the human gates.
* V1's production gates (DEC-006) are not a precondition for building V2 on synthetic data; they remain a precondition for production.
* **Still open:** naming the qualified accountant (the firm grants `accounts:rule-verify`). Until then every V2 rule is UNVERIFIED and V2 produces previews only.
* Not recorded as approved here: acceptance of V1 as a whole (readiness report 5.6, item 1) stays with the product owner.

### DEC-052 - Standard-rule verification (V2)
* New permission `accounts:rule-verify` (COMPANY scope like `tax:rule-verify`; held by owner and admin by default, granted by the firm to its named accountant).
* Every rule record (standard version, statement line set, map version, disclosure rule, validation rule, size threshold) carries: source URL, instrument and paragraph (for example "FRS 105, Section 4", "SI 2008/409, Sch 1"), retrieval date, effective-from and effective-to, author, verifier, verification time, notes. Verification is by a different person from the author; a verified record is immutable; a change supersedes it with a new UNVERIFIED version (DEC-021 pattern, service and database).
* Unverified records may be used for previews only; every preview says so on its face. Filing-ready output (V2-M6) refuses any unverified rule.

### DEC-053 - V2-M1 reporting framework
* **Standard** (organisation-scoped code such as FRS105, FRS102-1A, FRS102; name) with **versions** (effective dates, source, verification). Nothing is seeded.
* **Statement lines** per version: key, statement (P&L, balance sheet, cash flow later), parent, order, kind (lines from accounts, or a total over other lines with signs), display name; the totals are data, never code.
* **Map** per version: which V1 reporting lines (optionally narrowed by account subtype) feed which statutory line; a company may override an account's statutory line with a reason (audited). Every account in the trial balance must land on exactly one line, otherwise the preview lists the unmapped accounts.
* **Disclosure and validation rules** as data in a closed JSON expression language (line references, constants, +, -, comparison, tolerance, applicability by entity size); evaluated by a small interpreter, never by code evaluation.
* **Company framework per financial year:** standard version and entity size chosen for a financial year (audited; locked once the year's accounts are approved in V2-M6).
* **Computation:** from journal lines through the map (the M8 rule: no source-document tables), with comparatives, each line drilling to its accounts; validations evaluated and listed with pass or fail.

### DEC-054 - Golden trial balances
* A synthetic trial balance per scenario (micro-entity, small FRS 102 1A, a year with fixed assets and accruals) with its expected statements and notes written by hand first, kept in `tests/golden/` as data; tests compute and compare to the cent.
* The named accountant reviews the expected outputs before verifying the rule versions they exercise; until then the goldens prove the engine, not the standard.

### DEC-055 - How V2-M1 is built (delegated, DEC-019; recorded before code)
* **Totals:** a `TOTAL` line's formula is a JSON list of `{"line": "<key>", "sign": 1 | -1}`; it may reference any line of its version, never itself, and no cycle is allowed (checked when written and again at verification).
* **Line values:** an `ACCOUNTS` line is the sum of its accounts on its natural side (DEBIT: debits less credits; CREDIT: credits less debits); P&L lines cover the financial year, balance-sheet lines the balances at its end. `RETAINED_PROFIT` is the P&L of every year up to the year end (credit positive), until the V2-M3 closing journal exists. An income or expense account placed on a balance-sheet line, or the reverse, is reported as a placement error, not summed.
* **Exactly one line per account:** an active company override wins, else the map entry for (the account's V1 reporting line, its subtype), else the entry for the V1 line with no subtype. The database permits one active entry per (version, V1 line, subtype) and one active override per (company, version, account), so an account cannot be mapped twice; the preview lists unmapped and misplaced accounts and proves the result: the P&L lines plus the unplaced amounts equal the ledger's profit, and the balance sheet with the retained profit nets to zero.
* **Supersede:** only a VERIFIED version is superseded (an unverified one is edited). Superseding creates a new UNVERIFIED version that copies the old one's lines, map and rules, and marks the old one SUPERSEDED in the same transaction. A financial year cannot newly choose a superseded version; years already on it keep it and their previews say so.
* **Verification checks:** a version is verifiable only when it has lines, every map entry and override targets an `ACCOUNTS` line, every total and rule refers to lines of the version, parents exist on the same statement, and there are no cycles (service; the database re-checks the map targets and the line count).
* **Removal:** lines, map entries and rules are removed by a flag while their version is UNVERIFIED (the runtime role cannot delete); a removed key can be added again.
* **Framework year:** the version must be in effect on the year's start (`effective_from <= year start <= effective_to`); the year end may change while the year is unlocked, the start may not; years of a company do not overlap.
* **Comparative:** the prior financial year is the company's framework year ending the day before the year start, else the twelve months before it; it is computed on the current year's version.
* **Flag:** the V2 routes need `accounts.production` (default off) in addition to their permissions; screens (V2-M7) use the same flag.
* **Exactness:** rule constants and tolerances have at most 15 integer digits and 4 decimals (the ledger's scale), so every value stays within the 20 significant digits the decimal arithmetic keeps exactly (found by the grammar tests; recorded before the change).

### DEC-056 - V2 qualified accountant named (product owner, 2026-10-18)
* The product owner named **Shoaib** as the firm's qualified accountant for V2 (the open item of DEC-051). Professional body and membership number not yet recorded.
* Role: reviews the hand-written golden outputs (DEC-054; `v2-m1-golden-workings.xlsx`) and verifies standard versions entered from the current FRS 105 / FRS 102 texts and the Companies Act 2006 accounts regulations, through an account holding `accounts:rule-verify` (owner or admin by default, or a role the firm grants), never on a version Shoaib authored.
* **Naming verifies nothing:** every version stays UNVERIFIED, and every output a preview, until verified in the platform (DEC-052). DEC-051's text is kept as recorded; this entry closes its open item.

### DEC-057 - V2-M1 golden outputs reviewed (2026-10-18)
* Shoaib, the named accountant (DEC-056), reviewed the V2-M1 golden workings on 2026-10-18: the postings, both synthetic layouts, and the override, broken-map and earlier-year scenarios, all recomputed independently.
* This closes the review part of DEC-054 for this scenario only. It is not verification: the layouts are synthetic, and no FRS 105 or FRS 102 version exists in the system. V2-TEST-01 stays Partially until the later scenarios (V2-M2..M5) are reviewed as well.
* Note on segregation: Shoaib is both the product owner and the named accountant. The platform still requires that a version's verifier is not its author, so each real version must be entered by someone else.

### DEC-058 - How V2-M2 is built (delegated, DEC-019; recorded before code)
* **Classes:** per company, a code and name; the cost account (ASSET, FIXED_ASSET_TANGIBLE or FIXED_ASSET_INTANGIBLE); the accumulated depreciation account (ASSET, FIXED_ASSET_DEPRECIATION); the depreciation expense account (EXPENSE, DEPRECIATION); the disposal gain/loss account (INCOME or EXPENSE). All four are non-control accounts. A class also carries default method, life or rate, residual and convention for new assets.
* **Additions:** three kinds, each kept on the asset.
  * POSTED: the register posts Dr cost / Cr a non-control offset account (source FIXED_ASSET_ADDITION).
  * LINKED: the cost was already posted, for example by a supplier bill or a cash payment. The asset names that journal, which must debit the class cost account by at least the cost not yet registered against it. Nothing is posted.
  * TAKE_ON: an asset brought in with its accumulated depreciation at a take-on date. It may link the journal that carries the balances. Nothing is posted.
  Bank, cash and payables movements stay in their own modules.
* **Depreciation:** the methods are STRAIGHT_LINE (over a life in months) and REDUCING_BALANCE (an annual rate on the carrying amount at the start of each asset year, never below the residual value). There are two conventions:
  * DAILY: days in use, counted inclusively, over the days of the life or of the asset year.
  * MONTHLY: a full month in the month the asset comes into use, and none in the month of disposal.
  Every charge is the cumulative amount due at the date, rounded half-up to the penny, less what was charged before, so rounding never drifts and the residual value is reached exactly.
* **Changes of estimate are prospective (FRS 102 s.10):** a new basis starts the day after the last charged date. Its starting point is the carrying amount on that day, with the new method, remaining life or rate, and residual. Each basis is kept with its reason; history is never rewritten.
* **Runs:** one per company per as-at date, later than the previous live run, in an open period (source FIXED_ASSET_DEPRECIATION). Each run posts one journal with one Dr expense / Cr accumulated depreciation pair per class, and keeps one line per asset. A preview posts nothing. Only the latest live run is reversed, by its own mirror (FIXED_ASSET_DEPRECIATION_REVERSAL). Nothing else reverses or edits a run.
* **Disposals:** a full disposal on a date, with proceeds to a non-control account or nil. The disposal journal (FIXED_ASSET_DISPOSAL) does three things:
  1. Charges the depreciation catch-up to the disposal date.
  2. Removes the cost and accumulated depreciation, putting the carrying amount on the disposal account.
  3. Puts the proceeds on the disposal account.
  The gain or loss is the proceeds less the carrying amount. A disposal is reversed by its mirror (FIXED_ASSET_DISPOSAL_REVERSAL) only while no later run is live. A POSTED addition is reversed by its mirror (FIXED_ASSET_ADDITION_REVERSAL) only before any depreciation, which makes the asset VOID.
* **Journal sources:** all six are `subLedger`, so they are corrected in the register and never by a ledger REVERSAL. None touches a control account and none carries VAT.
* **Tax kept apart:** a tax category (AIA, MAIN_POOL, SPECIAL_RATE_POOL, SINGLE_ASSET_POOL, NOT_QUALIFYING, UNDECIDED) and an optional tax cost are stored on the asset for V4. Depreciation never reads them (architecture-tested), and changing them changes no figure.
* **Reconciliation:** per cost and accumulated-depreciation account, at a date, the register's amount against the ledger balance. Every journal on those accounts that is neither from the register nor linked to an asset is listed as a reconciling item.
* **Permissions:** new `assets:read` and `assets:manage`, both company-scoped. Owner, admin, partner, manager and accountant hold both; bookkeeper and reviewer hold `assets:read`. The routes sit behind `accounts.production`.
* **Not in V2-M2:** partial disposals, revaluation and impairment (FRS 102 options, never FRS 105), componentisation, capital allowances (V4), screens (V2-M7), and asset transfers between classes.

### DEC-059 - V2-M3 split; how V2-M3a is built (delegated, DEC-019; recorded before code)
* **Split:** V2-M3a covers the year-end adjustments. V2-M3b covers the year-end closing journal, because it touches V1's statements: every P&L figure (management P&L, statutory preview, FX report) must exclude closing journals, and balance sheets include them. Each half has its own acceptance package. The closing journal is in the approved plan (v2-proposal section 4) but had no matrix row; V2-YEC-01 is added to the matrix with a history entry.
* **Accruals and accrued income (ACCRUAL, ACCRUED_INCOME):** an amount at a date, normally a period end.
  * ACCRUAL posts Dr expense / Cr a non-control liability. ACCRUED_INCOME posts Dr a non-control asset / Cr income (source ACCRUAL).
  * The reversal dated the next day is posted at the same time (ACCRUAL_AUTO_REVERSAL), so the next day must fall in an existing open period.
  * A wrong accrual is cancelled by mirrors of both journals at their own dates (ACCRUAL_CANCELLATION).
  * Evidence documents are linked to the item.
* **Prepayments and deferred income (PREPAYMENT, DEFERRED_INCOME):** an amount released over a service period [start, end], straight line, DAILY (days in the period) or MONTHLY (months from the start month to the end month; a month counts once its last day is reached).
  * Set-up is either POSTED or LINKED:
    * POSTED reclassifies from the P&L account (ADJUSTMENT_SETUP): Dr prepayment / Cr expense, or Dr income / Cr deferred income.
    * LINKED names the journal that already put the amount on the balance account; it is never over-linked.
  * Releases are posted by release runs (ADJUSTMENT_RELEASE). Like depreciation runs, each run is later than every live run, only the latest is reversed by its mirror (ADJUSTMENT_RELEASE_REVERSAL), and each charge is the cumulative amount due less what was released, rounded half-up once.
  * A schedule nothing has been released from can be cancelled by the mirror of its set-up (ADJUSTMENT_SETUP_REVERSAL).
* **Provisions (FRS 102 s.21):** a provision names its liability account and its expense account (both non-control) and records its basis. Each movement is posted under PROVISION_MOVEMENT, with a reason:
  * MADE: Dr expense / Cr provision.
  * USED: Dr provision / Cr a non-control account (the expense the actual cost went to).
  * RELEASED: Dr provision / Cr expense.
  The balance never goes below zero. Only the latest live movement is reversed, by its mirror (PROVISION_MOVEMENT_REVERSAL). A movement report gives opening, made, used, released and closing for a date range.
* **Accounts:** the P&L side must be EXPENSE or INCOME as the kind requires; the balance side must be ASSET or LIABILITY as the kind requires. Never a control account, and never bank or cash.
* **Reconciliation:** per balance account at a date, the register (live items in effect at the date) is set against the ledger. Postings neither made nor linked by the register are listed as reconciling items.
* **Permissions:** writes need `accounts:prepare`, reads need `ledger:read`. No new permission. The routes sit behind `accounts.production`.
* **Sources:** all nine are `subLedger` (corrected only by their own mirrors), never touch a control account and carry no VAT. Each has its five posting-rule categories.
* **Not in V2-M3a:** accruals that do not auto-reverse; release by anything other than time (usage, milestones); discounting of provisions (FRS 102 s.21.7); contingent liabilities, which are a disclosure in V2-M5.


### DEC-060 - How V2-M3b is built: the year-end closing journal (delegated, DEC-019; recorded before code)
* **What it is:** for a financial year [start, end], one journal dated the year end (source YEAR_END_CLOSE) reverses each income and expense account's net balance over the year and puts the difference, the year's profit or loss, on the company's retained-earnings account (the RETAINED_EARNINGS control account; the source reaches no other control account). The lines run in account-code order; retained earnings comes last. A year whose income and expense accounts all net to zero is refused (`nothing_to_close`).
* **The year:** its start is the start date of an accounting period and its end the end date of one. The accounting periods in between cover it without a gap. It is at most 18 months long (Companies Act 2006 s.390-392 caps a financial year at 18 months). It does not overlap another live close. Earlier years are not closed automatically: the preview warns when income or expense was posted before the start and is not covered by a live close.
* **While it is live:**
  * No journal with an income or expense line dated in the year posts, except the close itself and its mirror (`year_closed`; it covers V2-M2/M3a postings and journal requests alike).
  * The PostingService takes a shared company lock for every journal with an income or expense line, and the close takes it exclusively. A posting either lands before the close reads balances or is refused after it. A database trigger on `journal_line` refuses the same thing again.
  * To change a closed year: reverse the close (mirror, YEAR_END_CLOSE_REVERSAL, dated the year end, reason required), post, then close again. Any live close may be reversed while its period is open. Closes are independent of each other.
* **Statements:**
  * Every P&L figure leaves out journals of both closing sources: the management P&L and its reconciliation to the ledger, the balance sheet's profit for the year to date and brought forward, the statutory preview (V2-M1), and the FX report's exchange differences.
  * The balance sheet's lines are computed without closing journals, so they are the same before and after a close. The amounts closed to retained earnings are shown inside the profit and loss reserve: brought forward plus the year to date.
  * The balance sheet's trial-balance proof uses the whole ledger, closing journals included. The balance sheet reports the amount transferred to retained earnings by live closes up to the date.
  * The trial balance and the general ledger show the ledger as it is, closes included. The general ledger takes `excludeClosing=true`, and every P&L drill-down carries it, so a drill-down adds up to the figure it came from.
  * This is how DEC-059's "balance sheets include them" is carried out. DEC-059 itself is not changed.
* **Data:** `year_end_close` records company, year start and end, retained-earnings account, journal, profit, status (POSTED, REVERSED), reversal journal, who, when and why. The facts never change; it moves POSTED -> REVERSED once and is never deleted; the database refuses an overlapping live close. The journal's lines are the record of what was closed.
* **Permissions:** writes need `accounts:prepare`, reads need `ledger:read`, behind `accounts.production`. Both sources are `subLedger` and carry no VAT; each has its five posting-rule categories.
* **Known limitation, unchanged from V1:** the balance sheet's "profit for the financial year to date" starts at the accounting period that contains the date. A company with monthly periods therefore sees the month to date. Using the reporting-framework year there is left to V2-M5.
* **Not in V2-M3b:** automatic closing when a period is locked; dividends and transfers between reserves, which belong in V2-M4/M5; tax on profit.

### DEC-061 - Golden outputs of V2-M2, V2-M3a and V2-M3b reviewed (2026-10-19)
* The product owner, who is Shoaib, the named accountant (DEC-056), answered "All verified" after receiving the V2-M3a and V2-M3b acceptance packages and golden workings. The V2-M2 package and workbook had been delivered earlier in the same exchange.
* This is recorded as the review of the synthetic golden figures in `v2-m2-golden-workings.xlsx`, `v2-m3a-golden-workings.xlsx` and `v2-m3b-golden-workings.xlsx`, as DEC-057 did for V2-M1.
* **What it does not do:** it verifies no reporting-standard version, map or rule. Under DEC-052 that is done in the platform, by a holder of `accounts:rule-verify` who did not author the content. No matrix row changes status because of this record.

### DEC-062 - How V2-M4 is built: director and shareholder loan accounts, related parties (delegated, DEC-019; recorded before code)
* **No new postings:** director loan movements already reach the ledger through V1 (cash transactions, bank, journals, documents). V2-M4 reads the ledger and adds registers and review flags. It adds no journal source and writes nothing to the ledger.
* **Loan accounts:**
  * Each person's account (`director_loan_account`) names the company, the person (a contact), a kind (DIRECTOR, SHAREHOLDER, DIRECTOR_AND_SHAREHOLDER), a dedicated ledger account, an opening date and notes.
  * The ledger account must be a non-control ASSET or LIABILITY account, and not bank or cash.
  * One live loan account per ledger account, and one per person per company.
  * A kind that includes DIRECTOR needs a DIRECTOR appointment of that contact in the company's officers (V0 master data).
  * The facts never change. The account moves ACTIVE -> CLOSED once, with a date and reason, and is never deleted.
* **Statement for a date range:** opening, every movement, and closing.
  * Sign: credit-positive. Positive means the company owes the person; negative means the account is overdrawn.
  * Each journal's movement is categorised by its other lines, ignoring VAT: CASH_AND_BANK, EXPENSES, INCOME, DIVIDENDS, OTHER_LOAN_ACCOUNT, or MIXED when they differ.
  * The day-end running balance gives the lowest balance, the first day it was reached, and the number of days overdrawn.
* **Review flags:** prompts for the reviewer, not legal conclusions.
  * OVERDRAWN_AT_END and OVERDRAWN_IN_PERIOD.
  * LARGE_MOVEMENT: a movement at or above the company's large-movement threshold.
  * OVERDRAWN_ABOVE_THRESHOLD: the lowest balance at or below minus the company's overdrawn threshold.
  * The thresholds are the firm's own review settings, stored per company as versioned rows. The latest row applies, and each row records who set it, when and why; none is ever edited.
  * A threshold that is not set is reported as "not evaluated", never as passed.
  * No legal value (for example the Companies Act 2006 s.207 amounts, or the CTA 2010 s.455 charge) is encoded. Those belong to the verified framework (DEC-052) and to V4 tax.
* **Related parties:**
  * The register (`related_party`) names the company, the counterparty (a contact), a relationship, a description, a from date and an optional to date. Relationships are: DIRECTOR, CLOSE_FAMILY_OF_DIRECTOR, SHAREHOLDER, ENTITY_CONTROLLED_BY_DIRECTOR, KEY_MANAGEMENT, PARENT, SUBSIDIARY, FELLOW_SUBSIDIARY, ASSOCIATE, JOINT_VENTURE, OTHER.
  * The facts never change; a party is ended once, with a reason. There is one live entry per counterparty and relationship.
* **Related-party year report:** for each party in the register during the range, everything is read from journal lines:
  * **Sales** (net, base currency): the non-control lines of the journals of the counterparty's posted sales invoices and credit notes dated in the range.
  * **Purchases:** the same, for purchase bills and debit notes.
  * **Cash paid to and received from:** the non-control lines of the counterparty's cash transactions and their reversals.
  * **Owed by and owed to at the end:** the trade-receivables and trade-payables lines of all the counterparty's sub-ledger journals (documents, receipts, payments, their reversals, and exchange differences on allocation) up to the end.
  * **Loan account:** its closing balance and lowest balance, where the counterparty has one.
  * Every figure lists the journals behind it for drill-down.
  * The report is the input for the related-party note (V2-M5). Choosing what to disclose is the framework's job, not this report's.
* **Permissions:** writes need `accounts:prepare`; reads need `ledger:read`. The routes sit behind `accounts.production`.
* **Not in V2-M4:**
  * disclosure wording and materiality (V2-M5);
  * the members' approval tracking of Companies Act 2006 ss.197-214;
  * s.455 and s.464C tax computations (V4);
  * related-party transactions made only by manual journal, which are listed for the counterparty only if posted through its sub-ledger, cash or loan account;
  * share registers and shareholdings.

### DEC-063 - V2-M5 split; how V2-M5a is built: the accounts document (delegated, DEC-019; recorded before code)
* **Split:**
  * V2-M5a renders the accounts document.
  * V2-M5b adds two things:
    * The size test. Its thresholds are company law, so they become verified data: a source, and a second person who is not the author.
    * The cash flow statement for full FRS 102.
  * Each half has its own acceptance package.
* **Wording is version content.** The disclosure rules of a standard version (V2-M1) gain a section, an order, a body template and an "omit when empty" flag:
  * The sections are POLICIES, NOTES, DIRECTORS_REPORT and BALANCE_SHEET_STATEMENTS.
  * The wording is verified with the version (DEC-052) and frozen with it.
  * A rule applies to the entity sizes it lists, against the size chosen for the year (V2-M1).
  * Nothing is seeded: the firm writes the wording, and Shoaib verifies it.
* **Templates:** a closed grammar, checked when written. There is no code, no HTML and no expressions; the output is text and tables, never markup. The placeholders are:
  * `{{line:KEY}}` and `{{line:KEY:prior}}`: a statutory line of the version, this year and the comparative.
  * `{{fact:KEY}}`: a scalar fact.
  * `{{table:KEY}}`: a table fact, on its own paragraph.
  * `{{company:name}}` and `{{company:number}}`.
  * `{{year:start}}`, `{{year:end}}` and `{{year:priorEnd}}`.
  * `{{standard:name}}` and `{{version:label}}`.
  * `{{directors:names}}`: the directors serving at any time in the year, from the officers in V0 master data.
* **Facts drawn from the platform:**
  * `fixedAssets.movements` (table), read from the ledger by fixed-asset class:
    * cost brought forward, additions, disposals and carried forward;
    * depreciation brought forward, charge, eliminated on disposals, other movements and carried forward;
    * net book value at both dates.
  * `provisions.movements` (table), from the V2-M3a register: opening, made, used, released and closing.
  * `directors.advances` (table), from the V2-M4 loan accounts of directors: opening, advanced, credited or repaid, closing, and the lowest balance.
  * `relatedParties.transactions` (table), from the V2-M4 report.
* **Facts the preparer enters:** one row per change for each framework year; the latest applies, and each row records who, when and why.
  * `employees.average` and `employees.averagePrior` (whole numbers).
  * `approval.date` (a date).
  * `approval.director` (a director of the company; rendered as the name).
  * `text.*`: free wording for the company, such as going concern, post-balance-sheet events, or the terms of advances to directors.
* **Missing facts:** a missing fact renders as `[missing: key]` and is listed as a problem. A document with any problem, or from an unverified version, is not complete.
* **Omit when empty:** a rule marked this way is left out when every table it uses has no rows and every line it uses is zero. The omission is listed.
* **Numbers in the wording:** two decimals with thousands separators, and a minus sign for negatives. The document states its currency.
* **Dates in the wording:** in full, for example 31 December 2026.
* **Tables:** keep a fixed set of columns per fact. The fixed-asset note runs down the page by item and across by class, with a total column.
* **Permissions:** the document needs `ledger:read`. Entering facts needs `accounts:prepare`. Rule wording needs `accounts:rules-manage`, and verification needs `accounts:rule-verify` (V2-M1). The routes sit behind `accounts.production`.
* **Not in V2-M5a:**
  * the size test and the cash flow statement (V2-M5b);
  * filing-ready output, approval and locking (V2-M6);
  * PDF or iXBRL rendering (V3);
  * any real standard wording (never seeded; DEC-052).

### DEC-064 - Draft wording packs written by engineering at the product owner's instruction (2026-10-19)
* **Instruction:** after V2-M5a was accepted, the product owner said "Well go add add wordings your self".
* **What engineering does:**
  * Drafts two packs as JSON in `content/standards/drafts/`: FRS 105 for micro-entities, and FRS 102 Section 1A for small entities.
  * Each pack holds:
    * the statement lines in the statutory formats;
    * the map from V1 reporting lines;
    * validation rules;
    * the wording (policies, notes, the directors' report and the balance-sheet statements) in the V2-M5a template grammar.
  * Each rule names the provision it is meant to reflect and carries a note for the verifier.
* **How the drafts were written:** from engineering's knowledge. The FRC's site and legislation.gov.uk could not be reached from the build environment, so no text was retrieved or copied. Every version says so in its notes, and its source records the drafting date rather than a retrieval date.
* **How a pack gets in:**
  * It is imported through the public API by `scripts/standards/import-pack.mjs`, as the person running it, who needs `accounts:rules-manage`.
  * It lands as an UNVERIFIED standard version.
  * Nothing loads it automatically. No migration seeds it, and engineering never verifies it.
* **Verification is unchanged (DEC-052):** Shoaib, or another holder of `accounts:rule-verify` who is not the author, checks each rule against the current FRS and Companies Act text, edits or removes what is wrong, and only then verifies. Until then every document from a pack is a preview marked unverified, and it is never complete.
* **Audit trail:** DEC-052 said no real standard content is entered or seeded. This decision amends that only by allowing these importable drafts in the repository. DEC-052 itself is not rewritten.
* **Not done:** FRS 102 in full (medium and large companies), charities (SORP), LLPs and groups.

### DEC-065 - Draft wording packs reviewed by the product owner (2026-10-20)
* **What happened:** after the DEC-064 packs and the wording review workbook were delivered, the product owner said "I have gone through documents / Now keep going".
* **What it is recorded as:** the product owner's read of the drafts. The workbook's Verdict column came back with nothing in it, so no rule is accepted, changed or rejected by this record.
* **What it is not:** verification. DEC-052 is unchanged. The packs become usable for filing-ready accounts only once they are imported and a holder of `accounts:rule-verify` who is not the importer verifies each version in the platform.

### DEC-066 - V2-M5b split again; how V2-M5b is built: the size test (delegated, DEC-019; recorded before code)
* **Split (amends DEC-063's split; DEC-063 is not rewritten):**
  * V2-M5b is the size test.
  * V2-M5c is the cash flow statement for full FRS 102. It gets its own specification before code.
  * Reason: each part is proven on its own golden scenario and accepted on its own evidence.
* **Thresholds are data, never code:**
  * A **threshold set** belongs to the organisation. It holds:
    * a label;
    * the financial years it governs, by the date a year begins (from, and optionally to, both inclusive);
    * the micro-entity, small and medium limits for turnover, balance-sheet total and average employees;
    * whether, for the first year it governs, the preceding year is also tested against it (a transitional rule; the verifier decides from the instrument);
    * a source (URL, provision, retrieval date), notes, its author, verifier and status.
  * Statuses and rules are the same as standard versions (DEC-052, DEC-055):
    * a set starts UNVERIFIED;
    * a holder of `accounts:rule-verify` who is not its author verifies it;
    * a verified set never changes and is replaced by superseding it;
    * the current sets of an organisation never overlap.
  * Limits are nested: micro, then small, then medium, for each measure.
  * Nothing is seeded. Engineering may draft an importable set under the DEC-064 pattern. It is never verified by engineering.
* **Figures of a framework year:**
  * **Turnover:** the amount on the turnover line of the year's standard version. A version names its turnover line, a P&L line, while it is unverified. The line is verified with the version and frozen after. Closing journals are left out, as on every P&L line (DEC-060).
  * **Balance-sheet total:** the sum of the year's balance-sheet accounts lines whose natural side is DEBIT, at the year end. These are the amounts shown as assets.
  * **Employees:** the year's `employees.average` fact (V2-M5a).
  * A year that is not twelve months has its turnover limit adjusted in proportion. The adjustment is by days, against the twelve months that begin on the year start. The comparison is exact, with no rounding.
* **Conditions:** a class's conditions are met when two or more of the three figures are not more than the limits.
  * A missing figure is unknown.
  * The result is decided only when two known figures settle it either way.
* **Two consecutive years, per class:**
  * When this year and the preceding year agree, this year's result is the status.
  * When they differ, the preceding year's status carries forward.
  * The preceding year's figures are tested against its own set, or against this year's set when this year's set says so for its first year.
  * When the preceding framework year exists on the platform, its figures and status are computed by the platform, recursively.
  * For the earliest framework year, the preparer states two facts:
    * `size.priorMet`: the smallest class whose conditions the preceding year met, or LARGE;
    * `size.priorStatus`: the smallest class it qualified as, or FIRST_YEAR when this is the company's first financial year (the status is then this year's result).
* **Result:**
  * the smallest class the company qualifies as (MICRO, SMALL or MEDIUM), else LARGE;
  * each figure, limit and condition, by class and year;
  * the basis of each status;
  * whether the entity size chosen for the year fits. It does not fit when the chosen size is smaller than the class the company qualifies as; choosing a larger size is allowed and said.
  * The result is `verified` only when every set used is verified.
  * Exclusions are not tested and are stated as a notice: public companies, banking, insurance and other excluded companies, micro-entity exclusions, and groups.
* **Not in V2-M5b:**
  * the cash flow statement (V2-M5c);
  * gating approval or filing on the size test (V2-M6 reads it);
  * groups, LLPs' separate regulations, and charities.

### DEC-067 - How V2-M5c is built: the cash flow statement (delegated, DEC-019; recorded before code)
* **Content is the version's, never code (DEC-052).** A standard version gains, all verified with it and frozen after:
  * **cash-flow classes:** a key, a section (OPERATING, INVESTING or FINANCING), an order and a caption.
    * An investing or financing class also has a caption for its non-cash part, shown among the operating adjustments.
    * It may also have separate inflow and outflow captions, to show gross receipts and payments.
  * **a cash-flow map:** a V1 reporting line, optionally narrowed by account subtype, maps to a class or to CASH. The most specific entry wins.
  * **the entity sizes** whose accounts include the statement, and its captions (profit, the three section totals, the net change, and opening and closing cash).
* **The figures (exact, from the ledger, closing journals left out):** for every account other than cash, its effect E is minus its net debit movement in the year.
  * Its cash part C is the same, taken only over journals with a line on a cash account.
  * Its non-cash part is N = E - C.
  * The change in cash always equals the sum of E over all accounts.
* **The statement (indirect method):**
  * **Profit line:** the E of the P&L accounts the map does not place.
  * **Operating section:**
    * the profit line;
    * for each investing or financing class, the sum of N (for example depreciation, against the fixed-asset class);
    * for each operating class, the sum of E (working capital, or tax paid when the tax charge and the tax creditor share a class).
  * **Investing and financing sections:** each class's C, gross by direction when the class asks for it.
  * **Net change in cash, opening and closing cash:** from the cash accounts.
  * **Proof:** the net change equals the cash accounts' movement. By the identity this holds whenever every account is placed; a balance-sheet account the map does not place goes to an "unclassified" line and is listed as a problem.
* **Comparative:** the preceding framework year, or the twelve months before, on the same version (as V2-M1).
* **Accounts document:** the statement joins the statements when the year's entity size is one the version lists. Its problems keep the document incomplete.
* **Not in V2-M5c:**
  * per-company cash-flow overrides (classification follows the V1 reporting line and subtype);
  * the direct method;
  * the notes on cash flows (analysis of net debt);
  * any real FRS 102 classification or caption (never seeded; the named accountant enters and verifies them).

### DEC-068 - V2-M6 split; how V2-M6a is built: review flags and the review checklist (delegated, DEC-019; recorded before code)
* **Split:** each part has its own specification before code and its own acceptance package.
  * **V2-M6a:** the review flags (V2-RC-01 to V2-RC-09) and the review checklist (V2-MOD-14).
  * **V2-M6b:** the 14-step year-end workflow, each step showing its status from the existing control (V2-MOD-01, V2-YE-01 to V2-YE-11).
  * **V2-M6c:** partner review, client approval, locking the year, and the filing-ready package (V2-MOD-15, V2-YE-12 to V2-YE-14), which is refused while anything it uses is unverified (V2-ARC-04).
* **Flags are computed, not stored.** Each time the checklist is read, the flags of a framework year are raised from the ledger (closing journals left out), the registers and the documents. Each flag has a stable key (control, subject, id) and its figures.
* **The nine controls:**

  | Control | Raised when |
  |---|---|
  | RC-01 Unexplained movements | A manual or control-adjustment journal in the year totals at least the setting |
  | RC-02 Material changes | A statutory line fed by accounts, or the retained profit, moves from the comparative by at least the amount setting and, when the comparative is not zero, by at least the percentage setting |
  | RC-03 Unusual balances | A P&L account's net for the year is on the wrong side (income in debit, expense in credit) |
  | RC-04 Negative balances | At the year end an asset account (other than accumulated depreciation) is in credit, or a liability account is in debit |
  | RC-05 Old receivables and payables | A customer or supplier has amounts overdue by more than the setting (30, 60 or 90 days) at the year end, from the V1 aged reports |
  | RC-06 Director loan movements | A director or shareholder loan account carries any V2-M4 flag for the year |
  | RC-07 Suspense | A suspense account has a balance at the year end |
  | RC-08 Unreconciled bank | An active bank account has no signed reconciliation at the year end, or one with a difference; or a bank ledger account with a balance has no bank account set up |
  | RC-09 Missing supporting evidence | A manual or control-adjustment journal, an approved purchase bill or a cash payment in the year of at least the setting has no live evidence link to a document |

* **Settings are the firm's, not law.** They are versioned per company, set with a reason by `accounts:prepare`:
  * the unexplained-movement amount;
  * the material-change amount and percentage;
  * the old-item days;
  * the evidence amount.

  A control whose setting is not set is reported as NOT_EVALUATED and is never treated as passed (as in DEC-062).
* **Responses are kept per flag, written once and never changed.**
  * **EXPLAIN:** a preparer, with `accounts:prepare`, explains the flag in a note.
  * **SIGN_OFF:** a reviewer accepts the explanation. The reviewer holds the new `accounts:review` permission and is not the person who explained it.
  * **REOPEN:** a reviewer, with `accounts:review`, sends a flag back.
  * Each response stores the flag's figures. An explanation or sign-off whose figures no longer match the flag lapses, and the flag is OPEN again and marked as changed.
  * The database repeats the second-person rule.
  * A flag that is no longer raised keeps its history, listed as resolved.
* **The checklist:** the nine controls, each CLEAR, OPEN, EXPLAINED, SIGNED_OFF or NOT_EVALUATED, with its flags, their figures, drill-down and responses. It is complete when every control is evaluated and every flag is signed off.
* **Permissions:**
  * `accounts:review` is new, held by owner, admin and partner.
  * Reading needs `ledger:read`.
  * The routes sit behind `accounts.production`.
* **Not in V2-M6a:**
  * the year-end steps (V2-M6b);
  * approval, locking and the package (V2-M6c);
  * per-account materiality;
  * analytical review beyond the comparative.

### DEC-069 - How V2-M6b is built: the 14-step year-end workflow (delegated, DEC-019; recorded before code)
* **Steps and their controls:** each control is READY, ATTENTION (with what needs doing) or NOT_APPLICABLE.

  | Step | Control |
  |---|---|
  | 1 Lock/confirm period | The year's accounting periods cover it without gaps; no draft sales or purchase documents and no pending journal requests are dated in it. The periods themselves are locked at approval (V2-M6c), because the year-end adjustments still post into them |
  | 2 Bank reconciliation | Review control RC-08 is CLEAR or SIGNED_OFF |
  | 3 Receivables review | The customer flags of RC-05 are none or all signed off, and RC-05 is evaluated |
  | 4 Payables review | The supplier flags of RC-05 are none or all signed off, and RC-05 is evaluated |
  | 5 Fixed asset review | The V2-M2 register reconciles to the ledger at the year end, and when any asset is active, a live depreciation run as at the year end exists |
  | 6 Accrual/prepayment review | The V2-M3a register reconciles to the ledger at the year end |
  | 7 Director balances | RC-06 is CLEAR or SIGNED_OFF |
  | 8 VAT reconciliation | NOT_APPLICABLE when the company is not VAT registered; otherwise the year's VAT workpaper reconciliation has no unexplained difference |
  | 9 Suspense clearance | RC-07 is CLEAR or SIGNED_OFF |
  | 10 Review adjustments | The review checklist (V2-M6a) is complete |
  | 11 Generate accounts | The accounts document is complete (V2-M5a) and the size test is verified and fits (V2-M5b) |
  | 12 to 14 | Partner review, client approval and the filing-ready package: V2-M6c |

* **Order:**
  * Step 1 comes first.
  * Steps 2 to 9 may be done in any order after it.
  * Step 10 needs steps 1 to 9.
  * Step 11 needs step 10.
  * Steps 12, 13 and 14 follow in order (V2-M6c).
* **Sign-off:** a preparer with `accounts:prepare` signs a step off with an optional note.
  * Only when its control is READY or NOT_APPLICABLE and every step it depends on is DONE.
  * The sign-off stores the control's status and summary.
  * A step is reopened with a reason.
  * Rows are written once. The database checks the step number, the year and the note on a reopen.
* **State of a step:**
  * LATER: steps 12 to 14 until V2-M6c;
  * DONE: signed off and its control still ready;
  * LAPSED: signed off, but its control is no longer ready;
  * BLOCKED: a step it depends on is not DONE;
  * TODO: its control is ready;
  * ATTENTION: otherwise.

  The current step is the first that is not DONE.
* **Second-person control stays where it already is:**
  * the review flags' sign-off (`accounts:review`, DEC-068);
  * the standard versions and thresholds (`accounts:rule-verify`, DEC-052);
  * partner review and client approval (V2-M6c).
* **Not in V2-M6b:** steps 12 to 14, locking, approval and the package (V2-M6c); screens (V2-M7).

### DEC-070 - How V2-M6c is built: partner review, client approval, locking and the filing-ready package (delegated, DEC-019; recorded before code)
* **The fingerprint:** the SHA-256 of the accounts document (V2-M5a) in canonical JSON (keys sorted), without its notices. It exists only while the document is complete. Any change to a figure, a fact, the wording, the company's name or number, or the directors changes it.
* **Partner review (step 12):**
  * Recorded by a holder of `accounts:review`, with an optional note, once step 11 is DONE.
  * The reviewer must not be the person whose live sign-off of step 11 generated the accounts (second person; service and database).
  * It stores the fingerprint. It is live while the fingerprint is unchanged; when the accounts change it LAPSES, and a new review is recorded.
* **Client approval (step 13):**
  * Recorded by a holder of `accounts:review` and `period:lock`, because it locks the periods.
  * It names the approving director, the approval date and an evidence document (the signed approval, uploaded to the company and scanned clean), with an optional note.
  * It is refused unless:
    * step 12 is DONE (a live partner review of the same fingerprint);
    * the director and date equal the facts `approval.director` and `approval.date`, which the accounts state (Companies Act 2006 s.414);
    * the date is after the year end and not in the future. It is not compared with the partner review's date: an approval that happened before the accounts reached the platform is recorded with both dates;
    * the director was serving on that date;
    * every accounting period of the year is CLOSED or LOCKED, because the close controls run when a period closes.
  * One per year.
* **Locking, in the same transaction as the approval:**
  * each CLOSED period of the year is locked through the period service, audited with the approval as its reason;
  * the year's reporting framework gets `locked_at`, which the database allows only when a client approval of that framework exists. A locked framework never changes (V2-M1).
* **After approval:**
  * a period of the year cannot be unlocked (service and database);
  * new accounts facts, review-flag responses, workflow sign-offs and approvals for the year are refused (`year_approved`; service and database);
  * postings into the year are refused because its periods are locked (V1).
  * Inputs outside the year's records (the company's name, its officers, the prior year's ledger) are not locked. A change to them changes the fingerprint, which shows steps 12 to 14 as LAPSED and refuses the package.
* **The filing-ready package (step 14):**
  * Generated once per year by a holder of `accounts:prepare`. It is stored write-once with its own SHA-256.
  * It holds:
    * the approved accounts document;
    * the fingerprint;
    * the framework: standard, version, and who verified it and when;
    * the size test and its threshold sets, with who verified them;
    * the partner review;
    * the client approval: the director's name, the date, the evidence document, who recorded it and when.
  * Refused (V2-ARC-04) unless:
    * the year is approved and the current fingerprint equals the approved one;
    * the accounts document is complete;
    * the standard version and every threshold set the size test uses were verified by a second person;
    * the size test is verified and fits.
  * The database refuses a package for a framework that is not locked, has no client approval of the same fingerprint, or whose version was never verified.
  * It is the platform's filing-ready output, **not a filing**: iXBRL tagging and submission to Companies House are V3.
* **Workflow:**
  * Steps 12 to 14 are no longer LATER, and the LATER state is removed.
  * Step 12 now depends on steps 1 to 11, not on step 11 alone as in DEC-069, so a lapse anywhere blocks the partner review. Steps 13 and 14 still follow in turn.
  * The V2-M6b golden is revised to match, and the revision is recorded in the golden file. Its acceptance evidence at 9868fbc stands as it was.
  * Each is DONE through its own record (the partner review, the client approval, the package) and is not signed off or reopened in the workflow (`step_own_record`).
  * Their controls:
    * 12: the document is complete and, once reviewed, unchanged since the review;
    * 13: the review is live, the periods are closed and the approval facts are set; once approved, the figures are unchanged since the approval;
    * 14: approved, unchanged since the approval and every rule verified; once generated, unchanged since the package.
* **Not in V2-M6c:**
  * withdrawing an approval and amended accounts (a later decision);
  * filing deadlines (Companies Act 2006 s.442), which are legal rules to be entered as verified data later;
  * iXBRL and filing (V3);
  * screens (V2-M7).

### DEC-071 - V2-M7 split; how V2-M7a is built: the year-end workspace screens (delegated, DEC-019; recorded before code)
* **Split:** V2-M7 covers every V2 module, so it is split into three slices, like V1-M9. Each slice is accepted on its own.
  * **V2-M7a, the year-end workspace:** the workflow, the review checklist, the accounts document and its facts, and the approval and package.
  * **V2-M7b, the registers:** fixed assets and depreciation, year-end adjustments and release runs, provisions, the closing journal, director loan accounts and related parties.
  * **V2-M7c, the reporting framework:** standards, versions and their content, verification, size-threshold sets, the framework of each year, overrides, the statutory preview and the cash flow statement.
* **Where the screens live:** in the company workspace, as an "Accounts production" navigation shown only when the `accounts.production` feature is on and the person holds `ledger:read`. With the feature off, a V2 page says so and calls no V2 route. The API stays the only enforcement.
* **What a screen does (DEC-048 applied to V2):**
  * it shows what the API returns: states, controls, figures, wording, problems and notices, with every PREVIEW ONLY notice on its face;
  * it computes no figure, state or fingerprint;
  * an action button shows only to a person holding the permission the route needs;
  * a refusal is shown in the API's words.
* **V2-M7a screens:**

  | Screen | What it shows and does | API routes |
  |---|---|---|
  | Year end | The years from the reporting frameworks; for the chosen year the 14 steps with control, state, dependencies and sign-offs, the current step and whether the year is locked. Steps 1 to 11 can be signed off or reopened; steps 12 to 14 link to Approval | `reporting-frameworks`, `year-end-workflow`, `year-end-workflow/sign-off`, `year-end-workflow/reopen` |
  | Review | The nine controls with status, flags, figures and responses, and the review settings. A flag can be explained (`accounts:prepare`), or signed off or reopened (`accounts:review`); the settings can be set | `review-checklist`, `review-flags/explain`, `review-flags/sign-off`, `review-flags/reopen`, `review-settings` |
  | Accounts | The accounts document: statements, sections, omitted items, problems and notices; the facts, which can be set; the size test result | `accounts-document`, `accounts-facts`, `size-test` |
  | Approval | Steps 12 to 14, the partner reviews (live or lapsed), the client approval and the package. Actions: record a partner review; record the client approval, choosing the director from the officers and the evidence from the company's documents; generate the package; view the package and save its JSON | `accounts-approval`, `accounts-approval/partner-review`, `accounts-approval/client-approval`, `accounts-package`, `officers`, `documents` |

* **Proof (DEC-050):** real-browser tests over the real stack, on synthetic books built through the API. They cover:
  * the main path from the workflow to the package;
  * a refusal shown in the API's words: the step-11 signer as partner reviewer;
  * a reader (the reviewer role) who sees the screens and no action button;
  * the feature switched off;
  * the web typecheck and production build in CI.

  The acceptance lists each screen with its routes.
* **Matrix:** V2-DOD-01 stays Missing until all three slices are accepted, and moves to Implemented with V2-M7c. Each slice records its screens against the row.
* **Not in V2-M7a:** the registers (V2-M7b); the reporting framework (V2-M7c); a rendered PDF or iXBRL of the accounts (V3).

### DEC-072 - Engineering's data check of V2, a review not a verification (2026-10-21)
* **Request:** on 2026-10-21 the product owner said "Check data yourself". Engineering checked the V2 data itself. The result is `docs/architecture/v2-data-check.xlsx`, written by `scripts/docs/gen_v2_data_check.py`, which re-runs every check and fails on any difference.
* **What was checked:**
  * **The goldens:** all 11 workbook generators were re-run. They cover 905 checks, with 0 differences.
  * **Invariants no author can bend:**
    * all 44 hand-written journals in the goldens balance;
    * the V2-M1 statements were recomputed line by line, as Excel formulas, in both layouts;
    * cross-checks: profit and net assets agree across the layouts, net assets equal capital and reserves, and the profit and loss reserve moves by the year's profit.
  * **The draft size thresholds:**
    * the nine 2025 and the nine 2016 limits;
    * the 6 April 2025 commencement with no early adoption;
    * the 2025 transitional rule;
    * two of the three conditions;
    * "not more than", and the code's comparison;
    * the turnover adjustment for a year that is not twelve months.

    These were checked against the ACCA, ICAEW and PwC summaries reachable through web search. legislation.gov.uk and the professional bodies' pages could not be fetched from the build environment.
  * **Every statutory or standard reference in the two wording packs**, with engineering's reading of each.
  * **All 610 evidence paths** named by the V1 and V2 matrices: all exist.
* **Findings:**
  * **F1, a finding:** NOTE.CREDLONG (FRS 102 1A pack) discloses creditors due after more than one year. The Sch 1 requirement it cites is debts payable after more than five years, and debts on which security is given.
  * **Items to check:**
    * **F2:** "(including directors)" in the employees note;
    * **F3:** the financial instruments policy asserts only basic instruments for every client;
    * **F4:** the citations for the micro-entity statement and the compliance statement;
    * **F5:** no wording for political donations and expenditure over £2,000 (Sch 7);
    * **F7:** the balance sheet total is right only if every asset line holds assets.
  * **F6, not confirmed:** the SI 2015/980 transitional treatment behind `priorYearOnFirst` on the 2016 set.
  * **F8, a limitation:** groups and LLPs are not modelled.
* **Status:**
  * this is a **review**: engineering wrote this data, so under DEC-052 it verifies nothing;
  * nothing in the platform changed;
  * the findings go to the named accountant (DEC-056);
  * content changes follow the DEC-064 pattern: a new draft, imported UNVERIFIED and verified by a second person;
  * no case law is relied on.

### DEC-073 - Draft wording packs 0.2: findings F1 to F3 of the data check reworded (2026-10-22)
* **Request:** after the data check (DEC-072), engineering offered to draft corrected wording for F1 to F3, and the product owner said "go".
* **Changes**, in `content/standards/drafts/`, each recorded in the pack's `revisions`:
  * **NOTE.CREDLONG** (FRS 102 1A, F1). The after-one-year line stays for context and so that the note is left out when there are no such creditors. Two disclosures are added, each from a new fact:
    * the debts payable after more than five years (`text.debtsAfterFiveYears`);
    * the debts on which security is given, with its nature (`text.securedDebts`).

    The source now names both requirements of SI 2008/409 Sch 1.
  * **NOTE.EMPLOYEES** (both packs, F2): "(including directors)" is removed. s.411 counts persons employed under contracts of service, so a director without one is not counted.
  * **POL.FININST** (FRS 102 1A, F3): the policy states how basic financial instruments are measured. The position on any other instruments comes from a new fact, `text.otherFinancialInstruments`, instead of asserting that every client has only basic instruments.
* **Status:**
  * both packs are labelled "engineering draft 0.2 (unverified)";
  * the text of 0.1 stays in git history;
  * nothing is imported or verified by this; the verifier checks the new wording and its citations like any other rule (DEC-052).
* **Open from DEC-072:**
  * F4: the citations for the micro-entity and compliance statements;
  * F5: political donations (Sch 7);
  * F6: the SI 2015/980 transitional rule;
  * F7: the balance sheet total and asset lines;
  * F8: groups and LLPs.
* **Evidence:**
  * `tests/api/standard-packs.test.ts` imports and renders both packs (5/5);
  * `docs/architecture/v2-draft-wording-review.xlsx` and `docs/architecture/v2-data-check.xlsx` are regenerated; F1 to F3 now show as DRAFTED.

### DEC-074 - How V2-M7b is built: the register screens (delegated, DEC-019; recorded before code)
* **Where:** a "Registers" section in the company workspace, shown only while `accounts.production` is on and the person holds `ledger:read` or `assets:read`. It has its own sub-navigation. With the feature off, the pages say so and call no V2 route (DEC-071).
* **Rules as in DEC-071:**
  * a screen shows what the API returns and computes no figure;
  * an action button shows only to a person holding the route's permission;
  * refusals are shown in the API's words;
  * a reversal or cancellation always asks for the reason the API requires.
* **Screens:**

  | Screen | Shows | Actions (permission) | API routes |
  |---|---|---|---|
  | Fixed assets | The register as at a date, with its reconciliation to the ledger; the classes; the assets with status | Create a class or change its defaults; add an asset, as POSTED, LINKED to an existing posting, or TAKEN_ON with accumulated depreciation (`assets:manage`) | `fixed-asset-register`, `fixed-asset-classes`, `fixed-assets` |
  | Asset | One asset: cost, schedule, events, tax fields | Change the estimate; change the tax fields; dispose; reverse a disposal or an addition (`assets:manage`) | `fixed-assets/{id}`, `/estimate`, `/tax`, `/dispose`, `/reverse-disposal`, `/reverse-addition` |
  | Depreciation | The runs; a preview as at a date; a run's lines | Post a run; reverse a run (`assets:manage`) | `depreciation-runs`, `/preview`, `/{id}`, `/{id}/reverse` |
  | Adjustments | Accruals, accrued income, prepayments and deferred income with status; the release runs and a preview; the year-end register as at a date | Create an item; cancel it; post or reverse a release run (`accounts:prepare`) | `year-end-items`, `/{id}/cancel`, `release-runs`, `/preview`, `/{id}/reverse`, `year-end-register` |
  | Provisions | The provisions with their movements; the report for a range | Create a provision; make, use or release (a movement); reverse a movement (`accounts:prepare`) | `provisions`, `/{id}`, `/{id}/movements`, `provision-movements/{id}/reverse`, `provisions/report` |
  | Closing journal | The year-end closes; a preview for a year | Post the close; reverse it (`accounts:prepare`) | `year-end-closes`, `/preview`, `/{id}/reverse` |
  | Directors | The loan accounts with flags; a statement for a range; the report; the thresholds | Open an account; close one; set the thresholds (`accounts:prepare`) | `director-loan-accounts`, `/report`, `/{id}/statement`, `/{id}/close`, `director-loan-thresholds` |
  | Related parties | The parties; the report for a range | Record a party; end one (`accounts:prepare`) | `related-parties`, `/report`, `/{id}/end` |

* **Proof (DEC-050):** real-browser tests over the real stack, on synthetic books built through the API. They cover:
  * a fixed-asset class and an asset added in the browser, depreciated by a run posted in the browser, with the register reconciled;
  * a prepayment created and released by a run;
  * a provision made and used;
  * the closing journal previewed and posted;
  * a director loan account opened with its statement;
  * a related party recorded with its report;
  * a refusal shown in the API's words: a disposal dated before the asset was acquired;
  * a reviewer who sees every register and no action button.
* **Matrix:** V2-DOD-01 stays Missing until V2-M7c (DEC-071).
* **Not in V2-M7b:** the reporting framework (V2-M7c); editing the tax fields beyond the API's own rules (capital allowances are V4).

### DEC-075 - The product owner's design stack installed in the repository (2026-10-25)
* **Request:** the product owner attached `CLAUDE-DESIGN-STACK.md` (their design and front-end stack) and the frontend-design `SKILL.md`. Asked what to do with them, they chose "Both": install the stack in this repository, then redesign the platform's screens with it (DEC-076).
* **Installed** with the file's own §3 commands, into `.claude/skills/`, committed so that every session on this repository has them:
  * **design-taste-frontend v2** (Leonxlnx/taste-skill). The repository now ships one consolidated skill; the 13 separate skills the file lists no longer exist there. `skills-lock.json` records its source and hash.
  * **frontend-design, senior-frontend and ui-design-system** (claude-code-templates). The installer could not reach the GitHub API from the build environment (HTTP 403), so the three skills were copied from a sparse git clone of the same repository. frontend-design is identical to the copy the owner uploaded.
  * **ui-ux-pro-max** (`uipro init --ai claude`).
* **Reviewed before commit:**
  * no hooks and no settings changes;
  * no credential-shaped strings;
  * the scripts are design tooling only: a browser inspector that drives a local Chrome, an image fetcher for public museum collections, and local search and generator scripts. Nothing reads credentials or sends data elsewhere.
* **Excluded from the platform's checks:** `.claude/**` is excluded from ESLint (`eslint.config.mjs`) and from CodeQL (`.github/codeql/codeql-config.yml`). The skill code is tooling for the assistant; it is never built or shipped with the app.
* **Not installed:**
  * **framer-motion and gsap:** the file says to install them only if they are used. The screens use motion only where a person's action needs it (DEC-076).
  * **The two MCP servers:** they are set up per machine, outside the repository. 21st.dev needs the owner's API key, and Higgsfield an interactive sign-in.
* **`CLAUDE.md`:** the owner's file, saved unchanged as the project's `CLAUDE.md`, with a section appended recording this installation. It also records that the project's own rules still govern screen work (DEC-048, DEC-050, DEC-071).
* **Restart:** skills load when a session starts, so they are active from the next session.

### DEC-076 - UI-1: the platform's visual system (delegated, DEC-019; recorded before code)
* **Why:** the product owner chose to redesign the screens with their design stack (DEC-075). The screens built in V1-M9 and V2-M7 share a 27-line stylesheet of browser defaults. UI-1 gives them one visual system without changing what any screen shows.
* **The plan:** `docs/design/visual-system.md`, written before code with the frontend-design skill's two passes (plan, then review against the brief) and the design-taste-frontend skill's app-screen run.
  * **The style:** Achromatic ledger (light), on an Open plane shell, dealt by the skill's own draw (seed 117641326), not chosen from habit.
  * **Tokens:**
    * ledger ground `#f2f4f7` and white sheets;
    * blue-black ink `#172231` and pencil `#566170`;
    * rules in three steps;
    * one signal blue `#1d5fbf`, on the main data element only;
    * red ink `#b3261e`, only for what is wrong;
    * settled green `#276b2b`;
    * pale status pills;
    * true-neutral dark mode.
  * **Contrast:** every text colour reaches 4.5:1 on each surface it sits on. `scripts/docs/check_contrast.py` checks all 37 pairs.
  * **Type:** Geist, bundled from the `geist` package (no request to Google); tabular figures on every amount. Geist Mono only for identifiers a person compares.
  * **Shell:** a 256px labelled sidebar on the ground holds the product's mark and name, the company and its currency, the sections in groups, and the person with Sign out. The canvas is fluid, with sheets that have a 1px edge, an 8px radius and no shadow.
  * **The memorable thing:** the accountant's ruled totals. A single ink rule sits above each total, and a double rule under a statement's final total.
  * **Removed tells:** the review against the brief replaced the sheet's `#0a0a0a` ink, the middle-dot sub-navigation and the default `#f8f8f8` ground (plan section 7).
* **What does not change:**
  * every figure, word, state, route, permission and action (DEC-048, DEC-071);
  * the accessible names and test ids.

  The CSS gains no utility framework, and no animation library is added.
* **Acceptance:**
  * the 32 existing e2e tests pass unchanged;
  * the web typecheck, lint and production build;
  * the contrast check passes;
  * screenshots of the main screens at 1440 and 390 wide, before and after, are taken with the real stack and kept in `docs/design/screens/`;
  * keyboard focus is visible, and reduced motion is respected;
  * CI green and a clean clone.

### DEC-077 - October 2026 dependency advisories (2026-10-25)
* **What happened:** before UI-1 was pushed, `pnpm audit --audit-level=high` (a CI gate) failed on advisories published after the last green run. None came from UI-1's one new package (`geist`, SIL Open Font Licence).
* **Updated:**
  * `next` 15.5.28, for a critical unauthenticated remote code execution in image optimisation and a denial of service through Server Actions;
  * `vitest` 4.1.12, which brings `@vitest/mocker` 4.1.12;
  * through `pnpm.overrides`, held to their current major versions: `body-parser` ^2.4.0, `multer` ^2.5.0, `undici` ^8.12.2 and `fast-uri` ^3.1.9.
* **Zod (GHSA-mrhx-c7xc-m3w5, high):**
  * **The advisory:** an array schema reports an issue for every failing element and never stops early, so a large array can exhaust memory. It is patched only in Zod 4.6.6.
  * **Our exposure:** the platform uses Zod 3 (3.25.76), whose arrays behave the same way. Measured: a 1 MB body of 500,000 bad items cost about 146 MB of heap and 0.4 s to refuse.
  * **The mitigation:** `ZodPipe`, through which every request body and query is validated, now refuses any array over 5,000 items before the schema runs. The refusal is a 422 `validation_error` naming the path.
  * **The test:** `tests/unit/request-arrays.test.ts` proves the guard on half a million items. It walks every exported contract schema (1,705 nodes) to show no limited array allows more than the guard. It also lists the one array with no limit of its own (`createRoleSchema.permissions`), so that list can only shrink.
  * **The audit:** the advisory is in `pnpm.auditConfig.ignoreGhsas`, pointing here.
  * **Not done:** moving to Zod 4 changes the validation layer of every route. It is not done here and is left as its own milestone.
* **Not changed:** API behaviour, except the new refusal; no schema, route or permission changes.

### DEC-078 - UI-1 build record (2026-10-25)
DEC-076 is unchanged. This records what building it refined; the detail is in `docs/design/visual-system.md` section 9.

* **The ruled total sits over the figures only.** A 1px ink rule runs above each total's amounts, and a 3px double rule runs under the final total's amounts on the statements and the trial balance. That is how signed accounts rule them. The first build ruled the whole row, where the grey row rule hid the ink.
* **The mark** is an "=" on an ink square: the two sides of the ledger in balance. A three-rule draft read as a menu button.
* **The sidebar's groups** are Books, Reports, Money and Accounts production, so no group shares a section's name.
* **Dark-mode pills** were added with the same rule as the light ones; the contrast check now has 41 pairs, all passing.
* **Phone tables:** a table of four or more columns keeps a minimum width and scrolls inside its sheet, and its first two columns stay on one line.
* **Chrome words.** No word, figure or state from the API changed. Three pieces of the platform's own chrome did:
  * the top bar's "Dashboard" link to the company list reads "Companies";
  * the workspace breadcrumb became the sidebar's company block: the name, "Base currency GBP" and "Change company";
  * the sub-navigation rows lost their middle dots.

  The middle dots inside data lines stay: they are what the screens say, and tests read them.
* **The quality floor test:** a new browser test, `tests/e2e/visual.test.ts`, checks:
  * visible focus;
  * reduced motion;
  * the sidebar outside `main`;
  * the current section marked;
  * no sideways scroll at 390px.

  The evidence is in `docs/design/ui-1-acceptance.md`.

### DEC-079 - The look: the design prototype is the reference (2026-10-27)
* **What the owner decided:** asked to choose between the look proposed in the AccLedger teardown blueprint (AccLedger's shadcn/ui screens) and the platform's own visual system, the product owner answered: "look should be just like the artifact created".
* **The artifact:**
  * a design canvas, "UK Practice Platform", with six screens: practice overview, clients, a client's workspace, the MTD VAT return, MTD Income Tax and the Company Tax Return;
  * standalone copies, with a README, are in `docs/design/prototype/`.
* **What it means:**
  * DEC-076 and DEC-078 stay as they are, because the prototype applies them: tokens, Geist, the 256px sidebar shell, sheets, tables, pills and the ruled totals;
  * screens built later (V4, V5, V7, V13) take their layout from the prototype;
  * the AccLedger/shadcn look is not adopted.
* **The sidebar groups** extend DEC-078:
  * at practice level: Practice, Tax and Firm;
  * at client level: Client, Books, Accounts production and Tax.
* **What does not follow the prototype:**
  * its sample figures and names: screens show what the API returns (DEC-048, DEC-071);
  * its Google Fonts link: the app keeps the bundled `geist` package;
  * its CT600 box numbers and HMRC wording, which stay UNVERIFIED (DEC-022).
* **Not changed:** no screen, route, permission or test.

### DEC-080 - Sage-style nominal codes: chart templates version 2 (2026-10-27)
* **What the owner decided:** asked whether to adopt the Sage-style nominal codes the blueprint recommends, the product owner answered "sage style".
* **The draft:** `docs/architecture/chart-templates-v2.xlsx`, written by `scripts/docs/gen_chart_templates_v2.py`. It has one template per business type:
  * limited company (109 accounts);
  * sole trader (103);
  * partnership (104);
  * landlord (36).

  Each account has its code, name, type, subtype, control, VAT treatment, reporting line, HMRC category and SA103F/SA105 box, with a column for the owner's verdict.
* **The codes:** four digits in the Sage 50 ranges:
  * fixed assets 0010-0099, current assets 1000-1999, liabilities 2000-2999, capital 3000-3999;
  * sales 4000-4999, purchases 5000-5999, direct expenses 6000-6999, overheads 7000-7999;
  * depreciation and other expenses 8000-8999, suspense 9000-9999.

  The platform keeps one VAT control account (2200), not Sage's three, because the VAT engine posts to one (M4b).
* **Rules for the build, after the owner's review:**
  * **Versions:** `DEFAULT_CHART_VERSION` 2, with the template chosen from the legal form when a chart is initialised. Version 1 stays for every existing company and for the V2 golden workings, which read it. A chart is never merged (`initialiseDefault` refuses a non-empty chart).
  * **New subtypes:** OWNER_CAPITAL, DRAWINGS, PARTNER_CAPITAL and PARTNER_CURRENT.
  * **New reporting lines:** BS.CAPITAL.PROPRIETOR and BS.CAPITAL.PARTNERS, as reporting-mapping version 2. The registry is versioned, so version 1 is never edited.
  * **HMRC category:** a new account attribute holding the self-employment or UK property category of HMRC's MTD APIs. V13 builds the quarterly updates from it. It is verified with `tax:rule-verify` before use.
  * **Legal forms:** a landlord needs a legal form the platform lacks (for example INDIVIDUAL). LLPs and charities need their own templates (members' interests, funds); they are not in this draft.
  * **Wording:** screens call these "UK standard nominal codes". "Sage" is a trade mark and is not used in the product.
* **Status:** every HMRC category and box reference is UNVERIFIED (DEC-022). Nothing is built until the owner has reviewed the workbook, as with the golden workings (DEC-057).

### DEC-081 - MTD Income Tax and Self Assessment: specification V13, built against HMRC's sandbox (2026-10-27)
* **Why:** the AccLedger blueprint review found that no specification (V0 to V12) covers MTD Income Tax or Self Assessment. Asked "whether to write its spec now and build it against HMRC's test environment", the product owner chose that option.
* **The specification:** `docs/specifications/V13_MTD_Income_Tax_Self_Assessment.md`, added to the manifest's roadmap and to the implementation order, after V5. Its milestones:
  * M0, the HMRC connection, shared with V5 and built once;
  * M1, the taxpayer and income sources;
  * M2, obligations and cumulative quarterly updates from the ledger;
  * M3, HMRC's calculation;
  * M4, end of year and the final declaration;
  * M5, the SA100 for clients outside MTD;
  * M6, screens following the prototype (DEC-079).
* **Rules:**
  * figures come only from journal lines, through each account's verified HMRC category (DEC-080);
  * every submission keeps a snapshot of its payload, hash, response and receipt, behind an idempotency key;
  * the client approves before the final declaration, which only a person with the main-agent authorisation submits; never AI or the system;
  * dates, thresholds and categories are UNVERIFIED data until verified with `tax:rule-verify`.
* **Sandbox only:**
  * production access is an explicit gate, like DEC-006;
  * the blueprint reports that HMRC has paused new production-access requests for MTD Income Tax software for 2026/27, which is UNVERIFIED;
  * the feature flag stays off.
* **Blocked on:**
  * a sandbox application on HMRC's Developer Hub, whose client id and secret go into the environment's secrets;
  * network access from the build environment to `test-api.service.hmrc.gov.uk`, which its network policy denies today.

  Until both exist, tests run against the fake adapter, and sandbox contract tests are reported as skipped, never as passed.

### DEC-082 - HMRC's test environment set aside (2026-10-27)
* **What the owner decided:** "ignore hmrc test environment", after DEC-081 recorded building V13 against HMRC's sandbox.
* **What changes:** this amends DEC-081; that entry stays as written.
  * V13 is built and accepted against the fake HMRC adapter only (the V0 port-and-adapter pattern);
  * no implementation that calls HMRC, sandbox or live, is written until the owner decides on HMRC access;
  * the two blockers recorded in DEC-081 (a Developer Hub sandbox application and network access to `test-api.service.hmrc.gov.uk`) are withdrawn;
  * no acceptance package may claim a test against HMRC.
* **What does not change:** the specification's scope, rules and controls; production access stays an explicit gate (DEC-006 pattern), and the feature flag stays off.
* **The specification** `docs/specifications/V13_MTD_Income_Tax_Self_Assessment.md` is updated to match.

### DEC-083 - Verification of the VAT rules and the accounting-standard versions directed (2026-10-27)
* **What the owner decided:** "approve", in answer to "verify the VAT rates and the FRS 105 / FRS 102 1A versions inside the platform".
* **What it means:** the work may start. It does not verify anything:
  * the platform ships no VAT rate (DEC-022); a firm enters its codes and rates, and a different person holding `tax:rule-verify` verifies each rate version (DEC-021);
  * the draft FRS 105 and FRS 102 Section 1A packs and the size thresholds (`content/standards/drafts/`) are imported UNVERIFIED and verified by a holder of `accounts:rule-verify` who did not import them (DEC-052);
  * the named verifier is Shoaib (DEC-056); neither engineering nor AI verifies.
* **What engineering supplies:** `docs/legal/rule-verification-worksheet.xlsx` (generator `scripts/docs/gen_rule_verification.py`), which lists:
  * the VAT codes and rates to enter, with their box mapping and the provision each must be checked against;
  * where the draft packs and thresholds are, how to import them and the review workbook that already covers them (`v2-draft-wording-review.xlsx`);
  * the steps in the platform.
* **Where:** verification needs a running platform, so it happens on staging (DEC-085).

### DEC-084 - Retention and privacy approved (2026-10-27)
Amends DEC-003. The owner approved the retention and privacy decisions and answered the four open questions of the schedule (section 4).
* **Periods:** every category in `docs/legal/retention-verification-schedule.md` is CONFIRMED at the period written there. The reviewer's questions in each row (clock-start events and the like) stay open in the schedule for the next review; confirming a period does not answer them.
* **Data held while active (WHILE_ACTIVE):** kept while the relationship is active and for 6 years after it ends (the Limitation Act 1980 s.5 period, as for engagement records). The category becomes a 6-year period from RELATIONSHIP_END.
* **Controller:** the accounting practice is the controller of its clients' data; the platform operator is its processor under a UK GDPR Art 28 contract. The practice sets any longer period its own obligations need.
* **IP address and user agent:** lawful basis legitimate interests (UK GDPR Art 6(1)(f)) for security and fraud prevention, with a documented balancing test, and minimised:
  * removed from audit rows after 12 months (the row itself is kept for its 7 years);
  * removed from sessions 90 days after they expire;
  * the login-challenge IP (`auth_challenge.ip`, never read) is no longer stored;
  * IP addresses in rate-limit keys are hashed, like the login-throttle keys.
* **S4(b) is unfrozen.** Purge jobs, the IP minimisation above and the erasure-versus-retention process (UK GDPR Art 17(3)(b); MLR 2017 reg 40) are built as milestone **PRIV-1**, with its own design recorded before code. The audit trail stays append-only: the only change PRIV-1 may make to an audit row is to clear the two personal fields, by a controlled, audited job.
* **Not changed by this entry:** no data is deleted today. The schedule's sources were not opened from the build environment, so its links remain the owner's to check.

### DEC-085 - Production gate approved: staging first, then live (2026-10-27)
Amends DEC-006 and DEC-014. The owner approved going live, choosing "approve; deploy staging".
* **Who deploys:** a person with access to the firm's AWS account applies the Terraform in `infra/terraform` (London, eu-west-2). This session has no AWS access, so nothing has been applied.
* **Staging:** synthetic data only. The rules are imported and verified there (DEC-083), and the main paths are smoke-tested against real AWS (S3 signatures, ClamAV, SES).
* **Production with real client data** starts only when all of these hold:
  1. staging is up and the smoke test passed;
  2. PRIV-1 is built and accepted (DEC-084);
  3. the VAT rates and standard versions a client needs are verified;
  4. an Art 28 processing agreement template exists for practices (DEC-084);
  5. backups, restore and the incident runbook are tested on staging.
* **DEC-014's synthetic-data rule** stays in force everywhere except production after go-live.

### DEC-086 - Build order: V7, then V5, then V3 and V4 (2026-10-27)
* **What the owner decided:** "build", after the order was given as the practice layer (V7) and the VAT return (V5), followed by V3 and V4.
* **V7 split** (`docs/architecture/v7-plan.md`), each milestone with its design recorded before code:
  * V7-M1 compliance calendar: obligations per client and their deadlines, with statuses;
  * V7-M2 practice dashboard and client list, following the prototype (DEC-079);
  * V7-M3 onboarding and anti-money-laundering checks;
  * V7-M4 client portal: requests, uploads, approvals, secure messages;
  * V7-M5 compliance health score and client communication.
* **V5:** the VAT return from the ledger, the review flags and the submission record. The HMRC connection is built against the fake adapter only, as DEC-082 does for V13: nothing calls HMRC until the owner decides on HMRC access.
* **Then** V3 (iXBRL, Companies House) and V4 (Corporation Tax).
* **PRIV-1** (DEC-084) is fitted in before production, whatever milestone is in progress.

### DEC-087 - Correction to DEC-080: VAT accounts in chart templates version 2 (2026-10-27)
* **The error:** DEC-080 said the platform keeps one VAT control account "because the VAT engine posts to one (M4b)". That is wrong. The VAT settings hold an output account and an input account (`outputAccountId`, `inputAccountId`); the posting service writes output VAT to the first and input VAT to the second, and they may be the same account or two.
* **The correction:** the draft templates use Sage's three VAT accounts:
  * 2200 sales tax control account, set as the output account (control kind VAT_CONTROL);
  * 2201 purchase tax control account, set as the input account (control kind VAT_CONTROL);
  * 2202 VAT liability, which takes the return's net amount when the return is filed and is cleared when it is paid (the filing journal is V5's).
* **Counts:** limited company 111 accounts, sole trader 105, partnership 106, landlord 38 (DEC-080 gave 109, 103, 104 and 36).
* `docs/architecture/chart-templates-v2.xlsx` is regenerated; DEC-080 is otherwise unchanged.

### DEC-088 - How V7-M1 is built: the compliance calendar (delegated, DEC-019; recorded before code)
The first V7 milestone (`docs/architecture/v7-plan.md`). It records what a practice must file or pay for each client and when, and who is doing it. It files nothing (DEC-082, DEC-086).
* **Deadline rules** (`deadline_rule`, organisation data, the DEC-021 pattern):
  * a rule names an obligation kind: ACCOUNTS_FILING, CT_PAYMENT, CT_RETURN, CONFIRMATION_STATEMENT or VAT_RETURN;
  * it names the legal forms it applies to, and the dates it governs (anchors from `effectiveFrom` to `effectiveTo`);
  * the due date is computed from the anchor in three steps: add `daysBeforeMonths` days; add `months` months; then add `daysAfterMonths` days. With `monthEndRule`, an anchor that falls on the last day of a month lands on the last day of the target month (Companies Act 2006 s.443);
  * every rule carries its source (URL, provision, date read), starts UNVERIFIED and is verified once by a holder of `compliance:rule-verify` who did not enter it; a change is a new version that supersedes the old one;
  * the database refuses overlapping current versions of the same kind for a shared legal form, and any edit other than verification once and supersession once;
  * engineering ships draft rules in `content/compliance/drafts/uk-deadline-rules.json`, imported by a person; no migration seeds a rule.
* **The anchors:**
  * ACCOUNTS_FILING, CT_PAYMENT and CT_RETURN run from the end of each accounting period of the client (`accounting_period`);
  * VAT_RETURN runs from the end of each VAT return period, taken from the VAT settings (stagger, period length, registration date);
  * CONFIRMATION_STATEMENT runs from the confirmation date held on the client's compliance profile, and each anniversary of it.
* **Obligations** (`compliance_obligation`, per client):
  * generated from a verified rule (source RULE, with the rule version) or entered by hand (source MANUAL); kind OTHER is for internal deadlines and needs a title;
  * generation is idempotent: one RULE obligation per client, kind and anchor date; it reports what it created, what already existed and what it skipped and why (no verified rule, or no anchor data);
  * statuses NOT_STARTED, IN_PROGRESS, WAITING_ON_CLIENT, READY, DONE and NOT_REQUIRED. DONE needs the date it was done and may carry a reference and an evidence document. NOT_REQUIRED, reopening DONE or NOT_REQUIRED, and moving a due date each need a reason;
  * an owner (a member of the organisation) may be set;
  * an obligation is never deleted; every change is audited with its before and after, and updates use an optimistic version;
  * overdue means the due date is before today and the status is neither DONE nor NOT_REQUIRED. It is computed by the API, never stored.
* **What a rule change does:** existing obligations keep their due date and the rule version they came from. Regenerating creates only what is missing.
* **Known limits, recorded rather than guessed:**
  * the first accounts of a new company (21 months from incorporation, s.442(3)) and accounting periods longer than 12 months for Corporation Tax are not derived: the preparer moves the due date, with a reason;
  * extensions granted by Companies House or HMRC are recorded the same way;
  * MTD Income Tax obligations wait for V13; PAYE is not in scope.
* **Practice-wide views:**
  * a list across the clients the caller may read with `compliance:read`, filtered by status, kind, client, owner and due window (overdue, next 14 days, next 90 days, all open);
  * counts of overdue, due in the next 14 days, waiting on the client and ready to submit, over the same clients;
  * a client the caller may not read is invisible, not counted.
* **Permissions (new):**
  * `compliance:read` and `compliance:manage`, company-scoped;
  * `compliance:rules-manage` and `compliance:rule-verify`, organisation-scoped;
  * system roles: owner and admin hold all four; partner, manager and accountant read and manage; bookkeeper and reviewer read; client viewer none (the client portal is V7-M4).
* **Feature flag:** `practice.management`, default off, gates every V7 route and screen.
* **Screens** (following the prototype, DEC-079):
  * a practice deadlines page with the four counts and the deadline list;
  * a client compliance page: its obligations, generation, updates and the confirmation date.
* **Retention:**
  * deadline rules: ACCOUNTING_RECORDS, as tax rates;
  * obligations: FILING_EVIDENCE;
  * the compliance profile: WHILE_ACTIVE.
* **Acceptance:**
  * unit tests of the due-date arithmetic, including month ends, leap years and the three-step order;
  * database tests of every guard;
  * API tests of the rule lifecycle, generation, updates, the practice views, permissions and tenancy;
  * a real-browser test (DEC-050);
  * the OpenAPI contract regenerated;
  * CI green.

### DEC-089 - How V7-M2 is built: the practice overview and the client list (delegated, DEC-019; recorded before code)
The second V7 milestone (`docs/architecture/v7-plan.md`). The screens follow the prototype (DEC-079) and show only what the API returns.
* **The practice shell:**
  * a sidebar like the client workspace's: the product's mark, the organisation, and the sections in groups;
  * the Practice group holds Overview, Clients and Deadlines; the person and Sign out stay at the bottom;
  * the overview, the client list and the V7-M1 deadlines page all use it, in place of the top bar.
* **The overview** (`/org/{org}/overview`):
  * the four V7-M1 counts;
  * the deadlines due soon (overdue and the next 14 days);
  * the open work by status and by kind, from a new count over the open obligations of the clients the caller may read;
  * the connections, stated as the decisions stand: no HMRC or Companies House connection is built (DEC-082, DEC-086).
* **Work in progress** (`GET compliance/work`): open obligations (neither DONE nor NOT_REQUIRED) counted by status and by kind, over the readable clients only. The year-end workflow's stage per client is not used here: computing every client's 14 controls on one page is too heavy, and the obligations already say where the work stands.
* **The client list** (`GET compliance/clients`, `/org/{org}/clients`). For each client the caller may read with `compliance:read`, it shows:
  * the name, company number, legal form and year end;
  * VAT registration and its period length;
  * the next open deadline, with its kind, due date and the API's overdue flag;
  * the open and overdue counts;
  * the client manager.

  The list is searchable by name and filtered by legal form and manager, with cursor pages by name. Services, the engagement and the anti-money-laundering status wait for V7-M3.
* **The client manager:** a new optional field on the compliance profile (`clientManagerUserId`), an active member of the organisation, set with `compliance:manage` and a reason, audited. The list names the manager by the member's display name.
* **Permissions:** no new permission. The new routes need `compliance:read`, and setting the manager needs `compliance:manage`.
* **Acceptance:**
  * API tests of the new counts, the list (visibility, search, filters, pages) and the manager;
  * a real-browser test of the overview, the client list and the shell, including a reader with no action;
  * the OpenAPI contract regenerated;
  * CI green.

### DEC-090 - How V5-M1 is built: the VAT return (delegated, DEC-019; recorded before code)
V5 follows V7-M1 and V7-M2 (DEC-086). `docs/architecture/v5-plan.md` splits it into three milestones:
* V5-M1 the VAT return: preparation, review flags, review and client approval, the period lock;
* V5-M2 the filing record: the HMRC port with a fake adapter only (DEC-082, DEC-086), the submission record, boxes 6 to 9 in whole pounds by a verified rule, the liability journal, the obligation marked done;
* V5-M3 the screens, following the prototype's VAT return (DEC-079).

**V5-M1** follows the accounts approval pattern (DEC-070):
* **The return** (`vat_return`): one per client and VAT period, the period taken from the VAT settings (`vatPeriodFor`). It is created by a person with `vat:prepare` (new), linked to the client's open VAT obligation for that period when there is one (V7-M1).
* **The fingerprint:** the SHA-256 of the M4b workpaper for the period in canonical JSON (keys sorted), without its notice. It covers the boxes, the lines each box drills to, the rule versions and the control-account reconciliation. It is computed live; any change of the ledger that touches the period changes it.
* **Events** (`vat_return_event`, append-only, each with the fingerprint it was made on):
  * PREPARED: a person with `vat:prepare` records that the return as it stands is prepared;
  * FLAG_EXPLAINED: a person with `vat:prepare` or `vat:review` explains one review flag;
  * REVIEWED: a person with `vat:review` (new), who is not the person of the live PREPARED event, records the review;
  * CLIENT_APPROVED: a person with `vat:review` and `period:lock` records the client's approval, naming the client's contact, the approval date and an evidence document (readable, of the same client, scanned clean).
* **Review flags**, computed live from the workpaper. Each has a stable key, and review is refused while a flag has no explanation:
  * `reconciliation_difference`: the control-account difference is not zero (the explained entries are listed with it);
  * `superseded_rate:{rateId}`: a VAT line used a rate version that has since been superseded;
  * `repayment`: box 4 is greater than box 1 plus box 2 (a repayment return);
  * `zero_return`: every box is zero;
  * `late_posting:{journalId}:{lineNo}`: a VAT line with a tax point in the period on a journal dated after the period's end.
* **Status, derived and not stored:**
  * DRAFT: no live PREPARED event;
  * PREPARED: the latest PREPARED event has the live fingerprint;
  * REVIEWED: a REVIEWED event has the live fingerprint and follows it;
  * APPROVED: the return is locked.

  A PREPARED or REVIEWED event whose fingerprint no longer matches has lapsed. It is kept and shown as lapsed.
* **Approval freezes and locks:**
  * client approval needs a live review and no unexplained flag;
  * it stores the workpaper as approved (content and SHA-256) on the return and sets the lock, written once;
  * from then on the database refuses any journal line with a tax point inside the locked period for that client (`vat_period_locked`). A correction goes into a later return, as HMRC's error-correction rules expect;
  * the linked obligation moves to READY with an audited, versioned update.
* **Boxes 6 to 9:** M1 stores and approves the exact amounts. Whole-pound presentation is applied when the filing record is built (V5-M2), by a verified rule, from the approved amounts. No rounding figure is built in (DEC-021).
* **Permissions and the flag:**
  * `vat:prepare` and `vat:review` (company), granted as `accounts:prepare` and `accounts:review` are;
  * the routes sit behind the new feature flag `vat.returns`.
* **Records:**
  * the two new tables are classified (RLS+APP), with no DELETE or TRUNCATE;
  * identity and lock fields are guarded;
  * retention is ACCOUNTING_RECORDS (6 years from the end of the period, DEC-084);
  * every event is audited.
* **Not in M1:** filing, payment, the liability journal, the screens, partial exemption, the flat-rate and cash schemes (not implemented in M4b) and the input-to-output threshold the firm would set.
* **Acceptance:**
  * golden workings for a synthetic quarter (a workbook with each box traced to its lines), for review by the named accountant (the DEC-054 pattern);
  * API and database tests of every rule above;
  * the OpenAPI contract;
  * CI green.

### DEC-091 - How V5-M2 is built: the VAT filing record (delegated, DEC-019; recorded before code)
The second V5 milestone (`docs/architecture/v5-plan.md`). There is no HMRC connection (DEC-082, DEC-086). The platform therefore records filings made elsewhere, and it simulates its own submission only through a fake adapter.
* **The presentation rule** (`vat_presentation_rule`, organisation data like a VAT rate version, DEC-021):
  * it states how boxes 6 to 9 are presented: `TRUNCATE_PENCE` (whole pounds, pence left out) or `ROUND_TO_POUND` (half up);
  * it carries its dates and its source;
  * it is entered with `vat:manage`, starts UNVERIFIED, is verified once by a different person with `tax:rule-verify`, and is superseded by a new version;
  * no rule is seeded. The draft is added to the verifier's worksheet with HMRC's guidance to check against.
* **The filing package:**
  * built from the approved return only (DEC-090);
  * boxes 1 to 5 in pounds and pence, exactly as approved; boxes 6 to 9 by the verified rule whose dates cover the period end. Without one, the package is refused (`presentation_rule_unverified`);
  * it names the VRN and the period, and records its SHA-256 and the rule version used.
* **Recording a filing made outside the platform** (`vat:file`, new; granted to owner, admin and partner):
  * the person gives the submission date (not before the approval, not in the future) and HMRC's receipt reference (the form bundle number, 12 digits);
  * they also give an evidence document of the client, readable and scanned clean (HMRC's receipt), and confirm the declaration that the return was submitted as approved;
  * one recorded filing per return;
  * in the same transaction:
    * the liability journal is posted (new source `VAT_RETURN`, dated the period end): Dr the output VAT account with box 3, Cr the input VAT account with box 4, and Cr (payable) or Dr (repayable) the VAT liability account with box 5. Zero lines are left out;
    * the client's VAT obligation becomes DONE, with the submission date, the receipt reference and the evidence (a versioned, audited update).
* **The VAT liability account:** a new optional field of the VAT settings, `liabilityAccountId`. It must be an active balance-sheet account, other than the output and input accounts. Recording a filing without it is refused (`liability_account_missing`).
* **Simulated submission:**
  * goes through the HMRC VAT port (`packages/adapters`), whose only adapter is `fake`; it returns a receipt marked FAKE;
  * the driver is set by `HMRC_VAT_ADAPTER` (`none` by default; production refuses `fake` at start);
  * it is stored as a SIMULATED filing with its receipt, and posts nothing and changes no obligation;
  * with the driver `none` the route answers `filing_not_available`.
* **Records:**
  * `vat_filing` is append-only; it is classified (RLS+APP), with retention FILING_EVIDENCE;
  * every step is audited.
* **Not in M2:** a real HMRC adapter (the HMRC test environment is ignored, DEC-082) and fraud-prevention headers; the VAT payment or repayment through the bank; the screens (V5-M3).
* **Acceptance:**
  * API and database tests of every rule above, including the journal and the obligation;
  * the golden workings extended with the package and the journal;
  * the OpenAPI contract;
  * CI green.

### DEC-092 - How V5-M3 is built: the VAT return screens (delegated, DEC-019; recorded before code)
The third V5 milestone. The screens follow the prototype's VAT return (DEC-079, `docs/design/prototype/VatReturn.html`) and show only what the API returns (DEC-048, DEC-071).
* **Where:**
  * a "Tax" group in the client workspace sidebar, with "VAT returns" (`ledger:read`, feature `vat.returns`);
  * the list at `/org/{org}/companies/{company}/vat-returns`;
  * a return at `/org/{org}/companies/{company}/vat-returns/{id}`.
* **The list:**
  * each return's period, status, unexplained flags and whether it is locked;
  * "Open the return for a period", with a date, for `vat:prepare`.
* **The return screen,** laid out as the prototype:
  * the nine boxes with their descriptions; each box opens to its lines (journal number, line, account, code, tax point, amount);
  * once a filing package exists, boxes 6 to 9 are also shown in whole pounds as the package states them;
  * "Checks against the ledger": the control-account reconciliation and the entries that explain it;
  * the review flags, with an explanation form for `vat:prepare` or `vat:review`;
  * "Sign-off": prepared, reviewed and approved, each with the person's name and date, and marked "lapsed" when the API says so;
  * actions offered by permission:
    * Prepare (`vat:prepare`);
    * Review (`vat:review`);
    * the client's approval with the client's contact, the date and the evidence document (`vat:review` and `period:lock`);
    * once approved, recording a filing made outside the platform, with the declaration text of the prototype (`vat:file`);
  * the filings, with their receipts. A simulated one is marked "Simulated: nothing was sent to HMRC".
  * There is no "Submit to HMRC" button: the platform does not submit (DEC-082, DEC-086). A simulated submission stays an API route for testing the seam; the screen does not offer it.
* **API addition:** each event of a return carries `byName`, the person's display name, so the screen computes nothing.
* **Acceptance:**
  * real-browser tests of the main path across people (prepare, explain, review, approve, record), a refusal in the API's words, a reader with no action, and the feature switched off;
  * the OpenAPI contract;
  * CI green.

### DEC-093 - V3 plan and how V3-M1 is built: the taxonomy and its mapping (delegated, DEC-019; recorded before code)
V3 follows V5 (DEC-086). `docs/architecture/v3-plan.md` splits it into four milestones:
* V3-M1 the taxonomy and mapping;
* V3-M2 the iXBRL document and its validation;
* V3-M3 the Companies House workflow, with a fake adapter only, as for HMRC (DEC-082);
* V3-M4 the screens.

**V3-M1:**
* **Taxonomy versions** (`xbrl_taxonomy_version`, organisation data):
  * each has a label (for example "FRC 2025 FRS 105"), the reporting standard it tags (FRS105 or FRS102), the entry point (schema reference) and the namespace of each prefix it uses;
  * it has the dates it is effective for and its source (link, reference, date read);
  * a version is UNVERIFIED while its entries are edited; a person with `ixbrl:rule-verify` (new) who did not create it verifies it, which freezes it; a change is a new version that supersedes it (the V2-M1 pattern, DEC-051).
* **Concept map entries** (`xbrl_concept_map`, in a taxonomy version), one per source:
  * the source is a statutory line key (current and prior year use the same concept in different contexts), a preparer's fact key, or a company detail. The company details are name, number, the period start and end, the balance sheet date, the directors and the approving director;
  * each entry gives the concept (a prefix the version declares and a local name), its data type (MONETARY, TEXT, DATE), its period type (INSTANT or DURATION), whether the line's natural amount is negated, the decimals and any dimensions (axis and member, each a declared prefix);
  * an entry may be marked mandatory, which V3-M2 checks;
  * entries change only while the version is UNVERIFIED (database guard).
* **Draft pack:**
  * `content/ixbrl/drafts/frc-frs105.json` maps the FRS 105 micro-entity pack's lines and the company details to FRC taxonomy concepts;
  * it is written without reading the taxonomy, so every concept is a proposal for the verifier to check against the FRC taxonomy files;
  * it is imported with `scripts/ixbrl/import-taxonomy.mjs` and lands UNVERIFIED. The verifier's worksheet gets a sheet for it.
* **Permissions:** `ixbrl:rules-manage` (create versions and edit entries) and `ixbrl:rule-verify`, organisation scope, granted to owner and admin as the standards permissions are.
* **The flag** `ixbrl.filing` gates the routes.
* **Records:** both tables are classified (RLS+APP), with no DELETE or TRUNCATE (entries of an UNVERIFIED version may be removed through the service, by a guarded delete); retention ACCOUNTING_RECORDS; every change is audited.
* **Acceptance:**
  * API and database tests (versions, entries, verification by a second person, the freeze, supersession by copy, the import);
  * the OpenAPI contract;
  * CI green.

### DEC-094 - How V3-M2 is built: the iXBRL document and its validation (delegated, DEC-019; recorded before code)
The second V3 milestone (`docs/architecture/v3-plan.md`). It reads the approved accounts package (DEC-070) and the verified mapping (DEC-093), and it changes no accounting record.
* **Which mapping:** the VERIFIED taxonomy version whose standard is the package's and whose dates cover the year end. It is refused when there is none (`taxonomy_unverified`) or more than one (`taxonomy_ambiguous`).
* **The entity identifier scheme** becomes data of the taxonomy version (a new column, `entity_scheme`, edited while UNVERIFIED). A version without it cannot generate (`entity_scheme_missing`); a verified one is superseded to add it.
* **Facts:**
  * a statutory line gives a fact for the year (its amount) and, when the package has a comparative, one for the prior year;
  * the prior period starts at the start of the company's previous reporting-framework year, and comparatives are left out (with a warning) when there is no such year;
  * a DURATION concept takes the period's context and an INSTANT one its end;
  * an amount is the package's on the line's natural side, negated when the entry says so, with the entry's decimals, in the package currency's ISO 4217 unit;
  * a line with no amount gives no fact;
  * the company details come from the package; a preparer's fact comes from the year's facts (the year is locked once approved);
  * dimensions become explicit members in the context.
* **Contexts and units** are generated once per distinct period and dimension set, and once per currency.
* **The document:**
  * an XHTML file with the inline XBRL header: the schema reference to the version's entry point, the contexts and units, and the hidden facts;
  * the body shows the company, the year, the statements with each amount tagged (a negative amount is shown without its sign and tagged with `sign="-"`) and the accounts' text sections untagged;
  * the namespaces of the inline XBRL specification are fixed; those of the taxonomy come only from the version.
* **Checks,** stored with the document:
  * errors: a mandatory entry with no value; the package's balance sheet not balanced; a context with its start after its end; two facts of the same concept and context with different values; a fact whose context or unit is missing;
  * warnings: a line with an amount that no entry maps; comparatives left out.

  A document with an error is INVALID; otherwise it is VALID. Full schema and taxonomy validation, with the FRC taxonomy files and an external validator, is not run in the platform: it is a go-live step (DEC-085).
* **Storage** (`ixbrl_document`, append-only):
  * the package, the taxonomy version, the content, its SHA-256, the counts of facts and contexts, the errors and warnings, the status, who generated it and when;
  * generating again makes a new document. The latest is the current one, and the same content gives the same SHA-256.
* **Permissions:** generating needs `accounts:prepare`; reading needs `ledger:read`. The routes sit behind `ixbrl.filing`.
* **Acceptance:**
  * API tests of a synthetic approved year through generation, the facts and contexts in the document, each check, and the SHA-256;
  * golden workings of the tagged figures;
  * the OpenAPI contract;
  * CI green.

### DEC-095 - How V3-M3 is built: the Companies House filing workflow (delegated, DEC-019; recorded before code)
The third V3 milestone (`docs/architecture/v3-plan.md`). There is no Companies House connection (as for HMRC, DEC-082, DEC-086).
* **The filing** (`ch_filing`): one company's filing of one iXBRL document (DEC-094). Its status moves only along the specification's path, and the database guards each move:
  * DRAFT: created from a document by a person with `ixbrl:file` (new);
  * VALIDATED: the document is VALID, it is the latest document of its package, the package is still the year's, and the company has a registered number;
  * AUTHORISED: a person with `ixbrl:file` records the explicit authority to file. It names the director who authorised (a serving director on the date), the date (not in the future) and an evidence document of the company scanned clean. That person is not the one who validated (second person);
  * SUBMITTED: submitted through the Companies House port, with an idempotency key (the filing's id), the document's SHA-256 as the payload hash, and the adapter's submission id;
  * ACCEPTED or REJECTED: the adapter's answer, read when a person asks for the status (no automatic polling in V3);
  * or ACCEPTED directly from VALIDATED or AUTHORISED, when a filing made elsewhere is recorded with its Companies House reference, its acceptance date and the acceptance as evidence (mode RECORDED).
* **No automatic submission:** a submission needs AUTHORISED and a person's request. A retry of a submission with the same idempotency key returns the same submission, and a REJECTED filing is final: a new filing is made after the cause is fixed.
* **Evidence** (`ch_filing_event`, append-only): one event per move, with the actor, the time, the payload hash, the adapter's request and response (JSON), the submission id and any reason. The filing row holds the current status and its key facts. Only a move may change it (database guard), and it is never deleted.
* **The Companies House port** (`packages/adapters`): the only adapter is `fake`. It accepts any submission, except that a company number starting `99` is rejected, so rejection can be tested. The driver is `CH_ADAPTER` (`none` by default, and production refuses `fake` at start); with `none`, submission answers `filing_not_available`.
* **On ACCEPTED** the client's accounts-filing obligation for the year end (V7-M1) becomes DONE, with the acceptance date, the Companies House reference and the evidence (a versioned, audited update).
* **Permissions and the flag:**
  * `ixbrl:file` (company), granted to owner, admin and partner;
  * reading needs `ledger:read`;
  * the routes sit behind `ixbrl.filing`.
* **Records:** both tables are classified (RLS+APP) with retention FILING_EVIDENCE; filings have no DELETE or TRUNCATE, and events no UPDATE, DELETE or TRUNCATE.
* **Acceptance:**
  * API and database tests of every move and refusal (including the second-person authority, idempotent retry, rejection and the recorded filing) and of the obligation;
  * the OpenAPI contract;
  * CI green.

### DEC-096 - How V3-M4 is built: the iXBRL and filing screens (delegated, DEC-019; recorded before code)
The fourth V3 milestone. The screens show what the API returns and compute nothing (DEC-048, DEC-071). They follow the visual system of the prototype (DEC-079), which has no iXBRL screen of its own.
* **Accounts filing** (client workspace, Accounts production group, `ledger:read`, feature `ixbrl.filing`, at `/org/{org}/companies/{company}/filing`):
  * the year, chosen from the company's reporting-framework years;
  * the year's iXBRL documents, latest first: status, SHA-256, counts, errors and warnings, and a link that opens the document itself;
  * "Generate the iXBRL document" for `accounts:prepare`, with the API's refusal shown when the year has no approved package or no verified mapping;
  * the Companies House filing of a document, as the path DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED or REJECTED with the current step marked, and each move with who did it and when. Actions are offered by status and `ixbrl:file`:
    * start a filing (on a VALID document);
    * validate;
    * record the authority (a director from the company's officers, the date, an evidence document);
    * submit;
    * read the status;
    * record a filing made elsewhere (the reference, the date, the evidence);
  * the API's notice says that the connection is a fake and nothing reaches Companies House.
* **Taxonomy mapping** (practice shell, at `/org/{org}/taxonomy`):
  * the versions with their standard, dates and status;
  * a version's entry point, scheme, namespaces, entries and problems;
  * "Verify this version" for a holder of `ixbrl:rule-verify` (from the organisation's `me`) with notes; the API refuses the creator.
  * Entries are entered with the import tool or the API in V3. The page reads them and does not edit them.
* **Acceptance:**
  * real-browser tests of the main path across people (generate, start, validate, authorise, submit, read the status), a refusal in the API's words, a reader with no action, and the mapping page's verification;
  * CI green.

### DEC-097 - V4 plan and how V4-M1 is built: Corporation Tax rules, tax periods and the tax profile (delegated, DEC-019; recorded before code)
V4 follows V3 (DEC-086). `docs/architecture/v4-plan.md` splits it into six milestones:
* V4-M1 the rules, the tax periods and the tax profile;
* V4-M2 the tax adjustments and taxable profit;
* V4-M3 capital allowances;
* V4-M4 losses, the computation and the canonical CT600;
* V4-M5 CT iXBRL and the HMRC submission (fake adapter only, DEC-082);
* V4-M6 the screens.

**V4-M1:**
* **Corporation Tax rules** (`ct_rule`, organisation data, jurisdiction UK). A rule version has:
  * a kind;
  * the dates it is effective for (financial years run 1 April to 31 March);
  * its parameters, checked by kind in `@uk/contracts`;
  * its source (link, provision, date read).

  It starts UNVERIFIED. It is verified once by a holder of `tax:rule-verify` who did not enter it, and it is superseded by a new version. Two current versions of one kind may not overlap (database guard). The kinds in M1:
  * `CT_RATES`: the main rate and the small profits rate (percentages), the lower and upper limits, and the marginal relief fraction (numerator and denominator);
  * `PERIOD_MAX_MONTHS`: the longest a CT accounting period may run.
  Later milestones add their kinds (capital allowances in V4-M3, losses in V4-M4).
* **The draft pack** `content/tax/drafts/uk-ct-rules.json` lands UNVERIFIED through `scripts/tax/import-ct-rules.mjs`, with a note for the verifier on each rule; the verifier's worksheet gets a sheet for it. It holds:
  * the rates and limits from financial year 2023, with their provisions;
  * the 12-month maximum, with its provision.

  Nothing is seeded.
* **The tax profile** (`company_tax_profile`): the company's Unique Taxpayer Reference (10 digits, format-checked only), set with `ct:prepare` (new) and a reason, audited.
* **Tax periods** (`ct_period`):
  * derived from a reporting-framework year by a holder of `ct:prepare`, as one period or, when the year is longer than the verified maximum, as consecutive periods of at most that many months (the first starting on the year's start);
  * deriving is refused while the maximum rule for the year's start is not verified (`ct_rule_unverified`), and it is idempotent;
  * each period records the rule version used and its associated companies (0 or more), set with a reason;
  * a period's dates never change, and it is never deleted.
* **Permissions:**
  * `ct:manage` (enter and supersede CT rules) and `ct:prepare`, both company scope, granted to owner, admin, partner and accountant;
  * verification uses the existing `tax:rule-verify`.
* **The flag** `corporation.tax` gates the routes.
* **Records:**
  * the three tables are classified (RLS+APP), with no DELETE or TRUNCATE;
  * retention: ACCOUNTING_RECORDS for the rules and the periods, WHILE_ACTIVE for the profile;
  * every change is audited.
* **Acceptance:**
  * unit tests of the period split and the parameter checks;
  * API and database tests;
  * the OpenAPI contract;
  * CI green.

### DEC-098 - V4-M1 details settled while building (delegated, DEC-019)
These refine DEC-097. None of them is a tax rule.
* **Superseding.** A CT rule version is never edited, so a wrong UNVERIFIED version is corrected the same way as a verified one: by a new version that supersedes it. The new version keeps the kind of the one it replaces (`kind_mismatch` otherwise). A superseded version cannot be verified.
* **Deriving.** Deriving the periods of a year answers 200 with `created` (true the first time, false when the periods already exist), so a client can call it again safely. Two derivations at the same moment cannot both write: the second is refused by the unique start date (`ct_period_exists`).
* **A changed accounts year.** The accounts year can still be changed until it is approved, but a period's dates never change (DEC-097). If the year's end no longer matches its last period, deriving refuses with `ct_periods_stale` and returns the periods it holds. How such periods are corrected (a superseding period set) is left to the computation milestone (V4-M4), before any computation relies on them.

### DEC-099 - How V4-M2 is built: tax adjustments and the profit of each CT period (delegated, DEC-019; recorded before code)
V4-M2 of `docs/architecture/v4-plan.md`. It produces the profit of a CT accounting period adjusted for tax, **before** capital allowances (V4-M3) and losses (V4-M4). It computes no tax.
* **Accounting profit** of a period is the profit before tax from the ledger, the same figure as the profit and loss account:
  * the net of every INCOME and EXPENSE account for journals dated in the period;
  * leaving out the closing journals (`YEAR_END_CLOSE` and its reversal) and accounts mapped to the tax line (`PL.TAXATION`).
* **Account adjustment rules** (`ct_adjustment_rule`, company data):
  * a rule names an INCOME or EXPENSE account of the company, a category, a percentage (above 0, at most 100), the journal dates it covers, a reason and, optionally, the provision relied on;
  * categories: `DISALLOWABLE`, `DEPRECIATION`, `ENTERTAINING`, `PROVISION`, `LEGAL_PROFESSIONAL`, `NON_TAXABLE_INCOME`, `OTHER`;
  * entered with `ct:prepare`, verified once by a holder of `tax:rule-verify` who did not enter it, changed only by a new version that supersedes it;
  * two current rules of one account may not cover the same date (database guard).

  Classifying an account is the firm's judgement about its contents, not a figure of law, so a rule is company data rather than a rule of the DEC-021 kind. It is still verified by a second person, because it moves the taxable profit.
* **The adjustment a rule makes** for a period: the account's debits less its credits for journals dated in the period and inside the rule's dates (closing journals left out), times the percentage, rounded half-up to the currency's minor units.
  * A positive result is added to profit: an expense disallowed.
  * A negative result is deducted: income that is not taxable.
* **Manual adjustments** (`ct_adjustment`):
  * belong to one CT period, with a category, a direction (`ADD` or `DEDUCT`), a positive amount, a description and an evidence document of the company that the person can read; the evidence is required;
  * entered with `ct:prepare`;
  * withdrawn once with a reason by a holder of `ct:prepare`, and never changed or removed (database guard).
* **The statement** (`GET ct-periods/{id}/adjusted-profit`, `ledger:read`) shows:
  * the accounting profit;
  * every adjustment: rule-made ones with the account, the movement, the percentage and a drill-down to the account's lines for the dates; manual ones with the evidence document;
  * the totals added and deducted, and the adjusted profit;
  * `problems`: unverified rules that made an adjustment, and associated companies not yet set with a reason. The computation (V4-M4) will refuse while there are problems;
  * a SHA-256 fingerprint of the statement.

  Nothing is stored: the statement is read from the ledger each time. V4-M4 stores the computation it approves.
* **Rules for the whole milestone:**
  * screens compute nothing (DEC-048);
  * AI may not write any of this (`ai_cannot_write`);
  * every change is audited;
  * the two tables are classified (RLS+APP), with no DELETE or TRUNCATE;
  * retention is ACCOUNTING_RECORDS for both.
* **Acceptance:**
  * unit tests of the arithmetic;
  * API and database tests;
  * a golden workbook of a synthetic period worked by hand;
  * the OpenAPI contract;
  * CI green.

### DEC-100 - How V4-M3 is built: capital allowances (delegated, DEC-019; recorded before code)
V4-M3 of `docs/architecture/v4-plan.md`: the capital allowances of each CT accounting period, from the fixed-asset register's tax fields (the tax category and the tax cost, which depreciation never reads, DEC-058).

**Rules (new `ct_rule` kinds, DEC-097 pattern; added to the draft pack, UNVERIFIED):**
* `AIA_LIMIT` (`annualLimit`, pounds);
* `WDA_RATES` (`mainRate`, `specialRate`, percentages);
* `SMALL_POOL_LIMIT` (`limit`, pounds).

A period uses the version of each kind in force on its first day. If another version of a kind starts inside the period, the computation is refused (`ca_rule_change_in_period`): hybrid rates and transitional limits are not modelled. Each rule must be verified (`ct_rule_unverified`, `ct_rule_not_found`).

**The period fraction:**
* 1 for a period of exactly 12 months;
* otherwise the days in the period divided by 365.

It scales the AIA limit, the writing-down allowances and the small pools limit for a short period.

**What an asset contributes** (assets not VOID). The tax cost is the asset's tax cost when set, else its cost.
* **Additions:** assets acquired in the period.
  * Category `AIA` is main-pool expenditure on which AIA is claimed. AIA is allocated to such additions in date order (then by asset number) up to the period's limit, and any excess goes into the main pool.
  * `MAIN_POOL` and `SPECIAL_RATE_POOL` go into those pools.
  * `SINGLE_ASSET_POOL` opens a pool of its own, written down at the main rate.
  * `NOT_QUALIFYING` is listed and ignored.
  * `UNDECIDED` is a problem.
* **Disposals:** assets disposed of in the period, of a qualifying category. The disposal value is the lower of the proceeds and the tax cost. It is deducted from the asset's pool (an `AIA` asset's pool is the main pool).

**Pools.** Each pool computes:

    available = opening + additions not covered by AIA - disposal values

* If `available` is below zero, it is a balancing charge, and the pool closes at zero.
* Otherwise, if it is above zero and at most the small pools limit times the fraction (main and special rate pools only), it is all claimed.
* Otherwise the writing-down allowance is `available` times the rate times the fraction, rounded half-up to the penny, and the rest is carried forward.

A single asset pool disposed of in the period gives a balancing allowance (what is left) or a balancing charge, and closes.

**Opening balances (`ca_pool_opening`):**
* the main, special rate or a single asset pool's written-down value at a date, with a reason and evidence of the company;
* entered with `ct:prepare` and verified by a holder of `tax:rule-verify` who did not enter them;
* immutable, and superseded once;
* used for a period whose day before its start is the opening date and which has no stored computation before it.

A first period with neither is a problem. Zero is entered explicitly.

**The computation (`ca_computation`):**
* `GET ct-periods/{id}/capital-allowances` shows it live, with its problems;
* `POST` (`ct:prepare`) stores it when there are none, as a snapshot with a SHA-256 fingerprint and the id of the prior period's computation it started from. A stored computation is append-only: a new one supersedes the previous one of the period;
* the next period (the CT period starting the day after) opens from the prior period's current stored computation. If the prior period has none, that is a problem;
* a stored computation whose prior has since been superseded is reported as stale in the list.

The totals are the allowances (AIA, writing-down allowances, balancing allowances) and the balancing charges, which V4-M4 takes into taxable profit.

**Not in V4-M3:**
* first-year allowances, including full expensing (`ca_fya_not_modelled` is not raised: no tax category selects them yet);
* private-use adjustments and cars;
* structures and buildings allowance;
* cessation of trade;
* AIA allocated other than by date order;
* disclaiming allowances.

**Rules for the whole milestone:**
* permissions as V4-M1 and V4-M2;
* every change audited;
* the two new tables classified (RLS+APP), with no DELETE or TRUNCATE;
* retention ACCOUNTING_RECORDS.

**Acceptance:**
* unit tests of the arithmetic;
* API and database tests;
* a golden of two consecutive periods (12 months and a 6-month period) worked by hand with formulas;
* the OpenAPI contract;
* CI green.

### DEC-101 - How V4-M4 is built: losses, the computation and the canonical CT600 (delegated, DEC-019; recorded before code)
V4-M4 of `docs/architecture/v4-plan.md`. The chain is: adjusted profit (V4-M2), less capital allowances plus balancing charges (V4-M3), equals trading profit or loss; less losses; equals taxable total profits; then tax by financial year.

**What is treated how:**
* Every figure of the adjusted profit is treated as **trading**. Non-trading loan relationships, property income, chargeable gains and distributions are not separated: their CT600 fields are zero, and the computation's notice says so.
* Augmented profits equal taxable total profits (no exempt distributions are modelled).

**Losses:**
* **Brought forward** come from:
  * the previous CT period's current approved computation (its losses carried forward); or
  * when there is none, a trading loss opening balance (`ct_loss_opening`) at the day before the period starts, entered with evidence and verified by a second person (as DEC-100's pool openings; zero is entered explicitly).

  They are set against the period's trading profit as far as it goes.
  * The deductions allowance and the restriction on brought-forward losses (CTA 2010 Part 7ZA) are not modelled. A period whose profits exceed the restriction threshold is out of scope; it is refused only once a rule for it exists.
  * Pre-April 2017 and post-April 2017 losses are not distinguished, since all profit is trading.
* **Carry back** (CTA 2010 s 37):
  * a period with a trading loss may claim, when it is prepared, an amount carried back to the immediately preceding CT period, if that period lies wholly within the 12 months before the loss period starts;
  * the amount is capped at that period's profits before carry back, taken from its current approved computation;
  * other shapes are refused (`carry_back_not_modelled`). The rest of the loss is carried forward;
  * the preceding period's computation deducts the amount claimed by the following period's current **approved** computation;
  * terminal loss relief and group relief are not modelled.

**Tax by financial year** (1 April to 31 March):
* the taxable total profits are apportioned to each financial year the period falls in by days (the first part rounded half-up to the penny, the last part the remainder);
* each part uses the `CT_RATES` version in force on the first day of the part, and a version change inside a part is refused (`ct_rule_change_in_period`);
* the lower and upper limits for the period are the rule's limits:
  * times the period fraction (1 for 12 months, else days/365);
  * divided by one plus the associated companies;
  * apportioned to each part by its days;
* for a part:
  * at or below its lower limit: the small profits rate;
  * at or above its upper limit: the main rate;
  * between them: the main rate less marginal relief, the fraction times (upper limit less profits); with augmented profits equal to profits the N/A factor is 1;
* tax and relief are rounded half-up to the penny per part.

**The computation (`ct_computation`):**
* `GET ct-periods/{id}/computation` (optionally `carryBack`) shows it live with its problems:
  * the adjusted profit's problems;
  * no current stored capital allowances computation, or a stale one;
  * unknown losses brought forward;
* `POST .../computation` (`ct:prepare`, with the fingerprint as read and any carry-back claim) stores it as PREPARED and supersedes the period's previous one;
* `POST .../computation/{id}/approve` (`ct:approve`, new: owner, admin, partner) is made by someone other than the preparer, only while the live computation still has the stored fingerprint (`computation_changed`);
* a stored computation is never changed, and is superseded once;
* a period's computation records the figures it took from its neighbours (the previous period's losses carried forward and profits before carry back, the following period's carry-back). It is stale when they no longer match the neighbours' current approved computations.

**The canonical CT600** (`GET ct-periods/{id}/ct600`) is built from the period's current approved computation, the company and its tax profile. It uses named fields, not box numbers:
* identity;
* turnover;
* trading profits;
* losses used;
* taxable total profits;
* associated companies;
* each financial year's profit, rate, tax and marginal relief;
* corporation tax chargeable;
* tax payable;
* losses carried forward.

It refuses when there is no approved computation (`computation_not_approved`) or no UTR (`utr_missing`). The mapping to the form's boxes and HMRC's schema is V4-M5's verified data. Nothing is filed.

**Not in V4-M4:**
* quarterly instalment payments;
* R&D and other reliefs;
* the deductions allowance;
* group relief;
* close investment-holding companies;
* ring-fence trades;
* a period falling in more than two financial years (impossible at 12 months).

**Rules for the whole milestone:**
* permissions as above;
* every change audited;
* the two new tables (`ct_loss_opening`, `ct_computation`) classified (RLS+APP), with no DELETE or TRUNCATE;
* retention ACCOUNTING_RECORDS.

**Acceptance:**
* unit tests of the arithmetic (financial-year split, marginal relief, associated companies, short periods, losses);
* API and database tests;
* a golden of a profitable 12-month period across two financial years and a following short loss period carried back, worked by hand with formulas;
* the OpenAPI contract;
* CI green.

### DEC-102 - How V4-M5 is built: CT iXBRL and the HMRC submission (delegated, DEC-019; recorded before code)
V4-M5 of `docs/architecture/v4-plan.md`. There is no HMRC connection: the port's only adapter is a fake, refused in production (DEC-082, DEC-086), as for VAT (DEC-091) and Companies House (DEC-095).

**The CT600 box map** is a new `ct_rule` kind, `CT600_FORM`:
* `formVersion` (text) and `boxes`, a map from each canonical CT600 field (DEC-101) to its box number;
* fields not in the canonical list are refused;
* it is effective-dated and verified by a second person (DEC-097 pattern), and the draft pack gains one UNVERIFIED version with a note for the verifier;
* a return uses the version in force on its period's last day.

**The computation's iXBRL:**
* the computation is tagged from a taxonomy version of the V3-M1 kind (`xbrl_taxonomy_version`), verified, whose standard code is `CT-COMP`;
* its entries are FACT entries keyed `ct.<field>` for the canonical fields, and `ct.fy1.<field>` / `ct.fy2.<field>` for the financial-year parts;
* the document is an XHTML page of the computation:
  * contexts for the CT period (and each financial-year part);
  * the entity identified by the company's UTR under the version's scheme;
  * GBP;
* checks, which make it INVALID:
  * a mandatory entry without a value;
  * a key the platform does not know;
  * a missing UTR or scheme.

The concepts are the firm's verified data. Nothing of HMRC's computation taxonomy is in code, and no draft mapping is shipped (the taxonomy files were not read from this environment); the verifier enters it.

**The CT return (`ct_return`, `ct_return_event`):**
* one live return per approved computation;
* the package holds:
  * the canonical CT600 with its boxes;
  * the computation's iXBRL (stored with its SHA-256);
  * the id and SHA-256 of the accounts' latest VALID iXBRL document (V3-M2) for the accounts year that contains the CT period;

  A return needs all three.
* the path:
  * DRAFT (`ct:file`);
  * VALIDATED, re-checking that the computation is still the current approved one;
  * AUTHORISED: the declaration of a serving director, with its date (not in the future) and evidence of the company, recorded by someone other than the validator;
  * SUBMITTED through the port, with the payload SHA-256 and the return id as the idempotency key; a retry returns the same submission;
  * ACCEPTED (with HMRC's reference) or REJECTED (final, with reasons), when a person reads the status;

  or RECORDED as filed elsewhere, with the reference, the date and evidence.
* every move is an append-only event. The database keeps the path and the second-person authority;
* on acceptance (or recording), the company's `CT_RETURN` obligation whose period end is the CT period's end becomes DONE with the reference (V7-M1);
* the fake adapter rejects a UTR starting `99`, so rejection can be tested;
* `HMRC_CT_ADAPTER` is `none` (the default, which answers `filing_not_available`) or `fake`.

**New permission** `ct:file`, granted to owner, admin and partner.

**Not in V4-M5:**
* the GovTalk envelope and HMRC's XML schema;
* real HMRC credentials;
* amendments;
* payment.

**Rules for the whole milestone:**
* every change audited;
* the new tables classified (RLS+APP), with no DELETE or TRUNCATE;
* retention FILING_EVIDENCE.

**Acceptance:**
* unit tests of the document builder;
* API and database tests, including a well-formedness check of the computation document with xmllint;
* the OpenAPI contract;
* CI green.
