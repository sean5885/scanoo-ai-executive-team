import { resolveCapabilityLane } from "./capability-lane.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const PLUGIN_NATIVE_TOOL_PATTERNS = [
  /^lark_doc_/,
  /^lark_message_/,
  /^lark_messages_/,
  /^lark_calendar_/,
  /^lark_task_/,
  /^lark_tasks_/,
  /^lark_bitable_/,
  /^lark_spreadsheet_/,
  /^lark_drive_/,
  /^lark_wiki_/,
  /^company_brain_/,
  /^lobster_security_/,
  /^lark_kb_status$/,
  /^lark_kb_sync$/,
];

const KNOWLEDGE_ANSWER_TOOL_PATTERNS = [
  /^lark_kb_answer$/,
];

const SUPPORTED_PLUGIN_DISPATCH_LANES = new Set([
  "knowledge-assistant",
  "scanoo-diagnose",
  "doc-editor",
  "group-shared-assistant",
  "personal-assistant",
]);

const REQUESTED_CAPABILITY_ROUTE_MAP = {
  knowledge_answer: {
    route_target: "knowledge_answer",
    mapped_lane: "knowledge-assistant",
    chosen_lane: "knowledge-assistant",
    lane_mapping_source: "explicit",
    chosen_skill: null,
    fallback_reason: "knowledge_answer_path",
  },
  scanoo_diagnose: {
    route_target: "lane_backend",
    mapped_lane: "scanoo-diagnose",
    chosen_lane: "scanoo-diagnose",
    lane_mapping_source: "explicit",
    chosen_skill: "scanoo_diagnose",
    fallback_lane: "knowledge-assistant",
    fallback_reason_on_miss: "missing_exact_scanoo_diagnose_lane_fallback_to_knowledge_assistant",
  },
  scanoo_compare: {
    route_target: "lane_backend",
    mapped_lane: "knowledge-assistant",
    chosen_lane: "knowledge-assistant",
    lane_mapping_source: "fallback",
    chosen_skill: "scanoo_compare",
    fallback_reason: "missing_exact_scanoo_compare_lane_fallback_to_knowledge_assistant",
  },
  scanoo_optimize: {
    route_target: "lane_backend",
    mapped_lane: "knowledge-assistant",
    chosen_lane: "knowledge-assistant",
    lane_mapping_source: "fallback",
    chosen_skill: "scanoo_optimize",
    fallback_reason: "missing_exact_scanoo_optimize_lane_fallback_to_knowledge_assistant",
  },
  lane_style_capability: {
    route_target: "lane_backend",
    mapped_lane: "personal-assistant",
    chosen_lane: "personal-assistant",
    lane_mapping_source: "fallback",
    chosen_skill: "lane_style_capability",
    fallback_reason: "lane_style_capability",
  },
};

const LANE_STYLE_PATTERNS = [
  /scanoo/i,
  /分析/u,
  /分析一下/u,
  /診斷/u,
  /诊断/u,
  /比較/u,
  /比较/u,
  /優化/u,
  /优化/u,
  /compare/i,
  /diagnos/i,
  /optimi[sz]/i,
];

const DIRECT_INGRESS_SOURCES = new Set([
  "direct_http_answer",
  "direct_lark_long_connection",
  "direct_ingress",
]);

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    if (!error) {
      return null;
    }
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        message: error.message || "unknown_error",
      };
    }
    return {
      message: String(error),
    };
  },
};

function safeUpperMethod(value) {
  const method = cleanText(value).toUpperCase();
  return method || "GET";
}

function parseRouteQuery(pathname = "") {
  const rawPath = cleanText(pathname);
  if (!rawPath) {
    return new URLSearchParams();
  }
  const parsed = new URL(rawPath, "http://dispatch.local");
  return parsed.searchParams;
}

function normalizeRouteRequest(routeRequest = {}) {
  const path = cleanText(routeRequest?.path || routeRequest?.pathname || "");
  return {
    path,
    method: safeUpperMethod(routeRequest?.method),
    body: routeRequest?.body && typeof routeRequest.body === "object" && !Array.isArray(routeRequest.body)
      ? { ...routeRequest.body }
      : routeRequest?.body ?? null,
  };
}

function normalizeCapabilitySource(value = "") {
  const source = cleanText(value);
  if (source === "explicit" || source === "inferred") {
    return source;
  }
  return null;
}

function normalizeLaneMappingSource(value = "") {
  const source = cleanText(value);
  if (source === "explicit" || source === "fallback") {
    return source;
  }
  return null;
}

