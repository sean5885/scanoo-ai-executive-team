import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cleanText } from "./message-intent-utils.mjs";

const PLANNER_SUMMARY_TRIGGER_TURNS = 6;
const PLANNER_SUMMARY_TRIGGER_CHARS = 2400;
const PLANNER_RECENT_MESSAGE_LIMIT = 4;

const plannerConversationMemoryState = {
  recent_messages: [],
  latest_summary: null,
  turns_since_summary: 0,
  chars_since_summary: 0,
  total_turns: 0,
  last_compacted_at: null,
};
let plannerConversationMemoryLoaded = false;

function cloneJsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolvePlannerConversationMemoryStorePath() {
  return cleanText(process.env.PLANNER_CONVERSATION_MEMORY_PATH)
    || fileURLToPath(new URL("../.data/planner-conversation-memory.json", import.meta.url));
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
  };
}

function applyPlannerConversationMemorySnapshot(snapshot = {}) {
  const normalized = normalizePlannerConversationMemorySnapshot(snapshot);
  plannerConversationMemoryState.latest_summary = normalized.latest_summary;
  plannerConversationMemoryState.recent_messages = normalized.recent_messages;
  plannerConversationMemoryState.turns_since_summary = normalized.turns_since_summary;
  plannerConversationMemoryState.chars_since_summary = normalized.chars_since_summary;
  plannerConversationMemoryState.total_turns = normalized.total_turns;
  plannerConversationMemoryState.last_compacted_at = normalized.last_compacted_at;
}

function persistPlannerConversationMemory() {
  const storePath = resolvePlannerConversationMemoryStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    latest_summary: plannerConversationMemoryState.latest_summary,
    recent_messages: plannerConversationMemoryState.recent_messages,
    turns_since_summary: plannerConversationMemoryState.turns_since_summary,
    chars_since_summary: plannerConversationMemoryState.chars_since_summary,
    total_turns: plannerConversationMemoryState.total_turns,
    last_compacted_at: plannerConversationMemoryState.last_compacted_at,
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
  plannerConversationMemoryState.recent_messages.push(normalized);
  plannerConversationMemoryState.recent_messages = plannerConversationMemoryState.recent_messages
    .slice(-PLANNER_RECENT_MESSAGE_LIMIT);
  return normalized.content.length;
}

function normalizePlannerFlowSnapshot(flow = null) {
  if (!flow || typeof flow !== "object") {
    return null;
  }
  return {
    id: cleanText(flow.id) || null,
    priority: Number.isFinite(flow.priority) ? Number(flow.priority) : 0,
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
      return {
        type: cleanText(item?.type || "") || null,
        label,
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

export function shouldCompactPlannerConversationMemory() {
  ensurePlannerConversationMemoryLoaded();
  return (
    plannerConversationMemoryState.turns_since_summary >= PLANNER_SUMMARY_TRIGGER_TURNS
    || plannerConversationMemoryState.chars_since_summary >= PLANNER_SUMMARY_TRIGGER_CHARS
  );
}

export function recordPlannerConversationMessages(messages = []) {
  ensurePlannerConversationMemoryLoaded();
  if (!Array.isArray(messages)) {
    return;
  }
  let totalChars = 0;
  for (const message of messages) {
    totalChars += pushPlannerRecentMessage(message);
  }
  if (totalChars > 0) {
    plannerConversationMemoryState.turns_since_summary += 1;
    plannerConversationMemoryState.chars_since_summary += totalChars;
    plannerConversationMemoryState.total_turns += 1;
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
      "dynamic flow selection by priority then keyword-hit count",
      "company-brain doc query pipeline with active_doc, active_candidates, and active_theme",
      "fail-soft planner dispatch, retry, self-heal, and preset execution",
    ],
    current_flows: normalizedFlows.map((flow) => ({
      id: flow.id,
      priority: flow.priority,
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
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const summary = buildPlannerConversationSummary({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
  });
  plannerConversationMemoryState.latest_summary = summary;
  plannerConversationMemoryState.turns_since_summary = 0;
  plannerConversationMemoryState.chars_since_summary = 0;
  plannerConversationMemoryState.last_compacted_at = summary.generated_at;
  persistPlannerConversationMemory();
  logger?.debug?.("planner_conversation_memory", {
    stage: "planner_conversation_memory",
    event_type: "conversation_compacted",
    reason: cleanText(reason) || "manual",
    latest_trace_id: latestTraceId || null,
    recent_message_count: plannerConversationMemoryState.recent_messages.length,
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
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  if (!force && !shouldCompactPlannerConversationMemory()) {
    return plannerConversationMemoryState.latest_summary
      ? cloneJsonSafe(plannerConversationMemoryState.latest_summary)
      : null;
  }
  return compactPlannerConversationMemory({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
    logger,
    reason,
  });
}

export function getPlannerConversationMemory() {
  ensurePlannerConversationMemoryLoaded();
  return cloneJsonSafe({
    latest_summary: plannerConversationMemoryState.latest_summary,
    recent_messages: plannerConversationMemoryState.recent_messages,
    turns_since_summary: plannerConversationMemoryState.turns_since_summary,
    chars_since_summary: plannerConversationMemoryState.chars_since_summary,
    total_turns: plannerConversationMemoryState.total_turns,
    last_compacted_at: plannerConversationMemoryState.last_compacted_at,
  });
}

export function resetPlannerConversationMemory() {
  ensurePlannerConversationMemoryLoaded();
  plannerConversationMemoryState.recent_messages = [];
  plannerConversationMemoryState.latest_summary = null;
  plannerConversationMemoryState.turns_since_summary = 0;
  plannerConversationMemoryState.chars_since_summary = 0;
  plannerConversationMemoryState.total_turns = 0;
  plannerConversationMemoryState.last_compacted_at = null;
  rmSync(resolvePlannerConversationMemoryStorePath(), { force: true });
}

export function reloadPlannerConversationMemory() {
  plannerConversationMemoryLoaded = false;
  return loadPlannerConversationMemoryFromStore();
}

ensurePlannerConversationMemoryLoaded();
