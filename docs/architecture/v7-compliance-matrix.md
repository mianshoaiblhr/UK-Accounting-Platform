# V7 Practice Management - compliance matrix (plan version 1)

Source requirements: `docs/specifications/V7_Practice_Management_Client_Portal_Compliance.md`, `00_MASTER_IMPLEMENTATION_MANIFEST.md`, `decision-log.md` DEC-086 and DEC-088, `v7-plan.md`.

**Statuses change only with evidence (code and passing tests). A requirement is never marked implemented because a table or flag exists.** "Implemented" means the mechanism is built and proven on synthetic data. Statutory dates come from deadline rules, which stay UNVERIFIED until the named verifier verifies them in the platform (DEC-083, DEC-088).

## Plan history (append-only)
* v1.0 (2026-10-27, V7-M1, DEC-086/088): matrix created from the V7 specification; 38 rows. The compliance calendar is built.
  * Missing -> Implemented: V7-CAL-01, V7-CAL-02, V7-CAL-03, V7-CAL-05, V7-CAL-07.
  * Missing -> Partially: V7-DASH-02 and V7-DASH-03 (the practice deadlines page and its counts; the full dashboard is V7-M2).

## Requirements
| Id | Requirement (specification) | Status | Milestone | Evidence or note |
|---|---|---|---|---|
| V7-DASH-01 | Dashboard: clients | Missing | V7-M2 | |
| V7-DASH-02 | Dashboard: deadlines | Partially | V7-M1, V7-M2 | Practice deadlines page with the deadline list across readable clients (`tests/e2e/compliance.test.ts`); the overview layout is V7-M2 |
| V7-DASH-03 | Dashboard: overdue tasks | Partially | V7-M1, V7-M2 | Overdue obligations counted per person (`GET compliance/summary`); overdue tasks are V7-M2 |
| V7-DASH-04 | Dashboard: work in progress | Missing | V7-M2 | |
| V7-DASH-05 | Dashboard: filings | Missing | V7-M2 | |
| V7-DASH-06 | Dashboard: review queue | Missing | V7-M2 | |
| V7-DASH-07 | Dashboard: client risk | Missing | V7-M3 | |
| V7-DASH-08 | Dashboard: compliance health | Missing | V7-M5 | |
| V7-ONB-01 | Onboarding: KYC / anti-money-laundering workflow | Missing | V7-M3 | |
| V7-ONB-02 | Onboarding: company information | Missing | V7-M3 | |
| V7-ONB-03 | Onboarding: directors | Missing | V7-M3 | Officers exist since V0; the onboarding step is V7-M3 |
| V7-ONB-04 | Onboarding: beneficial owners | Missing | V7-M3 | |
| V7-ONB-05 | Onboarding: tax registrations | Missing | V7-M3 | |
| V7-ONB-06 | Onboarding: engagement | Missing | V7-M3 | |
| V7-ONB-07 | Onboarding: risk assessment | Missing | V7-M3 | |
| V7-ONB-08 | Onboarding: document collection | Missing | V7-M3, V7-M4 | |
| V7-CAL-01 | Compliance calendar: accounts | Implemented | V7-M1 | ACCOUNTS_FILING from each accounting period end by a verified rule, with the month-end rule (`tests/api/compliance.test.ts`, `packages/contracts/src/compliance.test.ts`) |
| V7-CAL-02 | Compliance calendar: corporation tax | Implemented | V7-M1 | CT_PAYMENT and CT_RETURN from each accounting period end (same tests). Instalments of large companies are not modelled (DEC-088) |
| V7-CAL-03 | Compliance calendar: VAT | Implemented | V7-M1 | VAT_RETURN from the VAT settings' periods from the registration date (same tests) |
| V7-CAL-04 | Compliance calendar: PAYE-related tasks | Missing | not planned | PAYE is outside the platform's scope until a payroll integration (V11) |
| V7-CAL-05 | Compliance calendar: confirmation statement | Implemented | V7-M1 | From the confirmation date on the client's profile and its anniversaries (same tests) |
| V7-CAL-06 | Compliance calendar: MTD obligations | Missing | V13 | MTD Income Tax obligations come from HMRC; no HMRC connection yet (DEC-082) |
| V7-CAL-07 | Compliance calendar: internal deadlines | Implemented | V7-M1 | Manual obligations of kind OTHER with a title and a reason (same tests) |
| V7-POR-01 | Portal: upload documents | Missing | V7-M4 | |
| V7-POR-02 | Portal: view requests | Missing | V7-M4 | |
| V7-POR-03 | Portal: answer questions | Missing | V7-M4 | |
| V7-POR-04 | Portal: approve accounts | Missing | V7-M4 | The practice records the client's approval since V2-M6c (DEC-070); the client doing it is V7-M4 |
| V7-POR-05 | Portal: approve tax returns | Missing | V7-M4, V4, V5 | |
| V7-POR-06 | Portal: view tasks | Missing | V7-M4 | |
| V7-POR-07 | Portal: secure messages | Missing | V7-M4 | |
| V7-POR-08 | Portal: see filing status | Missing | V7-M4 | |
| V7-REQ-01 | One client action list, prioritised by deadline, materiality, risk and dependency | Missing | V7-M4 | AI may suggest; a person decides (manifest control 10) |
| V7-HLT-01 | Compliance health score, explainable | Missing | V7-M5 | |
| V7-HLT-02 | Compliance health score, configurable | Missing | V7-M5 | |
| V7-COM-01 | Communication templates | Missing | V7-M5 | |
| V7-COM-02 | Secure messaging | Missing | V7-M4 | |
| V7-COM-03 | Reminders | Missing | V7-M5 | Task reminders exist since V0 |
| V7-COM-04 | Escalation | Missing | V7-M5 | |
