# V7 milestone V7-M1 - acceptance package (the compliance calendar)

**Status:** ACCEPTED under the delegation (DEC-019, DEC-086) on 2026-10-27, on the green CI run recorded in section 1.

The design is in DEC-088 and `docs/architecture/v7-plan.md`, recorded and pushed before code (`b22ac37`). This is milestone evidence only, **not production approval** (DEC-085 sets the go-live checklist). All data is synthetic. The screens show what the API returns and compute nothing (DEC-048, DEC-071).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `315b801` (API), `b8324ff` (screens), `408453c` (privilege matrix); CI on `53c88b5`, which contains them |
| CI | [ci run 184](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40596762720): all nine jobs green (build, lint, typecheck, unit, integration and real-browser tests; migrations from scratch; Terraform; dependency audit and secret scan; S3 and ClamAV; the four images with their Trivy scans) |
| Local runs | see section 6 |

## 2. What was built
| Part | Where |
|---|---|
| Due-date arithmetic, request schemas, kinds and statuses | `packages/contracts/src/compliance.ts` |
| Permissions `compliance:read`, `compliance:manage` (company), `compliance:rules-manage`, `compliance:rule-verify` (organisation) | `packages/contracts/src/permissions.ts` |
| Feature flag `practice.management` | `packages/contracts/src/features.ts` |
| Tables `deadline_rule`, `company_compliance_profile`, `compliance_obligation`: guards, forced RLS, role grants, retention classification | `packages/db/prisma/migrations/20260131000000_v7_compliance_calendar` |
| Service: rules, profile, generation, obligations, practice views | `packages/accounting/src/compliance.ts` |
| API: 13 operations, documented in the OpenAPI contract | `apps/api/src/compliance/compliance.controller.ts`, `docs/api/openapi.json` |
| Screens: the client's deadlines; the practice's deadlines with counts | `apps/web/src/app/org/[orgId]/companies/[companyId]/compliance`, `apps/web/src/app/org/[orgId]/deadlines` |
| Draft deadline rules (UNVERIFIED) and their import tool | `content/compliance/drafts/`, `scripts/compliance/import-deadline-rules.mjs` |
| The rules on the verifier's worksheet | `docs/legal/rule-verification-worksheet.xlsx`, sheet "Deadline rules" |

## 3. Screens and the routes each uses (DEC-050)
| Screen | Shows | Actions (permission) | API routes |
|---|---|---|---|
| Client deadlines (`/org/{org}/companies/{company}/compliance`, "Deadlines" in the Compliance group of the sidebar) | The client's obligations by window (all, open, overdue, next 90 days), with the API's status and overdue flag; the confirmation date | Create deadlines from the verified rules (reports what was skipped and why); change status, done date and reference with a reason when the API asks; set the confirmation date; enter a deadline by hand (`compliance:manage`) | `GET/POST compliance/obligations`, `PATCH compliance/obligations/{id}`, `POST compliance/generate`, `GET/PUT compliance/profile` |
| Practice deadlines (`/org/{org}/deadlines`, linked from the company list) | Four counts (overdue, due in 14 days, waiting on the client, ready); the deadlines across the clients the person may read, by window, with a link to each client | None | `GET compliance/summary`, `GET compliance/obligations` |

**What the screens choose themselves:** the window, the labels of kinds and statuses, and which actions to offer from the person's permissions. **What they do not compute:** no due date, count or overdue flag.

## 4. Tests
* **Unit** (`packages/contracts/src/compliance.test.ts`, 11 tests):
  * month addition across years and into shorter months;
  * the month-end rule, including 28 and 29 February;
  * the three-step order (days, months, days);
  * the overdue rule and the request schemas.
* **API** (`tests/api/compliance.test.ts`, 22 tests):
  * every role's access to rules and obligations;
  * a rule starts UNVERIFIED, overlap refused, self-verification refused, verification once, supersession;
  * generation uses only verified versions, reports skipped and not-applicable kinds, and is idempotent;
  * the database guards on rules and obligations;
  * versioned updates and every reason rule;
  * evidence from another client refused;
  * the practice views over only the readable clients, by due window, with cursor pages;
  * the counts per person;
  * the feature flag;
  * importing the draft pack lands UNVERIFIED and needs `compliance:rules-manage`.
* **RBAC matrix** (`tests/api/permissions.test.ts`): four new probes across every system role.
* **Browser** (`tests/e2e/compliance.test.ts`, 5 tests):
  * a manager creates the deadlines from a verified synthetic rule and is told VAT does not apply;
  * a refusal is shown in the API's words;
  * a change is saved;
  * the practice page shows the API's count and links back;
  * a reviewer sees no action;
  * with the feature off both pages say so.

## 5. Security and permission checks
| Check | Evidence |
|---|---|
| A practice-wide list or count includes only clients where the caller holds `compliance:read` | `tests/api/compliance.test.ts` (assigned accountant) |
| Another organisation sees nothing (404) | `tests/api/compliance.test.ts` |
| A rule is verified only by a second person; verification is one-way; a version is immutable | API and database tests |
| An obligation is never deleted; what it is never changes; every update advances its version | database tests |
| Evidence must be a readable document of the same client | `tests/api/compliance.test.ts` |
| Every change is audited with its reason | `tests/api/compliance.test.ts` |
| The new tables are classified (RLS+APP) and documented | `tests/db/classification.test.ts`, `docs/architecture/security-architecture.md` |

## 6. Local runs
Recorded from the full local run of build, typecheck, lint, unit and integration tests and e2e on the code baseline.

## 7. Known limitations (recorded in DEC-088)
* No rule is verified: every deadline is skipped as `rule_unverified` until Shoaib verifies the draft rules in the platform (DEC-083).
* First accounts, accounting periods longer than 12 months for Corporation Tax, public companies, large companies' instalments and extensions are entered by hand with a reason.
* MTD Income Tax obligations wait for V13; PAYE is not in scope.
* Nothing is filed: DONE is recorded by a person with evidence (DEC-082, DEC-086).
* The practice dashboard (work by stage, connections) and the client list are V7-M2.
