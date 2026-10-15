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
