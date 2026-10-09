# V0 Architecture Change Set — Practice level, layered authorisation, workflow, AI states, naming

Status: **approved by the product owner (D1, D2, D3, D5, D6) and IMPLEMENTED; this document records the design and the as-built behaviour (§8).**
Scope: V0 architecture only. No bookkeeping, ledger, VAT or filing functionality is introduced.

## 1. Decision: Practice is a distinct entity *under* Organisation

**Recommendation (adopted): add `practice` as a child entity of `organisation`; do not specialise Organisation into a nested tenant.**

| | Option A — Practice as entity under Organisation (chosen) | Option B — specialise Organisation (Organisation may own sub-organisations / practice *is* an organisation) |
|---|---|---|
| Tenant boundary | One: `organisation_id`. RLS, composite FKs, outbox, audit, jobs unchanged. | Two kinds of tenant; a practice would need *cross-tenant* access to client organisations → RLS would need cross-tenant grants. |
| Billing | Organisation is the single billing/subscription owner. | Ambiguous (who pays: practice or client org?). |
| Direct business | Organisation of type `BUSINESS`, no practice, companies use the same engine. Not forced to "pretend" to be a practice. | Same, but needs a null parent and recursive ownership rules. |
| Isolation risk | Lowest: nothing crosses an organisation boundary. | Highest: every query must reason about a tree. |
| Future flexibility | Multiple practices per organisation (offices/teams). A *cross-organisation* engagement (a client business that already has its own organisation inviting a practice) can later be added as an explicit grant table without changing this hierarchy. | Flexible but harder to constrain. |

Hierarchy: `Platform → Organisation → Practice (PRACTICE organisations only) → Company → Accounting period`.
A `BUSINESS` organisation has companies directly (no practice). One accounting/period/workflow engine serves both — nothing downstream of `company` knows whether a practice exists.

### 1.1 Canonical ownership model (single source of truth for each fact)
| Fact | Stored in | Rule |
|---|---|---|
| Tenant owner and billing account of everything | `organisation.id` (denormalised as `organisation_id` on every tenant row, as today) | Canonical. Never changes. RLS key. |
| Mode (practice vs direct) | `organisation.type` (`PRACTICE`\|`BUSINESS`) | Only place the mode is stored. |
| Practice belongs to | `practice.organisation_id` | Only allowed when `organisation.type = PRACTICE` (trigger). |
| Company is *owned* by | `company.organisation_id` | Canonical owner. |
| Company is *managed* by | `company.practice_id` (nullable) | **Explicit relationship.** Required when the owning organisation is `PRACTICE`, forbidden when `BUSINESS` (trigger). Composite FK `(organisation_id, practice_id) → practice(organisation_id, id)` makes a company/practice pair from different organisations structurally impossible, so the two columns cannot become inconsistent. |
| User ↔ organisation | `organisation_membership` | Active membership is the precondition for everything. |
| User ↔ practice | `practice_membership` (role) | Grants practice permissions and, as the default, the role on that practice's companies. |
| User ↔ company | `company_membership` (role) | Most specific grant; replaces broader grants for that company. |

Implications — **database:** every new table carries `organisation_id`, composite FKs to its parents, forced RLS. **Billing:** subscription/seat counting attaches to `organisation` only (practice and company are not billable units; seats = distinct active `organisation_membership` users). **Permissions:** see §3. A practice **cannot** reach a company it is not related to: reach requires either `company.practice_id` = the practice *and* a `practice_membership` (or an explicit `company_membership`), never mere organisation membership.

## 2. Entity-relationship changes
```
user ──< organisation_membership >── organisation ──< practice ──< company ──< accounting_period
              │  (role, reach ALL|ASSIGNED)    │            │          │
              │                                 │            │          └──< company_membership (role)   (was company_assignment)
              └──< practice_membership (role) ──┘            └─ company.practice_id (nullable, composite FK, trigger-enforced)
role (system org_id NULL | custom per org)  ← referenced by all three membership tables (same-org trigger)
```
New: `practice`, `practice_membership`. Changed: `company` (+`practice_id`), `company_assignment` → `company_membership` (+`role_id`), `membership` → `organisation_membership`, `workflow_instance`/`workflow_transition` (+assignee, attempt, evidence), `ai_proposal` (+provenance, status enum), `role` catalogue additions.

## 3. Authorisation model (central, testable)
Four levels, evaluated by **one pure module** (`packages/contracts/src/authz.ts`) wrapped by one Nest service (`AccessService`). Controllers and services never re-implement rules; they ask `access.can(permission, target)` or `access.companyFilter(permission)`.

1. **Platform** — `user.platform_role` (`NONE`|`SUPPORT`|`ADMIN`). Platform roles hold *platform* permissions only and **never** grant tenant data access (tested). No platform endpoints are exposed in V0.
2. **Organisation** — `organisation_membership` (status, role, reach). Gate for everything; ORG-scope permissions come from its role.
3. **Practice** — `practice_membership` role, for PRACTICE-scope permissions on that practice and as the default role on its companies.
4. **Company** — `company_membership` role (explicit, most specific).

