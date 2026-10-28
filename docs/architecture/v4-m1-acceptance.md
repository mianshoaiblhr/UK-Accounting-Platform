# V4 milestone V4-M1 - acceptance package (Corporation Tax rules, tax periods and the tax profile)

**Status:** ACCEPTED under the delegation (DEC-019, DEC-086) on 2026-10-28, on the green CI run recorded in section 1. The draft rules wait for the named verifier (DEC-056) in the platform.

The design is in DEC-097, recorded and pushed before code (`5e35dd5`). This is milestone evidence only, **not production approval** (DEC-085). All data in the tests is synthetic, and the figures in the tests are fixtures, not the law. **No rule is seeded:** the draft pack is imported through the API and lands UNVERIFIED.

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `c08464a` |
| CI | [ci run 203](https://github.com/mianshoaiblhr/UK-Accounting-Platform/actions/runs/40783514135) on `17d53a8`, which contains it: every job green, including the real-browser tests and the image scans |
| Local runs | see section 5 |

## 2. What was built
| Part | Where |
|---|---|
| Rule kinds and their parameter checks (`CT_RATES`, `PERIOD_MAX_MONTHS`); request schemas; the period split `splitCtPeriods`; permissions `ct:manage` and `ct:prepare` (owner, admin, partner, accountant); flag `corporation.tax` | `packages/contracts/src/corporation-tax.ts`, `permissions.ts`, `features.ts` |
| Tables `ct_rule` (immutable versions, verified once by a second person, superseded once, no overlap of current versions of a kind), `company_tax_profile`, `ct_period` (dates fixed, associated companies versioned); RLS, grants, retention | `packages/db/prisma/migrations/20260207000000_v4_ct_rules_periods` |
| Service: rules (list, enter, supersede, verify, the rule in force on a date), the tax profile, periods (derive, read, associated companies) | `packages/accounting/src/corporation-tax.ts` |
| API: 11 operations behind `corporation.tax`, documented in the OpenAPI contract | `apps/api/src/tax/corporation-tax.controller.ts`, `docs/api/openapi.json` |
| The draft pack (UNVERIFIED, with a note for the verifier on each rule) and its import tool | `content/tax/drafts/uk-ct-rules.json`, `scripts/tax/import-ct-rules.mjs` |
| The verifier's worksheet: a "Corporation Tax rules" sheet, step 9, the sign-off rows and the legal references | `docs/legal/rule-verification-worksheet.xlsx` (`scripts/docs/gen_rule_verification.py`) |

## 3. Tests
* **Unit** (`packages/contracts/src/corporation-tax.test.ts`, 4 tests): the split of a year into periods (12 months or less, 18 months, month ends, a 24-month year); the parameter checks of each kind.
* **API and database** (`tests/api/corporation-tax.test.ts`, 12 tests):
  * a rule is entered with `ct:manage` and starts UNVERIFIED; a reviewer may not enter one; anyone who reads the ledger reads it;
  * parameters are checked by kind (limits in order, the small profits rate not above the main rate, at most 100%, no unknown field, months 1 to 24, no unknown kind);
  * two current versions of one kind may not overlap (`ct_rule_overlap`);
  * verification needs `tax:rule-verify` and someone other than the person who entered the rule, and happens once;
  * a change is a new UNVERIFIED version of the same kind; the old one is superseded once and can no longer be verified; the list leaves out superseded versions unless asked; every step is audited;
  * the database refuses changing a version, withdrawing a verification, removing a version and a self-verification (`ctr_verification_ck`);
  * the tax profile: `ct:prepare`, a 10-digit UTR, a reason, cleared with a reason, audited;
  * periods: refused with no rule (`ct_rule_not_found`) and with an unverified rule (`ct_rule_unverified`); an 18-month year gives 12 months from its start and the remaining 6; a 12-month year gives one period; deriving again returns the same periods; each period records the rule version used;
  * associated companies are set with a reason and each change advances the version; the database refuses a change of dates, an update that does not advance the version, and removal; a changed accounts year is reported (`ct_periods_stale`);
  * the draft pack imports every rule UNVERIFIED; importing needs `ct:manage`.
* **RBAC matrix:** new probes for `ct:manage` and `ct:prepare` across every system role.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| No rule is used before a second person verifies it | `ruleFor` (`ct_rule_unverified`); `ctr_verification_ck` (`verified_by_user_id <> entered_by_user_id`) |
| A rule version and a period's dates cannot be changed or removed | `ct_rule_guard`, `ct_period_guard`, `forbid_mutation`, revoked privileges, `tests/db/privileges.test.ts` |
| Only a person changes these records | `ai_cannot_write` in the service |
| Every change is audited | `ct.rule_added`, `ct.rule_superseded`, `ct.rule_verified`, `ct.tax_profile_set`, `ct.periods_derived`, `ct.associated_companies_set` |

## 5. Local runs
* `tests/api/corporation-tax.test.ts`: 12 passed on the first run.
* `packages/contracts/src/corporation-tax.test.ts`: 4 passed.
* Unit and integration projects: 2,562 of 2,565 passed on the first full run. The three failures were registry lists that did not yet name the new code:
  * the regression test's list of approved tables (`company_tax_profile` contains "tax");
  * the service as a reader of the accounts year;
  * the service as a reader of evidence documents (it applies the verifier's `canReadDocument`).

  They were updated in the next commit, and both files pass (46 unit tests, 5 regression tests).
* Typecheck (every package) and lint: clean.

## 6. For the verifier (Shoaib)
Import `content/tax/drafts/uk-ct-rules.json` with `scripts/tax/import-ct-rules.mjs`, then check each rule against its provision on the "Corporation Tax rules" sheet of the worksheet and verify it in the platform:

| Rule | Draft figures | Provision |
|---|---|---|
| `CT_RATES` from 1 April 2023 | main rate 25%; small profits rate 19%; lower limit £50,000; upper limit £250,000; marginal relief fraction 3/200 | CTA 2010 Part 3A (ss 18A-18N), inserted by FA 2021 s 7 and Sch 1; FA 2021 s 6 for the main rate for FY2023 |
| `PERIOD_MAX_MONTHS` | 12 | CTA 2009 s 10(1)(a); HMRC manual CTM01405 |

## 7. Known limitations (recorded in DEC-097 and DEC-098)
* The rates are held by financial year; how a CT period that spans two financial years is apportioned is V4-M4's computation.
* A period's dates never change. If the accounts year changes after its periods were derived, deriving reports it (`ct_periods_stale`), and correcting the periods is left to a later milestone.
* The UTR is checked for its form only; nothing is sent to HMRC.
