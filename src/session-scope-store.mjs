import { sessionScopeStorePath, tokenEncryptionSecret } from "./config.mjs";
import { readMemory } from "./company-brain-memory-authority.mjs";
import { guardedMemorySet } from "./memory-write-guard.mjs";
import { decryptSecretValue, encryptSecretValue } from "./secret-crypto.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const SESSION_EXPLICIT_AUTH_MEMORY_PREFIX = "session_explicit_auth:";

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
  const accessToken = typeof auth?.access_token === "string" ? auth.access_token.trim() : "";
  if (!normalizedSessionKey || !accessToken) {
    return null;
  }
  const store = await loadStore();
  const existing = store.sessions[normalizedSessionKey] || { session_key: normalizedSessionKey };
  existing.explicit_auth = {
    account_id: typeof auth?.account_id === "string" ? auth.account_id.trim() || null : null,
    access_token: encryptSecretValue(accessToken, tokenEncryptionSecret),
    source: typeof auth?.source === "string" ? auth.source.trim() || "session_user_access_token" : "session_user_access_token",
    updated_at: new Date().toISOString(),
  };
  existing.updated_at = new Date().toISOString();
  store.sessions[normalizedSessionKey] = existing;
  await writeJsonFile(sessionScopeStorePath, store);
  const decrypted = decryptSessionAuth(existing.explicit_auth);
  if (decrypted) {
    guardedMemorySet({
      key: buildSessionExplicitAuthMemoryKey(normalizedSessionKey),
      value: decrypted,
      source: "session-scope-store",
    });
  }
  return decrypted;
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

export async function listResolvedSessions() {
  const store = await loadStore();
  return Object.values(store.sessions)
    .map((session) => ({
      ...session,
      explicit_auth: sanitizeSessionAuth(session.explicit_auth),
    }))
    .sort((left, right) =>
      String(right.updated_at || "").localeCompare(String(left.updated_at || "")),
    );
}
