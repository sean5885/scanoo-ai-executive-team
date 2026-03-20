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

export function buildExecutionEvidence({
  reply = null,
  supportingOutputs = [],
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const evidence = [];
  if (reply?.metadata?.retrieval_count > 0) {
    evidence.push({
      type: EVIDENCE_TYPES.tool_output,
      summary: `retrieved_sources:${reply.metadata.retrieval_count}`,
    });
  }
  if (reply?.text) {
    evidence.push({
      type: EVIDENCE_TYPES.summary_generated,
      summary: "reply_text_present",
    });
    evidence.push({
      type: EVIDENCE_TYPES.structured_output,
      summary: "text_output_validated",
    });
  }
  if (Array.isArray(supportingOutputs) && supportingOutputs.length) {
    evidence.push({
      type: EVIDENCE_TYPES.tool_output,
      summary: `supporting_agents:${supportingOutputs.length}`,
    });
  }
  if (structuredResult?.knowledge_writeback?.proposal_ids?.length) {
    evidence.push({
      type: EVIDENCE_TYPES.knowledge_proposal_created,
      summary: `knowledge_proposals:${structuredResult.knowledge_writeback.proposal_ids.length}`,
    });
  }
  if (Array.isArray(structuredResult?.action_items) && structuredResult.action_items.length) {
    evidence.push({
      type: EVIDENCE_TYPES.action_items_created,
      summary: `action_items:${structuredResult.action_items.length}`,
    });
  }
  return [...evidence, ...(Array.isArray(extraEvidence) ? extraEvidence : [])];
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
  const evidence = buildExecutionEvidence({
    reply: replyText ? { text: replyText } : null,
    structuredResult,
    extraEvidence,
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
  const evidence = buildExecutionEvidence({
    reply,
    supportingOutputs,
    structuredResult,
    extraEvidence,
  });
  for (const item of evidence) {
    current = await appendExecutiveTaskEvidence(task.id, item);
  }

  const verification = verifyTaskCompletion({
    taskType: current?.task_type || task.task_type,
    replyText: reply?.text || "",
    evidence,
    structuredResult,
    expectedOutputSchema: { text: "string" },
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
