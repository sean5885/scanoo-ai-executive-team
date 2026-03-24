import { cleanText } from "./message-intent-utils.mjs";

export const EVIDENCE_TYPES = Object.freeze({
  tool_output: "tool_output",
  file_created: "file_created",
  file_updated: "file_updated",
  structured_output: "structured_output",
  summary_generated: "summary_generated",
  action_items_created: "action_items_created",
  knowledge_proposal_created: "knowledge_proposal_created",
  API_call_success: "API_call_success",
  DB_write_confirmed: "DB_write_confirmed",
});

export const VERIFICATION_CHECKLISTS = Object.freeze({
  search: ["has_answer", "has_source_evidence", "no_overclaim"],
  summarize: ["has_answer", "has_structured_summary", "marks_uncertainty_when_needed"],
  knowledge_write: ["has_proposal_or_approved_write", "has_conflict_decision", "verifier_passed"],
  meeting_processing: ["has_structured_output", "has_decisions", "has_action_items", "has_owner_coverage", "has_deadline_coverage_or_open_questions", "has_knowledge_writeback"],
  doc_rewrite: ["has_rewrite_diff", "has_apply_evidence", "preserves_structure"],
  cloud_doc: ["has_scope", "has_preview_or_apply_result", "has_apply_evidence"],
  proposal_creation: ["has_proposal_body", "has_scope", "has_rationale"],
  prd_generation: ["has_background", "has_goal", "has_scope", "has_acceptance", "has_risk"],
  task_assignment: ["has_action_items", "has_owner_coverage"],
  decision_support: ["has_answer", "has_basis", "has_risk_or_next_step"],
});

function evidenceTypeSet(evidence = []) {
  const aliases = new Map([
    ["command_succeeded", EVIDENCE_TYPES.API_call_success],
    ["structured_summary_produced", EVIDENCE_TYPES.summary_generated],
    ["task_item_created", EVIDENCE_TYPES.action_items_created],
    ["database_write_confirmed", EVIDENCE_TYPES.DB_write_confirmed],
    ["api_call_succeeded", EVIDENCE_TYPES.API_call_success],
    ["output_schema_validated", EVIDENCE_TYPES.structured_output],
  ]);
  return new Set(
    (Array.isArray(evidence) ? evidence : []).map((item) => {
      const normalized = cleanText(item?.type);
      return aliases.get(normalized) || normalized;
    }),
  );
}

function countMissingOwners(actionItems = []) {
  return actionItems.filter((item) => !cleanText(item?.owner) || cleanText(item?.owner) === "待確認").length;
}

function countMissingDeadlines(actionItems = []) {
  return actionItems.filter((item) => !cleanText(item?.deadline) || cleanText(item?.deadline) === "待確認").length;
}

function validateBasicSections(text = "", keywords = []) {
  const normalized = cleanText(text);
  return keywords.every((keyword) => normalized.includes(keyword));
}

function buildExecutionJournal({
  executionJournal = null,
  replyText = "",
  evidence = [],
  structuredResult = null,
  expectedOutputSchema = null,
} = {}) {
  if (executionJournal && typeof executionJournal === "object") {
    return {
      classified_intent: cleanText(executionJournal.classified_intent || ""),
      selected_action: cleanText(executionJournal.selected_action || ""),
      dispatched_actions: Array.isArray(executionJournal.dispatched_actions)
        ? executionJournal.dispatched_actions
        : [],
      raw_evidence: Array.isArray(executionJournal.raw_evidence)
        ? executionJournal.raw_evidence
        : [],
      fallback_used: executionJournal.fallback_used === true,
      tool_required: executionJournal.tool_required === true,
      synthetic_agent_hint: executionJournal.synthetic_agent_hint && typeof executionJournal.synthetic_agent_hint === "object"
        ? executionJournal.synthetic_agent_hint
        : null,
      reply_text: cleanText(
        executionJournal.reply_text
        || executionJournal.reply?.text
        || replyText,
      ),
      structured_result:
        executionJournal.structured_result !== undefined
          ? executionJournal.structured_result
          : structuredResult,
      expected_output_schema:
        executionJournal.expected_output_schema !== undefined
          ? executionJournal.expected_output_schema
          : expectedOutputSchema,
    };
  }

  return {
    classified_intent: "",
    selected_action: "",
    dispatched_actions: [],
    raw_evidence: Array.isArray(evidence) ? evidence : [],
    fallback_used: false,
    tool_required: false,
    synthetic_agent_hint: null,
    reply_text: cleanText(replyText),
    structured_result: structuredResult,
    expected_output_schema: expectedOutputSchema,
  };
}

