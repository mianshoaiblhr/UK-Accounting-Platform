# V7 plan: practice management, client portal and compliance

Written 2026-10-27 under DEC-086, from `docs/specifications/V7_Practice_Management_Client_Portal_Compliance.md`. Each milestone records its design in the decision log before code (DEC-007), is gated by the feature flag `practice.management`, and is accepted with the package DEC-007 names. The screens follow the design prototype (DEC-079).

## Milestones
| Milestone | Scope | Builds on |
|---|---|---|
| **V7-M1 Compliance calendar** | Deadline rules as sourced, verified data; obligations per client (accounts filing, Corporation Tax payment and return, confirmation statement, VAT returns) generated from the client's periods and VAT settings, plus manual and internal deadlines; statuses, owners and filing evidence; the practice's deadline list and counts across the clients a person may see; the client's compliance screen and the practice deadlines screen | Periods (V0), VAT settings (V1-M4b), documents (V0) |
| **V7-M2 Practice dashboard and client list** | The practice overview of the prototype: the counts, deadlines, work by stage (from the year-end workflow, DEC-069, and the obligations), connections; the client list with services, year end, VAT, next deadline, manager | V7-M1, V2 year-end workflow |
| **V7-M3 Onboarding and anti-money-laundering** | Client onboarding checklist; customer due diligence and risk assessment (MLR 2017 regs 18, 27, 28, 33); beneficial owners; identity evidence (retention category IDENTITY_VERIFICATION, DEC-084); the engagement letter; review dates | Officers (V0), documents |
| **V7-M4 Client portal** | Client users; one list of requests ("3 items required from you"); uploads against a request; client approval of accounts (DEC-070) and later of returns; secure messages; filing status | V7-M1, V7-M3, accounts approval |
| **V7-M5 Compliance health and communication** | An explainable, configurable score per client from its obligations, documents, bank reconciliation and accounts; message templates, reminders and escalation | V7-M1 to M4, notifications (V0) |

## Rules that hold for every milestone
* Every date that comes from law is data: a deadline rule is entered with its source, starts UNVERIFIED and is used only once a different person has verified it (the DEC-021 pattern). Engineering ships draft rules as a pack, never as seeded data.
* Screens show what the API returns and compute nothing (DEC-048, DEC-071).
* A practice-wide list shows only the clients the person may read: the API filters by the caller's permission per company.
* Real-browser tests for the main path, a refusal and a read-only person (DEC-050).
* No HMRC or Companies House connection: filing status is recorded by a person, with evidence (DEC-082, DEC-086).
