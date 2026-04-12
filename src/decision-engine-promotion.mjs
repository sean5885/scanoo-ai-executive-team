import { cleanText } from "./message-intent-utils.mjs";
import {
  PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS,
  PROMOTION_CONTROL_SURFACE_ALL_ACTIONS,
  PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
  resolvePromotionActionPolicy,
  resolvePromotionControlSurface,
} from "./promotion-control-surface.mjs";
import { hasAnyTrulyMissingRequiredSlot } from "./truly-missing-slot.mjs";

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
  "ask_user_no_truly_missing_slot",
  "ask_user_resume_action_available",
  "ask_user_slot_suppressed",
  "ask_user_waiting_user_slots_filled",
  "ask_user_continuation_ready",
  "ask_user_slot_input_malformed",
  "ask_user_rollback_disabled",
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
  "reroute_signals_missing",
  "reroute_missing_slot_priority",
  "reroute_invalid_artifact",
  "reroute_blocked_dependency",
  "reroute_recovery_conflict",
  "reroute_health_signal_missing",
  "reroute_health_signal_not_ready",
  "reroute_target_unverified",
  "reroute_gate_passed",
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

const REROUTE_CONFLICT_RECOVERY_ACTIONS = new Set([
  "failed",
  "rollback_to_step",
]);

