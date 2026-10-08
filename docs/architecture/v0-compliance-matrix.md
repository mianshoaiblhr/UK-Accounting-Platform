# V0 Compliance Matrix

**Status: BLOCKED — awaiting the Master Implementation Manifest and the V0 specification.**
They were announced but are not in the repository or the conversation (`docs/specs/` does not exist), so no requirement-by-requirement classification has been made. Nothing below is invented.

## Procedure once the specs are supplied (agreed process)
1. Read the **Master Manifest** first, then **V0**.
2. Extract every requirement into the table below with its source reference (`MANIFEST §x.y`, `V0 §x.y`).
3. Classify each: `IMPLEMENTED` · `PARTIALLY IMPLEMENTED` · `MISSING` · `CONFLICTING` · `NOT APPLICABLE`, with evidence (file / test / document).
4. **Do not rewrite working code merely because a spec describes a different implementation detail.** Where the implementation is architecturally superior, record a *Deviation* with the rationale. Where it **conflicts** with the specification, list it here and get a decision **before** changing anything.
5. Re-run the V0 gate (`v0-completion-gate.md`) after any change.

| ID | Source | Requirement | Status | Evidence | Deviation / conflict note |
|---|---|---|---|---|---|
| _(to be populated from the supplied specifications)_ | | | | | |

## Deviations already known from the user's own instructions (not from the spec)
| Topic | Decision |
|---|---|
| OpenAPI | Moved into V0 (user decision) — implemented |
| Transactional outbox | Moved into V0 (user decision) — implemented |
| Auth tables outside tenant RLS | Explicit, documented exception — `security-architecture.md` §1.1 |
| Ledger/journals | Not in V0 (user boundary) — a regression test asserts none exist |
