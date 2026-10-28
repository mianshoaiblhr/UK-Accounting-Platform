# V5 plan: the VAT return

Written 2026-10-27 under DEC-086 and DEC-090. Each milestone records its design in the decision log before code (DEC-007), is gated by the feature flag `vat.returns`, and is accepted with the package DEC-007 names. There is no HMRC connection: filing goes through a port with a fake adapter only (DEC-082, DEC-086).

## Milestones
| Milestone | Scope | Builds on |
|---|---|---|
| **V5-M1 The VAT return** | The return per client and period from the M4b workpaper; the fingerprint; prepared, flag explanations, second-person review and recorded client approval; review flags; approval freezes the return, locks the period against new VAT lines and moves the obligation to READY | VAT foundation (V1-M4b), compliance calendar (V7-M1), documents |
| **V5-M2 The filing record** (DEC-091) | Boxes 6 to 9 in whole pounds by a verified presentation rule; a filing made outside the platform recorded with HMRC's receipt and evidence, which posts the liability journal and marks the obligation DONE; a simulated submission through the HMRC VAT port (fake adapter only, refused in production) | V5-M1 |
| **V5-M3 Screens** | The prototype's VAT return: the nine boxes with drill-down to lines, the flags and their explanations, the events and their state (live or lapsed), approval and the lock | V5-M1, V5-M2 |

## Rules that hold for every milestone
* No tax figure is built in: rates, box mappings and presentation rules are verified data (DEC-021).
* The return shows what the ledger and the verified rules give; screens compute nothing (DEC-048, DEC-071).
* A change of the ledger after preparation or review makes that step lapse; after approval the period is locked.
* Real-browser tests for the main path, a refusal and a read-only person (DEC-050).
* Synthetic data only until go-live (DEC-014, DEC-085).
