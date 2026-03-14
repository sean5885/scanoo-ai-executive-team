import { agentWorkflowCheckpointStorePath } from "./config.mjs";
import { normalizeText } from "./text-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

function uniqueItems(items = [], limit = 8) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
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

function normalizeCheckpoint(checkpoint = {}) {
  return {
    goal: normalizeText(checkpoint.goal || ""),
    completed: uniqueItems(checkpoint.completed, 8),
    pending: uniqueItems(checkpoint.pending, 8),
    constraints: uniqueItems(checkpoint.constraints, 8),
    facts: uniqueItems(checkpoint.facts, 8),
    risks: uniqueItems(checkpoint.risks, 8),
    updated_at: checkpoint.updated_at || new Date().toISOString(),
    meta: checkpoint.meta && typeof checkpoint.meta === "object" ? { ...checkpoint.meta } : {},
  };
}

async function loadStore() {
  const raw = await readJsonFile(agentWorkflowCheckpointStorePath);
  if (!raw || typeof raw !== "object" || typeof raw.checkpoints !== "object") {
    return { checkpoints: {} };
  }
  return {
    checkpoints: { ...raw.checkpoints },
  };
}

export async function getWorkflowCheckpoint(key) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) {
    return null;
  }
  const store = await loadStore();
  const checkpoint = store.checkpoints[normalizedKey];
  return checkpoint ? normalizeCheckpoint(checkpoint) : null;
}

export async function updateWorkflowCheckpoint(key, patch = {}) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) {
    return null;
  }

  const store = await loadStore();
  const current = normalizeCheckpoint(store.checkpoints[normalizedKey] || {});
  const next = normalizeCheckpoint({
    ...current,
    ...patch,
    completed: [...current.completed, ...(Array.isArray(patch.completed) ? patch.completed : [])],
    pending: [...(Array.isArray(patch.pending) ? patch.pending : [])],
    constraints: [...current.constraints, ...(Array.isArray(patch.constraints) ? patch.constraints : [])],
    facts: [...current.facts, ...(Array.isArray(patch.facts) ? patch.facts : [])],
    risks: [...(Array.isArray(patch.risks) ? patch.risks : current.risks)],
    meta: {
      ...current.meta,
      ...(patch.meta && typeof patch.meta === "object" ? patch.meta : {}),
    },
    updated_at: new Date().toISOString(),
  });

  store.checkpoints[normalizedKey] = next;
  await writeJsonFile(agentWorkflowCheckpointStorePath, store);
  return next;
}
