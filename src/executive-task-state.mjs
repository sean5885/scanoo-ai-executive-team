import crypto from "node:crypto";

import { executiveTaskStateStorePath } from "./config.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const ACTIVE_TASK_TTL_MS = 6 * 60 * 60 * 1000;
let inMemoryStoreOverride = null;

function createStore() {
  return {
    tasks: {},
    active_by_session: {},
  };
}

function cloneStore(store = createStore()) {
  return {
    tasks: Object.fromEntries(
      Object.entries(store?.tasks || {}).map(([key, value]) => [key, { ...value }]),
    ),
    active_by_session: { ...(store?.active_by_session || {}) },
  };
}

function normalizeList(items = [], limit = 8) {
  const values = Array.isArray(items) ? items : [];
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const normalized = normalizeText(item);
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

function normalizeExecutionJournal(journal = {}) {
  if (!journal || typeof journal !== "object") {
    return null;
  }

  const rawEvidence = Array.isArray(journal.raw_evidence)
    ? journal.raw_evidence
        .map((item) => ({
          type: normalizeText(item?.type),
          source: normalizeText(item?.source),
          summary: normalizeText(item?.summary),
          status: normalizeText(item?.status || ""),
        }))
        .filter((item) => item.type || item.source || item.summary)
        .slice(-24)
    : [];
  const dispatchedActions = Array.isArray(journal.dispatched_actions)
    ? journal.dispatched_actions
        .map((item) =>
          typeof item === "string"
            ? {
                action: normalizeText(item),
                target: "",
                status: "",
              }
            : {
                action: normalizeText(item?.action),
                target: normalizeText(item?.target || ""),
                status: normalizeText(item?.status || ""),
              })
        .filter((item) => item.action)
        .slice(-12)
    : [];
  const verifierVerdict = journal.verifier_verdict && typeof journal.verifier_verdict === "object"
    ? {
        pass: journal.verifier_verdict.pass === true,
        issues: normalizeList(journal.verifier_verdict.issues || [], 12),
        execution_policy_state: normalizeText(journal.verifier_verdict.execution_policy_state || ""),
        execution_policy_reason: normalizeText(journal.verifier_verdict.execution_policy_reason || ""),
        at: journal.verifier_verdict.at || nowIso(),
      }
    : null;
  const syntheticAgentHint = journal.synthetic_agent_hint && typeof journal.synthetic_agent_hint === "object"
    ? {
        agent: normalizeText(journal.synthetic_agent_hint.agent || ""),
        action: normalizeText(journal.synthetic_agent_hint.action || ""),
        status: normalizeText(journal.synthetic_agent_hint.status || ""),
      }
    : null;

  return {
    classified_intent: normalizeText(journal.classified_intent || ""),
    selected_action: normalizeText(journal.selected_action || ""),
    dispatched_actions: dispatchedActions,
    raw_evidence: rawEvidence,
    fallback_used: journal.fallback_used === true,
    tool_required: journal.tool_required === true,
    verifier_verdict: verifierVerdict,
    synthetic_agent_hint: syntheticAgentHint,
  };
}

function normalizeTask(task = {}) {
  return {
    id: normalizeText(task.id),
    account_id: normalizeText(task.account_id),
    session_key: normalizeText(task.session_key),
    chat_id: normalizeText(task.chat_id),
    workflow: normalizeText(task.workflow || "executive") || "executive",
    workflow_state: normalizeText(task.workflow_state || "active") || "active",
    routing_hint: normalizeText(task.routing_hint || ""),
    trace_id: normalizeText(task.trace_id || ""),
    status: normalizeText(task.status || "active") || "active",
    lifecycle_state: normalizeText(task.lifecycle_state || "created") || "created",
    task_type: normalizeText(task.task_type || "search") || "search",
    objective: normalizeText(task.objective),
    goal: normalizeText(task.goal || task.objective),
    primary_agent_id: normalizeText(task.primary_agent_id),
    current_agent_id: normalizeText(task.current_agent_id || task.primary_agent_id),
    supporting_agent_ids: normalizeList(task.supporting_agent_ids, 2),
    pending_questions: normalizeList(task.pending_questions, 8),
    constraints: normalizeList(task.constraints, 8),
    success_criteria: normalizeList(task.success_criteria, 10),
    failure_criteria: normalizeList(task.failure_criteria, 10),
    evidence_requirements: normalizeList(task.evidence_requirements, 10),
    validation_method: normalizeText(task.validation_method),
    retry_policy: normalizeText(task.retry_policy),
    escalation_policy: normalizeText(task.escalation_policy),
    risk_level: normalizeText(task.risk_level || "medium") || "medium",
    work_plan: Array.isArray(task.work_plan)
      ? task.work_plan
          .map((item) => ({
            agent_id: normalizeText(item?.agent_id),
            task: normalizeText(item?.task),
            selected_action: normalizeText(item?.selected_action || item?.action || ""),
            role: normalizeText(item?.role || ""),
            status: normalizeText(item?.status || "pending") || "pending",
            tool_required: item?.tool_required === true,
          }))
          .filter((item) => item.agent_id && item.task)
          .slice(0, 3)
      : [],
    evidence: Array.isArray(task.evidence)
      ? task.evidence
          .map((item) => ({
            type: normalizeText(item?.type),
            summary: normalizeText(item?.summary),
            status: normalizeText(item?.status || "present") || "present",
            at: item?.at || nowIso(),
          }))
          .filter((item) => item.type)
          .slice(-24)
      : [],
    verifications: Array.isArray(task.verifications)
      ? task.verifications
          .map((item) => ({
            verifier: normalizeText(item?.verifier || "rule_based_v1"),
            task_type: normalizeText(item?.task_type || task.task_type || "search"),
            pass: item?.pass === true,
            issues: normalizeList(item?.issues || [], 12),
            checklist: normalizeList(item?.checklist || [], 12),
            required_evidence_present: item?.required_evidence_present !== false,
            fake_completion: item?.fake_completion === true,
            overclaim: item?.overclaim === true,
            partial_completion: item?.partial_completion === true,
            execution_policy_state: normalizeText(item?.execution_policy_state || ""),
            execution_policy_reason: normalizeText(item?.execution_policy_reason || ""),
            at: item?.at || nowIso(),
          }))
          .slice(-12)
      : [],
    reflections: Array.isArray(task.reflections)
      ? task.reflections
          .map((item) => ({
            created_at: item?.created_at || nowIso(),
            task_type: normalizeText(item?.task_type),
            task_input: normalizeText(item?.task_input || item?.what_was_asked),
            action_taken: normalizeText(item?.action_taken || item?.what_was_done),
            what_went_wrong: normalizeList(item?.what_went_wrong || [], 12),
            missing_elements: normalizeList(item?.missing_elements || item?.what_was_missing || [], 12),
            error_type: normalizeText(item?.error_type),
          }))
          .slice(-12)
      : [],
    improvement_proposals: Array.isArray(task.improvement_proposals)
      ? task.improvement_proposals
          .map((item) => ({
            id: normalizeText(item?.id),
            category: normalizeText(item?.category),
            mode: normalizeText(item?.mode),
            title: normalizeText(item?.title),
            description: normalizeText(item?.description),
            target: normalizeText(item?.target),
            status: normalizeText(item?.status || "proposed") || "proposed",
            decision_actor: normalizeText(item?.decision_actor),
            decision_at: item?.decision_at || null,
            applied_by: normalizeText(item?.applied_by),
            applied_at: item?.applied_at || null,
            created_at: item?.created_at || nowIso(),
          }))
          .filter((item) => item.title)
          .slice(-12)
      : [],
    agent_outputs: Array.isArray(task.agent_outputs)
      ? task.agent_outputs
          .map((item) => ({
            agent_id: normalizeText(item?.agent_id),
            task: normalizeText(item?.task),
            summary: normalizeText(item?.summary),
            status: normalizeText(item?.status || "completed") || "completed",
            at: item?.at || nowIso(),
          }))
          .filter((item) => item.agent_id && item.summary)
          .slice(-12)
      : [],
    turns: Array.isArray(task.turns) ? task.turns.slice(-12) : [],
    handoffs: Array.isArray(task.handoffs) ? task.handoffs.slice(-12) : [],
    execution_journal: normalizeExecutionJournal(task.execution_journal),
    meta: task.meta && typeof task.meta === "object" ? { ...task.meta } : {},
    lifecycle_last_transition:
      task.lifecycle_last_transition && typeof task.lifecycle_last_transition === "object"
        ? { ...task.lifecycle_last_transition }
        : null,
    created_at: task.created_at || nowIso(),
    updated_at: task.updated_at || nowIso(),
  };
}

async function loadStore() {
  if (inMemoryStoreOverride) {
    return cloneStore(inMemoryStoreOverride);
  }
  const raw = await readJsonFile(executiveTaskStateStorePath);
  if (!raw || typeof raw !== "object") {
    return createStore();
  }
  return {
    tasks: raw.tasks && typeof raw.tasks === "object" ? { ...raw.tasks } : {},
    active_by_session:
      raw.active_by_session && typeof raw.active_by_session === "object" ? { ...raw.active_by_session } : {},
  };
}

async function saveStore(store) {
  if (inMemoryStoreOverride) {
    inMemoryStoreOverride = cloneStore(store);
    return;
  }
  await writeJsonFile(executiveTaskStateStorePath, store);
}

export function useInMemoryExecutiveTaskStateStoreForTests() {
  inMemoryStoreOverride = createStore();
}

export async function resetExecutiveTaskStateStoreForTests() {
  if (inMemoryStoreOverride) {
    inMemoryStoreOverride = createStore();
    return;
  }
  await writeJsonFile(executiveTaskStateStorePath, createStore());
}

export function restoreExecutiveTaskStateStoreForTests() {
  inMemoryStoreOverride = null;
}

function sessionIndexKey(accountId = "", sessionKey = "") {
  const account = normalizeText(accountId);
  const session = normalizeText(sessionKey);
  return account && session ? `${account}::${session}` : "";
}

function isExpired(task) {
  const updatedAtMs = Date.parse(task?.updated_at || "");
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }
  return Date.now() - updatedAtMs > ACTIVE_TASK_TTL_MS;
}

