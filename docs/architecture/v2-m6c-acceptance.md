# V2 milestone V2-M6c - acceptance package (partner review, client approval, locking and the filing-ready package)

Prepared under the product owner's delegation (DEC-019, DEC-051). The design is in DEC-070, recorded before code.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic. The filing-ready package is **not a filing**: iXBRL tagging and submission to Companies House are V3.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | @@COMMIT@@ (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5j and DEC-070 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M6c delivers (v2-plan section 5j)
| Part | What it is |
|---|---|
| The fingerprint | The SHA-256 of the accounts document in canonical JSON (keys sorted), without its notices; it exists only while the document is complete. It ties the three records together |
| Partner review (step 12) | Recorded by a holder of `accounts:review` once steps 1 to 11 are done. The reviewer must not be the person whose live sign-off of step 11 generated the accounts. It stores the fingerprint and LAPSES when the accounts change, after which a new review is recorded |
| Client approval (step 13) | Recorded by a holder of `accounts:review` and `period:lock`. It names the approving director, the date and an evidence document (of the company, scanned clean, visible to the recorder). The director and date must equal the approval the accounts state (the facts `approval.director` and `approval.date`; Companies Act 2006 s.414). The date is after the year end and not in the future, and the director served on it. It needs a live partner review and every period of the year closed. One per year |
| Locking | In the same transaction as the approval, each closed period of the year is locked through the period service, audited with the approval as reason, and the year's framework gets `locked_at`. After that, the year's facts, flag responses, workflow sign-offs and reviews are refused (`year_approved`); its periods cannot be unlocked; postings into it are refused (locked periods) |
| Filing-ready package (step 14) | Generated once per year by a holder of `accounts:prepare` and stored write-once with its own SHA-256. It holds the approved accounts document, the fingerprint, the framework and who verified it, the size test, the partner review and the client approval. It is refused unless the year is approved, the accounts are unchanged since then and every rule used was verified by a second person (V2-ARC-04) |
| Workflow | Steps 12 to 14 are no longer LATER (the state is removed). Each is DONE through its own record and refused as a workflow sign-off or reopen (`step_own_record`). Step 12 now waits for steps 1 to 11; DEC-070 amends DEC-069 here |
| API | 5 operations, all in OpenAPI and behind `accounts.production`: `accounts-approval` (GET), `accounts-approval/partner-review`, `accounts-approval/client-approval`, `accounts-package` (GET and POST) |

**Migration:** `20260129000000_v2_accounts_approval` (additive).
* **`accounts_approval`:**
  * forced row-level security;
  * UPDATE, DELETE and TRUNCATE revoked;
  * checks on the stage, the fingerprint, the note, and the client fields by stage;
  * one client approval per year;
  * a trigger enforcing the second-person rule, the review of the same accounts, the date after the year end, the serving director and the company's evidence.
* **`accounts_package`:**
  * forced row-level security;
  * UPDATE, DELETE and TRUNCATE revoked;
  * one per year;
  * a trigger: the year is locked, a client approval of the same fingerprint exists, and the version was verified by a second person.
* **Triggers on existing tables:**
  * `crf_guard` is replaced: a framework is locked only by its client approval, and nothing else changes as it is locked;
  * a period of an approved year cannot leave LOCKED;
  * `accounts_fact`, `review_flag_response`, `year_end_step_signoff` and `accounts_approval` take no rows for a locked year.
