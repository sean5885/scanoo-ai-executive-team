import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();

const [
  {
    DECISION_ENGINE_PROMOTION_VERSION,
    DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
    evaluateDecisionEnginePromotion,
    buildDecisionPromotionAuditRecord,
    applyDecisionPromotionAuditSafety,
    createDecisionPromotionAuditState,
    resolveDecisionPromotionPolicy,
    resolveDecisionPromotionRollbackGate,
    formatDecisionPromotionAuditSummary,
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
  {
    PROMOTION_CONTROL_SURFACE_VERSION,
    resolvePromotionControlSurface,
    formatPromotionControlSurfaceSummary,
  },
] = await Promise.all([
  import("../src/decision-engine-promotion.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
  import("../src/executive-planner.mjs"),
  import("../src/planner-conversation-memory.mjs"),
  import("../src/promotion-control-surface.mjs"),
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
      retry_budget_max: 2,
      retry_budget_remaining: 2,
      retry_budget_exhausted: false,
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
    ask_user_gate: {
      task_phase: "executing",
      required_slots: ["doc_id"],
      unresolved_slots: ["doc_id"],
      slot_state: [
        {
          slot_key: "doc_id",
          status: "missing",
        },
      ],
      current_step_action: null,
      next_best_action: null,
      current_step_resume_available: false,
      next_best_action_available: false,
      resume_action_available: false,
      slot_suppressed_ask: false,
      waiting_user_all_required_slots_filled: false,
      continuation_ready: false,
      malformed_input: false,
    },
    evidence_complete: true,
    ...(overrides || {}),
  };
}

function buildRetryPromotionInput(overrides = {}) {
  return buildPromotionInput({
    advisor: {
      recommended_next_action: "retry",
      decision_reason_codes: ["retry_worthy", "outcome_partial"],
      decision_confidence: "high",
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
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: true,
      recovery_ready: true,
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
      retry_allowed: true,
      retry_budget_max: 3,
      retry_budget_remaining: 2,
      retry_budget_exhausted: false,
    },
    artifact: {
      artifact_id: "artifact-1",
      validity_status: "valid",
      invalid_artifact_count: 0,
      blocked_dependency_count: 0,
    },
    ...(overrides || {}),
  });
}

function buildHealthyRerouteScoreboard(overrides = {}) {
  const actions = {
    ask_user: { maturity_signal: "medium" },
    retry: { maturity_signal: "medium" },
    fail: { maturity_signal: "medium" },
    reroute: { maturity_signal: "low" },
    ...(overrides?.actions || {}),
  };
  return {
    actions: Object.entries(actions).map(([actionName, config]) => ({
      action_name: actionName,
      maturity_signal: config?.maturity_signal || "low",
    })),
  };
}

function buildReroutePromotionInput(overrides = {}) {
  const decisionScoreboard = buildHealthyRerouteScoreboard();
  return buildPromotionInput({
    advisor: {
      recommended_next_action: "reroute",
      decision_reason_codes: ["owner_mismatch", "capability_gap", "outcome_partial"],
      decision_confidence: "high",
    },
    advisor_alignment: {
      advisor_action: "reroute",
      actual_action: "reroute",
      is_aligned: true,
      alignment_type: "exact_match",
      divergence_reason_codes: [],
      promotion_candidate: true,
      evaluator_version: "advisor_alignment_evaluator_v1",
    },
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch"],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: false,
      recovery_ready: true,
      recommended_action: "reroute",
    },
    outcome: {
      outcome_status: "partial",
      retry_worthiness: false,
    },
    recovery: {
      recovery_policy: "reroute_owner",
      recovery_action: "reroute_owner",
      recovery_attempt_count: 1,
      retry_allowed: true,
      retry_budget_max: 3,
      retry_budget_remaining: 2,
      retry_budget_exhausted: false,
    },
    artifact: {
      artifact_id: "artifact-1",
      validity_status: "valid",
      invalid_artifact_count: 0,
      blocked_dependency_count: 0,
    },
    task_plan: {
      task_id: "task-1",
      plan_id: "plan-1",
      plan_status: "active",
      current_step_id: "step-1",
      current_step_status: "running",
      failure_class: "capability_gap",
      step_retryable: true,
      malformed_input: false,
    },
    decision_scoreboard: decisionScoreboard,
    reroute_context: {
      previous_owner_agent: "doc_agent",
      current_owner_agent: "runtime_agent",
      reroute_target: "runtime_agent",
      reroute_reason: "owner_mismatch",
      reroute_source: "promoted_decision_engine_v1",
      reroute_target_verified: true,
    },
    ...(overrides || {}),
  });
}

function buildPromotionAuditRecordInput(overrides = {}) {
  const promotionSeed = buildPromotionInput();
  return {
    promoted_action: "ask_user",
    promotion_decision: {
      promoted_action: "ask_user",
      promotion_applied: true,
      promotion_reason_codes: ["safety_gate_passed", "promotion_applied"],
      promotion_confidence: "high",
      safety_gate_passed: true,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: promotionSeed.advisor,
    advisor_alignment: promotionSeed.advisor_alignment,
    readiness: promotionSeed.readiness,
    outcome: promotionSeed.outcome,
    recovery: promotionSeed.recovery,
    artifact: promotionSeed.artifact,
    task_plan: promotionSeed.task_plan,
    final_step_status: "blocked",
    outcome_status: "blocked",
    user_visible_completeness: "none",
    ...(overrides || {}),
  };
}

test("advisor=ask_user with full gate conditions applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput());

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "ask_user");
  assert.equal(decision.safety_gate_passed, true);
  assert.deepEqual(decision.ask_user_gate?.truly_missing_slots, ["doc_id"]);
  assert.equal(decision.ask_user_gate?.promotion_allowed, true);
  assert.equal(decision.promotion_version, DECISION_ENGINE_PROMOTION_VERSION);
});

