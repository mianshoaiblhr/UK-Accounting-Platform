# V1 readiness report (completion gate for V1 Core Bookkeeping)

**Recommendation: V1 IS BUILT AND VERIFIED FOR ITS APPROVED SCOPE - NOT PRODUCTION-APPROVED.** Every V1 milestone that engineering can complete alone is verified (M1 to M9, each with an acceptance package, a green CI run, a clean-clone run and, for the screens, real-browser tests). Seven matrix rows remain open; every one of them waits on a person's review or a recorded decision, not on code. Production, live customers and real data stay out of scope until the gates in section 6 are passed (DEC-006). All data used so far is synthetic.

This report is versioned evidence: it does not replace any earlier decision or acceptance package, and later changes are added as dated addenda.

## 1. Verified commit and results
| Item | Result |
|---|---|
| Last code commit verified | `c0cad12` (branch `claude/adoring-cori-mra6ze`); later commits change documentation only |
| CI run (all jobs) | <https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/38973214119> - **success**: migrations from scratch; terraform fmt, init and validate; real S3 protocol (moto) and real ClamAV; build, lint, typecheck, unit, integration, e2e; dependency audit and secret scan; images for api, worker, web and migrate with the Trivy gate |
| CodeQL | <https://github.com/mianshoaiblhr/uk-accounting-platform/actions/runs/38973214250> - **success** |
| Clean-clone verification | fresh clone of `c0cad12`: install, build, typecheck, lint exit 0; **1881 tests passed, 0 failed, 0 skipped**; real-browser e2e **21/21**; OpenAPI drift 0 |
| Database | 32 migrations (13 for V1), applied from scratch on every CI run and by every test run; forced row-level security on every tenant table |
| API | 210 paths, 274 operations, all in `docs/api/openapi.json` (checked for drift by CI) |
| Terraform | formatted and validated only. **Nothing has been planned or applied** |

## 2. What V1 delivers
| Milestone | Scope | Code baseline | Evidence |
|---|---|---|---|
| M1 | Ledger core: chart of accounts, periods and their states, PostingService, journals, general ledger, trial balance | `fae5270` | `v1-m1-acceptance.md` (accepted, DEC-008) |
| M2 | Ledger controls: opening balances and control-account adjustments by request with second-person approval | `d98e3ed` | `v1-m2-acceptance.md` (accepted, DEC-015) |
| M3 | Foreign currency: rates with verification, original-currency lines, revaluation with auto-reversal | `c8fd8c0` | `v1-m3-acceptance.md` (accepted under delegation, DEC-019) |
| M4a | Customers and suppliers as roles; encrypted supplier bank details with second-person verification | `206b14d` | `v1-m4a-acceptance.md` |
| M4b | VAT foundation: codes, sourced rate versions usable only once verified, VAT on postings, nine-box workpaper, control reconciliation | (M4b, plan 6.4) | `v1-m4b-acceptance.md` - **rules usable only after the tax reviewer verifies them** |
| M5a, M5b | Sales invoices and credit notes; receipts, allocation, realised FX, statements, aged receivables | `e698562`, `376aec6` | `v1-m5a-`, `v1-m5b-acceptance.md` |
| M6a, M6b, M6c | Bills and debit notes; supplier payments; cash transactions and the negative-cash control | `16c7f12`, `a753db0`, `7f4adad` | `v1-m6a-`, `v1-m6b-`, `v1-m6c-acceptance.md` |
| M7a, M7b | Bank accounts, CSV statement import, transfers; reconciliation with proof and sign-off | `e100429`, `b8c0e0a` | `v1-m7a-`, `v1-m7b-acceptance.md` |
| M8, M8h | P&L, balance sheet, drill-down, alerts, close controls, FX report; hygiene (customer default VAT code, posting-rule coverage registry) | `b1e69af`, `e358a26` | `v1-m8-`, `v1-m8h-acceptance.md` |
| M9a, M9b, M9c | Screens behind `bookkeeping.core`: workspace and reports; sales and purchases; bank, cash and reconciliation | `34c2c1e`, `5854a0d`, `c0cad12` | `v1-m9a-`, `v1-m9b-`, `v1-m9c-acceptance.md` |