function inferRequestText(raw = {}, routeRequest = {}) {
  const explicit = cleanText(
    raw?.request_text
    || raw?.q
    || raw?.query
    || raw?.text
    || raw?.prompt
    || raw?.title
    || raw?.skill_query
    || routeRequest?.body?.q
    || routeRequest?.body?.query
    || routeRequest?.body?.text,
  );
  if (explicit) {
    return explicit;
  }

  const query = parseRouteQuery(routeRequest?.path || "");
  return cleanText(query.get("q") || query.get("query") || query.get("text") || "") || null;
}

export function buildLarkPluginDispatchSessionKey({
  thread_id = "",
  chat_id = "",
  session_id = "",
} = {}) {
  const threadId = cleanText(thread_id);
  if (threadId) {
    return `thread:${threadId}`;
  }

  const chatId = cleanText(chat_id);
  if (chatId) {
    return `chat:${chatId}`;
  }

  const sessionId = cleanText(session_id);
  if (sessionId) {
    return `session:${sessionId}`;
  }

  return "";
}

export function inferRequestedCapability({
  requested_capability = "",
} = {}) {
  return cleanText(requested_capability) || null;
}

export function normalizeLarkPluginDispatchRequest(raw = {}) {
  const routeRequest = normalizeRouteRequest(raw?.route_request || {});
  const query = parseRouteQuery(routeRequest.path);
  const requestText = inferRequestText(raw, routeRequest);
  const accountId = cleanText(
    raw?.account_id
    || raw?.route_request?.body?.account_id
    || query.get("account_id")
    || "",
  );

  const normalized = {
    request_text: requestText,
    session_id: cleanText(raw?.session_id),
    thread_id: cleanText(raw?.thread_id),
    chat_id: cleanText(raw?.chat_id),
    user_id: cleanText(raw?.user_id),
    account_id: accountId,
    source: cleanText(raw?.source || "official_lark_plugin") || "official_lark_plugin",
    tool_name: cleanText(raw?.tool_name),
    requested_capability: inferRequestedCapability({
      requested_capability: raw?.requested_capability,
    }),
    capability_source: normalizeCapabilitySource(raw?.capability_source),
    user_access_token: cleanText(raw?.user_access_token),
    route_request: routeRequest,
  };

  return {
    ...normalized,
    resolved_session_key: buildLarkPluginDispatchSessionKey(normalized),
  };
}

export function resolveDirectIngressSourceState({
  source = "",
  directIngressPrimaryEnabled = false,
} = {}) {
  const normalizedSource = cleanText(source);
  const isDirectIngress = DIRECT_INGRESS_SOURCES.has(normalizedSource);
  return {
    is_direct_ingress: isDirectIngress,
    is_primary_entry: isDirectIngress ? directIngressPrimaryEnabled === true : normalizedSource === "official_lark_plugin",
    fallback_reason: isDirectIngress && directIngressPrimaryEnabled !== true ? "direct_ingress_not_primary" : null,
  };
}

function matchesAnyPattern(value = "", patterns = []) {
  const text = cleanText(value);
  return patterns.some((pattern) => pattern.test(text));
}

function isPluginNativeRequest(normalizedRequest = {}) {
  return matchesAnyPattern(normalizedRequest?.tool_name, PLUGIN_NATIVE_TOOL_PATTERNS)
    || matchesAnyPattern(normalizedRequest?.requested_capability, PLUGIN_NATIVE_TOOL_PATTERNS);
}

function isKnowledgeAnswerRequest(normalizedRequest = {}) {
  return matchesAnyPattern(normalizedRequest?.tool_name, KNOWLEDGE_ANSWER_TOOL_PATTERNS)
    || cleanText(normalizedRequest?.requested_capability) === "knowledge_answer"
    || cleanText(normalizedRequest?.route_request?.path).startsWith("/answer");
}

function isLaneStyleRequest(normalizedRequest = {}) {
  return matchesAnyPattern(normalizedRequest?.request_text, LANE_STYLE_PATTERNS);
}

function resolveLaneChoice(normalizedRequest = {}) {
  const fallbackChatId = cleanText(normalizedRequest?.chat_id || normalizedRequest?.thread_id || normalizedRequest?.session_id || "plugin_dispatch");
  const baseScope = {
    chat_type: "dm",
    chat_id: fallbackChatId,
    session_key: cleanText(normalizedRequest?.resolved_session_key || fallbackChatId),
    workspace_key: "workspace:lark_plugin_dispatch",
  };
  const syntheticInput = {
    message_text: cleanText(normalizedRequest?.request_text),
    text: cleanText(normalizedRequest?.request_text),
    message: {
      chat_id: fallbackChatId,
      content: JSON.stringify({ text: cleanText(normalizedRequest?.request_text) }),
    },
  };
  return resolveCapabilityLane(baseScope, syntheticInput)?.capability_lane || "personal-assistant";
}