Every permission has a **scope** (`ORG`, `PRACTICE`, `COMPANY`). Effective permissions for user U on company C (deny by default, most specific wins, no union across levels, so a grant can restrict as well as extend):

```
membership not ACTIVE or organisation not ACTIVE        → ∅
company_membership(U, C) exists                          → role.permissions ∩ COMPANY
else practice_membership(U, C.practice) exists           → role.permissions ∩ COMPANY
else organisation_membership.reach = ALL                 → organisation role ∩ COMPANY
else                                                     → ∅  (404 for the company)
```
ORG-scope permissions: organisation role only. PRACTICE-scope permissions on practice P: `practice_membership(U,P).role`, else organisation role when reach = ALL. Company-level permissions never leak to another company. Resources with no company (`company_id IS NULL`, e.g. organisation-level documents/tasks) are governed by the organisation role.

### 3.1 Role and permission matrix (new/changed items marked ★)
Permission scopes: **ORG** org:read, org:manage, member:read, member:invite, member:manage, role:read, role:manage, audit:read, job:read, job:manage, integration:read, integration:manage · **PRACTICE** ★practice:read, ★practice:manage, ★practice:member:manage, company:create · **COMPANY** company:read, company:update, ★company:access:manage, period:read, period:manage, document:read, document:upload, document:archive, task:read, task:manage, workflow:read, workflow:manage, ★workflow:review, ★workflow:approve, ai:use, ai:approve.

| Role (system) | ORG scope | PRACTICE scope | COMPANY scope |
|---|---|---|---|
| Owner | all | all | all |
| Administrator | all except org:manage | all | all |
| ★Partner | org:read, member:read, role:read, audit:read, job:read | practice:read/manage/member:manage, company:create | all COMPANY incl. workflow:review/approve, ai:approve, company:access:manage |
| ★Manager | org:read, member:read, role:read, job:read | practice:read | read + manage (company:update, period:manage, documents, tasks, workflow:manage/review, ai:use) — no approve, no access management |
| Accountant | read set, audit:read, job:read | company:create | read/manage incl. workflow:review, ai:use/approve |
| Bookkeeper | read set, job:read | — | read, document:upload, task:manage, workflow:read, ai:use |
| Reviewer | read set, audit:read, job:read | — | read, workflow:read/review |
| Client Viewer | org:read | — | company:read, period:read, document:read |

Custom roles may combine any permissions; assignment is bounded by anti-escalation (a granter must hold every permission of the role **at the level being granted**).

