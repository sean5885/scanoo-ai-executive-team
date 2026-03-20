import crypto from "node:crypto";

import {
  executiveApprovedMemoryStorePath,
  executivePendingProposalStorePath,
  executiveSessionMemoryStorePath,
} from "./config.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

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
  const store = await loadStore(executiveSessionMemoryStorePath, createSessionStore);
  store.items = [...store.items, normalizeEntry(entry)].slice(-200);
  await writeJsonFile(executiveSessionMemoryStorePath, store);
  return store.items.at(-1) || null;
}

export async function listSessionMemory({ accountId = "", sessionKey = "", limit = 8 } = {}) {
  const store = await loadStore(executiveSessionMemoryStorePath, createSessionStore);
  return store.items
    .filter((item) =>
      (!accountId || item.account_id === cleanText(accountId)) &&
      (!sessionKey || item.session_key === cleanText(sessionKey)))
    .slice(-Math.max(1, limit));
}

export async function createPendingKnowledgeProposal(entry = {}) {
  const store = await loadStore(executivePendingProposalStorePath, createProposalStore);
  const item = normalizeEntry({
    ...entry,
    status: entry.status || "pending_review",
    requires_approval: entry.requires_approval !== false,
  });
  store.items = [...store.items, item].slice(-300);
  await writeJsonFile(executivePendingProposalStorePath, store);
  return item;
}

export async function appendApprovedMemory(entry = {}) {
  const store = await loadStore(executiveApprovedMemoryStorePath, createApprovedStore);
  const item = normalizeEntry({
    ...entry,
    status: "approved",
    requires_approval: false,
  });
  store.items = [...store.items, item].slice(-500);
  await writeJsonFile(executiveApprovedMemoryStorePath, store);
  return item;
}

export async function listPendingKnowledgeProposals({ accountId = "", limit = 20 } = {}) {
  const store = await loadStore(executivePendingProposalStorePath, createProposalStore);
  return store.items
    .filter((item) => !accountId || item.account_id === cleanText(accountId))
    .slice(-Math.max(1, limit));
}
