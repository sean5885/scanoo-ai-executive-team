import crypto from "node:crypto";

import { listMemoryByPrefix } from "./company-brain-memory-authority.mjs";
import {
  executiveApprovedMemoryStorePath,
  executivePendingProposalStorePath,
  executiveSessionMemoryStorePath,
} from "./config.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { guardedMemorySet } from "./memory-write-guard.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const EXECUTIVE_SESSION_MEMORY_PREFIX = "executive_session_memory:";
const EXECUTIVE_PENDING_PROPOSAL_PREFIX = "executive_pending_proposal:";
const EXECUTIVE_APPROVED_MEMORY_PREFIX = "executive_approved_memory:";
const EXECUTIVE_DECISION_MEMORY_NEEDS_CONTEXT_PATTERN = /(這個|那个|那個|this|that|上一題|上一轮|上一輪|上次|剛剛|刚刚|延續|延续|繼續|继续|same task|follow[-\s]?up|context|之前|前面|續上)/i;
const EXECUTIVE_MEMORY_QUERY_TOKEN_SPLIT_PATTERN = /[\s,.;:!?，。！？、；：/\\|()\[\]{}<>《》「」"'`]+/;

function createSessionStore() {
  return { items: [] };
}

function createApprovedStore() {
  return { items: [] };
}

function createProposalStore() {
  return { items: [] };
}

let inMemoryStoreOverride = null;
const storeMutationQueueByPath = new Map();

function cloneStorePayload(store = { items: [] }) {
  return {
    items: Array.isArray(store?.items)
      ? store.items.map((item) => (item && typeof item === "object" ? { ...item } : item))
      : [],
  };
}

function getInMemoryStore(filePath) {
  if (!inMemoryStoreOverride) {
    return null;
  }
  if (!Object.hasOwn(inMemoryStoreOverride, filePath)) {
    return null;
  }
  return cloneStorePayload(inMemoryStoreOverride[filePath]);
}

function setInMemoryStore(filePath, store = { items: [] }) {
  if (!inMemoryStoreOverride) {
    return false;
  }
  inMemoryStoreOverride[filePath] = cloneStorePayload(store);
  return true;
}

async function queueStoreMutation(filePath, operation) {
  const previous = storeMutationQueueByPath.get(filePath) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => operation());
  storeMutationQueueByPath.set(filePath, current);
  try {
    return await current;
  } finally {
    if (storeMutationQueueByPath.get(filePath) === current) {
      storeMutationQueueByPath.delete(filePath);
    }
  }
}

async function loadStore(filePath, fallbackFactory) {
  const inMemoryStore = getInMemoryStore(filePath);
  if (inMemoryStore) {
    return inMemoryStore;
  }
  const raw = await readJsonFile(filePath);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    return fallbackFactory();
  }
  return cloneStorePayload(raw);
}

function buildExecutiveMemoryKey(prefix = "", id = "") {
  const normalizedPrefix = cleanText(prefix);
  const normalizedId = cleanText(id);
  if (!normalizedPrefix || !normalizedId) {
    return "";
  }
  return `${normalizedPrefix}${normalizedId}`;
}

function hydrateAuthorityEntries(items = [], prefix = "", source = "executive-memory") {
  for (const item of Array.isArray(items) ? items : []) {
    const key = buildExecutiveMemoryKey(prefix, item?.id);
    if (!key) {
      continue;
    }
    guardedMemorySet({
      key,
      value: item,
      source,
    });
  }
}

