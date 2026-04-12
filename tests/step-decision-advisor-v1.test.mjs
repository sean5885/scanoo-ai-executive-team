import test from "node:test";
import assert from "node:assert/strict";

const [
  {
    STEP_DECISION_ADVISOR_REASON_CODES,
    STEP_DECISION_ADVISOR_VERSION,
    adviseStepNextAction,
  },
  { buildPlannerTaskTraceDiagnostics },
] = await Promise.all([
  import("../src/step-decision-advisor.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
]);

function buildBaseState(overrides = {}) {
  return {
    readiness: {
      is_ready: true,
      blocking_reason_codes: [],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: true,
      recovery_ready: true,
      recommended_action: "proceed",
      ...(overrides.readiness || {}),
    },
    outcome: {
      outcome_status: "success",
      outcome_confidence: 0.92,
      outcome_evidence: {
        slots_filled_count: 1,
        slots_missing_count: 0,
        artifacts_produced_count: 1,
        errors_encountered: [],
        recovery_actions_taken: [],
      },
      artifact_quality: "valid",
      retry_worthiness: false,
      user_visible_completeness: "complete",
      ...(overrides.outcome || {}),
    },
    recovery: {
      recovery_policy: null,
      recovery_action: null,
      recovery_attempt_count: 0,
      rollback_target_step_id: null,
      retry_allowed: true,
      skip_allowed: false,
      continuation_allowed: true,
      ...(overrides.recovery || {}),
    },
    artifact: {
      artifact_id: "artifact-1",
      artifact_type: "search_result",
      validity_status: "valid",
      dependency_type: null,
      dependency_blocked_step: null,
      invalid_artifacts: [],
      blocked_dependency_count: 0,
      dependencies_allow_skip: true,
      ...(overrides.artifact || {}),
    },
    task_plan: {
      task_id: "task-1",
      plan_id: "plan-1",
      plan_status: "active",
      current_step_id: "step-1",
      current_step_status: "running",
      failure_class: null,
      step_retryable: true,
      step_non_critical: false,
      malformed_input: false,
      ...(overrides.task_plan || {}),
    },
  };
}

test("advisor reason code catalog includes required reason codes", () => {
  const required = [
    "step_ready",
    "missing_slot_block",
    "invalid_artifact_block",
    "blocked_dependency",
    "owner_mismatch",
    "retry_worthy",
    "recovery_failed",
    "rollback_available",
    "skip_allowed",
    "plan_invalidated",
    "outcome_partial",
    "outcome_failed",
    "outcome_success",
  ];
  for (const code of required) {
    assert.equal(STEP_DECISION_ADVISOR_REASON_CODES.includes(code), true);
  }
});

test("ready + success recommends proceed", () => {
  const decision = adviseStepNextAction(buildBaseState());
  assert.equal(decision.recommended_next_action, "proceed");
  assert.equal(decision.decision_reason_codes.includes("step_ready"), true);
  assert.equal(decision.decision_reason_codes.includes("outcome_success"), true);
  assert.equal(decision.advisor_version, STEP_DECISION_ADVISOR_VERSION);
});

test("missing_slot block recommends ask_user", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
      missing_slots: ["candidate_selection_required"],
      recommended_action: "ask_user",
    },
    outcome: {
      outcome_status: "blocked",
      retry_worthiness: false,
      user_visible_completeness: "none",
    },
  }));
  assert.equal(decision.recommended_next_action, "ask_user");
  assert.equal(decision.decision_reason_codes.includes("missing_slot_block"), true);
});

test("retry worthy + retry allowed recommends retry", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: true,
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: true,
      outcome_evidence: {
        slots_filled_count: 1,
        slots_missing_count: 0,
        artifacts_produced_count: 0,
        errors_encountered: ["tool_error"],
        recovery_actions_taken: ["retry_same_step"],
      },
    },
    recovery: {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      retry_allowed: true,
    },
  }));
  assert.equal(decision.recommended_next_action, "retry");
  assert.equal(decision.decision_reason_codes.includes("retry_worthy"), true);
});

test("owner mismatch recommends reroute", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch"],
      owner_ready: false,
      recommended_action: "reroute",
    },
    outcome: {
      outcome_status: "failed",
      retry_worthiness: false,
    },
    task_plan: {
      failure_class: "capability_gap",
    },
  }));
  assert.equal(decision.recommended_next_action, "reroute");
  assert.equal(decision.decision_reason_codes.includes("owner_mismatch"), true);
});

