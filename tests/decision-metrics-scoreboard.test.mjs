import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [{
  createDecisionPromotionAuditState,
  applyDecisionPromotionAuditSafety,
  DECISION_ENGINE_PROMOTION_VERSION,
  DECISION_ENGINE_PROMOTION_AUDIT_VERSION,
}, {
  buildDecisionMetricsScoreboard,
  formatDecisionMetricsScoreboardSummary,
  buildRecoverySearchSplitMetrics,
  DECISION_METRICS_SCOREBOARD_VERSION,
}, {
  resolvePromotionControlSurface,
}, {
  buildPlannerTaskTraceDiagnostics,
}] = await Promise.all([
  import("../src/decision-engine-promotion.mjs"),
  import("../src/decision-metrics-scoreboard.mjs"),
  import("../src/promotion-control-surface.mjs"),
  import("../src/planner-working-memory-trace.mjs"),
]);

function buildAuditRecord({
  auditId = "audit-1",
  action = "ask_user",
  promotionApplied = true,
  effectiveness = "effective",
  alignmentType = "exact_match",
  rollbackFlag = false,
} = {}) {
  return {
    promotion_audit_id: auditId,
    promoted_action: action,
    promotion_applied: promotionApplied,
    promotion_effectiveness: effectiveness,
    rollback_flag: rollbackFlag,
    promotion_context: {
      alignment_type: alignmentType,
      advisor_alignment: {
        alignment_type: alignmentType,
      },
    },
    promotion_outcome: {
      final_step_status: promotionApplied ? "completed" : "running",
      outcome_status: promotionApplied ? "success" : "partial",
      user_visible_completeness: promotionApplied ? "complete" : "partial",
    },
    audit_version: DECISION_ENGINE_PROMOTION_AUDIT_VERSION,
  };
}

function applyAudit(state, auditRecord, promotionPolicy = null) {
  const safetyResult = applyDecisionPromotionAuditSafety({
    state,
    audit_record: auditRecord,
    promotion_policy: promotionPolicy,
  });
  return safetyResult.next_state;
}

function getEntry(scoreboard, actionName = "") {
  return Array.isArray(scoreboard?.actions)
    ? scoreboard.actions.find((entry) => entry?.action_name === actionName) || null
    : null;
}

test("scoreboard marks ask_user as high maturity when effective evidence is strong", () => {
  let state = createDecisionPromotionAuditState();
  for (let index = 0; index < 4; index += 1) {
    state = applyAudit(state, buildAuditRecord({
      auditId: `ask-user-effective-${index + 1}`,
      action: "ask_user",
      promotionApplied: true,
      effectiveness: "effective",
      alignmentType: "exact_match",
    }));
  }
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: state,
    promotion_policy: resolvePromotionControlSurface(),
  });
  const askUser = getEntry(scoreboard, "ask_user");
  assert.ok(askUser);
  assert.equal(askUser.maturity_signal, "high");
  assert.equal(askUser.promotion_applied_count, 4);
  assert.equal(askUser.effective_count, 4);
  assert.equal(askUser.ineffective_count, 0);
});

test("scoreboard marks retry as medium with limited but non-empty sample", () => {
  let state = createDecisionPromotionAuditState();
  state = applyAudit(state, buildAuditRecord({
    auditId: "retry-effective-1",
    action: "retry",
    promotionApplied: true,
    effectiveness: "effective",
    alignmentType: "exact_match",
  }));
  state = applyAudit(state, buildAuditRecord({
    auditId: "retry-advisory-1",
    action: "retry",
    promotionApplied: false,
    effectiveness: "unknown",
    alignmentType: "acceptable_divergence",
  }));
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: state,
    promotion_policy: resolvePromotionControlSurface(),
  });
  const retry = getEntry(scoreboard, "retry");
  assert.ok(retry);
  assert.equal(retry.maturity_signal, "medium");
  assert.equal(retry.promotion_applied_count, 1);
  assert.equal(retry.acceptable_divergence_count, 1);
});

test("scoreboard marks fail as low when ineffective and rollback evidence is high", () => {
  let state = createDecisionPromotionAuditState();
  const policy = resolvePromotionControlSurface({
    ineffective_threshold: 3,
  });
  for (let index = 0; index < 3; index += 1) {
    state = applyAudit(state, buildAuditRecord({
      auditId: `fail-ineffective-${index + 1}`,
      action: "fail",
      promotionApplied: true,
      effectiveness: "ineffective",
      alignmentType: "hard_divergence",
    }), policy);
  }
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: state,
    promotion_policy: policy,
  });
  const fail = getEntry(scoreboard, "fail");
  assert.ok(fail);
  assert.equal(fail.maturity_signal, "low");
  assert.equal(fail.current_rollback_disabled, true);
  assert.equal(fail.rollback_flag_count >= 1, true);
  assert.equal(fail.ineffective_count, 3);
});

test("scoreboard reflects rollback-disabled action from control surface", () => {
  const policy = resolvePromotionControlSurface({
    rollback_disabled_actions: ["retry"],
  });
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: createDecisionPromotionAuditState(),
    promotion_policy: policy,
  });
  const retry = getEntry(scoreboard, "retry");
  assert.ok(retry);
  assert.equal(retry.current_rollback_disabled, true);
  assert.equal(retry.promotion_enabled, false);
  assert.equal(scoreboard.rollback_disabled_actions.includes("retry"), true);
});