export async function getExecutiveTask(taskId = "") {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) {
    return null;
  }
  const store = await loadStore();
  const task = store.tasks[normalizedTaskId];
  return task ? normalizeTask(task) : null;
}

export async function getActiveExecutiveTask(accountId = "", sessionKey = "") {
  const indexKey = sessionIndexKey(accountId, sessionKey);
  if (!indexKey) {
    return null;
  }
  const store = await loadStore();
  const taskId = store.active_by_session[indexKey];
  if (!taskId) {
    return null;
  }
  const task = normalizeTask(store.tasks[taskId] || {});
  if (!task.id || isExpired(task) || task.status !== "active") {
    delete store.active_by_session[indexKey];
    await saveStore(store);
    return null;
  }
  return task;
}

export async function startExecutiveTask({
  accountId,
  sessionKey,
  chatId = "",
  workflow = "executive",
  workflowState = "active",
  routingHint = "",
  traceId = "",
  objective = "",
  primaryAgentId = "",
  currentAgentId = "",
  supportingAgentIds = [],
  pendingQuestions = [],
  constraints = [],
  taskType = "search",
  lifecycleState = "created",
  goal = "",
  successCriteria = [],
  failureCriteria = [],
  evidenceRequirements = [],
  validationMethod = "",
  retryPolicy = "",
  escalationPolicy = "",
  riskLevel = "medium",
  workPlan = [],
  agentOutputs = [],
  meta = {},
} = {}) {
  const account = normalizeText(accountId);
  const session = normalizeText(sessionKey);
  if (!account || !session) {
    return null;
  }
  const store = await loadStore();
  const taskId = crypto.randomUUID();
  const task = normalizeTask({
    id: taskId,
    account_id: account,
    session_key: session,
    chat_id: chatId,
    workflow,
    workflow_state: workflowState,
    routing_hint: routingHint,
    trace_id: traceId,
    objective,
    goal,
    primary_agent_id: primaryAgentId,
    current_agent_id: currentAgentId || primaryAgentId,
    task_type: taskType,
    lifecycle_state: lifecycleState,
    supporting_agent_ids: supportingAgentIds,
    pending_questions: pendingQuestions,
    constraints,
    success_criteria: successCriteria,
    failure_criteria: failureCriteria,
    evidence_requirements: evidenceRequirements,
    validation_method: validationMethod,
    retry_policy: retryPolicy,
    escalation_policy: escalationPolicy,
    risk_level: riskLevel,
    work_plan: workPlan,
    agent_outputs: agentOutputs,
    meta,
  });
  store.tasks[taskId] = task;
  store.active_by_session[sessionIndexKey(account, session)] = taskId;
  await saveStore(store);
  return task;
}

