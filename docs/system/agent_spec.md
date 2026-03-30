# Agent Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum common spec for checked-in agents in the Lobster system.

It is a template/spec document, not a claim that every agent below already exists as a dedicated runtime module.

## Agent Template

Every agent should define at least:

- `name`
- `purpose`
- `scope`
- `non_scope`
- `input_interface`
- `output_interface`
- `allowed_skills`
- `tool_access`
- `escalation`
- `failure_handling`
- `memory_boundary`

### Common Template

```json
{
  "name": "string",
  "purpose": "string",
  "scope": ["string"],
  "non_scope": ["string"],
  "input_interface": {
    "caller": "string",
    "shape": "object"
  },
  "output_interface": {
    "callee": "string",
    "shape": "object"
  },
  "allowed_skills": ["string"],
  "tool_access": {
    "direct": "boolean",
    "notes": "string"
  },
  "escalation": ["string"],
  "failure_handling": ["string"],
  "memory_boundary": {
    "can_write_company_brain": "boolean",
    "notes": "string"
  }
}
```

## 1. `planner_agent`

- name:
  - `planner_agent`
- purpose:
  - act as the execution/selection core for planner-side action choice, preset choice, dispatch, and fail-soft stop control
- scope:
  - select planner action or preset from user intent / task type
  - dispatch bounded actions through planner tool bridge
  - run planner presets and end-to-end tool flows
  - apply minimal contract validation, retry policy, self-healing, and stop boundary
- non_scope:
  - does not own workflow completion
  - does not bypass verifier or approval gates
  - does not let skills become task owners
  - does not directly write long-term memory by itself
- input_interface:
  - caller:
    - workflow/runtime/planner entrypoint
  - shape:
    ```json
    {
      "userIntent": "string|null",
      "taskType": "string|null",
      "payload": "object"
    }
    ```
- output_interface:
  - callee:
    - planner caller / workflow caller
  - shape:
    ```json
    {
      "selected_action": "string|null",
      "execution_result": "object|null",
      "formatted_output": "object|null",
      "agent_execution": "object|null (optional)",
      "trace_id": "string|null"
    }
    ```
- allowed_skills:
  - `none required by default`
  - may coordinate skill-governed capabilities indirectly through routes/tools, not by delegating ownership
- tool_access:
  - direct:
    - `true`
  - notes:
    - only through checked-in planner tool registry / bridge paths
- escalation:
  - return `selected_action=null` when no bounded tool rule matches
  - stop on `business_error`
  - stop after one self-heal failure for `contract_violation`
  - stop after one retry failure for `tool_error` / `runtime_exception`
- failure_handling:
  - fail-soft only
  - normalize errors into shared planner taxonomy
  - preserve `trace_id`
  - return stopped shape instead of throwing
- memory_boundary:
  - can_write_company_brain:
    - `false`
  - notes:
    - planner may trigger routes that later feed `company_brain`, but planner itself does not directly write memory

## 2. `company_brain_agent`

- name:
  - `company_brain_agent`
- purpose:
  - provide a minimal knowledge-facing agent contract over verified document mirrors in `company_brain_docs`
- scope:
  - list verified docs
  - search docs by `title` / `doc_id`
  - fetch single doc detail
  - participate in document-derived knowledge lookup flows
- non_scope:
  - does not create workflow completion
  - does not directly decide document verification
  - does not directly own Feishu document writing workflow
  - does not approve knowledge ingestion policy on its own
- input_interface:
  - caller:
    - planner, bridge, or runtime route
  - shape:
    ```json
    {
      "action": "list|search|detail",
      "payload": {
        "limit": "number|null",
        "q": "string|null",
        "doc_id": "string|null"
      }
    }
    ```
- output_interface:
  - callee:
    - planner / runtime caller
  - shape:
    ```json
    {
      "ok": "boolean",
      "action": "string",
      "data": "object",
      "trace_id": "string|null"
    }
    ```
- allowed_skills:
  - `none required by default`
  - may be paired with retrieval/formatting skills later, but current minimum spec does not require them
- tool_access:
  - direct:
    - `false`
  - notes:
    - current minimum path should use checked-in company-brain routes/repository access, not arbitrary tools
- escalation:
  - if requested doc does not exist, return controlled `not_found`
  - if query is empty, return controlled `invalid_query`
  - if request exceeds current minimal read-only scope, hand back to planner
- failure_handling:
  - fail-soft only
  - use route/repository controlled errors
  - preserve trace context
- memory_boundary:
  - can_write_company_brain:
    - `false` for agent-level reads
  - notes:
    - current runtime only writes to `company_brain_docs` when a verified document lifecycle reaches ingest; this agent reads that mirror and does not directly ingest new memory

## Current Boundary Summary

- `planner_agent` is grounded in checked-in code today.
- `company_brain_agent` is currently best understood as a minimal read-oriented interface contract over existing company-brain routes.
- This document does not claim a full independent agent runtime for every spec entry.
