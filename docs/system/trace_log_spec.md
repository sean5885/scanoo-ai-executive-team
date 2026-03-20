# Trace Log Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum trace/log event model for the current planner/agent/runtime layer.

It is a logging spec only:

- it does not add or change runtime logging by itself
- it describes the smallest common event fields and event types we want to align on
- it distinguishes between fields already present in checked-in runtime logs and fields that are still spec-only

## Common Event Fields

All minimum trace/log events should align around these fields:

- `trace_id`
- `event_type`
- `timestamp`
- `action|preset|agent`
- `ok`
- `error`
- `retry_count`
- `healed`
- `stopped`
- `stop_reason`

### Minimum Common Shape

```json
{
  "trace_id": "string|null",
  "event_type": "string",
  "timestamp": "string|null",
  "action": "string|null",
  "preset": "string|null",
  "agent": "string|null",
  "ok": "boolean|null",
  "error": "string|null",
  "retry_count": "number|null",
  "healed": "boolean|null",
  "stopped": "boolean|null",
  "stop_reason": "string|null"
}
```

## Runtime vs Spec Boundary

### Fields already commonly present in current runtime logs

- `trace_id`
- event name / event-like label
- `action` or `preset`
- `ok`
- `error` in many fail-soft paths
- `retry_count` in retry/self-heal-related planner paths
- `healed` in self-heal path
- `stopped`
- `stop_reason`
- a partial runtime trace stream now also emits explicit planner event types for:
  - `action_dispatch`
  - `action_result`
  - `preset_start`
  - `preset_result`
  - `self_heal_attempt`
  - `retry_attempt`
  - `stopped`
 - planner-side company-brain doc-query flow now also emits minimal internal debug events for:
   - `doc_query_route`
   - `doc_query_result`

### Fields not yet consistently runtimeized

- `event_type` as one unified key across every log family
- `timestamp` as an explicit event payload field in every planner log
- one fully standardized shape shared by planner, bridge, company-brain, and future handoff/escalation events
- dedicated `handoff` / `escalation` runtime events as first-class logger outputs
- planner trace events currently use the planner module logger path only; they are not yet a full shared system logging runtime
 - doc-query trace events are also planner-module-local debug events; they are not a separate public logging surface

## 1. `action_dispatch`

- purpose:
  - record that a bounded action dispatch has started
- trigger:
  - planner starts dispatching one concrete action
- required fields:
  - `trace_id`
  - `event_type`
  - `action`
- optional fields:
  - `agent`
  - `retry_count`
  - `healed`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": "trace_123",
    "event_type": "action_dispatch",
    "timestamp": null,
    "action": "create_doc",
    "agent": "planner_agent",
    "retry_count": 0,
    "healed": false
  }
  ```
- boundary:
  - dispatch start is not success
  - dispatch start is not completion

## 2. `action_result`

- purpose:
  - record the final result of one dispatched action
- trigger:
  - action dispatch returns success or controlled failure
- required fields:
  - `trace_id`
  - `event_type`
  - `action`
  - `ok`
- optional fields:
  - `error`
  - `retry_count`
  - `healed`
  - `stopped`
  - `stop_reason`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": "trace_123",
    "event_type": "action_result",
    "timestamp": null,
    "action": "create_doc",
    "ok": true,
    "error": null,
    "retry_count": 1,
    "healed": true,
    "stopped": false,
    "stop_reason": null
  }
  ```
- boundary:
  - action success is still evidence/output, not workflow completion

## 3. `preset_start`

- purpose:
  - record that a planner preset has begun execution
- trigger:
  - `runPlannerPreset(...)` starts
- required fields:
  - `trace_id`
  - `event_type`
  - `preset`
- optional fields:
  - `agent`
  - `timestamp`
  - `retry_count`
- sample shape:
  ```json
  {
    "trace_id": "trace_456",
    "event_type": "preset_start",
    "timestamp": null,
    "preset": "create_and_list_doc",
    "agent": "planner_agent"
  }
  ```
- boundary:
  - preset start is not success
  - preset start does not imply every step will run

## 4. `preset_result`

- purpose:
  - record the final result of preset execution
- trigger:
  - `runPlannerPreset(...)` finishes with success or controlled stop/failure
- required fields:
  - `trace_id`
  - `event_type`
  - `preset`
  - `ok`
