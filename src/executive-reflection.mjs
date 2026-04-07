import { cleanText } from "./message-intent-utils.mjs";

export const EXECUTIVE_ERROR_TAXONOMY = Object.freeze([
  "fake_completion",
  "insufficient_evidence",
  "missing_info",
  "wrong_routing",
  "unnecessary_clarification",
  "over_delegation",
  "under_delegation",
  "robotic_response",
  "overclaim",
  "knowledge_write_error",
  "meeting_extraction_failure",
  "missing_owner",
  "missing_deadline",
  "invalid_output",
  "hallucination",
  "hallucinated_source",
  "unverifiable_claim",
]);

const REFLECTION_MISSING_INFO_FAILURE_TYPES = new Set([
  "missing_access_token",
  "permission_denied",
  "document_not_found",
]);

function normalizeReflectionValues(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
}

function collectReflectionFailureTypes(verification = null) {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return [];
  }

  return normalizeReflectionValues([
    verification.failure_type,
    verification.failureType,
    verification.error_type,
    verification.errorType,
    verification.reason,
    verification.execution_policy_reason,
    verification?.data?.reason,
    ...(Array.isArray(verification.issues) ? verification.issues : []),
  ]);
}

function classifyReflectionReason({ verification = null } = {}) {
  const failureTypes = collectReflectionFailureTypes(verification);
  if (failureTypes.some((item) => REFLECTION_MISSING_INFO_FAILURE_TYPES.has(item))) {
    return "missing_info";
  }
  return "";
}

function detectRoboticResponse(text = "") {
  const normalized = cleanText(text);
  if (!normalized) {
    return false;
  }
  return [
    "任務已啟動",
    "待處理",
    "請提供來源",
    "Executive Team",
    "請直接再問一次",
  ].some((signal) => normalized.includes(signal));
}

export function createReflectionRecord({
  task = null,
  requestText = "",
  replyText = "",
  evidence = [],
  verification = null,
  routing = {},
} = {}) {
  const issues = [];
  const verificationIssues = Array.isArray(verification?.issues) ? verification.issues : [];
  const classifiedReason = classifyReflectionReason({ verification });
  const deviation = classifiedReason === "missing_info";

  if (verification?.fake_completion || verificationIssues.includes("fake_completion")) {
    issues.push("fake_completion");
  }
  if (verificationIssues.includes("insufficient_evidence")) {
    issues.push("insufficient_evidence");
  }
  if (verificationIssues.includes("missing_owner") || verificationIssues.includes("action_item_missing_owner")) {
    issues.push("missing_owner");
  }
  if (verificationIssues.includes("missing_deadline") || verificationIssues.includes("deadline_missing")) {
    issues.push("missing_deadline");
  }
  if (verificationIssues.includes("schema_invalid") || verificationIssues.includes("broken_output_schema")) {
    issues.push("invalid_output");
  }
  if (verificationIssues.includes("overclaim") || verification?.overclaim) {
    issues.push("overclaim");
  }
  if (detectRoboticResponse(replyText)) {
    issues.push("robotic_response");
  }
  if (routing?.expected_agent_id && routing?.actual_agent_id && routing.expected_agent_id !== routing.actual_agent_id) {
    issues.push("wrong_routing");
  }
  if (classifiedReason === "missing_info") {
    issues.push("missing_info");
  }

  const normalizedIssues = normalizeReflectionValues(issues);

  return {
    task_id: cleanText(task?.id),
    lifecycle_state: cleanText(task?.lifecycle_state),
    task_type: cleanText(task?.task_type),
    task_input: cleanText(requestText),
    action_taken: cleanText(replyText).slice(0, 1200),
    evidence_collected: (Array.isArray(evidence) ? evidence : []).map((item) => ({
      type: cleanText(item?.type),
      summary: cleanText(item?.summary),
    })),
    verification_result: verification || null,
    what_went_wrong: normalizedIssues,
    missing_elements: verificationIssues,
    rule_should_have_caught: normalizedIssues.map((item) => `rule:${item}`),
    routing_quality: {
      expected_agent_id: cleanText(routing?.expected_agent_id),
      actual_agent_id: cleanText(routing?.actual_agent_id),
      correct: !(routing?.expected_agent_id && routing?.actual_agent_id) || routing.expected_agent_id === routing.actual_agent_id,
    },
    response_quality: {
      robotic_response: normalizedIssues.includes("robotic_response"),
      direct_enough: !normalizedIssues.includes("robotic_response"),
    },
    reason: classifiedReason || "",
    deviation,
    error_type: classifiedReason || normalizedIssues[0] || "",
    should_improve_next_time: normalizedIssues.length > 0,
    created_at: new Date().toISOString(),
  };
}
