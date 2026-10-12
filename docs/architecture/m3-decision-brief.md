# M3 foreign-currency foundation - decision brief for the product owner

**Status: options only. Nothing here is decided.** This brief prepares the three decisions that block M3 (v1-plan.md section 7, items 2 and 3). Recommendations are *proposals* for you to accept, change or reject; M3 does not start until you decide (DEC-009 put foreign currency in V1; the policy choices are yours).

**Evidence limits (read first).** The build sandbox cannot reach gov.uk, legislation.gov.uk, frc.org.uk or bankofengland.co.uk (network policy). Every legal or source statement below comes from web-search summaries, **not from the primary text**, and is marked UNVERIFIED. Per the standing rule (DEC-010) no tax or accounting rule becomes active in the product until a qualified reviewer has checked it against the primary source. The source register is in `docs/legal/m3-fx-sources.xlsx` (same list as section 5).

## 1. What M3 must deliver (already decided, DEC-009)
Functional currency (the company's base currency) versus transaction currency; exchange-rate source and date; original-currency values stored immutably on lines; functional-currency postings that still balance; rounding; realised gains/losses on settlement; period-end revaluation of foreign-currency monetary items; acceptance tests for reconciliation and reporting. Until then the platform refuses foreign-currency journals (`foreign_currency_not_supported`).

## 2. Decision A - exchange-rate source and lookup window
| Option | What it means | For | Against |
|---|---|---|---|
| **A1 Manual entry only** | A person enters the rate for each transaction or period; rate, source text and date are mandatory and audited | No external dependency; works for any currency; simplest to build and test | Slow, error-prone, no independent check of the number |
| **A2 Official published series loaded as reference data** | An importer (behind an adapter port, never called at posting time) loads dated rates with publisher, series, URL and retrieval time. Candidates: HMRC monthly customs/VAT rates; Bank of England daily spot rates | Traceable, repeatable, reviewable; HMRC's monthly rates are, per search summaries, among the rates HMRC permits for VAT conversion | Each series has its own terms and limits (the Bank of England page says its rates are not official and no more authoritative than a commercial bank's); currency coverage differs; import errors must be controlled |
| **A3 Commercial provider** | Rates from a paid data vendor behind the same port | Broad coverage, intraday | Cost, licence and redistribution terms, vendor dependence, harder to evidence to HMRC |
| **Proposal** | Build the rate model and port once. Ship **A1 + A2** for V1 (manual always allowed; an importer for the HMRC monthly series and the Bank of England daily series, each rate keeping its publisher and URL). **A3 deferred.** Company chooses the default series per currency; every posting stores the rate id, rate, source and rate date | | |

**Lookup window (proposal):** use the rate for the transaction date; if none exists (weekend, holiday, gap) use the latest earlier published rate within **7 days**, otherwise refuse and ask for a manual rate. Never use a future rate. VAT conversion rules (M4) may require a different rate or date; the model must allow a separate VAT rate on the same transaction.

