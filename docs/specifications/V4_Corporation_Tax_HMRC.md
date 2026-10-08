# V4 — Corporation Tax / HMRC

## Objective
Create an accountant-grade Corporation Tax computation and filing workflow.

## Modules
- tax periods
- tax profile
- tax adjustments
- capital allowances
- losses
- associated companies
- group-related data where required
- tax computation
- CT600 model
- supporting schedules
- corporation tax iXBRL
- HMRC submission adapter.

## Tax Architecture
Accounting profit is an input, not the tax result.

Accounting TB
→ tax adjustment engine
→ taxable profit
→ rates/reliefs
→ tax computation
→ CT600
→ iXBRL
→ HMRC submission.

## Tax Adjustments
Support:
- disallowable expenses
- depreciation add-back
- capital allowances
- entertaining
- professional/legal classifications
- provisions
- accruals
- losses
- other statutory adjustments.

All rules must be:
- effective-dated
- jurisdiction-aware
- source/version controlled
- testable.

## CT600
Create an internal canonical CT600 representation independent of the UI.

## HMRC Adapter
- authentication/authorisation
- submission
- polling/status
- errors
- retry
- idempotency
- receipt
- audit trail.

## Review
Tax computation must show:
Accounting profit
+/- adjustments
= taxable profit
→ tax liability.

Every adjustment must drill to source/evidence.

## AI Boundary
AI may propose classifications or questions.
AI cannot silently alter a tax computation or submit a return.