## 4. Affected tables and migrations
| Migration | Change | Data impact |
|---|---|---|
| `20260103000000_v0_practice_and_company_roles` | create `practice`, `practice_membership`; rename `membership→organisation_membership`, `company_assignment→company_membership`; add `company_membership.role_id` (backfilled from the member's role), `company.practice_id` (backfilled: one default practice per existing PRACTICE organisation, named after the organisation); add `user.platform_role`; constraints/indexes renamed to the convention; RLS + grants + triggers for the new tables; new permissions; roles `partner`, `manager` | Additive + metadata-only renames. All rows preserved. |
| `20260103000100_v0_workflow_and_ai_states` | `workflow_instance` (+`assignee_user_id`, `attempt`), `workflow_transition` (+`attempt`, `evidence_document_ids`); `ai_proposal` status enum `PENDING_REVIEW/APPROVED/REJECTED → SUGGESTED/UNDER_REVIEW/ACCEPTED/REJECTED` (+ provenance columns) | Existing proposals mapped (`PENDING_REVIEW→SUGGESTED`, `APPROVED→ACCEPTED`). Historical workflow instances keep their definition version. |

Naming convention (ADR-22): singular snake_case tables; `<entity>_id` columns; join tables named for the relationship level (`organisation_membership`, `practice_membership`, `company_membership`); constraints `<table>_<columns>_fkey|key|idx`. Pluralising every table to match the specification's list was **rejected** (touches all 30 tables, policies, FKs and tests for no functional gain); only the ambiguous names were changed.

## 5. Compatibility with the existing V0 implementation
* API paths and response shapes remain. Additions: `/organisations/:id/practices…`, `/practices/:practiceId/members…`, `/companies/:companyId/access…`; `GET …/me` adds `practiceIds`; company creation accepts `practiceId` (defaulted for the single-practice case).
* Existing member `companyScope`/`companyIds` semantic is preserved: `ASSIGNED` + ids creates `company_membership` rows with the member's organisation role. A new optional `companyGrants: [{companyId, roleId}]` expresses per-company roles.
* `generic_approval` workflow remains (maker/checker). `standard_workflow` (DRAFT→IN_PROGRESS→REVIEW→APPROVAL→COMPLETED/REJECTED) is added; definitions are versioned and instances keep the version they started with.
* Permission checks previously based on `org.permissions` for company data move to `access.can(permission, {companyId})`; behaviour for existing single-role users is identical (their role applies where reach allows).
* OpenAPI is regenerated (drift test), classification registry gains the three new tables.

## 6. Destructive / high-risk changes
| Item | Risk | Mitigation |
|---|---|---|
| Table renames (`membership`, `company_assignment`) | Breaks a *running* old application version during rolling deploy; flagged by the migration-safety test | `ALTER TABLE … RENAME` is metadata-only, keeps data, RLS policies, grants and FKs; marked `destructive-approved` with backup-required; deploy as a single release (no instance of the old version runs against the new schema). No production deployment exists yet. |
| Enum replacement `AiProposalStatus` | `DROP TYPE` is flagged | Column converted with an explicit mapping inside one transaction; same approval marker. |
| Effective-permission change (company access now role-per-level) | Behavioural regression / privilege change | Pure module with exhaustive tests; full permission-matrix and tenancy suites re-run; old behaviour proven equal for single-role users. |
| New triggers on `company` | Could reject legitimate inserts | Backfill runs before triggers are created; tests cover both organisation types. |
| Workflow/AI definition changes | In-flight items | Versioned definitions; legacy AI v1 instances still decidable (mapped). |

Reversibility: each migration is additive except the documented renames/enum swap; a rollback script (`docs/runbooks/migrations.md` §rollback addendum) reverses renames and the enum mapping. Restore from the pre-migration backup remains the supported recovery path.

## 7. Workflow and AI state machines

### 7.1 Workflows (D2) — one reusable engine, definitions add controls
| Definition (version) | States | Notes |
|---|---|---|
| `standard_workflow` v1 | DRAFT → IN_PROGRESS → REVIEW → APPROVAL → COMPLETED; REJECTED from REVIEW or APPROVAL; REJECTED → DRAFT via `reopen` (new attempt) | `begin` / `submit_for_review` (`workflow:manage`); `request_changes` / `pass_review` / `reject` at REVIEW (`workflow:review`, must not be the preparer); `approve` (`workflow:approve`, must be neither preparer nor reviewer); comments mandatory for request_changes, reject and reopen |
| `generic_approval` v1 | DRAFT → SUBMITTED → APPROVED / REJECTED / CANCELLED | maker/checker kept for simple approvals |
| `ai_proposal_review` v2 (v1 legacy) | see 7.2 | |
Every transition: explicit edge in the definition; permission evaluated **for the instance's company**; actor, timestamp, comment, attempt and evidence documents written to the append-only history; outbox event; optimistic concurrency. Reassignment is a recorded non-state step. A database trigger forbids any state change without its recorded transition (no silent transitions). Accounting and statutory workflows (V1+/V7+) define their own types from the same primitives and may only add controls: `evidenceRequired`, `commentRequired`, wider `requireDistinctFrom`, stricter permissions (demonstrated by a test definition).

### 7.2 AI (D3) — state machine per use case
| Use case | Machine | Application of an accepted result |
|---|---|---|
| Generic suggestion / classification / extraction review (V0, `ai_proposal_review` v2) | SUGGESTED → UNDER_REVIEW → ACCEPTED \| REJECTED (reject also from SUGGESTED) | The owning module (e.g. V1 bookkeeping) applies it through **its own authorised service/workflow**, then calls `recordApplication` (human actor, reference). `ACCEPTED` itself changes nothing. |
| High-volume, low-risk suggestions (e.g. V1 bank-rule matches) | May register a lighter workflow type (SUGGESTED → ACCEPTED \| REJECTED, human batch decision) through `AiProposalService`'s `workflowFor(kind)` | Same rule: never posts by itself |
| Anything that would post ledger entries, change posted records or submit a filing | Must use the platform's accounting/filing workflow *after* ACCEPTED, with that workflow's own approvals; AI has no write path | Enforced structurally: AI code only has `ai_run`/`ai_proposal` access |
Provenance stored per proposal: provider, model, prompt version, confidence (0..1, optional), source evidence references, linked `ai_run` (hashes only), who started review, who decided and why, who applied and what it produced.

## 8. As built
* Migrations `20260103000000_v0_practice_and_company_roles`, `20260103000100_v0_workflow_and_ai_states` (+ rollback script, `docs/runbooks/rollback/`).
* Authorisation: `packages/contracts/src/authz.ts` (pure rules), `apps/api/src/common/access.ts` (`AccessContext`), `org.guard.ts` (coarse route gate + exact target gate for `:companyId`/`:practiceId`).
* New API: `/practices…`, `/practices/{id}/members/{membershipId}`, `/companies/{id}/access/{membershipId}`, `/workflows/{id}/reassign`, `/ai/proposals/{id}/review`; changed: company creation (`practiceId`), AI decision (`ACCEPT`/`REJECT`), workflow transitions (`evidenceDocumentIds`), `/me`, member listing (grants).
* Behaviour change to note: a member with reach `ASSIGNED` and no grants now has **no** implicit ability to create companies (previously auto-assigned); creation needs a practice-level (or organisation-wide) grant.
* Known limit: `audit:read`, `job:read` and `integration:*` remain organisation-scope (audit events and jobs carry no company dimension yet); company-bound integration connections need `company:update` on that company to create.
