# V2 — Accounts Production / FRS 102 / FRS 105

## Objective
Turn the bookkeeping engine into an accountant-grade statutory accounts production system.

## Modules
- year-end wizard
- trial balance mapping
- fixed assets
- depreciation
- accruals
- prepayments
- provisions
- deferred income
- director/shareholder balances
- related parties
- comparative periods
- notes
- statutory statements
- review checklist
- accounts approval.

## Fixed Assets
Support:
- additions
- disposals
- depreciation methods
- useful lives
- residual value
- asset classes
- tax vs accounting treatment
- reconciliation to ledger.

## Year-End Workflow
1. Lock/confirm period.
2. Bank reconciliation.
3. Receivables review.
4. Payables review.
5. Fixed asset review.
6. Accrual/prepayment review.
7. Director balances.
8. VAT reconciliation.
9. Suspense clearance.
10. Review adjustments.
11. Generate accounts.
12. Partner review.
13. Client approval.
14. Filing-ready package.

## FRS Architecture
Never hard-code reporting rules into transaction logic.

Use:
standard → effective date → taxonomy/reporting map → disclosure rules → validation rules.

Support:
- FRS 102
- FRS 105
- future standards without redesign.

## Accounts Output
- profit and loss
- balance sheet
- cash flow where applicable
- notes
- accounting policies
- comparatives
- directors/reporting sections where applicable.

## Review Controls
Flag:
- unexplained movements
- material changes
- unusual balances
- negative balances
- old receivables/payables
- director loan movements
- suspense
- unreconciled bank
- missing supporting evidence.

## Tests
Use golden trial balances and expected statutory outputs.