test("ask_user promotion blocks when required slot is already filled and valid", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: [],
      missing_slots: [],
      recommended_action: "ask_user",
    },
    ask_user_gate: {
      task_phase: "executing",
      required_slots: ["doc_id"],
      unresolved_slots: ["doc_id"],
      slot_state: [
        {
          slot_key: "doc_id",
          status: "filled",
          ttl: "2099-01-01T00:00:00.000Z",
        },
      ],
      current_step_resume_available: false,
      next_best_action_available: false,
      resume_action_available: false,
      slot_suppressed_ask: false,
      waiting_user_all_required_slots_filled: false,
      continuation_ready: false,
      malformed_input: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.ask_user_gate?.promotion_allowed, false);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_no_truly_missing_slot"), true);
});

test("waiting_user with all required slots filled blocks ask_user and prefers resume", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: [],
      missing_slots: [],
      recommended_action: "ask_user",
    },
    ask_user_gate: {
      task_phase: "waiting_user",
      required_slots: ["doc_id"],
      unresolved_slots: ["doc_id"],
      slot_state: [
        {
          slot_key: "doc_id",
          status: "filled",
          ttl: "2099-01-01T00:00:00.000Z",
        },
      ],
      current_step_action: "search_company_brain_docs",
      next_best_action: "search_company_brain_docs",
      current_step_resume_available: true,
      next_best_action_available: true,
      resume_action_available: true,
      slot_suppressed_ask: false,
      waiting_user_all_required_slots_filled: true,
      continuation_ready: true,
      malformed_input: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.ask_user_gate?.resume_instead_of_ask, true);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_waiting_user_slots_filled"), true);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_resume_action_available"), true);
});

test("ask_user promotion blocks when continuation is already possible", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    readiness: {
      is_ready: true,
      blocking_reason_codes: [],
      missing_slots: [],
      recommended_action: "proceed",
    },
    outcome: {
      outcome_status: "success",
      retry_worthiness: false,
    },
    recovery: {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      recovery_attempt_count: 1,
    },
    ask_user_gate: {
      task_phase: "executing",
      required_slots: ["doc_id"],
      unresolved_slots: [],
      slot_state: [
        {
          slot_key: "doc_id",
          status: "filled",
          ttl: "2099-01-01T00:00:00.000Z",
        },
      ],
      current_step_resume_available: true,
      next_best_action_available: true,
      resume_action_available: true,
      slot_suppressed_ask: false,
      waiting_user_all_required_slots_filled: false,
      continuation_ready: true,
      malformed_input: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_continuation_ready"), true);
});

test("slot_suppressed_ask condition blocks ask_user promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    ask_user_gate: {
      task_phase: "waiting_user",
      required_slots: ["doc_id"],
      unresolved_slots: ["doc_id"],
      slot_state: [
        {
          slot_key: "doc_id",
          status: "missing",
        },
      ],
      current_step_resume_available: true,
      next_best_action_available: true,
      resume_action_available: true,
      slot_suppressed_ask: true,
      waiting_user_all_required_slots_filled: false,
      continuation_ready: false,
      malformed_input: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_slot_suppressed"), true);
});

test("malformed ask_user slot gate input fails closed", () => {
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    ask_user_gate: {
      task_phase: "waiting_user",
      required_slots: ["doc_id"],
      unresolved_slots: ["doc_id"],
      slot_state: "malformed",
      malformed_input: true,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.ask_user_gate?.promotion_allowed, false);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_slot_input_malformed"), true);
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

test("advisor=retry with full retry gate conditions applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput());

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "retry");
  assert.equal(decision.promotion_reason_codes.includes("retry_gate_passed"), true);
});

test("advisor=reroute with explicit owner mismatch and healthy baseline applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput());

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "reroute");
  assert.equal(decision.safety_gate_passed, true);
  assert.equal(decision.reroute_target, "runtime_agent");
  assert.equal(decision.reroute_reason, "owner_mismatch");
  assert.equal(decision.reroute_source, "promoted_decision_engine_v1");
  assert.equal(decision.current_owner_agent, "runtime_agent");
});

test("advisor=reroute with explicit capability gap and unique target applies promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: [],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: true,
      recovery_ready: true,
      recommended_action: "reroute",
    },
    advisor: {
      recommended_next_action: "reroute",
      decision_reason_codes: ["capability_gap", "outcome_partial"],
      decision_confidence: "high",
    },
    reroute_context: {
      previous_owner_agent: "doc_agent",
      current_owner_agent: "runtime_agent",
      reroute_target: "runtime_agent",
      reroute_reason: "capability_gap",
      reroute_source: "promoted_decision_engine_v1",
      reroute_target_verified: true,
    },
  }));

  assert.equal(decision.promotion_applied, true);
  assert.equal(decision.promoted_action, "reroute");
  assert.equal(decision.reroute_reason, "capability_gap");
});

test("advisor=reroute blocks when target is ambiguous or unverifiable", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    reroute_context: {
      previous_owner_agent: "doc_agent",
      current_owner_agent: null,
      reroute_target: null,
      reroute_reason: "capability_gap",
      reroute_source: "promoted_decision_engine_v1",
      reroute_target_verified: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("reroute_target_unverified"), true);
});

test("rollback/skip stay advisory-only in promotion policy", () => {
  const deniedActions = ["rollback", "skip"];
  for (const deniedAction of deniedActions) {
    const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
      advisor: {
        recommended_next_action: deniedAction,
        decision_reason_codes: ["advisory_only_v1"],
      },
      advisor_alignment: {
        advisor_action: deniedAction,
        actual_action: deniedAction,
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
        recommended_action: deniedAction,
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
  }
});

test("rollback-disabled action is blocked even when allow-list would allow it", () => {
  const policy = resolvePromotionControlSurface({
    rollback_disabled_actions: ["ask_user"],
  });
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    promotion_policy: policy,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("promotion_disabled_by_rollback_flag"), true);
  assert.equal(decision.ask_user_gate?.blocked_reason_codes.includes("ask_user_rollback_disabled"), true);
});

test("rollback flag blocks retry promotion", () => {
  const policy = resolvePromotionControlSurface({
    rollback_disabled_actions: ["retry"],
  });
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    promotion_policy: policy,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("promotion_disabled_by_rollback_flag"), true);
});

