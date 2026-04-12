import { cleanText } from "./message-intent-utils.mjs";
import {
  PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS,
  PROMOTION_CONTROL_SURFACE_ALL_ACTIONS,
  PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
  resolvePromotionActionPolicy,
  resolvePromotionControlSurface,
} from "./promotion-control-surface.mjs";

export const DECISION_ENGINE_PROMOTION_VERSION = "decision_engine_promotion_v1";
export const DECISION_ENGINE_PROMOTION_AUDIT_VERSION = "decision_engine_promotion_audit_v1";
export const DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD = PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD;
export const DECISION_ENGINE_PROMOTION_ROLLBACK_REASON_CODE = "promotion_rollback_gate_active";
export const DECISION_ENGINE_PROMOTION_EFFECTIVENESS = Object.freeze([
  "effective",
  "ineffective",
  "unknown",
]);

export const DECISION_ENGINE_PROMOTABLE_ACTIONS = PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS;

export const DECISION_ENGINE_PROMOTION_REASON_CODES = Object.freeze([
  "missing_advisor_action",
  "unsupported_advisor_action",
  "promotion_denied_by_policy",
  "promotion_disabled_by_rollback_flag",
  "promotion_policy_fail_closed",
  "alignment_not_exact_match",
  "alignment_not_promotion_candidate",
  "evidence_incomplete",
  "malformed_or_unknown_signals",
  "conflicting_signals",
  "ask_user_signals_missing",
  "fail_signals_missing",
  "retry_not_worthy",
  "retry_outcome_failed",
  "retry_readiness_not_ready",
  "retry_readiness_blocked",
  "retry_invalid_artifact",
  "retry_blocked_dependency",
  "retry_budget_exhausted",
  "retry_budget_unknown",
  "retry_gate_passed",
  "safety_gate_passed",
  "promotion_applied",
]);

const DECISION_ENGINE_ALL_ACTIONS = PROMOTION_CONTROL_SURFACE_ALL_ACTIONS;

const ASK_USER_FRIENDLY_BLOCKING_REASONS = new Set([
  "missing_slot",
]);

const FAIL_CLOSED_BLOCKING_REASONS = new Set([
  "blocked_dependency",
  "plan_invalidated",
  "malformed_plan_state",
]);

const RETRY_BLOCKING_REASONS = new Set([
  "invalid_artifact",
  "blocked_dependency",
  "missing_slot",
  "recovery_in_progress",
  "owner_mismatch",
  "plan_invalidated",
  "malformed_plan_state",
]);

const PROMOTION_OUTCOME_STATUSES = new Set([
  "success",
  "partial",
  "blocked",
  "failed",
]);

const PROMOTION_FINAL_STEP_STATUSES = new Set([
  "pending",
  "running",
  "blocked",
  "failed",
  "completed",
  "skipped",
]);

const PROMOTION_HARD_FAIL_REASON_CODES = new Set([
  "plan_invalidated",
  "recovery_failed",
  "outcome_failed",
  "blocked_dependency",
  "malformed_plan_state",
]);

const PROMOTION_RECOVERABLE_ACTIONS = new Set([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
]);

const DEFAULT_PROMOTION_AUDIT_STATE = Object.freeze({
  actions: {
    ask_user: {
      consecutive_ineffective: 0,
      promotion_disabled: false,
      last_effectiveness: null,
      last_audit_id: null,
      metrics: {
        promotion_applied_count: 0,
        exact_match_count: 0,
        acceptable_divergence_count: 0,
        hard_divergence_count: 0,
        effective_count: 0,
        ineffective_count: 0,
        rollback_flag_count: 0,
      },
    },
    fail: {
      consecutive_ineffective: 0,
      promotion_disabled: false,
      last_effectiveness: null,
      last_audit_id: null,
      metrics: {
        promotion_applied_count: 0,
        exact_match_count: 0,
        acceptable_divergence_count: 0,
        hard_divergence_count: 0,
        effective_count: 0,
        ineffective_count: 0,
        rollback_flag_count: 0,
      },
    },
    retry: {
      consecutive_ineffective: 0,
      promotion_disabled: false,
      last_effectiveness: null,
      last_audit_id: null,
      metrics: {
        promotion_applied_count: 0,
        exact_match_count: 0,
        acceptable_divergence_count: 0,
        hard_divergence_count: 0,
        effective_count: 0,
        ineffective_count: 0,
        rollback_flag_count: 0,
      },
    },
  },
});

let promotionAuditSequence = 0;

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

function uniqueStrings(values = []) {
  return Array.from(new Set(
    toArray(values)
      .map((value) => cleanText(value))
      .filter(Boolean),
  ));
}

