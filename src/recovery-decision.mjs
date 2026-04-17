import { cleanText } from "./message-intent-utils.mjs";

const ESCALATE_FAILURE_CLASSES = new Set([
  "effect_committed",
  "commit_unknown",
  "permission_denied",
]);

function normalizeCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.floor(numeric));
}

function normalizeBoolean(value, fallback = null) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function extractNormalizedError({
  error = "",
  verification = null,
} = {}) {
  const verificationReason = cleanText(verification?.execution_policy_reason || "");
  return cleanText(error || verificationReason).toLowerCase();
}

function extractNormalizedFailureClass({
  failureClass = "",
  error = "",
  verification = null,
} = {}) {
  const normalizedFailureClass = cleanText(failureClass).toLowerCase();
  if (normalizedFailureClass) {
    return normalizedFailureClass;
  }
  const normalizedError = extractNormalizedError({
    error,
    verification,
  });
  if (!normalizedError) {
    return "";
  }
  if (normalizedError.includes("missing_slot")) {
    return "missing_slot";
  }
  if (normalizedError.includes("permission_denied")) {
    return "permission_denied";
  }
  if (normalizedError.includes("effect_committed")) {
    return "effect_committed";
  }
  if (normalizedError.includes("commit_unknown")) {
    return "commit_unknown";
  }
  return "";
}

function resolveRetryable({
  retryable = null,
  failureClass = "",
  verification = null,
} = {}) {
  const normalized = normalizeBoolean(retryable, null);
  if (normalized !== null) {
    return normalized;
  }
  if (failureClass && ESCALATE_FAILURE_CLASSES.has(failureClass)) {
    return false;
  }
  if (cleanText(verification?.execution_policy_state || "") === "failed") {
    return false;
  }
  return true;
}

function hasMissingSlot({
  failureClass = "",
  error = "",
  verification = null,
} = {}) {
  if (failureClass === "missing_slot") {
    return true;
  }
  const normalizedError = extractNormalizedError({
    error,
    verification,
  });
  if (normalizedError.includes("missing_slot")) {
    return true;
  }
  return (Array.isArray(verification?.issues) ? verification.issues : [])
    .map((item) => cleanText(item).toLowerCase())
    .includes("missing_slot");
}

export function resolveRecoveryDecisionV1({
  error = "",
  failure_class = "",
  retryable = null,
  retry_count = 0,
  max_retries = 2,
  workflow = "",
  verification = null,
} = {}) {
  const normalizedWorkflow = cleanText(workflow) || "workflow";
  const normalizedFailureClass = extractNormalizedFailureClass({
    failureClass: failure_class,
    error,
    verification,
  });
  const normalizedRetryable = resolveRetryable({
    retryable,
    failureClass: normalizedFailureClass,
    verification,
  });
  const retryCount = normalizeCount(retry_count, 0);
  const maxRetries = Math.max(1, normalizeCount(max_retries, 2));

  if (hasMissingSlot({
    failureClass: normalizedFailureClass,
    error,
    verification,
  })) {
    return {
      next_state: "blocked",
      next_status: "blocked",
      routing_hint: `${normalizedWorkflow}_waiting_user`,
      reason: "recovery_decision_v1_missing_slot_waiting_user",
    };
  }

  if (
    normalizedFailureClass
    && ESCALATE_FAILURE_CLASSES.has(normalizedFailureClass)
  ) {
    return {
      next_state: "escalated",
      next_status: "escalated",
      routing_hint: `${normalizedWorkflow}_escalated`,
      reason: `recovery_decision_v1_${normalizedFailureClass}`,
    };
  }

  if (normalizedRetryable === false) {
    return {
      next_state: "escalated",
      next_status: "escalated",
      routing_hint: `${normalizedWorkflow}_escalated`,
      reason: "recovery_decision_v1_non_retryable",
    };
  }

  if (retryCount < maxRetries) {
    return {
      next_state: "executing",
      next_status: "active",
      routing_hint: `${normalizedWorkflow}_resume_same_task`,
      reason: "recovery_decision_v1_retrying",
    };
  }

  if (cleanText(verification?.execution_policy_state || "") === "failed") {
    return {
      next_state: "failed",
      next_status: "failed",
      routing_hint: `${normalizedWorkflow}_failed_fail_soft`,
      reason: "recovery_decision_v1_retry_budget_exhausted_failed",
    };
  }

  return {
    next_state: "blocked",
    next_status: "blocked",
    routing_hint: `${normalizedWorkflow}_blocked_fail_soft`,
    reason: "recovery_decision_v1_retry_budget_exhausted_blocked",
  };
}
