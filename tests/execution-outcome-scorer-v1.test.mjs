import test from "node:test";
import assert from "node:assert/strict";

const [
  { scoreExecutionOutcome },
  { buildPlannerTaskTraceDiagnostics },
  {
    applyPlannerWorkingMemoryPatch,
    getPlannerWorkingMemory,
    resetPlannerConversationMemory,
  },
] = await Promise.all([
  import("../src/execution-outcome-scorer.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
  import("../src/planner-conversation-memory.mjs"),
]);

function buildOutcomeSeedSessionPatch() {
  return {
    current_goal: "seed goal",
    inferred_task_type: "document_lookup",
    last_selected_agent: "doc_agent",
    last_selected_skill: null,
    last_tool_result_summary: "seed summary",
    unresolved_slots: [],
    next_best_action: "search_company_brain_docs",
    confidence: 0.9,
    task_id: "task-outcome-seed",
    task_type: "document_lookup",
    task_phase: "executing",
    task_status: "running",
    current_owner_agent: "doc_agent",
    previous_owner_agent: null,
    handoff_reason: null,
    retry_count: 0,
    retry_policy: {
      max_retries: 2,
      strategy: "same_agent_then_reroute",
    },
    slot_state: [],
    abandoned_task_ids: [],
    execution_plan: {
      plan_id: "plan-outcome-seed",
      plan_status: "active",
      current_step_id: "step-1",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
          failure_class: null,
          recovery_policy: null,
          recovery_state: {
            last_failure_class: null,
            recovery_attempt_count: 0,
            last_recovery_action: null,
            rollback_target_step_id: null,
          },
        },
      ],
      artifacts: [],
      dependency_edges: [],
    },
  };
}

test("outcome scorer marks complete successful step as success", () => {
  const outcome = scoreExecutionOutcome({
    stepStatus: "completed",
    requiredSlots: ["doc_id"],
    missingSlots: [],
    artifactsProducedCount: 1,
    artifactValidityStatus: "valid",
    userVisibleAnswer: "已完成",
    userVisibleSources: ["doc_1"],
  });

  assert.equal(outcome.outcome_status, "success");
  assert.equal(outcome.user_visible_completeness, "complete");
  assert.equal(outcome.artifact_quality, "valid");
});

test("outcome scorer marks missing slots as partial", () => {
  const outcome = scoreExecutionOutcome({
    stepStatus: "running",
    requiredSlots: ["doc_id", "scope_id"],
    missingSlots: ["scope_id"],
    artifactsProducedCount: 0,
    error: "",
    userVisibleAnswer: "還缺少一些資訊",
  });

  assert.equal(outcome.outcome_status, "partial");
  assert.equal(outcome.outcome_evidence.slots_missing_count, 1);
  assert.equal(outcome.user_visible_completeness, "partial");
});

test("outcome scorer marks readiness-gated step as blocked", () => {
  const outcome = scoreExecutionOutcome({
    stepStatus: "blocked",
    requiredSlots: ["candidate_selection_required"],
    missingSlots: ["candidate_selection_required"],
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["missing_slot"],
      missing_slots: ["candidate_selection_required"],
    },
    recoveryAction: "ask_user",
    recoveryPolicy: "ask_user",
  });

  assert.equal(outcome.outcome_status, "blocked");
  assert.equal(outcome.retry_worthiness, false);
});

test("outcome scorer marks terminal recovery failure as failed", () => {
  const outcome = scoreExecutionOutcome({
    stepStatus: "failed",
    error: "business_error",
    failureClass: "unknown",
    recoveryAction: "failed",
    recoveryPolicy: "ask_user",
    hasUserVisibleOutputFlag: false,
  });

  assert.equal(outcome.outcome_status, "failed");
  assert.equal(outcome.user_visible_completeness, "none");
});