function normalizeAction(value = "") {
  const normalized = cleanText(value || "");
  return DECISION_ENGINE_ALL_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function normalizePromotableAction(value = "") {
  const normalized = normalizeAction(value);
  return normalized && DECISION_ENGINE_PROMOTABLE_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function resolveDecisionPromotionThreshold({
  promotion_policy = null,
  threshold = null,
} = {}) {
  if (threshold !== null && threshold !== undefined && threshold !== "" && Number.isFinite(Number(threshold))) {
    return Math.max(1, Number(threshold));
  }
  const normalizedPolicy = resolvePromotionControlSurface({
    promotion_policy,
  });
  if (Number.isFinite(Number(normalizedPolicy.ineffective_threshold))) {
    return Math.max(1, Number(normalizedPolicy.ineffective_threshold));
  }
  return DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD;
}

export function listDecisionPromotionRollbackDisabledActions({
  state = null,
  threshold = null,
  promotion_policy = null,
} = {}) {
  const normalizedState = createDecisionPromotionAuditState(state);
  const normalizedThreshold = resolveDecisionPromotionThreshold({
    promotion_policy,
    threshold,
  });
  const disabledActions = [];
  for (const action of DECISION_ENGINE_PROMOTABLE_ACTIONS) {
    const actionState = normalizePromotionActionState(normalizedState.actions[action]);
    if (actionState.promotion_disabled === true || actionState.consecutive_ineffective >= normalizedThreshold) {
      disabledActions.push(action);
    }
  }
  return disabledActions;
}

export function resolveDecisionPromotionPolicy({
  promotion_policy = null,
  rollback_disabled_actions = [],
  state = null,
  threshold = null,
} = {}) {
  const disabledActionsFromState = listDecisionPromotionRollbackDisabledActions({
    state,
    threshold,
    promotion_policy,
  });
  return resolvePromotionControlSurface({
    promotion_policy,
    rollback_disabled_actions: [
      ...disabledActionsFromState,
      ...toArray(rollback_disabled_actions),
    ],
  });
}

function normalizeOutcomeStatus(value = "") {
  const normalized = cleanText(value || "");
  return PROMOTION_OUTCOME_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeFinalStepStatus(value = "") {
  const normalized = cleanText(value || "");
  return PROMOTION_FINAL_STEP_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeUserVisibleCompleteness(value = "") {
  const normalized = cleanText(value || "");
  return normalized || null;
}

function inferOutcomeStatusFromFinalStepStatus(finalStepStatus = "") {
  const normalized = normalizeFinalStepStatus(finalStepStatus);
  if (!normalized) {
    return null;
  }
  if (normalized === "completed") {
    return "success";
  }
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "blocked") {
    return "blocked";
  }
  if (normalized === "running" || normalized === "pending" || normalized === "skipped") {
    return "partial";
  }
  return null;
}

function hasReadinessEvidence(readiness = null) {
  const readinessObject = toObject(readiness);
  if (!readinessObject) {
    return false;
  }
  return typeof readinessObject.is_ready === "boolean"
    || uniqueStrings(readinessObject.blocking_reason_codes).length > 0
    || Boolean(normalizeAction(readinessObject.recommended_action));
}

function hasOutcomeEvidence(outcome = null) {
  const outcomeObject = toObject(outcome);
  if (!outcomeObject) {
    return false;
  }
  return Boolean(cleanText(outcomeObject.outcome_status || ""));
}

function hasRecoveryEvidence(recovery = null) {
  const recoveryObject = toObject(recovery);
  if (!recoveryObject) {
    return false;
  }
  return Boolean(cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || ""))
    || Number.isFinite(Number(recoveryObject.recovery_attempt_count));
}

function resolveEvidenceComplete({
  readiness = null,
  outcome = null,
  recovery = null,
  evidence_complete = null,
} = {}) {
  if (typeof evidence_complete === "boolean") {
    return evidence_complete;
  }
  return hasReadinessEvidence(readiness)
    && (hasOutcomeEvidence(outcome) || hasRecoveryEvidence(recovery));
}

function resolveHardFailClosedSignal({
  readiness = null,
  recovery = null,
  task_plan = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const recoveryObject = toObject(recovery) || {};
  const taskPlanObject = toObject(task_plan) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  if (blockingReasonCodes.some((reasonCode) => FAIL_CLOSED_BLOCKING_REASONS.has(reasonCode))) {
    return true;
  }
  const planStatus = cleanText(taskPlanObject.plan_status || "");
  if (planStatus === "invalidated") {
    return true;
  }
  if (taskPlanObject.malformed_input === true) {
    return true;
  }
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  return recoveryAction === "failed";
}

function resolveMalformedOrUnknownSignals({
  advisor_action = null,
  advisor_alignment = null,
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
} = {}) {
  if (!normalizeAction(advisor_action)) {
    return true;
  }
  const alignment = toObject(advisor_alignment) || {};
  const alignmentType = cleanText(alignment.alignment_type || "");
  if (alignmentType === "unknown") {
    return true;
  }
  const divergenceReasonCodes = uniqueStrings(alignment.divergence_reason_codes);
  if (divergenceReasonCodes.some((reasonCode) =>
    reasonCode === "malformed_alignment_input"
    || reasonCode === "missing_advisor_action"
    || reasonCode === "missing_actual_action")) {
    return true;
  }
  if (readiness !== null && toObject(readiness) === null) {
    return true;
  }
  if (outcome !== null && toObject(outcome) === null) {
    return true;
  }
  if (recovery !== null && toObject(recovery) === null) {
    return true;
  }
  if (artifact !== null && toObject(artifact) === null) {
    return true;
  }
  if (task_plan !== null && toObject(task_plan) === null) {
    return true;
  }
  return false;
}

function resolveOptionalNonNegativeNumber(value = null) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Math.max(0, Number(value));
}

function resolveRetryBudgetState(recovery = null) {
  const recoveryObject = toObject(recovery) || {};
  const retryAllowedFieldPresent = typeof recoveryObject.retry_allowed === "boolean";
  const retryAllowed = retryAllowedFieldPresent
    ? recoveryObject.retry_allowed === true
    : true;
  const recoveryAttemptCount = resolveOptionalNonNegativeNumber(recoveryObject.recovery_attempt_count);
  const retryBudgetMax = resolveOptionalNonNegativeNumber(
    recoveryObject.retry_budget_max
      ?? recoveryObject.max_retries
      ?? recoveryObject.retry_budget_limit
      ?? recoveryObject.retry_budget_total
      ?? null,
  );
  const retryBudgetRemainingExplicit = resolveOptionalNonNegativeNumber(
    recoveryObject.retry_budget_remaining ?? null,
  );
  const retryBudgetExhaustedExplicit = recoveryObject.retry_budget_exhausted === true;
  const retryBudgetRemaining = retryBudgetRemainingExplicit !== null
    ? retryBudgetRemainingExplicit
    : (retryBudgetMax !== null && recoveryAttemptCount !== null
      ? Math.max(0, retryBudgetMax - recoveryAttemptCount)
      : null);
  const retryBudgetExhausted = retryBudgetExhaustedExplicit
    || retryAllowed === false
    || (retryBudgetMax !== null && recoveryAttemptCount !== null && recoveryAttemptCount >= retryBudgetMax)
    || (retryBudgetRemaining !== null && retryBudgetRemaining <= 0);
  const hasBudgetSignal = retryBudgetExhaustedExplicit
    || retryBudgetRemainingExplicit !== null
    || (retryBudgetMax !== null && recoveryAttemptCount !== null);
  return {
    retry_allowed: retryAllowed,
    retry_budget_known: hasBudgetSignal || retryAllowedFieldPresent,
    has_budget_signal: hasBudgetSignal,
    retry_budget_exhausted: retryBudgetExhausted,
    retry_budget_max: retryBudgetMax,
    retry_budget_remaining: retryBudgetRemaining,
    recovery_attempt_count: recoveryAttemptCount,
  };
}

function evaluateRetrySafety({
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const artifactObject = toObject(artifact) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const missingSlots = uniqueStrings(readinessObject.missing_slots);
  const readinessRecommendedAction = normalizeAction(readinessObject.recommended_action);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  const retryWorthiness = outcomeObject.retry_worthiness === true;
  const invalidArtifacts = toArray(readinessObject.invalid_artifacts).filter((item) => toObject(item));
  const blockedDependencies = toArray(readinessObject.blocked_dependencies).filter((item) => toObject(item));
  const artifactValidity = cleanText(artifactObject.validity_status || "");
  const artifactInvalidCount = resolveOptionalNonNegativeNumber(artifactObject.invalid_artifact_count) || 0;
  const blockedDependencyCount = resolveOptionalNonNegativeNumber(artifactObject.blocked_dependency_count) || 0;
  const hasInvalidArtifact = invalidArtifacts.length > 0
    || artifactInvalidCount > 0
    || artifactValidity === "invalid"
    || blockingReasonCodes.includes("invalid_artifact");
  const hasBlockedDependency = blockedDependencies.length > 0
    || blockedDependencyCount > 0
    || Boolean(cleanText(artifactObject.dependency_blocked_step || ""))
    || blockingReasonCodes.includes("blocked_dependency");
  const hasBlockingReadiness = readinessObject.is_ready !== true
    || missingSlots.length > 0
    || blockingReasonCodes.some((reasonCode) => RETRY_BLOCKING_REASONS.has(reasonCode))
    || readinessObject.owner_ready === false
    || readinessObject.recovery_ready === false
    || (readinessRecommendedAction && readinessRecommendedAction !== "retry");
  const retryBudgetState = resolveRetryBudgetState(recovery);

  const conflictingSignals = [];
  if (!retryWorthiness) {
    conflictingSignals.push("retry_not_worthy");
  }
  if (outcomeStatus === "failed") {
    conflictingSignals.push("retry_outcome_failed");
  }
  if (readinessObject.is_ready !== true) {
    conflictingSignals.push("retry_readiness_not_ready");
  }
  if (hasInvalidArtifact) {
    conflictingSignals.push("retry_invalid_artifact");
  }
  if (hasBlockedDependency) {
    conflictingSignals.push("retry_blocked_dependency");
  }
  if (hasBlockingReadiness && !hasInvalidArtifact && !hasBlockedDependency) {
    conflictingSignals.push("retry_readiness_blocked");
  }
  if (retryBudgetState.retry_budget_exhausted) {
    conflictingSignals.push("retry_budget_exhausted");
  } else if (!retryBudgetState.has_budget_signal) {
    conflictingSignals.push("retry_budget_unknown");
  }

  return {
    gatePassed: conflictingSignals.length === 0,
    reasonCodes: uniqueStrings(conflictingSignals),
    confidence: conflictingSignals.length === 0 ? "high" : "low",
  };
}

function evaluateAskUserSafety({
  readiness = null,
  outcome = null,
  recovery = null,
  task_plan = null,
  advisor_reason_codes = [],
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const recoveryObject = toObject(recovery) || {};
  const taskPlanObject = toObject(task_plan) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const missingSlots = uniqueStrings(readinessObject.missing_slots);
  const readinessRecommendedAction = normalizeAction(readinessObject.recommended_action);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  const advisorReasonCodes = uniqueStrings(advisor_reason_codes);

  const hasAskUserSignal = missingSlots.length > 0
    || blockingReasonCodes.some((reasonCode) => ASK_USER_FRIENDLY_BLOCKING_REASONS.has(reasonCode))
    || readinessRecommendedAction === "ask_user"
    || outcomeStatus === "blocked";

  const hasFailClosedSignal = resolveHardFailClosedSignal({
    readiness,
    recovery,
    task_plan: taskPlanObject,
  }) || advisorReasonCodes.some((reasonCode) =>
    reasonCode === "plan_invalidated"
    || reasonCode === "recovery_failed"
    || reasonCode === "outcome_failed"
    || reasonCode === "blocked_dependency");

  const conflictingSignals = [];
  if (!hasAskUserSignal) {
    conflictingSignals.push("ask_user_signals_missing");
  }
  if (hasFailClosedSignal) {
    conflictingSignals.push("conflicting_signals");
  }
  if (readinessRecommendedAction && readinessRecommendedAction !== "ask_user") {
    conflictingSignals.push("conflicting_signals");
  }
  if (outcomeStatus === "success") {
    conflictingSignals.push("conflicting_signals");
  }
  if (recoveryAction && recoveryAction !== "ask_user") {
    conflictingSignals.push("conflicting_signals");
  }

  return {
    gatePassed: conflictingSignals.length === 0,
    reasonCodes: uniqueStrings(conflictingSignals),
    confidence: hasAskUserSignal && conflictingSignals.length === 0 ? "high" : "low",
  };
}

function evaluateFailSafety({
  readiness = null,
  outcome = null,
  recovery = null,
  task_plan = null,
  advisor_reason_codes = [],
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const recoveryObject = toObject(recovery) || {};
  const taskPlanObject = toObject(task_plan) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const missingSlots = uniqueStrings(readinessObject.missing_slots);
  const readinessRecommendedAction = normalizeAction(readinessObject.recommended_action);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  const retryWorthiness = typeof outcomeObject.retry_worthiness === "boolean"
    ? outcomeObject.retry_worthiness
    : null;
  const advisorReasonCodes = uniqueStrings(advisor_reason_codes);

  const hasHardFailClosedSignal = resolveHardFailClosedSignal({
    readiness,
    recovery,
    task_plan: taskPlanObject,
  });
  const hasFailSignal = hasHardFailClosedSignal
    || outcomeStatus === "failed"
    || advisorReasonCodes.some((reasonCode) =>
      reasonCode === "plan_invalidated"
      || reasonCode === "recovery_failed"
      || reasonCode === "outcome_failed"
      || reasonCode === "blocked_dependency");

  const conflictingSignals = [];
  if (!hasFailSignal) {
    conflictingSignals.push("fail_signals_missing");
  }
  if (!hasHardFailClosedSignal
    && (blockingReasonCodes.some((reasonCode) => ASK_USER_FRIENDLY_BLOCKING_REASONS.has(reasonCode))
      || missingSlots.length > 0
      || readinessRecommendedAction === "ask_user"
      || (outcomeStatus === "blocked" && retryWorthiness !== false)
      || recoveryAction === "ask_user")) {
    conflictingSignals.push("conflicting_signals");
  }
  if (readinessRecommendedAction && !["fail", "rollback"].includes(readinessRecommendedAction)) {
    conflictingSignals.push("conflicting_signals");
  }
  if (outcomeStatus === "success") {
    conflictingSignals.push("conflicting_signals");
  }

  return {
    gatePassed: conflictingSignals.length === 0,
    reasonCodes: uniqueStrings(conflictingSignals),
    confidence: hasHardFailClosedSignal && conflictingSignals.length === 0
      ? "high"
      : hasFailSignal && conflictingSignals.length === 0
        ? "medium"
        : "low",
  };
}

export function evaluateDecisionEnginePromotion({
  advisor = null,
  advisor_alignment = null,
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
  evidence_complete = null,
  promotion_policy = null,
} = {}) {
  const advisorObject = toObject(advisor) || {};
  const alignment = toObject(advisor_alignment) || {};
  const advisorAction = normalizeAction(advisorObject.recommended_next_action);
  const promotionPolicy = resolveDecisionPromotionPolicy({
    promotion_policy,
  });
  const actionPolicy = advisorAction
    ? resolvePromotionActionPolicy({
      policy: promotionPolicy,
      action: advisorAction,
    })
    : null;
  const alignmentType = cleanText(alignment.alignment_type || "");
  const promotionCandidate = alignment.promotion_candidate === true;
  const advisorReasonCodes = uniqueStrings(advisorObject.decision_reason_codes);
  const evidenceComplete = resolveEvidenceComplete({
    readiness,
    outcome,
    recovery,
    evidence_complete,
  });

  const reasonCodes = [];
  const pushReason = (reasonCode = "") => {
    const normalized = cleanText(reasonCode);
    if (!normalized || !DECISION_ENGINE_PROMOTION_REASON_CODES.includes(normalized) || reasonCodes.includes(normalized)) {
      return;
    }
    reasonCodes.push(normalized);
  };

  if (!advisorAction) {
    pushReason("missing_advisor_action");
  } else if (actionPolicy?.promotion_allowed !== true) {
    pushReason("unsupported_advisor_action");
    if (actionPolicy?.rollback_disabled === true) {
      pushReason("promotion_disabled_by_rollback_flag");
    } else {
      pushReason("promotion_denied_by_policy");
    }
  }
  if (promotionPolicy.policy_fail_closed === true) {
    pushReason("promotion_policy_fail_closed");
  }

  if (actionPolicy?.requires_exact_match === true && alignmentType !== "exact_match") {
    pushReason("alignment_not_exact_match");
  }
  if (!promotionCandidate) {
    pushReason("alignment_not_promotion_candidate");
  }
  if (actionPolicy?.requires_complete_evidence === true && !evidenceComplete) {
    pushReason("evidence_incomplete");
  }

  if (resolveMalformedOrUnknownSignals({
    advisor_action: advisorAction,
    advisor_alignment: alignment,
    readiness,
    outcome,
    recovery,
    artifact,
    task_plan,
  })) {
    pushReason("malformed_or_unknown_signals");
  }

  let actionSafety = {
    gatePassed: false,
    reasonCodes: [],
    confidence: "low",
  };
  if (advisorAction === "ask_user" && actionPolicy?.promotion_allowed === true) {
    actionSafety = evaluateAskUserSafety({
      readiness,
      outcome,
      recovery,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
    });
  } else if (advisorAction === "fail" && actionPolicy?.promotion_allowed === true) {
    actionSafety = evaluateFailSafety({
      readiness,
      outcome,
      recovery,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
    });
  } else if (advisorAction === "retry" && actionPolicy?.promotion_allowed === true) {
    actionSafety = evaluateRetrySafety({
      readiness,
      outcome,
      recovery,
      artifact,
    });
  }
  for (const reasonCode of actionSafety.reasonCodes) {
    pushReason(reasonCode);
  }

  const safetyGatePassed = reasonCodes.length === 0 && actionSafety.gatePassed;
  if (safetyGatePassed) {
    if (advisorAction === "retry") {
      pushReason("retry_gate_passed");
    }
    pushReason("safety_gate_passed");
    pushReason("promotion_applied");
  }

  return {
    promoted_action: safetyGatePassed ? advisorAction : null,
    promotion_applied: safetyGatePassed,
    promotion_reason_codes: reasonCodes,
    promotion_confidence: safetyGatePassed
      ? actionSafety.confidence
      : "low",
    safety_gate_passed: safetyGatePassed,
    promotion_version: DECISION_ENGINE_PROMOTION_VERSION,
    promotion_policy_version: cleanText(promotionPolicy.promotion_policy_version || "") || null,
  };
}

export function formatDecisionPromotionSummary(promotionDecision = null) {
  const normalized = toObject(promotionDecision) || {};
  const promotedAction = normalizeAction(normalized.promoted_action || "") || "none";
  const promotionApplied = normalized.promotion_applied === true;
  const safetyGatePassed = normalized.safety_gate_passed === true;
  const confidence = cleanText(normalized.promotion_confidence || "") || "low";
  const reasonCodes = uniqueStrings(normalized.promotion_reason_codes);
  const version = cleanText(normalized.promotion_version || "") || DECISION_ENGINE_PROMOTION_VERSION;
  return `promotion_applied=${promotionApplied ? "true" : "false"} action=${promotedAction} safety_gate_passed=${safetyGatePassed ? "true" : "false"} confidence=${confidence} reasons=${reasonCodes.length > 0 ? `[${reasonCodes.join(", ")}]` : "[]"} version=${version}`;
}

function normalizeDecisionPromotionAuditContext({
  advisor = null,
  advisor_alignment = null,
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
} = {}) {
  const advisorObject = toObject(advisor) || {};
  const alignmentObject = toObject(advisor_alignment) || {};
  const readinessSummary = toObject(readiness);
  const outcomeSummary = toObject(outcome);
  const recoverySummary = toObject(recovery);
  const artifactSummary = toObject(artifact);
  const taskPlanSummary = toObject(task_plan);
  const advisorAction = normalizeAction(advisorObject.recommended_next_action || alignmentObject.advisor_action || "") || null;
  const promotionCandidate = alignmentObject.promotion_candidate === true;
  const alignmentType = cleanText(alignmentObject.alignment_type || "") || null;
  const retryCase = advisorAction === "retry";
  const advisorAlignmentSummary = `advisor_action=${advisorAction || "none"} alignment_type=${alignmentType || "unknown"} promotion_candidate=${promotionCandidate ? "true" : "false"} retry_case=${retryCase ? "true" : "false"}`;
  return {
    advisor_action: advisorAction,
    alignment_type: alignmentType,
    advisor_alignment: {
      advisor_action: advisorAction,
      actual_action: normalizeAction(alignmentObject.actual_action || "") || null,
      is_aligned: alignmentObject.is_aligned === true,
      alignment_type: alignmentType,
      promotion_candidate: promotionCandidate,
      retry_case: retryCase,
    },
    advisor_alignment_summary: advisorAlignmentSummary,
    retry_case: retryCase,
    decision_reason_codes: uniqueStrings(advisorObject.decision_reason_codes),
    readiness_summary: readinessSummary || null,
    outcome_summary: outcomeSummary || null,
    recovery_summary: recoverySummary || null,
    artifact_summary: artifactSummary || null,
    task_plan_summary: taskPlanSummary || null,
  };
}

function normalizeDecisionPromotionAuditOutcome({
  final_step_status = null,
  outcome_status = null,
  user_visible_completeness = null,
} = {}) {
  const normalizedFinalStepStatus = normalizeFinalStepStatus(final_step_status || "");
  const normalizedOutcomeStatus = normalizeOutcomeStatus(outcome_status || "")
    || inferOutcomeStatusFromFinalStepStatus(normalizedFinalStepStatus);
  return {
    final_step_status: normalizedFinalStepStatus || null,
    outcome_status: normalizedOutcomeStatus || null,
    user_visible_completeness: normalizeUserVisibleCompleteness(user_visible_completeness),
  };
}

function hasOutcomeConflict({
  final_step_status = null,
  outcome_status = null,
} = {}) {
  const finalStepStatus = normalizeFinalStepStatus(final_step_status || "");
  const outcomeStatus = normalizeOutcomeStatus(outcome_status || "");
  if (!finalStepStatus || !outcomeStatus) {
    return false;
  }
  if (finalStepStatus === "completed" && outcomeStatus !== "success") {
    return true;
  }
  if (finalStepStatus === "failed" && outcomeStatus === "success") {
    return true;
  }
  if (finalStepStatus === "blocked" && outcomeStatus === "success") {
    return true;
  }
  return false;
}

function hasHardFailureSignal(context = null) {
  const normalizedContext = toObject(context) || {};
  const decisionReasonCodes = uniqueStrings(normalizedContext.decision_reason_codes);
  if (decisionReasonCodes.some((reasonCode) => PROMOTION_HARD_FAIL_REASON_CODES.has(reasonCode))) {
    return true;
  }
  const readinessSummary = toObject(normalizedContext.readiness_summary) || {};
  const blockingReasonCodes = uniqueStrings(readinessSummary.blocking_reason_codes);
  if (blockingReasonCodes.some((reasonCode) => FAIL_CLOSED_BLOCKING_REASONS.has(reasonCode))) {
    return true;
  }
  const taskPlanSummary = toObject(normalizedContext.task_plan_summary) || {};
  if (cleanText(taskPlanSummary.plan_status || "") === "invalidated" || taskPlanSummary.malformed_input === true) {
    return true;
  }
  const recoverySummary = toObject(normalizedContext.recovery_summary) || {};
  const recoveryAction = cleanText(recoverySummary.recovery_action || recoverySummary.recovery_policy || "");
  return recoveryAction === "failed";
}

function resolveOutcomeImprovementRank(outcomeStatus = "") {
  const normalizedStatus = normalizeOutcomeStatus(outcomeStatus || "");
  if (normalizedStatus === "success") {
    return 3;
  }
  if (normalizedStatus === "partial") {
    return 2;
  }
  if (normalizedStatus === "blocked") {
    return 1;
  }
  if (normalizedStatus === "failed") {
    return 0;
  }
  return null;
}

function resolveDecisionPromotionEffectiveness({
  promoted_action = null,
  promotion_applied = false,
  promotion_context = null,
  promotion_outcome = null,
} = {}) {
  const promotedAction = normalizePromotableAction(promoted_action || "");
  const context = toObject(promotion_context);
  const outcome = toObject(promotion_outcome);
  if (!promotedAction || promotion_applied !== true || !context || !outcome) {
    return {
      promotion_effectiveness: "unknown",
      audit_fail_closed: true,
      audit_reason_codes: ["malformed_audit"],
      countable: false,
    };
  }
  const normalizedOutcome = normalizeDecisionPromotionAuditOutcome(outcome);
  const outcomeStatus = normalizeOutcomeStatus(normalizedOutcome.outcome_status || "");
  const finalStepStatus = normalizeFinalStepStatus(normalizedOutcome.final_step_status || "");
  if (!outcomeStatus && !finalStepStatus) {
    return {
      promotion_effectiveness: "unknown",
      audit_fail_closed: true,
      audit_reason_codes: ["malformed_audit"],
      countable: false,
    };
  }
  if (hasOutcomeConflict({
    final_step_status: finalStepStatus,
    outcome_status: outcomeStatus,
  })) {
    return {
      promotion_effectiveness: "unknown",
      audit_fail_closed: true,
      audit_reason_codes: ["conflicting_audit"],
      countable: false,
    };
  }

  const hardFailureSignal = hasHardFailureSignal(context);
  const recoverySummary = toObject(context.recovery_summary) || {};
  const recoveryAction = normalizeAction(recoverySummary.recovery_action || recoverySummary.recovery_policy || "");
  const recoverableSignal = Boolean(recoveryAction && PROMOTION_RECOVERABLE_ACTIONS.has(recoveryAction));
  const previousOutcomeSummary = toObject(context.outcome_summary) || {};
  const previousOutcomeStatus = normalizeOutcomeStatus(previousOutcomeSummary.outcome_status || "");
  const previousRank = resolveOutcomeImprovementRank(previousOutcomeStatus);
  const nextRank = resolveOutcomeImprovementRank(outcomeStatus);

  if (promotedAction === "ask_user") {
    if (outcomeStatus === "success") {
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["outcome_success"],
        countable: true,
      };
    }
    if (outcomeStatus === "failed" && !hardFailureSignal) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["outcome_failed_without_hard_reason"],
        countable: true,
      };
    }
    if (outcomeStatus === "blocked" || finalStepStatus === "blocked") {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["ask_user_stuck_or_no_response"],
        countable: true,
      };
    }
    if (outcomeStatus === "failed" || finalStepStatus === "failed") {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["ask_user_follow_up_failed"],
        countable: true,
      };
    }
    return {
      promotion_effectiveness: "unknown",
      audit_fail_closed: false,
      audit_reason_codes: ["ask_user_effectiveness_unknown"],
      countable: false,
    };
  }

  if (promotedAction === "fail") {
    if (outcomeStatus === "success" || finalStepStatus === "completed" || recoverableSignal) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["fail_blocked_recoverable_path"],
        countable: true,
      };
    }
    if (outcomeStatus === "failed" && !hardFailureSignal) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["outcome_failed_without_hard_reason"],
        countable: true,
      };
    }
    if ((outcomeStatus === "failed" || finalStepStatus === "failed") && hardFailureSignal && !recoverableSignal) {
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["fail_prevented_unsafe_continuation"],
        countable: true,
      };
    }
    return {
      promotion_effectiveness: "unknown",
      audit_fail_closed: false,
      audit_reason_codes: ["fail_effectiveness_unknown"],
      countable: false,
    };
  }

  if (promotedAction === "retry") {
    if (outcomeStatus === "success") {
      if (previousOutcomeStatus === "success") {
        return {
          promotion_effectiveness: "ineffective",
          audit_fail_closed: false,
          audit_reason_codes: ["retry_no_improvement"],
          countable: true,
        };
      }
      if (previousOutcomeStatus === "failed" || previousOutcomeStatus === "partial") {
        return {
          promotion_effectiveness: "effective",
          audit_fail_closed: false,
          audit_reason_codes: ["retry_improved_to_success"],
          countable: true,
        };
      }
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["outcome_success"],
        countable: true,
      };
    }
    if (previousRank !== null && nextRank !== null && nextRank <= previousRank) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["retry_no_improvement"],
        countable: true,
      };
    }
    if (outcomeStatus === "failed" || finalStepStatus === "failed") {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["retry_outcome_failed"],
        countable: true,
      };
    }
    return {
      promotion_effectiveness: "ineffective",
      audit_fail_closed: false,
      audit_reason_codes: ["retry_effectiveness_unknown"],
      countable: true,
    };
  }

  if (outcomeStatus === "success") {
    return {
      promotion_effectiveness: "effective",
      audit_fail_closed: false,
      audit_reason_codes: ["outcome_success"],
      countable: true,
    };
  }
  if (outcomeStatus === "failed" && !hardFailureSignal) {
    return {
      promotion_effectiveness: "ineffective",
      audit_fail_closed: false,
      audit_reason_codes: ["outcome_failed_without_hard_reason"],
      countable: true,
    };
  }

  return {
    promotion_effectiveness: "unknown",
    audit_fail_closed: false,
    audit_reason_codes: ["effectiveness_unknown"],
    countable: false,
  };
}