function resolveChosenSkill(normalizedRequest = {}, routeTarget = "") {
  if (cleanText(routeTarget) !== "lane_backend") {
    return null;
  }
  const requestedCapability = cleanText(normalizedRequest?.requested_capability);
  if (requestedCapability && requestedCapability !== "knowledge_answer") {
    return requestedCapability;
  }
  if (/scanoo/i.test(cleanText(normalizedRequest?.request_text))) {
    return "scanoo";
  }
  return null;
}

export function resolveRequestedCapabilityLaneMapping({
  requestedCapability = "",
  capabilityRouteMap = REQUESTED_CAPABILITY_ROUTE_MAP,
  supportedPluginDispatchLanes = SUPPORTED_PLUGIN_DISPATCH_LANES,
} = {}) {
  const normalizedCapability = cleanText(requestedCapability);
  if (!normalizedCapability) {
    return null;
  }

  const mapping = capabilityRouteMap?.[normalizedCapability];
  if (!mapping) {
    return null;
  }

  const routeTarget = cleanText(mapping?.route_target) || "plugin_native";
  const requestedLane = cleanText(mapping?.mapped_lane || mapping?.chosen_lane);
  const supportedLane = requestedLane && supportedPluginDispatchLanes.has(requestedLane)
    ? requestedLane
    : null;

  if (routeTarget === "lane_backend" && !supportedLane) {
    const fallbackLane = cleanText(mapping?.fallback_lane);
    const supportedFallbackLane = fallbackLane && supportedPluginDispatchLanes.has(fallbackLane)
      ? fallbackLane
      : null;
    return {
      route_target: routeTarget,
      mapped_lane: supportedFallbackLane || "personal-assistant",
      chosen_lane: supportedFallbackLane || "personal-assistant",
      lane_mapping_source: "fallback",
      chosen_skill: cleanText(mapping?.chosen_skill) || normalizedCapability,
      fallback_reason: cleanText(mapping?.fallback_reason_on_miss)
        || cleanText(mapping?.fallback_reason)
        || "mapped_lane_missing_or_unsupported_fallback_to_personal_assistant",
    };
  }

  return {
    route_target: routeTarget,
    mapped_lane: supportedLane,
    chosen_lane: supportedLane,
    lane_mapping_source: normalizeLaneMappingSource(mapping?.lane_mapping_source)
      || (supportedLane ? "explicit" : null),
    chosen_skill: cleanText(mapping?.chosen_skill) || null,
    fallback_reason: cleanText(mapping?.fallback_reason) || null,
  };
}

function resolveRequestedCapabilityDecision(normalizedRequest = {}) {
  const requestedCapability = cleanText(normalizedRequest?.requested_capability);
  if (!requestedCapability) {
    return null;
  }

  const capabilityLaneMapping = resolveRequestedCapabilityLaneMapping({
    requestedCapability,
  });
  if (capabilityLaneMapping) {
    return capabilityLaneMapping;
  }

  if (matchesAnyPattern(requestedCapability, PLUGIN_NATIVE_TOOL_PATTERNS)) {
    return {
      route_target: "plugin_native",
      mapped_lane: null,
      chosen_lane: null,
      lane_mapping_source: "fallback",
      chosen_skill: null,
      fallback_reason: "plugin_native_capability",
    };
  }

  return {
    route_target: "plugin_native",
    mapped_lane: null,
    chosen_lane: null,
    lane_mapping_source: "fallback",
    chosen_skill: null,
    fallback_reason: "unknown_capability_fallback_plugin_native",
  };
}