- optional fields:
  - `error`
  - `stopped`
  - `stop_reason`
  - `retry_count`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": "trace_456",
    "event_type": "preset_result",
    "timestamp": null,
    "preset": "create_search_detail_list_doc",
    "ok": false,
    "error": "business_error",
    "stopped": true,
    "stop_reason": "business_error"
  }
  ```
- boundary:
  - preset result is planner-chain result, not workflow completion

## 5. `self_heal_attempt`

- purpose:
  - record one minimal self-heal attempt for planner input-side `contract_violation`
- trigger:
  - planner detects input contract mismatch and tries one repair
- required fields:
  - `trace_id`
  - `event_type`
  - `action`
  - `retry_count`
  - `healed`
- optional fields:
  - `error`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": null,
    "event_type": "self_heal_attempt",
    "timestamp": null,
    "action": "create_doc",
    "retry_count": 1,
    "healed": true,
    "error": "contract_violation"
  }
  ```
- boundary:
  - self-heal is shallow and bounded
  - self-heal attempt does not imply repaired success

## 6. `retry_attempt`

- purpose:
  - record one retry attempt after `tool_error` or `runtime_exception`
- trigger:
  - planner retry policy is invoked
- required fields:
  - `trace_id`
  - `event_type`
  - `action`
  - `retry_count`
  - `error`
- optional fields:
  - `timestamp`
  - `agent`
- sample shape:
  ```json
  {
    "trace_id": "trace_789",
    "event_type": "retry_attempt",
    "timestamp": null,
    "action": "get_runtime_info",
    "retry_count": 1,
    "error": "runtime_exception"
  }
  ```
- boundary:
  - retry attempt is bounded by policy
  - retry attempt does not clear original trace context

## 7. `handoff`

- purpose:
  - record a bounded transfer from one agent layer to another
- trigger:
  - planner decides a request should move to a narrower downstream agent capability
- required fields:
  - `trace_id`
  - `event_type`
  - `agent`
- optional fields:
  - `action`
  - `error`
  - `timestamp`
  - `stop_reason`
- sample shape:
  ```json
  {
    "trace_id": "trace_900",
    "event_type": "handoff",
    "timestamp": null,
    "agent": "company_brain_agent",
    "action": "search_company_brain_docs",
    "ok": null
  }
  ```
- boundary:
  - currently mostly spec-only
  - current runtime more often implies handoff through planner dispatch than through a dedicated handoff event

## 8. `escalation`

- purpose:
  - record that work is being returned upward for planner judgment
- trigger:
  - downstream bounded capability cannot safely continue in its current scope
- required fields:
  - `trace_id`
  - `event_type`
  - `agent`
  - `error`
- optional fields:
  - `action`
  - `stop_reason`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": "trace_901",
    "event_type": "escalation",
    "timestamp": null,
    "agent": "company_brain_agent",
    "action": "get_company_brain_doc_detail",
    "error": "not_found",
    "stop_reason": "not_found"
  }
  ```
- boundary:
  - currently mostly spec-only
  - current runtime mainly expresses this as fail-soft return/stop, not a dedicated escalation event

## 9. `stopped`

- purpose:
  - record that the current bounded planner/action/preset chain has stopped
- trigger:
  - planner stop boundary is reached
- required fields:
  - `trace_id`
  - `event_type`
  - `ok`
  - `error`
  - `stopped`
  - `stop_reason`
- optional fields:
  - `action`
  - `preset`
  - `agent`
  - `retry_count`
  - `healed`
  - `timestamp`
- sample shape:
  ```json
  {
    "trace_id": "trace_999",
    "event_type": "stopped",
    "timestamp": null,
    "action": "create_doc",
    "ok": false,
    "error": "tool_error",
    "retry_count": 1,
    "healed": false,
    "stopped": true,
    "stop_reason": "tool_error"
  }
  ```
- boundary:
  - stopped is terminal for the current bounded chain only
  - stopped is not workflow completion

## Current Boundary Summary

- current runtime already emits several planner-adjacent logs that map closely to:
-  - `action_dispatch`
-  - `action_result`
-  - `preset_start`
-  - `preset_result`
-  - `self_heal_attempt`
-  - `retry_attempt`
-  - `stopped`
- `handoff` and `escalation` are still mainly spec-only
- this document standardizes the minimum field set, but runtime logs are not yet fully normalized to this exact schema