function listAuthorityEntries(prefix = "") {
  const rows = listMemoryByPrefix({ prefix });
  if (rows.ok !== true || !Array.isArray(rows.data)) {
    return [];
  }
  return rows.data
    .map((row) => row?.value)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function mergeMemoryEntries(authorityItems = [], persistedItems = []) {
  const merged = new Map();
  for (const item of Array.isArray(persistedItems) ? persistedItems : []) {
    if (!cleanText(item?.id)) {
      continue;
    }
    merged.set(item.id, item);
  }
  for (const item of Array.isArray(authorityItems) ? authorityItems : []) {
    if (!cleanText(item?.id)) {
      continue;
    }
    merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

async function persistExecutiveMirrorItem({
  filePath,
  fallbackFactory,
  item,
  limit,
}) {
  return queueStoreMutation(filePath, async () => {
    const store = await loadStore(filePath, fallbackFactory);
    store.items = [...store.items, item].slice(-Math.max(1, limit));
    if (!setInMemoryStore(filePath, store)) {
      await writeJsonFile(filePath, store);
    }
    return item;
  });
}

export function useInMemoryExecutiveMemoryStoresForTests() {
  inMemoryStoreOverride = {
    [executiveSessionMemoryStorePath]: createSessionStore(),
    [executivePendingProposalStorePath]: createProposalStore(),
    [executiveApprovedMemoryStorePath]: createApprovedStore(),
  };
}

export async function resetExecutiveMemoryStoresForTests() {
  if (!inMemoryStoreOverride) {
    await Promise.all([
      writeJsonFile(executiveSessionMemoryStorePath, createSessionStore()),
      writeJsonFile(executivePendingProposalStorePath, createProposalStore()),
      writeJsonFile(executiveApprovedMemoryStorePath, createApprovedStore()),
    ]);
    return;
  }
  inMemoryStoreOverride[executiveSessionMemoryStorePath] = createSessionStore();
  inMemoryStoreOverride[executivePendingProposalStorePath] = createProposalStore();
  inMemoryStoreOverride[executiveApprovedMemoryStorePath] = createApprovedStore();
}

export function restoreExecutiveMemoryStoresForTests() {
  inMemoryStoreOverride = null;
  storeMutationQueueByPath.clear();
}

function normalizeEntry(entry = {}) {
  return {
    id: cleanText(entry.id) || crypto.randomUUID(),
    account_id: cleanText(entry.account_id),
    session_key: cleanText(entry.session_key),
    task_id: cleanText(entry.task_id),
    type: cleanText(entry.type || "note") || "note",
    title: cleanText(entry.title),
    content: cleanText(entry.content),
    status: cleanText(entry.status || "active") || "active",
    tags: Array.isArray(entry.tags) ? entry.tags.map((item) => cleanText(item)).filter(Boolean).slice(0, 10) : [],
    evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(0, 10) : [],
    requires_approval: entry.requires_approval === true,
    created_at: entry.created_at || new Date().toISOString(),
    updated_at: entry.updated_at || new Date().toISOString(),
  };
}

function normalizeMemoryText(value = "") {
  return cleanText(String(value || "").toLowerCase());
}

function tokenizeMemoryQuery(text = "") {
  const normalized = normalizeMemoryText(text);
  if (!normalized) {
    return [];
  }
  const tokens = normalized
    .split(EXECUTIVE_MEMORY_QUERY_TOKEN_SPLIT_PATTERN)
    .map((token) => cleanText(token))
    .filter((token) => token.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 12);
}

function parseIsoTimestamp(value = "") {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function scoreMemoryEntry(entry = {}, {
  query = "",
  tokens = [],
} = {}) {
  const title = normalizeMemoryText(entry?.title || "");
  const content = normalizeMemoryText(entry?.content || "");
  const type = normalizeMemoryText(entry?.type || "");
  const tags = Array.isArray(entry?.tags)
    ? entry.tags.map((item) => normalizeMemoryText(item)).filter(Boolean)
    : [];
  const haystack = [title, content, type, ...tags].filter(Boolean).join("\n");
  if (!haystack) {
    return 0;
  }

  let score = 0;
  if (query && haystack.includes(query)) {
    score += 4;
  }
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  if (query && title && title.includes(query)) {
    score += 2;
  }
  if (query && type && query.includes(type)) {
    score += 1;
  }

  const updatedAt = parseIsoTimestamp(entry?.updated_at || entry?.created_at || "");
  if (updatedAt > 0) {
    const ageMs = Math.max(0, Date.now() - updatedAt);
    if (ageMs <= 1000 * 60 * 60 * 24 * 3) {
      score += 1;
    } else if (ageMs <= 1000 * 60 * 60 * 24 * 7) {
      score += 0.5;
    }
  }
  return score;
}

function toDecisionMemorySnippet(entry = {}, {
  tier = "",
  score = 0,
} = {}) {
  return {
    id: cleanText(entry?.id || "") || null,
    type: cleanText(entry?.type || "") || "note",
    title: cleanText(entry?.title || "") || null,
    content: cleanText(entry?.content || "") || null,
    tags: Array.isArray(entry?.tags) ? entry.tags.map((item) => cleanText(item)).filter(Boolean).slice(0, 8) : [],
    task_id: cleanText(entry?.task_id || "") || null,
    session_key: cleanText(entry?.session_key || "") || null,
    updated_at: cleanText(entry?.updated_at || entry?.created_at || "") || null,
    memory_tier: cleanText(tier || "") || null,
    score: Number.isFinite(Number(score))
      ? Number(score)
      : 0,
  };
}

function rankMemoryEntries(entries = [], {
  query = "",
  tokens = [],
  limit = 4,
  tier = "",
  includeZeroScore = false,
} = {}) {
  const scored = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const score = scoreMemoryEntry(entry, {
      query,
      tokens,
    });
    if (!includeZeroScore && score <= 0) {
      continue;
    }
    scored.push({
      entry,
      score,
    });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const rightUpdatedAt = parseIsoTimestamp(right.entry?.updated_at || right.entry?.created_at || "");
    const leftUpdatedAt = parseIsoTimestamp(left.entry?.updated_at || left.entry?.created_at || "");
    return rightUpdatedAt - leftUpdatedAt;
  });

  const normalizedLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 4);
  return scored
    .slice(0, normalizedLimit)
    .map((item) => toDecisionMemorySnippet(item.entry, {
      tier,
      score: item.score,
    }));
}

export function needsExecutiveMemoryContext({ text = "" } = {}) {
  return EXECUTIVE_DECISION_MEMORY_NEEDS_CONTEXT_PATTERN.test(cleanText(text));
}

export async function appendSessionMemory(entry = {}) {
  const item = normalizeEntry(entry);
  guardedMemorySet({
    key: buildExecutiveMemoryKey(EXECUTIVE_SESSION_MEMORY_PREFIX, item.id),
    value: item,
    source: "executive-memory",
  });
  return persistExecutiveMirrorItem({
    filePath: executiveSessionMemoryStorePath,
    fallbackFactory: createSessionStore,
    item,
    limit: 200,
  });
}

export async function listSessionMemory({ accountId = "", sessionKey = "", limit = 8 } = {}) {
  const authorityItems = listAuthorityEntries(EXECUTIVE_SESSION_MEMORY_PREFIX);
  const store = await loadStore(executiveSessionMemoryStorePath, createSessionStore);
  const persistedItems = Array.isArray(store.items) ? store.items : [];
  hydrateAuthorityEntries(persistedItems, EXECUTIVE_SESSION_MEMORY_PREFIX);
  const items = mergeMemoryEntries(authorityItems, persistedItems);
  return items
    .filter((item) =>
      (!accountId || item.account_id === cleanText(accountId)) &&
      (!sessionKey || item.session_key === cleanText(sessionKey)))
    .slice(-Math.max(1, limit));
}

export async function createPendingKnowledgeProposal(entry = {}) {
  const item = normalizeEntry({
    ...entry,
    status: entry.status || "pending_review",
    requires_approval: entry.requires_approval !== false,
  });
  guardedMemorySet({
    key: buildExecutiveMemoryKey(EXECUTIVE_PENDING_PROPOSAL_PREFIX, item.id),
    value: item,
    source: "executive-memory",
  });
  return persistExecutiveMirrorItem({
    filePath: executivePendingProposalStorePath,
    fallbackFactory: createProposalStore,
    item,
    limit: 300,
  });
}

export async function appendApprovedMemory(entry = {}) {
  const item = normalizeEntry({
    ...entry,
    status: "approved",
    requires_approval: false,
  });
  guardedMemorySet({
    key: buildExecutiveMemoryKey(EXECUTIVE_APPROVED_MEMORY_PREFIX, item.id),
    value: item,
    source: "executive-memory",
  });
  return persistExecutiveMirrorItem({
    filePath: executiveApprovedMemoryStorePath,
    fallbackFactory: createApprovedStore,
    item,
    limit: 500,
  });
}

export async function listPendingKnowledgeProposals({ accountId = "", limit = 20 } = {}) {
  const authorityItems = listAuthorityEntries(EXECUTIVE_PENDING_PROPOSAL_PREFIX);
  const store = await loadStore(executivePendingProposalStorePath, createProposalStore);
  const persistedItems = Array.isArray(store.items) ? store.items : [];
  hydrateAuthorityEntries(persistedItems, EXECUTIVE_PENDING_PROPOSAL_PREFIX);
  const items = mergeMemoryEntries(authorityItems, persistedItems);
  return items
    .filter((item) => !accountId || item.account_id === cleanText(accountId))
    .slice(-Math.max(1, limit));
}

export async function listApprovedMemory({ accountId = "", limit = 20 } = {}) {
  const authorityItems = listAuthorityEntries(EXECUTIVE_APPROVED_MEMORY_PREFIX);
  const store = await loadStore(executiveApprovedMemoryStorePath, createApprovedStore);
  const persistedItems = Array.isArray(store.items) ? store.items : [];
  hydrateAuthorityEntries(persistedItems, EXECUTIVE_APPROVED_MEMORY_PREFIX);
  const items = mergeMemoryEntries(authorityItems, persistedItems);
  return items
    .filter((item) => !accountId || item.account_id === cleanText(accountId))
    .slice(-Math.max(1, limit));
}

export async function retrieveExecutiveDecisionMemory({
  accountId = "",
  sessionKey = "",
  text = "",
  sessionLimit = 4,
  approvedLimit = 3,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedSessionKey = cleanText(sessionKey);
  const normalizedText = cleanText(text);
  const normalizedQuery = normalizeMemoryText(normalizedText);
  const queryTokens = tokenizeMemoryQuery(normalizedText);
  const needsContext = needsExecutiveMemoryContext({ text: normalizedText });
  try {
    const [sessionCandidates, approvedCandidates] = await Promise.all([
      listSessionMemory({
        accountId: normalizedAccountId,
        sessionKey: normalizedSessionKey,
        limit: 80,
      }),
      listApprovedMemory({
        accountId: normalizedAccountId,
        limit: 120,
      }),
    ]);

    let sessionHits = rankMemoryEntries(sessionCandidates, {
      query: normalizedQuery,
      tokens: queryTokens,
      limit: sessionLimit,
      tier: "session",
      includeZeroScore: false,
    });
    let approvedHits = rankMemoryEntries(approvedCandidates, {
      query: normalizedQuery,
      tokens: queryTokens,
      limit: approvedLimit,
      tier: "approved",
      includeZeroScore: false,
    });

    let retrievalMode = "scored_match";
    if (sessionHits.length + approvedHits.length === 0 && needsContext) {
      sessionHits = rankMemoryEntries(sessionCandidates, {
        query: "",
        tokens: [],
        limit: Math.max(1, Number(sessionLimit) || 4),
        tier: "session",
        includeZeroScore: true,
      });
      approvedHits = rankMemoryEntries(approvedCandidates, {
        query: "",
        tokens: [],
        limit: Math.max(1, Number(approvedLimit) || 3),
        tier: "approved",
        includeZeroScore: true,
      });
      retrievalMode = "recent_fallback";
    } else if (sessionHits.length + approvedHits.length === 0) {
      retrievalMode = "no_match";
    }

    return {
      ok: true,
      decision_context: {
        query: normalizedText || null,
        needs_context: needsContext,
        session_memory: sessionHits,
        approved_memory: approvedHits,
      },
      observability: {
        memory_retrieval_attempted: true,
        memory_retrieval_needs_context: needsContext,
        memory_retrieval_hit: (sessionHits.length + approvedHits.length) > 0,
        memory_retrieval_session_hit_count: sessionHits.length,
        memory_retrieval_approved_hit_count: approvedHits.length,
        memory_retrieval_mode: retrievalMode,
        memory_retrieval_query_tokens: queryTokens.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      decision_context: {
        query: normalizedText || null,
        needs_context: needsContext,
        session_memory: [],
        approved_memory: [],
      },
      observability: {
        memory_retrieval_attempted: true,
        memory_retrieval_needs_context: needsContext,
        memory_retrieval_hit: false,
        memory_retrieval_session_hit_count: 0,
        memory_retrieval_approved_hit_count: 0,
        memory_retrieval_mode: "error",
        memory_retrieval_error: cleanText(error?.message || "") || "memory_retrieval_failed",
      },
    };
  }
}
