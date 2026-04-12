import test from "node:test";
import assert from "node:assert/strict";

const {
  loadUsageEvalCasesFromJson,
  runUsageEvalCase,
  runUsageEvalRunner,
} = await import("../src/usage-eval-runner.mjs");

test("usage eval runner executes multi-turn case and captures per-turn surfaces", () => {
  const loaded = loadUsageEvalCasesFromJson();
  const testCase = loaded.cases.find((item) => item?.case_id === "cont-001");
  assert.ok(testCase, "missing cont-001 fixture");

  const result = runUsageEvalCase(testCase);

  assert.equal(result.ok, true);
  assert.equal(result.fail_closed, false);
  assert.equal(result.case_id, "cont-001");
  assert.equal(Array.isArray(result.turns), true);
  assert.equal(result.turns.length, 3);
  for (const turn of result.turns) {
    assert.equal(typeof turn.usage_layer, "object");
    assert.equal(typeof turn.decision_promotion, "object");
    assert.equal(typeof turn.advisor_alignment, "object");
    assert.equal(typeof turn.outcome, "object");
    assert.equal(typeof turn.readiness, "object");
    assert.equal(typeof turn.trace_snapshot, "object");
    assert.equal(turn.trace_snapshot.case_id, "cont-001");
    assert.equal(typeof turn.trace_snapshot.turn_index, "number");
    assert.equal(typeof turn.trace_snapshot.response_continuity_score, "string");
  }
});

test("usage eval runner aggregates deterministic metrics correctly", () => {
  const run = runUsageEvalRunner({
    case_count_target: { min: 1, max: 10 },
    cases: [
      {
        case_id: "agg-001",
        description: "slot flow baseline",
        turns: [
          { user_input: "幫我打開文件", expected_behavior_hint: "start_task" },
          { user_input: "直接打開", expected_behavior_hint: "slot_missing" },
          { user_input: "doc-20", expected_behavior_hint: "slot_filled_resume continuation with_context" },
        ],
      },
      {
        case_id: "agg-002",
        description: "continuation + promotion baseline",
        turns: [
          { user_input: "先整理摘要", expected_behavior_hint: "start_task" },
          { user_input: "第一份", expected_behavior_hint: "continuation_missed" },
          { user_input: "retry", expected_behavior_hint: "retry retry_effective with_context" },
          { user_input: "改由 runtime", expected_behavior_hint: "reroute reroute_effective with_context" },
        ],
      },
    ],
  });

  assert.equal(run.ok, true);
  assert.equal(run.fail_closed, false);
  assert.equal(run.total_cases, 2);
  assert.equal(run.aggregated_metrics.continuation_quality.continuation_intent_turns, 4);
  assert.equal(run.aggregated_metrics.continuation_quality.continuation_hits, 3);
  assert.equal(run.aggregated_metrics.continuation_quality.continuation_rate, 0.75);
  assert.equal(run.aggregated_metrics.continuation_quality.mistaken_new_task_count, 1);
  assert.equal(run.aggregated_metrics.slot_resume_quality.slot_fill_resume_attempts, 1);
  assert.equal(run.aggregated_metrics.slot_resume_quality.slot_fill_resume_successes, 1);
  assert.equal(run.aggregated_metrics.slot_resume_quality.slot_fill_resume_success_rate, 1);
  assert.equal(run.aggregated_metrics.decision_engine.promotion_applied_count_by_action.ask_user, 1);
  assert.equal(run.aggregated_metrics.decision_engine.promotion_applied_count_by_action.retry, 1);
  assert.equal(run.aggregated_metrics.decision_engine.promotion_applied_count_by_action.reroute, 1);
  assert.equal(run.aggregated_metrics.reroute_quality.reroute_applied_count, 1);
  assert.equal(run.aggregated_metrics.reroute_quality.reroute_effective_rate, 1);
});

test("usage eval runner fail-closes malformed cases", () => {
  const run = runUsageEvalRunner({
    cases: [
      {
        description: "missing case_id and malformed turns",
        turns: [
          { expected_behavior_hint: "start_task" },
        ],
      },
    ],
  });

  assert.equal(run.ok, false);
  assert.equal(run.fail_closed, true);
  assert.equal(run.error_type, "contract_violation");
  assert.equal(Array.isArray(run.validation_issues), true);
  assert.equal(run.validation_issues.length > 0, true);
  assert.equal(run.cases.length, 0);
});

test("usage eval runner returns required summary structure", () => {
  const loaded = loadUsageEvalCasesFromJson();
  const run = runUsageEvalRunner({
    cases: loaded.cases.slice(0, 6),
    case_count_target: { min: 1, max: 10 },
  });

  assert.equal(run.ok, true);
  assert.equal(typeof run.summary, "object");
  assert.equal(Array.isArray(run.summary.top_usage_issues), true);
  assert.equal(Object.prototype.hasOwnProperty.call(run.summary, "most_common_divergence_pattern"), true);
  assert.equal(typeof run.summary.action_promotion_performance, "object");
  assert.equal(Array.isArray(run.summary.action_promotion_performance.by_action), true);
  assert.equal(Array.isArray(run.summary.pause_promotion_actions), true);
  assert.equal(
    ["high", "medium", "low"].includes(run.summary.overall_intelligence_signal),
    true,
  );
});

