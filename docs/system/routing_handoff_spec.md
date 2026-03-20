# Routing and Handoff Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum routing / handoff / escalation / stop rules for the current Lobster planner-facing agent layer.

It is intentionally small:

- it describes the current bounded routing logic around `planner_agent` and `company_brain_agent`
- it does not claim a full runtime router mesh
- it does not add new execution behavior by itself

## 1. `routing_rule`

- purpose:
  - decide whether a request stays in `planner_agent` or can be routed to a narrower downstream agent interface
- trigger:
  - new planner-side request, preset request, or bounded knowledge/document task
- decision:
  - route to `planner_agent` by default
  - route to `company_brain_agent` only when the task is a bounded company-brain read path
- required context:
  ```json
  {
    "user_intent": "string|null",
    "task_type": "string|null",
    "selected_action": "string|null",
    "payload": "object",
    "trace_id": "string|null"
  }
  ```
- output shape:
  ```json
  {
    "route_to": "planner_agent|company_brain_agent",
    "reason": "string",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft
  - if routing confidence is not bounded, keep the request on `planner_agent`
- boundary:
  - routing does not transfer workflow ownership
  - `company_brain_agent` is only for minimal list/search/detail reads, not for document lifecycle or write orchestration

### Current minimum routing decisions

- `planner_agent` directly handles:
  - intent/preset selection
  - planner action dispatch
  - document create
  - runtime info
  - any no-match / fallback / stop boundary
- `company_brain_agent` may handle:
  - company-brain list
  - company-brain search
  - company-brain detail

## 2. `handoff_rule`

- purpose:
  - transfer a bounded request from one agent layer to another without changing global ownership
- trigger:
  - planner has already narrowed the task to a company-brain read operation
- decision:
  - hand off from `planner_agent` to `company_brain_agent` only for read-only company-brain actions:
    - `list_company_brain_docs`
    - `search_company_brain_docs`
    - `get_company_brain_doc_detail`
- required context:
  ```json
  {
    "source_agent": "planner_agent",
    "target_agent": "company_brain_agent",
    "action": "string",
    "payload": "object",
    "trace_id": "string|null",
    "reason": "string"
  }
  ```
- output shape:
  ```json
  {
    "handoff_to": "string",
    "action": "string",
    "payload": "object",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft
  - if the target action falls outside the bounded read scope, reject the handoff and return control to `planner_agent`
- boundary:
  - handoff does not mean `company_brain_agent` becomes task owner
  - handoff is action-bounded and read-only in the current minimum spec

### Minimum context that must travel during handoff

- `source_agent`
- `target_agent`
- `action`
- `payload`
- `trace_id`
- `reason`

## 3. `escalation_rule`

- purpose:
  - return bounded agent work back to `planner_agent` when the downstream agent cannot safely continue
- trigger:
  - invalid query
  - missing target doc
  - request exceeds downstream scope
  - downstream controlled failure that needs broader planner judgment
- decision:
  - escalate back to `planner_agent`
- required context:
  ```json
  {
    "source_agent": "string",
    "error": "string",
    "data": "object",
    "trace_id": "string|null",
    "reason": "string"
  }
  ```
- output shape:
  ```json
  {
    "escalate_to": "planner_agent",
    "reason": "string",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft
  - preserve upstream `error`, `trace_id`, and bounded failure evidence
- boundary:
  - escalation is not completion
  - escalation does not silently retry unless planner policy explicitly says so

### Current minimum escalation cases

- `company_brain_agent` must hand back to `planner_agent` when:
  - the request is not list/search/detail
  - the query is invalid or empty
  - a requested `doc_id` is not found
  - the caller needs write/lifecycle behavior, not read behavior

## 4. `stop_rule`

- purpose:
  - define when the current planner-side chain should stop instead of routing or handing off further
- trigger:
  - controlled planner failure or bounded preset/action failure
- decision:
  - stop immediately on:
    - `business_error`
    - unrecoverable `contract_violation`
    - `tool_error` after retry budget is exhausted
    - `runtime_exception` after retry budget is exhausted
- required context:
  ```json
  {
    "agent": "string",
    "error": "string",
    "trace_id": "string|null",
    "data": "object"
  }
  ```
- output shape:
  ```json
  {
    "ok": false,
    "error": "string",
    "data": {
      "stopped": true,
      "stop_reason": "string"
    },
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft only
  - preserve existing `stopped` / `stopped_at_step` if already present
- boundary:
  - stop is terminal for the current bounded planner/action chain
  - stop is not equal to workflow completion
  - stop does not bypass verifier or workflow governance

## Current Boundary Summary

- `planner_agent` is the default routing and escalation center.
- `company_brain_agent` is currently a narrow read-side handoff target only.
- all write/lifecycle/create decisions still belong to planner-driven routes, not to `company_brain_agent`.
- stop boundaries are already partially reflected in planner runtime behavior, but this document is still a minimum spec, not a full router implementation.
