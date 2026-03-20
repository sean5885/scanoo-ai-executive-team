# Planner Agent Runtime Refactor Plan

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document is a minimum refactor plan for evolving `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` into a clearer `planner_agent` runtime shape over time.

It is a planning document only:

- it does not change runtime behavior
- it assumes existing tests and validated flows must stay green
- it prefers staged extraction over one-shot rewrites

## Current Structure

Current `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` mixes several responsibilities in one module:

- executive-turn planning
- intent selection
- planner tool registry
- planner preset registry
- action dispatch
- multi-step execution
- preset execution
- action-level contract validation
- preset-level final output validation
- error normalization
- retry/self-heal/stop boundary policy

This is workable today, but the module is carrying both:

- decision logic
- runtime execution logic

in the same file.

## Target Structure

Target direction is a clearer `planner_agent` runtime split, while preserving current external behavior:

- planner selection layer
- planner dispatch/runtime layer
- planner preset runner layer
- planner contract/policy layer
- planner trace/log helper layer

This does **not** mean introducing a new autonomous planner service immediately.

## Keep As-Is

These parts should stay as-is for now because they are already validated and user-facing behavior depends on them:

- existing exported function names from `executive-planner.mjs`
- current action names and preset names
- current planner result shapes
- current fail-soft error behavior
- current retry/self-heal/stop behavior
- current planner contract file usage

## Extract Later

These are good candidates for later extraction into smaller internal modules/helpers:

- tool registry and preset registry
- contract validation helpers
- error taxonomy + normalize helpers
- retry/self-heal/stop policy helpers
- planner trace/log event helpers

The key rule is:

- extraction later should preserve current exports or provide stable wrappers

## Defer For Now

These should be explicitly deferred until current planner flows need more structure:

- preset step-level validation
- dedicated handoff runtime module
- dedicated escalation runtime module
- externalized planner policy config
- generic agent runtime wrapper beyond the current planner helper layer
- deeper schema system beyond current minimal `required/type`

## Refactor Phases

### Phase 1: Clarify Internal Responsibility Boundaries

- status:
  - completed

- goal:
  - reorganize the current file conceptually without changing external behavior
- scope:
  - group internal helpers by concern
  - add clearer section boundaries / naming consistency
  - keep exports and runtime behavior unchanged
- constraints:
  - no action/preset rename
  - no output shape changes
  - no test expectation changes

### Phase 2: Extract Minimum Helper / Policy / Trace Structures

- status:
  - completed

- goal:
  - move stable internal concerns into small helper modules
- scope:
  - validation helper extraction
  - policy helper extraction
  - trace/log helper extraction
  - minimal planner trace runtime landing on top of those helpers
- constraints:
  - keep `executive-planner.mjs` as the stable public entrypoint
  - no change to planner contract behavior
  - no change to live route mapping

Current Phase 2 landing now also includes:

- a reusable internal planner flow interface extracted into `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs`
- a reusable planner-side doc-query flow extracted into `/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs`
- the extracted flow owns:
  - hard company-brain pre-routing
  - `active_doc` / `active_candidates` state
  - doc-query payload shaping
  - ambiguity-aware company-brain formatter output
  - doc-query context sync after successful search/detail execution
- `executive-planner.mjs` remains the stable public planner entrypoint and only wires that flow in

### Phase 3: Reserve Interfaces for Future Planner-Agent Wrapper

- status:
  - completed

- goal:
  - make the current planner runtime easier to wrap as a clearer `planner_agent` boundary later
- scope:
  - define stable internal interfaces for:
    - selection
    - dispatch
    - preset execution
    - stop/error normalization
  - prepare for future runtime wrapper without changing current caller behavior
- constraints:
  - no full wrapper runtime yet
  - no independent router/mesh assumption

Current Phase 3 landing:

- keeps the existing public planner helpers unchanged
- adds internal runtime-interface shapers for:
  - planner-agent input/output
  - action runtime input
  - preset runtime input/output
  - multi-step output
- reserves no-op internal hook points for:
  - future handoff attachment
  - future escalation attachment
  - future planner wrapper attachment
- does not introduce a new runtime layer or change current planner behavior

## What Should Not Be Touched Now

To avoid breaking already validated behavior, these should not be changed in the near-term refactor:

- action names:
  - `create_doc`
  - `list_company_brain_docs`
  - `search_company_brain_docs`
  - `get_company_brain_doc_detail`
  - `get_runtime_info`
- preset names:
  - `create_and_list_doc`
  - `runtime_and_list_docs`
  - `search_and_detail_doc`
  - `create_search_detail_list_doc`
- current output shapes
- current `trace_id` behavior
- current retry/self-heal semantics
- current fail-soft contract violation behavior

## What Can Be Safely Refactored First

These are good first moves because they are mostly semantic/internal:

- clearer helper grouping
- internal function naming cleanup
- extraction of policy constants/helpers
- extraction of trace/log shape helpers
- extraction of registry builders

These should be done without changing:

- exports
- payload shapes
- route paths
- test assertions

## Validation Strategy

Every refactor phase should preserve the existing validated planner surface.

Minimum validation after each phase:

- `node --check src/executive-planner.mjs`
- `node --test tests/executive-planner.test.mjs`

Additionally preserve previously validated behaviors:

- selection fallback
- action dispatch
- contract validation
- retry/self-heal
- preset success/failure/stop_on_error
- end-to-end preset selection flows

## Rollback Boundary

Rollback should stay simple:

- keep `executive-planner.mjs` as the primary stable surface during all phases
- avoid simultaneous refactors across planner + routes + contracts
- if a refactor breaks planner behavior, revert only the planner-internal extraction/change set

Practical rollback boundary:

- one phase per PR/change set
- no concurrent planner runtime and route behavior rewrites

## Current Boundary Summary

- current `executive-planner.mjs` is already a functioning minimum planner runtime
- the safest near-term goal is internal clarity, not behavioral redesign
- future wrapperization should be prepared by interface extraction, not by replacing the current module in one step