test("outcome scorer retry worthiness follows deterministic rules", () => {
  const retryable = scoreExecutionOutcome({
    stepStatus: "failed",
    error: "tool_error",
    failureClass: "tool_error",
    recoveryAction: "retry_same_step",
    artifactValidityStatus: "valid",
  });
  const missingSlot = scoreExecutionOutcome({
    stepStatus: "blocked",
    error: "missing_slot",
    failureClass: "missing_slot",
    recoveryAction: "ask_user",
    artifactValidityStatus: "valid",
  });
  const invalidArtifact = scoreExecutionOutcome({
    stepStatus: "failed",
    error: "invalid_artifact",
    failureClass: "invalid_artifact",
    recoveryAction: "rollback_to_step",
    artifactValidityStatus: "invalid",
  });
  const unknownFailure = scoreExecutionOutcome({
    stepStatus: "failed",
    error: "unknown",
    failureClass: "unknown",
    recoveryAction: "failed",
  });

  assert.equal(retryable.retry_worthiness, true);
  assert.equal(missingSlot.retry_worthiness, false);
  assert.equal(invalidArtifact.retry_worthiness, false);
  assert.equal(unknownFailure.retry_worthiness, false);
});

test("trace diagnostics include outcome fields", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-outcome-trace",
      execution_plan: {
        plan_id: "plan-outcome-trace",
        plan_status: "active",
        current_step_id: "step-1",
        steps: [
          {
            step_id: "step-1",
            status: "running",
            outcome: {
              outcome_status: "partial",
              outcome_confidence: 0.6,
              outcome_evidence: {
                slots_filled_count: 1,
                slots_missing_count: 1,
                artifacts_produced_count: 0,
                errors_encountered: ["missing_slot"],
                recovery_actions_taken: ["ask_user"],
              },
              artifact_quality: "unknown",
              retry_worthiness: false,
              user_visible_completeness: "partial",
            },
          },
        ],
      },
    },
    memorySnapshot: {
      task_id: "task-outcome-trace",
      execution_plan: {
        plan_id: "plan-outcome-trace",
        plan_status: "completed",
        current_step_id: null,
        steps: [
          {
            step_id: "step-1",
            status: "completed",
            outcome: {
              outcome_status: "success",
              outcome_confidence: 0.95,
              outcome_evidence: {
                slots_filled_count: 2,
                slots_missing_count: 0,
                artifacts_produced_count: 1,
                errors_encountered: [],
                recovery_actions_taken: [],
              },
              artifact_quality: "valid",
              retry_worthiness: false,
              user_visible_completeness: "complete",
            },
          },
        ],
      },
    },
  });

  assert.equal(trace.diff.includes("outcome_status: partial -> success"), true);
  assert.equal(trace.diff.some((line) => line.startsWith("outcome_evidence:")), true);
  assert.match(trace.text, /outcome: status=success/);
});

test("answer-boundary execution plan patch merges outcome without overriding step status", () => {
  const sessionKey = "wm-outcome-patch-merge";
  resetPlannerConversationMemory({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_outcome_patch_seed",
    patch: buildOutcomeSeedSessionPatch(),
  });

  const outcome = scoreExecutionOutcome({
    stepStatus: "running",
    requiredSlots: [],
    missingSlots: [],
    artifactsProducedCount: 0,
    recoveryAction: "retry_same_step",
    failureClass: "tool_error",
    error: "tool_error",
  });

  const mergeResult = applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_outcome_patch_merge",
    patch: {
      execution_plan: {
        steps: [
          {
            step_id: "step-1",
            outcome,
          },
        ],
      },
    },
  });

  assert.equal(mergeResult.ok, true);
  const memory = getPlannerWorkingMemory({ sessionKey });
  const step = memory.execution_plan.steps.find((item) => item.step_id === "step-1");
  assert.equal(step?.status, "running");
  assert.equal(step?.outcome?.outcome_status, outcome.outcome_status);

  resetPlannerConversationMemory({ sessionKey });
});

test("malformed outcome patch fails closed", () => {
  const sessionKey = "wm-outcome-malformed";
  resetPlannerConversationMemory({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_outcome_malformed_seed",
    patch: buildOutcomeSeedSessionPatch(),
  });

  const malformedResult = applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_outcome_malformed_patch",
    patch: {
      execution_plan: {
        steps: [
          {
            step_id: "step-1",
            outcome: {
              outcome_status: "success",
              outcome_confidence: 0.8,
              retry_worthiness: "yes",
            },
          },
        ],
      },
    },
  });

  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.error, "invalid_working_memory_execution_plan");

  resetPlannerConversationMemory({ sessionKey });
});