Not built, by decision: M5c (VAT on foreign-currency documents) waits for the verified rule (DEC-031); a VAT-registered company cannot approve a foreign-currency sale until then, so nothing is silently missing from the VAT workpaper.

## 3. Compliance counts (113 rows, matrix v3.7)
| Status | Rows |
|---|---|
| Implemented | **106** |
| Partially implemented | 5 |
| Missing | 2 |
| Not applicable | 0 |

| Open row | Status | Waiting on | What closes it |
|---|---|---|---|
| V1-MOD-12 VAT foundation | Missing | Qualified tax reviewer | Every V1-VAT criterion met with verified sources (the build is done; the rules are not verified) |
| V1-VAT-04 output and input VAT | Partially | Qualified tax reviewer | Rate versions and box mappings verified; boundary cases confirmed |
| V1-VAT-05 credit and debit notes | Partially | Qualified tax reviewer | Confirm the rate-version rule for notes (DEC-029) and the reverse-charge mirror |
| V1-VAT-07 tax point | Partially | Qualified tax reviewer | Confirm the tax-point rule (DEC-028: explicit or the issue date; supply date flagged for review) or specify the statutory derivation to build |
| V1-VAT-15 foreign-currency VAT | Missing | Qualified tax reviewer, then engineering (M5c) | The verified rule on converting VAT on foreign-currency supplies; then M5c is specified and built |
| MAN-ACC-09 effective-dated rules | Partially | Product owner (V2 decision) | VAT rates are effective-dated; reporting mappings are versioned in code. Decide whether mappings move into the database with V2 statutory accounts |
| V1-PRIV-01 IP address and user agent | Partially | DPO / legal (DEC-013) | Approve a purpose, lawful basis and retention period; then deletion is built (frozen until then, S4(b)) |

## 4. Security and tenancy assessment (engineering's own; the independent review is a gate)
* **Tenancy:** every tenant table has forced row-level security keyed to the organisation in the transaction; the runtime role cannot bypass it and has DELETE and TRUNCATE revoked; another organisation's records are invisible (tests per module) and company scope is checked in code on every route.
* **Accounting integrity:** only the PostingService writes journals (architecture test); every sub-ledger has one writer; balance, period state, control-account kinds, VAT amounts, mirror reversals and negative cash are re-proven by the database at commit, so a bypass of the application cannot post an unbalanced or out-of-period entry.
* **Separation of duties:** opening balances and control adjustments need a second person; VAT rate versions and exchange rates are verified by someone other than their author; supplier bank detail changes need a second person, and payments made while unverified are flagged on the dashboard.
* **AI:** AI proposals never post or approve; a person always does.
* **Sensitive data:** supplier and company bank details are field-encrypted and shown only masked; reads of full details are audited.
* **Screens:** hide actions the person may not take, and the API refuses them anyway (tested for each slice).
* **Audit:** every posting and every sub-ledger action is in the audit trail with actor, before/after and reason (tested across modules).
* **Not yet done:** an independent security review and penetration test; real-volume performance; the AWS environment (see section 6).

## 5. Reviewer checklists
The workbook `docs/architecture/v1-reviewer-checklists.xlsx` holds the same lists as working sheets (item, where to look, result, reviewer, date). The legal references below are pointers to the provisions each item turns on; **they are not legal advice**, and the reviewer should read the current consolidated text. On 2026-10-17 the following were confirmed through the publishers' pages found by search: VAT Act 1994 s.6, HMRC VATREVCON13000, VATVAL09500 (Sch 6 para 11), VATREC13040/13070/13120 (reg 38 and the case law), VATTOS3600, VAT Notice 700/12, the ICO storage-limitation guidance and the *Breyer* judgment (C-582/14, 19 October 2016). The links to VAT Act 1994 s.8 and s.55A, Sch 6 para 11, reg 38, UK GDPR arts 5 and 6 and the CURIA case page follow the publishers' standard addresses and could not be opened from the build environment (no direct internet access): open them before relying on them.