test("rollback flag blocks reroute promotion", () => {
  const policy = resolvePromotionControlSurface({
    rollback_disabled_actions: ["reroute"],
  });
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    promotion_policy: policy,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("promotion_disabled_by_rollback_flag"), true);
});

test("missing reroute health signal fails closed", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    decision_scoreboard: null,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("reroute_health_signal_missing"), true);
});

test("low-maturity baseline blocks reroute promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    decision_scoreboard: buildHealthyRerouteScoreboard({
      actions: {
        retry: { maturity_signal: "low" },
      },
    }),
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("reroute_health_signal_not_ready"), true);
});

test("promotion gate reads control surface policy instead of hardcoded allow-list", () => {
  const policy = resolveDecisionPromotionPolicy({
    promotion_policy: {
      promotion_policy_version: "test_policy_fail_only",
      allowed_actions: ["fail"],
      denied_actions: ["proceed", "ask_user", "retry", "reroute", "rollback", "skip"],
      ineffective_threshold: 4,
      policy_reason_codes: ["policy_allow_list", "policy_deny_list"],
    },
  });
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    promotion_policy: policy,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("promotion_denied_by_policy"), true);
});

test("malformed promotion policy fails closed", () => {
  const malformedPolicy = {
    promotion_policy_version: "bad_policy",
    allowed_actions: ["ask_user", "not_a_real_action"],
    denied_actions: ["retry", "reroute"],
    ineffective_threshold: "NaN",
  };
  const decision = evaluateDecisionEnginePromotion(buildPromotionInput({
    promotion_policy: malformedPolicy,
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("promotion_policy_fail_closed"), true);
});

test("promotion control surface v1 exposes required policy fields", () => {
  const policy = resolvePromotionControlSurface();

  assert.equal(policy.promotion_policy_version, PROMOTION_CONTROL_SURFACE_VERSION);
  assert.equal(Array.isArray(policy.allowed_actions), true);
  assert.equal(Array.isArray(policy.denied_actions), true);
  assert.equal(Array.isArray(policy.rollback_disabled_actions), true);
  assert.equal(Number.isFinite(Number(policy.ineffective_threshold)), true);
  assert.equal(typeof policy.action_policy_map, "object");
  assert.equal(Array.isArray(policy.policy_reason_codes), true);
  assert.equal(typeof policy.action_policy_map.ask_user?.promotion_allowed, "boolean");
  assert.equal(typeof policy.action_policy_map.ask_user?.rollback_disabled, "boolean");
  assert.equal(typeof policy.action_policy_map.ask_user?.requires_exact_match, "boolean");
  assert.equal(typeof policy.action_policy_map.ask_user?.requires_complete_evidence, "boolean");
  assert.equal(typeof policy.action_policy_map.retry?.promotion_allowed, "boolean");
  assert.equal(policy.action_policy_map.retry?.requires_retry_worthiness, true);
  assert.equal(policy.action_policy_map.retry?.requires_no_blocking_readiness, true);
  assert.equal(policy.action_policy_map.reroute?.promotion_allowed, true);
  assert.equal(policy.action_policy_map.reroute?.requires_exact_match, true);
  assert.equal(policy.action_policy_map.reroute?.requires_complete_evidence, true);
  assert.equal(policy.action_policy_map.reroute?.requires_owner_mismatch_or_capability_gap, true);
  assert.equal(policy.action_policy_map.reroute?.requires_no_blocking_dependency, true);
  assert.equal(policy.action_policy_map.reroute?.requires_no_invalid_artifact, true);
  assert.equal(policy.action_policy_map.reroute?.requires_recovery_safe, true);
  assert.equal(typeof formatPromotionControlSurfaceSummary(policy), "string");
});

test("rollback gate threshold is sourced from control surface policy", () => {
  const state = createDecisionPromotionAuditState({
    actions: {
      ask_user: {
        consecutive_ineffective: 4,
        promotion_disabled: false,
        last_effectiveness: "ineffective",
        last_audit_id: "audit-threshold",
      },
      fail: {
        consecutive_ineffective: 0,
        promotion_disabled: false,
        last_effectiveness: null,
        last_audit_id: null,
      },
    },
  });
  const policy = resolveDecisionPromotionPolicy({
    promotion_policy: {
      promotion_policy_version: "threshold_5_policy",
      allowed_actions: ["ask_user", "fail"],
      denied_actions: ["proceed", "retry", "reroute", "rollback", "skip"],
      ineffective_threshold: 5,
    },
  });
  const rollbackGate = resolveDecisionPromotionRollbackGate({
    state,
    promoted_action: "ask_user",
    promotion_policy: policy,
  });

  assert.equal(rollbackGate.threshold, 5);
  assert.equal(rollbackGate.promotion_allowed, true);
  assert.equal(rollbackGate.rollback_flag, false);
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

test("missing_slot priority blocks reroute promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch", "missing_slot"],
      missing_slots: ["doc_id"],
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: false,
      recovery_ready: true,
      recommended_action: "reroute",
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("reroute_missing_slot_priority"), true);
});

test("invalid_artifact blocks reroute promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch", "invalid_artifact"],
      missing_slots: [],
      invalid_artifacts: [{
        artifact_id: "artifact-bad",
        validity_status: "invalid",
        blocked_step_id: "step-2",
      }],
      blocked_dependencies: [],
      owner_ready: false,
      recovery_ready: true,
      recommended_action: "reroute",
    },
    artifact: {
      artifact_id: "artifact-bad",
      validity_status: "invalid",
      invalid_artifact_count: 1,
      blocked_dependency_count: 0,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("reroute_invalid_artifact"), true);
});

test("blocked_dependency blocks reroute promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch", "blocked_dependency"],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [{
        step_id: "step-0",
        status: "failed",
      }],
      owner_ready: false,
      recovery_ready: true,
      recommended_action: "reroute",
    },
    artifact: {
      artifact_id: "artifact-1",
      validity_status: "valid",
      invalid_artifact_count: 0,
      blocked_dependency_count: 1,
      dependency_blocked_step: "step-0",
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promotion_reason_codes.includes("reroute_blocked_dependency"), true);
});

