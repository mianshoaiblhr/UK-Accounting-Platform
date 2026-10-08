# V11 — Integrations / Migration / Ecosystem

## Objective
Make switching to the platform easy and make the platform interoperable.

## Integration Hub
Adapters for:
- Xero
- QuickBooks
- FreeAgent
- Sage
- banks/open banking
- Stripe
- Shopify
- Amazon
- PayPal
- Wise
- payroll providers
- expense systems.

## Adapter Contract
Each adapter supports as applicable:
- authenticate
- discover accounts
- import customers
- import suppliers
- import invoices
- import bills
- import bank transactions
- import payments
- import VAT data
- export
- reconcile
- disconnect.

## Normalisation
External data → connector DTO → canonical platform model.

Never let external schemas contaminate core accounting tables.

## Migration Engine
Support:
- chart of accounts
- contacts
- invoices
- bills
- bank
- journals
- opening balances
- VAT history
- fixed assets.

## Migration Assistant
Detect:
- duplicate accounts
- duplicate contacts
- VAT mismatches
- unbalanced TB
- missing opening balances
- orphan transactions
- invalid tax codes.

## Migration Validation
Pre-import:
VALIDATE → PREVIEW → USER CONFIRMATION → IMPORT.

Post-import:
RECONCILE → EXCEPTION REPORT → SIGN-OFF.

## Marketplace
Future:
- accountant-built integrations
- partner applications
- workflow extensions
- AI agents
- industry templates.