export async function updateExecutiveTask(taskId = "", patch = {}) {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) {
    return null;
  }
  const store = await loadStore();
  const current = normalizeTask(store.tasks[normalizedTaskId] || {});
  if (!current.id) {
    return null;
  }
  const next = normalizeTask({
    ...current,
    ...patch,
    supporting_agent_ids:
      patch.supporting_agent_ids == null
        ? current.supporting_agent_ids
        : patch.supporting_agent_ids,
    pending_questions:
      patch.pending_questions == null
        ? current.pending_questions
        : patch.pending_questions,
    constraints:
      patch.constraints == null
        ? current.constraints
        : patch.constraints,
    work_plan:
      patch.work_plan == null
        ? current.work_plan
        : patch.work_plan,
    agent_outputs:
      patch.agent_outputs == null
        ? current.agent_outputs
        : patch.agent_outputs,
    turns:
      patch.turns == null
        ? current.turns
        : patch.turns,
    handoffs:
      patch.handoffs == null
        ? current.handoffs
        : patch.handoffs,
    execution_journal:
      patch.execution_journal === undefined
        ? current.execution_journal
        : patch.execution_journal,
    meta: {
      ...current.meta,
      ...(patch.meta && typeof patch.meta === "object" ? patch.meta : {}),
    },
    updated_at: nowIso(),
  });
  store.tasks[normalizedTaskId] = next;
  await saveStore(store);
  return next;
}