test("invalid artifact with rollback target recommends rollback", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["invalid_artifact"],
      invalid_artifacts: [{
        artifact_id: "artifact-bad",
        validity_status: "invalid",
        blocked_step_id: "step-2",
        rollback_target_step_id: "step-1",
      }],
      recommended_action: "rollback",
    },
    outcome: {
      outcome_status: "blocked",
      retry_worthiness: false,
    },
    recovery: {
      recovery_policy: "rollback_to_step",
      recovery_action: "rollback_to_step",
      rollback_target_step_id: "step-1",
      rollback_available: true,
    },
  }));
  assert.equal(decision.recommended_next_action, "rollback");
  assert.equal(decision.decision_reason_codes.includes("invalid_artifact_block"), true);
  assert.equal(decision.decision_reason_codes.includes("rollback_available"), true);
});

test("skip allowed with dependencies allowed recommends skip", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: [],
      recommended_action: "skip",
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: false,
    },
    recovery: {
      recovery_policy: "skip_step",
      recovery_action: "skip_step",
      skip_allowed: true,
    },
    task_plan: {
      step_non_critical: true,
      step_retryable: false,
    },
  }));
  assert.equal(decision.recommended_next_action, "skip");
  assert.equal(decision.decision_reason_codes.includes("skip_allowed"), true);
});

test("invalidated plan recommends fail", () => {
  const decision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["plan_invalidated"],
      recommended_action: "fail",
    },
    task_plan: {
      plan_status: "invalidated",
    },
  }));
  assert.equal(decision.recommended_next_action, "fail");
  assert.equal(decision.decision_reason_codes.includes("plan_invalidated"), true);
});

test("partial outcome chooses deterministic retry or ask_user", () => {
  const retryDecision = adviseStepNextAction(buildBaseState({
    outcome: {
      outcome_status: "partial",
      retry_worthiness: true,
      outcome_evidence: {
        slots_filled_count: 1,
        slots_missing_count: 0,
        artifacts_produced_count: 0,
        errors_encountered: ["tool_error"],
        recovery_actions_taken: [],
      },
    },
    recovery: {
      retry_allowed: true,
      recovery_action: null,
    },
  }));
  const askDecision = adviseStepNextAction(buildBaseState({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
      missing_slots: ["doc_id"],
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: false,
      outcome_evidence: {
        slots_filled_count: 0,
        slots_missing_count: 1,
        artifacts_produced_count: 0,
        errors_encountered: ["missing_slot"],
        recovery_actions_taken: [],
      },
    },
  }));

  assert.equal(retryDecision.recommended_next_action, "retry");
  assert.equal(askDecision.recommended_next_action, "ask_user");
  assert.equal(askDecision.decision_reason_codes.includes("outcome_partial"), true);
});

test("task trace diagnostics expose advisor recommendation and comparison", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-advisor-trace",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      execution_plan: {
        plan_id: "plan-advisor-trace",
        plan_status: "active",
        current_step_id: "step-1",
        steps: [
          {
            step_id: "step-1",
            status: "running",
          },
        ],
      },
    },
    observability: {
      advisor: {
        recommended_next_action: "retry",
        decision_reason_codes: ["retry_worthy", "outcome_partial"],
        decision_confidence: "high",
        advisor_version: STEP_DECISION_ADVISOR_VERSION,
      },
      advisor_based_on_summary: "readiness=true ; reasons=none ; outcome=partial",
      advisor_vs_actual: {
        recommended_next_action: "retry",
        actual_next_action: "ask_user",
        is_aligned: false,
      },
    },
  });

  assert.equal(trace.diff.includes("advisor.recommended_next_action: retry"), true);
  assert.equal(trace.diff.includes("advisor.decision_confidence: high"), true);
  assert.equal(trace.diff.some((line) => line.startsWith("advisor_vs_actual:")), true);
  assert.match(trace.text, /advisor: action=retry/);
  assert.equal(trace.event_alignment.advisor_recommended_next_action, true);
  assert.equal(trace.event_alignment.advisor_vs_actual, true);
});

test("malformed advisor inputs fail-closed", () => {
  const decision = adviseStepNextAction({
    readiness: "bad",
    outcome: null,
    recovery: [],
    task_plan: null,
  });
  assert.equal(decision.recommended_next_action, "fail");
  assert.equal(decision.decision_confidence, "low");
  assert.equal(decision.decision_reason_codes.includes("plan_invalidated"), true);
});
