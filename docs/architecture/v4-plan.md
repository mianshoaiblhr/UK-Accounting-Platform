# V4 plan: Corporation Tax

Written 2026-10-28 under DEC-086 and DEC-097, from `docs/specifications/V4_Corporation_Tax_HMRC.md`. Each milestone records its design in the decision log before code (DEC-007), is gated by the feature flag `corporation.tax`, and is accepted with the package DEC-007 names. There is no HMRC connection: the CT adapter is a fake until the owner decides on HMRC access (DEC-082, DEC-086).

## The chain (specification)
Accounting trial balance -> tax adjustments -> taxable profit -> rates and reliefs -> tax computation -> CT600 -> iXBRL -> HMRC submission. Accounting profit is an input, never the tax result.

## Milestones
| Milestone | Scope | Builds on |
|---|---|---|
| **V4-M1 Tax rules, tax periods and the tax profile** | Corporation Tax rules as sourced, effective-dated, verified data (rates and limits by financial year, the length of an accounting period for CT); the company's tax profile (UTR); CT accounting periods derived from the accounts year (split when longer than the verified maximum) with the associated companies of each | Reporting frameworks (V2), the DEC-021 pattern |
| **V4-M2 Tax adjustments and taxable profit** | Account-level adjustment rules (disallowable, entertaining, depreciation, provisions) as firm data, manual adjustments with evidence, the profit of each tax period from the trial balance; every adjustment drills to its source | V4-M1, the ledger, documents |
| **V4-M3 Capital allowances** | Pools and allowances (annual investment allowance, writing-down allowances, first-year allowances) from the fixed-asset register's tax fields, with rates and limits as verified rules | V4-M1, fixed assets (V2-M2) |
| **V4-M4 Losses and the computation** | Trading losses carried forward and back, rates and marginal relief by financial year, the liability; the computation that shows accounting profit, the adjustments, taxable profit and tax; the canonical CT600 and its schedules | V4-M1 to M3 |
| **V4-M5 CT iXBRL and the HMRC submission** | The computation and accounts tagged for HMRC, the CT600 submission workflow through an HMRC port with a fake adapter only, receipts and status, the CT deadlines marked done | V4-M4, V3-M2, V7-M1 |
| **V4-M6 Screens** | The computation, its adjustments and their evidence, capital allowances, losses, review and approval, the CT600 and the filing | V4-M1 to M5 |

## Rules for every milestone
* Every tax figure, rate, limit, period length and allowance is data: a rule version with its source, UNVERIFIED until a different person verifies it (the DEC-021 pattern). Engineering ships draft rules as a pack, never as seeded data.
* AI may propose classifications or questions; it never changes a computation or submits a return (specification, "AI Boundary").
* Screens show what the API returns and compute nothing (DEC-048, DEC-071).
* Synthetic data only until go-live (DEC-014, DEC-085).
