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
import { createImprovementProposals } from "./executive-improvement.mjs";
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
} = {}) {
  if (!task?.id) {
    return null;
  }

  let current = await applyLifecycle(task, "verifying", "workflow returned output");
  const executionJournal = buildExecutionJournal({
    classifiedIntent: taskType,
    selectedAction: cleanText(task?.execution_journal?.selected_action || ""),
    dispatchedActions: task?.execution_journal?.dispatched_actions || [],
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
  current = await updateExecutiveTask(task.id, {
    execution_journal: executionJournal,
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
} = {}) {
  if (!task?.id) {
    return null;
  }

  let current = await applyLifecycle(task, "verifying", "executor returned output");
  const toolRequired = (Array.isArray(task?.work_plan) ? task.work_plan : []).some((item) => item?.tool_required === true);
  const executionJournal = buildExecutionJournal({
    classifiedIntent: current?.task_type || task.task_type,
    selectedAction: cleanText(routing?.action || ""),
    dispatchedActions: routing?.dispatched_actions || [],
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
  current = await updateExecutiveTask(task.id, {
    execution_journal: executionJournal,
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
  current = await applyLifecycle(current || task, "reflected", "post_task_review_completed");

  const rawProposals = createImprovementProposals({
    reflection,
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