function normalizePromotionActionState(actionState = null) {
  const normalized = toObject(actionState) || {};
  return {
    consecutive_ineffective: Number.isFinite(Number(normalized.consecutive_ineffective))
      ? Math.max(0, Number(normalized.consecutive_ineffective))
      : 0,
    promotion_disabled: normalized.promotion_disabled === true,
    last_effectiveness: DECISION_ENGINE_PROMOTION_EFFECTIVENESS.includes(cleanText(normalized.last_effectiveness || ""))
      ? cleanText(normalized.last_effectiveness || "")
      : null,
    last_audit_id: cleanText(normalized.last_audit_id || "") || null,
    metrics: normalizePromotionActionMetrics(normalized.metrics),
  };
}

function normalizePromotionActionMetrics(metrics = null) {
  const normalizedMetrics = toObject(metrics) || {};
  return {
    promotion_applied_count: Number.isFinite(Number(normalizedMetrics.promotion_applied_count))
      ? Math.max(0, Number(normalizedMetrics.promotion_applied_count))
      : 0,
    exact_match_count: Number.isFinite(Number(normalizedMetrics.exact_match_count))
      ? Math.max(0, Number(normalizedMetrics.exact_match_count))
      : 0,
    acceptable_divergence_count: Number.isFinite(Number(normalizedMetrics.acceptable_divergence_count))
      ? Math.max(0, Number(normalizedMetrics.acceptable_divergence_count))
      : 0,
    hard_divergence_count: Number.isFinite(Number(normalizedMetrics.hard_divergence_count))
      ? Math.max(0, Number(normalizedMetrics.hard_divergence_count))
      : 0,
    effective_count: Number.isFinite(Number(normalizedMetrics.effective_count))
      ? Math.max(0, Number(normalizedMetrics.effective_count))
      : 0,
    ineffective_count: Number.isFinite(Number(normalizedMetrics.ineffective_count))
      ? Math.max(0, Number(normalizedMetrics.ineffective_count))
      : 0,
    rollback_flag_count: Number.isFinite(Number(normalizedMetrics.rollback_flag_count))
      ? Math.max(0, Number(normalizedMetrics.rollback_flag_count))
      : 0,
  };
}

