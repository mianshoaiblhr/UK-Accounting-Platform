# V10 — AI Accountant / Autonomous Workflows

## Objective
Create an AI Accountant that can reason across bookkeeping, accounts, tax, compliance and client communications while remaining controlled by accountants.

## AI Accountant Capabilities
Ask:
- Why did profit fall?
- What changed this month?
- Which clients need attention?
- What year-end issues remain?
- Which transactions are unusual?
- What information should I request?
- Which accounts need review?

## Agent Architecture
AI Orchestrator
→ planning
→ tool selection
→ evidence retrieval
→ reasoning
→ proposed action
→ approval
→ execution
→ audit.

## Tools
Read-only by default:
- ledger search
- transaction search
- document search
- reports
- tax schedules
- compliance calendar
- working papers.

Write-capable only after explicit permission:
- create draft journal
- create task
- draft client message
- prepare filing
- propose adjustment.

Submission always requires authorised workflow.

## Autonomous Workflows
Examples:
- daily bookkeeping exception review
- bank reconciliation assistant
- month-end close assistant
- year-end review assistant
- client information request assistant
- tax deadline monitor
- filing readiness assistant.

## Guardrails
- evidence required
- confidence threshold
- approval thresholds
- segregation of duties
- complete audit trail
- no silent posting
- no silent filing
- rollback/reversal mechanisms.

## AI Memory
Store company-specific knowledge only within tenant/company permissions.
