# Planner-Visible Live Telemetry Design

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines a production-ready telemetry / monitoring / rollback design for the current `planner_visible` surface without wiring it into a real production pipeline yet.

Current design scope:

- add a checked-in event/metric/alert/rollback spec
- add checked-in minimal runtime emission through a telemetry adapter layer
- keep the current planner contract unchanged
- keep the current two-skill admission boundary unchanged
- reuse the existing request/trace/debug surface where possible

Still out of scope in this thread:

- no new skill
- no planner public response contract change
- no external telemetry sink, dashboard, alerting transport, or feature-flag runtime
- no change to the current checked-in routing or admission behavior

## Current Code Truth

The current checked-in observability surface now has a minimal live runtime stub on top of the existing fixture-backed watch:

- [planner_visible_multi_skill_observability.md](/Users/seanhan/Documents/Playground/docs/system/planner_visible_multi_skill_observability.md)
- `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`

The current runtime already exposes the key local evidence we will build on later:

- `planner_tool_select`
  - emits selector attempt/status/key/surface metadata
- `lobster_tool_execution`
  - emits request-scoped tool execution evidence with `request_id`, optional `trace_id`, and skill-specific extras
- `chat_output_boundary`
  - proves skill-backed replies still passed the answer pipeline before user rendering
- `http_request_trace_events`
  - persists trace-scoped runtime events for local reconstruction
- `planner_visible_*`
  - now emits spec-constrained runtime events through an injected telemetry adapter
  - the default adapter is an in-memory buffer so current behavior stays local-only
  - current checked-in emission points are planner decision / selection, fail-closed admission, fallback, and answer boundary

Current checked-in baseline from the coexistence watch:

- selector overlap: `0`
- per-skill selector hit rate:
  - `search_and_summarize = 2/2`
  - `document_summarize = 1/1`
- fail-closed count/rate: `2 / 4 = 0.5`
- ambiguity count/rate: `1 / 4 = 0.25`
- fallback distribution:
  - `search_company_brain_docs = 2 / 4 = 0.5`
  - `search_and_detail_doc = 2 / 4 = 0.5`
- routing mismatch rate: `0`
- answer inconsistency rate: `0`

This baseline is the only checked-in fact today. It is valid as an initial alert baseline, but it is still fixture-shaped and must not be over-described as a live traffic norm.

## Code Anchors

- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
- `/Users/seanhan/Documents/Playground/docs/system/trace_log_spec.md`

## Telemetry Adapter Layer

The runtime no longer writes directly to one concrete sink.

Current checked-in adapter contract:

- `emit(event)`
  - required
  - receives the fully built planner-visible telemetry event without altering schema
- `flush()`
  - optional
  - lets a sink finish local delivery when the caller explicitly asks
- `getBuffer()`
  - optional
  - primarily for the default in-memory adapter and local tests

Current checked-in adapters:

- `InMemoryTelemetryAdapter`
  - default runtime adapter
  - keeps a bounded local event buffer
  - preserves the prior collector behavior for tests and local inspection
- `StructuredLogTelemetryAdapter`
  - mock production-facing sink
  - serializes each event into one JSON log line
  - can write to `console` or a local file stub

Injection boundary:

- adapter selection happens when planner-visible runtime is initialized
- `executePlannedUserInput(...)` and `runPlannerToolFlow(...)` accept an injected adapter
- telemetry context carries the resolved adapter forward so later answer-boundary emission uses the same sink
- when no adapter is injected, runtime falls back to the default in-memory adapter

Sink lifecycle:

- `emit(...)`
  - called immediately at each checked-in planner-visible emission point
- `flush()`
  - not required for the default in-memory adapter, but available for adapters that stage writes
- `reset()`
  - adapter-specific helper used only by local tests and the default in-memory buffer
- buffer trimming
  - the default in-memory adapter keeps a bounded buffer and drops the oldest events first

## Query-Type Normalization

The live telemetry design uses one stable `query_type` enum:

- `search`
- `detail`
- `mixed`
- `follow-up`

Mapping from the current checked-in watch pack:

- `search_and_summarize` fixture -> `search`
- `detail_summary` fixture -> `detail`
- `mixed_query` fixture -> `mixed`
- `follow_up_reference` fixture -> `follow-up`

