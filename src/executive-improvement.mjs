import { cleanText } from "./message-intent-utils.mjs";

export const EXECUTIVE_IMPROVEMENT_TYPES = Object.freeze([
  "prompt_fix",
  "routing_fix",
  "knowledge_gap",
  "retry_strategy",
]);

const RETRYABLE_ERROR_TYPES = new Set([
  "contract_violation",
  "tool_error",
  "runtime_exception",
  "business_error",
  "not_found",
  "permission_denied",
]);

function normalizeList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => cleanText(item))
        .filter(Boolean),
    ),
  );
}

function collectSignals(reflectionResult = null) {
  if (!reflectionResult || typeof reflectionResult !== "object") {
    return {
      issues: [],
      missingElements: [],
      errorType: "",
    };
  }

  const issues = normalizeList([
    ...(Array.isArray(reflectionResult.what_went_wrong) ? reflectionResult.what_went_wrong : []),
    ...(Array.isArray(reflectionResult.verification_result?.issues) ? reflectionResult.verification_result.issues : []),
    cleanText(reflectionResult.error_type),
  ]);

  return {
    issues,
    missingElements: normalizeList(reflectionResult.missing_elements),
    errorType: cleanText(reflectionResult.error_type),
  };
}

function hasAny(signals = [], expected = []) {
  return expected.some((item) => signals.includes(item));
}

function buildMissingElementsSummary(prefix = "", missingElements = []) {
  if (!missingElements.length) {
    return prefix;
  }
  const details = missingElements.slice(0, 3).join(", ");
  return prefix ? `${prefix} Missing: ${details}.` : `Missing: ${details}.`;
}

export function createImprovementProposal(reflection_result = null) {
  const { issues, missingElements, errorType } = collectSignals(reflection_result);
  if (!issues.length && !missingElements.length && !errorType) {
    return null;
  }

  if (hasAny(issues, ["planning_error"])) {
    return {
      type: "prompt_fix",
      summary: "The execution plan did not translate cleanly into a grounded response contract.",
      action_suggestion: "Tighten prompt instructions so the planned task, output contract, and success criteria stay aligned.",
    };
  }

  if (hasAny(issues, ["missing_info"])) {
    return {
      type: "knowledge_gap",
      summary: buildMissingElementsSummary("The run stopped on missing information that still needs verified inputs.", missingElements),
      action_suggestion: "Collect the missing information first and keep the response scoped to verified knowledge until those gaps are closed.",
    };
  }

  if (hasAny(issues, ["tool_failure"])) {
    return {
      type: "retry_strategy",
      summary: buildMissingElementsSummary("The task needs a retry path because a required tool step failed.", missingElements),
      action_suggestion: "Retry the failed tool step with explicit fail-soft handling, validation checks, and a clear stop condition if the dependency stays unavailable.",
    };
  }

  if (hasAny(issues, ["wrong_routing", "under_delegation", "over_delegation"])) {
    return {
      type: "routing_fix",
      summary: "Routing or delegation did not match the task shape.",
      action_suggestion: "Adjust routing hints and delegation thresholds so similar requests stay on the right execution path.",
    };
  }

  if (hasAny(issues, ["robotic_response", "invalid_output", "overclaim", "fake_completion"])) {
    return {
      type: "prompt_fix",
      summary: "Prompt constraints did not keep the response grounded and on-contract.",
      action_suggestion: "Tighten answer-order, completion-gate, and evidence-language instructions for this failure pattern.",
    };
  }

  if (
    RETRYABLE_ERROR_TYPES.has(errorType)
    || hasAny(issues, ["meeting_extraction_failure", "missing_owner", "action_item_missing_owner", "missing_deadline", "deadline_missing"])
    || (missingElements.length && !hasAny(issues, [
      "insufficient_evidence",
      "hallucination",
      "hallucinated_source",
      "unverifiable_claim",
      "knowledge_write_error",
    ]))
    || reflection_result?.verification_result?.pass === false && !hasAny(issues, [
      "insufficient_evidence",
      "hallucination",
      "hallucinated_source",
      "unverifiable_claim",
      "knowledge_write_error",
    ]) && !hasAny(issues, ["robotic_response", "invalid_output", "overclaim", "fake_completion", "wrong_routing", "under_delegation", "over_delegation"])
  ) {
    return {
      type: "retry_strategy",
      summary: buildMissingElementsSummary("The task needs a controlled retry path instead of a one-pass completion.", missingElements),
      action_suggestion: "Retry with explicit validation steps and fail-soft stopping conditions for missing fields, permissions, or tool failures.",
    };
  }

  if (hasAny(issues, [
    "insufficient_evidence",
    "hallucination",
    "hallucinated_source",
    "unverifiable_claim",
    "knowledge_write_error",
  ]) || missingElements.length) {
    return {
      type: "knowledge_gap",
      summary: buildMissingElementsSummary("The run was missing verified knowledge or required evidence.", missingElements),
      action_suggestion: "Gather the missing evidence before answering and keep knowledge writeback proposal-only until verification passes.",
    };
  }

  return {
    type: "prompt_fix",
    summary: "The failure pattern needs a lighter but clearer execution prompt.",
    action_suggestion: "Add a concise instruction that reinforces evidence, output shape, and stop conditions for this case.",
  };
}

function toLegacyWorkflowProposal(improvementProposal = null, reflection = null, task = null) {
  if (!improvementProposal) {
    return null;
  }

  const issues = collectSignals(reflection).issues;

  switch (improvementProposal.type) {
    case "routing_fix":
      return {
        category: "routing_improvement",
        mode: "proposal_only",
        title: "Adjust routing hints",
        description: improvementProposal.action_suggestion,
        target: "lane-executor",
      };
    case "knowledge_gap":
      return {
        category: issues.includes("knowledge_write_error") ? "knowledge_policy_update" : "verification_improvement",
        mode: issues.includes("knowledge_write_error") ? "human_approval" : "proposal_only",
        title: "Close verified knowledge gap",
        description: improvementProposal.action_suggestion,
        target: issues.includes("knowledge_write_error") ? "executive-rules" : "executive-verifier",
      };
    case "retry_strategy":
      return {
        category: cleanText(task?.current_agent_id) === "meeting" || cleanText(task?.task_type).includes("meeting")
          ? "meeting_agent_improvement"
          : "rule_improvement",
        mode: cleanText(task?.current_agent_id) === "meeting" || cleanText(task?.task_type).includes("meeting")
          ? "auto_apply"
          : "proposal_only",
        title: "Add controlled retry path",
        description: improvementProposal.action_suggestion,
        target: cleanText(task?.current_agent_id) === "meeting" || cleanText(task?.task_type).includes("meeting")
          ? "meeting-agent"
          : "executive-rules",
      };
    case "prompt_fix":
    default:
      return {
        category: "prompt_improvement",
        mode: "proposal_only",
        title: "Tighten execution prompt",
        description: improvementProposal.action_suggestion,
        target: "agent-dispatcher",
      };
  }
}

export function createImprovementProposals({ reflection_result = null, reflection = null, task = null } = {}) {
  const sourceReflection = reflection_result || reflection;
  const proposal = createImprovementProposal(sourceReflection);
  const legacyProposal = toLegacyWorkflowProposal(proposal, sourceReflection, task);
  return legacyProposal ? [legacyProposal] : [];
}
