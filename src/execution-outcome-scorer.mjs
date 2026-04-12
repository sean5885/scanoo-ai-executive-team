import { cleanText } from "./message-intent-utils.mjs";

export const EXECUTION_OUTCOME_STATUSES = Object.freeze([
  "success",
  "partial",
  "blocked",
  "failed",
]);

export const EXECUTION_OUTCOME_CONFIDENCE_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
]);

export const EXECUTION_OUTCOME_ARTIFACT_QUALITIES = Object.freeze([
  "valid",
  "invalid",
  "weak",
  "unknown",
]);

export const EXECUTION_OUTCOME_USER_VISIBLE_COMPLETENESS = Object.freeze([
  "complete",
  "partial",
  "none",
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

function uniqueStrings(items = []) {
  return Array.from(new Set(
    toArray(items).map((item) => cleanText(item)).filter(Boolean),
  ));
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.floor(normalized);
}

function normalizeOutcomeConfidence(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return null;
    }
    return Number(value.toFixed(4));
  }
  const level = cleanText(value || "");
  if (!level) {
    return null;
  }
  return EXECUTION_OUTCOME_CONFIDENCE_LEVELS.includes(level)
    ? level
    : null;
}

function normalizeOutcomeEvidence(value = null, { allowNull = true } = {}) {
  if ((value === null || value === undefined || value === "") && allowNull) {
    return null;
  }
  const evidence = toObject(value);
  if (!evidence) {
    return null;
  }
  const slotsFilledCount = normalizeNonNegativeInteger(evidence.slots_filled_count);
  const slotsMissingCount = normalizeNonNegativeInteger(evidence.slots_missing_count);
  const artifactsProducedCount = normalizeNonNegativeInteger(evidence.artifacts_produced_count);
  if (slotsFilledCount === null || slotsMissingCount === null || artifactsProducedCount === null) {
    return null;
  }
  return {
    slots_filled_count: slotsFilledCount,
    slots_missing_count: slotsMissingCount,
    artifacts_produced_count: artifactsProducedCount,
    errors_encountered: uniqueStrings(evidence.errors_encountered),
    recovery_actions_taken: uniqueStrings(evidence.recovery_actions_taken),
  };
}

export function normalizeExecutionOutcome(outcome = null, { allowNull = true } = {}) {
  if ((outcome === null || outcome === undefined || outcome === "") && allowNull) {
    return null;
  }
  const normalizedOutcome = toObject(outcome);
  if (!normalizedOutcome) {
    return null;
  }
  const status = cleanText(normalizedOutcome.outcome_status || "");
  const confidence = normalizeOutcomeConfidence(normalizedOutcome.outcome_confidence);
  const evidence = normalizeOutcomeEvidence(normalizedOutcome.outcome_evidence, { allowNull: false });
  const artifactQuality = cleanText(normalizedOutcome.artifact_quality || "");
  const userVisibleCompleteness = cleanText(normalizedOutcome.user_visible_completeness || "");
  if (!EXECUTION_OUTCOME_STATUSES.includes(status)
    || confidence === null
    || !evidence
    || !EXECUTION_OUTCOME_ARTIFACT_QUALITIES.includes(artifactQuality)
    || typeof normalizedOutcome.retry_worthiness !== "boolean"
    || !EXECUTION_OUTCOME_USER_VISIBLE_COMPLETENESS.includes(userVisibleCompleteness)) {
    return null;
  }
  return {
    outcome_status: status,
    outcome_confidence: confidence,
    outcome_evidence: evidence,
    artifact_quality: artifactQuality,
    retry_worthiness: normalizedOutcome.retry_worthiness,
    user_visible_completeness: userVisibleCompleteness,
  };
}

function classifyErrorTag(value = "") {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return "";
  }
  if (normalized === "tool_error" || normalized === "runtime_exception") {
    return "tool_error";
  }
  if (normalized === "timeout" || normalized === "request_timeout" || normalized === "request_cancelled") {
    return "timeout";
  }
  if (normalized === "missing_slot") {
    return "missing_slot";
  }
  if (normalized === "invalid_artifact" || normalized === "artifact_invalid") {
    return "invalid_artifact";
  }
  if (normalized === "unknown"
    || normalized === "blocked_dependency"
    || normalized === "plan_invalidated"
    || normalized === "malformed_plan_state") {
    return "unknown";
  }
  return normalized;
}

