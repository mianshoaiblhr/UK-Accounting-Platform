# V1 milestone M2 - acceptance package (ledger controls)

Submitted for the product owner's acceptance (DEC-007). **Not accepted until the product owner says so.** M3 has not been started. Nothing here is production approval (DEC-006); development data is synthetic (DEC-003).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `d98e3ed` (branch `claude/adoring-cori-mra6ze`). Later commits are documentation only (`ad1bbf1` matrix rows, `3ac8f46` plan sections 7/8, and the commit carrying this file) |
| CI | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029493> - **success, 9 of 9 jobs**: build/lint/typecheck/unit/integration/e2e, real S3 (moto) + real ClamAV, dependency audit + gitleaks, migrations-from-scratch, terraform (fmt/init/validate), images api/worker/web/migrate with the Trivy gate |
| CodeQL | <https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/37933029188> - **success** |
| Clean clone of `d98e3ed` | install, build, typecheck, lint exit 0; `pnpm test` **68 files, 1303 tests passed, 0 failed, 0 skipped** (M1: 64 / 1170); `pnpm test:e2e` 4/4 passed; `pnpm openapi` no drift |
| Local full run on the same code tree | 70 files, 1319 tests passed, 0 failed (19 skipped locally: the real-S3 / real-ClamAV infrastructure tests, which run in their own CI job) |
| Terraform | validation only (as in V0): **no infrastructure has been applied or verified in AWS** |

## 2. What M2 delivers (V1 plan section 4, DEC-012, ADR-49 and ADR-54)
Opening balances and control-account adjustments are **requested, not posted**. A request is validated like a journal (by a PostingService dry run) but is not a ledger entry. It is posted by the PostingService only when a **different person holding `ledger:approve`** approves it, or at once when the company's policy exempts a request at or below its materiality threshold. Posted journals stay immutable; correction is a reversal. All behind flag `bookkeeping.core`; API only (DEC-002), no UI.

* **Four new COMPANY permissions:** `ledger:opening-balance` (owner/admin/partner), `ledger:control-adjustment` (owner/admin/partner/accountant), `ledger:approve` and `ledger:policy` (owner/admin/partner).
* **Endpoints:** `POST opening-balance-requests`, `POST control-adjustment-requests`, `GET journal-requests[?status&kind]`, `GET journal-requests/{id}`, `POST journal-requests/{id}/approve|reject|cancel`, `GET|PUT ledger-policy`.
* **Rules:** reason of at least 20 characters; control adjustments need at least one readable evidence document of the same company and must touch a control account; opening balances need evidence when approval is required; the first-day-of-first-period rule is kept; AI can neither request nor approve; reject needs a reason; only the requester cancels; a request expires (default 14 days) and cannot then be approved.
* **Policy per company:** `ALWAYS` (default) or `ABOVE_THRESHOLD` (strictly greater than a configured threshold). There is deliberately **no "never" mode**; permission, reason, evidence and audit always apply. Changing the policy needs `ledger:policy` and a reason and is audited before/after.
* **Traceability:** the journal records `request_id`, requester and approver; its `source_id` is the request; the request's evidence documents are linked journal -> document in the evidence graph; the requester is notified of the decision (no amounts in the notification).

## 3. Migration
`20260107000000_v1_ledger_controls` (additive, applied from scratch in CI and by the populated-database upgrade test as a non-superuser owner): tables `journal_request` and `ledger_policy` (forced RLS; `DELETE`/`TRUNCATE` revoked; delete/truncate triggers); three nullable columns on `journal`; `journal_insert_guard` extended (a request-based journal must match a PENDING, unexpired request of the same kind/company/total/date/requester, approved by someone else, or by the requester only when the request was policy-exempt); request-content immutability and one-way status trigger; check constraints for outcome, separation of duties, cancel-by-requester, self-approval consistency, policy modes, threshold and expiry range; `journal` accepted as an evidence-link type; four permissions added to the system roles; retention rows for the two new tables (classification only - **no retention period is approved or enforced**). The check `journal_request_link_ck` is `NOT VALID`: it applies to every new journal; pre-M2 development rows are not rescanned.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Role x capability matrix for the four new permissions (8 roles x 4 probes, allowed iff the role holds the permission) plus 22 explicit cases through the API | `tests/api/permissions.test.ts`, `tests/api/ledger-controls.test.ts` |
| A holder of only `journal:post` (manager, accountant) can no longer post an opening balance; `POST /journals` refuses `OPENING_BALANCE` and `CONTROL_ADJUSTMENT` | `tests/api/ledger-controls.test.ts`, `tests/api/ledger.test.ts` |
| The requester cannot approve their own request - in the service **and in the database** (journal guard and status trigger, exercised as the runtime role) | `tests/api/ledger-controls.test.ts`, `tests/db/ledger-controls.test.ts` (13), `tests/platform/ledger-requests.test.ts` (5) |
| Concurrent approvals post exactly one journal; approve vs reject vs cancel races end with one outcome and no stray journal | `tests/api/ledger-controls.test.ts` |
| Threshold boundary: equal to the threshold is exempt, one penny above needs a second person; policy in force at request time governs the request; exemption never waives permission, reason or evidence | `tests/api/ledger-controls.test.ts`, `tests/platform/ledger-requests.test.ts` |
| A period closed between request and approval refuses the approval and leaves the request pending; expired requests cannot be approved; reject/cancel leave the ledger untouched; trial balance ignores pending requests | `tests/api/ledger-controls.test.ts` |
| An approved adjustment is corrected by reversal (links both ways); posted journals cannot be updated or deleted | `tests/api/ledger-controls.test.ts`, `tests/db/ledger.test.ts` |
| AI actors are refused (create, approve, reject, direct post); a forged request, missing permission or wrong source reference is refused by the PostingService; a request id that does not exist is stopped by the database | `tests/platform/ledger-requests.test.ts` |
| Tenant and company isolation: another company's path gives 404, another organisation sees zero rows and cannot insert; a member assigned to another company gets 404 | `tests/api/ledger-controls.test.ts`, `tests/db/ledger-controls.test.ts` |
| Single writer: only `requests.ts` writes `journal_request` / `ledger_policy`; only `posting.ts` writes journals and sets the posting switch; platform/AI/worker cannot import the accounting package | `tests/unit/architecture.test.ts` |
| Privileges: no `DELETE`/`TRUNCATE` on the new tables for the runtime role; triggers stop the owner too | `tests/db/privileges.test.ts`, `tests/db/ledger-controls.test.ts` |
| Audit: `ledger.request_created/approved/rejected/cancelled`, `ledger.policy_changed`, and `journal.posted` metadata (request, requester, approver, self-approved) | `tests/api/ledger-controls.test.ts` |
| Evidence graph: `journal` is an evidence end; reading follows `ledger:read`; restricted documents are indistinguishable from missing ones | `tests/api/ledger-controls.test.ts` |

