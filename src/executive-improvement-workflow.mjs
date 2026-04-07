import crypto from "node:crypto";

import {
  executiveImprovementStorePath,
  executiveReflectionStorePath,
} from "./config.mjs";
import { buildLifecycleTransition } from "./executive-lifecycle.mjs";
import { getExecutiveTask, updateExecutiveTask, updateExecutiveTaskImprovementProposal } from "./executive-task-state.mjs";
import { appendApprovedMemory } from "./executive-memory.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

function nowIso() {
  return new Date().toISOString();
}

function createStore() {
  return { items: [] };
}

async function loadStore(filePath) {
  const raw = await readJsonFile(filePath);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    return createStore();
  }
  return raw;
}

function findLatestProposalIndex(store, proposalId = "") {
  const normalizedProposalId = cleanText(proposalId);
  if (!normalizedProposalId || !Array.isArray(store?.items)) {
    return -1;
  }
  for (let index = store.items.length - 1; index >= 0; index -= 1) {
    if (cleanText(store.items[index]?.id) === normalizedProposalId) {
      return index;
    }
  }
  return -1;
}

async function saveStore(filePath, store) {
  await writeJsonFile(filePath, store);
}

function normalizeReflectionEntry(entry = {}) {
  const executionReflectionSummary =
    entry.execution_reflection_summary && typeof entry.execution_reflection_summary === "object"
      ? {
          overall_status: cleanText(entry.execution_reflection_summary.overall_status || ""),
          total_steps: Number.isFinite(Number(entry.execution_reflection_summary.total_steps))
            ? Number(entry.execution_reflection_summary.total_steps)
            : 0,
          deviated_steps: Number.isFinite(Number(entry.execution_reflection_summary.deviated_steps))
            ? Number(entry.execution_reflection_summary.deviated_steps)
            : 0,
          deviation_rate: Number.isFinite(Number(entry.execution_reflection_summary.deviation_rate))
            ? Number(entry.execution_reflection_summary.deviation_rate)
            : 0,
        }
      : null;
  return {
    id: cleanText(entry.id) || crypto.randomUUID(),
    task_id: cleanText(entry.task_id),
    account_id: cleanText(entry.account_id),
    session_key: cleanText(entry.session_key),
    task_type: cleanText(entry.task_type),
    task_input: cleanText(entry.task_input),
    action_taken: cleanText(entry.action_taken),
    evidence_collected: Array.isArray(entry.evidence_collected) ? entry.evidence_collected.slice(0, 24) : [],
    verification_result: entry.verification_result && typeof entry.verification_result === "object" ? { ...entry.verification_result } : null,
    what_went_wrong: Array.isArray(entry.what_went_wrong) ? entry.what_went_wrong.slice(0, 12) : [],
    missing_elements: Array.isArray(entry.missing_elements) ? entry.missing_elements.slice(0, 12) : [],
    routing_quality: entry.routing_quality && typeof entry.routing_quality === "object" ? { ...entry.routing_quality } : null,
    response_quality: entry.response_quality && typeof entry.response_quality === "object" ? { ...entry.response_quality } : null,
    error_type: cleanText(entry.error_type),
    execution_reflection_summary: executionReflectionSummary,
    improvement_triggered: entry.improvement_triggered === true,
    retry_attempted: entry.retry_attempted === true,
    retry_succeeded: entry.retry_succeeded === true,
    created_at: entry.created_at || nowIso(),
  };
}

function normalizeImprovementEntry(entry = {}) {
  return {
    id: cleanText(entry.id) || crypto.randomUUID(),
    task_id: cleanText(entry.task_id),
    account_id: cleanText(entry.account_id),
    session_key: cleanText(entry.session_key),
    reflection_id: cleanText(entry.reflection_id),
    category: cleanText(entry.category),
    mode: cleanText(entry.mode),
    title: cleanText(entry.title),
    description: cleanText(entry.description),
    target: cleanText(entry.target),
    context: entry.context && typeof entry.context === "object" && !Array.isArray(entry.context)
      ? { ...entry.context }
      : null,
    source_error_type: cleanText(entry.source_error_type),
    status: cleanText(entry.status || "pending_approval") || "pending_approval",
    decision_actor: cleanText(entry.decision_actor),
    decision_at: entry.decision_at || null,
    applied_by: cleanText(entry.applied_by),
    applied_at: entry.applied_at || null,
    created_at: entry.created_at || nowIso(),
    updated_at: entry.updated_at || nowIso(),
  };
}

export async function archiveExecutiveReflection({
  accountId = "",
  sessionKey = "",
  taskId = "",
  reflection = null,
} = {}) {
  if (!reflection || typeof reflection !== "object") {
    return null;
  }
  const store = await loadStore(executiveReflectionStorePath);
  const record = normalizeReflectionEntry({
    ...reflection,
    task_id: taskId || reflection.task_id,
    account_id: accountId,
    session_key: sessionKey,
  });
  store.items = [...store.items, record].slice(-500);
  await saveStore(executiveReflectionStorePath, store);
  return record;
}

