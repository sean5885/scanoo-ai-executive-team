import { cleanText } from "./message-intent-utils.mjs";

const ABANDONED_TASK_PREVIEW_LIMIT = 3;

function normalizeRetryCount(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : 0;
}

function normalizeRetryPolicy(policy = null) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : {};
  const maxRetries = Number(normalizedPolicy.max_retries);
  return {
    max_retries: Number.isFinite(maxRetries) && maxRetries > 0
      ? Math.max(1, Math.floor(maxRetries))
      : 2,
    strategy: cleanText(normalizedPolicy.strategy || "") || "same_agent_then_reroute",
  };
}

function normalizeSlotState(slotState = []) {
  if (!Array.isArray(slotState)) {
    return {
      missing: [],
      filled: [],
      invalid: [],
      map: {},
    };
  }
  const map = {};
  for (const slot of slotState) {
    const slotKey = cleanText(slot?.slot_key || "");
    const status = cleanText(slot?.status || "");
    if (!slotKey || !status) {
      continue;
    }
    map[slotKey] = status;
  }
  const entries = Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  const missing = entries.filter(([, status]) => status === "missing").map(([slotKey]) => slotKey);
  const filled = entries.filter(([, status]) => status === "filled").map(([slotKey]) => slotKey);
  const invalid = entries.filter(([, status]) => status === "invalid").map(([slotKey]) => slotKey);
  return {
    missing,
    filled,
    invalid,
    map,
  };
}

function normalizeAbandonedTaskIds(taskIds = []) {
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds
    .map((taskId) => cleanText(taskId))
    .filter(Boolean);
}

function summarizeAbandonedTaskIds(taskIds = []) {
  const normalizedTaskIds = normalizeAbandonedTaskIds(taskIds);
  const preview = normalizedTaskIds.slice(-ABANDONED_TASK_PREVIEW_LIMIT);
  return {
    all: normalizedTaskIds,
    preview,
    hidden_count: Math.max(0, normalizedTaskIds.length - preview.length),
  };
}

function toSnapshot(memorySnapshot = null) {
  const snapshot = memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)
    ? memorySnapshot
    : {};
  const retryPolicy = normalizeRetryPolicy(snapshot.retry_policy);
  const slotState = normalizeSlotState(snapshot.slot_state);
  const abandonedTaskIds = summarizeAbandonedTaskIds(snapshot.abandoned_task_ids);
  return {
    task_id: cleanText(snapshot.task_id || "") || null,
    task_type: cleanText(snapshot.task_type || snapshot.inferred_task_type || "") || null,
    task_phase: cleanText(snapshot.task_phase || "") || "init",
    task_status: cleanText(snapshot.task_status || "") || "running",
    current_owner_agent: cleanText(snapshot.current_owner_agent || snapshot.last_selected_agent || "") || null,
    previous_owner_agent: cleanText(snapshot.previous_owner_agent || "") || null,
    handoff_reason: cleanText(snapshot.handoff_reason || "") || null,
    retry_count: normalizeRetryCount(snapshot.retry_count),
    retry_policy: retryPolicy,
    next_best_action: cleanText(snapshot.next_best_action || "") || null,
    slot_state: {
      missing: slotState.missing,
      filled: slotState.filled,
      invalid: slotState.invalid,
    },
    abandoned_task_ids: abandonedTaskIds.preview,
    abandoned_task_total: abandonedTaskIds.all.length,
    abandoned_task_hidden_count: abandonedTaskIds.hidden_count,
    _slot_map: slotState.map,
  };
}

function formatValue(value = null) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? `[${value.join(", ")}]`
      : "[]";
  }
  return String(value);
}

function parseTransition(transition = "") {
  const normalized = cleanText(transition);
  if (!normalized || !normalized.includes("->")) {
    return null;
  }
  const [fromRaw, toRaw] = normalized.split("->");
  const from = cleanText(fromRaw || "");
  const to = cleanText(toRaw || "");
  if (!from && !to) {
    return null;
  }
  return {
    from: from || "none",
    to: to || "none",
  };
}