function applyPromotionAuditMetrics({
  metrics = null,
  audit_record = null,
  rollback_flag = false,
} = {}) {
  const nextMetrics = normalizePromotionActionMetrics(metrics);
  const normalizedAudit = toObject(audit_record) || {};
  const normalizedContext = toObject(normalizedAudit.promotion_context) || {};
  const promotionApplied = normalizedAudit.promotion_applied === true;
  const alignmentType = cleanText(
    normalizedContext.alignment_type
    || normalizedContext?.advisor_alignment?.alignment_type
    || "",
  );
  const promotionEffectiveness = cleanText(normalizedAudit.promotion_effectiveness || "");
  if (alignmentType === "exact_match") {
    nextMetrics.exact_match_count += 1;
  } else if (alignmentType === "acceptable_divergence") {
    nextMetrics.acceptable_divergence_count += 1;
  } else if (alignmentType === "hard_divergence") {
    nextMetrics.hard_divergence_count += 1;
  }
  if (promotionApplied) {
    nextMetrics.promotion_applied_count += 1;
  }
  if (promotionEffectiveness === "effective") {
    nextMetrics.effective_count += 1;
  } else if (promotionEffectiveness === "ineffective") {
    nextMetrics.ineffective_count += 1;
  }
  if (rollback_flag === true) {
    nextMetrics.rollback_flag_count += 1;
  }
  return nextMetrics;
}

