import { cleanText } from "./message-intent-utils.mjs";
import { normalizeExecutionOutcome } from "./execution-outcome-scorer.mjs";
import { formatAdvisorAlignmentSummary } from "./advisor-alignment-evaluator.mjs";
import {
  formatDecisionPromotionSummary,
  formatDecisionPromotionAuditSummary,
} from "./decision-engine-promotion.mjs";
import { formatPromotionControlSurfaceSummary } from "./promotion-control-surface.mjs";
import {
  buildDecisionMetricsScoreboard,
  formatDecisionMetricsScoreboardSummary,
} from "./decision-metrics-scoreboard.mjs";

const ABANDONED_TASK_PREVIEW_LIMIT = 3;

function normalizeRetryCount(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : 0;
}

function normalizeRetryPolicy(policy = null) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : {};
  const maxRetries = Number(normalizedPolicy.max_retries);
  return {
    max_retries: Number.isFinite(maxRetries) && maxRetries > 0
      ? Math.max(1, Math.floor(maxRetries))
      : 2,
    strategy: cleanText(normalizedPolicy.strategy || "") || "same_agent_then_reroute",
  };
}

function normalizeSlotState(slotState = []) {
  if (!Array.isArray(slotState)) {
    return {
      missing: [],
      filled: [],
      invalid: [],
      map: {},
    };
  }
  const map = {};
  for (const slot of slotState) {
    const slotKey = cleanText(slot?.slot_key || "");
    const status = cleanText(slot?.status || "");
    if (!slotKey || !status) {
      continue;
    }
    map[slotKey] = status;
  }
  const entries = Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  const missing = entries.filter(([, status]) => status === "missing").map(([slotKey]) => slotKey);
  const filled = entries.filter(([, status]) => status === "filled").map(([slotKey]) => slotKey);
  const invalid = entries.filter(([, status]) => status === "invalid").map(([slotKey]) => slotKey);
  return {
    missing,
    filled,
    invalid,
    map,
  };
}

function normalizeAbandonedTaskIds(taskIds = []) {
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds
    .map((taskId) => cleanText(taskId))
    .filter(Boolean);
}

function summarizeAbandonedTaskIds(taskIds = []) {
  const normalizedTaskIds = normalizeAbandonedTaskIds(taskIds);
  const preview = normalizedTaskIds.slice(-ABANDONED_TASK_PREVIEW_LIMIT);
  return {
    all: normalizedTaskIds,
    preview,
    hidden_count: Math.max(0, normalizedTaskIds.length - preview.length),
  };
}

function normalizeExecutionPlan(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      plan_id: null,
      plan_status: null,
      current_step: null,
      steps: [],
      map: {},
      artifacts: [],
      dependency_edges: [],
      primary_artifact: {
        artifact_id: null,
        artifact_type: null,
        validity_status: null,
        produced_by_step_id: null,
        affected_downstream_steps: null,
        dependency_type: null,
        artifact_superseded: false,
        dependency_blocked_step: null,
      },
    };
  }
  const planId = cleanText(plan.plan_id || "");
  const planStatus = cleanText(plan.plan_status || "");
  const currentStep = cleanText(plan.current_step_id || "");
  const normalizedSteps = Array.isArray(plan.steps)
    ? plan.steps
        .map((step) => {
          const stepId = cleanText(step?.step_id || "");
          const stepStatus = cleanText(step?.status || "");
          if (!stepId || !stepStatus) {
            return null;
          }
          return {
            step_id: stepId,
            status: stepStatus,
            failure_class: cleanText(step?.failure_class || "") || null,
            recovery_policy: cleanText(step?.recovery_policy || "") || null,
            outcome: normalizeExecutionOutcome(step?.outcome, { allowNull: true }),
            recovery_state: step?.recovery_state && typeof step.recovery_state === "object" && !Array.isArray(step.recovery_state)
              ? {
                  last_failure_class: cleanText(step.recovery_state.last_failure_class || "") || null,
                  recovery_attempt_count: Number.isFinite(Number(step.recovery_state.recovery_attempt_count))
                    ? Number(step.recovery_state.recovery_attempt_count)
                    : 0,
                  last_recovery_action: cleanText(step.recovery_state.last_recovery_action || "") || null,
                  rollback_target_step_id: cleanText(step.recovery_state.rollback_target_step_id || "") || null,
                }
              : {
                  last_failure_class: null,
                  recovery_attempt_count: 0,
                  last_recovery_action: null,
                  rollback_target_step_id: null,
                },
          };
        })
        .filter(Boolean)
    : [];
  const normalizedArtifacts = Array.isArray(plan.artifacts)
    ? plan.artifacts
        .map((artifact) => {
          const artifactId = cleanText(artifact?.artifact_id || "");
          if (!artifactId) {
            return null;
          }
          return {
            artifact_id: artifactId,
            artifact_type: cleanText(artifact?.artifact_type || "") || null,
            produced_by_step_id: cleanText(artifact?.produced_by_step_id || "") || null,
            validity_status: cleanText(artifact?.validity_status || "") || null,
            supersedes_artifact_id: cleanText(artifact?.supersedes_artifact_id || "") || null,
          };
        })
        .filter(Boolean)
    : [];
  const normalizedDependencyEdges = Array.isArray(plan.dependency_edges)
    ? plan.dependency_edges
        .map((edge) => {
          const fromStepId = cleanText(edge?.from_step_id || "");
          const toStepId = cleanText(edge?.to_step_id || "");
          const viaArtifactId = cleanText(edge?.via_artifact_id || "");
          const dependencyType = cleanText(edge?.dependency_type || "");
          if (!fromStepId || !toStepId || !viaArtifactId || !dependencyType) {
            return null;
          }
          return {
            from_step_id: fromStepId,
            to_step_id: toStepId,
            via_artifact_id: viaArtifactId,
            dependency_type: dependencyType,
          };
        })
        .filter(Boolean)
    : [];
  const map = {};
  for (const step of normalizedSteps) {
    map[step.step_id] = step.status;
  }
  const artifactMap = {};
  for (const artifact of normalizedArtifacts) {
    artifactMap[artifact.artifact_id] = artifact.validity_status || "none";
  }
  const artifactPriority = normalizedArtifacts.find((artifact) => artifact.validity_status === "invalid")
    || normalizedArtifacts.find((artifact) => artifact.validity_status === "missing")
    || normalizedArtifacts.find((artifact) => artifact.validity_status === "superseded")
    || normalizedArtifacts.find((artifact) => artifact.produced_by_step_id === currentStep)
    || normalizedArtifacts[0]
    || null;
  const hardDownstream = artifactPriority
    ? normalizedDependencyEdges
      .filter((edge) => edge.via_artifact_id === artifactPriority.artifact_id && edge.dependency_type === "hard")
      .map((edge) => edge.to_step_id)
    : [];
  const softDownstream = artifactPriority
    ? normalizedDependencyEdges
      .filter((edge) => edge.via_artifact_id === artifactPriority.artifact_id && edge.dependency_type === "soft")
      .map((edge) => edge.to_step_id)
    : [];
  const dependencyType = hardDownstream.length > 0
    ? "hard"
    : softDownstream.length > 0
      ? "soft"
      : null;
  const affectedDownstreamSteps = dependencyType === "hard"
    ? hardDownstream
    : softDownstream;
  const dependencyBlockedStep = dependencyType === "hard"
    ? affectedDownstreamSteps.find((stepId) => {
        const stepStatus = cleanText(map[stepId] || "");
        return stepStatus === "blocked" || stepStatus === "failed" || stepStatus === "running";
      }) || affectedDownstreamSteps[0] || null
    : null;
  return {
    plan_id: planId || null,
    plan_status: planStatus || null,
    current_step: currentStep || null,
    steps: normalizedSteps,
    map,
    artifacts: normalizedArtifacts,
    dependency_edges: normalizedDependencyEdges,
    artifact_map: artifactMap,
    primary_artifact: {
      artifact_id: artifactPriority?.artifact_id || null,
      artifact_type: artifactPriority?.artifact_type || null,
      validity_status: artifactPriority?.validity_status || null,
      produced_by_step_id: artifactPriority?.produced_by_step_id || null,
      affected_downstream_steps: affectedDownstreamSteps.length > 0
        ? Array.from(new Set(affectedDownstreamSteps))
        : null,
      dependency_type: dependencyType,
      artifact_superseded: artifactPriority?.validity_status === "superseded"
        || Boolean(cleanText(artifactPriority?.supersedes_artifact_id || "")),
      dependency_blocked_step: dependencyBlockedStep,
    },
  };
}

function resolveFocusPlanStep(executionPlan = null) {
  const normalizedPlan = executionPlan && typeof executionPlan === "object" && !Array.isArray(executionPlan)
    ? executionPlan
    : null;
  if (!normalizedPlan || !Array.isArray(normalizedPlan.steps) || normalizedPlan.steps.length === 0) {
    return null;
  }
  if (normalizedPlan.current_step) {
    const currentStep = normalizedPlan.steps.find((step) => step.step_id === normalizedPlan.current_step) || null;
    if (currentStep) {
      return currentStep;
    }
  }
  const producedByStepId = cleanText(normalizedPlan?.primary_artifact?.produced_by_step_id || "");
  if (producedByStepId) {
    const producedStep = normalizedPlan.steps.find((step) => step.step_id === producedByStepId) || null;
    if (producedStep) {
      return producedStep;
    }
  }
  for (let index = normalizedPlan.steps.length - 1; index >= 0; index -= 1) {
    const step = normalizedPlan.steps[index];
    if (normalizeExecutionOutcome(step?.outcome, { allowNull: true })) {
      return step;
    }
  }
  return normalizedPlan.steps[normalizedPlan.steps.length - 1] || null;
}