* **Retention:** ACCOUNTING_RECORDS for both tables.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m6c-approval.json` was written by hand before the code. `docs/architecture/v2-m6c-golden-workings.xlsx` re-derives every control, state and refusal in Python, with an independent implementation of the rules: 112 checks, 0 differences.

* **The company:** the V2-M6b company moved back one year, so that an approval date after the year end is not in the future. It has:
  * a director;
  * two synthetic wording rules: the employees note and the approval statement;
  * the approval facts (16 March 2026);
  * steps 1 to 10 signed off by the accountant and step 11 by the partner.
* **The six phases**, with all 14 states each:
  1. **The accounts generated.** The partner, who signed off step 11, is refused as reviewer; approval and the package are refused as blocked; step 12 cannot be signed off through the workflow.
  2. **The owner reviews.** Approval is refused as not ready because the period is open; a second review is refused.
  3. **The employees fact changes from 1 to 2.** The fingerprint changes and the review LAPSES.
  4. **The owner reviews again and the period is closed.** Approval is refused for another director, for another date, for missing evidence, and for the accountant (403).
  5. **The partner records the approval.** The period is LOCKED and the framework locked. A fact, a workflow reopen, a review, a flag reopen and an unlock are refused (`year_approved`); a journal is refused (`period_locked`).
  6. **The package is generated.** It holds the director's name, the date, the verified version, the size test and the approval wording; a second package is refused.
* **Hand figures:** every state and refusal code matched on the first run. One hand expectation was corrected: the approval wording is two paragraphs (a line break starts a new paragraph, V2-M5a), not one text with a line break. The correction is recorded in the golden file.
* **The V2-M6b golden is revised:** steps 12 to 14 changed from LATER to their V2-M6c states, and the refusal `step_later` became `step_own_record`. The revision is recorded in the golden file, and its workbook still checks 79 items with 0 differences. The V2-M6b acceptance evidence at 9868fbc stands as recorded.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Partner review needs `accounts:review` and a second person; approval needs `accounts:review` and `period:lock`; the package needs `accounts:prepare`; a reviewer or accountant gets 403; another organisation sees nothing | `tests/api/accounts-approval.test.ts` |
| The approval evidence is read with the recorder's per-document visibility (ADR-32) | `tests/unit/architecture.test.ts` ('documents are read only where per-document visibility is applied') |
| Rows are written once; the second-person rule, the review of the same accounts, the date, the director and the evidence hold in the database; a framework is locked only by its approval and never changes after; the locked year takes no facts, responses, sign-offs or reviews; its periods stay locked; the package is refused for a year not approved, for other accounts or under a version never verified; another organisation sees nothing | `tests/db/accounts-approval.test.ts`, `tests/db/privileges.test.ts` |
| The fingerprint, the approval date rule and the package gate on every combination of its conditions | `tests/unit/accounts-approval.test.ts` |
| The state rules on 2,000 random combinations, with step 12 waiting for steps 1 to 11 | `tests/unit/year-end-workflow.test.ts` |
| Approvals and packages have one writer. It locks periods only through the period service and the framework only through the framework service, and never posts. V2-ARC-01 is widened to the approval service finding the framework year (recorded here). The period service does not read the framework: it translates the database's refusal | `tests/unit/architecture.test.ts` |
| The new tables are classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v2.3 (61 rows: Implemented 59, Partially 1, Missing 1).
* **Missing -> Implemented:** V2-MOD-15, V2-YE-12, V2-YE-13 and V2-YE-14.
* **Partially -> Implemented:**
  * V2-MOD-01 (all 14 steps);
  * V2-ARC-04 (the filing-ready refusal of unverified rules). This row covers **the mechanism only**: no real standard content or threshold is verified yet.
* **V2-TEST-01** gains the V2-M6c golden. It stays Partially until an FRS 102 Section 1A scenario exists and Shoaib reviews the V2-M4 to V2-M6c goldens.
* **Still Missing:** V2-DOD-01, the screens (V2-M7).

## 6. Known limitations
1. **No withdrawal of an approval, and no amended accounts.** An approved year stays locked; reopening it is a later decision.
2. **Inputs outside the year's records are not locked:** the company's name or number, its officers, and the prior year's ledger. A change to them changes the fingerprint, shows steps 12 to 14 as LAPSED and refuses the package. It does not change what was approved.
3. **The fingerprint covers the accounts document as rendered.** Two documents with the same figures and wording but a different statement order would differ; the order comes from the verified version and is stable.
4. **The approval date is not compared with the partner review's date.** An approval made before the accounts reached the platform is recorded with both dates (DEC-070).
5. **Filing deadlines are not computed.** They are legal rules (Companies Act 2006 s.442), to be entered as verified data later.
6. **Not in this milestone:**
   * iXBRL and Companies House filing (V3);
   * screens (V2-M7).
7. **Production gates unchanged:**
   * standard content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