export function verifyTaskCompletion({
  taskType = "search",
  replyText = "",
  evidence = [],
  structuredResult = null,
  expectedOutputSchema = null,
  executionJournal = null,
} = {}) {
  const checklist = VERIFICATION_CHECKLISTS[taskType] || VERIFICATION_CHECKLISTS.search;
  const journal = buildExecutionJournal({
    executionJournal,
    replyText,
    evidence,
    structuredResult,
    expectedOutputSchema,
  });
  const evidenceSet = evidenceTypeSet(journal.raw_evidence);
  const issues = [];
  const normalizedReply = cleanText(journal.reply_text);
  const normalizedStructuredResult = journal.structured_result;
  const normalizedExpectedOutputSchema = journal.expected_output_schema;
  const dispatchedActions = Array.isArray(journal.dispatched_actions) ? journal.dispatched_actions : [];
  const fallbackUsed = journal.fallback_used === true;
  const toolRequired = journal.tool_required === true;

  if (!normalizedReply && !normalizedStructuredResult) {
    issues.push("empty_output");
  }

  if (normalizedExpectedOutputSchema && typeof normalizedExpectedOutputSchema === "object" && !normalizedReply && !normalizedStructuredResult) {
    issues.push("schema_invalid");
  }

  const result = {
    verifier: "rule_based_v1",
    task_type: taskType,
    checklist,
    issues,
    required_evidence_present: true,
    fake_completion: false,
    overclaim: false,
    partial_completion: false,
    execution_policy_state: "clear",
    execution_policy_reason: "",
    pass: false,
  };

  if (toolRequired && dispatchedActions.length === 0) {
    issues.push("tool_dispatch_missing");
    result.required_evidence_present = false;
    result.execution_policy_state = fallbackUsed ? "blocked" : "failed";
    result.execution_policy_reason = fallbackUsed
      ? "tool_required_fallback_without_dispatch"
      : "tool_required_no_dispatch";
  } else if (toolRequired && fallbackUsed) {
    issues.push("tool_required_fallback_blocked");
    result.execution_policy_state = "blocked";
    result.execution_policy_reason = "tool_required_fallback_used";
  }

  if (taskType === "summarize" && !evidenceSet.has(EVIDENCE_TYPES.summary_generated)) {
    issues.push("insufficient_evidence");
    result.required_evidence_present = false;
  }

  if (taskType === "search" || taskType === "decision_support") {
    if (!evidenceSet.has(EVIDENCE_TYPES.tool_output)) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
  }

  if (taskType === "meeting_processing") {
    const actionItems = Array.isArray(normalizedStructuredResult?.action_items) ? normalizedStructuredResult.action_items : [];
    const decisions = Array.isArray(normalizedStructuredResult?.decisions) ? normalizedStructuredResult.decisions : [];
    const knowledgeWriteback = normalizedStructuredResult?.knowledge_writeback;
    if (!normalizedStructuredResult?.summary) {
      issues.push("missing_summary");
    }
    if (!decisions.length) {
      issues.push("missing_decisions");
    }
    if (!actionItems.length) {
      issues.push("missing_action_items");
    }
    if (countMissingOwners(actionItems) > 0) {
      issues.push("missing_owner");
      result.partial_completion = true;
    }
    if (countMissingDeadlines(actionItems) > 0 && !(normalizedStructuredResult?.open_questions || []).length) {
      issues.push("missing_deadline");
      result.partial_completion = true;
    }
    if (!knowledgeWriteback || !Array.isArray(knowledgeWriteback.proposals)) {
      issues.push("missing_knowledge_writeback");
    }
    if (!evidenceSet.has(EVIDENCE_TYPES.summary_generated)) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
  }

  if (taskType === "knowledge_write") {
    if (!evidenceSet.has(EVIDENCE_TYPES.knowledge_proposal_created) && !evidenceSet.has(EVIDENCE_TYPES.DB_write_confirmed)) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
  }

  if (taskType === "doc_rewrite") {
    const patchPlan = Array.isArray(normalizedStructuredResult?.patch_plan) ? normalizedStructuredResult.patch_plan : [];
    const hasDiff = patchPlan.length > 0
      || (Array.isArray(normalizedStructuredResult?.before_excerpt) && Array.isArray(normalizedStructuredResult?.after_excerpt))
      || (cleanText(normalizedStructuredResult?.before_excerpt) && cleanText(normalizedStructuredResult?.after_excerpt));
    if (!hasDiff) {
      issues.push("missing_rewrite_diff");
    }
    if (normalizedStructuredResult?.structure_preserved !== true) {
      issues.push("structure_broken");
      result.partial_completion = true;
    }
    if (!evidenceSet.has(EVIDENCE_TYPES.file_updated) && !evidenceSet.has(EVIDENCE_TYPES.API_call_success)) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
  }

  if (taskType === "cloud_doc") {
    if (!cleanText(normalizedStructuredResult?.scope_key)) {
      issues.push("missing_scope");
    }
    const hasApplyResult = normalizedStructuredResult?.apply_result && typeof normalizedStructuredResult.apply_result === "object";
    const hasPreviewPlan = normalizedStructuredResult?.preview_plan
      && Array.isArray(normalizedStructuredResult.preview_plan.moves)
      && Array.isArray(normalizedStructuredResult.preview_plan.target_folders);
    if (!hasPreviewPlan) {
      issues.push("missing_preview_plan");
    }
    if (!hasApplyResult) {
      issues.push("preview_is_not_completion");
    }
    const hasSkippedOrConflictArrays =
      Array.isArray(normalizedStructuredResult?.skipped_items) || Array.isArray(normalizedStructuredResult?.conflict_items);
    if (!hasSkippedOrConflictArrays) {
      issues.push("missing_skipped_or_conflict_items");
    }
    const hasApplyEvidence = evidenceSet.has(EVIDENCE_TYPES.file_updated) || evidenceSet.has(EVIDENCE_TYPES.API_call_success);
    if (!hasApplyEvidence) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
  }

  if (taskType === "proposal_creation" && !evidenceSet.has(EVIDENCE_TYPES.knowledge_proposal_created)) {
    issues.push("missing_proposal");
    result.required_evidence_present = false;
  }

  if (taskType === "prd_generation" && !validateBasicSections(normalizedReply, ["背景", "目標", "範圍", "驗收"])) {
    issues.push("schema_invalid");
  }
  if (taskType === "prd_generation" && !evidenceSet.has(EVIDENCE_TYPES.summary_generated)) {
    issues.push("insufficient_evidence");
    result.required_evidence_present = false;
  }

  if (taskType === "task_assignment") {
    const actionItems = Array.isArray(normalizedStructuredResult?.action_items) ? normalizedStructuredResult.action_items : [];
    if (!evidenceSet.has(EVIDENCE_TYPES.action_items_created)) {
      issues.push("insufficient_evidence");
      result.required_evidence_present = false;
    }
    if (!actionItems.length) {
      issues.push("missing_action_items");
    }
    if (countMissingOwners(actionItems) > 0) {
      issues.push("missing_owner");
    }
  }

  const completionClaimed = /已完成|已寫入|已更新|已建立|完成了|已經查完|我已查完|已整理完成/u.test(normalizedReply);
  if (completionClaimed && !result.required_evidence_present) {
    result.fake_completion = true;
    issues.push("fake_completion");
  }

  result.overclaim = /一定|已確認|完全沒有問題/u.test(normalizedReply) && issues.includes("insufficient_evidence");
  if (result.overclaim) {
    issues.push("overclaim");
  }

  result.pass = issues.length === 0 && result.execution_policy_state === "clear";
  return result;
}

