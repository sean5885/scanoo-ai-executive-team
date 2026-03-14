import { lobsterBindingStrategy, lobsterSharedWorkspaceKey } from "./config.mjs";
import { resolveCapabilityLane } from "./capability-lane.mjs";

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeChatType(value) {
  const raw = clean(value)?.toLowerCase();
  if (raw === "p2p" || raw === "private") {
    return "dm";
  }
  if (raw === "group" || raw === "chat") {
    return "group";
  }
  return raw || "unknown";
}

function buildBindingInput(input = {}) {
  const senderOpenId =
    clean(input.sender_open_id) ||
    clean(input.sender?.sender_id?.open_id) ||
    clean(input.event?.sender?.sender_id?.open_id) ||
    null;
  const senderUserId =
    clean(input.sender_user_id) ||
    clean(input.sender?.sender_id?.user_id) ||
    clean(input.event?.sender?.sender_id?.user_id) ||
    null;
  const chatId =
    clean(input.chat_id) ||
    clean(input.message?.chat_id) ||
    clean(input.event?.message?.chat_id) ||
    null;
  const messageId =
    clean(input.message_id) ||
    clean(input.message?.message_id) ||
    clean(input.event?.message?.message_id) ||
    null;
  const rootId =
    clean(input.root_id) ||
    clean(input.message?.root_id) ||
    clean(input.event?.message?.root_id) ||
    null;
  const threadId =
    clean(input.thread_id) ||
    clean(input.message?.thread_id) ||
    clean(input.event?.message?.thread_id) ||
    null;
  const tenantKey =
    clean(input.tenant_key) ||
    clean(input.sender?.tenant_key) ||
    clean(input.event?.sender?.tenant_key) ||
    null;
  const chatType = normalizeChatType(
    input.chat_type ||
      input.message?.chat_type ||
      input.event?.message?.chat_type,
  );
  const channel = clean(input.channel) || "lark";
  const botId = clean(input.bot_id) || clean(input.app_id) || "lobster";

  return {
    channel,
    bot_id: botId,
    tenant_key: tenantKey,
    chat_type: chatType,
    chat_id: chatId,
    sender_open_id: senderOpenId,
    sender_user_id: senderUserId,
    message_id: messageId,
    root_id: rootId,
    thread_id: threadId,
  };
}

function resolvePeerKey(binding) {
  if (binding.chat_type === "group") {
    return clean(binding.chat_id) || "unknown-group";
  }
  return clean(binding.sender_open_id) || clean(binding.sender_user_id) || clean(binding.chat_id) || "unknown-peer";
}

function resolveWorkspaceKey(binding) {
  if (lobsterBindingStrategy === "per_peer_workspace") {
    return `workspace:${binding.channel}:peer:${resolvePeerKey(binding)}`;
  }
  if (lobsterBindingStrategy === "per_account_channel_peer") {
    return `workspace:${binding.channel}:tenant:${binding.tenant_key || "local"}:shared`;
  }
  return lobsterSharedWorkspaceKey;
}

function resolveAgentBindingKey(binding) {
  if (lobsterBindingStrategy === "per_peer_workspace") {
    return `agent:${binding.channel}:peer:${resolvePeerKey(binding)}`;
  }
  if (binding.chat_type === "group") {
    return `agent:${binding.channel}:group-shared`;
  }
  return `agent:${binding.channel}:shared-assistant`;
}

export function resolveLarkBindingRuntime(input = {}) {
  const binding = buildBindingInput(input);
  const peerKey = resolvePeerKey(binding);
  const workspaceKey = resolveWorkspaceKey(binding);
  const sessionKey = `session:${binding.channel}:${binding.chat_type}:${peerKey}`;
  const sandboxKey = `sandbox:${binding.channel}:${binding.chat_type}:${peerKey}`;
  const dmScope = binding.chat_type === "group" ? "group_chat" : "direct_message";
  const lane = resolveCapabilityLane(
    {
      chat_type: binding.chat_type,
      session_key: sessionKey,
      workspace_key: workspaceKey,
    },
    input,
  );

  return {
    binding_strategy: lobsterBindingStrategy,
    channel: binding.channel,
    bot_id: binding.bot_id,
    tenant_key: binding.tenant_key,
    peer_key: peerKey,
    chat_type: binding.chat_type,
    chat_id: binding.chat_id,
    sender_open_id: binding.sender_open_id,
    sender_user_id: binding.sender_user_id,
    message_id: binding.message_id,
    root_id: binding.root_id,
    thread_id: binding.thread_id,
    scope_mode: dmScope,
    agent_binding_key: resolveAgentBindingKey(binding),
    capability_lane: lane.capability_lane,
    lane_label: lane.lane_label,
    lane_reason: lane.lane_reason,
    recommended_tools: lane.recommended_tools,
    workspace_key: workspaceKey,
    session_key: sessionKey,
    sandbox_key: sandboxKey,
    session_scope: "per-channel-peer",
    workspace_scope:
      lobsterBindingStrategy === "per_peer_workspace" ? "per-peer" : "shared-company",
    recommended_memory_layers: {
      shared_workspace_memory: workspaceKey,
      per_peer_session_memory: sessionKey,
      optional_profile_memory:
        binding.chat_type === "group"
          ? null
          : `profile:${binding.channel}:${peerKey}`,
    },
  };
}