function buildDiffLines({
  previousSnapshot = null,
  nextSnapshot = null,
  observability = null,
} = {}) {
  const previous = toSnapshot(previousSnapshot);
  const next = toSnapshot(nextSnapshot);
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const diffLines = [];
  const seen = new Set();
  const addDiffLine = (line = "") => {
    const normalized = cleanText(line);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    diffLines.push(normalized);
  };
  const addFieldDiff = (field, leftValue, rightValue) => {
    if (formatValue(leftValue) === formatValue(rightValue)) {
      return;
    }
    addDiffLine(`${field}: ${formatValue(leftValue)} -> ${formatValue(rightValue)}`);
  };
  const hasDiffPrefix = (prefix = "") => {
    const normalizedPrefix = cleanText(prefix);
    if (!normalizedPrefix) {
      return false;
    }
    return diffLines.some((line) => line.startsWith(normalizedPrefix));
  };

  addFieldDiff("task_id", previous.task_id, next.task_id);
  addFieldDiff("task_type", previous.task_type, next.task_type);
  addFieldDiff("task_phase", previous.task_phase, next.task_phase);
  addFieldDiff("task_status", previous.task_status, next.task_status);
  addFieldDiff("current_owner_agent", previous.current_owner_agent, next.current_owner_agent);
  addFieldDiff("previous_owner_agent", previous.previous_owner_agent, next.previous_owner_agent);
  addFieldDiff("handoff_reason", previous.handoff_reason, next.handoff_reason);
  addFieldDiff("retry_count", previous.retry_count, next.retry_count);
  addFieldDiff("retry_policy.max_retries", previous.retry_policy.max_retries, next.retry_policy.max_retries);
  addFieldDiff("retry_policy.strategy", previous.retry_policy.strategy, next.retry_policy.strategy);
  addFieldDiff("next_best_action", previous.next_best_action, next.next_best_action);
  addFieldDiff("abandoned_task_ids", previous.abandoned_task_ids, next.abandoned_task_ids);

  const slotKeys = Array.from(new Set([
    ...Object.keys(previous._slot_map || {}),
    ...Object.keys(next._slot_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const slotKey of slotKeys) {
    addFieldDiff(`slot.${slotKey}`, previous._slot_map[slotKey] || "none", next._slot_map[slotKey] || "none");
  }

  const phaseTransition = parseTransition(normalizedObservability.task_phase_transition);
  if (phaseTransition) {
    addDiffLine(`task_phase: ${phaseTransition.from} -> ${phaseTransition.to}`);
  }
  const statusTransition = parseTransition(normalizedObservability.task_status_transition);
  if (statusTransition) {
    addDiffLine(`task_status: ${statusTransition.from} -> ${statusTransition.to}`);
  }

  const handoff = normalizedObservability.agent_handoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    addDiffLine(`current_owner_agent: ${formatValue(handoff.from)} -> ${formatValue(handoff.to)}`);
    const reason = cleanText(handoff.reason || "");
    if (reason && !hasDiffPrefix("handoff_reason:")) {
      addDiffLine(`handoff_reason: ${reason}`);
    }
  }

  const retryAttempt = normalizedObservability.retry_attempt;
  if (retryAttempt && typeof retryAttempt === "object" && !Array.isArray(retryAttempt)) {
    if (!hasDiffPrefix("retry_count:")
      && Number.isFinite(Number(retryAttempt.from))
      && Number.isFinite(Number(retryAttempt.to))) {
      addDiffLine(`retry_count: ${Number(retryAttempt.from)} -> ${Number(retryAttempt.to)}`);
    } else if (!hasDiffPrefix("retry_count:") && Number.isFinite(Number(retryAttempt.retry_count))) {
      addDiffLine(`retry_count: ${next.retry_count} -> ${Number(retryAttempt.retry_count)}`);
    }
  }

  const slotUpdate = normalizedObservability.slot_update;
  if (slotUpdate
    && typeof slotUpdate === "object"
    && !Array.isArray(slotUpdate)
    && Array.isArray(slotUpdate.pending_slots)
    && slotUpdate.pending_slots.length > 0
    && !hasDiffPrefix("slot_state.missing:")) {
    addDiffLine(`slot_state.missing: ${formatValue(slotUpdate.pending_slots)}`);
  }
  const taskAbandoned = normalizedObservability.task_abandoned;
  if (taskAbandoned && typeof taskAbandoned === "object" && !Array.isArray(taskAbandoned)) {
    const abandonedTaskId = cleanText(taskAbandoned.task_id || "");
    if (abandonedTaskId && !hasDiffPrefix("abandoned_task_ids:")) {
      addDiffLine(`abandoned_task_ids: +${abandonedTaskId}`);
    }
  }

  return diffLines;
}

function buildTaskTraceText({
  memoryStage = "",
  snapshot = null,
  diffLines = [],
} = {}) {
  const next = toSnapshot(snapshot);
  const slots = next.slot_state;
  const abandonedSummary = next.abandoned_task_hidden_count > 0
    ? `${formatValue(next.abandoned_task_ids)} (+${next.abandoned_task_hidden_count} more)`
    : formatValue(next.abandoned_task_ids);
  const lines = [
    `[task-trace] ${cleanText(memoryStage || "") || "unknown_stage"}`,
    `now: task_id=${formatValue(next.task_id)} | task_type=${formatValue(next.task_type)} | phase=${formatValue(next.task_phase)} | status=${formatValue(next.task_status)}`,
    `owner: current=${formatValue(next.current_owner_agent)} | previous=${formatValue(next.previous_owner_agent)} | handoff=${formatValue(next.handoff_reason)}`,
    `retry: count=${next.retry_count} | policy=${next.retry_policy.strategy} (max=${next.retry_policy.max_retries})`,
    `next_best_action: ${formatValue(next.next_best_action)}`,
    `slot_state: missing=${formatValue(slots.missing)} | filled=${formatValue(slots.filled)} | invalid=${formatValue(slots.invalid)}`,
    `abandoned_task_ids: ${abandonedSummary}`,
  ];
  if (Array.isArray(diffLines) && diffLines.length > 0) {
    lines.push("diff:");
    for (const line of diffLines) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push("diff: no_change");
  }
  return lines.join("\n");
}

export function buildPlannerTaskTraceDiagnostics({
  memoryStage = "",
  memorySnapshot = null,
  previousMemorySnapshot = null,
  observability = null,
} = {}) {
  const snapshot = toSnapshot(memorySnapshot);
  const diff = buildDiffLines({
    previousSnapshot: previousMemorySnapshot,
    nextSnapshot: memorySnapshot,
    observability,
  });
  const summary = `task=${formatValue(snapshot.task_id)} phase=${snapshot.task_phase} status=${snapshot.task_status} owner=${formatValue(snapshot.current_owner_agent)} next=${formatValue(snapshot.next_best_action)}`;
  return {
    summary,
    snapshot: {
      task_id: snapshot.task_id,
      task_type: snapshot.task_type,
      task_phase: snapshot.task_phase,
      task_status: snapshot.task_status,
      current_owner_agent: snapshot.current_owner_agent,
      previous_owner_agent: snapshot.previous_owner_agent,
      handoff_reason: snapshot.handoff_reason,
      retry_count: snapshot.retry_count,
      retry_policy: snapshot.retry_policy,
      next_best_action: snapshot.next_best_action,
      slot_state: snapshot.slot_state,
      abandoned_task_ids: snapshot.abandoned_task_ids,
      abandoned_task_total: snapshot.abandoned_task_total,
    },
    diff,
    text: buildTaskTraceText({
      memoryStage,
      snapshot: memorySnapshot,
      diffLines: diff,
    }),
    event_alignment: {
      memory_snapshot: Boolean(memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)),
      task_phase_transition: Boolean(cleanText(observability?.task_phase_transition || "")),
      agent_handoff: Boolean(observability?.agent_handoff && typeof observability.agent_handoff === "object"),
      retry_attempt: Boolean(observability?.retry_attempt && typeof observability.retry_attempt === "object"),
    },
  };
}