export function verifyMeetingWorkflowCompletion({
  summaryContent = "",
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  return verifyTaskCompletion({
    taskType: "meeting_processing",
    replyText: summaryContent,
    structuredResult,
    expectedOutputSchema: {
      summary: "string",
      decisions: "array",
      action_items: "array",
    },
    evidence: [
      {
        type: EVIDENCE_TYPES.summary_generated,
        summary: "meeting_summary",
      },
      {
        type: EVIDENCE_TYPES.structured_output,
        summary: "meeting_structured_result",
      },
      ...(Array.isArray(extraEvidence) ? extraEvidence : []),
    ],
  });
}

export function verifyDocRewriteWorkflowCompletion({
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  return verifyTaskCompletion({
    taskType: "doc_rewrite",
    replyText: "",
    structuredResult,
    expectedOutputSchema: {
      patch_plan: "array",
      structure_preserved: "boolean",
    },
    evidence: [...(Array.isArray(extraEvidence) ? extraEvidence : [])],
  });
}

export function verifyCloudDocWorkflowCompletion({
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  return verifyTaskCompletion({
    taskType: "cloud_doc",
    replyText: "",
    structuredResult,
    expectedOutputSchema: {
      scope_key: "string",
    },
    evidence: [...(Array.isArray(extraEvidence) ? extraEvidence : [])],
  });
}
