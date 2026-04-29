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
- `/Users/seanhan/Documents/Playground/src/execution/planned-user-input-runtime.mjs`

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

Execution-plane runtime split currently includes one checked-in extraction from the planner monolith:

- `createPlannedUserInputExecutionRuntime(...)` in `/Users/seanhan/Documents/Playground/src/execution/planned-user-input-runtime.mjs`
  - owns `executePlannedUserInput(...)` and `buildPlannedUserInputEnvelope(...)` execution runtime path
  - keeps dependency-injected boundary with `executive-planner.mjs` (planner remains control-plane owner)

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

## Subtask Artifact Gate

- checked-in collaboration merge now uses subtask artifacts before final synthesis:
  - each subtask artifact carries `required_evidence`, `observed_evidence`, `missing_required_evidence`, `verifiable`
  - merge gate (`merge_evidence_gate`) is `pass=true` only when all subtask artifacts are verifiable
- verifier treats `merge_evidence_gate.pass=false` (or unverifiable subtask artifacts) as blocking:
  - `required_evidence_present=false`
  - `execution_policy_state=blocked` (when no higher-priority failure state already exists)
  - issue code includes `subtask_evidence_missing`

## Documentation Consistency Gate

- `system-self-check` truthful-completion metrics now include a hard documentation contract gate.
- required doc mirror paths are:
  - `docs/system/architecture.md`
  - `docs/system/data_flow.md`
  - `docs/system/module_contracts.md`
- checks enforce both:
  - path exists
  - required content contracts exist (not file-existence-only)
- current content contracts include:
  - architecture mirrors control/execution/evidence plane split and references replaceable execution modules (`decision/dispatch/recovery/formatter`)
  - data-flow mirrors PDF ingest/retrieve/answer chain with OCR fallback and page citation markers (`#page`)
  - module contracts include `Capability Contracts`, `Failure Taxonomy`, `Evidence Schema`, `Subtask Artifact Gate`
- if any required path or content contract check fails:
  - `truthful_completion_metrics.status=fail` (hard gate)
  - release-check blocks as truthful completion failure
  - this hard gate is independent from sample-size `unknown` handling for other truthful metrics