export async function appendExecutiveTaskTurn(taskId = "", turn = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextTurns = [
    ...task.turns,
    {
      role: normalizeText(turn.role || "user") || "user",
      text: normalizeText(turn.text || ""),
      agent_id: normalizeText(turn.agent_id || ""),
      at: nowIso(),
    },
  ].slice(-12);
  return updateExecutiveTask(taskId, { turns: nextTurns });
}

export async function appendExecutiveTaskHandoff(taskId = "", handoff = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextHandoffs = [
    ...task.handoffs,
    {
      from_agent_id: normalizeText(handoff.from_agent_id || ""),
      to_agent_id: normalizeText(handoff.to_agent_id || ""),
      reason: normalizeText(handoff.reason || ""),
      at: nowIso(),
    },
  ].slice(-12);
  return updateExecutiveTask(taskId, { handoffs: nextHandoffs });
}

export async function appendExecutiveAgentOutput(taskId = "", output = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextOutputs = [
    ...task.agent_outputs,
    {
      agent_id: normalizeText(output.agent_id || ""),
      task: normalizeText(output.task || ""),
      summary: normalizeText(output.summary || ""),
      status: normalizeText(output.status || "completed") || "completed",
      at: nowIso(),
    },
  ]
    .filter((item) => item.agent_id && item.summary)
    .slice(-12);
  return updateExecutiveTask(taskId, { agent_outputs: nextOutputs });
}

