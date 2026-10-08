# V1 — Core Bookkeeping Engine

## Objective
Deliver production-grade double-entry bookkeeping.

## Modules
- Chart of Accounts
- Customers
- Suppliers
- Sales
- Purchases
- Credit Notes
- Debit Notes
- Receipts
- Payments
- Bank Accounts
- Cash
- VAT foundation
- Journals
- General Ledger
- Trial Balance
- P&L
- Balance Sheet
- Reconciliation
- Accounting Periods

## Accounting Architecture
Source document → transaction service → PostingService → journal → journal lines → ledger.

Never calculate financial statements independently from source transactions.

## Chart of Accounts
Each account must include:
- code
- name
- type
- subtype
- control account flag
- tax treatment
- reporting mapping
- active dates.

## Posting Engine
PostingService is the sole service authorised to post ledger entries.

Validate:
- balanced journal
- valid accounts
- valid period
- VAT treatment
- currency
- source reference
- permissions.

## Sales Example
Dr Trade Receivables
Cr Revenue
Cr Output VAT

## Purchase Example
Dr Expense/Asset
Dr Input VAT
Cr Trade Payables

## Receipt
Dr Bank
Cr Trade Receivables

## Payment
Dr Trade Payables
Cr Bank

## Credit Notes
Must reverse or adjust the original economic effect with full source linkage.

## Bank
- bank accounts
- statement imports
- transactions
- reconciliation
- unmatched items
- transfers
- bank charges
- interest.

## Reconciliation
Support:
- matched
- partially matched
- unmatched
- suggested matches
- manual override with audit.

## Reporting
Trial Balance → P&L / Balance Sheet.

All report figures must support drill-down:
Report → account → journal → source transaction → document.

## Controls
- locked periods
- duplicate document checks
- suspense account visibility
- negative cash alerts
- unposted transaction alerts
- audit trail.

## Tests
Every posting rule requires positive, negative, reversal, VAT and period-lock tests.