export function createDecisionPromotionAuditState(state = null) {
  const normalizedState = toObject(state) || {};
  const actions = toObject(normalizedState.actions) || {};
  return {
    actions: {
      ask_user: normalizePromotionActionState(actions.ask_user || DEFAULT_PROMOTION_AUDIT_STATE.actions.ask_user),
      retry: normalizePromotionActionState(actions.retry || DEFAULT_PROMOTION_AUDIT_STATE.actions.retry),
      fail: normalizePromotionActionState(actions.fail || DEFAULT_PROMOTION_AUDIT_STATE.actions.fail),
    },
  };
}

export function resolveDecisionPromotionRollbackGate({
  state = null,
  promoted_action = null,
  threshold = null,
  promotion_policy = null,
} = {}) {
  const normalizedState = createDecisionPromotionAuditState(state);
  const promotedAction = normalizeAction(promoted_action || "");
  const actionState = promotedAction
    ? normalizedState.actions[promotedAction]
    : null;
  const normalizedThreshold = resolveDecisionPromotionThreshold({
    promotion_policy,
    threshold,
  });
  const promotionPolicy = resolveDecisionPromotionPolicy({
    promotion_policy,
    state: normalizedState,
    threshold: normalizedThreshold,
  });
  const actionPolicy = promotedAction
    ? resolvePromotionActionPolicy({
      policy: promotionPolicy,
      action: promotedAction,
    })
    : null;
  return {
    promoted_action: promotedAction || null,
    promotion_allowed: promotedAction
      ? actionPolicy?.promotion_allowed === true
      : true,
    rollback_flag: promotedAction
      ? actionPolicy?.rollback_disabled === true
      : false,
    consecutive_ineffective: promotedAction
      ? Number(actionState?.consecutive_ineffective || 0)
      : 0,
    threshold: normalizedThreshold,
  };
}