export async function appendExecutiveTaskEvidence(taskId = "", evidence = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextEvidence = [
    ...task.evidence,
    {
      type: normalizeText(evidence.type || ""),
      summary: normalizeText(evidence.summary || ""),
      status: normalizeText(evidence.status || "present") || "present",
      at: nowIso(),
    },
  ].filter((item) => item.type).slice(-24);
  return updateExecutiveTask(taskId, { evidence: nextEvidence });
}

export async function appendExecutiveTaskVerification(taskId = "", verification = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextVerifications = [
    ...task.verifications,
    {
      verifier: normalizeText(verification.verifier || "rule_based_v1"),
      task_type: normalizeText(verification.task_type || task.task_type || "search"),
      pass: verification.pass === true,
      issues: normalizeList(verification.issues || [], 12),
      checklist: normalizeList(verification.checklist || [], 12),
      required_evidence_present: verification.required_evidence_present !== false,
      fake_completion: verification.fake_completion === true,
      overclaim: verification.overclaim === true,
      partial_completion: verification.partial_completion === true,
      execution_policy_state: normalizeText(verification.execution_policy_state || ""),
      execution_policy_reason: normalizeText(verification.execution_policy_reason || ""),
      at: nowIso(),
    },
  ].slice(-12);
  return updateExecutiveTask(taskId, { verifications: nextVerifications });
}

export async function appendExecutiveTaskReflection(taskId = "", reflection = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextReflections = [
    ...task.reflections,
    {
      created_at: reflection.created_at || nowIso(),
      task_type: normalizeText(reflection.task_type || task.task_type),
      task_input: normalizeText(reflection.task_input || reflection.what_was_asked || ""),
      action_taken: normalizeText(reflection.action_taken || reflection.what_was_done || ""),
      what_went_wrong: normalizeList(reflection.what_went_wrong || [], 12),
      missing_elements: normalizeList(reflection.missing_elements || reflection.what_was_missing || [], 12),
      error_type: normalizeText(reflection.error_type || ""),
    },
  ].slice(-12);
  return updateExecutiveTask(taskId, { reflections: nextReflections });
}

export async function appendExecutiveTaskImprovementProposal(taskId = "", proposal = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task) {
    return null;
  }
  const nextProposals = [
    ...task.improvement_proposals,
    {
      id: normalizeText(proposal.id || ""),
      category: normalizeText(proposal.category || ""),
      mode: normalizeText(proposal.mode || ""),
      title: normalizeText(proposal.title || ""),
      description: normalizeText(proposal.description || ""),
      target: normalizeText(proposal.target || ""),
      status: normalizeText(proposal.status || "proposed") || "proposed",
      decision_actor: normalizeText(proposal.decision_actor || ""),
      decision_at: proposal.decision_at || null,
      applied_by: normalizeText(proposal.applied_by || ""),
      applied_at: proposal.applied_at || null,
      created_at: proposal.created_at || nowIso(),
    },
  ].filter((item) => item.title).slice(-12);
  return updateExecutiveTask(taskId, { improvement_proposals: nextProposals });
}

export async function updateExecutiveTaskImprovementProposal(taskId = "", proposalId = "", patch = {}) {
  const task = await getExecutiveTask(taskId);
  if (!task || !proposalId) {
    return null;
  }
  const nextProposals = task.improvement_proposals.map((item) => {
    if (normalizeText(item.id) !== normalizeText(proposalId)) {
      return item;
    }
    return {
      ...item,
      status: normalizeText(patch.status || item.status || "proposed") || "proposed",
      decision_actor: normalizeText(patch.decision_actor || item.decision_actor || ""),
      decision_at: patch.decision_at || item.decision_at || null,
      applied_by: normalizeText(patch.applied_by || item.applied_by || ""),
      applied_at: patch.applied_at || item.applied_at || null,
    };
  });
  return updateExecutiveTask(taskId, { improvement_proposals: nextProposals });
}

export async function clearActiveExecutiveTask(accountId = "", sessionKey = "") {
  const indexKey = sessionIndexKey(accountId, sessionKey);
  if (!indexKey) {
    return null;
  }
  const store = await loadStore();
  delete store.active_by_session[indexKey];
  await saveStore(store);
  return true;
}
