# V3 — iXBRL / Companies House Filing

## Objective
Build a dedicated statutory digital filing layer.

## Architecture
Accounts Engine → Reporting Model → XBRL/iXBRL Mapping → Validation → Filing Package → Companies House Adapter.

The filing adapter must not modify accounting records.

## XBRL Model
Support:
- taxonomy
- taxonomy version
- concepts
- contexts
- units
- facts
- dimensions
- decimals
- sign
- period
- entity identifier.

## Mapping
Map internal reporting concepts to taxonomy concepts using versioned mapping tables.

Never scatter taxonomy tags throughout application code.

## Validation
Before submission:
- schema validation
- taxonomy validation
- mandatory facts
- context validation
- period validation
- balance checks
- consistency checks
- duplicate fact checks.

## Companies House Workflow
DRAFT → VALIDATED → AUTHORISED → SUBMITTED → ACCEPTED / REJECTED.

Store:
- submission ID
- request payload hash
- response
- timestamp
- actor
- filing period
- acceptance evidence.

## Filing Safety
- no automatic submission without explicit authority;
- idempotency keys;
- retry rules;
- rejection handling;
- immutable filing evidence.

## Strategic Requirement
The architecture must support the UK direction toward commercial software/iXBRL filing and future taxonomy changes without rebuilding the accounts engine.
