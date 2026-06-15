import { sessionScopeStorePath, tokenEncryptionSecret } from "./config.mjs";
import { readMemory } from "./company-brain-memory-authority.mjs";
import { guardedMemorySet } from "./memory-write-guard.mjs";
import { decryptSecretValue, encryptSecretValue } from "./secret-crypto.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const SESSION_EXPLICIT_AUTH_MEMORY_PREFIX = "session_explicit_auth:";
const SESSION_ATTACHMENT_CONTEXT_MEMORY_PREFIX = "session_attachment_context:";

function normalizeStore(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.sessions !== "object") {
    return { sessions: {} };
  }
  return { sessions: { ...payload.sessions } };
}

async function loadStore() {
  return normalizeStore(await readJsonFile(sessionScopeStorePath));
}

function buildSessionExplicitAuthMemoryKey(sessionKey = "") {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return normalizedSessionKey ? `${SESSION_EXPLICIT_AUTH_MEMORY_PREFIX}${normalizedSessionKey}` : "";
}

function buildSessionAttachmentContextMemoryKey(sessionKey = "") {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return normalizedSessionKey ? `${SESSION_ATTACHMENT_CONTEXT_MEMORY_PREFIX}${normalizedSessionKey}` : "";
}

function buildResolvedSessionExplicitAuth(auth = null) {
  const accessToken = typeof auth?.access_token === "string" ? auth.access_token.trim() : "";
  if (!accessToken) {
    return null;
  }

  const updatedAt = new Date().toISOString();
  const accountId = typeof auth?.account_id === "string" ? auth.account_id.trim() || null : null;
  const source = typeof auth?.source === "string" ? auth.source.trim() || "session_user_access_token" : "session_user_access_token";

  return {
    decrypted: {
      account_id: accountId,
      access_token: accessToken,
      source,
      updated_at: updatedAt,
    },
    persisted: {
      account_id: accountId,
      access_token: encryptSecretValue(accessToken, tokenEncryptionSecret),
      source,
      updated_at: updatedAt,
    },
  };
}

function sanitizeSessionAuth(auth = null) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return null;
  }
  return {
    account_id: typeof auth.account_id === "string" ? auth.account_id.trim() || null : null,
    source: typeof auth.source === "string" ? auth.source.trim() || null : null,
    updated_at: typeof auth.updated_at === "string" ? auth.updated_at.trim() || null : null,
    has_explicit_user_access_token: Boolean(auth.access_token),
  };
}

function sanitizeAttachmentRefs(refs = []) {
  return (Array.isArray(refs) ? refs : [])
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const kind = typeof item.kind === "string" ? item.kind.trim() : "";
      const value = typeof item.value === "string" ? item.value.trim() : "";
      if (!kind || !value) {
        return null;
      }
      return {
        kind,
        value,
        name: typeof item.name === "string" ? item.name.trim() || null : null,
        mime: typeof item.mime === "string" ? item.mime.trim() || null : null,
        ext: typeof item.ext === "string" ? item.ext.trim() || null : null,
      };
    })
    .filter(Boolean);
}

function buildResolvedSessionAttachmentContext(context = null) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const kind = typeof context.kind === "string" ? context.kind.trim().toLowerCase() : "";
  if (!["pdf", "image", "office"].includes(kind)) {
    return null;
  }
  const refs = sanitizeAttachmentRefs(context.refs);
  if (!refs.length) {
    return null;
  }
  const updatedAtMs = Number.isFinite(Number(context.updated_at_ms))
    ? Number(context.updated_at_ms)
    : Date.now();
  return {
    kind,
    refs,
    message_id: typeof context.message_id === "string" ? context.message_id.trim() || null : null,
    download_state: typeof context.download_state === "string" ? context.download_state.trim() || null : null,
    last_failure: typeof context.last_failure === "string" ? context.last_failure.trim() || null : null,
    updated_at: new Date(updatedAtMs).toISOString(),
    updated_at_ms: updatedAtMs,
  };
}

function sanitizeSessionAttachmentContext(context = null) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const normalized = buildResolvedSessionAttachmentContext(context);
  if (!normalized) {
    return null;
  }
  return normalized;
}

function decryptSessionAuth(auth = null) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return null;
  }
  try {
    const accessToken = typeof auth.access_token === "string"
      ? decryptSecretValue(auth.access_token, tokenEncryptionSecret).trim()
      : "";
    if (!accessToken) {
      return null;
    }
    return {
      account_id: typeof auth.account_id === "string" ? auth.account_id.trim() || null : null,
      access_token: accessToken,
      source: typeof auth.source === "string" ? auth.source.trim() || "session_user_access_token" : "session_user_access_token",
      updated_at: typeof auth.updated_at === "string" ? auth.updated_at.trim() || null : null,
    };
  } catch {
    return null;
  }
}

