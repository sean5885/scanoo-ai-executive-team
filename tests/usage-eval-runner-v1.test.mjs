import test from "node:test";
import assert from "node:assert/strict";

const {
  loadUsageEvalCasesFromJson,
  runUsageEvalCase,
  runUsageEvalRunner,
  classifyUsageIssueVisibilityForTurn,
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
  assert.equal(Array.isArray(run.summary.top_detected_issues), true);
  assert.equal(Array.isArray(run.summary.top_user_visible_issues), true);
  assert.equal(Array.isArray(run.summary.top_usage_issues), true);
  assert.equal(typeof run.summary.raw_issue_distribution, "object");
  assert.equal(typeof run.summary.user_visible_issue_distribution, "object");
  assert.equal(typeof run.summary.suppression_effectiveness, "object");
  assert.equal(typeof run.summary.retry_context_success_rate, "number");
  assert.equal(typeof run.summary.slot_ask_suppression_success_rate, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(run.summary, "most_common_divergence_pattern"), true);
  assert.equal(typeof run.summary.action_promotion_performance, "object");
  assert.equal(Array.isArray(run.summary.action_promotion_performance.by_action), true);
  assert.equal(Array.isArray(run.summary.pause_promotion_actions), true);
  assert.equal(
    ["high", "medium", "low"].includes(run.summary.overall_intelligence_signal),
    true,
  );
});

test("slot suppression keeps redundant_slot_ask in detected layer but removes user-visible exposure", () => {
  const result = runUsageEvalCase({
    case_id: "slot-suppression-001",
    description: "slot suppression should not be user-visible issue",
    turns: [
      { user_input: "幫我看文件", expected_behavior_hint: "start_task" },
      { user_input: "先問我", expected_behavior_hint: "slot_missing redundant_ask" },
      { user_input: "繼續", expected_behavior_hint: "continuation redundant_ask with_context" },
    ],
  });

  assert.equal(result.ok, true);
  const targetTurn = result.turns[2];
  assert.deepEqual(targetTurn.issue_detected_codes.includes("redundant_slot_ask_suppressed"), true);
  assert.deepEqual(targetTurn.issue_exposed_codes.includes("redundant_slot_ask"), false);
  assert.deepEqual(targetTurn.issue_exposed_codes.includes("redundant_slot_ask_suppressed"), false);
  assert.equal(targetTurn.suppression_flags.slot.applied, true);
  assert.equal(targetTurn.suppression_flags.slot.successful, true);
  assert.deepEqual(targetTurn.trace_snapshot.issue_detected_codes.includes("redundant_slot_ask_suppressed"), true);
  assert.deepEqual(targetTurn.trace_snapshot.issue_exposed_codes.includes("redundant_slot_ask_suppressed"), false);
});

test("retry continuity suppression keeps retry issue detected but not exposed", () => {
  const visibility = classifyUsageIssueVisibilityForTurn({
    usage_layer: {
      retry_context_applied: true,
      usage_issue_codes: ["retry_without_contextual_response"],
    },
    user_response: {
      answer: "接著上一輪我先補上結果，這一步就沿原路徑完成。",
      sources: ["接著上一輪，我沿用同一個上下文。"],
      limitations: [],
    },
  });

  assert.equal(visibility.issue_detected, true);
  assert.deepEqual(visibility.issue_detected_codes.includes("retry_without_contextual_response"), true);
  assert.deepEqual(visibility.issue_exposed_codes.includes("retry_without_contextual_response"), false);
  assert.equal(visibility.suppression_flags.retry.applied, true);
  assert.equal(visibility.suppression_flags.retry.successful, true);
});

test("detected and user-visible issue distributions stay separated in aggregation", () => {
  const run = runUsageEvalRunner({
    case_count_target: { min: 1, max: 10 },
    cases: [
      {
        case_id: "issue-split-001",
        description: "trigger slot suppression and retry continuity",
        turns: [
          { user_input: "幫我看文件", expected_behavior_hint: "start_task" },
          { user_input: "先問我", expected_behavior_hint: "slot_missing redundant_ask" },
          { user_input: "繼續", expected_behavior_hint: "continuation redundant_ask with_context" },
          { user_input: "retry", expected_behavior_hint: "retry retry_effective with_context" },
        ],
      },
    ],
  });

  assert.equal(run.ok, true);
  assert.equal(run.aggregated_metrics.usage_layer.issue_detected_count_by_code.redundant_slot_ask_suppressed > 0, true);
  assert.equal(run.aggregated_metrics.usage_layer.issue_exposed_count_by_code.redundant_slot_ask_suppressed || 0, 0);
  assert.equal(run.summary.raw_issue_distribution.redundant_slot_ask_suppressed > 0, true);
  assert.equal(run.summary.user_visible_issue_distribution.redundant_slot_ask_suppressed || 0, 0);
  assert.equal(run.aggregated_metrics.slot_ask_suppression_quality.slot_ask_suppression_success_rate, 1);
  assert.equal(run.aggregated_metrics.retry_context_quality.retry_context_success_rate, 1);
});

test("issue visibility suppression fails closed on malformed suppression context", () => {
  const visibility = classifyUsageIssueVisibilityForTurn({
    usage_layer: {
      slot_suppressed_ask: true,
      retry_context_applied: true,
      usage_issue_codes: ["redundant_slot_ask", "retry_without_contextual_response"],
    },
    decision_promotion: {
      promoted_action: "ask_user",
      promotion_applied: true,
    },
    user_response: {
      answer: "我先當作新任務重新開始處理。",
      sources: [],
      limitations: [],
    },
    slot_state_snapshot: [
      { slot_key: "doc_id", status: "invalid", invalid: true },
    ],
  });

  assert.equal(visibility.issue_detected, true);
  assert.deepEqual(visibility.issue_exposed_codes.includes("redundant_slot_ask"), true);
  assert.deepEqual(visibility.issue_exposed_codes.includes("retry_without_contextual_response"), true);
  assert.equal(visibility.suppression_flags.slot.successful, false);
  assert.equal(visibility.suppression_flags.retry.successful, false);
});