export function resolveLarkPluginDispatchDecision(normalizedRequest = {}, {
  pluginHybridDispatchEnabled = true,
  directIngressPrimaryEnabled = false,
} = {}) {
  const ingressState = resolveDirectIngressSourceState({
    source: normalizedRequest?.source,
    directIngressPrimaryEnabled,
  });

  let routeTarget = "plugin_native";
  let mappedLane = null;
  let chosenLane = null;
  let laneMappingSource = null;
  let chosenSkill = null;
  let fallbackReason = ingressState.fallback_reason;

  if (pluginHybridDispatchEnabled !== true) {
    fallbackReason = fallbackReason || "plugin_hybrid_dispatch_disabled";
  } else {
    const capabilityDecision = resolveRequestedCapabilityDecision(normalizedRequest);
    if (capabilityDecision) {
      routeTarget = capabilityDecision.route_target;
      mappedLane = capabilityDecision.mapped_lane || null;
      chosenLane = capabilityDecision.chosen_lane;
      laneMappingSource = capabilityDecision.lane_mapping_source || null;
      chosenSkill = capabilityDecision.chosen_skill;
      fallbackReason = fallbackReason || capabilityDecision.fallback_reason;
    } else if (isPluginNativeRequest(normalizedRequest)) {
      laneMappingSource = "fallback";
      fallbackReason = fallbackReason || "plugin_native_capability";
    } else if (isLaneStyleRequest(normalizedRequest)) {
      routeTarget = "lane_backend";
      mappedLane = resolveLaneChoice(normalizedRequest);
      chosenLane = resolveLaneChoice(normalizedRequest);
      laneMappingSource = "fallback";
      chosenSkill = resolveChosenSkill(normalizedRequest, routeTarget);
      fallbackReason = fallbackReason || "lane_style_capability";
    } else if (isKnowledgeAnswerRequest(normalizedRequest)) {
      routeTarget = "knowledge_answer";
      mappedLane = "knowledge-assistant";
      chosenLane = "knowledge-assistant";
      laneMappingSource = "explicit";
      fallbackReason = fallbackReason || "knowledge_answer_path";
    } else {
      laneMappingSource = "fallback";
      fallbackReason = fallbackReason || "unknown_capability_fallback_plugin_native";
    }
  }

  return {
    route_target: routeTarget,
    mapped_lane: mappedLane,
    chosen_lane: chosenLane,
    lane_mapping_source: laneMappingSource,
    chosen_skill: chosenSkill || resolveChosenSkill(normalizedRequest, routeTarget),
    fallback_reason: fallbackReason,
    is_primary_entry: ingressState.is_primary_entry === true,
    ingress_state: ingressState,
  };
}

function resolveExplicitLaneContext(normalizedRequest = {}, preferredLane = "") {
  const lane = cleanText(preferredLane);
  if (!lane) {
    return null;
  }
  if (lane === "scanoo-diagnose") {
    return {
      capability_lane: "scanoo-diagnose",
      lane_label: "Scanoo 診斷助手",
      lane_reason: "plugin_dispatch_requested_capability",
    };
  }
  if (lane === "knowledge-assistant") {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "plugin_dispatch_requested_capability",
    };
  }
  if (lane === "doc-editor") {
    return {
      capability_lane: "doc-editor",
      lane_label: "文檔編輯助手",
      lane_reason: "plugin_dispatch_requested_capability",
    };
  }
  if (lane === "group-shared-assistant") {
    return {
      capability_lane: "group-shared-assistant",
      lane_label: "群組共享助手",
      lane_reason: "plugin_dispatch_requested_capability",
    };
  }
  return {
    capability_lane: "personal-assistant",
    lane_label: "個人助手",
    lane_reason: "plugin_dispatch_requested_capability",
  };
}

export function buildLarkPluginLaneContext(normalizedRequest = {}, preferredLane = "") {
  const fallbackChatId = cleanText(normalizedRequest?.chat_id || normalizedRequest?.thread_id || normalizedRequest?.session_id || "plugin_dispatch");
  const baseScope = {
    chat_type: "dm",
    chat_id: fallbackChatId,
    session_key: cleanText(normalizedRequest?.resolved_session_key || fallbackChatId),
    workspace_key: "workspace:lark_plugin_dispatch",
  };
  const event = {
    sender: {
      sender_id: {
        open_id: cleanText(normalizedRequest?.user_id),
      },
    },
    message_text: cleanText(normalizedRequest?.request_text),
    text: cleanText(normalizedRequest?.request_text),
    message: {
      chat_id: fallbackChatId,
      chat_type: "p2p",
      content: JSON.stringify({ text: cleanText(normalizedRequest?.request_text) }),
    },
    __lobster_plugin_dispatch: {
      account_id: cleanText(normalizedRequest?.account_id),
      user_id: cleanText(normalizedRequest?.user_id),
      session_id: cleanText(normalizedRequest?.session_id),
      thread_id: cleanText(normalizedRequest?.thread_id),
      source: cleanText(normalizedRequest?.source),
      requested_capability: cleanText(normalizedRequest?.requested_capability),
      capability_source: cleanText(normalizedRequest?.capability_source),
    },
  };

  const explicitLaneContext = resolveExplicitLaneContext(normalizedRequest, preferredLane);

  return {
    event,
    scope: {
      ...baseScope,
      ...(explicitLaneContext || resolveCapabilityLane(baseScope, event)),
    },
  };
}