function nextDecisionPromotionAuditId() {
  promotionAuditSequence += 1;
  return `promotion_audit_${String(promotionAuditSequence).padStart(6, "0")}`;
}

export function resetDecisionPromotionAuditSequence() {
  promotionAuditSequence = 0;
}

export function buildDecisionPromotionAuditRecord({
  audit_id = null,
  promoted_action = null,
  promotion_decision = null,
  advisor = null,
  advisor_alignment = null,
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
  final_step_status = null,
  outcome_status = null,
  user_visible_completeness = null,
  rollback_flag = false,
} = {}) {
  const normalizedDecision = toObject(promotion_decision) || {};
  const promotedAction = normalizePromotableAction(
    promoted_action
    || normalizedDecision.promoted_action
    || toObject(advisor)?.recommended_next_action
    || "",
  );
  const promotionApplied = normalizedDecision.promotion_applied === true
    && Boolean(promotedAction);
  const context = normalizeDecisionPromotionAuditContext({
    advisor,
    advisor_alignment,
    readiness,
    outcome,
    recovery,
    artifact,
    task_plan,
  });
  const outcomeSummary = normalizeDecisionPromotionAuditOutcome({
    final_step_status,
    outcome_status,
    user_visible_completeness,
  });
  const effectiveness = resolveDecisionPromotionEffectiveness({
    promoted_action: promotedAction,
    promotion_applied: promotionApplied,
    promotion_context: context,
    promotion_outcome: outcomeSummary,
  });
  const auditId = cleanText(audit_id || "") || nextDecisionPromotionAuditId();
  const auditRecord = {
    promotion_audit_id: auditId,
    promoted_action: promotedAction || null,
    promotion_applied: promotionApplied,
    promotion_context: context,
    promotion_outcome: outcomeSummary,
    promotion_effectiveness: effectiveness.promotion_effectiveness,
    rollback_flag: rollback_flag === true,
    audit_version: DECISION_ENGINE_PROMOTION_AUDIT_VERSION,
  };
  if (effectiveness.audit_fail_closed === true) {
    auditRecord.audit_fail_closed = true;
  }
  if (Array.isArray(effectiveness.audit_reason_codes) && effectiveness.audit_reason_codes.length > 0) {
    auditRecord.audit_reason_codes = effectiveness.audit_reason_codes;
  }
  if (effectiveness.countable === false) {
    auditRecord.effectiveness_counted = false;
  }
  return auditRecord;
}