test("malformed reroute input fails closed", () => {
  const decision = evaluateDecisionEnginePromotion(buildReroutePromotionInput({
    readiness: "malformed_readiness_payload",
    reroute_context: "malformed_reroute_context",
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(
    decision.promotion_reason_codes.includes("malformed_or_unknown_signals")
      || decision.promotion_reason_codes.includes("reroute_signals_missing"),
    true,
  );
});

test("retry_worthiness=false blocks retry promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    outcome: {
      outcome_status: "partial",
      retry_worthiness: false,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("retry_not_worthy"), true);
});

test("readiness blocked blocks retry promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    readiness: {
      is_ready: false,
      blocking_reason_codes: ["recovery_in_progress"],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [],
      owner_ready: true,
      recovery_ready: false,
      recommended_action: "retry",
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("retry_readiness_not_ready"), true);
});

test("invalid artifact blocks retry promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    readiness: {
      is_ready: true,
      blocking_reason_codes: ["invalid_artifact"],
      missing_slots: [],
      invalid_artifacts: [{
        artifact_id: "artifact-bad",
        validity_status: "invalid",
        blocked_step_id: "step-2",
      }],
      blocked_dependencies: [],
      owner_ready: true,
      recovery_ready: true,
      recommended_action: "retry",
    },
    artifact: {
      artifact_id: "artifact-bad",
      validity_status: "invalid",
      invalid_artifact_count: 1,
      blocked_dependency_count: 0,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("retry_invalid_artifact"), true);
});

test("blocked dependency blocks retry promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    readiness: {
      is_ready: true,
      blocking_reason_codes: ["blocked_dependency"],
      missing_slots: [],
      invalid_artifacts: [],
      blocked_dependencies: [{
        step_id: "step-0",
        status: "failed",
      }],
      owner_ready: true,
      recovery_ready: true,
      recommended_action: "retry",
    },
    artifact: {
      artifact_id: "artifact-1",
      validity_status: "valid",
      invalid_artifact_count: 0,
      blocked_dependency_count: 1,
      dependency_blocked_step: "step-0",
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("retry_blocked_dependency"), true);
});

test("retry budget exhausted blocks retry promotion", () => {
  const decision = evaluateDecisionEnginePromotion(buildRetryPromotionInput({
    recovery: {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      recovery_attempt_count: 3,
      retry_allowed: true,
      retry_budget_max: 3,
      retry_budget_remaining: 0,
      retry_budget_exhausted: true,
    },
  }));

  assert.equal(decision.promotion_applied, false);
  assert.equal(decision.promoted_action, null);
  assert.equal(decision.promotion_reason_codes.includes("retry_budget_exhausted"), true);
});

test("promotion audit marks ask_user slot recovery as effective", () => {
  const auditRecord = buildDecisionPromotionAuditRecord(buildPromotionAuditRecordInput({
    final_step_status: "completed",
    outcome_status: "success",
    user_visible_completeness: "complete",
    outcome: {
      outcome_status: "success",
      retry_worthiness: false,
    },
  }));

  assert.equal(auditRecord.promoted_action, "ask_user");
  assert.equal(auditRecord.promotion_applied, true);
  assert.equal(auditRecord.promotion_effectiveness, "effective");
  assert.equal(auditRecord.rollback_flag, false);
});

test("promotion audit marks ask_user no-response/stuck as ineffective or unknown", () => {
  const auditRecord = buildDecisionPromotionAuditRecord(buildPromotionAuditRecordInput({
    final_step_status: "blocked",
    outcome_status: "blocked",
    user_visible_completeness: "none",
  }));

  assert.equal(auditRecord.promoted_action, "ask_user");
  assert.equal(["ineffective", "unknown"].includes(auditRecord.promotion_effectiveness), true);
});

test("promotion audit marks fail that prevents unsafe continuation as effective", () => {
  const failInput = buildPromotionInput({
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
  });
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: "fail",
    promotion_decision: {
      promoted_action: "fail",
      promotion_applied: true,
      promotion_reason_codes: ["safety_gate_passed", "promotion_applied"],
      promotion_confidence: "high",
      safety_gate_passed: true,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: failInput.advisor,
    advisor_alignment: failInput.advisor_alignment,
    readiness: failInput.readiness,
    outcome: failInput.outcome,
    recovery: failInput.recovery,
    artifact: failInput.artifact,
    task_plan: failInput.task_plan,
    final_step_status: "failed",
    outcome_status: "failed",
    user_visible_completeness: "none",
  });

  assert.equal(auditRecord.promoted_action, "fail");
  assert.equal(auditRecord.promotion_effectiveness, "effective");
});

test("promotion audit marks fail that blocks recoverable flow as ineffective", () => {
  const auditRecord = buildDecisionPromotionAuditRecord({
    ...buildPromotionAuditRecordInput({
      promoted_action: "fail",
      promotion_decision: {
        promoted_action: "fail",
        promotion_applied: true,
        promotion_reason_codes: ["safety_gate_passed", "promotion_applied"],
        promotion_confidence: "medium",
        safety_gate_passed: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      advisor: {
        recommended_next_action: "fail",
        decision_reason_codes: ["outcome_failed"],
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
      final_step_status: "completed",
      outcome_status: "success",
      user_visible_completeness: "complete",
    }),
  });

  assert.equal(auditRecord.promoted_action, "fail");
  assert.equal(auditRecord.promotion_effectiveness, "ineffective");
});

test("promotion audit marks retry that improves to success as effective", () => {
  const retrySeed = buildRetryPromotionInput({
    outcome: {
      outcome_status: "failed",
      retry_worthiness: true,
    },
  });
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: "retry",
    promotion_decision: {
      promoted_action: "retry",
      promotion_applied: true,
      promotion_reason_codes: ["retry_gate_passed", "safety_gate_passed", "promotion_applied"],
      promotion_confidence: "high",
      safety_gate_passed: true,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: retrySeed.advisor,
    advisor_alignment: retrySeed.advisor_alignment,
    readiness: retrySeed.readiness,
    outcome: retrySeed.outcome,
    recovery: retrySeed.recovery,
    artifact: retrySeed.artifact,
    task_plan: retrySeed.task_plan,
    final_step_status: "completed",
    outcome_status: "success",
    user_visible_completeness: "complete",
  });

  assert.equal(auditRecord.promoted_action, "retry");
  assert.equal(auditRecord.promotion_effectiveness, "effective");
});

test("promotion audit marks retry with no improvement as ineffective", () => {
  const retrySeed = buildRetryPromotionInput({
    outcome: {
      outcome_status: "partial",
      retry_worthiness: true,
    },
  });
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: "retry",
    promotion_decision: {
      promoted_action: "retry",
      promotion_applied: true,
      promotion_reason_codes: ["retry_gate_passed", "safety_gate_passed", "promotion_applied"],
      promotion_confidence: "medium",
      safety_gate_passed: true,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: retrySeed.advisor,
    advisor_alignment: retrySeed.advisor_alignment,
    readiness: retrySeed.readiness,
    outcome: retrySeed.outcome,
    recovery: retrySeed.recovery,
    artifact: retrySeed.artifact,
    task_plan: retrySeed.task_plan,
    final_step_status: "running",
    outcome_status: "partial",
    user_visible_completeness: "partial",
  });

  assert.equal(auditRecord.promoted_action, "retry");
  assert.equal(auditRecord.promotion_effectiveness, "ineffective");
});