function scoreArtifactQuality({
  artifactQualityHint = "",
  artifactValidityStatus = "",
  readinessInvalidArtifacts = [],
  artifactsProducedCount = 0,
} = {}) {
  const hint = cleanText(artifactQualityHint || "");
  const statusCandidates = uniqueStrings([
    artifactValidityStatus,
    ...toArray(readinessInvalidArtifacts).map((item) => cleanText(item?.validity_status || "")),
  ]);
  const hasInvalid = statusCandidates.includes("invalid");
  const hasValid = statusCandidates.includes("valid");
  const hasWeak = statusCandidates.includes("superseded") || statusCandidates.includes("missing");
  if (hasInvalid) {
    return "invalid";
  }
  if (hasValid) {
    return "valid";
  }
  if (hasWeak) {
    return "weak";
  }
  if (EXECUTION_OUTCOME_ARTIFACT_QUALITIES.includes(hint)) {
    return hint;
  }
  return artifactsProducedCount > 0
    ? "weak"
    : "unknown";
}

function buildFailClosedOutcome() {
  return {
    outcome_status: "failed",
    outcome_confidence: 0,
    outcome_evidence: {
      slots_filled_count: 0,
      slots_missing_count: 0,
      artifacts_produced_count: 0,
      errors_encountered: ["malformed_outcome"],
      recovery_actions_taken: ["failed"],
    },
    artifact_quality: "unknown",
    retry_worthiness: false,
    user_visible_completeness: "none",
  };
}

function hasUserVisibleOutput({
  hasUserVisibleOutputFlag = null,
  userVisibleAnswer = "",
  userVisibleSources = [],
  userVisibleLimitations = [],
} = {}) {
  if (typeof hasUserVisibleOutputFlag === "boolean") {
    return hasUserVisibleOutputFlag;
  }
  return Boolean(
    cleanText(userVisibleAnswer || "")
    || toArray(userVisibleSources).length > 0
    || toArray(userVisibleLimitations).length > 0,
  );
}

function scoreOutcomeConfidence({
  outcomeStatus = "partial",
  artifactQuality = "unknown",
  visibleOutput = false,
} = {}) {
  let confidence = 0.5;
  if (outcomeStatus === "success") {
    confidence = 0.9;
  } else if (outcomeStatus === "partial") {
    confidence = visibleOutput ? 0.62 : 0.54;
  } else if (outcomeStatus === "blocked") {
    confidence = 0.38;
  } else if (outcomeStatus === "failed") {
    confidence = 0.18;
  }
  if (artifactQuality === "valid") {
    confidence += 0.05;
  } else if (artifactQuality === "invalid") {
    confidence -= 0.08;
  } else if (artifactQuality === "unknown") {
    confidence -= 0.03;
  }
  return Math.max(0, Math.min(1, Number(confidence.toFixed(4))));
}

