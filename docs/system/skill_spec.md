# Skill Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum common spec for skills used by the Lobster planner/agent layer.

It is a spec/template document only:

- it does not claim every skill below already has a dedicated runtime wrapper
- it does not turn skills into task owners
- it defines the minimum reusable contract so agent/skill boundaries stay explicit

## Skill Template

Every skill should define at least:

- `name`
- `purpose`
- `owner_agent`
- `shared_or_private`
- `input_shape`
- `output_shape`
- `allowed_tools`
- `failure_handling`
- `escalation`
- `boundary`
- `versioning`

### Common Template

```json
{
  "name": "string",
  "purpose": "string",
  "owner_agent": "string",
  "shared_or_private": "shared|private",
  "input_shape": "object",
  "output_shape": "object",
  "allowed_tools": ["string"],
  "failure_handling": ["string"],
  "escalation": ["string"],
  "boundary": ["string"],
  "versioning": {
    "mode": "manual",
    "current": "v1"
  }
}
```

## Sharing Rules

- shared skills:
  - may be reused by more than one checked-in agent if the capability is read-only or bounded
- private skills:
  - are intended for one owner agent only
  - should not be called directly by other agents unless planner policy explicitly allows it
- no skill becomes task owner
- skill success is capability output, not completion

## Tool Access Rules

- a skill may:
  - call a bounded route/tool directly if that route/tool is explicitly allowed in the skill spec
- a skill may not:
  - bypass planner/workflow/approval/verification boundaries
  - invent tool access outside declared `allowed_tools`
- if a skill needs a tool outside its scope:
  - it should escalate back to the owner agent or planner

## 1. `planning_skill`

- name:
  - `planning_skill`
- purpose:
  - provide bounded planner-side selection, dispatch, preset orchestration, and stop-boundary behavior
- owner_agent:
  - `planner_agent`
- shared_or_private:
  - `private`
- input_shape:
  ```json
  {
    "userIntent": "string|null",
    "taskType": "string|null",
    "payload": "object"
  }
  ```
- output_shape:
  ```json
  {
    "selected_action": "string|null",
    "execution_result": "object|null",
    "trace_id": "string|null"
  }
  ```
- allowed_tools:
  - `create_doc`
  - `list_company_brain_docs`
  - `search_company_brain_docs`
  - `get_company_brain_doc_detail`
  - `get_runtime_info`
  - planner presets:
    - `create_and_list_doc`
    - `runtime_and_list_docs`
    - `search_and_detail_doc`
    - `create_search_detail_list_doc`
- failure_handling:
  - fail-soft only
  - normalize into planner error taxonomy
  - preserve `trace_id`
  - return stopped shape when current planner chain must stop
- escalation:
  - no-match returns fallback to planner caller
  - bounded read tasks may hand off to `company_brain_agent`
  - write/lifecycle/verification boundaries stay with planner
- boundary:
  - planner skill is not workflow completion logic
  - planner skill may dispatch tools, but does not bypass verifier
  - not reusable as a general-purpose shared skill
- versioning:
  - `manual`
  - `v1`

## 2. `company_brain_search_skill`

- name:
  - `company_brain_search_skill`
- purpose:
  - search verified company-brain document mirrors by `title` or `doc_id`
- owner_agent:
  - `company_brain_agent`
- shared_or_private:
  - `shared`
- input_shape:
  ```json
  {
    "q": "string",
    "limit": "number|null"
  }
  ```
- output_shape:
  ```json
  {
    "ok": "boolean",
    "action": "company_brain_docs_search",
    "data": {
      "total": "number",
      "items": "object"
    },
    "trace_id": "string|null"
  }
  ```
- allowed_tools:
  - `GET /api/company-brain/search`
- failure_handling:
  - fail-soft
  - empty query returns controlled `invalid_query`
  - downstream controlled failures should be returned to caller with `trace_id`
- escalation:
  - if caller needs write/create/lifecycle behavior, escalate to `planner_agent`
  - if search result is empty and next step needs a concrete `doc_id`, hand back to planner for stop/escalation decision
- boundary:
  - read-only
  - cannot create documents
  - cannot mutate company-brain memory
  - may call route directly because it is an explicitly bounded read tool
- versioning:
  - `manual`
  - `v1`

## 3. `company_brain_detail_skill`

- name:
  - `company_brain_detail_skill`
- purpose:
  - fetch one verified company-brain mirror record by `doc_id`
- owner_agent:
  - `company_brain_agent`
- shared_or_private:
  - `shared`
- input_shape:
  ```json
  {
    "doc_id": "string"
  }
  ```
- output_shape:
  ```json
  {
    "ok": "boolean",
    "action": "company_brain_doc_detail",
    "data": {
      "item": "object|null"
    },
    "trace_id": "string|null"
  }
  ```
- allowed_tools:
  - `GET /api/company-brain/docs/:doc_id`
- failure_handling:
  - fail-soft
  - missing `doc_id` should be rejected by caller-side validation
  - nonexistent `doc_id` returns controlled `not_found`
- escalation:
  - if doc detail is requested as part of a broader write/lifecycle task, hand back to `planner_agent`
  - if detail lookup fails and caller needs alternative search/routing, escalate to planner
- boundary:
  - read-only
  - does not infer workflow completion
  - does not grant write access or modify lifecycle state
  - may call route directly because it is an explicitly bounded read tool
- versioning:
  - `manual`
  - `v1`

## Current Boundary Summary

- `planning_skill` is effectively planner-private.
- `company_brain_search_skill` and `company_brain_detail_skill` are safe candidates for shared read-side use.
- current spec allows direct route/tool usage only when the route is explicitly bounded and declared in `allowed_tools`.
- failures should return to the owner agent/planner as controlled results, never as silent completion.
