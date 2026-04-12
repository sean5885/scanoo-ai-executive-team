import { cleanText } from "./message-intent-utils.mjs";

export const DECISION_ENGINE_PROMOTION_VERSION = "decision_engine_promotion_v1";

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
