# V13 — MTD Income Tax / Self Assessment

Added by DEC-081 (2026-10-27). The product owner decided to write this specification now and build it against HMRC's sandbox. No earlier version (V0 to V12) covers Income Tax for individuals.

## Objective
Give an accounting practice one place to keep the records of its sole-trader and landlord clients, and to send what HMRC requires for Income Tax:
* the quarterly updates of Making Tax Digital for Income Tax (MTD IT);
* the end-of-year adjustments and final declaration;
* the Self Assessment return (SA100) for clients outside MTD IT.

The figures come from the ledger. No module keeps a second set of figures (manifest: "The General Ledger is the accounting source of truth").

## Who it serves
* **Clients:**
  * sole traders (self-employment income);
  * landlords (UK property income);
  * individuals with both, with one ledger per income source.
* **Not in V13:**
  * partnerships: MTD IT does not yet apply to them; their own return (SA800) is a later milestone;
  * foreign property income;
  * capital gains;
  * employment income, except reading what HMRC already holds.
* **People in the practice:** a preparer, a reviewer, and the person holding the agent authorisation who submits. The client approves before the final declaration.

## Status of the rules
Every date, threshold, category and box reference in this document is **UNVERIFIED** (DEC-022): the build environment cannot read gov.uk, legislation.gov.uk or HMRC's API documentation. The platform holds these rules as effective-dated data. A holder of `tax:rule-verify`, who is not the person who entered a rule, verifies it before it can be used, as for VAT (DEC-021).

## Milestones
1. **V13-M0, HMRC connection (shared with V5):** built once, in the HMRC adapter that V5 specifies, behind the port-and-adapter pattern of V0:
   * OAuth 2.0 user-restricted access, for the agent and for an individual;
   * encrypted token storage per client;
   * HMRC's fraud-prevention headers with the connection method `WEB_APP_VIA_SERVER`;
   * a fake adapter for tests;
   * a sandbox implementation, proven against HMRC's Test Fraud Prevention Headers API.

   If V5 has not built the adapter yet, V13-M0 builds it to V5's interface.
2. **V13-M1, the taxpayer and income sources:**
   * an individual taxpayer record, with the NI number and UTR encrypted and masked like supplier bank details (DEC-023);
   * the agent authorisation, main agent or supporting agent;
   * the income sources from HMRC's Business Details API: self-employment and UK property;
   * the accounting type, cash or accruals;
   * periods of account;
   * the sign-up status for MTD IT, with the reason (qualifying income over the threshold, or voluntary).
3. **V13-M2, obligations and quarterly updates:**
   * the obligations read from HMRC, never derived locally;
   * each update cumulative from 6 April, summed on the server from the journal lines of the period through each account's HMRC category (DEC-080);
   * a draft that the preparer reviews;
   * on submission, a snapshot of the exact payload, its hash, the response and the receipt, with an idempotency key so the same update is never sent twice;
   * a correction is a new cumulative update, never an edit of a sent one.
4. **V13-M3, HMRC's calculation:**
   * trigger and retrieve HMRC's in-year calculation after an update, and show HMRC's figures as HMRC sent them;
   * the platform does not compute an individual's Income Tax liability on its own.
5. **V13-M4, end of year and final declaration:**
   * accounting adjustments through HMRC's Business Source Adjustable Summary;
   * allowances and losses;
   * the final calculation;
   * the client's approval of the calculation, recorded with the same fingerprint pattern as the accounts approval (DEC-070);
   * the final declaration, submitted by a user holding the agent authorisation, with HMRC's declaration text shown;
   * the declaration is never submitted by AI or by the system (manifest control 10).
6. **V13-M5, Self Assessment for clients outside MTD IT:**
   * the SA100 with the self-employment (SA103) and property (SA105) pages, filled from the same ledger mapping;
   * filed through HMRC's Self Assessment online filing channel for software. That channel's recognition and test process (vendor ID, test service) is a separate HMRC application and is UNVERIFIED here.
7. **V13-M6, screens:**
   * the practice and client screens follow the design prototype (DEC-079): obligations as a row of steps with the current one in signal blue, and cumulative figures with ruled totals;
   * HMRC's estimate shown only once HMRC returns it;
   * real-browser tests (DEC-050).

## Rules the build must follow (UNVERIFIED until verified as above)
* **Who is in MTD IT:** qualifying income over £50,000 from 6 April 2026, then £30,000 from 6 April 2027 and £20,000 from 6 April 2028. Qualifying income is self-employment plus property turnover, from the return two years earlier. Exemptions include digital exclusion (see *LH Bishop Electric*, below).
* **Quarterly periods:**
  * standard periods: 6 April to 5 July, 6 July to 5 October, 6 October to 5 January, 6 January to 5 April;
  * a client may elect calendar quarters;
  * each update is due by the 7th of the month after the period.
