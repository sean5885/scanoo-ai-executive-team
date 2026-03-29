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

- `request_id`
- `trace_id`
- `traffic_source`
- `request_backed`
- `action`
- `status`
- `event_type`
- `timestamp`
- `action|preset|agent`
- `chosen_lane`
- `chosen_action`
- `fallback_reason`
- `ok`
- `error`
- `retry_count`
- `healed`
- `stopped`
- `stop_reason`
- `timeout_ms`
- `reasoning`

### Minimum Common Shape

```json
{
  "request_id": "string|null",
  "trace_id": "string|null",
  "traffic_source": "real|test|replay|null",
  "request_backed": "boolean|null",
  "action": "string|null",
  "status": "string|null",
  "event_type": "string",
  "timestamp": "string|null",
  "preset": "string|null",
  "agent": "string|null",
  "chosen_lane": "string|null",
  "chosen_action": "string|null",
  "fallback_reason": "string|null",
  "ok": "boolean|null",
  "error": "string|null",
  "retry_count": "number|null",
  "healed": "boolean|null",
  "stopped": "boolean|null",
  "stop_reason": "string|null",
  "timeout_ms": "number|null",
  "reasoning": {
    "why": "string|null",
    "alternative": {
      "action": "string|null",
      "agent_id": "string|null",
      "summary": "string|null"
    }
  }
}
```

## Runtime vs Spec Boundary

### Fields already commonly present in current runtime logs

- `trace_id`
- `traffic_source`
- `request_backed`
- `action`
- `status`
- event name / event-like label
- `action` or `preset`
- `ok`
- `error` in many fail-soft paths
- `retry_count` in retry/self-heal-related planner paths
- `healed` in self-heal path
- `stopped`
- `stop_reason`
- bounded `reasoning` in planner decision / end-to-end trace events, exposing `why` and a simplified `alternative`
- a partial runtime trace stream now also emits explicit planner event types for:
  - `action_dispatch`
  - `action_result`
  - `preset_start`
  - `preset_result`
  - `self_heal_attempt`
  - `retry_attempt`
- executive planner decision selection now also emits:
  - `executive_decision`
  - `executive_decision_fallback`
- `stopped`
 - planner-side company-brain doc-query flow now also emits minimal internal debug events for:
   - `doc_query_route`
   - `doc_query_result`
- lane/runtime selection logs now also surface:
  - `chosen_lane`
  - `chosen_action`
  - `fallback_reason`
- tool execution callers now also emit a unified `lobster_tool_execution` payload with:
   - `request_id`
   - `action`
 - `params`
 - `result.success`
 - `result.data`
 - `result.error`
 - `duration_ms`
 - optional `trace_id`
- workflow write-gate callers now also emit `write_guard_decision` events with:
  - `owner`
  - `workflow`
  - `decision`
  - `allow`
  - `deny`
  - `reason`
  - deny-only `error_code`
  - `traffic_source`
  - `request_backed`
- those `tool_execution` events are now also persisted into SQLite `http_request_trace_events`, so request-scoped learning/analysis can measure per-tool success rate and latency from the same trace surface
- the HTTP runtime now also persists one compact SQLite request-monitor row per finished request keyed by `trace_id`; this is a query surface over request outcomes, not a replacement for structured logs
- the HTTP runtime now also emits explicit `request_timeout` / `request_cancelled` trace events and persists the corresponding `error_code` into `http_request_monitor`
- the monitoring layer now also persists trace-scoped runtime events into SQLite `http_request_trace_events`; this stays a local observability/debug surface and does not replace the runtime logger stream
- a local CLI `node scripts/debug-trace.mjs <trace_id>` can now reconstruct one persisted request timeline from those trace events plus the compact request row
- runtime console/log sinks now emit one JSON log object per line for the shared runtime logger, rate-limited alerts, and tool execution logs; the runtime payload keeps `event` as a compatibility alias while `event_type` is the canonical analysis key
- planner selector logs for checked-in skill-backed actions now also expose:
  - `skill_selector_attempted`
  - `skill_selector_task_type`
  - `skill_selector_status`
  - `skill_selector_fail_closed`
  - `skill_selector_key`
  - `skill_surface_layer`
  - `skill_promotion_stage`
- skill-backed `tool_execution` logs now also expose:
  - `skill_bridge`
  - `skill_name`
  - `skill_surface_layer`
  - `skill_promotion_stage`
  - `skill_selector_key`
  - `skill_fail_closed`
  - `skill_stop_reason`
- `chat_output_boundary` logs now also expose planner-visible skill boundary evidence when the reply came from `skill_bridge`:
  - `planner_skill_boundary = "answer_pipeline"`
  - `planner_skill_answer_pipeline_enforced = true`
  - `planner_skill_raw_payload_blocked = true`

### Fields not yet consistently runtimeized

- `event_type` as one unified key across every remaining log family outside the shared runtime/tool helpers
- `timestamp` as an explicit event payload field in every remaining planner-module-local log
- one fully standardized shape shared by planner, bridge, company-brain, and future handoff/escalation events
- dedicated `handoff` / `escalation` runtime events as first-class logger outputs
- planner trace events currently use the planner module logger path only; they are not yet a full shared system logging runtime
- doc-query trace events are also planner-module-local debug events; they are not a separate public logging surface
- the planner-visible live telemetry event family described in `/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md` is still spec-only and not yet emitted by runtime

## Persisted Local Debug Surface

Current local monitoring persistence now has two layers keyed by `trace_id`:

- `http_request_monitor`
  - one compact terminal row per HTTP request
  - optimized for recent requests, errors, and aggregate metrics
- `http_request_trace_events`
  - ordered request-scoped runtime events persisted from the structured runtime logger
  - carries request input, route/lane/planner/action steps, and terminal failure/success signals
  - intended for local debug reconstruction, not as a public API contract

The reconstruction CLI reads both tables so operators can quickly inspect:

- request input
- planner decision `why`
- lane / action
- final result / error
- timeout budget when the failure is a timeout
- timeline step ordering and most likely failure layer

## `request_input`

- purpose:
  - persist a sanitized snapshot of HTTP request input for later trace reconstruction
- trigger:
  - HTTP request body/query parsing completes
- required fields:
  - `trace_id`
  - `event_type`
  - `request_input.method`
  - `request_input.pathname`
  - `request_input.traffic_source`
  - `request_input.request_backed`
- optional fields:
  - `request_input.query`
  - `request_input.body`
- boundary:
  - request input is sanitized and redacted before persistence
  - persisted request input is a debug hint, not an exact raw wire replay

## 0. `tool_execution`

- purpose:
  - record one bounded tool execution with request correlation and a normalized result payload
- trigger:
  - planner tool dispatch or OpenClaw plugin tool execution returns success or failure
- required fields:
  - `request_id`
  - `action`
  - `params`
  - `result.success`
  - `result.data`
  - `result.error`
- optional fields:
  - `trace_id`
  - `timestamp`
  - `duration_ms`
  - checked-in skill observability fields such as `skill_surface_layer`, `skill_selector_key`, and `skill_fail_closed`
- sample shape:
  ```json
  {
    "request_id": "planner_tool_123",
    "action": "get_runtime_info",
    "params": {},
    "result": {
      "success": true,
      "data": {
        "db_path": "/tmp/db.sqlite"
      },
      "error": null
    },
    "duration_ms": 18,
    "trace_id": "trace_runtime"
  }
  ```
- boundary:
  - `tool_execution` is execution evidence only
  - it does not replace planner `action_dispatch` / `action_result`
  - tool logs must record both controlled errors and runtime exceptions; no silent fail

## 0A. `planner_tool_select` skill selector fields

- purpose:
  - record deterministic planner skill selection state without changing planner public result shapes
- trigger:
  - planner selector runs for user intent / task type selection
- checked-in skill fields:
  - `skill_selector_attempted`
  - `skill_selector_task_type`
  - `skill_selector_match_count`
  - `skill_selector_status`
  - `skill_selector_fail_closed`
  - `skill_selector_key`
  - `skill_action`
  - `skill_name`
  - `skill_surface_layer`
  - `skill_promotion_stage`
- boundary:
  - this is observability only
  - selector drift must still fail closed; these fields do not authorize fallback

## 0B. `chat_output_boundary` planner skill evidence

- purpose:
  - prove skill-backed replies still crossed the existing answer pipeline before user rendering
- trigger:
  - `user-response-normalizer.mjs` normalizes a planner envelope into user-facing `answer / sources / limitations`
- checked-in planner-skill fields:
  - `planner_skill_boundary`
  - `planner_skill_action`
  - `planner_skill_name`
  - `planner_skill_surface_layer`
  - `planner_skill_promotion_stage`
  - `planner_skill_answer_pipeline_enforced`
  - `planner_skill_raw_payload_blocked`
- boundary:
  - this event is evidence for debug / rollback checks only
  - it does not change the user-facing response contract

## 0C. Proposed `planner_visible_*` live telemetry events

- purpose:
  - define a production-ready event family for planner-visible routing/monitoring/rollback without changing the planner contract
- status:
  - checked-in minimal runtime emission now exists
  - current schema guard lives at `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
  - current in-memory collector/runtime hook lives at `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- proposed event set:
  - `planner_visible_skill_selected`
  - `planner_visible_fail_closed`
  - `planner_visible_ambiguity`
  - `planner_visible_fallback`
  - `planner_visible_answer_generated`
- required shared fields:
  - `query_type`
  - `selected_skill`
  - `candidate_skills`
  - `decision_reason`
  - `routing_family`
  - `request_id`
  - `timestamp`
- recommended shared extension fields:
  - `trace_id`
  - `reason_code`
  - `task_type`
- boundary:
  - these events now emit inside runtime, but only into a local in-memory collector
  - external telemetry pipeline, dashboard, and alert transport are still future work
  - they must reuse the existing request/trace chain
  - they must not widen admission or alter the public response shape

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

## 1A. `write_guard_decision`

- purpose:
  - record one workflow-level write gate decision for both allow and deny outcomes
- trigger:
  - any guarded internal/external write path calls `decideWriteGuard(...)`
- required fields:
  - `event_type`
  - `action`
  - `owner`
  - `workflow`
  - `decision`
  - `allow`
  - `deny`
  - `reason`
- optional fields:
  - `trace_id`
  - `request_id`
  - `error_code`
  - workflow-specific target identifiers such as `document_id`, `folder_token`, or `scope_key`
- sample shape:
  ```json
  {
    "event_type": "write_guard_decision",
    "action": "meeting_confirm_write",
    "owner": "meeting_agent",
    "workflow": "meeting",
    "decision": "deny",
    "allow": false,
    "deny": true,
    "reason": "confirmation_required",
    "error_code": "write_guard_confirmation_required",
    "trace_id": "http_123"
  }
  ```
- boundary:
  - this event is guard evidence only
  - it explains why a write was allowed or denied
  - it does not itself prove the downstream write succeeded

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
