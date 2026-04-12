import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();

const [
  {
    DECISION_ENGINE_PROMOTION_VERSION,
    evaluateDecisionEnginePromotion,
  },
  { buildPlannerTaskTraceDiagnostics },
  {
    runPlannerToolFlow,
    resetPlannerRuntimeContext,
  },
  {
    applyPlannerWorkingMemoryPatch,
    resetPlannerConversationMemory,
  },
] = await Promise.all([
  import("../src/decision-engine-promotion.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
  import("../src/executive-planner.mjs"),
  import("../src/planner-conversation-memory.mjs"),
]);

test.after(() => {
  testDb.close();
});

function buildPromotionInput(overrides = {}) {
  return {
    advisor: {
      recommended_next_action: "ask_user",
      decision_reason_codes: ["missing_slot_block", "outcome_partial"],
      decision_confidence: "high",
      based_on: {
        readiness_summary: {
          is_ready: false,
          blocking_reason_codes: ["missing_slot"],
          missing_slots: ["doc_id"],
          recommended_action: "ask_user",
        },
        outcome_summary: {
          outcome_status: "blocked",
          retry_worthiness: false,
        },
        recovery_summary: {
          recovery_action: "ask_user",
          recovery_policy: "ask_user",
          recovery_attempt_count: 0,
        },
        artifact_summary: {
          artifact_id: "artifact-1",
          validity_status: "valid",
        },
        task_plan_summary: {
          task_id: "task-1",
          plan_id: "plan-1",
          plan_status: "active",
          current_step_id: "step-1",
          malformed_input: false,
        },
      },
    },
    advisor_alignment: {
      advisor_action: "ask_user",
      actual_action: "ask_user",
      is_aligned: true,
      alignment_type: "exact_match",
      divergence_reason_codes: [],
      promotion_candidate: true,
      evaluator_version: "advisor_alignment_evaluator_v1",
    },
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
    recovery: {
      recovery_policy: "ask_user",
      recovery_action: "ask_user",
      recovery_attempt_count: 0,
    },
    artifact: {
      artifact_id: "artifact-1",
      validity_status: "valid",
    },
    task_plan: {
      task_id: "task-1",
      plan_id: "plan-1",
      plan_status: "active",
      current_step_id: "step-1",
      malformed_input: false,
    },
    evidence_complete: true,
    ...(overrides || {}),
  };
}

test("advisor=ask_user with full gate conditions applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput());

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "ask_user");
  assert.equal(decision.safety_gate_passed, true);
  assert.equal(decision.promotion_version, DECISION_ENGINE_PROMOTION_VERSION);
});

test("advisor=fail with full gate conditions applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    advisor: {
      recommended_next_action: "fail",
      decision_reason_codes: ["plan_invalidated", "outcome_failed"],
    },
    advisor_alignment: {
      advisor_action: "fail",
      actual_action: "fail",
      is_aligned: true,
      alignment_type: "exact_match",
      divergence_reason_codes: [],
      promotion_candidate: true,
      evaluator_version: "advisor_alignment_evaluator_v1",
    },
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["plan_invalidated"],
      missing_slots: [],
      recommended_action: "fail",
    },
    outcome: {
      outcome_status: "failed",
      retry_worthiness: false,
    },
    recovery: {
      recovery_policy: "failed",
      recovery_action: "failed",
      recovery_attempt_count: 1,
    },
    task_plan: {
      task_id: "task-1",
      plan_id: "plan-1",
      plan_status: "invalidated",
      current_step_id: "step-1",
      malformed_input: false,
    },
  }));

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "fail");
  assert.equal(decision.safety_gate_passed, true);
});

test("advisor=retry never promotes even with exact alignment", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    advisor: {
      recommended_next_action: "retry",
      decision_reason_codes: ["retry_worthy"],
    },
    advisor_alignment: {
      advisor_action: "retry",
      actual_action: "retry",
      is_aligned: true,
      alignment_type: "exact_match",
      divergence_reason_codes: [],
      promotion_candidate: true,
      evaluator_version: "advisor_alignment_evaluator_v1",
    },
    readiness: {
      is_ready: true,
      blocking_reason_codes: [],
      missing_slots: [],
      recommended_action: "retry",
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: true,
    },
    recovery: {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      recovery_attempt_count: 1,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("unsupported_advisor_action"), true);
});

