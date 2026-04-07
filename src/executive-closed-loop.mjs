import {
  appendSessionMemory,
  appendApprovedMemory,
  createPendingKnowledgeProposal,
} from "./executive-memory.mjs";
import { buildLifecycleTransition } from "./executive-lifecycle.mjs";
import {
  archiveExecutiveReflection,
  registerImprovementWorkflowProposals,
} from "./executive-improvement-workflow.mjs";
import { buildTaskRuleSet, inferTaskType, KNOWLEDGE_RULES } from "./executive-rules.mjs";
import { createReflectionRecord } from "./executive-reflection.mjs";
import { createImprovementProposal, createImprovementProposals } from "./executive-improvement.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "./executive-verifier.mjs";
import {
  appendExecutiveTaskEvidence,
  appendExecutiveTaskImprovementProposal,
  appendExecutiveTaskReflection,
  appendExecutiveTaskVerification,
  updateExecutiveTask,
} from "./executive-task-state.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const VALID_EVIDENCE_TYPES = new Set(Object.values(EVIDENCE_TYPES));

function normalizeReflectionList(items = [], limit = 10) {
  const values = Array.isArray(items) ? items : [];
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const normalized = cleanText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function normalizePlannerStepRecord(item = {}, fallbackSuccessCriteria = []) {
  if (typeof item === "string") {
    const intent = cleanText(item);
    if (!intent) {
      return null;
    }
    return {
      intent,
      success_criteria: normalizeReflectionList(fallbackSuccessCriteria, 10),
    };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const intent = cleanText(
    item.intent
    || item.selected_action
    || item.action
    || item.task
    || item.name
    || "",
  );
  const itemSuccessCriteria = Array.isArray(item.success_criteria) && item.success_criteria.length > 0
    ? item.success_criteria
    : Array.isArray(item.successCriteria) && item.successCriteria.length > 0
      ? item.successCriteria
      : Array.isArray(item.criteria) && item.criteria.length > 0
        ? item.criteria
        : fallbackSuccessCriteria;
  const successCriteria = normalizeReflectionList(itemSuccessCriteria, 10);
  if (!intent && !successCriteria.length) {
    return null;
  }

  return {
    intent: intent || "execution_step",
    success_criteria: successCriteria,
  };
}

function buildPlannerStepMetadata({
  task = null,
  plannerSteps = [],
  executionJournal = null,
} = {}) {
  const fallbackSuccessCriteria = normalizeReflectionList(task?.success_criteria || [], 10);
  const explicitSteps = (Array.isArray(plannerSteps) ? plannerSteps : [])
    .map((item) => normalizePlannerStepRecord(item, fallbackSuccessCriteria))
    .filter(Boolean);
  if (explicitSteps.length) {
    return explicitSteps;
  }

  const workPlanSteps = (Array.isArray(task?.work_plan) ? task.work_plan : [])
    .map((item) => normalizePlannerStepRecord({
      intent: item?.intent || item?.selected_action || item?.task || item?.agent_id || "",
      success_criteria: item?.success_criteria || fallbackSuccessCriteria,
    }, fallbackSuccessCriteria))
    .filter(Boolean);
  if (workPlanSteps.length) {
    return workPlanSteps;
  }

  const fallbackIntent = cleanText(
    executionJournal?.selected_action
    || executionJournal?.classified_intent
    || task?.task_type
    || task?.objective
    || "",
  );
  if (!fallbackIntent && !fallbackSuccessCriteria.length) {
    return [];
  }
  return [{
    intent: fallbackIntent || "execution_step",
    success_criteria: fallbackSuccessCriteria,
  }];
}

function normalizeReflectionIntent(value = "") {
  return cleanText(value).toLowerCase();
}

function matchesReflectionIntent(expected = "", actual = "") {
  const normalizedExpected = normalizeReflectionIntent(expected);
  const normalizedActual = normalizeReflectionIntent(actual);
  if (!normalizedExpected || !normalizedActual) {
    return false;
  }
  return normalizedExpected === normalizedActual
    || normalizedExpected.includes(normalizedActual)
    || normalizedActual.includes(normalizedExpected);
}

function findMatchingWorkPlanStep(intent = "", workPlan = []) {
  const items = Array.isArray(workPlan) ? workPlan : [];
  return items.find((item) =>
    matchesReflectionIntent(intent, item?.intent || item?.selected_action || item?.task || item?.agent_id || ""),
  ) || null;
}

function findMatchingDispatchedAction(intent = "", dispatchedActions = []) {
  const items = Array.isArray(dispatchedActions) ? dispatchedActions : [];
  return items.find((item) =>
    matchesReflectionIntent(intent, item?.action || item?.target || ""),
  ) || null;
}

function buildExecutionReflectionSurface({
  executionJournal = null,
} = {}) {
  const journal = executionJournal && typeof executionJournal === "object"
    ? executionJournal
    : {};
  const structuredResult = journal.structured_result && typeof journal.structured_result === "object"
    ? journal.structured_result
    : null;
  const actionItems = Array.isArray(structuredResult?.action_items) ? structuredResult.action_items : [];
  const decisions = Array.isArray(structuredResult?.decisions) ? structuredResult.decisions : [];
  const risks = Array.isArray(structuredResult?.risks) ? structuredResult.risks : [];
  const openQuestions = Array.isArray(structuredResult?.open_questions) ? structuredResult.open_questions : [];
  const nextActions = Array.isArray(structuredResult?.next_actions) ? structuredResult.next_actions : [];
  const rawEvidence = Array.isArray(journal.raw_evidence) ? journal.raw_evidence : [];
  const evidenceTypes = new Set(
    rawEvidence
      .map((item) => cleanText(item?.type || ""))
      .filter(Boolean),
  );
  const textParts = [
    cleanText(journal.reply_text || ""),
    structuredResult ? cleanText(JSON.stringify(structuredResult)) : "",
    ...rawEvidence.map((item) => cleanText(item?.summary || "")),
    ...(Array.isArray(journal.dispatched_actions) ? journal.dispatched_actions.map((item) => cleanText(item?.action || "")) : []),
  ].filter(Boolean);
  const combinedText = textParts.join("\n").toLowerCase();

  return {
    journal,
    structuredResult,
    actionItems,
    decisions,
    risks,
    openQuestions,
    nextActions,
    evidenceTypes,
    combinedText,
    hasReply: Boolean(cleanText(journal.reply_text || "")),
    hasStructuredSummary: Boolean(
      cleanText(structuredResult?.summary || "")
      || cleanText(structuredResult?.answer || ""),
    ),
  };
}

function matchesStructuredCriterion(criterion = "", surface = {}) {
  const normalized = cleanText(criterion).toLowerCase();
  if (!normalized) {
    return true;
  }

  if (normalized.includes("來源") || normalized.includes("證據") || normalized.includes("referenced") || normalized.includes("basis") || normalized.includes("依據")) {
    return surface.evidenceTypes.has(EVIDENCE_TYPES.tool_output)
      || surface.evidenceTypes.has(EVIDENCE_TYPES.structured_output)
      || surface.combinedText.includes("retrieved_sources");
  }

  if (normalized.includes("先回答問題") || normalized.includes("可讀結論") || normalized.includes("has_answer") || normalized.includes("有答案") || normalized.includes("summary 完整")) {
    return surface.hasReply || surface.hasStructuredSummary;
  }

  if (normalized.includes("風險與下一步")) {
    return (
      (surface.risks.length > 0 || surface.combinedText.includes("風險"))
      && (surface.actionItems.length > 0 || surface.nextActions.length > 0 || surface.combinedText.includes("下一步"))
    );
  }

  if (normalized.includes("下一步") || normalized.includes("next_action") || normalized.includes("action items") || normalized.includes("action_item")) {
    return surface.actionItems.length > 0
      || surface.nextActions.length > 0
      || surface.combinedText.includes("下一步");
  }

  if (normalized.includes("風險") || normalized.includes("risk")) {
    return surface.risks.length > 0 || surface.combinedText.includes("風險");
  }

  if (normalized.includes("decision") || normalized.includes("決策")) {
    return surface.decisions.length > 0;
  }

  if (normalized.includes("owner")) {
    return surface.actionItems.length > 0
      && surface.actionItems.every((item) => cleanText(item?.owner || "") && cleanText(item?.owner || "") !== "待確認");
  }

  if (normalized.includes("deadline")) {
    return surface.actionItems.length > 0
      && surface.actionItems.every((item) => cleanText(item?.deadline || "") && cleanText(item?.deadline || "") !== "待確認");
  }

  if (normalized.includes("待確認") || normalized.includes("open question")) {
    return surface.openQuestions.length > 0 || surface.combinedText.includes("待確認");
  }

  if (normalized.includes("理由") || normalized.includes("rationale")) {
    return surface.combinedText.includes("理由")
      || surface.combinedText.includes("因為")
      || Boolean(cleanText(surface.structuredResult?.rationale || ""));
  }

  return surface.combinedText.includes(normalized);
}

function buildSuccessMatch({
  successCriteria = [],
  executionJournal = null,
} = {}) {
  const criteria = normalizeReflectionList(successCriteria, 10);
  if (!criteria.length) {
    return {
      matched: true,
      matched_criteria: [],
      unmet_criteria: [],
    };
  }

  const surface = buildExecutionReflectionSurface({
    executionJournal,
  });
  const matchedCriteria = [];
  const unmetCriteria = [];
  for (const criterion of criteria) {
    if (matchesStructuredCriterion(criterion, surface)) {
      matchedCriteria.push(criterion);
      continue;
    }
    unmetCriteria.push(criterion);
  }

  return {
    matched: unmetCriteria.length === 0,
    matched_criteria: matchedCriteria,
    unmet_criteria: unmetCriteria,
  };
}

function hasMissingInfoSignal({
  executionJournal = null,
  successMatch = null,
} = {}) {
  const surface = buildExecutionReflectionSurface({
    executionJournal,
  });
  const missingMarkers = [
    "待確認",
    "不確定",
    "需要更多資訊",
    "缺少",
    "無法確認",
    "待補",
    "unknown",
    "missing",
    "tbd",
  ];
  if (surface.openQuestions.length > 0) {
    return true;
  }
  if (missingMarkers.some((item) => surface.combinedText.includes(item.toLowerCase()))) {
    return true;
  }
  const unmetCriteria = Array.isArray(successMatch?.unmet_criteria) ? successMatch.unmet_criteria : [];
  return unmetCriteria.some((criterion) => {
    const normalized = cleanText(criterion).toLowerCase();
    return normalized.includes("owner")
      || normalized.includes("deadline")
      || normalized.includes("待確認")
      || normalized.includes("open question")
      || normalized.includes("風險")
      || normalized.includes("risk")
      || normalized.includes("下一步");
  });
}

function resolveStepReason({
  success = false,
  matchedPlanStep = null,
  matchedDispatch = null,
  executionJournal = null,
  successMatch = null,
} = {}) {
  if (success) {
    return "none";
  }
  const planStatus = cleanText(matchedPlanStep?.status || "");
  const dispatchStatus = cleanText(matchedDispatch?.status || "");
  if (planStatus === "failed" || dispatchStatus === "failed") {
    return "tool_failure";
  }
  if (hasMissingInfoSignal({
    executionJournal,
    successMatch,
  })) {
    return "missing_info";
  }
  return "planning_error";
}

function resolveStepDeviation({
  success = false,
  successMatch = null,
  matchedPlanStep = null,
  matchedDispatch = null,
  executionJournal = null,
  isLastStep = false,
} = {}) {
  if (success && executionJournal?.fallback_used === true && isLastStep) {
    return "fallback_used";
  }
  if (success) {
    return "none";
  }
  const planStatus = cleanText(matchedPlanStep?.status || "");
  const dispatchStatus = cleanText(matchedDispatch?.status || "");
  const hasExecutionOutput = Boolean(
    cleanText(executionJournal?.reply_text || "")
    || (executionJournal?.structured_result && typeof executionJournal.structured_result === "object")
    || (Array.isArray(executionJournal?.raw_evidence) && executionJournal.raw_evidence.length > 0),
  );
  if (planStatus === "failed" || dispatchStatus === "failed") {
    return "tool_failure";
  }
  if (!hasExecutionOutput) {
    return "missing_output";
  }
  if (!matchedPlanStep && !matchedDispatch) {
    return "intent_mismatch";
  }
  if (successMatch?.matched === false) {
    return "success_criteria_unmet";
  }
  return "execution_gap";
}

function resolveExecutionReflectionStatus(stepReviews = []) {
  const reviews = Array.isArray(stepReviews) ? stepReviews : [];
  if (!reviews.length) {
    return "failed";
  }
  const successCount = reviews.filter((item) => item.success === true).length;
  const hasDeviation = reviews.some((item) => item.deviation && item.deviation !== "none");
  if (successCount === reviews.length) {
    return hasDeviation ? "success_with_deviation" : "success";
  }
  if (successCount > 0) {
    return "partial_success";
  }
  return "failed";
}

export function buildExecutionReflection({
  task = null,
  plannerSteps = [],
  executionJournal = null,
} = {}) {
  const journal = executionJournal && typeof executionJournal === "object"
    ? executionJournal
    : {};
  const workPlan = Array.isArray(task?.work_plan) ? task.work_plan : [];
  const dispatchedActions = Array.isArray(journal.dispatched_actions)
    ? journal.dispatched_actions
    : [];
  const plannerStepRecords = buildPlannerStepMetadata({
    task,
    plannerSteps: Array.isArray(journal.planner_steps) && journal.planner_steps.length
      ? journal.planner_steps
      : plannerSteps,
    executionJournal: journal,
  });
  const hasExecutionOutput = Boolean(
    cleanText(journal.reply_text || "")
    || (journal.structured_result && typeof journal.structured_result === "object")
    || (Array.isArray(journal.raw_evidence) && journal.raw_evidence.length > 0),
  );

  const stepReviews = plannerStepRecords.map((step, index) => {
    const matchedPlanStep = findMatchingWorkPlanStep(step.intent, workPlan)
      || (plannerStepRecords.length === 1 ? workPlan[0] || null : null);
    const matchedDispatch = findMatchingDispatchedAction(step.intent, dispatchedActions)
      || (plannerStepRecords.length === 1 ? dispatchedActions[0] || null : null);
    const stepStatus = cleanText(matchedPlanStep?.status || "");
    const dispatchStatus = cleanText(matchedDispatch?.status || "");
    const stepFailed = stepStatus === "failed" || dispatchStatus === "failed";

    const successMatch = stepFailed
      ? {
          matched: false,
          matched_criteria: [],
          unmet_criteria: normalizeReflectionList(step.success_criteria, 10),
        }
      : buildSuccessMatch({
          successCriteria: step.success_criteria,
          executionJournal: journal,
        });
    const intentObserved = stepStatus === "completed"
      || (matchedDispatch && dispatchStatus !== "failed")
      || (plannerStepRecords.length === 1 && hasExecutionOutput);
    const success = intentObserved && successMatch.matched === true;
    const deviation = resolveStepDeviation({
      success,
      successMatch,
      matchedPlanStep,
      matchedDispatch,
      executionJournal: journal,
      isLastStep: index === plannerStepRecords.length - 1,
    });
    const reason = resolveStepReason({
      success,
      matchedPlanStep,
      matchedDispatch,
      executionJournal: journal,
      successMatch,
    });

    return {
      intent: step.intent,
      success,
      success_match: successMatch,
      deviation,
      reason,
    };
  });

  return {
    overall_status: resolveExecutionReflectionStatus(stepReviews),
    step_reviews: stepReviews,
  };
}

export function buildTaskInitialization({
  objective = "",
  agentId = "",
  requestText = "",
  workflow = "",
} = {}) {
  const taskType = inferTaskType({ agentId, requestText, workflow });
  const ruleSet = buildTaskRuleSet({
    taskType,
    objective: cleanText(objective) || requestText,
    agentId,
  });
  return {
    task_type: taskType,
    lifecycle_state: "created",
    ...ruleSet,
  };
}

function normalizeDispatchedActionRecord(item = {}) {
  if (typeof item === "string") {
    const action = cleanText(item);
    return action
      ? {
          action,
          target: null,
          status: null,
        }
      : null;
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const action = cleanText(item.action || item.name || "");
  if (!action) {
    return null;
  }

  return {
    action,
    target: cleanText(item.target || item.agent_id || item.tool || "") || null,
    status: cleanText(item.status || "") || null,
  };
}

function normalizeRawEvidenceRecord(item = {}) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const type = cleanText(item.type || "");
  const source = cleanText(item.source || "");
  const summary = cleanText(item.summary || "");
  if (!type && !source && !summary) {
    return null;
  }

  return {
    type: type || null,
    source: source || null,
    summary: summary || null,
    status: cleanText(item.status || "") || null,
  };
}

function buildRawExecutionEvidence({
  reply = null,
  supportingOutputs = [],
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const evidence = Array.isArray(extraEvidence)
    ? extraEvidence.map((item) => normalizeRawEvidenceRecord(item)).filter(Boolean)
    : [];
  if (reply?.metadata?.retrieval_count > 0) {
    evidence.push({
      type: EVIDENCE_TYPES.tool_output,
      summary: `retrieved_sources:${reply.metadata.retrieval_count}`,
      source: "reply_metadata",
    });
  }
  if (reply?.text) {
    evidence.push({
      type: EVIDENCE_TYPES.summary_generated,
      summary: "reply_text_present",
      source: "reply_text",
    });
  }
  if (structuredResult && typeof structuredResult === "object" && !Array.isArray(structuredResult)) {
    evidence.push({
      type: EVIDENCE_TYPES.structured_output,
      summary: "structured_result_present",
      source: "structured_result",
    });
  }
  if (structuredResult?.knowledge_writeback?.proposal_ids?.length) {
    evidence.push({
      type: EVIDENCE_TYPES.knowledge_proposal_created,
      summary: `knowledge_proposals:${structuredResult.knowledge_writeback.proposal_ids.length}`,
      source: "structured_result",
    });
  }
  if (Array.isArray(structuredResult?.action_items) && structuredResult.action_items.length) {
    evidence.push({
      type: EVIDENCE_TYPES.action_items_created,
      summary: `action_items:${structuredResult.action_items.length}`,
      source: "structured_result",
    });
  }
  if (Array.isArray(supportingOutputs) && supportingOutputs.length) {
    evidence.push({
      source: "supporting_outputs",
      summary: `supporting_agents:${supportingOutputs.length}`,
    });
  }
  return evidence;
}

export function buildExecutionJournal({
  classifiedIntent = "",
  selectedAction = "",
  dispatchedActions = [],
  plannerSteps = [],
  reply = null,
  supportingOutputs = [],
  structuredResult = null,
  extraEvidence = [],
  fallbackUsed = false,
  toolRequired = false,
  verifierVerdict = null,
  syntheticAgentHint = null,
  expectedOutputSchema = null,
} = {}) {
  return {
    classified_intent: cleanText(classifiedIntent || ""),
    selected_action: cleanText(selectedAction || ""),
    dispatched_actions: (Array.isArray(dispatchedActions) ? dispatchedActions : [])
      .map((item) => normalizeDispatchedActionRecord(item))
      .filter(Boolean),
    planner_steps: (Array.isArray(plannerSteps) ? plannerSteps : [])
      .map((item) => normalizePlannerStepRecord(item))
      .filter(Boolean),
    raw_evidence: buildRawExecutionEvidence({
      reply,
      supportingOutputs,
      structuredResult,
      extraEvidence,
    }),
    fallback_used: fallbackUsed === true,
    tool_required: toolRequired === true,
    verifier_verdict: verifierVerdict && typeof verifierVerdict === "object"
      ? {
          pass: verifierVerdict.pass === true,
          issues: Array.isArray(verifierVerdict.issues) ? verifierVerdict.issues : [],
          execution_policy_state: cleanText(verifierVerdict.execution_policy_state || ""),
          execution_policy_reason: cleanText(verifierVerdict.execution_policy_reason || ""),
        }
      : null,
    synthetic_agent_hint:
      syntheticAgentHint && typeof syntheticAgentHint === "object"
        ? {
            agent: cleanText(syntheticAgentHint.agent || ""),
            action: cleanText(syntheticAgentHint.action || ""),
            status: cleanText(syntheticAgentHint.status || ""),
          }
        : null,
    reply_text: cleanText(reply?.text || ""),
    structured_result: structuredResult,
    expected_output_schema: expectedOutputSchema,
  };
}

function withVerifierVerdict(executionJournal = null, verifierVerdict = null) {
  return {
    ...executionJournal,
    verifier_verdict: verifierVerdict && typeof verifierVerdict === "object"
      ? {
          pass: verifierVerdict.pass === true,
          issues: Array.isArray(verifierVerdict.issues) ? verifierVerdict.issues : [],
          execution_policy_state: cleanText(verifierVerdict.execution_policy_state || ""),
          execution_policy_reason: cleanText(verifierVerdict.execution_policy_reason || ""),
        }
      : null,
  };
}

function withImprovementProposal(executionJournal = null, improvementProposal = null) {
  return {
    ...(executionJournal && typeof executionJournal === "object" ? executionJournal : {}),
    improvement_proposal:
      improvementProposal && typeof improvementProposal === "object"
        ? {
            type: cleanText(improvementProposal.type || ""),
            summary: cleanText(improvementProposal.summary || ""),
            action_suggestion: cleanText(improvementProposal.action_suggestion || ""),
          }
        : null,
  };
}

export function buildExecutionEvidence({
  executionJournal = null,
} = {}) {
  const rawEvidence = Array.isArray(executionJournal?.raw_evidence)
    ? executionJournal.raw_evidence
    : [];
  return rawEvidence
    .map((item) => normalizeRawEvidenceRecord(item))
    .filter((item) => item?.type && VALID_EVIDENCE_TYPES.has(item.type))
    .map((item) => ({
      type: item.type,
      summary: item.summary || item.type,
      status: item.status || "present",
    }));
}

async function applyLifecycle(task, nextState, reason) {
  const transition = buildLifecycleTransition({
    from: task?.lifecycle_state,
    to: nextState,
    reason,
  });
  if (!transition.ok) {
    return task;
  }
  return updateExecutiveTask(task.id, transition.patch);
}

async function syncTaskStatus(task, status) {
  if (!task?.id || !status) {
    return task;
  }
  return updateExecutiveTask(task.id, { status });
}

export function resolveVerificationOutcome(verification = {}) {
  if (verification?.execution_policy_state === "failed") {
    return {
      nextState: "failed",
      nextStatus: "failed",
      reason: verification.execution_policy_reason || "verification_failed",
    };
  }
  if (verification?.execution_policy_state === "blocked") {
    return {
      nextState: "blocked",
      nextStatus: "blocked",
      reason: verification.execution_policy_reason || "verification_failed",
    };
  }
  if (verification?.pass) {
    return {
      nextState: "completed",
      nextStatus: "completed",
      reason: "verification_passed",
    };
  }
  if (verification?.fake_completion) {
    return {
      nextState: "escalated",
      nextStatus: "escalated",
      reason: "verification_failed",
    };
  }
  if (verification?.required_evidence_present) {
    return {
      nextState: "blocked",
      nextStatus: "blocked",
      reason: "verification_failed",
    };
  }
  return {
    nextState: "executing",
    nextStatus: "retrying",
    reason: "verification_failed",
  };
}

export async function finalizeWorkflowVerificationGate({
  task,
  taskType = "search",
  replyText = "",
  structuredResult = null,
  extraEvidence = [],
  expectedOutputSchema = null,
  plannerSteps = [],
} = {}) {
  if (!task?.id) {
    return null;
  }

  let current = await applyLifecycle(task, "verifying", "workflow returned output");
  const executionJournal = buildExecutionJournal({
    classifiedIntent: taskType,
    selectedAction: cleanText(task?.execution_journal?.selected_action || ""),
    dispatchedActions: task?.execution_journal?.dispatched_actions || [],
    plannerSteps: buildPlannerStepMetadata({
      task,
      plannerSteps,
    }),
    reply: replyText ? { text: replyText } : null,
    supportingOutputs: [],
    structuredResult,
    extraEvidence,
    fallbackUsed: task?.execution_journal?.fallback_used === true,
    toolRequired: task?.execution_journal?.tool_required === true,
    syntheticAgentHint: task?.execution_journal?.synthetic_agent_hint || null,
    expectedOutputSchema,
  });
  const evidence = buildExecutionEvidence({
    executionJournal,
  });
  const executionReflection = buildExecutionReflection({
    task,
    plannerSteps,
    executionJournal,
  });
  current = await updateExecutiveTask(task.id, {
    execution_journal: executionJournal,
    meta: {
      execution_reflection: executionReflection,
    },
  });

  for (const item of evidence) {
    current = await appendExecutiveTaskEvidence(task.id, item);
  }

  const verification = verifyTaskCompletion({
    taskType,
    replyText,
    evidence,
    structuredResult,
    expectedOutputSchema,
  });
  current = await updateExecutiveTask(task.id, {
    execution_journal: withVerifierVerdict(executionJournal, verification),
  });
  current = await appendExecutiveTaskVerification(task.id, verification);

  const outcome = resolveVerificationOutcome(verification);
  current = await applyLifecycle(current || task, outcome.nextState, outcome.reason);
  current = await syncTaskStatus(current || task, outcome.nextStatus);

  return {
    task: current,
    evidence,
    execution_reflection: executionReflection,
    verification,
    outcome,
  };
}

export async function finalizeExecutiveTaskTurn({
  task,
  accountId = "",
  sessionKey = "",
  requestText = "",
  reply = null,
  supportingOutputs = [],
  routing = {},
  structuredResult = null,
  extraEvidence = [],
  plannerSteps = [],
} = {}) {
  if (!task?.id) {
    return null;
  }

  let current = await applyLifecycle(task, "verifying", "executor returned output");
  const toolRequired = (Array.isArray(task?.work_plan) ? task.work_plan : []).some((item) => item?.tool_required === true);
  const plannerStepMetadata = buildPlannerStepMetadata({
    task,
    plannerSteps,
  });
  const executionJournal = buildExecutionJournal({
    classifiedIntent: current?.task_type || task.task_type,
    selectedAction: cleanText(routing?.action || ""),
    dispatchedActions: routing?.dispatched_actions || [],
    plannerSteps: plannerStepMetadata,
    reply,
    supportingOutputs,
    structuredResult,
    extraEvidence,
    fallbackUsed: routing?.fallback_used === true,
    toolRequired,
    syntheticAgentHint: routing?.synthetic_agent_hint || null,
    expectedOutputSchema: { text: "string" },
  });
  const evidence = buildExecutionEvidence({
    executionJournal,
  });
  const executionReflection = buildExecutionReflection({
    task,
    plannerSteps: plannerStepMetadata,
    executionJournal,
  });
  current = await updateExecutiveTask(task.id, {
    execution_journal: executionJournal,
    meta: {
      execution_reflection: executionReflection,
    },
  });
  for (const item of evidence) {
    current = await appendExecutiveTaskEvidence(task.id, item);
  }

  const verification = verifyTaskCompletion({
    taskType: current?.task_type || task.task_type,
    executionJournal,
  });
  current = await updateExecutiveTask(task.id, {
    execution_journal: withVerifierVerdict(executionJournal, verification),
  });
  current = await appendExecutiveTaskVerification(task.id, verification);

  const outcome = resolveVerificationOutcome(verification);
  current = await applyLifecycle(current || task, outcome.nextState, outcome.reason);
  current = await syncTaskStatus(current || task, outcome.nextStatus);

  const reflection = createReflectionRecord({
    task: current || task,
    requestText,
    replyText: reply?.text || "",
    evidence,
    verification,
    routing,
  });
  current = await appendExecutiveTaskReflection(task.id, reflection);
  const archivedReflection = await archiveExecutiveReflection({
    accountId,
    sessionKey,
    taskId: task.id,
    reflection,
  });
  const improvementProposal = createImprovementProposal(reflection);
  current = await updateExecutiveTask(task.id, {
    execution_journal: withImprovementProposal(current?.execution_journal, improvementProposal),
  });
  current = await applyLifecycle(current || task, "reflected", "post_task_review_completed");

  const rawProposals = createImprovementProposals({
    reflection_result: reflection,
    task: current || task,
  });
  const proposals = await registerImprovementWorkflowProposals({
    accountId,
    sessionKey,
    taskId: task.id,
    reflectionId: archivedReflection?.id || "",
    reflection,
    proposals: rawProposals,
  });
  for (const proposal of proposals) {
    current = await appendExecutiveTaskImprovementProposal(task.id, proposal);
  }
  if (proposals.length) {
    current = await applyLifecycle(current || task, "improvement_proposed", "reflection_generated_improvement_proposals");
    if (proposals.every((item) => item.status === "applied")) {
      current = await applyLifecycle(current || task, "improved", "low_risk_improvements_auto_applied");
      current = await syncTaskStatus(current || task, "improved");
    }
  }

  await appendSessionMemory({
    account_id: accountId,
    session_key: sessionKey,
    task_id: task.id,
    type: "working_memory",
    title: cleanText(task.objective).slice(0, 80),
    content: cleanText(reply?.text || "").slice(0, 600),
    evidence: evidence.slice(0, 6),
    tags: [current?.task_type || task.task_type, current?.current_agent_id || task.current_agent_id].filter(Boolean),
  });

  if (current?.task_type === "knowledge_write" && verification.pass && structuredResult?.knowledge_writeback?.approved_items?.length) {
    for (const item of structuredResult.knowledge_writeback.approved_items) {
      await appendApprovedMemory({
        account_id: accountId,
        session_key: sessionKey,
        task_id: task.id,
        type: "approved_memory",
        title: item.title,
        content: item.content,
        evidence,
        tags: item.tags || [],
      });
    }
  }

  return {
    task: current,
    evidence,
    execution_reflection: executionReflection,
    verification,
    reflection,
    archived_reflection: archivedReflection,
    improvement_proposals: proposals,
  };
}

export async function registerKnowledgeWriteback({
  accountId = "",
  sessionKey = "",
  taskId = "",
  writeback = null,
} = {}) {
  if (!writeback || !Array.isArray(writeback.proposals)) {
    return [];
  }
  const result = [];
  for (const item of writeback.proposals) {
    const proposal = await createPendingKnowledgeProposal({
      account_id: accountId,
      session_key: sessionKey,
      task_id: taskId,
      type: "knowledge_proposal",
      title: item.title,
      content: item.content,
      tags: item.tags || [],
      evidence: item.evidence || [],
      requires_approval: KNOWLEDGE_RULES.proposal_required_conditions.length > 0,
    });
    result.push(proposal);
  }
  return result;
}
