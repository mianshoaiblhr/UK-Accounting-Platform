# Cross-Platform Product Requirements

## 1. Universal Drill-Down
Every number should answer:
Where did this number come from?

Example:
P&L → Revenue → Customer → Invoice → Invoice Line → Supporting Document → Bank Receipt.

## 2. Universal Search
Search across:
- clients
- companies
- transactions
- invoices
- documents
- tasks
- filings
- working papers.

## 3. Exception-First UX
Do not force accountants to inspect everything manually.

Dashboard should prioritise:
- exceptions
- overdue items
- material movements
- missing evidence
- compliance risks
- review points.

## 4. Global Command Centre
A single command/search interface:
“Show me all clients with VAT due in 14 days.”
“Which companies have unreconciled bank items?”
“Prepare year-end review for ABC Ltd.”

## 5. Materiality Engine
Allow firm/company-specific thresholds.
Use materiality in:
- review
- AI alerts
- working papers
- management reporting.

## 6. Evidence Graph
Connect:
transaction ↔ document ↔ journal ↔ report ↔ tax return ↔ filing.

This becomes the platform's auditability backbone.

## 7. Event Architecture
Important events:
TransactionPosted
BankImported
InvoiceCreated
DocumentUploaded
VATReturnPrepared
TaxComputationPrepared
AccountsApproved
FilingSubmitted
FilingAccepted
AIRecommendationCreated.

## 8. Observability
All asynchronous jobs need:
- status
- retries
- failure reason
- correlation ID
- tenant/company
- timestamps.

## 9. Feature Flags
Use feature flags for:
- beta AI
- new tax rules
- new HMRC endpoints
- filing formats
- new reporting standards.

## 10. Data Retention
Retention must be configurable by document/data category and applicable legal requirements.

## 11. Accessibility
Target WCAG-aligned accessible design, keyboard navigation and readable contrast.

## 12. Performance Targets
Common dashboard/report interactions should feel immediate.
Heavy operations such as OCR, imports, iXBRL and AI must run asynchronously with visible progress.

## 13. Mobile
Client portal and approval workflows should be mobile-first.
Accountant production UI can prioritise desktop/tablet.

## 14. Product Design
Design language:
- premium
- clean
- accountant-grade
- low cognitive load
- dense where professional users need density
- visual hierarchy for exceptions
- no decorative complexity that slows production work.
