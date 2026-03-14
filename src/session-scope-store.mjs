import { sessionScopeStorePath } from "./config.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

function normalizeStore(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.sessions !== "object") {
    return { sessions: {} };
  }
  return { sessions: { ...payload.sessions } };
}

async function loadStore() {
  return normalizeStore(await readJsonFile(sessionScopeStorePath));
}

export async function touchResolvedSession(scope) {
  const store = await loadStore();
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
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(sessionScopeStorePath, store);
  return store.sessions[scope.session_key];
}

export async function listResolvedSessions() {
  const store = await loadStore();
  return Object.values(store.sessions).sort((left, right) =>
    String(right.updated_at || "").localeCompare(String(left.updated_at || "")),
  );
}
