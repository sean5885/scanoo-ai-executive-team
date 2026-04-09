import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cleanText } from "./message-intent-utils.mjs";
import { getPlannerFlowOwnership } from "./planner-flow-runtime.mjs";

const PLANNER_SUMMARY_TRIGGER_TURNS = 6;
const PLANNER_SUMMARY_TRIGGER_CHARS = 2400;
const PLANNER_RECENT_MESSAGE_LIMIT = 4;
const DEFAULT_PLANNER_SESSION_KEY = "default";
const PLANNER_WORKING_MEMORY_SLOT_LIMIT = 6;
const PLANNER_WORKING_MEMORY_REQUIRED_KEYS = Object.freeze([
  "current_goal",
  "inferred_task_type",
  "last_selected_agent",
  "last_selected_skill",
  "last_tool_result_summary",
  "unresolved_slots",
  "next_best_action",
  "confidence",
  "updated_at",
]);

const plannerConversationMemoryState = {
  latest_session_key: DEFAULT_PLANNER_SESSION_KEY,
  sessions: {},
};
let plannerConversationMemoryLoaded = false;

function cloneJsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolvePlannerConversationMemoryStorePath() {
  return cleanText(process.env.PLANNER_CONVERSATION_MEMORY_PATH)
    || fileURLToPath(new URL("../.data/planner-conversation-memory.json", import.meta.url));
}

function normalizePlannerConversationSessionKey(sessionKey = "") {
  return cleanText(sessionKey) || DEFAULT_PLANNER_SESSION_KEY;
}

function buildEmptyPlannerWorkingMemory() {
  return {
    current_goal: null,
    inferred_task_type: null,
    last_selected_agent: null,
    last_selected_skill: null,
    last_tool_result_summary: null,
    unresolved_slots: [],
    next_best_action: null,
    confidence: null,
    updated_at: null,
  };
}

function normalizeWorkingMemoryString(value) {
  return cleanText(value) || null;
}

function normalizeWorkingMemorySlots(slots = []) {
  if (!Array.isArray(slots)) {
    return [];
  }
  return slots
    .map((slot) => normalizeWorkingMemoryString(slot))
    .filter(Boolean)
    .slice(0, PLANNER_WORKING_MEMORY_SLOT_LIMIT);
}

function normalizeWorkingMemoryConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  if (normalized < 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizePlannerWorkingMemory(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const key of PLANNER_WORKING_MEMORY_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return null;
    }
  }
  const stringFields = [
    "current_goal",
    "inferred_task_type",
    "last_selected_agent",
    "last_selected_skill",
    "last_tool_result_summary",
    "next_best_action",
    "updated_at",
  ];
  for (const key of stringFields) {
    if (value[key] !== null && value[key] !== undefined && typeof value[key] !== "string") {
      return null;
    }
  }
  if (!Array.isArray(value.unresolved_slots) || value.unresolved_slots.some((slot) => typeof slot !== "string")) {
    return null;
  }
  if (value.confidence !== null && value.confidence !== undefined && typeof value.confidence !== "number") {
    return null;
  }
  const unresolvedSlots = normalizeWorkingMemorySlots(value.unresolved_slots);
  if (unresolvedSlots.length !== value.unresolved_slots.length) {
    return null;
  }
  if (value.confidence !== null && value.confidence !== undefined && normalizeWorkingMemoryConfidence(value.confidence) === null) {
    return null;
  }

  return {
    current_goal: normalizeWorkingMemoryString(value.current_goal),
    inferred_task_type: normalizeWorkingMemoryString(value.inferred_task_type),
    last_selected_agent: normalizeWorkingMemoryString(value.last_selected_agent),
    last_selected_skill: normalizeWorkingMemoryString(value.last_selected_skill),
    last_tool_result_summary: normalizeWorkingMemoryString(value.last_tool_result_summary),
    unresolved_slots: unresolvedSlots,
    next_best_action: normalizeWorkingMemoryString(value.next_best_action),
    confidence: normalizeWorkingMemoryConfidence(value.confidence),
    updated_at: normalizeWorkingMemoryString(value.updated_at),
  };
}

function buildEmptyPlannerConversationSession() {
  return {
    recent_messages: [],
    latest_summary: null,
    working_memory: null,
    turns_since_summary: 0,
    chars_since_summary: 0,
    total_turns: 0,
    last_compacted_at: null,
  };
}