* **Final declaration:** by 31 January after the tax year.
* **Penalties:** late updates and late final declarations earn points under the Finance Act 2021 regime, and late payment has its own charges. The deadline engine records points per obligation; it never sets a penalty.
* **Records:** digital records of each transaction. Digital links only between the records and the submission: no copying and pasting of figures (Income Tax (Digital Requirements) Regulations 2021).

## Controls
* **Who may act:**
  * permissions `itsa:read`, `itsa:prepare`, `itsa:submit` and `itsa:declare`, at client level;
  * `itsa:declare` needs the main-agent authorisation.
* **Figures:** a submission is refused when the period has unposted drafts, or when an account used in it has no verified HMRC category.
* **Audit:**
  * every HMRC call is logged with its request id, fraud-prevention headers, the payload hash and the response, in the audit trail;
  * personal data is masked in logs.
* **Production:** production access is an explicit gate, like DEC-006. The blueprint reports that HMRC has paused new production-access requests for MTD IT software for 2026/27 (UNVERIFIED). Until the owner records otherwise, V13 runs in the sandbox only, behind a feature flag that is off.

## Acceptance
* **Tests:** unit and integration tests against the fake adapter, following the posting-rule coverage registry pattern (DEC-047).
* **Sandbox contract tests:** these run only where HMRC sandbox credentials and network access exist, and are reported as skipped elsewhere. They are never faked as passing.
* **Golden workings:** a hand-calculated synthetic sole trader and landlord, with the expected category totals for each cumulative update, reviewed by the named accountant (DEC-054 pattern).
* **Screens:** real-browser tests for the main path, a refusal and a read-only user (DEC-050).

## Blockers the owner must clear
1. **Sandbox credentials:** a sandbox application on HMRC's Developer Hub, subscribed to the MTD IT APIs and the test-user and fraud-prevention test APIs. Its client id and secret go into the environment's secrets, never into the repository.
2. **Network access:** the build environment must be allowed to reach HMRC's sandbox host (`test-api.service.hmrc.gov.uk`). Its network policy blocks it today.
3. **Production:** HMRC's production-access route for MTD IT software once HMRC reopens it.

## Legal basis
Primary sources were not read in this environment. Each link must be checked before a rule is verified. This is not legal advice.

| Source | Relevance | Link |
|---|---|---|
| Taxes Management Act 1970, Schedule A1 (inserted by Finance (No. 2) Act 2017, s60 and Sch 14) | Digital records and quarterly updates for Income Tax | https://www.legislation.gov.uk/ukpga/1970/9/schedule/A1 |
| Income Tax (Digital Requirements) Regulations 2021, SI 2021/1076, as amended | Who is in MTD IT, periods, updates, digital links, exemptions | https://www.legislation.gov.uk/uksi/2021/1076/contents/made |
| Taxes Management Act 1970, s8 and s12B | The personal return and the duty to keep records | https://www.legislation.gov.uk/ukpga/1970/9/section/12B |
| Income Tax (Trading and Other Income) Act 2005, Part 2 (s25, s25A, s34) | Trading profits: accounting basis, cash basis, wholly and exclusively | https://www.legislation.gov.uk/ukpga/2005/5/section/34 |
| Income Tax (Trading and Other Income) Act 2005, Part 3 (s272A, s311A) | Property income: residential finance costs, replacement of domestic items | https://www.legislation.gov.uk/ukpga/2005/5/section/272A |
| Finance Act 2021, Schedules 24 and 26 | Points-based late-submission penalties; late-payment penalties | https://www.legislation.gov.uk/ukpga/2021/26/schedule/24 |
| HMRC Developer Hub, API documentation | Business Details, Obligations, Self Employment Business, Property Business, Individual Calculations, Business Source Adjustable Summary, Individual Losses (all MTD) | https://developer.service.hmrc.gov.uk/api-documentation |
| HMRC fraud prevention guidance | Required headers and their validation | https://developer.service.hmrc.gov.uk/guides/fraud-prevention/ |

| Case | Relevance | Link |
|---|---|---|
| *LH Bishop Electric Co Ltd v HMRC* [2013] UKFTT 522 (TC) | Compulsory online filing must allow for people who cannot use it: the exemption route must exist | https://www.bailii.org/uk/cases/UKFTT/TC/2013/TC02912.html |
| *Donaldson v HMRC* [2016] EWCA Civ 761 | Penalties for late returns and what HMRC must notify: the deadline engine shows HMRC's notices, not its own | https://www.bailii.org/ew/cases/EWCA/Civ/2016/761.html |
| *Perrin v HMRC* [2018] UKUT 156 (TCC) | The test for a reasonable excuse: the platform keeps the evidence a practice would rely on | https://www.bailii.org/uk/cases/UKUT/TCC/2018/156.html |
| *Samadian v HMRC* [2014] UKUT 13 (TCC) | "Wholly and exclusively" for a sole trader's travel: why categories need review, not automatic mapping | https://www.bailii.org/uk/cases/UKUT/TCC/2014/13.html |