export async function touchResolvedSession(scope) {
  const store = await loadStore();
  const previous = store.sessions[scope.session_key] || {};
  store.sessions[scope.session_key] = {
    session_key: scope.session_key,
    agent_binding_key: scope.agent_binding_key,
    capability_lane: scope.capability_lane,
    lane_label: scope.lane_label,
    lane_reason: scope.lane_reason,
    recommended_tools: Array.isArray(scope.recommended_tools) ? scope.recommended_tools : [],
    workspace_key: scope.workspace_key,
    sandbox_key: scope.sandbox_key,
    chat_type: scope.chat_type,
    chat_id: scope.chat_id,
    peer_key: scope.peer_key,
    sender_open_id: scope.sender_open_id,
    sender_user_id: scope.sender_user_id,
    last_message_id: scope.message_id,
    last_root_id: scope.root_id,
    last_thread_id: scope.thread_id,
    explicit_auth: previous.explicit_auth || null,
    active_attachment_context: sanitizeSessionAttachmentContext(previous.active_attachment_context),
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(sessionScopeStorePath, store);
  return {
    ...store.sessions[scope.session_key],
    explicit_auth: sanitizeSessionAuth(store.sessions[scope.session_key].explicit_auth),
  };
}

export async function setResolvedSessionExplicitAuth(sessionKey, auth = null) {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const resolvedAuth = buildResolvedSessionExplicitAuth(auth);
  if (!normalizedSessionKey || !resolvedAuth) {
    return null;
  }

  guardedMemorySet({
    key: buildSessionExplicitAuthMemoryKey(normalizedSessionKey),
    value: resolvedAuth.decrypted,
    source: "session-scope-store",
  });

  const store = await loadStore();
  const existing = store.sessions[normalizedSessionKey] || { session_key: normalizedSessionKey };
  existing.explicit_auth = resolvedAuth.persisted;
  existing.updated_at = resolvedAuth.decrypted.updated_at;
  store.sessions[normalizedSessionKey] = existing;
  await writeJsonFile(sessionScopeStorePath, store);
  return resolvedAuth.decrypted;
}

export async function setResolvedSessionActiveAttachmentContext(sessionKey, context = null) {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const resolvedContext = buildResolvedSessionAttachmentContext(context);
  if (!normalizedSessionKey || !resolvedContext) {
    return null;
  }

  guardedMemorySet({
    key: buildSessionAttachmentContextMemoryKey(normalizedSessionKey),
    value: resolvedContext,
    source: "session-scope-store",
  });

  const store = await loadStore();
  const existing = store.sessions[normalizedSessionKey] || { session_key: normalizedSessionKey };
  existing.active_attachment_context = resolvedContext;
  existing.updated_at = resolvedContext.updated_at;
  store.sessions[normalizedSessionKey] = existing;
  await writeJsonFile(sessionScopeStorePath, store);
  return resolvedContext;
}

export async function getResolvedSessionExplicitAuth(sessionKey) {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!normalizedSessionKey) {
    return null;
  }
  const memory = readMemory({
    key: buildSessionExplicitAuthMemoryKey(normalizedSessionKey),
  });
  if (memory.ok === true && memory.data?.value) {
    return memory.data.value;
  }
  const store = await loadStore();
  const decrypted = decryptSessionAuth(store.sessions[normalizedSessionKey]?.explicit_auth || null);
  if (decrypted) {
    guardedMemorySet({
      key: buildSessionExplicitAuthMemoryKey(normalizedSessionKey),
      value: decrypted,
      source: "session-scope-store",
    });
  }
  return decrypted;
}

export async function getResolvedSessionActiveAttachmentContext(sessionKey, { kind = "" } = {}) {
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const normalizedKind = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  if (!normalizedSessionKey) {
    return null;
  }
  const memory = readMemory({
    key: buildSessionAttachmentContextMemoryKey(normalizedSessionKey),
  });
  const memoryValue = memory.ok === true ? sanitizeSessionAttachmentContext(memory.data?.value || null) : null;
  if (memoryValue && (!normalizedKind || memoryValue.kind === normalizedKind)) {
    return memoryValue;
  }
  const store = await loadStore();
  const persisted = sanitizeSessionAttachmentContext(store.sessions[normalizedSessionKey]?.active_attachment_context || null);
  if (persisted) {
    guardedMemorySet({
      key: buildSessionAttachmentContextMemoryKey(normalizedSessionKey),
      value: persisted,
      source: "session-scope-store",
    });
  }
  if (!persisted) {
    return null;
  }
  if (normalizedKind && persisted.kind !== normalizedKind) {
    return null;
  }
  return persisted;
}

export async function listResolvedSessions() {
  const store = await loadStore();
  return Object.values(store.sessions)
    .map((session) => ({
      ...session,
      explicit_auth: sanitizeSessionAuth(session.explicit_auth),
      active_attachment_context: sanitizeSessionAttachmentContext(session.active_attachment_context),
    }))
    .sort((left, right) =>
      String(right.updated_at || "").localeCompare(String(left.updated_at || "")),
    );
}