function normalizePlannerConversationMemorySnapshot(snapshot = {}) {
  return {
    latest_summary: snapshot?.latest_summary && typeof snapshot.latest_summary === "object"
      ? cloneJsonSafe(snapshot.latest_summary)
      : null,
    recent_messages: Array.isArray(snapshot?.recent_messages)
      ? snapshot.recent_messages
          .map((message) => normalizePlannerConversationMessage(message))
          .filter(Boolean)
          .slice(-PLANNER_RECENT_MESSAGE_LIMIT)
      : [],
    turns_since_summary: Number.isFinite(snapshot?.turns_since_summary)
      ? Number(snapshot.turns_since_summary)
      : 0,
    chars_since_summary: Number.isFinite(snapshot?.chars_since_summary)
      ? Number(snapshot.chars_since_summary)
      : 0,
    total_turns: Number.isFinite(snapshot?.total_turns)
      ? Number(snapshot.total_turns)
      : 0,
    last_compacted_at: cleanText(snapshot?.last_compacted_at) || null,
    working_memory: Object.prototype.hasOwnProperty.call(snapshot || {}, "working_memory")
      ? cloneJsonSafe(snapshot?.working_memory)
      : null,
  };
}

function normalizePlannerConversationMemoryStore(snapshot = {}) {
  if (snapshot?.sessions && typeof snapshot.sessions === "object" && !Array.isArray(snapshot.sessions)) {
    const sessions = {};
    for (const [sessionKey, value] of Object.entries(snapshot.sessions)) {
      const normalizedKey = normalizePlannerConversationSessionKey(sessionKey);
      sessions[normalizedKey] = normalizePlannerConversationMemorySnapshot(value);
    }
    return {
      latest_session_key: normalizePlannerConversationSessionKey(snapshot?.latest_session_key),
      sessions,
    };
  }

  return {
    latest_session_key: DEFAULT_PLANNER_SESSION_KEY,
    sessions: {
      [DEFAULT_PLANNER_SESSION_KEY]: normalizePlannerConversationMemorySnapshot(snapshot),
    },
  };
}

function applyPlannerConversationMemorySnapshot(snapshot = {}) {
  const normalized = normalizePlannerConversationMemoryStore(snapshot);
  plannerConversationMemoryState.latest_session_key = normalized.latest_session_key;
  plannerConversationMemoryState.sessions = normalized.sessions;
}

function getPlannerConversationSessionState(sessionKey = "", { createIfMissing = true } = {}) {
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  if (!plannerConversationMemoryState.sessions[normalizedSessionKey] && createIfMissing) {
    plannerConversationMemoryState.sessions[normalizedSessionKey] = buildEmptyPlannerConversationSession();
  }
  return plannerConversationMemoryState.sessions[normalizedSessionKey] || null;
}

function persistPlannerConversationMemory() {
  const storePath = resolvePlannerConversationMemoryStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    latest_session_key: plannerConversationMemoryState.latest_session_key,
    sessions: plannerConversationMemoryState.sessions,
  }, null, 2));
}

function loadPlannerConversationMemoryFromStore() {
  const storePath = resolvePlannerConversationMemoryStorePath();
  try {
    const raw = readFileSync(storePath, "utf8");
    applyPlannerConversationMemorySnapshot(JSON.parse(raw));
  } catch {
    applyPlannerConversationMemorySnapshot({});
  }
  plannerConversationMemoryLoaded = true;
  return getPlannerConversationMemory();
}

function ensurePlannerConversationMemoryLoaded() {
  if (!plannerConversationMemoryLoaded) {
    loadPlannerConversationMemoryFromStore();
  }
}

function normalizePlannerConversationMessage(message = {}) {
  const role = cleanText(message.role || "");
  const content = cleanText(message.content || "");
  if (!role || !content) {
    return null;
  }
  return {
    role,
    content,
    timestamp: cleanText(message.timestamp) || null,
  };
}

function pushPlannerRecentMessage(message = null) {
  const normalized = normalizePlannerConversationMessage(message);
  if (!normalized) {
    return 0;
  }
  const sessionState = getPlannerConversationSessionState();
  sessionState.recent_messages.push(normalized);
  sessionState.recent_messages = sessionState.recent_messages
    .slice(-PLANNER_RECENT_MESSAGE_LIMIT);
  return normalized.content.length;
}

