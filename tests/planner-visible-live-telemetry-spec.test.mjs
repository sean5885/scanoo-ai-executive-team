import test from "node:test";
import assert from "node:assert/strict";

import {
  PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY,
  PLANNER_VISIBLE_TELEMETRY_BASELINE,
  PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG,
  PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
  PLANNER_VISIBLE_TELEMETRY_ROLLBACK_MODES,
  buildPlannerVisibleTelemetryEvent,
  buildPlannerVisibleTelemetryStubEvent,
  listPlannerVisibleTelemetryEvents,
} from "../src/planner-visible-live-telemetry-spec.mjs";

test("planner-visible live telemetry catalog keeps the required event set", () => {
  assert.deepEqual(listPlannerVisibleTelemetryEvents(), [
    "planner_visible_skill_selected",
    "planner_visible_fail_closed",
    "planner_visible_ambiguity",
    "planner_visible_fallback",
    "planner_visible_answer_generated",
  ]);
});

test("planner-visible live telemetry events keep the shared required fields", () => {
  for (const entry of Object.values(PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG)) {
    for (const field of PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS) {
      assert.equal(entry.required_fields.includes(field), true);
    }
  }
});

test("planner-visible live telemetry baseline stays aligned to the checked-in coexistence watch", () => {
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.selector_overlap_count, 0);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.fail_closed.count, 2);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.fail_closed.rate, 0.5);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.ambiguity.count, 1);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.ambiguity.rate, 0.25);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_BASELINE.answer_inconsistency_rate, 0);
});

test("planner-visible live telemetry alert policy keeps the requested thresholds", () => {
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY.selector_overlap_detected.condition, "selector_overlap_count > 0");
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY.fail_closed_rate_anomalous.delta, 0.1);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY.ambiguity_rate_spike.delta, 0.1);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY.fallback_distribution_anomalous.share_delta, 0.2);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY.answer_mismatch_detected.baseline_rate, 0);
});

test("planner-visible live telemetry rollback modes stay contract-preserving", () => {
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ROLLBACK_MODES.single_skill_disable.preserves_planner_contract, true);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ROLLBACK_MODES.global_planner_visible_disable.preserves_planner_contract, true);
  assert.equal(PLANNER_VISIBLE_TELEMETRY_ROLLBACK_MODES.admission_tightening.preserves_planner_contract, true);
});

test("planner-visible live telemetry stub event normalizes the monitored request shape", () => {
  const event = buildPlannerVisibleTelemetryStubEvent({
    event: "planner_visible_skill_selected",
    query_type: "search",
    selected_skill: "search_and_summarize",
    candidate_skills: ["search_and_summarize", "search_and_summarize", "document_summarize"],
    decision_reason: "search-plus-summarize admission passed",
    routing_family: "planner_visible_search",
    request_id: "req_demo_123",
    timestamp: "2026-03-29T12:00:00.000Z",
    trace_id: "trace_demo_123",
    extra: {
      reason_code: "admitted",
    },
  });

  assert.equal(event.selected_skill, "search_and_summarize");
  assert.deepEqual(event.candidate_skills, ["search_and_summarize", "document_summarize"]);
  assert.equal(event.request_id, "req_demo_123");
  assert.equal(event.trace_id, "trace_demo_123");
  assert.equal(event.reason_code, "admitted");
});

test("planner-visible live telemetry runtime builder rejects ad-hoc fields", () => {
  assert.throws(() => buildPlannerVisibleTelemetryEvent({
    event: "planner_visible_skill_selected",
    query_type: "search",
    selected_skill: "search_and_summarize",
    candidate_skills: ["search_and_summarize", "document_summarize"],
    decision_reason: "search-plus-summarize admission passed",
    routing_family: "planner_visible_search",
    request_id: "req_demo_123",
    timestamp: "2026-03-29T12:00:00.000Z",
    trace_id: "trace_demo_123",
    extra: {
      reason_code: "admitted",
      selector_key: "skill.search_and_summarize.read",
      admission_outcome: "admitted",
      ad_hoc_field: "not_allowed",
    },
  }), /unknown_planner_visible_telemetry_field:ad_hoc_field/);
});
