import crypto from "node:crypto";
import {
  larkWriteBudgetDuplicateWindowMs,
  larkWriteBudgetHardLimit,
  larkWriteBudgetHardWhitelist,
  larkWriteBudgetNearRatio,
  larkWriteBudgetSoftLimit,
  larkWriteBudgetStorePath,
  larkWriteBudgetWindowMs,
} from "./config.mjs";
import { createRuntimeLogger } from "./runtime-observability.mjs";
import { nowIso } from "./text-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const budgetLogger = createRuntimeLogger({ logger: console, component: "lark_write_budget_guard" });

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeBoolean(value) {
  return value === true;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeStore(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.events)) {
    return { events: [] };
  }
  return {
    events: payload.events
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: cleanText(item.id) || crypto.randomUUID(),
        api_name: cleanText(item.api_name) || null,
        action: cleanText(item.action) || null,
        account_id: cleanText(item.account_id) || null,
        session_key: cleanText(item.session_key) || null,
        scope_key: cleanText(item.scope_key) || null,
        document_id: cleanText(item.document_id) || null,
        content_hash: cleanText(item.content_hash) || null,
        request_fingerprint: cleanText(item.request_fingerprint) || null,
        idempotency_key: cleanText(item.idempotency_key) || null,
        write_intent: normalizeBoolean(item.write_intent),
        blocked: normalizeBoolean(item.blocked),
        allowed: normalizeBoolean(item.allowed),
        whitelist: normalizeBoolean(item.whitelist),
        essential: normalizeBoolean(item.essential),
        reason: cleanText(item.reason) || null,
        metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
          ? item.metadata
          : {},
        created_at: cleanText(item.created_at) || nowIso(),
      })),
  };
}