function normalizePlannerFlowSnapshot(flow = null) {
  if (!flow || typeof flow !== "object") {
    return null;
  }
  return {
    id: cleanText(flow.id) || null,
    ownership: getPlannerFlowOwnership(flow),
    context: flow.context && typeof flow.context === "object" && !Array.isArray(flow.context)
      ? cloneJsonSafe(flow.context)
      : {},
  };
}

function normalizeUnfinishedItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const label = cleanText(item?.label || item?.message || "");
      if (!label) {
        return null;
      }
      const actions = Array.isArray(item?.actions)
        ? item.actions
            .map((action) => {
              const type = cleanText(action?.type || action?.action || "");
              const actionLabel = cleanText(action?.label || "");
              if (!type || !actionLabel) {
                return null;
              }
              return {
                type,
                label: actionLabel,
              };
            })
            .filter(Boolean)
            .slice(0, 3)
        : [];
      return {
        type: cleanText(item?.type || "") || null,
        item_id: cleanText(item?.item_id || item?.id) || null,
        label,
        status: cleanText(item?.status || "pending") || "pending",
        actions,
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function deriveNextStepSuggestion({
  activeDoc = null,
  activeCandidates = [],
  activeTheme = null,
  unfinishedItems = [],
  latestSelectedAction = "",
} = {}) {
  if (activeDoc?.doc_id) {
    return `可直接追問目前${activeTheme ? `${activeTheme.toUpperCase()}主題` : ""}文件「${activeDoc.title || activeDoc.doc_id}」的內容、重點或下一步。`;
  }
  if (Array.isArray(activeCandidates) && activeCandidates.length > 0) {
    return "先請使用者指定候選文件，例如第一份或第二份，再進 detail。";
  }
  if (cleanText(activeTheme)) {
    return `沿用目前主題 ${cleanText(activeTheme)} 繼續追問相關文件、內容或下一步。`;
  }
  if (unfinishedItems.length > 0) {
    return unfinishedItems[0]?.label || "先處理未完成事項，再繼續 planner 執行。";
  }
  if (cleanText(latestSelectedAction)) {
    return `沿用最近一次 planner 動作 ${cleanText(latestSelectedAction)} 的結果，繼續下一步。`;
  }
  return "維持最近少量對話與最新摘要，按下一個 user query 繼續。";
}

function summarizeSystemArchitectureStatus() {
  return {
    planner_runtime: "executive-planner public entrypoint with internal planner flow runtime",
    context_mode: "system prompt + latest_summary + recent_messages + current_user_query",
    summary_strategy: "compact in-memory summary replaces full-history replay",
  };
}

export function shouldCompactPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const sessionState = getPlannerConversationSessionState(sessionKey);
  return (
    sessionState.turns_since_summary >= PLANNER_SUMMARY_TRIGGER_TURNS
    || sessionState.chars_since_summary >= PLANNER_SUMMARY_TRIGGER_CHARS
  );
}

