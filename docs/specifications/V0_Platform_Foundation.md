# V0 — Platform Foundation

## Objective
Create the shared infrastructure before accounting features are built.

## Modules

### 1. Identity & Security
- users
- organisations/tenants
- memberships
- roles
- permissions
- MFA-ready authentication
- password/session controls
- login history
- device/session management

### 2. Multi-Tenancy
Hierarchy:
Organisation → Practice → Company → Accounting Period.

Support firms managing many client companies.

All tenant-scoped queries must enforce tenant isolation.

### 3. Core Master Data
- companies
- contacts
- addresses
- directors/officers
- currencies
- countries
- tax jurisdictions
- accounting periods
- financial year-end

### 4. Workflow Engine
Generic workflow states:
DRAFT → IN_PROGRESS → REVIEW → APPROVAL → COMPLETED → REJECTED

Must support:
- actor
- timestamp
- comments
- evidence
- approval
- reassignment
- SLA/deadline

### 5. Task Engine
Tasks:
- owner
- reviewer
- due date
- priority
- status
- company
- source
- attachments
- comments
- reminders.

### 6. Document Management
- upload
- folders
- metadata
- versioning
- document type
- company
- accounting period
- permissions
- OCR-ready pipeline
- immutable filing evidence

### 7. Notification Engine
Email, in-app and future SMS/WhatsApp adapters.

### 8. Audit Framework
Record:
- actor
- action
- entity
- before/after where appropriate
- IP/device metadata where lawful
- timestamp
- reason
- source workflow.

### 9. Integration Hub Foundation
Adapter interface for:
- HMRC
- Companies House
- banks
- Xero
- QuickBooks
- FreeAgent
- Stripe
- Shopify
- payroll
- payment providers.

### 10. AI Layer Foundation
Provider abstraction:
AIProvider → OCRProvider → Embedding/Search Provider.

AI requests must be logged and permission-aware.

## Core Tables
organisations
users
memberships
roles
permissions
companies
contacts
accounting_periods
tasks
workflow_instances
documents
document_versions
audit_events
notifications
integration_connections
integration_jobs
ai_requests

## Security
- encryption in transit
- encrypted sensitive data at rest
- tenant isolation
- least privilege
- secrets never stored in source code
- secure object storage
- backup and disaster recovery
- retention policies.

## Tests
- tenant isolation
- authorisation
- audit creation
- document access
- workflow transitions
- failed integration retry
- API authentication.
