import { cleanText } from "./message-intent-utils.mjs";

export const ADVISOR_ALIGNMENT_EVALUATOR_VERSION = "advisor_alignment_evaluator_v1";

export const ADVISOR_ALIGNMENT_TYPES = Object.freeze([
  "exact_match",
  "acceptable_divergence",
  "hard_divergence",
  "unknown",
]);

export const ADVISOR_ALIGNMENT_REASON_CODES = Object.freeze([
  "actual_more_conservative",
  "advisor_more_conservative",
  "routing_overrode_advisor",
  "recovery_overrode_advisor",
  "insufficient_evidence",
  "malformed_alignment_input",
  "missing_actual_action",
  "missing_advisor_action",
]);

const ADVISOR_ALIGNMENT_ACTIONS = Object.freeze([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);

const ACTION_CONSERVATISM_RANK = Object.freeze({
  proceed: 0,
  retry: 1,
  reroute: 1,
  skip: 1,
  ask_user: 2,
  rollback: 3,
  fail: 4,
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
    toArray(items)
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
}

function normalizeAction(value = "") {
  const normalized = cleanText(value || "");
  return ADVISOR_ALIGNMENT_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function normalizeReasonCodes(reasonCodes = []) {
  return uniqueStrings(reasonCodes)
    .filter((reasonCode) => ADVISOR_ALIGNMENT_REASON_CODES.includes(reasonCode));
}

function isMalformedEvidenceInput(value = null) {
  if (value === null || value === undefined) {
    return false;
  }
  return toObject(value) === null;
}

function hasBlockingEvidence({
  readiness = null,
  outcome = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const outcomeEvidence = toObject(outcomeObject.outcome_evidence) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const outcomeErrors = uniqueStrings(outcomeEvidence.errors_encountered);
  const readinessRecommendedAction = normalizeAction(readinessObject.recommended_action);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  if (blockingReasonCodes.includes("missing_slot") || blockingReasonCodes.includes("blocked_dependency")) {
    return true;
  }
  if (outcomeErrors.includes("missing_slot") || outcomeErrors.includes("blocked_dependency")) {
    return true;
  }
  if (readinessRecommendedAction === "ask_user") {
    return true;
  }
  return outcomeStatus === "blocked";
}

function isAskUserToFailAcceptable({
  readiness = null,
  outcome = null,
  recovery = null,
} = {}) {
  const readinessObject = toObject(readiness) || {};
  const outcomeObject = toObject(outcome) || {};
  const recoveryObject = toObject(recovery) || {};
  const blockingReasonCodes = uniqueStrings(readinessObject.blocking_reason_codes);
  const outcomeStatus = cleanText(outcomeObject.outcome_status || "");
  const retryWorthiness = typeof outcomeObject.retry_worthiness === "boolean"
    ? outcomeObject.retry_worthiness
    : null;
  const recoveryAction = cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || "");
  if (blockingReasonCodes.includes("blocked_dependency")
    || blockingReasonCodes.includes("plan_invalidated")
    || blockingReasonCodes.includes("malformed_plan_state")) {
    return true;
  }
  if (recoveryAction === "failed") {
    return true;
  }
  return outcomeStatus === "failed" && retryWorthiness === false;
}

function isEvidenceComplete({
  readiness = null,
  outcome = null,
  recovery = null,
  evidence_complete = null,
} = {}) {
  if (typeof evidence_complete === "boolean") {
    return evidence_complete;
  }
  const readinessObject = toObject(readiness);
  const outcomeObject = toObject(outcome);
  const recoveryObject = toObject(recovery);
  const hasReadinessEvidence = Boolean(readinessObject)
    && (
      typeof readinessObject.is_ready === "boolean"
      || uniqueStrings(readinessObject.blocking_reason_codes).length > 0
      || Boolean(cleanText(readinessObject.recommended_action || ""))
    );
  const hasOutcomeEvidence = Boolean(outcomeObject)
    && Boolean(cleanText(outcomeObject.outcome_status || ""));
  const hasRecoveryEvidence = Boolean(recoveryObject)
    && (
      Boolean(cleanText(recoveryObject.recovery_action || recoveryObject.recovery_policy || ""))
      || Number.isFinite(Number(recoveryObject.recovery_attempt_count))
    );
  return hasReadinessEvidence && (hasOutcomeEvidence || hasRecoveryEvidence);
}

function buildAlignmentResult({
  advisorAction = null,
  actualAction = null,
  isAligned = false,
  alignmentType = "unknown",
  divergenceReasonCodes = [],
  promotionCandidate = false,
} = {}) {
  return {
    advisor_action: advisorAction,
    actual_action: actualAction,
    is_aligned: isAligned === true,
    alignment_type: ADVISOR_ALIGNMENT_TYPES.includes(cleanText(alignmentType || ""))
      ? cleanText(alignmentType || "")
      : "unknown",
    divergence_reason_codes: normalizeReasonCodes(divergenceReasonCodes),
    promotion_candidate: promotionCandidate === true,
    evaluator_version: ADVISOR_ALIGNMENT_EVALUATOR_VERSION,
  };
}

function finalizeAlignmentResult({
  advisorAction = null,
  actualAction = null,
  alignmentType = "unknown",
  divergenceReasonCodes = [],
  evidenceComplete = false,
} = {}) {
  const normalizedAlignmentType = ADVISOR_ALIGNMENT_TYPES.includes(cleanText(alignmentType || ""))
    ? cleanText(alignmentType || "")
    : "unknown";
  const isAligned = normalizedAlignmentType === "exact_match";
  return buildAlignmentResult({
    advisorAction,
    actualAction,
    isAligned,
    alignmentType: normalizedAlignmentType,
    divergenceReasonCodes,
    promotionCandidate: isAligned && evidenceComplete,
  });
}

function resolveConservatismDirection({
  advisorAction = null,
  actualAction = null,
} = {}) {
  if (!advisorAction || !actualAction) {
    return "unknown";
  }
  const advisorRank = ACTION_CONSERVATISM_RANK[advisorAction];
  const actualRank = ACTION_CONSERVATISM_RANK[actualAction];
  if (!Number.isFinite(advisorRank) || !Number.isFinite(actualRank)) {
    return "unknown";
  }
  if (actualRank > advisorRank) {
    return "actual_more_conservative";
  }
  if (advisorRank > actualRank) {
    return "advisor_more_conservative";
  }
  return "equal";
}

export function evaluateAdvisorAlignment({
  advisor_action = "",
  actual_action = "",
  readiness = null,
  outcome = null,
  recovery = null,
  routing_overrode_advisor = false,
  recovery_overrode_advisor = false,
  malformed_input = false,
  evidence_complete = null,
} = {}) {
  const advisorAction = normalizeAction(advisor_action);
  const actualAction = normalizeAction(actual_action);
  const malformedEvidenceInput = isMalformedEvidenceInput(readiness)
    || isMalformedEvidenceInput(outcome)
    || isMalformedEvidenceInput(recovery);
  const evidenceComplete = isEvidenceComplete({
    readiness,
    outcome,
    recovery,
    evidence_complete,
  });
  const baseDivergenceReasons = [];
  if (routing_overrode_advisor === true) {
    baseDivergenceReasons.push("routing_overrode_advisor");
  }
  if (recovery_overrode_advisor === true) {
    baseDivergenceReasons.push("recovery_overrode_advisor");
  }

  if (malformed_input === true || malformedEvidenceInput) {
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: "unknown",
      divergenceReasonCodes: ["malformed_alignment_input", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }
  if (!advisorAction) {
    return finalizeAlignmentResult({
      advisorAction: null,
      actualAction,
      alignmentType: "unknown",
      divergenceReasonCodes: ["missing_advisor_action", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }
  if (!actualAction) {
    return finalizeAlignmentResult({
      advisorAction,
      actualAction: null,
      alignmentType: "unknown",
      divergenceReasonCodes: ["missing_actual_action", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }

  if (advisorAction === actualAction) {
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: "exact_match",
      divergenceReasonCodes: [],
      evidenceComplete,
    });
  }

  if (advisorAction === "retry" && actualAction === "ask_user") {
    const acceptable = hasBlockingEvidence({ readiness, outcome });
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: acceptable ? "acceptable_divergence" : "hard_divergence",
      divergenceReasonCodes: acceptable
        ? ["actual_more_conservative", ...baseDivergenceReasons]
        : ["actual_more_conservative", "insufficient_evidence", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }

  if (advisorAction === "proceed" && ["retry", "rollback", "fail"].includes(actualAction)) {
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: "hard_divergence",
      divergenceReasonCodes: ["actual_more_conservative", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }

  if (advisorAction === "ask_user" && actualAction === "fail") {
    const acceptable = isAskUserToFailAcceptable({ readiness, outcome, recovery });
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: acceptable ? "acceptable_divergence" : "hard_divergence",
      divergenceReasonCodes: acceptable
        ? ["actual_more_conservative", ...baseDivergenceReasons]
        : ["actual_more_conservative", "insufficient_evidence", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }

  const conservatismDirection = resolveConservatismDirection({
    advisorAction,
    actualAction,
  });
  if (conservatismDirection === "actual_more_conservative") {
    const acceptable = hasBlockingEvidence({ readiness, outcome });
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: acceptable ? "acceptable_divergence" : "hard_divergence",
      divergenceReasonCodes: acceptable
        ? ["actual_more_conservative", ...baseDivergenceReasons]
        : ["actual_more_conservative", "insufficient_evidence", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }
  if (conservatismDirection === "advisor_more_conservative") {
    return finalizeAlignmentResult({
      advisorAction,
      actualAction,
      alignmentType: "hard_divergence",
      divergenceReasonCodes: ["advisor_more_conservative", ...baseDivergenceReasons],
      evidenceComplete,
    });
  }

  return finalizeAlignmentResult({
    advisorAction,
    actualAction,
    alignmentType: "hard_divergence",
    divergenceReasonCodes: ["insufficient_evidence", ...baseDivergenceReasons],
    evidenceComplete,
  });
}

export function formatAdvisorAlignmentSummary(alignment = null) {
  const normalized = toObject(alignment);
  if (!normalized) {
    return "advisor=none actual=none aligned=false type=unknown reasons=[] promotion_candidate=false";
  }
  const advisorAction = cleanText(normalized.advisor_action || normalized.recommended_next_action || "") || "none";
  const actualAction = cleanText(normalized.actual_action || normalized.actual_next_action || "") || "none";
  const alignmentType = cleanText(normalized.alignment_type || "") || "unknown";
  const divergenceReasonCodes = normalizeReasonCodes(normalized.divergence_reason_codes);
  const isAligned = normalized.is_aligned === true;
  const promotionCandidate = normalized.promotion_candidate === true;
  return `advisor=${advisorAction} actual=${actualAction} aligned=${isAligned ? "true" : "false"} type=${alignmentType} reasons=${divergenceReasonCodes.length > 0 ? `[${divergenceReasonCodes.join(", ")}]` : "[]"} promotion_candidate=${promotionCandidate ? "true" : "false"}`;
}