export function applyDecisionPromotionAuditSafety({
  state = null,
  audit_record = null,
  threshold = null,
  promotion_policy = null,
} = {}) {
  const normalizedState = createDecisionPromotionAuditState(state);
  const normalizedAudit = toObject(audit_record) || {};
  const promotedAction = normalizePromotableAction(normalizedAudit.promoted_action || "");
  const normalizedThreshold = resolveDecisionPromotionThreshold({
    promotion_policy,
    threshold,
  });
  if (!promotedAction) {
    return {
      next_state: normalizedState,
      audit_record: {
        ...normalizedAudit,
        rollback_flag: false,
      },
    };
  }

  const actionState = normalizePromotionActionState(normalizedState.actions[promotedAction]);
  const effectiveness = cleanText(normalizedAudit.promotion_effectiveness || "");
  const promotionApplied = normalizedAudit.promotion_applied === true;
  const auditFailClosed = normalizedAudit.audit_fail_closed === true;
  const auditConflicting = Array.isArray(normalizedAudit.audit_reason_codes)
    && normalizedAudit.audit_reason_codes.includes("conflicting_audit");
  if (!auditFailClosed && !auditConflicting && promotionApplied) {
    if (effectiveness === "ineffective") {
      actionState.consecutive_ineffective += 1;
    } else {
      actionState.consecutive_ineffective = 0;
    }
    actionState.last_effectiveness = DECISION_ENGINE_PROMOTION_EFFECTIVENESS.includes(effectiveness)
      ? effectiveness
      : null;
    actionState.last_audit_id = cleanText(normalizedAudit.promotion_audit_id || "") || null;
    if (actionState.consecutive_ineffective >= normalizedThreshold) {
      actionState.promotion_disabled = true;
    }
  }
  const nextRollbackFlag = actionState.promotion_disabled === true;
  if (!auditFailClosed && !auditConflicting) {
    actionState.metrics = applyPromotionAuditMetrics({
      metrics: actionState.metrics,
      audit_record: normalizedAudit,
      rollback_flag: nextRollbackFlag,
    });
  }

  const nextState = {
    ...normalizedState,
    actions: {
      ...normalizedState.actions,
      [promotedAction]: actionState,
    },
  };
  return {
    next_state: nextState,
    audit_record: {
      ...normalizedAudit,
      rollback_flag: nextRollbackFlag,
    },
  };
}

