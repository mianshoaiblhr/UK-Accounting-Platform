# V5 — VAT / MTD / HMRC Services

## Objective
Build VAT compliance and the platform's HMRC obligation architecture.

## Modules
- VAT registration profile
- VAT codes
- VAT transactions
- VAT periods
- VAT return
- VAT reconciliation
- HMRC obligations
- liabilities
- payments
- MTD submission
- submission history
- HMRC messages/errors.

## VAT Engine
Each transaction carries VAT metadata:
- VAT code
- rate
- net
- VAT
- gross
- jurisdiction
- supply type
- recovery treatment where relevant.

## VAT Return
Generate return figures from the ledger/VAT subledger, not manual duplicate calculations.

## MTD Architecture
Use an HMRC adapter isolated from the accounting engine.

Generic interface:
getObligations()
getLiabilities()
getPayments()
submitReturn()
getSubmissionStatus()

## Idempotency
No duplicate submission.

Store:
- period
- obligation ID
- payload hash
- submission ID
- timestamp
- response
- status.

## VAT Review
Flag:
- unusual VAT rate
- missing VAT code
- VAT/ledger mismatch
- unusually high input VAT
- unusual output VAT
- unreconciled VAT control account.

## Future-Proofing
The HMRC integration layer must support expansion to other HMRC digital services without embedding HMRC logic in bookkeeping.