This normalization is telemetry-only. It does not change current planner selection logic.

## Event Schema

All five planner-visible telemetry events must carry the same shared fields:

- `query_type`
- `selected_skill`
  - skill name or `null`
- `candidate_skills`
  - ordered list of planner-visible skills considered for this request
- `decision_reason`
  - human-readable explanation
- `routing_family`
  - normalized routing family, not raw planner prose
- `request_id`
  - request correlation key
- `timestamp`
  - event creation time in ISO 8601

Recommended shared extension fields:

- `trace_id`
  - current runtime already supports it; use when available
- `reason_code`
  - machine-readable alert/debug bucket
- `task_type`
  - when the request came through deterministic task-type entry

### Routing Family Enum

Use a bounded family set:

- `planner_visible_search`
- `planner_visible_detail`
- `search_company_brain_docs`
- `search_and_detail_doc`
- `routing_no_match`

### 1. `planner_visible_skill_selected`

Emit when:

- deterministic selector matched a planner-visible skill
- admission passed
- routing commits to that skill path

Additional fields:

- `selector_key`
- `admission_outcome = "admitted"`
- `skill_surface_layer`
- `skill_promotion_stage`

Current expected examples:

- `query_type=search` + `selected_skill=search_and_summarize` + `routing_family=planner_visible_search`
- `query_type=detail` + `selected_skill=document_summarize` + `routing_family=planner_visible_detail`

### 2. `planner_visible_fail_closed`

Emit when:

- planner-visible admission was evaluated
- the request was intentionally denied fail-closed

Additional fields:

- `fail_closed_stage`
  - `selector | admission | execution`
- `admission_outcome = "fail_closed"`
- `rejected_skills`
- `ambiguity_detected`

Current expected examples:

- `query_type=mixed`
- `query_type=follow-up`

### 3. `planner_visible_ambiguity`

Emit when:

- the deny reason is specifically ambiguity
- more than one planner-visible interpretation remained possible
- or query evidence was insufficient to safely admit one skill

Additional fields:

- `ambiguity_signals`
- `rejected_skills`
- `admission_outcome = "ambiguous_fail_closed"`

Current expected example:

- `query_type=mixed`

### 4. `planner_visible_fallback`

Emit when:

- the monitored request routes back to the existing non-skill family
- whether because of fail-closed, disablement, or tighter admission

Additional fields:

- `fallback_action`
- `fallback_reason`
- `fallback_family_source`
  - `baseline_guard | skill_disabled | tightened_admission`
- `disabled_skill`
  - optional

Current expected examples:

- `query_type=search` fail-closed should normally fall back to `search_company_brain_docs`
- `query_type=detail` or `follow-up` fail-closed should normally fall back to `search_and_detail_doc`

### 5. `planner_visible_answer_generated`

Emit after `chat_output_boundary` confirms the user-visible answer boundary.

Additional fields:

- `answer_pipeline_enforced`
- `raw_payload_blocked`
- `answer_contract_ok`
- `answer_consistency_proxy_ok`
- `answer_skill_action`
- `source_count`
- `limitation_count`
- `answer_shape_signature`

This event is the live boundary proof that the selected skill or fallback route still produced a normalized user-facing answer rather than a raw bridge payload.

## Metrics Definition

All rate metrics must use a monitored denominator:

- only requests where planner-visible selection/admission was actually evaluated
- do not dilute with unrelated planner traffic

### 1. Per-Skill Hit Rate

Definition:

- numerator:
  - count of `planner_visible_skill_selected` where `selected_skill = <skill>`
- denominator:
  - count of monitored requests where `candidate_skills` contains `<skill>`

Reason:

- this matches the current coexistence watch more closely than using total traffic
- it stays comparable even when query-type mix changes

Initial checked-in baseline:

- `search_and_summarize = 1.0`
- `document_summarize = 1.0`

### 2. Fail-Closed Rate

Definition:

- numerator:
  - count of `planner_visible_fail_closed`
- denominator:
  - count of monitored planner-visible requests

Initial checked-in baseline:

- `0.5`

### 3. Ambiguity Rate

Definition:

- numerator:
  - count of `planner_visible_ambiguity`
- denominator:
  - count of monitored planner-visible requests