export function formatDecisionPromotionAuditSummary(promotionAudit = null) {
  const normalized = toObject(promotionAudit) || {};
  const auditId = cleanText(normalized.promotion_audit_id || "") || "none";
  const promotedAction = normalizePromotableAction(normalized.promoted_action || "") || "none";
  const promotionApplied = normalized.promotion_applied === true;
  const promotionEffectiveness = DECISION_ENGINE_PROMOTION_EFFECTIVENESS.includes(cleanText(normalized.promotion_effectiveness || ""))
    ? cleanText(normalized.promotion_effectiveness || "")
    : "unknown";
  const rollbackFlag = normalized.rollback_flag === true;
  const outcome = toObject(normalized.promotion_outcome) || {};
  const finalStepStatus = normalizeFinalStepStatus(outcome.final_step_status || "") || "none";
  const outcomeStatus = normalizeOutcomeStatus(outcome.outcome_status || "") || "none";
  const userVisibleCompleteness = normalizeUserVisibleCompleteness(outcome.user_visible_completeness || "") || "none";
  const reasonCodes = uniqueStrings(normalized.audit_reason_codes);
  const version = cleanText(normalized.audit_version || "") || DECISION_ENGINE_PROMOTION_AUDIT_VERSION;
  return `id=${auditId} action=${promotedAction} applied=${promotionApplied ? "true" : "false"} effectiveness=${promotionEffectiveness} rollback_flag=${rollbackFlag ? "true" : "false"} final_step_status=${finalStepStatus} outcome_status=${outcomeStatus} user_visible_completeness=${userVisibleCompleteness} reasons=${reasonCodes.length > 0 ? `[${reasonCodes.join(", ")}]` : "[]"} version=${version}`;
}