test("promotion audit marks reroute as effective when outcome improves", () => {
  const rerouteSeed = buildReroutePromotionInput();
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: "reroute",
    promotion_decision: {
      promoted_action: "reroute",
      promotion_applied: true,
      promotion_reason_codes: ["reroute_gate_passed", "safety_gate_passed", "promotion_applied"],
      promotion_confidence: "high",
      safety_gate_passed: true,
      reroute_target: "runtime_agent",
      reroute_reason: "capability_gap",
      reroute_source: "promoted_decision_engine_v1",
      previous_owner_agent: "doc_agent",
      current_owner_agent: "runtime_agent",
      reroute_target_verified: true,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: rerouteSeed.advisor,
    advisor_alignment: rerouteSeed.advisor_alignment,
    readiness: rerouteSeed.readiness,
    outcome: {
      outcome_status: "failed",
      retry_worthiness: false,
    },
    recovery: rerouteSeed.recovery,
    artifact: rerouteSeed.artifact,
    task_plan: rerouteSeed.task_plan,
    final_step_status: "completed",
    outcome_status: "success",
    user_visible_completeness: "complete",
  });

  assert.equal(auditRecord.promoted_action, "reroute");
  assert.equal(auditRecord.promotion_effectiveness, "effective");
});

test("promotion audit marks reroute as ineffective when target is incorrect", () => {
  const rerouteSeed = buildReroutePromotionInput();
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: "reroute",
    promotion_decision: {
      promoted_action: "reroute",
      promotion_applied: true,
      promotion_reason_codes: ["reroute_gate_passed", "safety_gate_passed", "promotion_applied"],
      promotion_confidence: "high",
      safety_gate_passed: true,
      reroute_target: "runtime_agent",
      reroute_reason: "capability_gap",
      reroute_source: "promoted_decision_engine_v1",
      previous_owner_agent: "doc_agent",
      current_owner_agent: "runtime_agent",
      reroute_target_verified: false,
      promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    },
    advisor: rerouteSeed.advisor,
    advisor_alignment: rerouteSeed.advisor_alignment,
    readiness: rerouteSeed.readiness,
    outcome: {
      outcome_status: "failed",
      retry_worthiness: false,
    },
    recovery: rerouteSeed.recovery,
    artifact: rerouteSeed.artifact,
    task_plan: rerouteSeed.task_plan,
    final_step_status: "failed",
    outcome_status: "failed",
    user_visible_completeness: "none",
  });

  assert.equal(auditRecord.promoted_action, "reroute");
  assert.equal(auditRecord.promotion_effectiveness, "ineffective");
  assert.equal(auditRecord.audit_reason_codes?.includes("reroute_target_incorrect"), true);
});

test("consecutive ineffective promotions trigger rollback flag and future gate-off", () => {
  let promotionState = createDecisionPromotionAuditState();
  let lastSafetyResult = null;
  for (let index = 0; index < DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD; index += 1) {
    const auditRecord = buildDecisionPromotionAuditRecord(buildPromotionAuditRecordInput({
      audit_id: `audit-ask-user-${index + 1}`,
      final_step_status: "blocked",
      outcome_status: "blocked",
      user_visible_completeness: "none",
    }));
    lastSafetyResult = applyDecisionPromotionAuditSafety({
      state: promotionState,
      audit_record: auditRecord,
      threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
    });
    promotionState = lastSafetyResult.next_state;
  }

  assert.ok(lastSafetyResult);
  assert.equal(lastSafetyResult.audit_record.rollback_flag, true);
  assert.equal(lastSafetyResult.next_state.actions.ask_user.promotion_disabled, true);
  assert.equal(lastSafetyResult.next_state.actions.ask_user.consecutive_ineffective, DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD);
  const rollbackGate = resolveDecisionPromotionRollbackGate({
    state: promotionState,
    promoted_action: "ask_user",
    threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
  });
  assert.equal(rollbackGate.promotion_allowed, false);
  assert.equal(rollbackGate.rollback_flag, true);
});

