# V6 — AI / OCR / Accounting Automation

## Objective
Introduce AI without compromising accounting integrity.

## AI Modules

### 1. Bank Statement OCR
Input:
- PDF
- image
- CSV
- Excel.

Output:
normalised bank transactions with confidence scores.

### 2. Invoice OCR
Extract:
- supplier/customer
- invoice number
- date
- due date
- lines
- net
- VAT
- gross
- bank details
- currency.

### 3. AI Categorisation
Suggest:
- nominal account
- VAT code
- customer/supplier
- transaction type.

Every suggestion must show confidence and explanation.

### 4. Duplicate Detection
Detect:
- invoice duplicates
- payment duplicates
- bank duplicates
- document duplicates.

### 5. Reconciliation Suggestions
AI may suggest matches between:
- bank
- invoices
- bills
- receipts
- payments.

### 6. Anomaly Detection
Flag:
- unusual transactions
- unusual suppliers
- unusual journals
- margin changes
- duplicate activity
- suspicious patterns.

### 7. AI Client Information Requests
Automatically generate questions such as:
- unusual expense movements
- missing documents
- director balance changes
- unexplained bank items
- potential accrual/prepayment items.

## Human-in-the-Loop
AI status:
SUGGESTED → REVIEWED → ACCEPTED / REJECTED.

No direct AI-to-ledger write.

## Explainability
Store:
- model/provider
- prompt version
- source evidence
- confidence
- recommendation
- user decision.

## Privacy
No sensitive company information may be sent to an external AI provider without the configured data-processing controls.