## 3. Decision B - rounding policy
| Item | Options | Proposal |
|---|---|---|
| Rate precision | 4, 6 or 8 decimal places stored | store up to 8 (as published); never round the rate itself |
| Amount precision | functional currency minor units (already in `currency.minor_units`) | round only the *functional* amount, to the currency's minor units |
| Mode | half-up (round half away from zero) or half-even (banker's) | **half-up**, applied identically everywhere (one function, property-tested) |
| Where | per line, or per document total | **per line**, then any difference needed to make the functional journal balance goes to an explicit, system-owned **FX rounding** line (shown on the journal, never hidden), with a hard tolerance (proposal: one minor unit per line, else refuse) |
| VAT amounts | rounding of VAT per line or per document | decided in M4 from the verified VAT rule; M3 only guarantees the mechanism |

## 4. Decision C - realised and unrealised FX, revaluation
| Item | Options | Proposal |
|---|---|---|
| Realised gain/loss | on settlement, the difference between the functional value carried and the functional value of the settlement | post to a system **realised FX** account at settlement, through the PostingService |
| Which items are revalued | (i) foreign-currency monetary items only (cash/bank, receivables, payables, loans, accruals); (ii) also non-monetary items | **(i) monetary items only**; non-monetary items at historical cost keep the transaction-date rate (consistent with FRS 102 section 30, UNVERIFIED) |
| Rate used | closing (period-end) spot rate; or average | period-end rate from the company's chosen series, rate and date stored |
| Treatment | unrealised difference to profit or loss; automatic reversal at the start of the next period or cumulative method | **unrealised FX account, to profit or loss; automatic reversal on the first day of the next period** so realised amounts are not double counted |
| Trigger | automatic at close, or an explicit action | **explicit "revalue" action at period close**, previewed first, requires `period:manage`, audited, repeatable (re-running replaces nothing: it posts a reversal and a new journal); a period cannot be closed with an unrevalued foreign-currency balance unless the user acknowledges it |
| Control accounts | revalue sub-ledger-controlled accounts by a system source | allowed only by the revaluation source (a new `JOURNAL_SOURCES` entry), never by manual journals |
| Out of scope | hedge accounting, forwards, net investments, translation of foreign operations | deferred (stated in the plan) |

## 5. Sources a qualified reviewer must verify (all UNVERIFIED)
| # | Source | Used for | Candidate link (not read in this sandbox) | How found |
|---|---|---|---|---|
| 1 | Value Added Tax Act 1994, Schedule 6, paragraph 11 | VAT value of supplies expressed in foreign currency; basis for permitted conversion methods | https://www.legislation.gov.uk/ukpga/1994/23/schedule/6 | search summary of HMRC guidance |
| 2 | HMRC VAT Valuation manual VATVAL09500 | permitted rates: HMRC period rate, UK market selling rate at the time of supply, ECB rate, rate agreed with HMRC | https://www.gov.uk/hmrc-internal-manuals/vat-valuation/vatval09500 | search result |
| 3 | HMRC VAT Trader Records manual VATREC5060 | invoices in a foreign currency; VAT amount shown in sterling | https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec5060 | search result |
| 4 | HMRC guidance "Foreign currency transactions and VAT" (tour operators page and general guidance) | the two standard conversion methods, monthly period rate | https://www.gov.uk/guidance/foreign-currency-transactions-vat-and-tour-operators | search result |
| 5 | HMRC "Exchange rates for customs and VAT" collection | monthly rates in CSV and XML; apply for the following calendar month; some years moved to the National Archives | https://www.gov.uk/government/collections/exchange-rates-for-customs-and-vat | search result |
| 6 | Taxation (Cross-border Trade) Act 2018, section 18 (as cited in search summary) | legal basis for HMRC monthly rates for customs purposes - **relevance to VAT of domestic supplies not established** | https://www.legislation.gov.uk/ukpga/2018/22/section/18 | search summary |
| 7 | FRS 102, Section 30 Foreign Currency Translation (paras 30.7 initial recognition at spot rate, average rate allowed if stable; 30.9 monetary items at closing rate; differences in profit or loss) | accounting treatment | https://www.frc.org.uk/ (current FRS 102 text; the version applicable to the period must be confirmed - ICAEW notes old and new versions) | search summaries (ICAEW, ACCA, FRC comparison) |
| 8 | HMRC Corporate Finance manual CFM23080 and Business Income manual BIM39510 | tax follows accounts for exchange differences (to be confirmed) | https://www.gov.uk/hmrc-internal-manuals/corporate-finance-manual/cfm23080, https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim39510 | search results |
| 9 | Bank of England daily spot exchange rates against sterling | candidate accounting series; page states rates are not official and are subject to the Bank's terms | https://www.bankofengland.co.uk/boeapps/database/Rates.asp?TD=15 | search result |

**Not confirmed and not to be cited:** a "VAT Regulations 1995 regulation 24" rule on foreign currency appeared in a search query but no source confirmed it; regulation 14 (invoice content) was mentioned in a result. A reviewer must establish the correct provisions.

**Case law:** none has been identified or verified. The reviewer should confirm whether any tribunal or court authority bears on the conversion date or rate for VAT or on exchange differences; the National Archives (caselaw.nationalarchives.gov.uk), BAILII and the Tribunal decisions database are the places to search once network access allows.

## 6. What happens after your decisions
Record them in the decision log (DEC-015 onward) and ADR-50; update plan section 5 and matrix rows V1-FX-01..10 with owners and acceptance details; then M3 can be specified in full and built on your go-ahead. The sandbox network restriction does not block the build; it blocks *verification of sources here*. To read the primary texts in this environment, allow `www.gov.uk`, `www.legislation.gov.uk`, `www.frc.org.uk` and `www.bankofengland.co.uk` in the environment's network settings; otherwise the reviewer verifies them elsewhere.
