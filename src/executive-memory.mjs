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

function createSessionStore() {
  return { items: [] };
}

function createApprovedStore() {
  return { items: [] };
}

function createProposalStore() {
  return { items: [] };
}

async function loadStore(filePath, fallbackFactory) {
  const raw = await readJsonFile(filePath);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    return fallbackFactory();
  }
  return raw;
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
  const store = await loadStore(filePath, fallbackFactory);
  store.items = [...store.items, item].slice(-Math.max(1, limit));
  await writeJsonFile(filePath, store);
  return item;
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