test("consecutive ineffective retry promotions trigger rollback flag deterministically", () => {
  let promotionState = createDecisionPromotionAuditState();
  let lastSafetyResult = null;
  for (let index = 0; index < DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD; index += 1) {
    const retrySeed = buildRetryPromotionInput();
    const auditRecord = buildDecisionPromotionAuditRecord({
      audit_id: `audit-retry-${index + 1}`,
      promoted_action: "retry",
      promotion_decision: {
        promoted_action: "retry",
        promotion_applied: true,
        promotion_reason_codes: ["retry_gate_passed", "safety_gate_passed", "promotion_applied"],
        promotion_confidence: "medium",
        safety_gate_passed: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      advisor: retrySeed.advisor,
      advisor_alignment: retrySeed.advisor_alignment,
      readiness: retrySeed.readiness,
      outcome: retrySeed.outcome,
      recovery: retrySeed.recovery,
      artifact: retrySeed.artifact,
      task_plan: retrySeed.task_plan,
      final_step_status: "running",
      outcome_status: "partial",
      user_visible_completeness: "partial",
    });
    lastSafetyResult = applyDecisionPromotionAuditSafety({
      state: promotionState,
      audit_record: auditRecord,
      threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
    });
    promotionState = lastSafetyResult.next_state;
  }

  assert.ok(lastSafetyResult);
  assert.equal(lastSafetyResult.audit_record.rollback_flag, true);
  assert.equal(lastSafetyResult.next_state.actions.retry.promotion_disabled, true);
  assert.equal(lastSafetyResult.next_state.actions.retry.consecutive_ineffective, DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD);
  const rollbackGate = resolveDecisionPromotionRollbackGate({
    state: promotionState,
    promoted_action: "retry",
    threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
  });
  assert.equal(rollbackGate.promotion_allowed, false);
  assert.equal(rollbackGate.rollback_flag, true);
});

test("consecutive ineffective reroute promotions trigger rollback flag deterministically", () => {
  let promotionState = createDecisionPromotionAuditState();
  let lastSafetyResult = null;
  for (let index = 0; index < DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD; index += 1) {
    const rerouteSeed = buildReroutePromotionInput();
    const auditRecord = buildDecisionPromotionAuditRecord({
      audit_id: `audit-reroute-${index + 1}`,
      promoted_action: "reroute",
      promotion_decision: {
        promoted_action: "reroute",
        promotion_applied: true,
        promotion_reason_codes: ["reroute_gate_passed", "safety_gate_passed", "promotion_applied"],
        promotion_confidence: "medium",
        safety_gate_passed: true,
        reroute_target: "runtime_agent",
        reroute_reason: "capability_gap",
        reroute_source: "promoted_decision_engine_v1",
        previous_owner_agent: "doc_agent",
        current_owner_agent: "runtime_agent",
        reroute_target_verified: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      advisor: rerouteSeed.advisor,
      advisor_alignment: rerouteSeed.advisor_alignment,
      readiness: rerouteSeed.readiness,
      outcome: {
        outcome_status: "failed",
        retry_worthiness: false,
      },
      recovery: rerouteSeed.recovery,
      artifact: rerouteSeed.artifact,
      task_plan: rerouteSeed.task_plan,
      final_step_status: "failed",
      outcome_status: "failed",
      user_visible_completeness: "none",
    });
    lastSafetyResult = applyDecisionPromotionAuditSafety({
      state: promotionState,
      audit_record: auditRecord,
      threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
    });
    promotionState = lastSafetyResult.next_state;
  }

  assert.ok(lastSafetyResult);
  assert.equal(lastSafetyResult.audit_record.rollback_flag, true);
  assert.equal(lastSafetyResult.next_state.actions.reroute.promotion_disabled, true);
  assert.equal(lastSafetyResult.next_state.actions.reroute.consecutive_ineffective, DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD);
  const rollbackGate = resolveDecisionPromotionRollbackGate({
    state: promotionState,
    promoted_action: "reroute",
    threshold: DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
  });
  assert.equal(rollbackGate.promotion_allowed, false);
  assert.equal(rollbackGate.rollback_flag, true);
});

test("malformed or conflicting audit fails closed and is excluded from effectiveness counting", () => {
  let promotionState = createDecisionPromotionAuditState();
  const ineffectiveAudit = buildDecisionPromotionAuditRecord(buildPromotionAuditRecordInput({
    audit_id: "audit-seed-1",
    final_step_status: "blocked",
    outcome_status: "blocked",
  }));
  let safetyResult = applyDecisionPromotionAuditSafety({
    state: promotionState,
    audit_record: ineffectiveAudit,
    threshold: 3,
  });
  promotionState = safetyResult.next_state;
  assert.equal(promotionState.actions.ask_user.consecutive_ineffective, 1);

  const malformedAudit = buildDecisionPromotionAuditRecord({
    ...buildPromotionAuditRecordInput({
      audit_id: "audit-malformed",
      promoted_action: null,
      advisor: {
        recommended_next_action: null,
        decision_reason_codes: [],
      },
      promotion_decision: {
        promoted_action: null,
        promotion_applied: true,
      },
      final_step_status: null,
      outcome_status: null,
    }),
  });
  assert.equal(malformedAudit.audit_fail_closed, true);
  assert.equal(malformedAudit.effectiveness_counted, false);
  safetyResult = applyDecisionPromotionAuditSafety({
    state: promotionState,
    audit_record: malformedAudit,
    threshold: 3,
  });
  promotionState = safetyResult.next_state;

  assert.equal(promotionState.actions.ask_user.consecutive_ineffective, 1);
  assert.equal(safetyResult.audit_record.rollback_flag, false);
  assert.match(formatDecisionPromotionAuditSummary(malformedAudit), /action=none/);
});

test("trace diagnostics expose promotion applied and blocked outcomes", () => {
  const appliedPolicy = resolvePromotionControlSurface();
  const blockedPolicy = resolvePromotionControlSurface({
    rollback_disabled_actions: ["ask_user"],
  });
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
        ask_user_gate: {
          truly_missing_slots: ["doc_id"],
          blocked_reason_codes: [],
          promotion_allowed: true,
          resume_instead_of_ask: false,
        },
        ask_user_recalibrated: false,
        ask_user_recalibration_summary: "promotion_allowed=true resume_instead_of_ask=false truly_missing_slots=[doc_id] blocked_reasons=[]",
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=true action=ask_user safety_gate_passed=true confidence=high reasons=[safety_gate_passed, promotion_applied] version=decision_engine_promotion_v1",
      promotion_policy: appliedPolicy,
      promotion_policy_summary: formatPromotionControlSurfaceSummary(appliedPolicy),
      promotion_audit: {
        promotion_audit_id: "audit-applied-1",
        promoted_action: "ask_user",
        promotion_applied: true,
        promotion_effectiveness: "effective",
        rollback_flag: false,
        audit_version: "decision_engine_promotion_audit_v1",
        promotion_outcome: {
          final_step_status: "completed",
          outcome_status: "success",
          user_visible_completeness: "complete",
        },
      },
      promotion_audit_summary: "id=audit-applied-1 action=ask_user applied=true effectiveness=effective rollback_flag=false final_step_status=completed outcome_status=success user_visible_completeness=complete reasons=[] version=decision_engine_promotion_audit_v1",
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
        ask_user_gate: {
          truly_missing_slots: [],
          blocked_reason_codes: ["ask_user_waiting_user_slots_filled", "ask_user_resume_action_available"],
          promotion_allowed: false,
          resume_instead_of_ask: true,
        },
        ask_user_blocked_reason: "ask_user_waiting_user_slots_filled",
        ask_user_recalibrated: true,
        ask_user_recalibration_summary: "promotion_allowed=false resume_instead_of_ask=true truly_missing_slots=[] blocked_reasons=[ask_user_waiting_user_slots_filled, ask_user_resume_action_available]",
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=false action=none safety_gate_passed=false confidence=low reasons=[unsupported_advisor_action] version=decision_engine_promotion_v1",
      promotion_policy: blockedPolicy,
      promotion_policy_summary: formatPromotionControlSurfaceSummary(blockedPolicy),
      promotion_audit: {
        promotion_audit_id: "audit-blocked-1",
        promoted_action: "ask_user",
        promotion_applied: true,
        promotion_effectiveness: "ineffective",
        rollback_flag: true,
        audit_version: "decision_engine_promotion_audit_v1",
        promotion_outcome: {
          final_step_status: "blocked",
          outcome_status: "blocked",
          user_visible_completeness: "none",
        },
      },
      promotion_audit_summary: "id=audit-blocked-1 action=ask_user applied=true effectiveness=ineffective rollback_flag=true final_step_status=blocked outcome_status=blocked user_visible_completeness=none reasons=[] version=decision_engine_promotion_audit_v1",
    },
  });

  assert.equal(appliedTrace.diff.includes("decision_promotion.promotion_applied: true"), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("decision_promotion_summary:")), true);
  assert.equal(appliedTrace.diff.includes("promotion_audit.promotion_effectiveness: effective"), true);
  assert.equal(appliedTrace.diff.includes("promotion_audit.rollback_flag: false"), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("promotion_policy.allowed_actions:")), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("promotion_policy.rollback_disabled_actions:")), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("promotion_policy.ineffective_threshold:")), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("promotion_policy_summary:")), true);
  assert.equal(appliedTrace.diff.some((line) => line.startsWith("ask_user_gate.truly_missing_slots:")), true);
  assert.equal(appliedTrace.snapshot.decision_promotion?.promotion_applied, true);
  assert.deepEqual(appliedTrace.snapshot.ask_user_gate?.truly_missing_slots, ["doc_id"]);
  assert.deepEqual(appliedTrace.snapshot.promotion_policy?.allowed_actions, ["ask_user", "retry", "reroute", "fail"]);
  assert.equal(appliedTrace.snapshot.promotion_audit?.promotion_effectiveness, "effective");
  assert.equal(appliedTrace.event_alignment.decision_promotion, true);
  assert.equal(appliedTrace.event_alignment.ask_user_gate, true);
  assert.equal(appliedTrace.event_alignment.promotion_policy, true);
  assert.equal(appliedTrace.event_alignment.promotion_policy_summary, true);
  assert.equal(appliedTrace.event_alignment.decision_promotion_summary, true);
  assert.equal(appliedTrace.event_alignment.promotion_audit_effectiveness, true);
  assert.equal(appliedTrace.event_alignment.promotion_audit_summary, true);
  assert.equal(blockedTrace.diff.includes("decision_promotion.promotion_applied: false"), true);
  assert.equal(blockedTrace.snapshot.decision_promotion?.safety_gate_passed, false);
  assert.deepEqual(blockedTrace.snapshot.promotion_policy?.rollback_disabled_actions, ["ask_user"]);
  assert.equal(blockedTrace.snapshot.promotion_audit?.rollback_flag, true);
  assert.equal(blockedTrace.snapshot.ask_user_recalibrated, true);
  assert.equal(blockedTrace.snapshot.ask_user_blocked_reason, "ask_user_waiting_user_slots_filled");
  assert.equal(blockedTrace.snapshot.ask_user_gate?.resume_instead_of_ask, true);
  assert.equal(blockedTrace.diff.includes("promotion_audit.rollback_flag: true"), true);
  assert.equal(blockedTrace.diff.some((line) => line.startsWith("ask_user_recalibration_summary:")), true);
  assert.equal(blockedTrace.event_alignment.decision_promotion_reason_codes, true);
  assert.equal(blockedTrace.event_alignment.promotion_audit_rollback_flag, true);
  assert.equal(blockedTrace.event_alignment.ask_user_recalibration_summary, true);
});