## 5. Test results for the new work
| File | Tests |
|---|---|
| `tests/api/ledger-controls.test.ts` | 57 |
| `tests/db/ledger-controls.test.ts` | 13 |
| `tests/platform/ledger-requests.test.ts` | 5 |
| `packages/contracts/src/ledger.test.ts` | 13 (4 new) |
| Updated for the new behaviour: `tests/platform/posting-service.test.ts` (34), `tests/api/ledger.test.ts`, `tests/db/ledger.test.ts`, `tests/api/permissions.test.ts`, `tests/db/privileges.test.ts`, `tests/unit/architecture.test.ts` (22), `tests/api/regression.test.ts` | |

## 6. Compliance-matrix changes (`v1-compliance-matrix.md|json|xlsx`, 113 rows, plan version 2.1)
IMPLEMENTED 27 -> **32**, PARTIALLY IMPLEMENTED 12 -> **12**, MISSING 74 -> **69**. Closed with evidence: V1-CTL-07 (dedicated permission), V1-CTL-08 (control-account adjustments with reason/evidence/audit), V1-CTL-09 (configurable second-person approval), V1-CTL-10 (requests are not ledger entries; immutability; reversal; AI refused), V1-CTL-11 (opening-balance fence replaced by permission + approval, first-day rule kept). V1-CTL-06 (audit trail) evidence extended and left PARTIAL on purpose (source modules add their events in M5+). No row was added or removed; M3+ rows are unchanged and still gated. V0 documents and the V0 readiness report were not touched.

## 7. Findings and fixes during the milestone
* **Real defect found by the new tests and fixed:** in `PostingService`, when the database refused an insert, the transaction was already aborted and the `finally` statement that switches the posting flag off threw its own error, hiding the real one. The reset is now best-effort (the flag is transaction-local); a test covers it.
* **The first full run found 3 failures, none a product defect:** the V0/M1 boundary test and the document-read architecture test needed to learn the approved M2 tables and the request evidence read (intentional, recorded changes - they still forbid invoicing, VAT, tax, payroll and filing tables); and an MFA characterisation test (privacy track) failed with `429`. **Root cause:** the test used fixed IP addresses and rate-limit counters live in Redis for up to an hour, so repeated local runs hit the limit. It never failed in CI (fresh Redis). The tests now use a fresh reserved-range address per run (I first suspected TOTP step rollover; the added diagnostics showed it was the rate limit; the rollover retry stays as harmless hardening).
* No test was skipped, weakened to pass, or deleted. Existing M1 tests that posted opening balances directly were rewritten to the request flow (the behaviour change below).

## 8. Behaviour changes versus M1 (by design, recorded)
`POST /journals` no longer accepts `OPENING_BALANCE` (422); opening balances need `ledger:opening-balance` and an approved request instead of `journal:post`; control accounts accept only `OPENING_BALANCE`, `CONTROL_ADJUSTMENT` and `REVERSAL`.

## 9. Known limitations
1. **API only:** no screen or dashboard for pending requests; approvers must use the API until M9. Approver notifications and a pending-requests dashboard are deferred (M8/M9), as are per-account rules, delegation, multi-step chains and workflow-engine integration.
2. **Defaults are proposals awaiting your confirmation:** approval `ALWAYS`, expiry 14 days. There is no built-in threshold; a company that wants `ABOVE_THRESHOLD` must configure one.
3. Expiry is evaluated at decision time (no sweeper): an expired request stays PENDING in storage and reads as `EXPIRED`. It changes nothing in the ledger.
4. Still single-currency (`foreign_currency_not_supported`, M3); no VAT (M4); no source documents (M5+); the posting switch is application-asserted (same trust boundary as the tenant context); trial balance and general ledger are computed on demand and posting is serialised per company (untested at real volume - a production gate).
5. Privacy finding DEC-013 (`session.ip`, `session.user_agent`, `auth_challenge.ip`) remains **unresolved** pending qualified review; retention periods and lawful basis remain unapproved (DEC-003, DEC-014); S3, S7 and S4(b) remain deferred/frozen.
6. Production gates are unchanged: privacy/retention review, security review, AWS apply and verification, real-volume performance. Nothing is production-approved.

## 10. Decisions needed from the product owner before M3
1. Accept M2 (or list changes), including confirmation of the defaults in limitation 2.
2. **Exchange-rate source** and lookup window (manual only, an official published series, or a commercial provider) - blocks M3.
3. **Rounding policy and revaluation policy** (which items, which rate, auto-reverse) - blocks M3.
4. For M4 (not yet started): the named qualified reviewer who verifies VAT rules and the verification record format.
