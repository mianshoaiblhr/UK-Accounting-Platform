# V3 plan: iXBRL and Companies House

Written 2026-10-28 under DEC-086 and DEC-093, from `docs/specifications/V3_iXBRL_Companies_House.md`. Each milestone records its design in the decision log before code (DEC-007), is gated by the feature flag `ixbrl.filing`, and is accepted with the package DEC-007 names. There is no Companies House connection: as for HMRC (DEC-082, DEC-086), the filing adapter is a fake until the owner decides on Companies House access.

## The chain (specification)
Accounts engine (V2) -> the approved accounts package (DEC-070) -> taxonomy mapping (V3-M1) -> iXBRL document and validation (V3-M2) -> filing package and the Companies House workflow (V3-M3). The filing layer reads the approved package only; it never changes an accounting record.

## Milestones
| Milestone | Scope | Builds on |
|---|---|---|
| **V3-M1 Taxonomy and mapping** | Taxonomy versions (entry point, namespaces, dates, source) and their concept map: which concept, period type, sign, decimals and dimensions each statutory line, preparer's fact or company detail is tagged with. Versioned data, verified by a second person, never in code; a draft pack, UNVERIFIED | Reporting standards (V2-M1), accounts facts (V2-M5a) |
| **V3-M2 iXBRL document and validation** | From an approved package and a verified mapping: contexts, units and facts, rendered as inline XBRL (XHTML) with the accounts' text; checks for mandatory facts, contexts, periods, units, duplicate facts, balance and consistency with the package; stored with its SHA-256 | V3-M1, accounts package (DEC-070) |
| **V3-M3 Companies House workflow** | DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED / REJECTED with immutable evidence (submission id, payload hash, response, actor, time); explicit authority; idempotency and retries; the Companies House port with a fake adapter only; a filing made elsewhere recorded with its evidence; the accounts deadline marked DONE | V3-M2, compliance calendar (V7-M1) |
| **V3-M4 Screens** | Mapping review, the iXBRL preview and its checks, authorisation and the filing record, following the prototype | V3-M1 to M3 |

## Rules for every milestone
* No taxonomy concept, namespace or entry point is written in application code: they are data in versioned mapping tables (specification, "Never scatter taxonomy tags").
* A mapping is used only once a person other than its author has verified it (the DEC-021 pattern).
* Nothing is submitted without explicit authority, and nothing reaches Companies House from the platform (DEC-082, DEC-086).
* Screens show what the API returns and compute nothing (DEC-048, DEC-071).
* Synthetic data only until go-live (DEC-014, DEC-085).