export async function executeLarkPluginDispatch({
  rawRequest = {},
  logger = noopLogger,
  pluginHybridDispatchEnabled = true,
  directIngressPrimaryEnabled = false,
  runKnowledgeAnswer = async () => ({ status: 500, data: { ok: false, error: "missing_knowledge_runner" } }),
  runLaneBackend = async () => ({ status: 500, data: { ok: false, error: "missing_lane_runner" } }),
} = {}) {
  const request = normalizeLarkPluginDispatchRequest(rawRequest);
  const decision = resolveLarkPluginDispatchDecision(request, {
    pluginHybridDispatchEnabled,
    directIngressPrimaryEnabled,
  });

  const logFields = {
    request_text: request.request_text || null,
    source: request.source || null,
    session_id: request.session_id || null,
    thread_id: request.thread_id || null,
    route_target: decision.route_target,
    mapped_lane: decision.mapped_lane || null,
    chosen_lane: decision.chosen_lane || null,
    lane_mapping_source: decision.lane_mapping_source || null,
    chosen_skill: decision.chosen_skill || null,
    fallback_reason: decision.fallback_reason || null,
    tool_name: request.tool_name || null,
    requested_capability: request.requested_capability || null,
    capability_source: request.capability_source || null,
    primary_entry: decision.is_primary_entry === true,
  };

  logger.info("lark_plugin_dispatch_started", {
    ...logFields,
    final_status: "started",
  });

  if (decision.route_target === "plugin_native") {
    const result = {
      ok: true,
      trace_id: null,
      request,
      requested_capability: request.requested_capability || null,
      route_target: decision.route_target,
      mapped_lane: decision.mapped_lane || null,
      chosen_lane: null,
      lane_mapping_source: decision.lane_mapping_source || null,
      chosen_skill: null,
      fallback_reason: decision.fallback_reason || null,
      capability_source: request.capability_source || null,
      final_status: "plugin_native_forward",
      response: null,
      forward_request: request.route_request,
    };
    logger.info("lark_plugin_dispatch_completed", {
      ...logFields,
      final_status: result.final_status,
    });
    return result;
  }

  try {
    const response = decision.route_target === "knowledge_answer"
      ? await runKnowledgeAnswer({ request, decision })
      : await runLaneBackend({ request, decision });
    const responseStatus = Number.isFinite(Number(response?.status)) ? Number(response.status) : 200;
    const finalStatus = responseStatus >= 400 ? "failed" : "completed";
    const traceId = cleanText(response?.trace_id || response?.data?.trace_id || "");
    const result = {
      ok: responseStatus < 400,
      trace_id: traceId || null,
      request,
      requested_capability: request.requested_capability || null,
      route_target: decision.route_target,
      mapped_lane: decision.mapped_lane || null,
      chosen_lane: decision.chosen_lane || null,
      lane_mapping_source: decision.lane_mapping_source || null,
      chosen_skill: decision.chosen_skill || null,
      fallback_reason: decision.fallback_reason || null,
      capability_source: request.capability_source || null,
      final_status: finalStatus,
      response: {
        status: responseStatus,
        data: response?.data ?? null,
      },
      forward_request: null,
    };
    logger.info("lark_plugin_dispatch_completed", {
      ...logFields,
      final_status: finalStatus,
    });
    return result;
  } catch (error) {
    logger.error("lark_plugin_dispatch_failed", {
      ...logFields,
      final_status: "failed",
      error: logger.compactError(error),
    });
    return {
      ok: false,
      trace_id: null,
      request,
      requested_capability: request.requested_capability || null,
      route_target: decision.route_target,
      mapped_lane: decision.mapped_lane || null,
      chosen_lane: decision.chosen_lane || null,
      lane_mapping_source: decision.lane_mapping_source || null,
      chosen_skill: decision.chosen_skill || null,
      fallback_reason: decision.fallback_reason || "runtime_exception",
      capability_source: request.capability_source || null,
      final_status: "failed",
      response: {
        status: 500,
        data: {
          ok: false,
          error: cleanText(error?.code || "") || "runtime_exception",
          message: cleanText(error?.message || "") || "plugin dispatch execution failed",
        },
      },
      forward_request: null,
    };
  }
}