test("scoreboard includes reroute entry and metrics fields", () => {
  let state = createDecisionPromotionAuditState();
  state = applyAudit(state, buildAuditRecord({
    auditId: "reroute-effective-1",
    action: "reroute",
    promotionApplied: true,
    effectiveness: "effective",
    alignmentType: "exact_match",
  }));
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: state,
    promotion_policy: resolvePromotionControlSurface(),
  });
  const reroute = getEntry(scoreboard, "reroute");
  assert.ok(reroute);
  assert.equal(typeof reroute.promotion_enabled, "boolean");
  assert.equal(typeof reroute.promotion_applied_count, "number");
  assert.equal(typeof reroute.exact_match_count, "number");
  assert.equal(typeof reroute.effective_count, "number");
  assert.equal(typeof reroute.ineffective_count, "number");
  assert.equal(typeof reroute.current_rollback_disabled, "boolean");
  assert.equal(typeof reroute.maturity_signal, "string");
});

test("scoreboard fails closed on malformed metrics input", () => {
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: "bad_state_payload",
    promotion_policy: resolvePromotionControlSurface(),
  });
  assert.equal(scoreboard.fail_closed, true);
  assert.equal(scoreboard.summary?.fail_closed, true);
  assert.equal(scoreboard.reason_code, "malformed_metrics_input");
  assert.deepEqual(scoreboard.actions, []);
  assert.match(formatDecisionMetricsScoreboardSummary(scoreboard), /fail_closed=true/);
});

test("recovery split metrics compute retry_without_candidate ratio and search success rate from deterministic fixtures", () => {
  const metrics = buildRecoverySearchSplitMetrics({
    events: [
      {
        failure_event: true,
        decision_path: "search_candidate",
        candidate_count: 2,
        search_selected: true,
        search_success: true,
        retry_without_candidate: false,
      },
      {
        failure_event: true,
        decision_path: "search_candidate",
        candidate_count: 1,
        search_selected: true,
        search_success: false,
        retry_without_candidate: false,
      },
      {
        failure_event: true,
        decision_path: "retry_without_candidate",
        candidate_count: 0,
        search_selected: false,
        search_success: false,
        retry_without_candidate: true,
      },
    ],
  });

  assert.equal(metrics.fail_closed, false);
  assert.equal(metrics.total_failures, 3);
  assert.equal(metrics.candidate_generated_count, 2);
  assert.equal(metrics.search_selected_count, 2);
  assert.equal(metrics.retry_without_candidate_count, 1);
  assert.equal(metrics.retry_without_candidate_ratio, 1 / 3);
  assert.equal(metrics.search_success_rate, 1 / 2);
});

test("scoreboard summary exposes recovery split metrics for search-vs-retry observability", () => {
  const scoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: createDecisionPromotionAuditState(),
    promotion_policy: resolvePromotionControlSurface(),
    observability: {
      recovery_decision_path: "retry_without_candidate",
      recovery_candidate_count: 0,
      recovery_retry_without_candidate: true,
      outcome_status: "failed",
    },
  });

  assert.equal(scoreboard.summary?.recovery_split_metrics?.retry_without_candidate_count, 1);
  assert.equal(scoreboard.summary?.recovery_split_metrics?.total_failures, 1);
  assert.equal(typeof scoreboard.summary?.recovery_split_metrics?.search_success_rate, "number");
  assert.match(
    formatDecisionMetricsScoreboardSummary(scoreboard),
    /retry_without_candidate_ratio=/,
  );
});

test("trace diagnostics includes scoreboard summary and top action fields", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-scoreboard-trace",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
    },
    observability: {
      advisor_alignment: {
        advisor_action: "ask_user",
        actual_action: "ask_user",
        is_aligned: true,
        alignment_type: "exact_match",
        divergence_reason_codes: [],
        promotion_candidate: true,
      },
      decision_promotion: {
        promoted_action: "ask_user",
        promotion_applied: true,
        promotion_reason_codes: ["safety_gate_passed", "promotion_applied"],
        promotion_confidence: "high",
        safety_gate_passed: true,
        promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
      },
      promotion_policy: resolvePromotionControlSurface(),
      promotion_audit: {
        promotion_audit_id: "trace-scoreboard-audit-1",
        promoted_action: "ask_user",
        promotion_applied: true,
        promotion_effectiveness: "effective",
        rollback_flag: false,
        audit_version: DECISION_ENGINE_PROMOTION_AUDIT_VERSION,
        promotion_outcome: {
          final_step_status: "completed",
          outcome_status: "success",
          user_visible_completeness: "complete",
        },
      },
    },
  });

  assert.equal(trace.snapshot?.decision_scoreboard?.scoreboard_version, DECISION_METRICS_SCOREBOARD_VERSION);
  assert.equal(typeof trace.snapshot?.decision_scoreboard_summary, "string");
  assert.equal(Array.isArray(trace.snapshot?.highest_maturity_actions), true);
  assert.equal(Array.isArray(trace.snapshot?.rollback_disabled_actions), true);
  assert.equal(trace.diff.some((line) => line.startsWith("decision_scoreboard_summary:")), true);
  assert.match(trace.summary || "", /decision_scoreboard=/);
});

test("memory influence gate script reports memory_hit_rate and action_changed_by_memory_rate with action evidence", () => {
  const raw = execFileSync(
    "node",
    ["scripts/memory-influence-gate.mjs", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        LARK_APP_ID: process.env.LARK_APP_ID || "memory-gate-test-app-id",
        LARK_APP_SECRET: process.env.LARK_APP_SECRET || "memory-gate-test-app-secret",
      },
    },
  );
  const report = JSON.parse(raw);
  assert.equal(typeof report?.metrics?.memory_hit_rate, "number");
  assert.equal(typeof report?.metrics?.action_changed_by_memory_rate, "number");
  assert.equal(report?.checks?.memory_hit_rate?.ok, true);
  assert.equal(report?.checks?.action_changed_by_memory_rate?.ok, true);
  assert.equal(Array.isArray(report?.action_level_evidence), true);
  assert.equal(report?.action_level_evidence.length > 0, true);
});