test("trace diagnostics expose retry promotion decisions and gate block reasons", () => {
  const promotionPolicy = resolvePromotionControlSurface();
  const retryAppliedTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-retry-promotion-applied",
      task_phase: "retrying",
      task_status: "failed",
      current_owner_agent: "doc_agent",
    },
    observability: {
      decision_promotion: {
        promoted_action: "retry",
        promotion_applied: true,
        promotion_reason_codes: ["retry_gate_passed", "safety_gate_passed", "promotion_applied"],
        promotion_confidence: "high",
        safety_gate_passed: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=true action=retry safety_gate_passed=true confidence=high reasons=[retry_gate_passed, safety_gate_passed, promotion_applied] version=decision_engine_promotion_v1",
      promotion_policy: promotionPolicy,
      promotion_policy_summary: formatPromotionControlSurfaceSummary(promotionPolicy),
      promotion_audit: {
        promotion_audit_id: "audit-retry-applied-1",
        promoted_action: "retry",
        promotion_applied: true,
        promotion_effectiveness: "effective",
        rollback_flag: false,
        audit_version: "decision_engine_promotion_audit_v1",
        promotion_outcome: {
          final_step_status: "completed",
          outcome_status: "success",
          user_visible_completeness: "complete",
        },
      },
      promotion_audit_summary: "id=audit-retry-applied-1 action=retry applied=true effectiveness=effective rollback_flag=false final_step_status=completed outcome_status=success user_visible_completeness=complete reasons=[] version=decision_engine_promotion_audit_v1",
    },
  });
  const retryBlockedTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-retry-promotion-blocked",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
    },
    observability: {
      decision_promotion: {
        promoted_action: null,
        promotion_applied: false,
        promotion_reason_codes: ["retry_budget_exhausted"],
        promotion_confidence: "low",
        safety_gate_passed: false,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=false action=none safety_gate_passed=false confidence=low reasons=[retry_budget_exhausted] version=decision_engine_promotion_v1",
      promotion_policy: promotionPolicy,
      promotion_policy_summary: formatPromotionControlSurfaceSummary(promotionPolicy),
      promotion_audit: {
        promotion_audit_id: "audit-retry-blocked-1",
        promoted_action: "retry",
        promotion_applied: true,
        promotion_effectiveness: "ineffective",
        rollback_flag: false,
        audit_version: "decision_engine_promotion_audit_v1",
        promotion_outcome: {
          final_step_status: "failed",
          outcome_status: "failed",
          user_visible_completeness: "none",
        },
      },
      promotion_audit_summary: "id=audit-retry-blocked-1 action=retry applied=true effectiveness=ineffective rollback_flag=false final_step_status=failed outcome_status=failed user_visible_completeness=none reasons=[] version=decision_engine_promotion_audit_v1",
    },
  });

  assert.equal(retryAppliedTrace.diff.includes("decision_promotion.promoted_action: retry"), true);
  assert.equal(retryAppliedTrace.diff.includes("decision_promotion.promotion_applied: true"), true);
  assert.equal(retryAppliedTrace.diff.includes("promotion_audit.promotion_effectiveness: effective"), true);
  assert.equal(retryAppliedTrace.snapshot.promotion_audit?.promoted_action, "retry");
  assert.equal(retryBlockedTrace.diff.includes("decision_promotion.promotion_applied: false"), true);
  assert.equal(retryBlockedTrace.diff.some((line) => line.startsWith("decision_promotion.promotion_reason_codes:")), true);
  assert.equal(retryBlockedTrace.snapshot.decision_promotion?.promotion_reason_codes?.includes("retry_budget_exhausted"), true);
  assert.equal(retryBlockedTrace.event_alignment.decision_promotion_reason_codes, true);
});

