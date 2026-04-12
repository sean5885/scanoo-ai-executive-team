import { cleanText } from "./message-intent-utils.mjs";
import {
  evaluateAdvisorAlignment,
} from "./advisor-alignment-evaluator.mjs";

export const STEP_DECISION_ADVISOR_VERSION = "step_decision_advisor_v1";

export const STEP_DECISION_ADVISOR_ACTIONS = Object.freeze([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);

export const STEP_DECISION_ADVISOR_REASON_CODES = Object.freeze([
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
]);

export const STEP_DECISION_ADVISOR_CONFIDENCE_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
]);

const RECOVERY_ACTION_TO_DECISION = Object.freeze({
  retry_same_step: "retry",
  reroute_owner: "reroute",
  rollback_to_step: "rollback",
  skip_step: "skip",
  ask_user: "ask_user",
  failed: "fail",
});

function toObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toArray(value = null) {
  return Array.isArray(value)
    ? value
    : [];
}

function uniqueStrings(items = []) {
  return Array.from(new Set(
    toArray(items).map((item) => cleanText(item)).filter(Boolean),
  ));
}

function normalizeDecisionAction(value = "") {
  const normalized = cleanText(value || "");
  return STEP_DECISION_ADVISOR_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function normalizeConfidence(value = "") {
  const normalized = cleanText(value || "");
  return STEP_DECISION_ADVISOR_CONFIDENCE_LEVELS.includes(normalized)
    ? normalized
    : "low";
}

function normalizeReasonCodes(reasonCodes = []) {
  return uniqueStrings(reasonCodes)
    .filter((code) => STEP_DECISION_ADVISOR_REASON_CODES.includes(code));
}

function normalizeReadinessSummary(readiness = null) {
  const normalized = toObject(readiness) || {};
  return {
    is_ready: typeof normalized.is_ready === "boolean"
      ? normalized.is_ready
      : null,
    blocking_reason_codes: uniqueStrings(normalized.blocking_reason_codes),
    missing_slots: uniqueStrings(normalized.missing_slots),
    invalid_artifacts: toArray(normalized.invalid_artifacts)
      .filter((item) => toObject(item))
      .map((item) => ({
        artifact_id: cleanText(item.artifact_id || "") || null,
        validity_status: cleanText(item.validity_status || "") || null,
        blocked_step_id: cleanText(item.blocked_step_id || "") || null,
        rollback_target_step_id: cleanText(item.rollback_target_step_id || "") || null,
      })),
    blocked_dependencies: toArray(normalized.blocked_dependencies)
      .filter((item) => toObject(item))
      .map((item) => ({
        step_id: cleanText(item.step_id || "") || null,
        status: cleanText(item.status || "") || null,
      })),
    owner_ready: typeof normalized.owner_ready === "boolean"
      ? normalized.owner_ready
      : null,
    recovery_ready: typeof normalized.recovery_ready === "boolean"
      ? normalized.recovery_ready
      : null,
    recommended_action: normalizeDecisionAction(normalized.recommended_action),
  };
}

function normalizeOutcomeSummary(outcome = null) {
  const normalized = toObject(outcome) || {};
  const evidence = toObject(normalized.outcome_evidence) || {};
  return {
    outcome_status: cleanText(normalized.outcome_status || "") || null,
    outcome_confidence: normalized.outcome_confidence ?? null,
    retry_worthiness: typeof normalized.retry_worthiness === "boolean"
      ? normalized.retry_worthiness
      : null,
    artifact_quality: cleanText(normalized.artifact_quality || "") || null,
    user_visible_completeness: cleanText(normalized.user_visible_completeness || "") || null,
    errors_encountered: uniqueStrings(evidence.errors_encountered),
    recovery_actions_taken: uniqueStrings(evidence.recovery_actions_taken),
  };
}

function normalizeRecoverySummary(recovery = null) {
  const normalized = toObject(recovery) || {};
  const recoveryAction = cleanText(normalized.recovery_action || "") || null;
  const recoveryPolicy = cleanText(normalized.recovery_policy || "") || null;
  const rollbackTargetStepId = cleanText(normalized.rollback_target_step_id || "") || null;
  const recoveryAttemptCount = Number.isFinite(Number(normalized.recovery_attempt_count))
    ? Number(normalized.recovery_attempt_count)
    : 0;
  const retryBudgetMax = Number.isFinite(Number(
    normalized.retry_budget_max
      ?? normalized.max_retries
      ?? normalized.retry_budget_limit
      ?? normalized.retry_budget_total,
  ))
    ? Math.max(0, Number(
      normalized.retry_budget_max
        ?? normalized.max_retries
        ?? normalized.retry_budget_limit
        ?? normalized.retry_budget_total,
    ))
    : null;
  const retryBudgetRemaining = Number.isFinite(Number(normalized.retry_budget_remaining))
    ? Math.max(0, Number(normalized.retry_budget_remaining))
    : (retryBudgetMax !== null
      ? Math.max(0, retryBudgetMax - recoveryAttemptCount)
      : null);
  const retryAllowed = typeof normalized.retry_allowed === "boolean"
    ? normalized.retry_allowed
    : true;
  const skipAllowed = typeof normalized.skip_allowed === "boolean"
    ? normalized.skip_allowed
    : recoveryAction === "skip_step" || recoveryPolicy === "skip_step";
  const recoveryFailed = recoveryAction === "failed" || recoveryPolicy === "failed";
  return {
    recovery_action: recoveryAction,
    recovery_policy: recoveryPolicy,
    recovery_attempt_count: recoveryAttemptCount,
    rollback_target_step_id: rollbackTargetStepId,
    retry_allowed: retryAllowed,
    retry_budget_max: retryBudgetMax,
    retry_budget_remaining: retryBudgetRemaining,
    retry_budget_exhausted: normalized.retry_budget_exhausted === true
      || (retryBudgetRemaining !== null && retryBudgetRemaining <= 0)
      || retryAllowed === false,
    skip_allowed: skipAllowed,
    rollback_available: Boolean(rollbackTargetStepId) || normalized.rollback_available === true,
    continuation_allowed: normalized.continuation_allowed === false
      ? false
      : !recoveryFailed,
    recovery_failed: recoveryFailed,
  };
}

function normalizeArtifactSummary(artifact = null) {
  const normalized = toObject(artifact) || {};
  const invalidArtifacts = toArray(normalized.invalid_artifacts)
    .filter((item) => toObject(item));
  return {
    artifact_id: cleanText(normalized.artifact_id || "") || null,
    artifact_type: cleanText(normalized.artifact_type || "") || null,
    validity_status: cleanText(normalized.validity_status || "") || null,
    dependency_type: cleanText(normalized.dependency_type || "") || null,
    dependency_blocked_step: cleanText(normalized.dependency_blocked_step || "") || null,
    invalid_artifact_count: invalidArtifacts.length,
    blocked_dependency_count: Number.isFinite(Number(normalized.blocked_dependency_count))
      ? Number(normalized.blocked_dependency_count)
      : 0,
    dependencies_allow_skip: normalized.dependencies_allow_skip === false
      ? false
      : true,
  };
}

function normalizeTaskPlanSummary(taskPlan = null) {
  const normalized = toObject(taskPlan) || {};
  return {
    task_id: cleanText(normalized.task_id || "") || null,
    plan_id: cleanText(normalized.plan_id || "") || null,
    plan_status: cleanText(normalized.plan_status || "") || null,
    current_step_id: cleanText(normalized.current_step_id || "") || null,
    current_step_status: cleanText(normalized.current_step_status || "") || null,
    failure_class: cleanText(normalized.failure_class || "") || null,
    step_retryable: typeof normalized.step_retryable === "boolean"
      ? normalized.step_retryable
      : true,
    step_non_critical: normalized.step_non_critical === true,
    malformed_input: normalized.malformed_input === true,
  };
}

function hasBlockingReason(readinessSummary = null, reason = "") {
  if (!readinessSummary || typeof readinessSummary !== "object") {
    return false;
  }
  return uniqueStrings(readinessSummary.blocking_reason_codes).includes(cleanText(reason || ""));
}

function buildAdvisorBasedOn({
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
} = {}) {
  return {
    readiness_summary: normalizeReadinessSummary(readiness),
    outcome_summary: normalizeOutcomeSummary(outcome),
    recovery_summary: normalizeRecoverySummary(recovery),
    artifact_summary: normalizeArtifactSummary(artifact),
    task_plan_summary: normalizeTaskPlanSummary(task_plan),
  };
}

function resolveDecisionConfidence({
  action = "fail",
  reasonCodes = [],
  malformed = false,
} = {}) {
  if (malformed) {
    return "low";
  }
  const normalizedAction = normalizeDecisionAction(action) || "fail";
  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  if (normalizedAction === "ask_user"
    && normalizedReasonCodes.includes("outcome_partial")
    && !normalizedReasonCodes.includes("missing_slot_block")) {
    return "medium";
  }
  if (normalizedAction === "fail"
    && !normalizedReasonCodes.some((code) =>
      code === "plan_invalidated"
      || code === "recovery_failed"
      || code === "outcome_failed"
      || code === "blocked_dependency")) {
    return "low";
  }
  return "high";
}

function buildDecisionResult({
  action = "fail",
  reasonCodes = [],
  basedOn = null,
  malformed = false,
} = {}) {
  const normalizedAction = normalizeDecisionAction(action) || "fail";
  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  const confidence = resolveDecisionConfidence({
    action: normalizedAction,
    reasonCodes: normalizedReasonCodes,
    malformed,
  });
  return {
    recommended_next_action: normalizedAction,
    decision_reason_codes: normalizedReasonCodes,
    decision_confidence: normalizeConfidence(confidence),
    based_on: basedOn || buildAdvisorBasedOn(),
    advisor_version: STEP_DECISION_ADVISOR_VERSION,
  };
}

function resolveOutcomeReasonCode(outcomeStatus = "") {
  const normalized = cleanText(outcomeStatus || "");
  if (normalized === "success") {
    return "outcome_success";
  }
  if (normalized === "partial") {
    return "outcome_partial";
  }
  if (normalized === "failed" || normalized === "blocked") {
    return "outcome_failed";
  }
  return null;
}

function resolvePartialFallbackAction({
  basedOn = null,
  hasMissingSlotBlock = false,
  hasRetryWorthy = false,
  retryAllowed = false,
} = {}) {
  if (!basedOn || typeof basedOn !== "object") {
    return "ask_user";
  }
  if (hasRetryWorthy && retryAllowed) {
    return "retry";
  }
  if (hasMissingSlotBlock) {
    return "ask_user";
  }
  const outcomeErrors = uniqueStrings(basedOn.outcome_summary?.errors_encountered);
  if (outcomeErrors.includes("missing_slot")) {
    return "ask_user";
  }
  return "ask_user";
}

export function adviseStepNextAction({
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
} = {}) {
  const basedOn = buildAdvisorBasedOn({
    readiness,
    outcome,
    recovery,
    artifact,
    task_plan,
  });

  const readinessSummary = basedOn.readiness_summary;
  const outcomeSummary = basedOn.outcome_summary;
  const recoverySummary = basedOn.recovery_summary;
  const artifactSummary = basedOn.artifact_summary;
  const taskPlanSummary = basedOn.task_plan_summary;

  const malformed = taskPlanSummary.malformed_input === true
    || (toObject(readiness) === null && toObject(outcome) === null && toObject(recovery) === null && toObject(task_plan) === null);

  const reasonCodes = [];
  const pushReason = (code = "") => {
    const normalized = cleanText(code || "");
    if (!normalized || !STEP_DECISION_ADVISOR_REASON_CODES.includes(normalized) || reasonCodes.includes(normalized)) {
      return;
    }
    reasonCodes.push(normalized);
  };

  const outcomeReasonCode = resolveOutcomeReasonCode(outcomeSummary.outcome_status);
  if (outcomeReasonCode) {
    pushReason(outcomeReasonCode);
  }

  const hasMissingSlotBlock = hasBlockingReason(readinessSummary, "missing_slot");
  const hasInvalidArtifactBlock = hasBlockingReason(readinessSummary, "invalid_artifact")
    || cleanText(artifactSummary.validity_status || "") === "invalid";
  const hasBlockedDependency = hasBlockingReason(readinessSummary, "blocked_dependency")
    || artifactSummary.blocked_dependency_count > 0;
  const hasOwnerMismatch = hasBlockingReason(readinessSummary, "owner_mismatch")
    || cleanText(taskPlanSummary.failure_class || "") === "capability_gap";
  const hasRetryWorthy = outcomeSummary.retry_worthiness === true;
  const hasRecoveryFailed = recoverySummary.recovery_failed === true || recoverySummary.continuation_allowed === false;
  const hasRollbackAvailable = recoverySummary.rollback_available === true;
  const hasSkipAllowed = recoverySummary.skip_allowed === true && artifactSummary.dependencies_allow_skip !== false;
  const hasPlanInvalidated = hasBlockingReason(readinessSummary, "plan_invalidated")
    || hasBlockingReason(readinessSummary, "malformed_plan_state")
    || cleanText(taskPlanSummary.plan_status || "") === "invalidated";
  const retryAllowed = recoverySummary.retry_allowed !== false
    && taskPlanSummary.step_retryable !== false
    && recoverySummary.continuation_allowed !== false;

  if (readinessSummary.is_ready === true) {
    pushReason("step_ready");
  }
  if (hasMissingSlotBlock) {
    pushReason("missing_slot_block");
  }
  if (hasInvalidArtifactBlock) {
    pushReason("invalid_artifact_block");
  }
  if (hasBlockedDependency) {
    pushReason("blocked_dependency");
  }
  if (hasOwnerMismatch) {
    pushReason("owner_mismatch");
  }
  if (hasRetryWorthy) {
    pushReason("retry_worthy");
  }
  if (hasRecoveryFailed) {
    pushReason("recovery_failed");
  }
  if (hasRollbackAvailable) {
    pushReason("rollback_available");
  }
  if (hasSkipAllowed) {
    pushReason("skip_allowed");
  }
  if (hasPlanInvalidated || malformed) {
    pushReason("plan_invalidated");
  }

  // Rule 7
  if (hasPlanInvalidated || malformed || hasRecoveryFailed) {
    return buildDecisionResult({
      action: "fail",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 1
  if (readinessSummary.is_ready === true && outcomeSummary.outcome_status === "success") {
    return buildDecisionResult({
      action: "proceed",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  if (outcomeSummary.outcome_status === "success"
    && !hasMissingSlotBlock
    && !hasInvalidArtifactBlock
    && !hasBlockedDependency
    && !hasOwnerMismatch) {
    return buildDecisionResult({
      action: "proceed",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 2
  if (readinessSummary.is_ready === false && hasMissingSlotBlock) {
    return buildDecisionResult({
      action: "ask_user",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 3
  if (hasRetryWorthy && retryAllowed) {
    return buildDecisionResult({
      action: "retry",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 4
  if (hasOwnerMismatch) {
    return buildDecisionResult({
      action: "reroute",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 5
  if (hasInvalidArtifactBlock && hasRollbackAvailable) {
    return buildDecisionResult({
      action: "rollback",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 6
  if (hasSkipAllowed && !hasBlockedDependency) {
    return buildDecisionResult({
      action: "skip",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  // Rule 8
  if (outcomeSummary.outcome_status === "partial") {
    const partialAction = resolvePartialFallbackAction({
      basedOn,
      hasMissingSlotBlock,
      hasRetryWorthy,
      retryAllowed,
    });
    return buildDecisionResult({
      action: partialAction,
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  if (outcomeSummary.outcome_status === "failed" || outcomeSummary.outcome_status === "blocked") {
    return buildDecisionResult({
      action: "fail",
      reasonCodes,
      basedOn,
      malformed,
    });
  }

  const fallbackAction = normalizeDecisionAction(readinessSummary.recommended_action)
    || (readinessSummary.is_ready === false ? "ask_user" : "fail");
  return buildDecisionResult({
    action: fallbackAction,
    reasonCodes,
    basedOn,
    malformed,
  });
}

export function formatStepDecisionAdvisorBasedOnSummary(basedOn = null) {
  const normalized = toObject(basedOn) || {};
  const readiness = toObject(normalized.readiness_summary) || {};
  const outcome = toObject(normalized.outcome_summary) || {};
  const recovery = toObject(normalized.recovery_summary) || {};
  const artifact = toObject(normalized.artifact_summary) || {};
  const taskPlan = toObject(normalized.task_plan_summary) || {};
  const readinessReasonCodes = uniqueStrings(readiness.blocking_reason_codes);
  const outcomeErrors = uniqueStrings(outcome.errors_encountered);
  return [
    `readiness=${typeof readiness.is_ready === "boolean" ? readiness.is_ready : "unknown"}`,
    `reasons=${readinessReasonCodes.length > 0 ? readinessReasonCodes.join("|") : "none"}`,
    `outcome=${cleanText(outcome.outcome_status || "") || "unknown"}`,
    `retry_worthy=${typeof outcome.retry_worthiness === "boolean" ? outcome.retry_worthiness : "unknown"}`,
    `outcome_errors=${outcomeErrors.length > 0 ? outcomeErrors.join("|") : "none"}`,
    `recovery=${cleanText(recovery.recovery_action || recovery.recovery_policy || "") || "none"}`,
    `rollback_target=${cleanText(recovery.rollback_target_step_id || "") || "none"}`,
    `artifact=${cleanText(artifact.artifact_id || "") || "none"}:${cleanText(artifact.validity_status || "") || "none"}`,
    `plan=${cleanText(taskPlan.plan_status || "") || "none"}:${cleanText(taskPlan.current_step_id || "") || "none"}`,
  ].join(" ; ");
}

export function resolveStepDecisionAdvisorActualAction({
  selected_action = "",
  recovery_action = "",
  task_phase = "",
  task_status = "",
  routing_locked = false,
  stop_error = "",
} = {}) {
  const normalizedRecoveryAction = cleanText(recovery_action || "");
  if (normalizedRecoveryAction && RECOVERY_ACTION_TO_DECISION[normalizedRecoveryAction]) {
    return RECOVERY_ACTION_TO_DECISION[normalizedRecoveryAction];
  }
  if (cleanText(selected_action || "")) {
    return "proceed";
  }
  const normalizedTaskStatus = cleanText(task_status || "");
  const normalizedTaskPhase = cleanText(task_phase || "");
  if (normalizedTaskStatus === "failed" || cleanText(stop_error || "")) {
    return "fail";
  }
  if (normalizedTaskStatus === "blocked" || normalizedTaskPhase === "waiting_user") {
    return "ask_user";
  }
  if (routing_locked === true) {
    return "fail";
  }
  return null;
}

export function buildStepDecisionAdvisorComparison({
  decision = null,
  actual_next_action = "",
  alignment_context = null,
} = {}) {
  const normalizedDecision = toObject(decision) || {};
  const recommendedAction = normalizeDecisionAction(normalizedDecision.recommended_next_action);
  const actualAction = normalizeDecisionAction(actual_next_action);
  const normalizedAlignmentContext = toObject(alignment_context) || {};
  const alignment = evaluateAdvisorAlignment({
    advisor_action: recommendedAction,
    actual_action: actualAction,
    readiness: toObject(normalizedAlignmentContext.readiness),
    outcome: toObject(normalizedAlignmentContext.outcome),
    recovery: toObject(normalizedAlignmentContext.recovery),
    routing_overrode_advisor: normalizedAlignmentContext.routing_overrode_advisor === true,
    recovery_overrode_advisor: normalizedAlignmentContext.recovery_overrode_advisor === true,
    malformed_input: normalizedAlignmentContext.malformed_input === true,
    evidence_complete: typeof normalizedAlignmentContext.evidence_complete === "boolean"
      ? normalizedAlignmentContext.evidence_complete
      : null,
  });
  return {
    ...alignment,
    recommended_next_action: alignment.advisor_action,
    actual_next_action: alignment.actual_action,
  };
}