test("evidence incomplete blocks promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    evidence_complete: false,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("evidence_incomplete"), true);
});

test("malformed or unknown signals block promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    advisor_alignment: {
      advisor_action: "ask_user",
      actual_action: null,
      is_aligned: false,
      alignment_type: "unknown",
      divergence_reason_codes: ["malformed_alignment_input"],
      promotion_candidate: false,
      evaluator_version: "advisor_alignment_evaluator_v1",
    },
    readiness: ["bad"],
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("malformed_or_unknown_signals"), true);
});

test("conflicting readiness/outcome/recovery signals block promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    readiness: {
      is_ready: true,
      blocking_reason_codes: [],
      missing_slots: [],
      recommended_action: "retry",
    },
    outcome: {
      outcome_status: "success",
      retry_worthiness: true,
    },
    recovery: {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      recovery_attempt_count: 1,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("conflicting_signals"), true);
});

test("trace diagnostics expose promotion applied and blocked outcomes", () => {
  const appliedTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-promotion-applied",
      task_phase: "waiting_user",
      task_status: "blocked",
      current_owner_agent: "doc_agent",
    },
    observability: {
      decision_promotion: {
        promoted_action: "ask_user",
        promotion_applied: true,
        promotion_reason_codes: ["safety_gate_passed", "promotion_applied"],
        promotion_confidence: "high",
        safety_gate_passed: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=true action=ask_user safety_gate_passed=true confidence=high reasons=[safety_gate_passed, promotion_applied] version=decision_engine_promotion_v1",
    },
  });
  const blockedTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-promotion-blocked",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
    },
    observability: {
      decision_promotion: {
        promoted_action: null,
        promotion_applied: false,
        promotion_reason_codes: ["unsupported_advisor_action"],
        promotion_confidence: "low",
        safety_gate_passed: false,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=false action=none safety_gate_passed=false confidence=low reasons=[unsupported_advisor_action] version=decision_engine_promotion_v1",
    },
  });

  assert.equal(appliedTrace.diff.includes("decision_promotion.promotion_applied: true"), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("decision_promotion_summary:")), true);
  assert.equal(appliedTrace.snapshot.decision_promotion?.promotion_applied, true);
  assert.equal(appliedTrace.event_alignment.decision_promotion, true);
  assert.equal(appliedTrace.event_alignment.decision_promotion_summary, true);
  assert.equal(blockedTrace.diff.includes("decision_promotion.promotion_applied: false"), true);
  assert.equal(blockedTrace.snapshot.decision_promotion?.safety_gate_passed, false);
  assert.equal(blockedTrace.event_alignment.decision_promotion_reason_codes, true);
});

test("promotion diagnostics do not break existing fail-closed boundary", async () => {
  const sessionKey = "promotion-fail-closed-boundary";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "promotion_boundary_seed",
    patch: {
      task_id: "task-promotion-fail",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      retry_count: 0,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
      execution_plan: {
        plan_id: "plan-promotion-fail",
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            step_type: "tool",
            status: "running",
            owner_agent: "doc_agent",
            intended_action: "search_company_brain_docs",
            retryable: true,
            slot_requirements: [],
            depends_on: [],
            artifact_refs: [],
          },
          {
            step_id: "step-2",
            step_type: "tool",
            status: "running",
            owner_agent: "doc_agent",
            intended_action: "search_and_detail_doc",
            retryable: false,
            slot_requirements: [],
            depends_on: ["step-1"],
            artifact_refs: [],
          },
        ],
      },
    },
  });

  const memoryLogs = [];
  const result = await runPlannerToolFlow({
    userIntent: "下一步",
    payload: {},
    sessionKey,
    disableAutoRouting: true,
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher() {
      return {
        ok: true,
        data: {
          should_not_run: true,
        },
      };
    },
  });

  const routerDecisionLog = memoryLogs.find((item) => item?.memory_stage === "runPlannerToolFlow_router_decision");
  assert.ok(routerDecisionLog);
  assert.equal(typeof routerDecisionLog?.decision_promotion, "object");
  assert.equal(routerDecisionLog?.decision_promotion?.promotion_applied, false);
  assert.equal(result.selected_action, null);
  assert.equal(result.execution_result?.ok, false);

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});