export async function registerImprovementWorkflowProposals({
  accountId = "",
  sessionKey = "",
  taskId = "",
  reflectionId = "",
  reflection = null,
  proposals = [],
} = {}) {
  const store = await loadStore(executiveImprovementStorePath);
  const persisted = [];
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const mode = cleanText(proposal.mode);
    const status = mode === "auto_apply" ? "applied" : "pending_approval";
    const record = normalizeImprovementEntry({
      ...proposal,
      task_id: taskId,
      account_id: accountId,
      session_key: sessionKey,
      reflection_id: reflectionId,
      source_error_type: cleanText(reflection?.error_type),
      status,
      decision_actor: mode === "auto_apply" ? "system" : "",
      decision_at: mode === "auto_apply" ? nowIso() : null,
      applied_by: mode === "auto_apply" ? "system" : "",
      applied_at: mode === "auto_apply" ? nowIso() : null,
    });
    store.items.push(record);
    persisted.push(record);
    if (record.status === "applied") {
      await appendApprovedMemory({
        account_id: accountId,
        session_key: sessionKey,
        task_id: taskId,
        type: "improvement_applied",
        title: record.title,
        content: record.description,
        tags: ["improvement", record.category, record.target].filter(Boolean),
        evidence: [{ type: "structured_output", summary: `improvement_applied:${record.id}` }],
      });
    }
  }
  store.items = store.items.slice(-500);
  await saveStore(executiveImprovementStorePath, store);
  return persisted;
}

export async function listImprovementWorkflowProposals({
  accountId = "",
  status = "",
  limit = 50,
} = {}) {
  const store = await loadStore(executiveImprovementStorePath);
  const normalizedAccountId = cleanText(accountId);
  const normalizedStatus = cleanText(status);
  return store.items
    .map((item) => normalizeImprovementEntry(item))
    .filter((item) => (!normalizedAccountId || item.account_id === normalizedAccountId) && (!normalizedStatus || item.status === normalizedStatus))
    .slice(-Math.max(1, limit));
}

async function syncTaskProposalStatus(record) {
  if (!record?.task_id || !record?.id) {
    return null;
  }
  return updateExecutiveTaskImprovementProposal(record.task_id, record.id, {
    status: record.status,
    decision_actor: record.decision_actor,
    decision_at: record.decision_at,
    applied_by: record.applied_by,
    applied_at: record.applied_at,
  });
}

async function syncTaskImprovementLifecycle(taskId = "") {
  const task = await getExecutiveTask(taskId);
  if (!task?.id || !Array.isArray(task.improvement_proposals) || !task.improvement_proposals.length) {
    return task;
  }
  const statuses = task.improvement_proposals.map((item) => cleanText(item.status));
  const hasPending = statuses.includes("pending_approval") || statuses.includes("approved");
  const hasApplied = statuses.includes("applied");
  if (hasPending || !hasApplied) {
    return task;
  }
  const transition = buildLifecycleTransition({
    from: task.lifecycle_state,
    to: "improved",
    reason: "improvement_proposals_applied",
  });
  if (!transition.ok) {
    return task;
  }
  return updateExecutiveTask(task.id, {
    ...transition.patch,
    status: "improved",
  });
}

async function updateProposalRecord(proposalId, updater) {
  const store = await loadStore(executiveImprovementStorePath);
  const index = findLatestProposalIndex(store, proposalId);
  if (index < 0) {
    return null;
  }
  const current = normalizeImprovementEntry(store.items[index]);
  const next = normalizeImprovementEntry({
    ...current,
    ...updater(current),
    updated_at: nowIso(),
  });
  store.items[index] = next;
  await saveStore(executiveImprovementStorePath, store);
  await syncTaskProposalStatus(next);
  await syncTaskImprovementLifecycle(next.task_id);
  return next;
}

export async function resolveImprovementWorkflowProposal({
  proposalId = "",
  approved = false,
  actor = "unknown",
} = {}) {
  return updateProposalRecord(proposalId, (current) => ({
    status: approved ? "approved" : "rejected",
    decision_actor: cleanText(actor) || "unknown",
    decision_at: nowIso(),
    applied_by: current.applied_by,
    applied_at: current.applied_at,
  }));
}

export async function applyImprovementWorkflowProposal({
  proposalId = "",
  actor = "system",
} = {}) {
  const applied = await updateProposalRecord(proposalId, (current) => {
    if (!["approved", "applied"].includes(current.status) && current.mode !== "auto_apply") {
      throw new Error("proposal_not_approved");
    }
    return {
      status: "applied",
      applied_by: cleanText(actor) || "system",
      applied_at: nowIso(),
    };
  });
  if (!applied) {
    return null;
  }
  await appendApprovedMemory({
    account_id: applied.account_id,
    session_key: applied.session_key,
    task_id: applied.task_id,
    type: "improvement_applied",
    title: applied.title,
    content: applied.description,
    tags: ["improvement", applied.category, applied.target].filter(Boolean),
    evidence: [{ type: "structured_output", summary: `improvement_applied:${applied.id}` }],
  });
  return applied;
}

export async function getImprovementWorkflowProposal(proposalId = "") {
  const store = await loadStore(executiveImprovementStorePath);
  const index = findLatestProposalIndex(store, proposalId);
  const record = index >= 0 ? store.items[index] : null;
  return record ? normalizeImprovementEntry(record) : null;
}