const REROUTE_HEALTH_BASE_ACTIONS = Object.freeze([
  "ask_user",
  "retry",
  "fail",
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

function buildDefaultPromotionActionMetrics() {
  return {
    promotion_applied_count: 0,
    exact_match_count: 0,
    acceptable_divergence_count: 0,
    hard_divergence_count: 0,
    effective_count: 0,
    ineffective_count: 0,
    rollback_flag_count: 0,
  };
}

function buildDefaultPromotionActionState() {
  return {
    consecutive_ineffective: 0,
    promotion_disabled: false,
    last_effectiveness: null,
    last_audit_id: null,
    metrics: buildDefaultPromotionActionMetrics(),
  };
}

const DEFAULT_PROMOTION_AUDIT_STATE = Object.freeze({
  actions: Object.freeze(
    Object.fromEntries(
      DECISION_ENGINE_PROMOTABLE_ACTIONS.map((action) => [
        action,
        Object.freeze(buildDefaultPromotionActionState()),
      ]),
    ),
  ),
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

function evaluateRerouteHealthSignal({
  decision_scoreboard = null,
} = {}) {
  const scoreboard = toObject(decision_scoreboard);
  if (!scoreboard) {
    return {
      gatePassed: false,
      reasonCode: "reroute_health_signal_missing",
      maturity: {},
    };
  }
  const entries = toArray(scoreboard.actions).filter((entry) => toObject(entry));
  if (entries.length === 0) {
    return {
      gatePassed: false,
      reasonCode: "reroute_health_signal_missing",
      maturity: {},
    };
  }
  const maturity = {};
  for (const actionName of REROUTE_HEALTH_BASE_ACTIONS) {
    const entry = entries.find((candidate) => cleanText(candidate?.action_name || "") === actionName) || null;
    const maturitySignal = cleanText(entry?.maturity_signal || "");
    maturity[actionName] = maturitySignal || "unknown";
    if (!entry || !maturitySignal || maturitySignal === "low") {
      return {
        gatePassed: false,
        reasonCode: "reroute_health_signal_not_ready",
        maturity,
      };
    }
  }
  return {
    gatePassed: true,
    reasonCode: null,
    maturity,
  };
}

function evaluateRerouteSafety({
  readiness = null,
  recovery = null,
  artifact = null,
  task_plan = null,
  advisor_reason_codes = [],
  decision_scoreboard = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const recoveryObject = toObject(recovery) || {};
  const artifactObject = toObject(artifact) || {};
  const taskPlanObject = toObject(task_plan) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const missingSlots = uniqueStrings(readinessObject.missing_slots);
  const advisorReasonCodes = uniqueStrings(advisor_reason_codes);
  const invalidArtifacts = toArray(readinessObject.invalid_artifacts).filter((item) => toObject(item));
  const blockedDependencies = toArray(readinessObject.blocked_dependencies).filter((item) => toObject(item));
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  const taskFailureClass = cleanText(taskPlanObject.failure_class || "");

  const hasOwnerMismatchSignal = blockingReasonCodes.includes("owner_mismatch")
    || readinessObject.owner_ready === false
    || advisorReasonCodes.includes("owner_mismatch");
  const hasCapabilityGapSignal = taskFailureClass === "capability_gap"
    || advisorReasonCodes.includes("capability_gap")
    || recoveryAction === "reroute_owner";
  const hasRerouteSignal = hasOwnerMismatchSignal || hasCapabilityGapSignal;

  const hasMissingSlotPriority = missingSlots.length > 0
    || blockingReasonCodes.includes("missing_slot");
  const hasInvalidArtifact = invalidArtifacts.length > 0
    || blockingReasonCodes.includes("invalid_artifact")
    || cleanText(artifactObject.validity_status || "") === "invalid"
    || Number(artifactObject.invalid_artifact_count || 0) > 0;
  const hasBlockedDependency = blockedDependencies.length > 0
    || blockingReasonCodes.includes("blocked_dependency")
    || Number(artifactObject.blocked_dependency_count || 0) > 0
    || Boolean(cleanText(artifactObject.dependency_blocked_step || ""));
  const retryBudgetState = resolveRetryBudgetState(recoveryObject);
  const hasRecoveryConflict = resolveHardFailClosedSignal({
    readiness,
    recovery,
    task_plan: taskPlanObject,
  })
    || REROUTE_CONFLICT_RECOVERY_ACTIONS.has(recoveryAction)
    || retryBudgetState.retry_budget_exhausted === true;
  const healthSignal = evaluateRerouteHealthSignal({
    decision_scoreboard,
  });

  const conflictingSignals = [];
  if (!hasRerouteSignal) {
    conflictingSignals.push("reroute_signals_missing");
  }
  if (hasMissingSlotPriority) {
    conflictingSignals.push("reroute_missing_slot_priority");
  }
  if (hasInvalidArtifact) {
    conflictingSignals.push("reroute_invalid_artifact");
  }
  if (hasBlockedDependency) {
    conflictingSignals.push("reroute_blocked_dependency");
  }
  if (hasRecoveryConflict) {
    conflictingSignals.push("reroute_recovery_conflict");
  }
  if (!healthSignal.gatePassed) {
    conflictingSignals.push(healthSignal.reasonCode || "reroute_health_signal_missing");
  }

  return {
    gatePassed: conflictingSignals.length === 0,
    reasonCodes: uniqueStrings(conflictingSignals),
    confidence: conflictingSignals.length === 0 ? "high" : "low",
    rerouteReason: hasOwnerMismatchSignal
      ? "owner_mismatch"
      : hasCapabilityGapSignal
        ? "capability_gap"
        : null,
    health_signal: healthSignal,
  };
}

function evaluateAskUserSafety({
  readiness = null,
  outcome = null,
  recovery = null,
  task_plan = null,
  advisor_reason_codes = [],
  ask_user_gate = null,
  action_policy = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const recoveryObject = toObject(recovery) || {};
  const taskPlanObject = toObject(task_plan) || {};
  const askUserGateObject = toObject(ask_user_gate) || {};
  const actionPolicy = toObject(action_policy) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const missingSlotsFromReadiness = uniqueStrings(readinessObject.missing_slots);
  const readinessRecommendedAction = normalizeAction(readinessObject.recommended_action);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  const advisorReasonCodes = uniqueStrings(advisor_reason_codes);
  const taskPhase = cleanText(askUserGateObject.task_phase || "");
  const currentStepAction = cleanText(askUserGateObject.current_step_action || "");
  const nextBestAction = cleanText(askUserGateObject.next_best_action || "");
  const currentStepResumeAvailable = askUserGateObject.current_step_resume_available === true
    || Boolean(currentStepAction);
  const nextBestActionAvailable = askUserGateObject.next_best_action_available === true
    || Boolean(nextBestAction);
  const hasResumeAction = currentStepResumeAvailable
    || nextBestActionAvailable
    || askUserGateObject.resume_action_available === true;
  const slotSuppressedAsk = askUserGateObject.slot_suppressed_ask === true;
  const requiredSlots = uniqueStrings([
    ...toArray(askUserGateObject.required_slots),
    ...missingSlotsFromReadiness,
  ]);
  const unresolvedSlots = uniqueStrings(askUserGateObject.unresolved_slots);
  const trulyMissingSlotsFromGate = uniqueStrings(askUserGateObject.truly_missing_slots);
  const slotMissingCheck = hasAnyTrulyMissingRequiredSlot({
    required_slots: requiredSlots,
    unresolved_slots: unresolvedSlots,
    slot_state: toArray(askUserGateObject.slot_state),
  });
  const malformedSlotInput = askUserGateObject.malformed_input === true
    || slotMissingCheck.malformed_input === true
    || (askUserGateObject.slot_state !== null
      && askUserGateObject.slot_state !== undefined
      && !Array.isArray(askUserGateObject.slot_state))
    || (askUserGateObject.required_slots !== null
      && askUserGateObject.required_slots !== undefined
      && !Array.isArray(askUserGateObject.required_slots))
    || (askUserGateObject.unresolved_slots !== null
      && askUserGateObject.unresolved_slots !== undefined
      && !Array.isArray(askUserGateObject.unresolved_slots));
  const trulyMissingSlots = trulyMissingSlotsFromGate.length > 0
    ? trulyMissingSlotsFromGate
    : slotMissingCheck.truly_missing_slots;
  const hasTrulyMissingSlot = trulyMissingSlots.length > 0;
  const waitingUserSlotsFilled = askUserGateObject.waiting_user_all_required_slots_filled === true
    || (taskPhase === "waiting_user"
      && slotMissingCheck.required_slots.length > 0
      && slotMissingCheck.has_any_truly_missing_required_slot !== true
      && malformedSlotInput !== true);
  const readinessCanContinue = readinessObject.is_ready === true
    || (readinessRecommendedAction
      && readinessRecommendedAction !== "ask_user"
      && readinessRecommendedAction !== "fail");
  const recoveryCanContinue = new Set([
    "retry_same_step",
    "reroute_owner",
    "rollback_to_step",
    "skip_step",
    "proceed",
  ]).has(cleanText(recoveryAction || ""));
  const outcomeCanContinue = outcomeStatus === "success"
    || (outcomeStatus === "partial" && outcomeObject.retry_worthiness !== false && readinessObject.is_ready === true);
  const continuationReady = askUserGateObject.continuation_ready === true
    || readinessCanContinue
    || recoveryCanContinue
    || outcomeCanContinue;

  const hasFailClosedSignal = resolveHardFailClosedSignal({
    readiness,
    recovery,
    task_plan: taskPlanObject,
  }) || advisorReasonCodes.some((reasonCode) =>
    reasonCode === "plan_invalidated"
    || reasonCode === "recovery_failed"
    || reasonCode === "outcome_failed"
    || reasonCode === "blocked_dependency");

  const blockedReasonCodes = [];
  if (actionPolicy.rollback_disabled === true) {
    blockedReasonCodes.push("ask_user_rollback_disabled");
  }
  if (malformedSlotInput) {
    blockedReasonCodes.push("ask_user_slot_input_malformed");
  }
  if (!hasTrulyMissingSlot) {
    blockedReasonCodes.push("ask_user_no_truly_missing_slot");
    blockedReasonCodes.push("ask_user_signals_missing");
  }
  if (hasResumeAction) {
    blockedReasonCodes.push("ask_user_resume_action_available");
  }
  if (slotSuppressedAsk) {
    blockedReasonCodes.push("ask_user_slot_suppressed");
  }
  if (waitingUserSlotsFilled) {
    blockedReasonCodes.push("ask_user_waiting_user_slots_filled");
  }
  if (continuationReady) {
    blockedReasonCodes.push("ask_user_continuation_ready");
  }
  if (hasFailClosedSignal) {
    blockedReasonCodes.push("conflicting_signals");
  }
  if (readinessRecommendedAction && readinessRecommendedAction !== "ask_user") {
    blockedReasonCodes.push("conflicting_signals");
  }
  if (outcomeStatus === "success") {
    blockedReasonCodes.push("conflicting_signals");
  }
  if (recoveryAction && recoveryAction !== "ask_user") {
    blockedReasonCodes.push("conflicting_signals");
  }
  const normalizedBlockedReasonCodes = uniqueStrings(blockedReasonCodes);
  const resumeInsteadOfAsk = waitingUserSlotsFilled
    || (hasResumeAction && !hasTrulyMissingSlot);

  return {
    gatePassed: normalizedBlockedReasonCodes.length === 0,
    reasonCodes: normalizedBlockedReasonCodes,
    confidence: hasTrulyMissingSlot && normalizedBlockedReasonCodes.length === 0 ? "high" : "low",
    ask_user_gate: {
      truly_missing_slots: trulyMissingSlots,
      blocked_reason_codes: normalizedBlockedReasonCodes,
      promotion_allowed: normalizedBlockedReasonCodes.length === 0,
      resume_instead_of_ask: resumeInsteadOfAsk,
    },
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
  decision_scoreboard = null,
  reroute_context = null,
  ask_user_gate = null,
} = {}) {
  const advisorObject = toObject(advisor) || {};
  const alignment = toObject(advisor_alignment) || {};
  const rerouteContext = toObject(reroute_context) || {};
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
  const askUserSafety = advisorAction === "ask_user"
    ? evaluateAskUserSafety({
      readiness,
      outcome,
      recovery,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
      ask_user_gate,
      action_policy: actionPolicy,
    })
    : null;
  if (advisorAction === "ask_user") {
    actionSafety = askUserSafety || actionSafety;
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
  } else if (advisorAction === "reroute" && actionPolicy?.promotion_allowed === true) {
    actionSafety = evaluateRerouteSafety({
      readiness,
      recovery,
      artifact,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
      decision_scoreboard,
    });
  }
  if (advisorAction === "reroute" && rerouteContext.reroute_target_verified === false) {
    pushReason("reroute_target_unverified");
  }
  for (const reasonCode of actionSafety.reasonCodes) {
    pushReason(reasonCode);
  }

  const safetyGatePassed = reasonCodes.length === 0 && actionSafety.gatePassed;
  if (safetyGatePassed) {
    if (advisorAction === "retry") {
      pushReason("retry_gate_passed");
    }
    if (advisorAction === "reroute") {
      pushReason("reroute_gate_passed");
    }
    pushReason("safety_gate_passed");
    pushReason("promotion_applied");
  }

  const rerouteTarget = cleanText(
    rerouteContext.reroute_target
    || rerouteContext.target_owner_agent
    || "",
  ) || null;
  const previousOwnerAgent = cleanText(rerouteContext.previous_owner_agent || "") || null;
  const currentOwnerAgent = cleanText(
    rerouteContext.current_owner_agent
    || rerouteTarget
    || "",
  ) || null;
  const rerouteReason = cleanText(
    rerouteContext.reroute_reason
    || actionSafety.rerouteReason
    || "",
  ) || null;
  const rerouteSource = cleanText(rerouteContext.reroute_source || "") || null;
  const askUserGate = askUserSafety?.ask_user_gate && typeof askUserSafety.ask_user_gate === "object"
    ? askUserSafety.ask_user_gate
    : {
      truly_missing_slots: [],
      blocked_reason_codes: [],
      promotion_allowed: false,
      resume_instead_of_ask: false,
    };
  const askUserBlockedReason = advisorAction === "ask_user"
    ? (cleanText(askUserGate.blocked_reason_codes?.[0] || "") || null)
    : null;
  const askUserRecalibrated = advisorAction === "ask_user"
    && askUserGate.blocked_reason_codes.length > 0;
  const askUserRecalibrationSummary = advisorAction === "ask_user"
    ? `promotion_allowed=${askUserGate.promotion_allowed ? "true" : "false"} resume_instead_of_ask=${askUserGate.resume_instead_of_ask ? "true" : "false"} truly_missing_slots=${askUserGate.truly_missing_slots.length > 0 ? `[${askUserGate.truly_missing_slots.join(", ")}]` : "[]"} blocked_reasons=${askUserGate.blocked_reason_codes.length > 0 ? `[${askUserGate.blocked_reason_codes.join(", ")}]` : "[]"}`
    : null;

  return {
    promoted_action: safetyGatePassed ? advisorAction : null,
    promotion_applied: safetyGatePassed,
    promotion_reason_codes: reasonCodes,
    promotion_confidence: safetyGatePassed
      ? actionSafety.confidence
      : "low",
    safety_gate_passed: safetyGatePassed,
    reroute_target: safetyGatePassed && advisorAction === "reroute"
      ? rerouteTarget
      : null,
    reroute_reason: safetyGatePassed && advisorAction === "reroute"
      ? rerouteReason
      : null,
    reroute_source: safetyGatePassed && advisorAction === "reroute"
      ? (rerouteSource || "promoted_decision_engine_v1")
      : null,
    reroute_target_verified: advisorAction === "reroute"
      ? (rerouteContext.reroute_target_verified === true)
      : null,
    previous_owner_agent: safetyGatePassed && advisorAction === "reroute"
      ? previousOwnerAgent
      : null,
    current_owner_agent: safetyGatePassed && advisorAction === "reroute"
      ? currentOwnerAgent
      : null,
    ask_user_gate: advisorAction === "ask_user"
      ? askUserGate
      : null,
    ask_user_blocked_reason: askUserBlockedReason,
    ask_user_recalibrated: askUserRecalibrated,
    ask_user_recalibration_summary: askUserRecalibrationSummary,
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
  const rerouteTarget = cleanText(normalized.reroute_target || "") || "none";
  const rerouteReason = cleanText(normalized.reroute_reason || "") || "none";
  const rerouteSource = cleanText(normalized.reroute_source || "") || "none";
  const previousOwnerAgent = cleanText(normalized.previous_owner_agent || "") || "none";
  const currentOwnerAgent = cleanText(normalized.current_owner_agent || "") || "none";
  const version = cleanText(normalized.promotion_version || "") || DECISION_ENGINE_PROMOTION_VERSION;
  return `promotion_applied=${promotionApplied ? "true" : "false"} action=${promotedAction} previous_owner_agent=${previousOwnerAgent} current_owner_agent=${currentOwnerAgent} reroute_target=${rerouteTarget} reroute_reason=${rerouteReason} reroute_source=${rerouteSource} safety_gate_passed=${safetyGatePassed ? "true" : "false"} confidence=${confidence} reasons=${reasonCodes.length > 0 ? `[${reasonCodes.join(", ")}]` : "[]"} version=${version}`;
}

function normalizeDecisionPromotionAuditContext({
  promotion_decision = null,
  advisor = null,
  advisor_alignment = null,
  readiness = null,
  outcome = null,
  recovery = null,
  artifact = null,
  task_plan = null,
} = {}) {
  const promotionDecision = toObject(promotion_decision) || {};
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
  const rerouteTarget = cleanText(promotionDecision.reroute_target || "") || null;
  const rerouteReason = cleanText(promotionDecision.reroute_reason || "") || null;
  const rerouteSource = cleanText(promotionDecision.reroute_source || "") || null;
  const previousOwnerAgent = cleanText(promotionDecision.previous_owner_agent || "") || null;
  const currentOwnerAgent = cleanText(promotionDecision.current_owner_agent || "") || null;
  const rerouteTargetVerified = typeof promotionDecision.reroute_target_verified === "boolean"
    ? promotionDecision.reroute_target_verified
    : null;
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
    reroute_target: rerouteTarget,
    reroute_reason: rerouteReason,
    reroute_source: rerouteSource,
    previous_owner_agent: previousOwnerAgent,
    current_owner_agent: currentOwnerAgent,
    reroute_target_verified: rerouteTargetVerified,
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

  if (promotedAction === "reroute") {
    const rerouteTargetVerified = context.reroute_target_verified;
    if (rerouteTargetVerified === false) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_target_incorrect"],
        countable: true,
      };
    }
    if (outcomeStatus === "success" || finalStepStatus === "completed") {
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_outcome_success"],
        countable: true,
      };
    }
    if (previousRank !== null && nextRank !== null && nextRank > previousRank) {
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_outcome_improved"],
        countable: true,
      };
    }
    if ((previousOutcomeStatus === "blocked" || previousOutcomeStatus === "failed")
      && (outcomeStatus === "partial" || outcomeStatus === "success")) {
      return {
        promotion_effectiveness: "effective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_avoided_blocked_or_failed"],
        countable: true,
      };
    }
    if (outcomeStatus === "blocked" || outcomeStatus === "failed" || finalStepStatus === "blocked" || finalStepStatus === "failed") {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_still_blocked_or_failed"],
        countable: true,
      };
    }
    if (previousRank !== null && nextRank !== null && nextRank <= previousRank) {
      return {
        promotion_effectiveness: "ineffective",
        audit_fail_closed: false,
        audit_reason_codes: ["reroute_no_improvement"],
        countable: true,
      };
    }
    return {
      promotion_effectiveness: "ineffective",
      audit_fail_closed: false,
      audit_reason_codes: ["reroute_effectiveness_unknown"],
      countable: true,
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
  const normalizedActions = {};
  for (const actionName of DECISION_ENGINE_PROMOTABLE_ACTIONS) {
    normalizedActions[actionName] = normalizePromotionActionState(
      actions[actionName]
      || DEFAULT_PROMOTION_AUDIT_STATE.actions[actionName]
      || buildDefaultPromotionActionState(),
    );
  }
  return {
    actions: normalizedActions,
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
    promotion_decision: normalizedDecision,
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
  const context = toObject(normalized.promotion_context) || {};
  const rerouteTarget = cleanText(context.reroute_target || "") || "none";
  const rerouteReason = cleanText(context.reroute_reason || "") || "none";
  const rerouteSource = cleanText(context.reroute_source || "") || "none";
  const previousOwnerAgent = cleanText(context.previous_owner_agent || "") || "none";
  const currentOwnerAgent = cleanText(context.current_owner_agent || "") || "none";
  const outcome = toObject(normalized.promotion_outcome) || {};
  const finalStepStatus = normalizeFinalStepStatus(outcome.final_step_status || "") || "none";
  const outcomeStatus = normalizeOutcomeStatus(outcome.outcome_status || "") || "none";
  const userVisibleCompleteness = normalizeUserVisibleCompleteness(outcome.user_visible_completeness || "") || "none";
  const reasonCodes = uniqueStrings(normalized.audit_reason_codes);
  const version = cleanText(normalized.audit_version || "") || DECISION_ENGINE_PROMOTION_AUDIT_VERSION;
  return `id=${auditId} action=${promotedAction} applied=${promotionApplied ? "true" : "false"} previous_owner_agent=${previousOwnerAgent} current_owner_agent=${currentOwnerAgent} reroute_target=${rerouteTarget} reroute_reason=${rerouteReason} reroute_source=${rerouteSource} effectiveness=${promotionEffectiveness} rollback_flag=${rollbackFlag ? "true" : "false"} final_step_status=${finalStepStatus} outcome_status=${outcomeStatus} user_visible_completeness=${userVisibleCompleteness} reasons=${reasonCodes.length > 0 ? `[${reasonCodes.join(", ")}]` : "[]"} version=${version}`;
}