export function recordPlannerConversationMessages(messages = [], { sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  if (!Array.isArray(messages)) {
    return;
  }
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  let totalChars = 0;
  for (const message of messages) {
    const normalized = normalizePlannerConversationMessage(message);
    if (!normalized) {
      continue;
    }
    sessionState.recent_messages.push(normalized);
    sessionState.recent_messages = sessionState.recent_messages.slice(-PLANNER_RECENT_MESSAGE_LIMIT);
    totalChars += normalized.content.length;
  }
  if (totalChars > 0) {
    sessionState.turns_since_summary += 1;
    sessionState.chars_since_summary += totalChars;
    sessionState.total_turns += 1;
    persistPlannerConversationMemory();
  }
}

export function buildPlannerConversationSummary({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
} = {}) {
  const normalizedFlows = Array.isArray(flows)
    ? flows.map((flow) => normalizePlannerFlowSnapshot(flow)).filter(Boolean)
    : [];
  const docFlow = normalizedFlows.find((flow) => flow.id === "doc_query");
  const activeDoc = docFlow?.context?.activeDoc || null;
  const activeCandidates = Array.isArray(docFlow?.context?.activeCandidates)
    ? docFlow.context.activeCandidates.slice(0, 5)
    : [];
  const activeTheme = cleanText(docFlow?.context?.activeTheme) || null;
  const normalizedUnfinishedItems = normalizeUnfinishedItems(unfinishedItems);

  return {
    generated_at: new Date().toISOString(),
    system_architecture_status: summarizeSystemArchitectureStatus(),
    completed_features: [
      "planner flow runtime with runtime-info / okr / delivery / doc-query flows",
      "explicit flow ownership contract for runtime_info / doc_query / okr / bd / delivery",
      "company-brain doc query pipeline with active_doc, active_candidates, and active_theme",
      "fail-soft planner dispatch, retry, self-heal, and preset execution",
    ],
    current_flows: normalizedFlows.map((flow) => ({
      id: flow.id,
      ownership: flow.ownership,
    })),
    active_doc: activeDoc && typeof activeDoc === "object" ? activeDoc : null,
    active_candidates: activeCandidates,
    active_theme: activeTheme,
    unfinished_items: normalizedUnfinishedItems,
    next_step_suggestion: deriveNextStepSuggestion({
      activeDoc,
      activeCandidates,
      activeTheme,
      unfinishedItems: normalizedUnfinishedItems,
      latestSelectedAction,
    }),
    latest_trace_id: latestTraceId || null,
  };
}

export function compactPlannerConversationMemory({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
  logger = console,
  reason = "manual",
  sessionKey = "",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  const summary = buildPlannerConversationSummary({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
  });
  sessionState.latest_summary = summary;
  sessionState.turns_since_summary = 0;
  sessionState.chars_since_summary = 0;
  sessionState.last_compacted_at = summary.generated_at;
  persistPlannerConversationMemory();
  logger?.debug?.("planner_conversation_memory", {
    stage: "planner_conversation_memory",
    event_type: "conversation_compacted",
    reason: cleanText(reason) || "manual",
    latest_trace_id: latestTraceId || null,
    session_key: normalizedSessionKey,
    recent_message_count: sessionState.recent_messages.length,
  });
  return cloneJsonSafe(summary);
}

export function maybeCompactPlannerConversationMemory({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
  logger = console,
  force = false,
  reason = "auto",
  sessionKey = "",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const sessionState = getPlannerConversationSessionState(sessionKey);
  if (!force && !shouldCompactPlannerConversationMemory({ sessionKey })) {
    return sessionState.latest_summary
      ? cloneJsonSafe(sessionState.latest_summary)
      : null;
  }
  return compactPlannerConversationMemory({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
    logger,
    reason,
    sessionKey,
  });
}

function getCanonicalPlannerWorkingMemoryFromSession(sessionState = null) {
  return normalizePlannerWorkingMemory(sessionState?.working_memory || null);
}

function normalizePlannerWorkingMemoryPatchValue(key, value) {
  if (key === "unresolved_slots") {
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: "invalid_working_memory_slots",
      };
    }
    const normalizedSlots = normalizeWorkingMemorySlots(value);
    if (normalizedSlots.length !== value.length) {
      return {
        ok: false,
        error: "invalid_working_memory_slots",
      };
    }
    return {
      ok: true,
      value: normalizedSlots,
    };
  }

  if (key === "confidence") {
    if (value === null || value === undefined || value === "") {
      return { ok: true, value: null };
    }
    const normalizedConfidence = normalizeWorkingMemoryConfidence(value);
    if (normalizedConfidence === null) {
      return {
        ok: false,
        error: "invalid_working_memory_confidence",
      };
    }
    return {
      ok: true,
      value: normalizedConfidence,
    };
  }

  if (key === "updated_at") {
    if (value === null || value === undefined || value === "") {
      return { ok: true, value: null };
    }
    const normalizedText = normalizeWorkingMemoryString(value);
    if (!normalizedText) {
      return {
        ok: false,
        error: "invalid_working_memory_updated_at",
      };
    }
    return {
      ok: true,
      value: normalizedText,
    };
  }

  if (value === null || value === undefined || value === "") {
    return { ok: true, value: null };
  }

  const normalizedText = normalizeWorkingMemoryString(value);
  if (!normalizedText) {
    return {
      ok: false,
      error: "invalid_working_memory_string",
    };
  }
  return {
    ok: true,
    value: normalizedText,
  };
}

function normalizePlannerWorkingMemoryPatch(patch = null) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {
      ok: false,
      error: "invalid_working_memory_patch",
      updates: {},
    };
  }

  const updates = {};
  const updateKeys = PLANNER_WORKING_MEMORY_REQUIRED_KEYS.filter((key) =>
    key !== "updated_at"
    && Object.prototype.hasOwnProperty.call(patch, key));

  for (const key of updateKeys) {
    const normalizedValue = normalizePlannerWorkingMemoryPatchValue(key, patch[key]);
    if (normalizedValue.ok !== true) {
      return {
        ok: false,
        error: normalizedValue.error || "invalid_working_memory_patch",
        field: key,
        updates: {},
      };
    }
    updates[key] = normalizedValue.value;
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      error: "empty_working_memory_patch",
      updates: {},
    };
  }

  return {
    ok: true,
    updates,
  };
}