Initial checked-in baseline:

- `0.25`

### 4. Fallback Distribution

Definition:

- count `planner_visible_fallback` grouped by `routing_family`
- optionally split by `query_type`

Initial checked-in baseline:

- `search_company_brain_docs = 0.5`
- `search_and_detail_doc = 0.5`

### 5. Routing Mismatch Rate

Definition:

- numerator:
  - monitored requests whose emitted `routing_family` does not match the checked expectation for the observed `query_type` or selected skill
- denominator:
  - count of monitored planner-visible requests

Expected initial matrix:

- `search` + selected `search_and_summarize` -> `planner_visible_search`
- `detail` + selected `document_summarize` -> `planner_visible_detail`
- `mixed` fail-closed -> `search_company_brain_docs`
- `follow-up` fail-closed -> `search_and_detail_doc`

Current baseline:

- `0`

### 6. Answer Inconsistency Rate

This must stay a proxy metric because the current runtime does not have a live semantic judge for every answer.

Definition:

- numerator:
  - count of `planner_visible_answer_generated` where `answer_consistency_proxy_ok = false`
- denominator:
  - count of `planner_visible_answer_generated`

The proxy turns false when any one of these becomes true:

- `answer_pipeline_enforced != true`
- `raw_payload_blocked != true`
- `answer_contract_ok != true`
- `selected_skill` is non-null but `answer_skill_action` differs
- `routing_family` on the answer event differs from the selected/fallback family already recorded for the same request
- the success path produces an impossible normalized shape
  - missing answer body
  - missing `sources`
  - missing `limitations`

Optional future extension:

- replay/canary fingerprint drift using `answer_shape_signature`

Current baseline:

- `0`

## Alert Thresholds

These thresholds are intentionally aligned to the current checked-in watch, not to unobserved production assumptions.

### Selector Overlap

Trigger:

- `selector overlap > 0`

Severity:

- critical

Action:

- immediate investigation
- prepare single-skill disable first
- escalate to global planner-visible disable if overlap is not isolated

### Fail-Closed Rate

Trigger:

- `fail_closed_rate > baseline + delta`
- initial baseline `0.5`
- initial delta `0.1`
- minimum sample size `30`

Interpretation:

- alert above `0.6`
- because the initial baseline comes from a fixture pack with intentionally bounded fail-closed cases, this threshold must be re-baselined after real shadow data exists

### Ambiguity Rate

Trigger:

- `ambiguity_rate > baseline + delta`
- initial baseline `0.25`
- initial delta `0.1`
- minimum sample size `30`

Interpretation:

- alert above `0.35`
- also alert if it exceeds rolling 7-day baseline by the same delta once live history exists

### Fallback Distribution

Trigger:

- a new fallback `routing_family` appears
- or an existing family share drifts by more than `0.2`
- minimum sample size `30`

Initial baseline:

- `search_company_brain_docs = 0.5`
- `search_and_detail_doc = 0.5`

Interpretation:

- a strong skew usually means admission drift, selector drift, or unexpected disablement

### Answer Mismatch

Trigger:

- any answer inconsistency above baseline
- baseline is `0`

Suggested severity split:

- warning:
  - first single mismatch
- critical:
  - `>= 3` mismatches within `1h`
  - or any mismatch tied to raw payload exposure / answer-pipeline bypass

## Rollback Design

The rollback design must not widen routing and must not change the planner public contract.

### 1. Single Skill Disable

Purpose:

- disable only the impacted `planner_visible` skill

Effect:

- remove that skill from planner-visible catalog exposure
- keep the internal skill runtime intact
- other planner-visible skill may remain active if metrics stay healthy

Target use:

- one-skill answer mismatch
- one-skill fail-closed inflation
- one-skill selector/admission drift

### 2. Global Planner-Visible Disable

Purpose:

- disable all `planner_visible` catalog exposure

Effect:

- route back to the existing non-skill routing family
- preserve current generic search/detail behavior
- keep skill runtime code available for internal deterministic callers if separately allowed later

Target use:

- selector overlap
- multi-skill routing mismatch
- multi-skill answer inconsistency

### 3. Admission Tightening

Purpose:

- keep planner-visible enabled but narrow its admissible surface

Effect:

- more traffic fails closed earlier
- mixed or weakly specified requests stay on original routing families
- no planner contract change

Target use:

- ambiguity spike
- fallback skew that points to overly broad admission rather than broken execution

### Feature-Flag Shape

Future runtime flag shape should remain narrow:

```json
{
  "planner_visible": {
    "enabled": true,
    "admission_mode": "baseline",
    "skills": {
      "search_and_summarize": {
        "enabled": true
      },
      "document_summarize": {
        "enabled": true
      }
    }
  }
}
```

This is design-only in the current thread. No checked-in runtime flag carrier exists yet.

## Trace / Debug SOP

One request should be traceable in this order:

1. `query`
   - request text, request id, optional task type
2. `planner`
   - planner begins routing and emits request-scoped reasoning
3. `selector`
   - inspect `planner_tool_select`
   - identify candidate skills, selector key, selection status
4. `admission`
   - inspect `planner_visible_skill_selected`, `planner_visible_fail_closed`, or `planner_visible_ambiguity`
   - answer:
     - why was a skill selected
     - why did it fail closed
5. `routing`
   - inspect `planner_visible_fallback` or selected routing family
   - confirm whether traffic stayed skill-backed or returned to the original family
6. `answer`
   - inspect `lobster_tool_execution`
   - inspect `chat_output_boundary`
   - inspect `planner_visible_answer_generated`

### Request-Level Debug Procedure

1. start from `request_id`
2. resolve `trace_id`
   - use `trace_id` directly if present
   - otherwise join from the request monitor / trace event store
3. list all trace events for that request
4. locate the first planner-visible event in the sequence
5. answer the selector question:
   - `candidate_skills`
   - `selected_skill`
   - `selector_key`
   - `decision_reason`
   - `reason_code`
6. answer the fail-closed question if present:
   - `fail_closed_stage`
   - `rejected_skills`
   - `ambiguity_signals`
   - `fallback_action`
   - `routing_family`
7. validate the answer boundary:
   - `answer_pipeline_enforced`
   - `raw_payload_blocked`
   - `answer_contract_ok`
   - `answer_consistency_proxy_ok`

### Minimum Fields Needed To Explain "Why This Skill?"

- `request_id`
- `trace_id`
- `query_type`
- `candidate_skills`
- `selected_skill`
- `selector_key`
- `decision_reason`
- `reason_code`
- `routing_family`

### Minimum Fields Needed To Explain "Why Fail-Closed?"

- `request_id`
- `trace_id`
- `query_type`
- `candidate_skills`
- `rejected_skills`
- `fail_closed_stage`
- `decision_reason`
- `reason_code`
- `ambiguity_signals`
- `fallback_action`
- `routing_family`

## Suggested Integration Path

When this design is wired later, the safest sequence is:

1. inject a production adapter that mirrors the existing event schema without changing runtime callsites
2. emit the five planner-visible telemetry events into the chosen structured-log or pipeline sink
3. mirror the same payloads into `http_request_trace_events`
4. compute metrics out-of-band
5. keep rollback control manual first
6. add feature-flag automation only after trace/debug quality is proven

This order preserves the current fail-closed posture and avoids introducing a second decision surface.

## Minimal Stub

The checked-in minimal stub for this design lives at:

- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`

What it does now:

- exports the event catalog
- exports metric definitions
- exports alert thresholds aligned to the current fixture baseline
- exports rollback mode definitions
- exports a stub event builder for future wiring/tests
- emits runtime events through an injected adapter, defaulting to local in-memory storage
- provides a mock structured-log adapter for future pipeline integration tests

What it does not do:

- it does not write SQLite rows
- it does not create dashboards
- it does not connect to Datadog, ELK, BigQuery, or another external backend
- it does not change planner behavior

## Current Assessment

The repo is ready for a production-facing telemetry design on this surface because the request and trace scaffolding already exists.

The repo is not yet running live planner-visible telemetry because:

- the current coexistence watch is still fixture-based
- there is no checked-in feature-flag carrier for planner-visible rollback
- there is no checked-in external telemetry pipeline

So the safe current position is:

- design is production-ready
- runtime adapter integration is checked in, but external pipeline wiring is intentionally deferred
- rollback policy remains fail-closed and manual-first
