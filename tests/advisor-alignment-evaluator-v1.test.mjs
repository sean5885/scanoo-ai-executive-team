import test from "node:test";
import assert from "node:assert/strict";

const [
  {
    ADVISOR_ALIGNMENT_EVALUATOR_VERSION,
    evaluateAdvisorAlignment,
  },
  { buildPlannerTaskTraceDiagnostics },
] = await Promise.all([
  import("../src/advisor-alignment-evaluator.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
]);

test("exact match returns aligned exact_match", () => {
  const result = evaluateAdvisorAlignment({
    advisor_action: "retry",
    actual_action: "retry",
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
      recommended_action: "ask_user",
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: true,
    },
  });

  assert.equal(result.is_aligned, true);
  assert.equal(result.alignment_type, "exact_match");
  assert.deepEqual(result.divergence_reason_codes, []);
  assert.equal(result.evaluator_version, ADVISOR_ALIGNMENT_EVALUATOR_VERSION);
});

test("actual more conservative retry->ask_user is acceptable divergence when blocked evidence exists", () => {
  const result = evaluateAdvisorAlignment({
    advisor_action: "retry",
    actual_action: "ask_user",
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
      missing_slots: ["doc_id"],
      recommended_action: "ask_user",
    },
    outcome: {
      outcome_status: "blocked",
      retry_worthiness: false,
      outcome_evidence: {
        errors_encountered: ["missing_slot"],
      },
    },
  });

  assert.equal(result.is_aligned, false);
  assert.equal(result.alignment_type, "acceptable_divergence");
  assert.equal(result.divergence_reason_codes.includes("actual_more_conservative"), true);
  assert.equal(result.promotion_candidate, false);
});

test("advisor optimistic proceed->rollback is hard divergence", () => {
  const result = evaluateAdvisorAlignment({
    advisor_action: "proceed",
    actual_action: "rollback",
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["invalid_artifact"],
    },
    recovery: {
      recovery_action: "rollback_to_step",
      rollback_target_step_id: "step-1",
    },
  });

  assert.equal(result.is_aligned, false);
  assert.equal(result.alignment_type, "hard_divergence");
  assert.equal(result.divergence_reason_codes.includes("actual_more_conservative"), true);
});

test("malformed input fails closed as unknown", () => {
  const result = evaluateAdvisorAlignment({
    advisor_action: "ask_user",
    actual_action: "fail",
    readiness: ["bad"],
  });

  assert.equal(result.is_aligned, false);
  assert.equal(result.alignment_type, "unknown");
  assert.equal(result.divergence_reason_codes.includes("malformed_alignment_input"), true);
  assert.equal(result.promotion_candidate, false);
});

test("missing actual action fails closed as unknown", () => {
  const result = evaluateAdvisorAlignment({
    advisor_action: "ask_user",
    actual_action: null,
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
    },
  });

  assert.equal(result.is_aligned, false);
  assert.equal(result.alignment_type, "unknown");
  assert.equal(result.divergence_reason_codes.includes("missing_actual_action"), true);
});

test("promotion candidate only true on exact match with complete evidence", () => {
  const promoted = evaluateAdvisorAlignment({
    advisor_action: "proceed",
    actual_action: "proceed",
    readiness: {
      is_ready: true,
      blocking_reason_codes: [],
      recommended_action: "proceed",
    },
    outcome: {
      outcome_status: "success",
      retry_worthiness: false,
    },
  });
  const notPromoted = evaluateAdvisorAlignment({
    advisor_action: "proceed",
    actual_action: "proceed",
    evidence_complete: false,
  });

  assert.equal(promoted.alignment_type, "exact_match");
  assert.equal(promoted.promotion_candidate, true);
  assert.equal(notPromoted.alignment_type, "exact_match");
  assert.equal(notPromoted.promotion_candidate, false);
});

test("trace diagnostics expose advisor alignment fields", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-alignment-trace",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
    },
    observability: {
      advisor: {
        recommended_next_action: "retry",
        decision_reason_codes: ["retry_worthy"],
        decision_confidence: "high",
      },
      advisor_alignment: {
        advisor_action: "retry",
        actual_action: "ask_user",
        is_aligned: false,
        alignment_type: "acceptable_divergence",
        divergence_reason_codes: ["actual_more_conservative"],
        promotion_candidate: false,
        evaluator_version: ADVISOR_ALIGNMENT_EVALUATOR_VERSION,
      },
      advisor_alignment_summary: "advisor=retry actual=ask_user aligned=false type=acceptable_divergence reasons=[actual_more_conservative] promotion_candidate=false",
    },
  });

  assert.equal(trace.diff.some((line) => line.startsWith("advisor_alignment:")), true);
  assert.equal(trace.diff.some((line) => line.startsWith("advisor_alignment_summary:")), true);
  assert.equal(trace.snapshot.advisor_alignment?.alignment_type, "acceptable_divergence");
  assert.equal(trace.event_alignment.advisor_alignment, true);
  assert.equal(trace.event_alignment.advisor_alignment_summary, true);
  assert.match(trace.text, /alignment=/);
});
