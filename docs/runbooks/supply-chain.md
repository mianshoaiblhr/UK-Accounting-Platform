# Supply-chain security controls

| Control | Where | Fails the build when |
|---|---|---|
| Dependency audit (runtime **and** dev tooling) | `ci.yml` job `supply-chain`: `pnpm audit --audit-level=high` | any known advisory of high/critical severity exists in the lockfile |
| Secret scanning (full git history) | `ci.yml` job `supply-chain`: gitleaks with `.gitleaks.toml` | a credential-shaped string is committed outside the allow-listed test/doc paths |
| Static analysis | `codeql.yml` (push, PR, weekly) | CodeQL reports a security-and-quality alert (results appear under Security → Code scanning) |
| Container image scan | `ci.yml` job `images`: Trivy on api / worker / web / migrate | a **fixable** HIGH/CRITICAL OS or library vulnerability is present |
| New-dependency review | `dependency-review.yml` (pull requests) | a PR introduces a dependency with a high/critical advisory |
| Automated update PRs | `.github/dependabot.yml` (npm, actions, docker, terraform; weekly) | – |
| Pinned transitive fixes | root `package.json` → `pnpm.overrides` | – |

## Overrides in force (remove when the parent catches up)
* `postcss >=8.5.23` – Next.js bundles an older PostCSS (build-time CSS processing; multiple advisories).
* `deepmerge-ts >=8.0.0` – pulled by Prisma's config package (stack exhaustion on hostile input; build/CLI-time only).
* Dev tooling: Vitest ≥ 4.1.11 (path traversal in the dev server; also removes the vulnerable `tinypool`).

## Responding to a finding
1. Prefer upgrading the direct dependency; use an override only when the parent has no release yet, and record it above.
2. Never silence a finding without an entry here naming the advisory, why it is not exploitable, and a review date.
3. A leaked secret is a **rotation incident first** (rotate, then purge), regardless of whether the repository is private.

## What this does not cover
No SBOM publication or signed provenance yet, and CodeQL/Trivy results depend on GitHub-hosted runners – tracked as production-readiness items in `v0-compliance-matrix.md`.