test("trace diagnostics expose reroute reason, target, and effectiveness", () => {
  const promotionPolicy = resolvePromotionControlSurface();
  const rerouteTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-reroute-promotion-applied",
      task_phase: "retrying",
      task_status: "failed",
      current_owner_agent: "runtime_agent",
      previous_owner_agent: "doc_agent",
      handoff_reason: "capability_gap",
    },
    observability: {
      decision_promotion: {
        promoted_action: "reroute",
        promotion_applied: true,
        promotion_reason_codes: ["reroute_gate_passed", "safety_gate_passed", "promotion_applied"],
        promotion_confidence: "high",
        safety_gate_passed: true,
        previous_owner_agent: "doc_agent",
        current_owner_agent: "runtime_agent",
        reroute_target: "runtime_agent",
        reroute_reason: "capability_gap",
        reroute_source: "promoted_decision_engine_v1",
        reroute_target_verified: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      decision_promotion_summary: "promotion_applied=true action=reroute previous_owner_agent=doc_agent current_owner_agent=runtime_agent reroute_target=runtime_agent reroute_reason=capability_gap reroute_source=promoted_decision_engine_v1 safety_gate_passed=true confidence=high reasons=[reroute_gate_passed, safety_gate_passed, promotion_applied] version=decision_engine_promotion_v1",
      promotion_policy: promotionPolicy,
      promotion_policy_summary: formatPromotionControlSurfaceSummary(promotionPolicy),
      promotion_audit: {
        promotion_audit_id: "audit-reroute-applied-1",
        promoted_action: "reroute",
        promotion_applied: true,
        promotion_effectiveness: "effective",
        rollback_flag: false,
        audit_version: "decision_engine_promotion_audit_v1",
        promotion_outcome: {
          final_step_status: "completed",
          outcome_status: "success",
          user_visible_completeness: "complete",
        },
      },
      promotion_audit_summary: "id=audit-reroute-applied-1 action=reroute applied=true previous_owner_agent=doc_agent current_owner_agent=runtime_agent reroute_target=runtime_agent reroute_reason=capability_gap reroute_source=promoted_decision_engine_v1 effectiveness=effective rollback_flag=false final_step_status=completed outcome_status=success user_visible_completeness=complete reasons=[] version=decision_engine_promotion_audit_v1",
    },
  });

  assert.equal(rerouteTrace.diff.includes("decision_promotion.reroute_target: runtime_agent"), true);
  assert.equal(rerouteTrace.diff.includes("decision_promotion.reroute_reason: capability_gap"), true);
  assert.equal(rerouteTrace.snapshot.decision_promotion?.reroute_target, "runtime_agent");
  assert.equal(rerouteTrace.snapshot.decision_promotion?.reroute_reason, "capability_gap");
  assert.equal(rerouteTrace.snapshot.promotion_audit?.promotion_effectiveness, "effective");
  assert.equal(rerouteTrace.event_alignment.decision_promotion_reroute_target, true);
  assert.equal(rerouteTrace.event_alignment.decision_promotion_reroute_reason, true);
  assert.equal(rerouteTrace.event_alignment.decision_promotion_reroute_source, true);
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
  assert.equal(typeof routerDecisionLog?.promotion_audit, "object");
  assert.equal(typeof routerDecisionLog?.promotion_audit?.promotion_effectiveness, "string");
  assert.equal(typeof routerDecisionLog?.promotion_audit?.rollback_flag, "boolean");
  assert.equal(typeof routerDecisionLog?.promotion_audit_summary, "string");
  assert.equal(result.selected_action, null);
  assert.equal(result.execution_result?.ok, false);

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});
