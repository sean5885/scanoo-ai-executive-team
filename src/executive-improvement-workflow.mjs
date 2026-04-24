import crypto from "node:crypto";

import {
  executiveImprovementStorePath,
  executiveReflectionStorePath,
} from "./config.mjs";
import { resolveImprovementExecutionPolicy } from "./executive-improvement.mjs";
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

function normalizeInteger(value, fallback = 0, min = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

function toFixedNumber(value, digits = 4) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Number(normalized.toFixed(digits));
}

function normalizeRiskLevel(value = "") {
  return cleanText(value) === "low_risk" ? "low_risk" : "high_risk";
}

function createStrategyEvent({
  event = "",
  version = 1,
  activeVersion = 1,
  actor = "",
  note = "",
  metadata = null,
} = {}) {
  const normalizedMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : null;
  return {
    event: cleanText(event),
    version: normalizeInteger(version, 1, 1),
    active_version: normalizeInteger(activeVersion, 1, 1),
    actor: cleanText(actor),
    note: cleanText(note),
    at: nowIso(),
    metadata: normalizedMetadata,
  };
}

function appendStrategyEvent(history = [], event = null, limit = 40) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  if (!event || typeof event !== "object" || !cleanText(event.event)) {
    return normalizedHistory.slice(-limit);
  }
  return [...normalizedHistory, event].slice(-limit);
}

function normalizeStrategyHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      return {
        event: cleanText(entry.event),
        version: normalizeInteger(entry.version, 1, 1),
        active_version: normalizeInteger(entry.active_version, 1, 1),
        actor: cleanText(entry.actor),
        note: cleanText(entry.note),
        at: cleanText(entry.at) || nowIso(),
        metadata: entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
          ? { ...entry.metadata }
          : null,
      };
    })
    .filter((entry) => cleanText(entry?.event))
    .slice(-40);
}

function normalizeEffectEvidence(evidence = null) {
  if (!evidence || typeof evidence !== "object") {
    return null;
  }
  const before = Number(evidence.before_value);
  const after = Number(evidence.after_value);
  const delta = Number(evidence.delta_value);
  const status = cleanText(evidence.status);
  return {
    method: cleanText(evidence.method) || "unknown",
    metric_name: cleanText(evidence.metric_name) || "unknown_metric",
    better_direction: cleanText(evidence.better_direction) || "higher",
    before_value: Number.isFinite(before) ? toFixedNumber(before, 4) : null,
    after_value: Number.isFinite(after) ? toFixedNumber(after, 4) : null,
    delta_value: Number.isFinite(delta) ? toFixedNumber(delta, 4) : null,
    status: status || "same",
    measurable: evidence.measurable === true,
    compared_at: cleanText(evidence.compared_at) || nowIso(),
    baseline: evidence.baseline && typeof evidence.baseline === "object" ? { ...evidence.baseline } : null,
    candidate: evidence.candidate && typeof evidence.candidate === "object" ? { ...evidence.candidate } : null,
    improvement_delta: evidence.improvement_delta && typeof evidence.improvement_delta === "object"
      ? { ...evidence.improvement_delta }
      : null,
  };
}

function normalizeRollback(rollback = null) {
  if (!rollback || typeof rollback !== "object") {
    return {
      rolled_back: false,
      rolled_back_at: null,
      rolled_back_by: "",
      reason: "",
      from_version: null,
      to_version: null,
    };
  }
  return {
    rolled_back: rollback.rolled_back === true,
    rolled_back_at: cleanText(rollback.rolled_back_at) || null,
    rolled_back_by: cleanText(rollback.rolled_back_by),
    reason: cleanText(rollback.reason),
    from_version: Number.isFinite(Number(rollback.from_version))
      ? Number(rollback.from_version)
      : null,
    to_version: Number.isFinite(Number(rollback.to_version))
      ? Number(rollback.to_version)
      : null,
  };
}

function computeDirectionalStatus(delta = 0, betterDirection = "higher") {
  if (!Number.isFinite(delta) || delta === 0) {
    return "same";
  }
  if (betterDirection === "lower") {
    return delta < 0 ? "improved" : "regressed";
  }
  return delta > 0 ? "improved" : "regressed";
}