function toSnapshot(memorySnapshot = null) {
  const snapshot = memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)
    ? memorySnapshot
    : {};
  const retryPolicy = normalizeRetryPolicy(snapshot.retry_policy);
  const slotState = normalizeSlotState(snapshot.slot_state);
  const abandonedTaskIds = summarizeAbandonedTaskIds(snapshot.abandoned_task_ids);
  const executionPlan = normalizeExecutionPlan(snapshot.execution_plan);
  const currentPlanStep = resolveFocusPlanStep(executionPlan);
  const currentPlanStepOutcome = normalizeExecutionOutcome(currentPlanStep?.outcome, { allowNull: true });
  return {
    task_id: cleanText(snapshot.task_id || "") || null,
    task_type: cleanText(snapshot.task_type || snapshot.inferred_task_type || "") || null,
    task_phase: cleanText(snapshot.task_phase || "") || "init",
    task_status: cleanText(snapshot.task_status || "") || "running",
    current_owner_agent: cleanText(snapshot.current_owner_agent || snapshot.last_selected_agent || "") || null,
    previous_owner_agent: cleanText(snapshot.previous_owner_agent || "") || null,
    handoff_reason: cleanText(snapshot.handoff_reason || "") || null,
    retry_count: normalizeRetryCount(snapshot.retry_count),
    retry_policy: retryPolicy,
    next_best_action: cleanText(snapshot.next_best_action || "") || null,
    slot_state: {
      missing: slotState.missing,
      filled: slotState.filled,
      invalid: slotState.invalid,
    },
    abandoned_task_ids: abandonedTaskIds.preview,
    abandoned_task_total: abandonedTaskIds.all.length,
    abandoned_task_hidden_count: abandonedTaskIds.hidden_count,
    execution_plan: {
      plan_id: executionPlan.plan_id,
      plan_status: executionPlan.plan_status,
      current_step: executionPlan.current_step,
      current_step_failure_class: currentPlanStep?.failure_class || null,
      current_step_recovery_policy: currentPlanStep?.recovery_policy || null,
      current_step_recovery_action: currentPlanStep?.recovery_state?.last_recovery_action || null,
      current_step_recovery_attempt_count: Number.isFinite(Number(currentPlanStep?.recovery_state?.recovery_attempt_count))
        ? Number(currentPlanStep.recovery_state.recovery_attempt_count)
        : 0,
      current_step_rollback_target_step_id: currentPlanStep?.recovery_state?.rollback_target_step_id || null,
      current_step_outcome_status: currentPlanStepOutcome?.outcome_status || null,
      current_step_outcome_confidence: currentPlanStepOutcome?.outcome_confidence ?? null,
      current_step_outcome_evidence: currentPlanStepOutcome?.outcome_evidence || null,
      current_step_artifact_quality: currentPlanStepOutcome?.artifact_quality || null,
      current_step_retry_worthiness: typeof currentPlanStepOutcome?.retry_worthiness === "boolean"
        ? currentPlanStepOutcome.retry_worthiness
        : null,
      current_step_user_visible_completeness: currentPlanStepOutcome?.user_visible_completeness || null,
      artifact_id: executionPlan.primary_artifact.artifact_id || null,
      artifact_type: executionPlan.primary_artifact.artifact_type || null,
      validity_status: executionPlan.primary_artifact.validity_status || null,
      produced_by_step_id: executionPlan.primary_artifact.produced_by_step_id || null,
      affected_downstream_steps: executionPlan.primary_artifact.affected_downstream_steps || null,
      dependency_type: executionPlan.primary_artifact.dependency_type || null,
      artifact_superseded: executionPlan.primary_artifact.artifact_superseded === true,
      dependency_blocked_step: executionPlan.primary_artifact.dependency_blocked_step || null,
      artifact_count: Array.isArray(executionPlan.artifacts) ? executionPlan.artifacts.length : 0,
      dependency_edge_count: Array.isArray(executionPlan.dependency_edges) ? executionPlan.dependency_edges.length : 0,
      steps: executionPlan.steps,
    },
    _slot_map: slotState.map,
    _plan_step_map: executionPlan.map,
    _artifact_map: executionPlan.artifact_map || {},
  };
}

function formatValue(value = null) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? `[${value.join(", ")}]`
      : "[]";
  }
  return String(value);
}

function parseTransition(transition = "") {
  const normalized = cleanText(transition);
  if (!normalized || !normalized.includes("->")) {
    return null;
  }
  const [fromRaw, toRaw] = normalized.split("->");
  const from = cleanText(fromRaw || "");
  const to = cleanText(toRaw || "");
  if (!from && !to) {
    return null;
  }
  return {
    from: from || "none",
    to: to || "none",
  };
}

function normalizeReadinessObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const readinessObject = normalizedObservability.readiness
    && typeof normalizedObservability.readiness === "object"
    && !Array.isArray(normalizedObservability.readiness)
    ? normalizedObservability.readiness
    : {};
  return {
    is_ready: typeof readinessObject.is_ready === "boolean"
      ? readinessObject.is_ready
      : null,
    blocking_reason_codes: Array.isArray(readinessObject.blocking_reason_codes)
      ? readinessObject.blocking_reason_codes.map((item) => cleanText(item)).filter(Boolean)
      : Array.isArray(normalizedObservability.blocking_reason_codes)
        ? normalizedObservability.blocking_reason_codes.map((item) => cleanText(item)).filter(Boolean)
        : [],
    missing_slots: Array.isArray(readinessObject.missing_slots)
      ? readinessObject.missing_slots.map((item) => cleanText(item)).filter(Boolean)
      : Array.isArray(normalizedObservability.missing_slots)
        ? normalizedObservability.missing_slots.map((item) => cleanText(item)).filter(Boolean)
        : [],
    invalid_artifacts: Array.isArray(readinessObject.invalid_artifacts)
      ? readinessObject.invalid_artifacts
      : Array.isArray(normalizedObservability.invalid_artifacts)
        ? normalizedObservability.invalid_artifacts
        : [],
    blocked_dependencies: Array.isArray(readinessObject.blocked_dependencies)
      ? readinessObject.blocked_dependencies
      : Array.isArray(normalizedObservability.blocked_dependencies)
        ? normalizedObservability.blocked_dependencies
        : [],
    owner_ready: typeof readinessObject.owner_ready === "boolean"
      ? readinessObject.owner_ready
      : typeof normalizedObservability.owner_ready === "boolean"
        ? normalizedObservability.owner_ready
        : null,
    recovery_ready: typeof readinessObject.recovery_ready === "boolean"
      ? readinessObject.recovery_ready
      : typeof normalizedObservability.recovery_ready === "boolean"
        ? normalizedObservability.recovery_ready
        : null,
    recommended_action: cleanText(readinessObject.recommended_action || normalizedObservability.recommended_action || "") || null,
  };
}

function normalizeOutcomeObservability(observability = null, snapshot = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const normalizedFromObservability = normalizeExecutionOutcome({
    outcome_status: normalizedObservability.outcome_status,
    outcome_confidence: normalizedObservability.outcome_confidence,
    outcome_evidence: normalizedObservability.outcome_evidence,
    artifact_quality: normalizedObservability.artifact_quality,
    retry_worthiness: normalizedObservability.retry_worthiness,
    user_visible_completeness: normalizedObservability.user_visible_completeness,
  }, { allowNull: true });
  if (normalizedFromObservability) {
    return normalizedFromObservability;
  }
  const snapshotOutcome = normalizeExecutionOutcome({
    outcome_status: snapshot?.execution_plan?.current_step_outcome_status,
    outcome_confidence: snapshot?.execution_plan?.current_step_outcome_confidence,
    outcome_evidence: snapshot?.execution_plan?.current_step_outcome_evidence,
    artifact_quality: snapshot?.execution_plan?.current_step_artifact_quality,
    retry_worthiness: snapshot?.execution_plan?.current_step_retry_worthiness,
    user_visible_completeness: snapshot?.execution_plan?.current_step_user_visible_completeness,
  }, { allowNull: true });
  return snapshotOutcome;
}

function normalizeAdvisorAlignment(value = null) {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  if (!normalized) {
    return null;
  }
  const advisorAction = cleanText(normalized.advisor_action || normalized.recommended_next_action || "");
  const actualAction = cleanText(normalized.actual_action || normalized.actual_next_action || "");
  const alignmentType = cleanText(normalized.alignment_type || "");
  const divergenceReasonCodes = Array.isArray(normalized.divergence_reason_codes)
    ? normalized.divergence_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const evaluatorVersion = cleanText(normalized.evaluator_version || "");
  return {
    advisor_action: advisorAction || null,
    actual_action: actualAction || null,
    recommended_next_action: advisorAction || null,
    actual_next_action: actualAction || null,
    is_aligned: typeof normalized.is_aligned === "boolean"
      ? normalized.is_aligned
      : null,
    alignment_type: alignmentType || null,
    divergence_reason_codes: divergenceReasonCodes,
    promotion_candidate: typeof normalized.promotion_candidate === "boolean"
      ? normalized.promotion_candidate
      : null,
    evaluator_version: evaluatorVersion || null,
  };
}

function normalizeAdvisorObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const advisorObject = normalizedObservability.advisor
    && typeof normalizedObservability.advisor === "object"
    && !Array.isArray(normalizedObservability.advisor)
    ? normalizedObservability.advisor
    : {};
  const reasonCodes = Array.isArray(advisorObject.decision_reason_codes)
    ? advisorObject.decision_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const alignment = normalizeAdvisorAlignment(
    normalizedObservability.advisor_alignment
    || normalizedObservability.advisor_vs_actual,
  );
  const alignmentSummaryFromObservability = cleanText(normalizedObservability.advisor_alignment_summary || "") || null;
  return {
    recommended_next_action: cleanText(advisorObject.recommended_next_action || "") || null,
    decision_reason_codes: reasonCodes,
    decision_confidence: cleanText(advisorObject.decision_confidence || "") || null,
    advisor_version: cleanText(advisorObject.advisor_version || "") || null,
    based_on: advisorObject.based_on && typeof advisorObject.based_on === "object" && !Array.isArray(advisorObject.based_on)
      ? advisorObject.based_on
      : null,
    based_on_summary: cleanText(normalizedObservability.advisor_based_on_summary || "") || null,
    alignment,
    alignment_summary: alignmentSummaryFromObservability
      || (alignment ? formatAdvisorAlignmentSummary(alignment) : null),
  };
}

function normalizeDecisionPromotionObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const hasPromotionObject = Boolean(
    normalizedObservability.decision_promotion
    && typeof normalizedObservability.decision_promotion === "object"
    && !Array.isArray(normalizedObservability.decision_promotion),
  );
  const promotionObject = hasPromotionObject
    && typeof normalizedObservability.decision_promotion === "object"
    && !Array.isArray(normalizedObservability.decision_promotion)
    ? normalizedObservability.decision_promotion
    : {};
  const promotedAction = cleanText(promotionObject.promoted_action || "");
  const reasonCodes = Array.isArray(promotionObject.promotion_reason_codes)
    ? promotionObject.promotion_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const normalizedPromotion = {
    promoted_action: promotedAction || null,
    promotion_applied: promotionObject.promotion_applied === true,
    promotion_reason_codes: reasonCodes,
    promotion_confidence: cleanText(promotionObject.promotion_confidence || "") || null,
    safety_gate_passed: promotionObject.safety_gate_passed === true,
    previous_owner_agent: cleanText(promotionObject.previous_owner_agent || "") || null,
    current_owner_agent: cleanText(promotionObject.current_owner_agent || "") || null,
    reroute_target: cleanText(promotionObject.reroute_target || "") || null,
    reroute_reason: cleanText(promotionObject.reroute_reason || "") || null,
    reroute_source: cleanText(promotionObject.reroute_source || "") || null,
    reroute_target_verified: typeof promotionObject.reroute_target_verified === "boolean"
      ? promotionObject.reroute_target_verified
      : null,
    promotion_version: cleanText(promotionObject.promotion_version || "") || null,
  };
  const summary = cleanText(normalizedObservability.decision_promotion_summary || "");
  const present = hasPromotionObject || Boolean(summary);
  return {
    present,
    ...normalizedPromotion,
    summary: present
      ? (summary || formatDecisionPromotionSummary(normalizedPromotion))
      : null,
  };
}

function normalizePromotionPolicyObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const hasPolicyObject = Boolean(
    normalizedObservability.promotion_policy
    && typeof normalizedObservability.promotion_policy === "object"
    && !Array.isArray(normalizedObservability.promotion_policy),
  );
  const policyObject = hasPolicyObject
    && typeof normalizedObservability.promotion_policy === "object"
    && !Array.isArray(normalizedObservability.promotion_policy)
    ? normalizedObservability.promotion_policy
    : {};
  const allowedActions = Array.isArray(policyObject.allowed_actions)
    ? policyObject.allowed_actions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const deniedActions = Array.isArray(policyObject.denied_actions)
    ? policyObject.denied_actions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const rollbackDisabledActions = Array.isArray(policyObject.rollback_disabled_actions)
    ? policyObject.rollback_disabled_actions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const policyReasonCodes = Array.isArray(policyObject.policy_reason_codes)
    ? policyObject.policy_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const ineffectiveThreshold = Number.isFinite(Number(policyObject.ineffective_threshold))
    ? Math.max(1, Number(policyObject.ineffective_threshold))
    : null;
  const normalizedPolicy = {
    promotion_policy_version: cleanText(policyObject.promotion_policy_version || "") || null,
    allowed_actions: allowedActions,
    denied_actions: deniedActions,
    rollback_disabled_actions: rollbackDisabledActions,
    ineffective_threshold: ineffectiveThreshold,
    policy_reason_codes: policyReasonCodes,
    policy_fail_closed: policyObject.policy_fail_closed === true,
  };
  const summary = cleanText(normalizedObservability.promotion_policy_summary || "");
  const present = hasPolicyObject || Boolean(summary);
  return {
    present,
    ...normalizedPolicy,
    summary: present
      ? (summary || formatPromotionControlSurfaceSummary(normalizedPolicy))
      : null,
  };
}

function normalizePromotionAuditObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const hasAuditObject = Boolean(
    normalizedObservability.promotion_audit
    && typeof normalizedObservability.promotion_audit === "object"
    && !Array.isArray(normalizedObservability.promotion_audit),
  );
  const auditObject = hasAuditObject
    && typeof normalizedObservability.promotion_audit === "object"
    && !Array.isArray(normalizedObservability.promotion_audit)
    ? normalizedObservability.promotion_audit
    : {};
  const promotionOutcome = auditObject.promotion_outcome
    && typeof auditObject.promotion_outcome === "object"
    && !Array.isArray(auditObject.promotion_outcome)
    ? auditObject.promotion_outcome
    : {};
  const normalizedAudit = {
    promotion_audit_id: cleanText(auditObject.promotion_audit_id || "") || null,
    promoted_action: cleanText(auditObject.promoted_action || "") || null,
    promotion_applied: auditObject.promotion_applied === true,
    promotion_effectiveness: cleanText(auditObject.promotion_effectiveness || "") || null,
    rollback_flag: auditObject.rollback_flag === true,
    audit_version: cleanText(auditObject.audit_version || "") || null,
    promotion_outcome: {
      final_step_status: cleanText(promotionOutcome.final_step_status || "") || null,
      outcome_status: cleanText(promotionOutcome.outcome_status || "") || null,
      user_visible_completeness: cleanText(promotionOutcome.user_visible_completeness || "") || null,
    },
  };
  const summary = cleanText(normalizedObservability.promotion_audit_summary || "");
  const present = hasAuditObject || Boolean(summary);
  return {
    present,
    ...normalizedAudit,
    summary: present
      ? (summary || formatDecisionPromotionAuditSummary(normalizedAudit))
      : null,
  };
}

function normalizeDecisionScoreboardObservability(observability = null) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const providedScoreboard = normalizedObservability.decision_scoreboard
    && typeof normalizedObservability.decision_scoreboard === "object"
    && !Array.isArray(normalizedObservability.decision_scoreboard)
    ? normalizedObservability.decision_scoreboard
    : null;
  const resolvedScoreboard = providedScoreboard
    || buildDecisionMetricsScoreboard({
      promotion_policy: normalizedObservability.promotion_policy || null,
      observability: normalizedObservability,
    });
  const summaryFromObservability = cleanText(normalizedObservability.decision_scoreboard_summary || "") || null;
  const normalizedSummary = summaryFromObservability || formatDecisionMetricsScoreboardSummary(resolvedScoreboard);
  const highestMaturityActions = Array.isArray(normalizedObservability.highest_maturity_actions)
    ? normalizedObservability.highest_maturity_actions.map((item) => cleanText(item)).filter(Boolean)
    : Array.isArray(resolvedScoreboard.highest_maturity_actions)
      ? resolvedScoreboard.highest_maturity_actions
      : [];
  const rollbackDisabledActions = Array.isArray(normalizedObservability.rollback_disabled_actions)
    ? normalizedObservability.rollback_disabled_actions.map((item) => cleanText(item)).filter(Boolean)
    : Array.isArray(resolvedScoreboard.rollback_disabled_actions)
      ? resolvedScoreboard.rollback_disabled_actions
      : [];
  const actions = Array.isArray(resolvedScoreboard.actions)
    ? resolvedScoreboard.actions
    : [];
  return {
    present: Boolean(
      providedScoreboard
      || summaryFromObservability
      || actions.length > 0,
    ),
    scoreboard: resolvedScoreboard,
    actions,
    summary: normalizedSummary,
    highest_maturity_actions: highestMaturityActions,
    rollback_disabled_actions: rollbackDisabledActions,
  };
}

function formatAdvisorReasons(reasonCodes = []) {
  return Array.isArray(reasonCodes) && reasonCodes.length > 0
    ? `[${reasonCodes.join(", ")}]`
    : "[]";
}

function formatAdvisorAlignment(alignment = null) {
  const normalized = normalizeAdvisorAlignment(alignment);
  if (!normalized) {
    return "none";
  }
  const advisorAction = cleanText(normalized.advisor_action || "") || "none";
  const actualAction = cleanText(normalized.actual_action || "") || "none";
  const alignmentType = cleanText(normalized.alignment_type || "") || "unknown";
  const divergenceReasonCodes = Array.isArray(normalized.divergence_reason_codes)
    ? normalized.divergence_reason_codes
    : [];
  const aligned = typeof normalized.is_aligned === "boolean"
    ? (normalized.is_aligned ? "aligned" : "mismatch")
    : "unknown";
  return `${advisorAction} vs ${actualAction} (${aligned}/${alignmentType}; reasons=${formatValue(divergenceReasonCodes)}; promotion=${formatValue(normalized.promotion_candidate)})`;
}