export function scoreExecutionOutcome({
  stepStatus = "",
  requiredSlots = [],
  missingSlots = [],
  artifactsProducedCount = 0,
  error = "",
  failureClass = "",
  readiness = null,
  recoveryAction = "",
  recoveryPolicy = "",
  artifactQualityHint = "",
  artifactValidityStatus = "",
  hasUserVisibleOutputFlag = null,
  userVisibleAnswer = "",
  userVisibleSources = [],
  userVisibleLimitations = [],
} = {}) {
  const normalizedReadiness = toObject(readiness);
  const normalizedRequiredSlots = uniqueStrings(requiredSlots);
  const normalizedMissingSlots = uniqueStrings(missingSlots);
  const requiredSlotSet = new Set(normalizedRequiredSlots);
  const missingRequiredSlots = normalizedRequiredSlots.filter((slotKey) =>
    normalizedMissingSlots.includes(slotKey));
  const slotsMissingCount = requiredSlotSet.size > 0
    ? missingRequiredSlots.length
    : normalizedMissingSlots.length;
  const slotsFilledCount = requiredSlotSet.size > 0
    ? Math.max(0, requiredSlotSet.size - slotsMissingCount)
    : 0;
  const producedCount = normalizeNonNegativeInteger(artifactsProducedCount) ?? 0;
  const blockingReasons = uniqueStrings(normalizedReadiness?.blocking_reason_codes);
  const errorTags = uniqueStrings([
    classifyErrorTag(error),
    classifyErrorTag(failureClass),
    ...blockingReasons.map((reason) => classifyErrorTag(reason)),
  ]);
  const normalizedRecoveryAction = cleanText(recoveryAction || "");
  const normalizedRecoveryPolicy = cleanText(recoveryPolicy || "");
  const recoveryActionsTaken = uniqueStrings([
    normalizedRecoveryAction,
    normalizedRecoveryPolicy,
  ]);
  const artifactQuality = scoreArtifactQuality({
    artifactQualityHint,
    artifactValidityStatus,
    readinessInvalidArtifacts: normalizedReadiness?.invalid_artifacts,
    artifactsProducedCount: producedCount,
  });
  const normalizedStepStatus = cleanText(stepStatus || "");
  const nonTerminalRecoveryActions = new Set([
    "retry_same_step",
    "reroute_owner",
    "rollback_to_step",
    "skip_step",
  ]);
  const readinessBlocked = normalizedReadiness?.is_ready === false
    || normalizedStepStatus === "blocked";
  const terminalFailed = normalizedRecoveryAction === "failed"
    || (normalizedStepStatus === "failed"
      && !nonTerminalRecoveryActions.has(normalizedRecoveryAction || normalizedRecoveryPolicy));
  const allRequiredSlotsFulfilled = slotsMissingCount === 0;
  const noError = errorTags.length === 0;
  let outcomeStatus = "partial";
  if (terminalFailed) {
    outcomeStatus = "failed";
  } else if (readinessBlocked) {
    outcomeStatus = "blocked";
  } else if (normalizedStepStatus === "completed" && allRequiredSlotsFulfilled && noError) {
    outcomeStatus = "success";
  }
  const visibleOutput = hasUserVisibleOutput({
    hasUserVisibleOutputFlag,
    userVisibleAnswer,
    userVisibleSources,
    userVisibleLimitations,
  });
  const userVisibleCompleteness = outcomeStatus === "success"
    ? "complete"
    : visibleOutput || (outcomeStatus === "partial" && (slotsFilledCount > 0 || producedCount > 0))
      ? "partial"
      : "none";
  let retryWorthiness = false;
  if (errorTags.includes("missing_slot") || errorTags.includes("invalid_artifact") || errorTags.includes("unknown")) {
    retryWorthiness = false;
  } else if ((errorTags.includes("tool_error") || errorTags.includes("timeout")) && artifactQuality !== "invalid") {
    retryWorthiness = true;
  }
  const candidate = normalizeExecutionOutcome({
    outcome_status: outcomeStatus,
    outcome_confidence: scoreOutcomeConfidence({
      outcomeStatus,
      artifactQuality,
      visibleOutput,
    }),
    outcome_evidence: {
      slots_filled_count: slotsFilledCount,
      slots_missing_count: slotsMissingCount,
      artifacts_produced_count: producedCount,
      errors_encountered: errorTags,
      recovery_actions_taken: recoveryActionsTaken,
    },
    artifact_quality: artifactQuality,
    retry_worthiness: retryWorthiness,
    user_visible_completeness: userVisibleCompleteness,
  }, { allowNull: false });
  return candidate || buildFailClosedOutcome();
}

export function buildExecutionOutcomeObservability(outcome = null) {
  const normalized = normalizeExecutionOutcome(outcome, { allowNull: true });
  if (!normalized) {
    return {
      outcome_status: null,
      outcome_confidence: null,
      outcome_evidence: null,
      artifact_quality: null,
      retry_worthiness: null,
      user_visible_completeness: null,
    };
  }
  return {
    outcome_status: normalized.outcome_status,
    outcome_confidence: normalized.outcome_confidence,
    outcome_evidence: normalized.outcome_evidence,
    artifact_quality: normalized.artifact_quality,
    retry_worthiness: normalized.retry_worthiness,
    user_visible_completeness: normalized.user_visible_completeness,
  };
}
