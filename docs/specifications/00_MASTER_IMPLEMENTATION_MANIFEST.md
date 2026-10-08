# UK Accounting Platform — Master Implementation Manifest V2.0

## Product Vision
Build an AI-native **Accounting, Tax, Compliance & Practice Management Operating System for UK accountants and businesses**.

This is not six independent applications. It is one platform delivered through sequential implementation versions.

## Mandatory Architecture Principle
Organisation → Companies → Accounting Periods → Source Transactions → Central Double-Entry Posting Engine → Journals → General Ledger → Trial Balance → Reporting Engine → FRS 102/105 → Tax/Compliance → Filing/Integrations → AI/Practice Intelligence.

**The General Ledger is the accounting source of truth.**

No reporting, tax, AI or filing module may create an alternative accounting truth.

## Version Roadmap
- V0 — Platform Foundation
- V1 — Core Bookkeeping
- V2 — Accounts Production / FRS 102 / FRS 105
- V3 — iXBRL / Companies House
- V4 — Corporation Tax / HMRC
- V5 — VAT / MTD / HMRC Services
- V6 — AI / OCR / Automation
- V7 — Practice Management / Client Portal / Compliance
- V8 — Working Papers / Review / Quality Control
- V9 — CFO / Forecasting / Financial Intelligence
- V10 — AI Accountant / Autonomous Workflows
- V11 — Integrations / Migration / Ecosystem
- V12 — Benchmarking / Marketplace / Platform Ecosystem

## Shared Technical Contract
- Frontend: Next.js + TypeScript
- Backend: NestJS + TypeScript
- Database: PostgreSQL
- ORM: Prisma unless an existing project uses another proven ORM
- API: REST with versioning
- Authentication: JWT/session architecture + MFA capability
- Authorisation: RBAC + company-level permissions
- Multi-tenancy: mandatory tenant isolation
- Object storage: encrypted document/object storage
- Queue/event layer: asynchronous jobs for OCR, imports, filings, AI and notifications
- Observability: structured logs, metrics, tracing and audit events
- Testing: unit, integration, accounting-rule, API, security and end-to-end tests

## Non-Negotiable Accounting Controls
1. Only the central PostingService can create posted ledger entries.
2. Posted journals are immutable.
3. Corrections use reversal/adjustment journals.
4. Debits must equal credits.
5. Every posted journal has source, user/system actor, timestamp and audit metadata.
6. Every source transaction must be traceable to its journal.
7. Every report number must be drillable to ledger/source evidence.
8. Accounting periods have explicit states and close controls.
9. Tax and reporting rules are effective-dated/versioned.
10. AI cannot silently post accounting entries or submit filings.

## Cross-Version Rule
Each version must:
- extend the existing platform;
- preserve existing APIs/data;
- preserve all previous tests;
- avoid duplicate accounting logic;
- expose reusable services;
- add migrations rather than destructive schema rewrites;
- include feature flags where functionality is incomplete.

## Definition of Done
A version is not complete until:
- database migrations exist;
- APIs are documented;
- permissions are enforced;
- audit events exist;
- UI workflows are usable;
- tests pass;
- failure/retry behaviour is implemented;
- observability is present;
- documentation is updated;
- existing functionality remains green.

## Strategic Differentiators
The platform should ultimately provide:
- AI bookkeeping
- AI year-end review
- AI client information requests
- AI Accountant/Copilot
- automated exception detection
- working papers
- review/sign-off workflow
- compliance health score
- client health score
- CFO forecasting
- explainable financial intelligence
- document intelligence
- HMRC/Companies House integrations
- migration from incumbent systems
- accountant-grade audit trail and controls.