function formatOutcomeEvidence(evidence = null) {
  const normalizedEvidence = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence
    : null;
  if (!normalizedEvidence) {
    return "none";
  }
  const slotsFilledCount = Number.isFinite(Number(normalizedEvidence.slots_filled_count))
    ? Number(normalizedEvidence.slots_filled_count)
    : 0;
  const slotsMissingCount = Number.isFinite(Number(normalizedEvidence.slots_missing_count))
    ? Number(normalizedEvidence.slots_missing_count)
    : 0;
  const artifactsProducedCount = Number.isFinite(Number(normalizedEvidence.artifacts_produced_count))
    ? Number(normalizedEvidence.artifacts_produced_count)
    : 0;
  const errorsEncountered = Array.isArray(normalizedEvidence.errors_encountered)
    ? normalizedEvidence.errors_encountered.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const recoveryActionsTaken = Array.isArray(normalizedEvidence.recovery_actions_taken)
    ? normalizedEvidence.recovery_actions_taken.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return `slots=${slotsFilledCount}/${slotsMissingCount} artifacts=${artifactsProducedCount} errors=${formatValue(errorsEncountered)} recovery=${formatValue(recoveryActionsTaken)}`;
}

function summarizeReadinessArtifacts(invalidArtifacts = []) {
  if (!Array.isArray(invalidArtifacts) || invalidArtifacts.length === 0) {
    return [];
  }
  return invalidArtifacts
    .map((artifact) => {
      const artifactId = cleanText(artifact?.artifact_id || "") || "unknown";
      const validityStatus = cleanText(artifact?.validity_status || "") || "unknown";
      const blockedStep = cleanText(artifact?.blocked_step_id || "") || "unknown";
      return `${artifactId}:${validityStatus}->${blockedStep}`;
    })
    .filter(Boolean);
}

function summarizeBlockedDependencies(blockedDependencies = []) {
  if (!Array.isArray(blockedDependencies) || blockedDependencies.length === 0) {
    return [];
  }
  return blockedDependencies
    .map((dependency) => {
      const stepId = cleanText(dependency?.step_id || "") || "unknown";
      const status = cleanText(dependency?.status || "") || "unknown";
      return `${stepId}:${status}`;
    })
    .filter(Boolean);
}