async function loadStore() {
  const raw = await readJsonFile(larkWriteBudgetStorePath);
  const store = normalizeStore(raw);
  const retentionMs = Math.max(larkWriteBudgetWindowMs, larkWriteBudgetDuplicateWindowMs);
  const cutoff = Date.now() - retentionMs;
  const nextEvents = store.events.filter((item) => {
    const createdAt = Date.parse(item.created_at || "");
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
  if (nextEvents.length !== store.events.length) {
    await writeJsonFile(larkWriteBudgetStorePath, { events: nextEvents });
    return { events: nextEvents };
  }
  return store;
}

async function saveStore(store) {
  await writeJsonFile(larkWriteBudgetStorePath, store);
}

function buildBudgetEvent(apiName, metadata = {}) {
  const requestFingerprint = cleanText(metadata.request_fingerprint)
    || buildRequestFingerprint(apiName, metadata);
  const idempotencyKey = cleanText(metadata.idempotency_key) || null;
  const contentHash = cleanText(metadata.content_hash)
    || (cleanText(metadata.content) ? hashValue(metadata.content) : null);

  return {
    id: crypto.randomUUID(),
    api_name: cleanText(apiName) || "unknown_api",
    action: cleanText(metadata.action) || cleanText(metadata.operation) || null,
    account_id: cleanText(metadata.account_id) || null,
    session_key: cleanText(metadata.session_key) || cleanText(metadata.scope_key) || cleanText(metadata.account_id) || null,
    scope_key: cleanText(metadata.scope_key) || null,
    document_id: cleanText(metadata.document_id) || null,
    content_hash: contentHash,
    request_fingerprint: requestFingerprint,
    idempotency_key: idempotencyKey,
    write_intent: metadata.write_intent !== false,
    blocked: normalizeBoolean(metadata.blocked),
    allowed: normalizeBoolean(metadata.allowed),
    whitelist: normalizeBoolean(metadata.whitelist),
    essential: normalizeBoolean(metadata.essential),
    reason: cleanText(metadata.reason) || null,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
    created_at: nowIso(),
  };
}

function collectBudgetEvents(store = { events: [] }) {
  const cutoff = Date.now() - larkWriteBudgetWindowMs;
  return store.events.filter((item) => {
    const createdAt = Date.parse(item.created_at || "");
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

function summarizeBudgetState(events = []) {
  const writeEvents = events.filter((item) => item.write_intent === true);
  const blockedEvents = writeEvents.filter((item) => item.blocked === true);
  const perApi = new Map();

  for (const item of writeEvents) {
    const current = perApi.get(item.api_name) || {
      api_name: item.api_name,
      total: 0,
      blocked: 0,
      last_at: null,
    };
    current.total += 1;
    if (item.blocked) {
      current.blocked += 1;
    }
    current.last_at = item.created_at;
    perApi.set(item.api_name, current);
  }

  return {
    window_ms: larkWriteBudgetWindowMs,
    soft_limit: larkWriteBudgetSoftLimit,
    hard_limit: larkWriteBudgetHardLimit,
    near_ratio: larkWriteBudgetNearRatio,
    total_events: events.length,
    write_events: writeEvents.length,
    blocked_writes: blockedEvents.length,
    remaining_to_soft_limit: Math.max(0, larkWriteBudgetSoftLimit - writeEvents.length),
    remaining_to_hard_limit: Math.max(0, larkWriteBudgetHardLimit - writeEvents.length),
    per_api: [...perApi.values()].sort((a, b) => b.total - a.total || a.api_name.localeCompare(b.api_name)),
  };
}

function findDuplicateEvent(store, event) {
  const cutoff = Date.now() - larkWriteBudgetDuplicateWindowMs;
  const events = store.events.filter((item) => {
    const createdAt = Date.parse(item.created_at || "");
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });

  if (event.idempotency_key) {
    const byIdempotency = events.find((item) =>
      item.idempotency_key
      && item.idempotency_key === event.idempotency_key
      && item.api_name === event.api_name
      && item.write_intent === true,
    );
    if (byIdempotency) {
      return { type: "idempotency_key", event: byIdempotency };
    }
    return null;
  }

  if (event.request_fingerprint && event.session_key) {
    const bySessionFingerprint = events.find((item) =>
      item.request_fingerprint
      && item.request_fingerprint === event.request_fingerprint
      && item.session_key === event.session_key
      && item.api_name === event.api_name
      && item.write_intent === true,
    );
    if (bySessionFingerprint) {
      return { type: "same_session_duplicate", event: bySessionFingerprint };
    }
  }

  if (event.document_id && event.content_hash) {
    const byDocumentContent = events.find((item) =>
      item.document_id
      && item.document_id === event.document_id
      && item.content_hash
      && item.content_hash === event.content_hash
      && item.api_name === event.api_name
      && item.allowed === true,
    );
    if (byDocumentContent) {
      return { type: "same_doc_duplicate_content", event: byDocumentContent };
    }
  }

  return null;
}

export function buildRequestFingerprint(apiName, metadata = {}) {
  const normalized = {
    api_name: cleanText(apiName) || "unknown_api",
    account_id: cleanText(metadata.account_id) || null,
    session_key: cleanText(metadata.session_key) || cleanText(metadata.scope_key) || null,
    scope_key: cleanText(metadata.scope_key) || null,
    document_id: cleanText(metadata.document_id) || null,
    target_document_id: cleanText(metadata.target_document_id) || null,
    confirmation_id: cleanText(metadata.confirmation_id) || null,
    mode: cleanText(metadata.mode) || null,
    content_hash: cleanText(metadata.content_hash)
      || (cleanText(metadata.content) ? hashValue(metadata.content) : null),
    preview_plan_hash: metadata.preview_plan ? hashValue(stableSerialize(metadata.preview_plan)) : null,
    payload_hash: metadata.payload ? hashValue(stableSerialize(metadata.payload)) : null,
  };
  return hashValue(stableSerialize(normalized));
}

export async function recordCall(apiName, metadata = {}) {
  const store = await loadStore();
  const event = buildBudgetEvent(apiName, metadata);
  store.events.push(event);
  await saveStore(store);
  return {
    event,
    budget_state: summarizeBudgetState(collectBudgetEvents(store)),
  };
}

export async function getBudgetState() {
  const store = await loadStore();
  return summarizeBudgetState(collectBudgetEvents(store));
}

export function isNearLimit(state = null) {
  const resolved = state || {};
  const writeEvents = Number(resolved.write_events || 0);
  const softLimit = Number(resolved.soft_limit || larkWriteBudgetSoftLimit);
  if (softLimit <= 0) {
    return false;
  }
  return writeEvents >= Math.ceil(softLimit * larkWriteBudgetNearRatio);
}

export function isOverSoftLimit(state = null) {
  const resolved = state || {};
  return Number(resolved.write_events || 0) >= Number(resolved.soft_limit || larkWriteBudgetSoftLimit);
}

export function isOverHardLimit(state = null) {
  const resolved = state || {};
  return Number(resolved.write_events || 0) >= Number(resolved.hard_limit || larkWriteBudgetHardLimit);
}

export function fallbackToPreviewReason(input = {}) {
  const reason = cleanText(input.reason || input);
  switch (reason) {
    case "over_soft_limit":
      return "write_budget_soft_limit_reached";
    case "over_hard_limit":
      return "write_budget_hard_limit_reached";
    case "idempotency_key":
      return "duplicate_write_idempotency_key";
    case "same_session_duplicate":
      return "duplicate_write_same_session";
    case "same_doc_duplicate_content":
      return "duplicate_write_same_doc_content";
    default:
      return "write_budget_guard_forced_preview";
  }
}

export async function shouldAllowWrite(apiNameOrOptions = {}, maybeMetadata = {}) {
  const apiName = typeof apiNameOrOptions === "string"
    ? apiNameOrOptions
    : cleanText(apiNameOrOptions.apiName) || cleanText(apiNameOrOptions.api_name);
  const metadata = typeof apiNameOrOptions === "string"
    ? maybeMetadata
    : apiNameOrOptions.metadata && typeof apiNameOrOptions.metadata === "object"
      ? apiNameOrOptions.metadata
      : apiNameOrOptions;
  const logger = apiNameOrOptions?.logger || maybeMetadata?.logger || budgetLogger;
  const store = await loadStore();
  const budgetState = summarizeBudgetState(collectBudgetEvents(store));
  const event = buildBudgetEvent(apiName, metadata);
  const whitelist = normalizeBoolean(metadata.whitelist) || larkWriteBudgetHardWhitelist.includes(event.api_name);
  const duplicate = findDuplicateEvent(store, event);

  if (duplicate) {
    const reason = fallbackToPreviewReason(duplicate.type);
    const blocked = {
      allow: false,
      reason,
      duplicate_type: duplicate.type,
      fallback_to_preview: true,
      budget_state: budgetState,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
    };
    await recordCall(event.api_name, {
      ...metadata,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
      blocked: true,
      allowed: false,
      reason,
    });
    logger?.warn?.("lark_write_budget_guard_blocked", {
      action: event.api_name,
      reason,
      duplicate_type: duplicate.type,
      account_id: event.account_id,
      session_key: event.session_key,
      scope_key: event.scope_key,
      document_id: event.document_id,
      write_budget: budgetState,
    });
    return blocked;
  }

  if (isOverHardLimit(budgetState) && !whitelist) {
    const reason = fallbackToPreviewReason("over_hard_limit");
    const blocked = {
      allow: false,
      reason,
      fallback_to_preview: true,
      budget_state: budgetState,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
    };
    await recordCall(event.api_name, {
      ...metadata,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
      blocked: true,
      allowed: false,
      whitelist,
      reason,
    });
    logger?.warn?.("lark_write_budget_guard_blocked", {
      action: event.api_name,
      reason,
      account_id: event.account_id,
      scope_key: event.scope_key,
      document_id: event.document_id,
      write_budget: budgetState,
    });
    return blocked;
  }

  if (isOverSoftLimit(budgetState) && !whitelist && metadata.essential !== true) {
    const reason = fallbackToPreviewReason("over_soft_limit");
    const blocked = {
      allow: false,
      reason,
      fallback_to_preview: true,
      budget_state: budgetState,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
    };
    await recordCall(event.api_name, {
      ...metadata,
      request_fingerprint: event.request_fingerprint,
      idempotency_key: event.idempotency_key,
      blocked: true,
      allowed: false,
      whitelist,
      reason,
    });
    logger?.warn?.("lark_write_budget_guard_soft_limit", {
      action: event.api_name,
      reason,
      account_id: event.account_id,
      scope_key: event.scope_key,
      document_id: event.document_id,
      write_budget: budgetState,
    });
    return blocked;
  }

  return {
    allow: true,
    reason: null,
    fallback_to_preview: false,
    budget_state: budgetState,
    near_limit: isNearLimit(budgetState),
    request_fingerprint: event.request_fingerprint,
    idempotency_key: event.idempotency_key,
    whitelist,
  };
}