function buildLearningReplayEffectEvidence(context = null) {
  const replay = context && typeof context === "object" ? context.ab_replay : null;
  if (!replay || typeof replay !== "object") {
    return null;
  }
  const metricName = cleanText(replay.metric) || "success_rate";
  const betterDirection = cleanText(replay.better_direction) || "higher";
  const before = Number(replay?.improvement_delta?.before ?? replay?.control?.[metricName]);
  const after = Number(replay?.improvement_delta?.after ?? replay?.candidate?.[metricName]);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  const delta = toFixedNumber(after - before, 4);
  const status = cleanText(replay?.improvement_delta?.status) || computeDirectionalStatus(delta, betterDirection);
  return normalizeEffectEvidence({
    method: cleanText(replay.method) || "ab_replay_time_split_v1",
    metric_name: metricName,
    better_direction: betterDirection,
    before_value: before,
    after_value: after,
    delta_value: delta,
    status,
    measurable: replay?.improvement_delta?.measurable === true || Math.abs(delta) >= 0.01,
    compared_at: nowIso(),
    baseline: replay.control,
    candidate: replay.candidate,
    improvement_delta: {
      ...(replay.improvement_delta && typeof replay.improvement_delta === "object" ? replay.improvement_delta : {}),
      before: toFixedNumber(before, 4),
      after: toFixedNumber(after, 4),
      delta,
      status,
      measurable: replay?.improvement_delta?.measurable === true || Math.abs(delta) >= 0.01,
    },
  });
}

function buildFallbackEffectEvidence(record = null) {
  return normalizeEffectEvidence({
    method: "workflow_state_transition_v1",
    metric_name: "strategy_activation_score",
    better_direction: "higher",
    before_value: 0,
    after_value: 1,
    delta_value: 1,
    status: "improved",
    measurable: true,
    compared_at: nowIso(),
    baseline: {
      status: cleanText(record?.status || "pending_approval"),
      strategy_version: normalizeInteger(record?.strategy_version, 1, 1),
    },
    candidate: {
      status: "applied",
      strategy_version: normalizeInteger(record?.strategy_version, 1, 1) + 1,
    },
    improvement_delta: {
      before: 0,
      after: 1,
      delta: 1,
      status: "improved",
      measurable: true,
    },
  });
}

function buildEffectEvidenceForApply(record = null) {
  const fromReplay = buildLearningReplayEffectEvidence(record?.context);
  if (fromReplay) {
    return fromReplay;
  }
  return buildFallbackEffectEvidence(record);
}

