import { cleanText } from "./message-intent-utils.mjs";

const ESCALATE_FAILURE_CLASSES = new Set([
  "effect_committed",
  "commit_unknown",
  "permission_denied",
]);
const CANDIDATE_SEARCH_KINDS = new Set([
  "route",
  "tool",
  "prompt",
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

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, numeric);
}

function normalizeRecoveryCandidate(candidate = null, index = 0) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const action = cleanText(candidate.action || "");
  if (!action) {
    return null;
  }
  const kind = cleanText(candidate.kind || "").toLowerCase();
  return {
    id: cleanText(candidate.id || "") || `candidate_${index + 1}`,
    kind: CANDIDATE_SEARCH_KINDS.has(kind) ? kind : "route",
    action,
    score: normalizeScore(candidate.score, 0),
    reason: cleanText(candidate.reason || "") || null,
  };
}

function normalizeRecoveryCandidates(candidates = null) {
  if (!Array.isArray(candidates)) {
    return [];
  }
  const normalized = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const parsed = normalizeRecoveryCandidate(candidates[index], index);
    if (parsed) {
      normalized.push(parsed);
    }
  }
  return normalized;
}

function resolveCandidateSelection({
  candidates = [],
  candidateSelection = null,
} = {}) {
  const normalizedCandidates = normalizeRecoveryCandidates(candidates);
  if (normalizedCandidates.length === 0) {
    return {
      candidates: [],
      selected_candidate: null,
    };
  }
  const normalizedSelection = candidateSelection && typeof candidateSelection === "object" && !Array.isArray(candidateSelection)
    ? candidateSelection
    : null;
  const selectedCandidateId = cleanText(normalizedSelection?.candidate_id || "");
  const explicitSelection = selectedCandidateId
    ? normalizedCandidates.find((candidate) => candidate.id === selectedCandidateId) || null
    : null;
  const scoredSelection = [...normalizedCandidates]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.id.localeCompare(right.id);
    })[0] || null;
  return {
    candidates: normalizedCandidates,
    selected_candidate: explicitSelection || scoredSelection,
  };
}

function buildDecisionBasis({
  whySearch = "",
  whyRetry = "",
  candidateCount = 0,
  selectedCandidate = null,
} = {}) {
  return {
    why_search: cleanText(whySearch || "") || null,
    why_retry: cleanText(whyRetry || "") || null,
    candidate_count: normalizeCount(candidateCount, 0),
    selected_candidate_id: cleanText(selectedCandidate?.id || "") || null,
    selected_candidate_kind: cleanText(selectedCandidate?.kind || "") || null,
    selected_candidate_action: cleanText(selectedCandidate?.action || "") || null,
    selected_candidate_score: Number.isFinite(Number(selectedCandidate?.score))
      ? Number(selectedCandidate.score)
      : null,
  };
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
  recovery_candidates = null,
  candidate_selection = null,
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
  const candidateResolution = resolveCandidateSelection({
    candidates: recovery_candidates,
    candidateSelection: candidate_selection,
  });
  const candidateCount = candidateResolution.candidates.length;
  const selectedCandidate = candidateResolution.selected_candidate;
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
      recovery_mode: "escalated",
      decision_basis: buildDecisionBasis({
        whySearch: candidateCount > 0 ? "search_candidates_blocked_by_non_retryable_failure" : "",
        whyRetry: "retryable_is_false",
        candidateCount,
      }),
    };
  }

  if (candidateCount > 0 && selectedCandidate) {
    return {
      next_state: "executing",
      next_status: "active",
      routing_hint: `${normalizedWorkflow}_search_candidate`,
      reason: "recovery_decision_v1_search_candidate_selected",
      recovery_mode: "search_candidate",
      decision_basis: buildDecisionBasis({
        whySearch: selectedCandidate.reason || "candidate_score_selected",
        whyRetry: "retry_deferred_because_search_candidate_available",
        candidateCount,
        selectedCandidate,
      }),
      candidate_selection: {
        selected_candidate: selectedCandidate,
        candidates: candidateResolution.candidates,
      },
    };
  }

  if (candidateCount > 0 && !selectedCandidate) {
    return {
      next_state: "blocked",
      next_status: "blocked",
      routing_hint: `${normalizedWorkflow}_blocked_fail_soft`,
      reason: "recovery_decision_v1_candidate_selection_unresolved",
      recovery_mode: "blocked",
      decision_basis: buildDecisionBasis({
        whySearch: "candidate_generation_returned_no_selectable_candidate",
        whyRetry: "retry_suppressed_until_search_candidate_is_selected",
        candidateCount,
      }),
    };
  }

  if (retryCount < maxRetries) {
    return {
      next_state: "executing",
      next_status: "active",
      routing_hint: `${normalizedWorkflow}_resume_same_task`,
      reason: "recovery_decision_v1_retrying",
      recovery_mode: "retry",
      decision_basis: buildDecisionBasis({
        whyRetry: "no_recovery_candidates_available",
      }),
    };
  }

  if (cleanText(verification?.execution_policy_state || "") === "failed") {
    return {
      next_state: "failed",
      next_status: "failed",
      routing_hint: `${normalizedWorkflow}_failed_fail_soft`,
      reason: "recovery_decision_v1_retry_budget_exhausted_failed",
      recovery_mode: "failed",
      decision_basis: buildDecisionBasis({
        whyRetry: "retry_budget_exhausted",
      }),
    };
  }

  return {
    next_state: "blocked",
    next_status: "blocked",
    routing_hint: `${normalizedWorkflow}_blocked_fail_soft`,
    reason: "recovery_decision_v1_retry_budget_exhausted_blocked",
    recovery_mode: "blocked",
    decision_basis: buildDecisionBasis({
      whyRetry: "retry_budget_exhausted",
    }),
  };
}
