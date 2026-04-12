import { cleanText } from "./message-intent-utils.mjs";

export const DECISION_ENGINE_PROMOTION_VERSION = "decision_engine_promotion_v1";
export const DECISION_ENGINE_PROMOTION_AUDIT_VERSION = "decision_engine_promotion_audit_v1";
export const DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD = 3;
export const DECISION_ENGINE_PROMOTION_ROLLBACK_REASON_CODE = "promotion_rollback_gate_active";
export const DECISION_ENGINE_PROMOTION_EFFECTIVENESS = Object.freeze([
  "effective",
  "ineffective",
  "unknown",
]);

export const DECISION_ENGINE_PROMOTABLE_ACTIONS = Object.freeze([
  "ask_user",
  "fail",
]);

export const DECISION_ENGINE_PROMOTION_REASON_CODES = Object.freeze([
  "missing_advisor_action",
  "unsupported_advisor_action",
  "alignment_not_exact_match",
  "alignment_not_promotion_candidate",
  "evidence_incomplete",
  "malformed_or_unknown_signals",
  "conflicting_signals",
  "ask_user_signals_missing",
  "fail_signals_missing",
  "safety_gate_passed",
  "promotion_applied",
]);

const DECISION_ENGINE_ALL_ACTIONS = Object.freeze([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);

const ASK_USER_FRIENDLY_BLOCKING_REASONS = new Set([
  "missing_slot",
]);

const FAIL_CLOSED_BLOCKING_REASONS = new Set([
  "blocked_dependency",
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
    },
    fail: {
      consecutive_ineffective: 0,
      promotion_disabled: false,
      last_effectiveness: null,
      last_audit_id: null,
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
  if (task_plan !== null && toObject(task_plan) === null) {
    return true;
  }
  return false;
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
} = {}) {
  const advisorObject = toObject(advisor) || {};
  const alignment = toObject(advisor_alignment) || {};
  const advisorAction = normalizeAction(advisorObject.recommended_next_action);
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
  } else if (!DECISION_ENGINE_PROMOTABLE_ACTIONS.includes(advisorAction)) {
    pushReason("unsupported_advisor_action");
  }

  if (alignmentType !== "exact_match") {
    pushReason("alignment_not_exact_match");
  }
  if (!promotionCandidate) {
    pushReason("alignment_not_promotion_candidate");
  }
  if (!evidenceComplete) {
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
    reasonCodes: ["conflicting_signals"],
    confidence: "low",
  };
  if (advisorAction === "ask_user") {
    actionSafety = evaluateAskUserSafety({
      readiness,
      outcome,
      recovery,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
    });
  } else if (advisorAction === "fail") {
    actionSafety = evaluateFailSafety({
      readiness,
      outcome,
      recovery,
      task_plan,
      advisor_reason_codes: advisorReasonCodes,
    });
  }
  for (const reasonCode of actionSafety.reasonCodes) {
    pushReason(reasonCode);
  }

  const safetyGatePassed = reasonCodes.length === 0 && actionSafety.gatePassed;
  if (safetyGatePassed) {
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
  return {
    advisor_action: normalizeAction(advisorObject.recommended_next_action || alignmentObject.advisor_action || "") || null,
    alignment_type: cleanText(alignmentObject.alignment_type || "") || null,
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
  };
}

export function createDecisionPromotionAuditState(state = null) {
  const normalizedState = toObject(state) || {};
  const actions = toObject(normalizedState.actions) || {};
  return {
    actions: {
      ask_user: normalizePromotionActionState(actions.ask_user || DEFAULT_PROMOTION_AUDIT_STATE.actions.ask_user),
      fail: normalizePromotionActionState(actions.fail || DEFAULT_PROMOTION_AUDIT_STATE.actions.fail),
    },
  };
}

export function resolveDecisionPromotionRollbackGate({
  state = null,
  promoted_action = null,
  threshold = DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
} = {}) {
  const normalizedState = createDecisionPromotionAuditState(state);
  const promotedAction = normalizePromotableAction(promoted_action || "");
  const actionState = promotedAction
    ? normalizedState.actions[promotedAction]
    : null;
  const normalizedThreshold = Number.isFinite(Number(threshold))
    ? Math.max(1, Number(threshold))
    : DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD;
  return {
    promoted_action: promotedAction || null,
    promotion_allowed: promotedAction
      ? actionState?.promotion_disabled !== true
      : true,
    rollback_flag: promotedAction
      ? actionState?.promotion_disabled === true
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
  threshold = DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD,
} = {}) {
  const normalizedState = createDecisionPromotionAuditState(state);
  const normalizedAudit = toObject(audit_record) || {};
  const promotedAction = normalizePromotableAction(normalizedAudit.promoted_action || "");
  const normalizedThreshold = Number.isFinite(Number(threshold))
    ? Math.max(1, Number(threshold))
    : DECISION_ENGINE_PROMOTION_ROLLBACK_THRESHOLD;
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
      rollback_flag: actionState.promotion_disabled === true,
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