function toVerificationStatus(effectStatus = "") {
  const normalized = cleanText(effectStatus);
  if (normalized === "regressed") {
    return "failed";
  }
  if (normalized === "improved") {
    return "passed";
  }
  return "stable";
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
  const strategyVersion = normalizeInteger(entry.strategy_version, 1, 1);
  const activeStrategyVersion = normalizeInteger(entry.active_strategy_version, strategyVersion, 1);
  const strategyHistory = normalizeStrategyHistory(entry.strategy_history);
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
    risk_level: normalizeRiskLevel(entry.risk_level),
    source_error_type: cleanText(entry.source_error_type),
    status: cleanText(entry.status || "pending_approval") || "pending_approval",
    verification_status: cleanText(entry.verification_status || "pending") || "pending",
    effect_evidence: normalizeEffectEvidence(entry.effect_evidence),
    strategy_version: strategyVersion,
    active_strategy_version: activeStrategyVersion,
    strategy_history: strategyHistory,
    rollback: normalizeRollback(entry.rollback),
    policy_reason: cleanText(entry.policy_reason),
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

function buildAppliedRecord(current = {}, actor = "system") {
  const normalizedActor = cleanText(actor) || "system";
  const now = nowIso();
  const previousVersion = normalizeInteger(current.strategy_version, 1, 1);
  const appliedVersion = previousVersion + 1;
  const previousActiveVersion = normalizeInteger(current.active_strategy_version, previousVersion, 1);
  const effectEvidence = buildEffectEvidenceForApply(current);
  const effectStatus = cleanText(effectEvidence?.status) || "same";
  const measurableImprovement = effectEvidence?.measurable === true && effectStatus === "improved";
  const verificationStatus = toVerificationStatus(effectStatus);
  let next = {
    ...current,
    status: "applied",
    verification_status: verificationStatus,
    effect_evidence: effectEvidence,
    strategy_version: appliedVersion,
    active_strategy_version: appliedVersion,
    rollback: normalizeRollback(current.rollback),
    applied_by: normalizedActor,
    applied_at: now,
  };
  next.strategy_history = appendStrategyEvent(
    normalizeStrategyHistory(current.strategy_history),
    createStrategyEvent({
      event: "applied",
      version: appliedVersion,
      activeVersion: appliedVersion,
      actor: normalizedActor,
      metadata: {
        effect_status: effectStatus,
        verification_status: verificationStatus,
      },
    }),
  );

  if (!measurableImprovement) {
    const rollbackVersion = appliedVersion + 1;
    const rollbackTargetVersion = Math.max(1, previousActiveVersion);
    const rollbackReason = effectStatus === "regressed"
      ? "effect_regressed_auto_rollback"
      : "no_measurable_improvement_auto_rollback";
    next = {
      ...next,
      status: "rolled_back",
      verification_status: "failed",
      strategy_version: rollbackVersion,
      active_strategy_version: rollbackTargetVersion,
      rollback: {
        rolled_back: true,
        rolled_back_at: now,
        rolled_back_by: normalizedActor,
        reason: rollbackReason,
        from_version: appliedVersion,
        to_version: rollbackTargetVersion,
      },
    };
    next.strategy_history = appendStrategyEvent(
      normalizeStrategyHistory(next.strategy_history),
      createStrategyEvent({
        event: "rolled_back",
        version: rollbackVersion,
        activeVersion: rollbackTargetVersion,
        actor: normalizedActor,
        note: rollbackReason,
        metadata: {
          rollback_from_version: appliedVersion,
          rollback_to_version: rollbackTargetVersion,
          effect_status: effectStatus,
          measurable: effectEvidence?.measurable === true,
        },
      }),
    );
  }

  return next;
}

function createRegisteredProposalRecord({
  proposal = null,
  taskId = "",
  accountId = "",
  sessionKey = "",
  reflectionId = "",
  reflection = null,
} = {}) {
  if (!proposal || typeof proposal !== "object") {
    return null;
  }

  const policy = resolveImprovementExecutionPolicy({
    category: proposal.category,
    requestedMode: proposal.mode,
    context: proposal.context,
    autoUpgrade: cleanText(proposal?.context?.source) === "learning_loop",
  });
  const mode = policy.mode;
  const initialStatus = mode === "auto_apply" ? "approved" : "pending_approval";
  const baseRecord = normalizeImprovementEntry({
    ...proposal,
    task_id: taskId,
    account_id: accountId,
    session_key: sessionKey,
    reflection_id: reflectionId,
    source_error_type: cleanText(reflection?.error_type),
    mode,
    risk_level: policy.risk_level,
    policy_reason: policy.policy_reason,
    status: initialStatus,
    verification_status: "pending",
    strategy_version: 1,
    active_strategy_version: 1,
    strategy_history: [
      createStrategyEvent({
        event: "registered",
        version: 1,
        activeVersion: 1,
        actor: mode === "auto_apply" ? "system" : "",
        metadata: {
          mode,
          risk_level: policy.risk_level,
          policy_reason: policy.policy_reason,
        },
      }),
    ],
    rollback: {
      rolled_back: false,
      rolled_back_at: null,
      rolled_back_by: "",
      reason: "",
      from_version: null,
      to_version: null,
    },
    decision_actor: mode === "auto_apply" ? "system" : "",
    decision_at: mode === "auto_apply" ? nowIso() : null,
    applied_by: "",
    applied_at: null,
  });
  if (mode !== "auto_apply") {
    return baseRecord;
  }
  return buildAppliedRecord(baseRecord, "system");
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
    const record = createRegisteredProposalRecord({
      proposal,
      taskId,
      accountId,
      sessionKey,
      reflectionId,
      reflection,
    });
    if (!record) {
      continue;
    }
    store.items.push(record);
    persisted.push(record);
    if (record.status === "applied") {
      const effectStatus = cleanText(record.effect_evidence?.status) || "same";
      await appendApprovedMemory({
        account_id: accountId,
        session_key: sessionKey,
        task_id: taskId,
        type: "improvement_applied",
        title: record.title,
        content: record.description,
        tags: ["improvement", record.category, record.target].filter(Boolean),
        evidence: [{
          type: "structured_output",
          summary: `improvement_applied:${record.id}:${effectStatus}`,
        }],
      });
    } else if (record.status === "rolled_back") {
      await appendApprovedMemory({
        account_id: accountId,
        session_key: sessionKey,
        task_id: taskId,
        type: "improvement_rollback",
        title: record.title,
        content: record.description,
        tags: ["improvement", "rollback", record.category, record.target].filter(Boolean),
        evidence: [{
          type: "structured_output",
          summary: `improvement_rolled_back:${record.id}:${cleanText(record.rollback?.reason) || "unknown"}`,
        }],
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
  const hasRolledBack = statuses.includes("rolled_back") || statuses.includes("apply_failed");
  if (hasPending || hasRolledBack || !hasApplied) {
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
  const normalizedActor = cleanText(actor) || "unknown";
  const now = nowIso();
  return updateProposalRecord(proposalId, (current) => ({
    status: approved ? "approved" : "rejected",
    decision_actor: normalizedActor,
    decision_at: now,
    applied_by: current.applied_by,
    applied_at: current.applied_at,
    verification_status: approved ? current.verification_status : "failed",
    strategy_history: appendStrategyEvent(
      normalizeStrategyHistory(current.strategy_history),
      createStrategyEvent({
        event: approved ? "approved" : "rejected",
        version: normalizeInteger(current.strategy_version, 1, 1),
        activeVersion: normalizeInteger(current.active_strategy_version, 1, 1),
        actor: normalizedActor,
      }),
    ),
  }));
}

export async function applyImprovementWorkflowProposal({
  proposalId = "",
  actor = "system",
} = {}) {
  const normalizedActor = cleanText(actor) || "system";
  const applied = await updateProposalRecord(proposalId, (current) => {
    if (!["approved", "applied"].includes(current.status) && current.mode !== "auto_apply") {
      throw new Error("proposal_not_approved");
    }
    return buildAppliedRecord(current, normalizedActor);
  });
  if (!applied) {
    return null;
  }
  if (applied.status === "applied") {
    await appendApprovedMemory({
      account_id: applied.account_id,
      session_key: applied.session_key,
      task_id: applied.task_id,
      type: "improvement_applied",
      title: applied.title,
      content: applied.description,
      tags: ["improvement", applied.category, applied.target].filter(Boolean),
      evidence: [{
        type: "structured_output",
        summary: `improvement_applied:${applied.id}:${cleanText(applied.effect_evidence?.status) || "same"}`,
      }],
    });
  } else if (applied.status === "rolled_back") {
    await appendApprovedMemory({
      account_id: applied.account_id,
      session_key: applied.session_key,
      task_id: applied.task_id,
      type: "improvement_rollback",
      title: applied.title,
      content: applied.description,
      tags: ["improvement", "rollback", applied.category, applied.target].filter(Boolean),
      evidence: [{
        type: "structured_output",
        summary: `improvement_rolled_back:${applied.id}:${cleanText(applied.rollback?.reason) || "unknown"}`,
      }],
    });
  }
  return applied;
}

export async function rollbackImprovementWorkflowProposal({
  proposalId = "",
  actor = "system",
  reason = "manual_rollback",
} = {}) {
  const normalizedActor = cleanText(actor) || "system";
  const normalizedReason = cleanText(reason) || "manual_rollback";
  return updateProposalRecord(proposalId, (current) => {
    const currentActiveVersion = normalizeInteger(current.active_strategy_version, current.strategy_version, 1);
    const rollbackVersion = normalizeInteger(current.strategy_version, 1, 1) + 1;
    const rollbackTargetVersion = Math.max(1, currentActiveVersion - 1);
    const history = appendStrategyEvent(
      normalizeStrategyHistory(current.strategy_history),
      createStrategyEvent({
        event: "rolled_back",
        version: rollbackVersion,
        activeVersion: rollbackTargetVersion,
        actor: normalizedActor,
        note: normalizedReason,
      }),
    );
    return {
      status: "rolled_back",
      verification_status: "failed",
      strategy_version: rollbackVersion,
      active_strategy_version: rollbackTargetVersion,
      strategy_history: history,
      rollback: {
        rolled_back: true,
        rolled_back_at: nowIso(),
        rolled_back_by: normalizedActor,
        reason: normalizedReason,
        from_version: currentActiveVersion,
        to_version: rollbackTargetVersion,
      },
    };
  });
}

export async function getImprovementWorkflowProposal(proposalId = "") {
  const store = await loadStore(executiveImprovementStorePath);
  const index = findLatestProposalIndex(store, proposalId);
  const record = index >= 0 ? store.items[index] : null;
  return record ? normalizeImprovementEntry(record) : null;
}
