# Module Contracts (Control / Execution / Evidence)

## Scope

This document tracks the checked-in contract boundary for the planner three-plane split:

- control plane: planner lifecycle/decision ownership
- execution plane: capability adapters and tool execution path
- evidence plane: evidence schema + required-evidence verification gate

## Source of Truth

- `/Users/seanhan/Documents/Playground/src/contracts/index.mjs`
- `/Users/seanhan/Documents/Playground/src/evidence/index.mjs`
- `/Users/seanhan/Documents/Playground/src/execution/index.mjs`
- `/Users/seanhan/Documents/Playground/src/execution/decision.mjs`
- `/Users/seanhan/Documents/Playground/src/execution/dispatch.mjs`
- `/Users/seanhan/Documents/Playground/src/execution/recovery.mjs`
- `/Users/seanhan/Documents/Playground/src/execution/formatter.mjs`

## Capability Contracts

Capability registry (`CAPABILITY_CONTRACT_REGISTRY`) currently defines:

1. `decision`
   - required evidence: `structured_output`
   - failure taxonomy: `contract_violation`, `runtime_exception`
2. `dispatch`
   - required evidence: `tool_output`
   - failure taxonomy: `tool_error`, `runtime_exception`, `business_error`
3. `recovery`
   - required evidence: `structured_output`
   - failure taxonomy: `runtime_exception`, `permission_denied`, `not_found`
4. `formatter`
   - required evidence: `structured_output`, `summary_generated`
   - failure taxonomy: `contract_violation`, `runtime_exception`

## Failure Taxonomy

Global checked-in failure taxonomy:

- `contract_violation`
- `tool_error`
- `runtime_exception`
- `business_error`
- `not_found`
- `permission_denied`

## Evidence Schema

Current checked-in evidence schema registry (`EVIDENCE_SCHEMA_REGISTRY`):

- `tool_output`: required fields `type`, `summary`
- `structured_output`: required fields `type`, `summary`
- `summary_generated`: required fields `type`, `summary`

Evidence plane verification must enforce:

1. evidence type is known
2. required schema fields are present
3. capability-level required evidence is present

If any check fails:

- `pass=false`
- `reason=evidence_validation_failed`
- include `required_evidence_present`, `missing_required_evidence`, `evidence_schema_valid`, `evidence_schema_violations`

## Front Boundary Rule

When verifier/evidence gate indicates missing required evidence (`required_evidence_present=false`), user-facing reply must stay non-completed and explicitly use `任務未完成` wording.