export function readPlannerWorkingMemoryForRouting({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey, {
    createIfMissing: false,
  });
  const rawWorkingMemory = sessionState?.working_memory;
  const normalizedWorkingMemory = getCanonicalPlannerWorkingMemoryFromSession(sessionState);
  const hasRawMemory = rawWorkingMemory !== null && rawWorkingMemory !== undefined;
  const hit = Boolean(normalizedWorkingMemory);
  const missReason = !hasRawMemory
    ? "missing"
    : hit
      ? null
      : "invalid_format";
  return {
    ok: true,
    data: hit ? cloneJsonSafe(normalizedWorkingMemory) : null,
    reason: missReason,
    observability: {
      memory_read_attempted: true,
      memory_hit: hit,
      memory_miss: !hit,
      memory_snapshot: hit ? cloneJsonSafe(normalizedWorkingMemory) : null,
    },
  };
}

export function getPlannerWorkingMemory({ sessionKey = "" } = {}) {
  const readResult = readPlannerWorkingMemoryForRouting({ sessionKey });
  return readResult.ok === true && readResult.data
    ? readResult.data
    : null;
}

export function applyPlannerWorkingMemoryPatch({
  patch = null,
  sessionKey = "",
  source = "unknown",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const normalizedPatch = normalizePlannerWorkingMemoryPatch(patch);
  if (normalizedPatch.ok !== true) {
    return {
      ok: false,
      error: normalizedPatch.error || "invalid_working_memory_patch",
      field: normalizedPatch.field || null,
      source: cleanText(source) || "unknown",
      data: null,
      observability: {
        memory_write_attempted: true,
        memory_write_succeeded: false,
        memory_snapshot: null,
      },
    };
  }

  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  const baseMemory = getCanonicalPlannerWorkingMemoryFromSession(sessionState) || buildEmptyPlannerWorkingMemory();
  const nextMemory = {
    ...baseMemory,
    ...normalizedPatch.updates,
    updated_at: new Date().toISOString(),
  };
  sessionState.working_memory = nextMemory;
  persistPlannerConversationMemory();

  return {
    ok: true,
    source: cleanText(source) || "unknown",
    data: cloneJsonSafe(nextMemory),
    observability: {
      memory_write_attempted: true,
      memory_write_succeeded: true,
      memory_snapshot: cloneJsonSafe(nextMemory),
    },
  };
}

export function getPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  return cloneJsonSafe({
    latest_summary: sessionState.latest_summary,
    recent_messages: sessionState.recent_messages,
    turns_since_summary: sessionState.turns_since_summary,
    chars_since_summary: sessionState.chars_since_summary,
    total_turns: sessionState.total_turns,
    last_compacted_at: sessionState.last_compacted_at,
    working_memory: getCanonicalPlannerWorkingMemoryFromSession(sessionState),
  });
}

export function resetPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = cleanText(sessionKey);
  if (!normalizedSessionKey) {
    plannerConversationMemoryState.latest_session_key = DEFAULT_PLANNER_SESSION_KEY;
    plannerConversationMemoryState.sessions = {};
    rmSync(resolvePlannerConversationMemoryStorePath(), { force: true });
    return;
  }
  delete plannerConversationMemoryState.sessions[normalizePlannerConversationSessionKey(normalizedSessionKey)];
  if (plannerConversationMemoryState.latest_session_key === normalizePlannerConversationSessionKey(normalizedSessionKey)) {
    plannerConversationMemoryState.latest_session_key = DEFAULT_PLANNER_SESSION_KEY;
  }
  persistPlannerConversationMemory();
}

export function reloadPlannerConversationMemory() {
  plannerConversationMemoryLoaded = false;
  return loadPlannerConversationMemoryFromStore();
}

ensurePlannerConversationMemoryLoaded();