### 5.1 Qualified tax reviewer (VAT)
1. **Rate versions:** for each tax code the firm will use, enter the rate version with its official source (URL, provision, retrieval date) and verify it as a holder of `tax:rule-verify` who is not its author (DEC-021). Nothing is seeded; the 12.5% in tests is synthetic. Register: `docs/legal/m4b-vat-sources.xlsx`.
2. **Box mappings:** confirm the net and VAT boxes of each rate version against VAT Notice 700/12 (boxes 1, 4, 6, 7; 2, 8, 9 for Northern Ireland goods only).
3. **Rounding:** confirm per-line half-up rounding on net or the VAT fraction of the gross (DEC-025; `tests/unit/vat-math.test.ts`).
4. **Tax point (V1-VAT-07):** confirm that an explicit tax point or the issue date, with the supply date stored and flagged when it differs, is acceptable for the firm's clients, or specify the derivation to automate (VAT Act 1994 s.6; Notice 700 sections 14-15).
5. **Credit and debit notes (V1-VAT-05):** confirm that a note takes the rate version its invoice or bill used and is reported at its own tax point (DEC-029), and the conditions for a valid note (VAT Regulations 1995 reg 38; HMRC VATREC13040 and VATREC13120).
6. **Reverse charge:** confirm which cases the firm will set up as reverse-charge purchase codes (services from abroad, VAT Act 1994 s.8; domestic reverse charge, s.55A and SI 2019/892).
7. **Foreign currency (V1-VAT-15, M5c):** give the rule for converting VAT on supplies in a foreign currency (VAT Act 1994 Sch 6 para 11 and HMRC's permitted rates); until then such sales stay unapprovable for VAT-registered companies (DEC-031).
8. **Workpaper:** review the nine-box workpaper on a test company against hand-calculated figures; it is a workpaper, not a return or a submission (MTD is V5).

### 5.2 DPO / legal (DEC-013, V1-PRIV-01)
1. Read `docs/legal/device-metadata-investigation.md` (every write and read of session and challenge IP address and user agent, with code references; 10 characterisation tests).
2. Decide the purpose and lawful basis for collecting them (UK GDPR art 6), and the retention period (art 5(1)(e) storage limitation; ICO guidance on storage limitation).
3. Note that IP addresses can be personal data in a website operator's hands (CJEU C-582/14 *Breyer*, 19 October 2016) and that rate-limit keys in Redis hold raw IP addresses (listed in the investigation).
4. Approve or amend the retention schedule `docs/legal/retention-verification-schedule.xlsx`; deletion stays frozen until approval.

### 5.3 Security reviewer
1. Review `docs/architecture/security-architecture.md` (protection class per table) and the row-level security and privilege tests (`tests/db/privileges.test.ts`, `tests/db/*.test.ts`).
2. Penetration test the API and web tier on a non-production environment; review session handling, MFA, Origin/CSRF checks, idempotency and rate limits.
3. Review field encryption of bank details and key handling; review the document pipeline (AV scan before use).
4. Review CodeQL, dependency audit, secret scan and Trivy results on the release commit.

### 5.4 Infrastructure (AWS gate)
1. Plan and apply `infra/terraform` in a non-production account; verify encryption, backups, private networking, IAM least privilege and logging.
2. Set the S3 bucket CORS policy for presigned uploads (the statement import uploads through it in production).
3. Run the clean-clone suite and the e2e suite against the deployed environment.
4. Add a Terraform provider lock file (the Dependabot Terraform job fails without one: the `hashicorp/aws ~> 5.80` constraint is unpinned).

### 5.5 Performance (real-volume gate)
1. Load a realistic volume (journals, statement lines, documents) and measure posting, the trial balance, statements, alerts and reconciliation suggestions, which aggregate on each request today.
2. Decide on indexes, caching or materialised balances from the measurements, not before.

### 5.6 Product owner
1. Accept V1 as built and verified for its scope, or list what is missing.
2. Name the qualified tax reviewer and the DPO / legal reviewer (the platform records who verified what, but cannot choose them).
3. Decide MAN-ACC-09 (reporting mappings in the database) as part of V2 planning.
4. Approve or amend the V2 proposal (`docs/architecture/v2-proposal.md`) before any V2 work starts.

## 6. Gates before production (unchanged; DEC-006)
1. Qualified tax reviewer: VAT rules verified (5.1).
2. Privacy: DEC-013 lawful basis and retention approved (5.2).
3. Independent security review (5.3).
4. AWS applied and verified (5.4).
5. Real-volume performance measured (5.5).
6. Product owner's production approval.

## 7. Known limitations of V1 (deliberate)
* Management accounts, not statutory accounts: exact amounts, no FRS 102/105 layout or notes, no year-end closing journal (V2).
* Screens are functional and tested, not designed; no accessibility audit beyond labelled controls.
* API-only: editing draft lines, partial credit and debit notes, attachments, editing or closing bank accounts.
* No document rendering or sending, payment files, direct debit, bad-debt relief, cash or flat-rate VAT schemes, or VAT returns and submission (later versions).

## 8. Legal references used in section 5
| Reference | Link |
|---|---|
| VAT Act 1994, s.6 (time of supply) | <https://www.legislation.gov.uk/ukpga/1994/23/section/6> |
| VAT Act 1994, s.8 (reverse charge on services received from abroad) | <https://www.legislation.gov.uk/ukpga/1994/23/section/8> |
| VAT Act 1994, s.55A (domestic reverse charge) and HMRC VATREVCON13000 | <https://www.legislation.gov.uk/ukpga/1994/23/section/55A>, <https://www.gov.uk/hmrc-internal-manuals/vat-reverse-charge-for-building-and-construction-services-manual/vatrevcon13000> |
| VAT Act 1994, Sch 6 para 11 (foreign currency) and HMRC VATVAL09500 | <https://www.legislation.gov.uk/ukpga/1994/23/schedule/6/paragraph/11>, <https://www.gov.uk/hmrc-internal-manuals/vat-valuation/vatval09500> |
| VAT Regulations 1995 (SI 1995/2518), reg 38 (changes in consideration) | <https://www.legislation.gov.uk/uksi/1995/2518/regulation/38> |
| HMRC VATREC13040, VATREC13070, VATREC13120 (credit and debit notes; case law) | <https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec13040>, <https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec13070>, <https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec13120> |
| HMRC VATTOS3600 (actual tax points) | <https://www.gov.uk/hmrc-internal-manuals/vat-time-of-supply/vattos3600> |
| VAT Notice 700/12 (filling in the VAT return) | <https://www.gov.uk/guidance/how-to-fill-in-and-submit-your-vat-return-vat-notice-70012> |
| Case law on credit notes, as summarised in VATREC13120: *British United Shoe Machinery Co Ltd* (1977) VATTR 187; *Silvermere Golf and Equestrian Centre Ltd* (1981) VATTR 106; *Highsize Ltd* (LON/90/945); *Kwik Fit (GB) Ltd* (1992) VATTR 427 | via VATREC13120 above |
| UK GDPR art 5 (principles) and art 6 (lawful basis) | <https://www.legislation.gov.uk/eur/2016/679/article/5>, <https://www.legislation.gov.uk/eur/2016/679/article/6> |
| ICO guidance, storage limitation | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/> |
| CJEU C-582/14 *Breyer v Bundesrepublik Deutschland* (dynamic IP addresses as personal data) | <https://curia.europa.eu/juris/liste.jsf?num=C-582/14> |