function buildDiffLines({
  previousSnapshot = null,
  nextSnapshot = null,
  observability = null,
} = {}) {
  const previous = toSnapshot(previousSnapshot);
  const next = toSnapshot(nextSnapshot);
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const readinessObservability = normalizeReadinessObservability(normalizedObservability);
  const outcomeObservability = normalizeOutcomeObservability(normalizedObservability, next);
  const advisorObservability = normalizeAdvisorObservability(normalizedObservability);
  const promotionObservability = normalizeDecisionPromotionObservability(normalizedObservability);
  const promotionPolicyObservability = normalizePromotionPolicyObservability(normalizedObservability);
  const promotionAuditObservability = normalizePromotionAuditObservability(normalizedObservability);
  const decisionScoreboardObservability = normalizeDecisionScoreboardObservability(normalizedObservability);
  const diffLines = [];
  const seen = new Set();
  const addDiffLine = (line = "") => {
    const normalized = cleanText(line);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    diffLines.push(normalized);
  };
  const addFieldDiff = (field, leftValue, rightValue) => {
    if (formatValue(leftValue) === formatValue(rightValue)) {
      return;
    }
    addDiffLine(`${field}: ${formatValue(leftValue)} -> ${formatValue(rightValue)}`);
  };
  const hasDiffPrefix = (prefix = "") => {
    const normalizedPrefix = cleanText(prefix);
    if (!normalizedPrefix) {
      return false;
    }
    return diffLines.some((line) => line.startsWith(normalizedPrefix));
  };

  addFieldDiff("task_id", previous.task_id, next.task_id);
  addFieldDiff("task_type", previous.task_type, next.task_type);
  addFieldDiff("task_phase", previous.task_phase, next.task_phase);
  addFieldDiff("task_status", previous.task_status, next.task_status);
  addFieldDiff("current_owner_agent", previous.current_owner_agent, next.current_owner_agent);
  addFieldDiff("previous_owner_agent", previous.previous_owner_agent, next.previous_owner_agent);
  addFieldDiff("handoff_reason", previous.handoff_reason, next.handoff_reason);
  addFieldDiff("retry_count", previous.retry_count, next.retry_count);
  addFieldDiff("retry_policy.max_retries", previous.retry_policy.max_retries, next.retry_policy.max_retries);
  addFieldDiff("retry_policy.strategy", previous.retry_policy.strategy, next.retry_policy.strategy);
  addFieldDiff("next_best_action", previous.next_best_action, next.next_best_action);
  addFieldDiff("abandoned_task_ids", previous.abandoned_task_ids, next.abandoned_task_ids);
  addFieldDiff("plan_id", previous.execution_plan.plan_id, next.execution_plan.plan_id);
  addFieldDiff("plan_status", previous.execution_plan.plan_status, next.execution_plan.plan_status);
  addFieldDiff("current_step", previous.execution_plan.current_step, next.execution_plan.current_step);
  addFieldDiff("current_step_failure_class", previous.execution_plan.current_step_failure_class, next.execution_plan.current_step_failure_class);
  addFieldDiff("current_step_recovery_policy", previous.execution_plan.current_step_recovery_policy, next.execution_plan.current_step_recovery_policy);
  addFieldDiff("current_step_recovery_action", previous.execution_plan.current_step_recovery_action, next.execution_plan.current_step_recovery_action);
  addFieldDiff("current_step_recovery_attempt_count", previous.execution_plan.current_step_recovery_attempt_count, next.execution_plan.current_step_recovery_attempt_count);
  addFieldDiff("current_step_rollback_target_step_id", previous.execution_plan.current_step_rollback_target_step_id, next.execution_plan.current_step_rollback_target_step_id);
  addFieldDiff("outcome_status", previous.execution_plan.current_step_outcome_status, next.execution_plan.current_step_outcome_status);
  addFieldDiff("outcome_confidence", previous.execution_plan.current_step_outcome_confidence, next.execution_plan.current_step_outcome_confidence);
  addFieldDiff("outcome_evidence", formatOutcomeEvidence(previous.execution_plan.current_step_outcome_evidence), formatOutcomeEvidence(next.execution_plan.current_step_outcome_evidence));
  addFieldDiff("artifact_quality", previous.execution_plan.current_step_artifact_quality, next.execution_plan.current_step_artifact_quality);
  addFieldDiff("retry_worthiness", previous.execution_plan.current_step_retry_worthiness, next.execution_plan.current_step_retry_worthiness);
  addFieldDiff("user_visible_completeness", previous.execution_plan.current_step_user_visible_completeness, next.execution_plan.current_step_user_visible_completeness);
  addFieldDiff("artifact_id", previous.execution_plan.artifact_id, next.execution_plan.artifact_id);
  addFieldDiff("artifact_type", previous.execution_plan.artifact_type, next.execution_plan.artifact_type);
  addFieldDiff("validity_status", previous.execution_plan.validity_status, next.execution_plan.validity_status);
  addFieldDiff("produced_by_step_id", previous.execution_plan.produced_by_step_id, next.execution_plan.produced_by_step_id);
  addFieldDiff("affected_downstream_steps", previous.execution_plan.affected_downstream_steps, next.execution_plan.affected_downstream_steps);
  addFieldDiff("dependency_type", previous.execution_plan.dependency_type, next.execution_plan.dependency_type);
  addFieldDiff("artifact_superseded", previous.execution_plan.artifact_superseded, next.execution_plan.artifact_superseded);
  addFieldDiff("dependency_blocked_step", previous.execution_plan.dependency_blocked_step, next.execution_plan.dependency_blocked_step);

  const slotKeys = Array.from(new Set([
    ...Object.keys(previous._slot_map || {}),
    ...Object.keys(next._slot_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const slotKey of slotKeys) {
    addFieldDiff(`slot.${slotKey}`, previous._slot_map[slotKey] || "none", next._slot_map[slotKey] || "none");
  }
  const planStepKeys = Array.from(new Set([
    ...Object.keys(previous._plan_step_map || {}),
    ...Object.keys(next._plan_step_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const stepId of planStepKeys) {
    addFieldDiff(`plan.step.${stepId}`, previous._plan_step_map[stepId] || "none", next._plan_step_map[stepId] || "none");
  }
  const artifactKeys = Array.from(new Set([
    ...Object.keys(previous._artifact_map || {}),
    ...Object.keys(next._artifact_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const artifactId of artifactKeys) {
    addFieldDiff(`plan.artifact.${artifactId}`, previous._artifact_map[artifactId] || "none", next._artifact_map[artifactId] || "none");
  }

  const phaseTransition = parseTransition(normalizedObservability.task_phase_transition);
  if (phaseTransition) {
    addDiffLine(`task_phase: ${phaseTransition.from} -> ${phaseTransition.to}`);
  }
  const statusTransition = parseTransition(normalizedObservability.task_status_transition);
  if (statusTransition) {
    addDiffLine(`task_status: ${statusTransition.from} -> ${statusTransition.to}`);
  }

  const handoff = normalizedObservability.agent_handoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    addDiffLine(`current_owner_agent: ${formatValue(handoff.from)} -> ${formatValue(handoff.to)}`);
    const reason = cleanText(handoff.reason || "");
    if (reason && !hasDiffPrefix("handoff_reason:")) {
      addDiffLine(`handoff_reason: ${reason}`);
    }
  }

  const retryAttempt = normalizedObservability.retry_attempt;
  if (retryAttempt && typeof retryAttempt === "object" && !Array.isArray(retryAttempt)) {
    if (!hasDiffPrefix("retry_count:")
      && Number.isFinite(Number(retryAttempt.from))
      && Number.isFinite(Number(retryAttempt.to))) {
      addDiffLine(`retry_count: ${Number(retryAttempt.from)} -> ${Number(retryAttempt.to)}`);
    } else if (!hasDiffPrefix("retry_count:") && Number.isFinite(Number(retryAttempt.retry_count))) {
      addDiffLine(`retry_count: ${next.retry_count} -> ${Number(retryAttempt.retry_count)}`);
    }
  }

  const slotUpdate = normalizedObservability.slot_update;
  if (slotUpdate
    && typeof slotUpdate === "object"
    && !Array.isArray(slotUpdate)
    && Array.isArray(slotUpdate.pending_slots)
    && slotUpdate.pending_slots.length > 0
    && !hasDiffPrefix("slot_state.missing:")) {
    addDiffLine(`slot_state.missing: ${formatValue(slotUpdate.pending_slots)}`);
  }
  const taskAbandoned = normalizedObservability.task_abandoned;
  if (taskAbandoned && typeof taskAbandoned === "object" && !Array.isArray(taskAbandoned)) {
    const abandonedTaskId = cleanText(taskAbandoned.task_id || "");
    if (abandonedTaskId && !hasDiffPrefix("abandoned_task_ids:")) {
      addDiffLine(`abandoned_task_ids: +${abandonedTaskId}`);
    }
  }
  const stepTransition = normalizedObservability.step_transition;
  if (stepTransition && typeof stepTransition === "object" && !Array.isArray(stepTransition)) {
    const steps = Array.isArray(stepTransition.steps) ? stepTransition.steps : [];
    for (const step of steps) {
      const stepId = cleanText(step?.step_id || "");
      if (!stepId) {
        continue;
      }
      addDiffLine(`plan.step.${stepId}: ${formatValue(step?.from || null)} -> ${formatValue(step?.to || null)}`);
    }
    if (stepTransition.from_current_step_id || stepTransition.to_current_step_id) {
      addDiffLine(`current_step: ${formatValue(stepTransition.from_current_step_id || null)} -> ${formatValue(stepTransition.to_current_step_id || null)}`);
    }
  }
  const planInvalidated = normalizedObservability.plan_invalidated;
  if (planInvalidated && typeof planInvalidated === "object" && !Array.isArray(planInvalidated)) {
    const planId = cleanText(planInvalidated.plan_id || "");
    if (planId && !hasDiffPrefix("plan_invalidated:")) {
      addDiffLine(`plan_invalidated: ${planId} (${cleanText(planInvalidated.reason || "unknown") || "unknown"})`);
    }
  }
  const failureClass = cleanText(normalizedObservability.failure_class || "");
  if (failureClass && !hasDiffPrefix("failure_class:")) {
    addDiffLine(`failure_class: ${failureClass}`);
  }
  const recoveryPolicy = cleanText(normalizedObservability.recovery_policy || "");
  if (recoveryPolicy && !hasDiffPrefix("recovery_policy:")) {
    addDiffLine(`recovery_policy: ${recoveryPolicy}`);
  }
  const recoveryAction = cleanText(normalizedObservability.recovery_action || "");
  if (recoveryAction && !hasDiffPrefix("recovery_action:")) {
    addDiffLine(`recovery_action: ${recoveryAction}`);
  }
  if (Number.isFinite(Number(normalizedObservability.recovery_attempt_count))
    && !hasDiffPrefix("recovery_attempt_count:")) {
    addDiffLine(`recovery_attempt_count: ${Number(normalizedObservability.recovery_attempt_count)}`);
  }
  const rollbackTargetStepId = cleanText(normalizedObservability.rollback_target_step_id || "");
  if (rollbackTargetStepId && !hasDiffPrefix("rollback_target_step_id:")) {
    addDiffLine(`rollback_target_step_id: ${rollbackTargetStepId}`);
  }
  if (Array.isArray(normalizedObservability.skipped_step_ids)
    && normalizedObservability.skipped_step_ids.length > 0
    && !hasDiffPrefix("skipped_step_ids:")) {
    addDiffLine(`skipped_step_ids: ${formatValue(normalizedObservability.skipped_step_ids)}`);
  }
  const artifactId = cleanText(normalizedObservability.artifact_id || "");
  if (artifactId && !hasDiffPrefix("artifact_id:")) {
    addDiffLine(`artifact_id: ${artifactId}`);
  }
  const artifactType = cleanText(normalizedObservability.artifact_type || "");
  if (artifactType && !hasDiffPrefix("artifact_type:")) {
    addDiffLine(`artifact_type: ${artifactType}`);
  }
  const validityStatus = cleanText(normalizedObservability.validity_status || "");
  if (validityStatus && !hasDiffPrefix("validity_status:")) {
    addDiffLine(`validity_status: ${validityStatus}`);
  }
  const producedByStepId = cleanText(normalizedObservability.produced_by_step_id || "");
  if (producedByStepId && !hasDiffPrefix("produced_by_step_id:")) {
    addDiffLine(`produced_by_step_id: ${producedByStepId}`);
  }
  if (Array.isArray(normalizedObservability.affected_downstream_steps)
    && normalizedObservability.affected_downstream_steps.length > 0
    && !hasDiffPrefix("affected_downstream_steps:")) {
    addDiffLine(`affected_downstream_steps: ${formatValue(normalizedObservability.affected_downstream_steps)}`);
  }
  const dependencyType = cleanText(normalizedObservability.dependency_type || "");
  if (dependencyType && !hasDiffPrefix("dependency_type:")) {
    addDiffLine(`dependency_type: ${dependencyType}`);
  }
  if (normalizedObservability.artifact_superseded === true && !hasDiffPrefix("artifact_superseded:")) {
    addDiffLine("artifact_superseded: true");
  }
  const dependencyBlockedStep = cleanText(normalizedObservability.dependency_blocked_step || "");
  if (dependencyBlockedStep && !hasDiffPrefix("dependency_blocked_step:")) {
    addDiffLine(`dependency_blocked_step: ${dependencyBlockedStep}`);
  }
  if (typeof readinessObservability.is_ready === "boolean" && !hasDiffPrefix("readiness.is_ready:")) {
    addDiffLine(`readiness.is_ready: ${readinessObservability.is_ready ? "true" : "false"}`);
  }
  if (Array.isArray(readinessObservability.blocking_reason_codes)
    && readinessObservability.blocking_reason_codes.length > 0
    && !hasDiffPrefix("blocking_reason_codes:")) {
    addDiffLine(`blocking_reason_codes: ${formatValue(readinessObservability.blocking_reason_codes)}`);
  }
  if (Array.isArray(readinessObservability.missing_slots)
    && readinessObservability.missing_slots.length > 0
    && !hasDiffPrefix("missing_slots:")) {
    addDiffLine(`missing_slots: ${formatValue(readinessObservability.missing_slots)}`);
  }
  const readinessInvalidArtifacts = summarizeReadinessArtifacts(readinessObservability.invalid_artifacts);
  if (readinessInvalidArtifacts.length > 0 && !hasDiffPrefix("invalid_artifacts:")) {
    addDiffLine(`invalid_artifacts: ${formatValue(readinessInvalidArtifacts)}`);
  }
  const readinessBlockedDependencies = summarizeBlockedDependencies(readinessObservability.blocked_dependencies);
  if (readinessBlockedDependencies.length > 0 && !hasDiffPrefix("blocked_dependencies:")) {
    addDiffLine(`blocked_dependencies: ${formatValue(readinessBlockedDependencies)}`);
  }
  if (typeof readinessObservability.owner_ready === "boolean" && !hasDiffPrefix("owner_ready:")) {
    addDiffLine(`owner_ready: ${readinessObservability.owner_ready ? "true" : "false"}`);
  }
  if (typeof readinessObservability.recovery_ready === "boolean" && !hasDiffPrefix("recovery_ready:")) {
    addDiffLine(`recovery_ready: ${readinessObservability.recovery_ready ? "true" : "false"}`);
  }
  if (readinessObservability.recommended_action && !hasDiffPrefix("recommended_action:")) {
    addDiffLine(`recommended_action: ${readinessObservability.recommended_action}`);
  }
  if (outcomeObservability?.outcome_status && !hasDiffPrefix("outcome_status:")) {
    addDiffLine(`outcome_status: ${outcomeObservability.outcome_status}`);
  }
  if (outcomeObservability?.outcome_confidence !== null
    && outcomeObservability?.outcome_confidence !== undefined
    && !hasDiffPrefix("outcome_confidence:")) {
    addDiffLine(`outcome_confidence: ${formatValue(outcomeObservability.outcome_confidence)}`);
  }
  if (outcomeObservability?.outcome_evidence && !hasDiffPrefix("outcome_evidence:")) {
    addDiffLine(`outcome_evidence: ${formatOutcomeEvidence(outcomeObservability.outcome_evidence)}`);
  }
  if (outcomeObservability?.artifact_quality && !hasDiffPrefix("artifact_quality:")) {
    addDiffLine(`artifact_quality: ${outcomeObservability.artifact_quality}`);
  }
  if (typeof outcomeObservability?.retry_worthiness === "boolean" && !hasDiffPrefix("retry_worthiness:")) {
    addDiffLine(`retry_worthiness: ${outcomeObservability.retry_worthiness ? "true" : "false"}`);
  }
  if (outcomeObservability?.user_visible_completeness && !hasDiffPrefix("user_visible_completeness:")) {
    addDiffLine(`user_visible_completeness: ${outcomeObservability.user_visible_completeness}`);
  }
  if (advisorObservability.recommended_next_action && !hasDiffPrefix("advisor.recommended_next_action:")) {
    addDiffLine(`advisor.recommended_next_action: ${advisorObservability.recommended_next_action}`);
  }
  if (Array.isArray(advisorObservability.decision_reason_codes)
    && advisorObservability.decision_reason_codes.length > 0
    && !hasDiffPrefix("advisor.decision_reason_codes:")) {
    addDiffLine(`advisor.decision_reason_codes: ${formatAdvisorReasons(advisorObservability.decision_reason_codes)}`);
  }
  if (advisorObservability.decision_confidence && !hasDiffPrefix("advisor.decision_confidence:")) {
    addDiffLine(`advisor.decision_confidence: ${advisorObservability.decision_confidence}`);
  }
  if (advisorObservability.based_on_summary && !hasDiffPrefix("advisor_based_on_summary:")) {
    addDiffLine(`advisor_based_on_summary: ${advisorObservability.based_on_summary}`);
  }
  if (advisorObservability.alignment && !hasDiffPrefix("advisor_alignment:")) {
    addDiffLine(`advisor_alignment: ${formatAdvisorAlignment(advisorObservability.alignment)}`);
  }
  if (advisorObservability.alignment_summary && !hasDiffPrefix("advisor_alignment_summary:")) {
    addDiffLine(`advisor_alignment_summary: ${advisorObservability.alignment_summary}`);
  }
  if (promotionObservability.present) {
    if (promotionObservability.promoted_action && !hasDiffPrefix("decision_promotion.promoted_action:")) {
      addDiffLine(`decision_promotion.promoted_action: ${promotionObservability.promoted_action}`);
    }
    if (!hasDiffPrefix("decision_promotion.promotion_applied:")) {
      addDiffLine(`decision_promotion.promotion_applied: ${promotionObservability.promotion_applied ? "true" : "false"}`);
    }
    if (Array.isArray(promotionObservability.promotion_reason_codes)
      && promotionObservability.promotion_reason_codes.length > 0
      && !hasDiffPrefix("decision_promotion.promotion_reason_codes:")) {
      addDiffLine(`decision_promotion.promotion_reason_codes: ${formatValue(promotionObservability.promotion_reason_codes)}`);
    }
    if (!hasDiffPrefix("decision_promotion.safety_gate_passed:")) {
      addDiffLine(`decision_promotion.safety_gate_passed: ${promotionObservability.safety_gate_passed ? "true" : "false"}`);
    }
    if (promotionObservability.reroute_target && !hasDiffPrefix("decision_promotion.reroute_target:")) {
      addDiffLine(`decision_promotion.reroute_target: ${promotionObservability.reroute_target}`);
    }
    if (promotionObservability.reroute_reason && !hasDiffPrefix("decision_promotion.reroute_reason:")) {
      addDiffLine(`decision_promotion.reroute_reason: ${promotionObservability.reroute_reason}`);
    }
    if (promotionObservability.reroute_source && !hasDiffPrefix("decision_promotion.reroute_source:")) {
      addDiffLine(`decision_promotion.reroute_source: ${promotionObservability.reroute_source}`);
    }
    if (promotionObservability.summary && !hasDiffPrefix("decision_promotion_summary:")) {
      addDiffLine(`decision_promotion_summary: ${promotionObservability.summary}`);
    }
  }
  if (promotionPolicyObservability.present) {
    if (Array.isArray(promotionPolicyObservability.allowed_actions)
      && !hasDiffPrefix("promotion_policy.allowed_actions:")) {
      addDiffLine(`promotion_policy.allowed_actions: ${formatValue(promotionPolicyObservability.allowed_actions)}`);
    }
    if (Array.isArray(promotionPolicyObservability.rollback_disabled_actions)
      && !hasDiffPrefix("promotion_policy.rollback_disabled_actions:")) {
      addDiffLine(`promotion_policy.rollback_disabled_actions: ${formatValue(promotionPolicyObservability.rollback_disabled_actions)}`);
    }
    if (Number.isFinite(Number(promotionPolicyObservability.ineffective_threshold))
      && !hasDiffPrefix("promotion_policy.ineffective_threshold:")) {
      addDiffLine(`promotion_policy.ineffective_threshold: ${Number(promotionPolicyObservability.ineffective_threshold)}`);
    }
    if (promotionPolicyObservability.summary && !hasDiffPrefix("promotion_policy_summary:")) {
      addDiffLine(`promotion_policy_summary: ${promotionPolicyObservability.summary}`);
    }
  }
  if (promotionAuditObservability.present) {
    if (promotionAuditObservability.promoted_action && !hasDiffPrefix("promotion_audit.promoted_action:")) {
      addDiffLine(`promotion_audit.promoted_action: ${promotionAuditObservability.promoted_action}`);
    }
    if (promotionAuditObservability.promotion_effectiveness && !hasDiffPrefix("promotion_audit.promotion_effectiveness:")) {
      addDiffLine(`promotion_audit.promotion_effectiveness: ${promotionAuditObservability.promotion_effectiveness}`);
    }
    if (!hasDiffPrefix("promotion_audit.rollback_flag:")) {
      addDiffLine(`promotion_audit.rollback_flag: ${promotionAuditObservability.rollback_flag ? "true" : "false"}`);
    }
    if (promotionAuditObservability.summary && !hasDiffPrefix("promotion_audit_summary:")) {
      addDiffLine(`promotion_audit_summary: ${promotionAuditObservability.summary}`);
    }
  }
  if (decisionScoreboardObservability.present) {
    if (decisionScoreboardObservability.summary && !hasDiffPrefix("decision_scoreboard_summary:")) {
      addDiffLine(`decision_scoreboard_summary: ${decisionScoreboardObservability.summary}`);
    }
    if (!hasDiffPrefix("highest_maturity_actions:")) {
      addDiffLine(`highest_maturity_actions: ${formatValue(decisionScoreboardObservability.highest_maturity_actions)}`);
    }
    if (!hasDiffPrefix("rollback_disabled_actions:")) {
      addDiffLine(`rollback_disabled_actions: ${formatValue(decisionScoreboardObservability.rollback_disabled_actions)}`);
    }
  }
  if (normalizedObservability.resumed_from_waiting_user === true) {
    addDiffLine("resume: waiting_user");
  }
  if (normalizedObservability.resumed_from_retry === true) {
    addDiffLine("resume: retry");
  }

  return diffLines;
}

function buildTaskTraceText({
  memoryStage = "",
  snapshot = null,
  diffLines = [],
  readinessObservability = null,
} = {}) {
  const next = toSnapshot(snapshot);
  const slots = next.slot_state;
  const readiness = normalizeReadinessObservability(readinessObservability);
  const outcome = normalizeOutcomeObservability(readinessObservability, next);
  const advisor = normalizeAdvisorObservability(readinessObservability);
  const promotion = normalizeDecisionPromotionObservability(readinessObservability);
  const promotionPolicy = normalizePromotionPolicyObservability(readinessObservability);
  const promotionAudit = normalizePromotionAuditObservability(readinessObservability);
  const decisionScoreboard = normalizeDecisionScoreboardObservability(readinessObservability);
  const readinessInvalidArtifacts = summarizeReadinessArtifacts(readiness.invalid_artifacts);
  const readinessBlockedDependencies = summarizeBlockedDependencies(readiness.blocked_dependencies);
  const abandonedSummary = next.abandoned_task_hidden_count > 0
    ? `${formatValue(next.abandoned_task_ids)} (+${next.abandoned_task_hidden_count} more)`
    : formatValue(next.abandoned_task_ids);
  const lines = [
    `[task-trace] ${cleanText(memoryStage || "") || "unknown_stage"}`,
    `now: task_id=${formatValue(next.task_id)} | task_type=${formatValue(next.task_type)} | phase=${formatValue(next.task_phase)} | status=${formatValue(next.task_status)}`,
    `owner: current=${formatValue(next.current_owner_agent)} | previous=${formatValue(next.previous_owner_agent)} | handoff=${formatValue(next.handoff_reason)}`,
    `retry: count=${next.retry_count} | policy=${next.retry_policy.strategy} (max=${next.retry_policy.max_retries})`,
    `next_best_action: ${formatValue(next.next_best_action)}`,
    `plan: id=${formatValue(next.execution_plan.plan_id)} | status=${formatValue(next.execution_plan.plan_status)} | current_step=${formatValue(next.execution_plan.current_step)}`,
    `recovery: class=${formatValue(next.execution_plan.current_step_failure_class)} | policy=${formatValue(next.execution_plan.current_step_recovery_policy)} | action=${formatValue(next.execution_plan.current_step_recovery_action)} | attempts=${formatValue(next.execution_plan.current_step_recovery_attempt_count)} | rollback_target=${formatValue(next.execution_plan.current_step_rollback_target_step_id)}`,
    `outcome: status=${formatValue(outcome?.outcome_status || null)} | confidence=${formatValue(outcome?.outcome_confidence ?? null)} | evidence=${formatOutcomeEvidence(outcome?.outcome_evidence || null)} | artifact_quality=${formatValue(outcome?.artifact_quality || null)} | retry_worthiness=${formatValue(typeof outcome?.retry_worthiness === "boolean" ? outcome.retry_worthiness : null)} | user_visible=${formatValue(outcome?.user_visible_completeness || null)}`,
    `advisor: action=${formatValue(advisor.recommended_next_action)} | reasons=${formatAdvisorReasons(advisor.decision_reason_codes)} | confidence=${formatValue(advisor.decision_confidence)} | based_on=${formatValue(advisor.based_on_summary)} | alignment=${formatAdvisorAlignment(advisor.alignment)} | alignment_summary=${formatValue(advisor.alignment_summary)}`,
    `decision_promotion: promoted_action=${formatValue(promotion.promoted_action)} | promotion_applied=${formatValue(promotion.promotion_applied)} | reason_codes=${formatValue(promotion.promotion_reason_codes)} | safety_gate_passed=${formatValue(promotion.safety_gate_passed)} | previous_owner_agent=${formatValue(promotion.previous_owner_agent)} | current_owner_agent=${formatValue(promotion.current_owner_agent)} | reroute_target=${formatValue(promotion.reroute_target)} | reroute_reason=${formatValue(promotion.reroute_reason)} | reroute_source=${formatValue(promotion.reroute_source)} | summary=${formatValue(promotion.summary)}`,
    `promotion_policy: version=${formatValue(promotionPolicy.promotion_policy_version)} | allowed_actions=${formatValue(promotionPolicy.allowed_actions)} | rollback_disabled_actions=${formatValue(promotionPolicy.rollback_disabled_actions)} | ineffective_threshold=${formatValue(promotionPolicy.ineffective_threshold)} | summary=${formatValue(promotionPolicy.summary)}`,
    `promotion_audit: promoted_action=${formatValue(promotionAudit.promoted_action)} | promotion_effectiveness=${formatValue(promotionAudit.promotion_effectiveness)} | rollback_flag=${formatValue(promotionAudit.rollback_flag)} | summary=${formatValue(promotionAudit.summary)}`,
    `decision_scoreboard: highest_maturity_actions=${formatValue(decisionScoreboard.highest_maturity_actions)} | rollback_disabled_actions=${formatValue(decisionScoreboard.rollback_disabled_actions)} | summary=${formatValue(decisionScoreboard.summary)}`,
    `artifact: id=${formatValue(next.execution_plan.artifact_id)} | type=${formatValue(next.execution_plan.artifact_type)} | validity=${formatValue(next.execution_plan.validity_status)} | produced_by=${formatValue(next.execution_plan.produced_by_step_id)} | downstream=${formatValue(next.execution_plan.affected_downstream_steps)} | dependency=${formatValue(next.execution_plan.dependency_type)} | blocked_step=${formatValue(next.execution_plan.dependency_blocked_step)} | superseded=${formatValue(next.execution_plan.artifact_superseded)}`,
    `readiness: is_ready=${formatValue(readiness.is_ready)} | reasons=${formatValue(readiness.blocking_reason_codes)} | missing_slots=${formatValue(readiness.missing_slots)} | invalid_artifacts=${formatValue(readinessInvalidArtifacts)} | blocked_dependencies=${formatValue(readinessBlockedDependencies)} | owner_ready=${formatValue(readiness.owner_ready)} | recovery_ready=${formatValue(readiness.recovery_ready)} | recommended_action=${formatValue(readiness.recommended_action)}`,
    `slot_state: missing=${formatValue(slots.missing)} | filled=${formatValue(slots.filled)} | invalid=${formatValue(slots.invalid)}`,
    `abandoned_task_ids: ${abandonedSummary}`,
  ];
  if (Array.isArray(diffLines) && diffLines.length > 0) {
    lines.push("diff:");
    for (const line of diffLines) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push("diff: no_change");
  }
  return lines.join("\n");
}

export function buildPlannerTaskTraceDiagnostics({
  memoryStage = "",
  memorySnapshot = null,
  previousMemorySnapshot = null,
  observability = null,
} = {}) {
  const snapshot = toSnapshot(memorySnapshot);
  const readinessObservability = normalizeReadinessObservability(observability);
  const outcomeObservability = normalizeOutcomeObservability(observability, snapshot);
  const advisorObservability = normalizeAdvisorObservability(observability);
  const promotionObservability = normalizeDecisionPromotionObservability(observability);
  const promotionPolicyObservability = normalizePromotionPolicyObservability(observability);
  const promotionAuditObservability = normalizePromotionAuditObservability(observability);
  const decisionScoreboardObservability = normalizeDecisionScoreboardObservability(observability);
  const readinessInvalidArtifacts = summarizeReadinessArtifacts(readinessObservability.invalid_artifacts);
  const readinessBlockedDependencies = summarizeBlockedDependencies(readinessObservability.blocked_dependencies);
  const diff = buildDiffLines({
    previousSnapshot: previousMemorySnapshot,
    nextSnapshot: memorySnapshot,
    observability,
  });
  const summary = `task=${formatValue(snapshot.task_id)} phase=${snapshot.task_phase} status=${snapshot.task_status} owner=${formatValue(snapshot.current_owner_agent)} plan=${formatValue(snapshot.execution_plan.plan_status)}:${formatValue(snapshot.execution_plan.current_step)} recovery=${formatValue(snapshot.execution_plan.current_step_recovery_action)} readiness=${formatValue(readinessObservability.is_ready)}:${formatValue(readinessObservability.recommended_action)} outcome=${formatValue(outcomeObservability?.outcome_status || null)}:${formatValue(outcomeObservability?.retry_worthiness)} advisor=${formatValue(advisorObservability.recommended_next_action)}:${formatValue(advisorObservability.decision_confidence)} advisor_alignment=${formatAdvisorAlignment(advisorObservability.alignment)} decision_promotion=${formatValue(promotionObservability.promoted_action)}:${formatValue(promotionObservability.promotion_applied)}:${formatValue(promotionObservability.safety_gate_passed)}:${formatValue(promotionObservability.reroute_target)}:${formatValue(promotionObservability.reroute_reason)} promotion_policy=${formatValue(promotionPolicyObservability.allowed_actions)}:${formatValue(promotionPolicyObservability.rollback_disabled_actions)}:${formatValue(promotionPolicyObservability.ineffective_threshold)} promotion_audit=${formatValue(promotionAuditObservability.promoted_action)}:${formatValue(promotionAuditObservability.promotion_effectiveness)}:${formatValue(promotionAuditObservability.rollback_flag)} decision_scoreboard=${formatValue(decisionScoreboardObservability.highest_maturity_actions)}:${formatValue(decisionScoreboardObservability.rollback_disabled_actions)} artifact=${formatValue(snapshot.execution_plan.artifact_id)}:${formatValue(snapshot.execution_plan.validity_status)} next=${formatValue(snapshot.next_best_action)}`;
  return {
    summary,
    snapshot: {
      task_id: snapshot.task_id,
      task_type: snapshot.task_type,
      task_phase: snapshot.task_phase,
      task_status: snapshot.task_status,
      current_owner_agent: snapshot.current_owner_agent,
      previous_owner_agent: snapshot.previous_owner_agent,
      handoff_reason: snapshot.handoff_reason,
      retry_count: snapshot.retry_count,
      retry_policy: snapshot.retry_policy,
      next_best_action: snapshot.next_best_action,
      execution_plan: snapshot.execution_plan,
      readiness: {
        is_ready: readinessObservability.is_ready,
        blocking_reason_codes: readinessObservability.blocking_reason_codes,
        missing_slots: readinessObservability.missing_slots,
        invalid_artifacts: readinessInvalidArtifacts,
        blocked_dependencies: readinessBlockedDependencies,
        owner_ready: readinessObservability.owner_ready,
        recovery_ready: readinessObservability.recovery_ready,
        recommended_action: readinessObservability.recommended_action,
      },
      outcome: outcomeObservability
        ? {
            outcome_status: outcomeObservability.outcome_status,
            outcome_confidence: outcomeObservability.outcome_confidence,
            outcome_evidence: outcomeObservability.outcome_evidence,
            artifact_quality: outcomeObservability.artifact_quality,
            retry_worthiness: outcomeObservability.retry_worthiness,
            user_visible_completeness: outcomeObservability.user_visible_completeness,
          }
        : null,
      advisor: advisorObservability.recommended_next_action
        ? {
            recommended_next_action: advisorObservability.recommended_next_action,
            decision_reason_codes: advisorObservability.decision_reason_codes,
            decision_confidence: advisorObservability.decision_confidence,
            advisor_version: advisorObservability.advisor_version,
            based_on: advisorObservability.based_on,
          }
        : null,
      advisor_based_on_summary: advisorObservability.based_on_summary,
      advisor_alignment: advisorObservability.alignment,
      advisor_alignment_summary: advisorObservability.alignment_summary,
      advisor_vs_actual: advisorObservability.alignment,
      decision_promotion: {
        promoted_action: promotionObservability.promoted_action,
        promotion_applied: promotionObservability.promotion_applied,
        promotion_reason_codes: promotionObservability.promotion_reason_codes,
        promotion_confidence: promotionObservability.promotion_confidence,
        safety_gate_passed: promotionObservability.safety_gate_passed,
        previous_owner_agent: promotionObservability.previous_owner_agent,
        current_owner_agent: promotionObservability.current_owner_agent,
        reroute_target: promotionObservability.reroute_target,
        reroute_reason: promotionObservability.reroute_reason,
        reroute_source: promotionObservability.reroute_source,
        reroute_target_verified: promotionObservability.reroute_target_verified,
        promotion_version: promotionObservability.promotion_version,
      },
      decision_promotion_summary: promotionObservability.summary,
      promotion_policy: {
        promotion_policy_version: promotionPolicyObservability.promotion_policy_version,
        allowed_actions: promotionPolicyObservability.allowed_actions,
        denied_actions: promotionPolicyObservability.denied_actions,
        rollback_disabled_actions: promotionPolicyObservability.rollback_disabled_actions,
        ineffective_threshold: promotionPolicyObservability.ineffective_threshold,
        policy_reason_codes: promotionPolicyObservability.policy_reason_codes,
        policy_fail_closed: promotionPolicyObservability.policy_fail_closed,
      },
      promotion_policy_summary: promotionPolicyObservability.summary,
      promotion_audit: {
        promotion_audit_id: promotionAuditObservability.promotion_audit_id,
        promoted_action: promotionAuditObservability.promoted_action,
        promotion_applied: promotionAuditObservability.promotion_applied,
        promotion_effectiveness: promotionAuditObservability.promotion_effectiveness,
        rollback_flag: promotionAuditObservability.rollback_flag,
        audit_version: promotionAuditObservability.audit_version,
        promotion_outcome: promotionAuditObservability.promotion_outcome,
      },
      promotion_audit_summary: promotionAuditObservability.summary,
      decision_scoreboard: decisionScoreboardObservability.scoreboard,
      decision_scoreboard_summary: decisionScoreboardObservability.summary,
      highest_maturity_actions: decisionScoreboardObservability.highest_maturity_actions,
      rollback_disabled_actions: decisionScoreboardObservability.rollback_disabled_actions,
      slot_state: snapshot.slot_state,
      abandoned_task_ids: snapshot.abandoned_task_ids,
      abandoned_task_total: snapshot.abandoned_task_total,
    },
    diff,
    text: buildTaskTraceText({
      memoryStage,
      snapshot: memorySnapshot,
      diffLines: diff,
      readinessObservability: observability,
    }),
    event_alignment: {
      memory_snapshot: Boolean(memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)),
      task_phase_transition: Boolean(cleanText(observability?.task_phase_transition || "")),
      agent_handoff: Boolean(observability?.agent_handoff && typeof observability.agent_handoff === "object"),
      retry_attempt: Boolean(observability?.retry_attempt && typeof observability.retry_attempt === "object"),
      step_transition: Boolean(observability?.step_transition && typeof observability.step_transition === "object"),
      plan_invalidated: Boolean(observability?.plan_invalidated && typeof observability.plan_invalidated === "object"),
      failure_class: Boolean(cleanText(observability?.failure_class || "")),
      recovery_policy: Boolean(cleanText(observability?.recovery_policy || "")),
      recovery_action: Boolean(cleanText(observability?.recovery_action || "")),
      rollback_target_step_id: Boolean(cleanText(observability?.rollback_target_step_id || "")),
      skipped_step_ids: Array.isArray(observability?.skipped_step_ids) && observability.skipped_step_ids.length > 0,
      artifact_id: Boolean(cleanText(observability?.artifact_id || "")),
      artifact_type: Boolean(cleanText(observability?.artifact_type || "")),
      validity_status: Boolean(cleanText(observability?.validity_status || "")),
      produced_by_step_id: Boolean(cleanText(observability?.produced_by_step_id || "")),
      affected_downstream_steps: Array.isArray(observability?.affected_downstream_steps)
        && observability.affected_downstream_steps.length > 0,
      dependency_type: Boolean(cleanText(observability?.dependency_type || "")),
      artifact_superseded: observability?.artifact_superseded === true,
      dependency_blocked_step: Boolean(cleanText(observability?.dependency_blocked_step || "")),
      readiness_is_ready: typeof readinessObservability.is_ready === "boolean",
      blocking_reason_codes: Array.isArray(readinessObservability.blocking_reason_codes)
        && readinessObservability.blocking_reason_codes.length > 0,
      missing_slots: Array.isArray(readinessObservability.missing_slots)
        && readinessObservability.missing_slots.length > 0,
      invalid_artifacts: readinessInvalidArtifacts.length > 0,
      blocked_dependencies: readinessBlockedDependencies.length > 0,
      owner_ready: typeof readinessObservability.owner_ready === "boolean",
      recovery_ready: typeof readinessObservability.recovery_ready === "boolean",
      recommended_action: Boolean(cleanText(readinessObservability.recommended_action || "")),
      outcome_status: Boolean(cleanText(outcomeObservability?.outcome_status || "")),
      outcome_confidence: outcomeObservability?.outcome_confidence !== null && outcomeObservability?.outcome_confidence !== undefined,
      outcome_evidence: Boolean(outcomeObservability?.outcome_evidence),
      artifact_quality: Boolean(cleanText(outcomeObservability?.artifact_quality || "")),
      retry_worthiness: typeof outcomeObservability?.retry_worthiness === "boolean",
      user_visible_completeness: Boolean(cleanText(outcomeObservability?.user_visible_completeness || "")),
      advisor_recommended_next_action: Boolean(cleanText(advisorObservability.recommended_next_action || "")),
      advisor_decision_reason_codes: Array.isArray(advisorObservability.decision_reason_codes)
        && advisorObservability.decision_reason_codes.length > 0,
      advisor_decision_confidence: Boolean(cleanText(advisorObservability.decision_confidence || "")),
      advisor_based_on_summary: Boolean(cleanText(advisorObservability.based_on_summary || "")),
      advisor_alignment: Boolean(advisorObservability.alignment),
      advisor_alignment_is_aligned: typeof advisorObservability.alignment?.is_aligned === "boolean",
      advisor_alignment_type: Boolean(cleanText(advisorObservability.alignment?.alignment_type || "")),
      advisor_alignment_divergence_reason_codes: Array.isArray(advisorObservability.alignment?.divergence_reason_codes)
        && advisorObservability.alignment.divergence_reason_codes.length > 0,
      advisor_alignment_promotion_candidate: typeof advisorObservability.alignment?.promotion_candidate === "boolean",
      advisor_alignment_summary: Boolean(cleanText(advisorObservability.alignment_summary || "")),
      advisor_vs_actual: Boolean(advisorObservability.alignment),
      decision_promotion: Boolean(observability?.decision_promotion && typeof observability.decision_promotion === "object"),
      decision_promotion_promoted_action: Boolean(cleanText(observability?.decision_promotion?.promoted_action || "")),
      decision_promotion_applied: typeof observability?.decision_promotion?.promotion_applied === "boolean",
      decision_promotion_reason_codes: Array.isArray(observability?.decision_promotion?.promotion_reason_codes)
        && observability.decision_promotion.promotion_reason_codes.length > 0,
      decision_promotion_safety_gate_passed: typeof observability?.decision_promotion?.safety_gate_passed === "boolean",
      decision_promotion_reroute_target: Boolean(cleanText(observability?.decision_promotion?.reroute_target || "")),
      decision_promotion_reroute_reason: Boolean(cleanText(observability?.decision_promotion?.reroute_reason || "")),
      decision_promotion_reroute_source: Boolean(cleanText(observability?.decision_promotion?.reroute_source || "")),
      decision_promotion_reroute_target_verified: typeof observability?.decision_promotion?.reroute_target_verified === "boolean",
      decision_promotion_summary: Boolean(cleanText(observability?.decision_promotion_summary || "")),
      promotion_policy: Boolean(observability?.promotion_policy && typeof observability.promotion_policy === "object"),
      promotion_policy_allowed_actions: Array.isArray(observability?.promotion_policy?.allowed_actions),
      promotion_policy_rollback_disabled_actions: Array.isArray(observability?.promotion_policy?.rollback_disabled_actions),
      promotion_policy_ineffective_threshold: Number.isFinite(Number(observability?.promotion_policy?.ineffective_threshold)),
      promotion_policy_summary: Boolean(cleanText(observability?.promotion_policy_summary || "")),
      promotion_audit: Boolean(observability?.promotion_audit && typeof observability.promotion_audit === "object"),
      promotion_audit_promoted_action: Boolean(cleanText(observability?.promotion_audit?.promoted_action || "")),
      promotion_audit_effectiveness: Boolean(cleanText(observability?.promotion_audit?.promotion_effectiveness || "")),
      promotion_audit_rollback_flag: typeof observability?.promotion_audit?.rollback_flag === "boolean",
      promotion_audit_summary: Boolean(cleanText(observability?.promotion_audit_summary || "")),
      decision_scoreboard: Boolean(observability?.decision_scoreboard && typeof observability.decision_scoreboard === "object"),
      decision_scoreboard_summary: Boolean(cleanText(observability?.decision_scoreboard_summary || "")),
      highest_maturity_actions: Array.isArray(observability?.highest_maturity_actions),
      rollback_disabled_actions: Array.isArray(observability?.rollback_disabled_actions),
      resumed_from_waiting_user: observability?.resumed_from_waiting_user === true,
      resumed_from_retry: observability?.resumed_from_retry === true,
    },
  };
}
