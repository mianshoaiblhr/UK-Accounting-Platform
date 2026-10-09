# Investigation DEC-013 - IP address and user agent held outside the audit switch

**Status: UNRESOLVED. Not production-ready. Not reviewed by a qualified privacy / legal person.** This is an engineering trace of what the platform does today, a proposal for policy-controlled retention and deletion, and the tests that pin today's behaviour. **Nothing in the proposal is implemented or enabled** (S4(b) is frozen, DEC-003). No lawful basis and no retention period is approved here (DEC-003, DEC-014). Development uses synthetic data only.

Evidence: `tests/api/device-metadata.test.ts` (10 characterisation tests), `tests/api/audit-privacy.test.ts` (the switch for the audit trail and access log), `docs/legal/retention-verification-schedule.md` section 2.

## 1. Question
The V0 report said `session.ip`, `session.user_agent` and `auth_challenge.ip` are stored regardless of `AUDIT_CAPTURE_DEVICE_METADATA` and are not purged. Trace where they are collected, how they are used, who can access them, what the purpose is, and propose a policy-controlled retention and deletion.

## 2. Trace (from the code, verified by tests)
| # | Data | Written by | Read by | Who can see it | Purpose evidenced in code | Covered by the audit switch? | Purged? |
|---|---|---|---|---|---|---|---|
| 1 | `session.ip`, `session.user_agent` (UA cut to 300 characters) | `SessionService.create` on every successful sign-in (`auth.service.ts`) | `SessionService.list` -> `GET /auth/sessions` -> the "Security" page in the web app (`apps/web/src/app/security/page.tsx`, shows the IP) | the signed-in user, for their own sessions only; revoking another user's session returns 404 | "where am I signed in": lets a person recognise and revoke an unfamiliar session | **No** | **No.** Rows are never deleted: revoked and expired sessions keep both fields indefinitely |
| 2 | `auth_challenge.ip` | `AuthService` when a correct password needs a second factor (5-minute challenge) | **Nothing.** No code reads it (the MFA step rate-limits on the request's own IP, not the stored one) | nobody through the API; database administrators | **None found**: collection without a use | **No** | **No** |
| 3 | `audit_event.ip`, `audit_event.user_agent` | `auditRow` for every audit event | `GET /audit-events` (audit:read, per company) and `GET /auth/login-history` (own events) | auditors for their companies; the user for their own pre-tenant events | accountability, security investigation | **Yes** (switch off = null) | No (provisional 7 years, DEC-003, not enforced) |
| 4 | API access log lines (`ip`, `userAgent`) | `access-log.middleware.ts` | log storage (CloudWatch log group, `log_retention_days`, default 400, not applied) | operators with log access | operations and incident triage | **Yes** | by log-group retention (not applied) |
| 5 | `login_trusted_ip.ip_hash` (SHA-256 of the IP) | login throttle on successful sign-in | login throttle (is this IP known for the account?) | nobody through the API | "account under attack" logic that lets the owner's usual networks through | No | No (one row per user and IP, no expiry) |
| 6 | Redis `rl:<route>:ip:<IP>` and `rl:mfa:ip:<IP>` - **raw IP in the key name** | rate limiter (`auth.guard.ts`, `auth.service.ts`) | the limiter | operators with Redis access | per-IP rate limiting of authentication routes | No | Yes, by TTL (the window: seconds to one hour) |
| 7 | Redis `lt:ip`, `lt:pair`, `lt:acct` - truncated SHA-256 of IP and e-mail | login throttle | login throttle | operators with Redis access | brute-force protection | No | Yes, by TTL (about 15 minutes) |

Other copies: database backups and snapshots of the tables above (35-day automated backups in the Terraform, not applied); there is no export of these fields to third parties, no analytics and no log shipping outside the platform in the code. Request IPs depend on `TRUST_PROXY_HOPS` (behind a load balancer the address is taken from `X-Forwarded-For`; misconfiguration would record the proxy's address, not the user's).

## 3. Findings
* **F-1 - Collection without a use.** `auth_challenge.ip` is written and never read (row 2). Data-minimisation question.
* **F-2 - The switch does not cover sessions or challenges.** With `AUDIT_CAPTURE_DEVICE_METADATA=false` the audit trail and access log carry no IP or user agent, but every sign-in still stores both on the session (and the IP on challenges) (rows 1-2; test "with the switch OFF ...").
* **F-3 - Nothing is purged.** Sessions and challenges, expired or revoked, keep their IP and user agent forever; the number of rows grows with every sign-in (test "a revoked or expired session keeps ...", and a test that fails if any deletion of these tables is added).
* **F-4 - Indefinite hashed IPs.** `login_trusted_ip` keeps a pseudonymised (hashed) IP per user with no expiry (row 5). A hashed IP is still personal data.
* **F-5 - Raw IPs in Redis keys** for up to an hour (row 6). This corrects the earlier statement in `retention-verification-schedule.md` that all Redis throttling keys were hashed: the login-throttle keys are, the generic rate-limit keys are not.
* **F-6 - Access is narrow.** Only the authentication module touches these tables (architecture-style test), the API exposes sessions only to their owner, and no organisation role can see another member's sessions or login history.

## 4. Proposal (NOT implemented, NOT enabled - for the privacy review)
All options are policy-controlled (configuration or a policy record), **off by default**, introduced as separate, reversible changes after the review records a lawful basis and periods. The periods below are placeholders for the reviewer, not proposals of law.
| Option | Change | Effect | Risk / note |
|---|---|---|---|
| A | Stop writing `auth_challenge.ip` | removes F-1 | none functional: nothing reads it |
| B | Give sessions their own switch (or extend `AUDIT_CAPTURE_DEVICE_METADATA` to cover them) | closes F-2; the "where am I signed in" page degrades gracefully (shows time and a "location hidden" note) | product decision: the page is a security feature |
| C | Coarsen on write: store IPv4 truncated to /24 and IPv6 to /48 (or a keyed hash) instead of the full address | smaller personal-data footprint, still useful for recognising a network | reduces investigative precision |
| D | Retention job: after a configurable number of days past expiry/revocation, null `ip`/`user_agent` (keep the row for the session history), then delete the row after a longer period; same for challenges and trusted IPs | closes F-3/F-4 | **irreversible deletion** - needs the review, a dry-run report first, an audit event per run, and tests; blocked by DEC-003 |
| E | Hash the IP in the generic rate-limit keys like the login-throttle keys | closes F-5 | none functional |
| F | Document the purposes, retention and access in the privacy notice and the record of processing | transparency | legal input |
Suggested order after review: A and E (no deletion), then B/C, then D behind a dry run.

## 5. Tests (all pass; they pin today's behaviour)
`tests/api/device-metadata.test.ts`: the switch off still stores session IP/UA and challenge IP; UA truncation; owner-only listing and revocation; no organisation endpoint exposes them; `auth_challenge.ip` has a writer and no reader; only the authentication module touches the tables; revoked/expired sessions keep their data; no purge exists in the code; Redis rate-limit keys hold the raw IP with a TTL no longer than the window and the login-throttle keys do not. **A test failing here means behaviour changed: update this document and obtain the review before relying on the change.**

## 6. Review checklist (for the qualified privacy / legal reviewer)
1. Is each purpose in section 2 necessary and proportionate? (Especially F-1: no use.)
2. Which lawful basis, if any, applies to each row; who is the controller (the firm or the platform operator)?
3. Retention period for each row; whether coarsening (option C) is sufficient.
4. Whether a hashed IP (rows 5 and 7) is treated as personal data here (it is for UK GDPR purposes unless truly anonymised).
5. Transparency: privacy notice wording; record of processing entry.
6. Approve, amend or reject options A-F in order; record the decision in `docs/architecture/decision-log.md`.
Until item 6 is recorded this finding stays **unresolved**.
