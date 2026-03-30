import { cleanText } from "./message-intent-utils.mjs";
import { createPlannerFlow } from "./planner-flow-runtime.mjs";
import { attachPlannerActionLayer } from "./planner-action-layer.mjs";
import { hasDocSearchIntent } from "./router.js";
import {
  buildDocQueryPayload,
  formatDocQueryExecutionResult,
  getPlannerDocQueryContext,
  resetPlannerDocQueryRuntimeContext,
  resolveDocQueryRoute,
  syncPlannerDocQueryContext,
} from "./planner-doc-query-flow.mjs";

const bdKeywords = [
  "bd",
  "商機",
  "商机",
  "客戶",
  "客户",
  "跟進",
  "跟进",
  "demo",
  "提案",
];

function buildBdTraceEvent({
  eventType = "",
  userQuery = "",
  routedIntent = "",
  tool = "",
  formatterKind = "",
  traceId = null,
  ok = null,
} = {}) {
  return {
    stage: "planner_bd_flow",
    event_type: cleanText(eventType) || null,
    user_query: cleanText(userQuery) || null,
    routed_intent: cleanText(routedIntent) || null,
    tool: cleanText(tool) || null,
    formatter_kind: cleanText(formatterKind) || null,
    trace_id: traceId || null,
    ok: typeof ok === "boolean" ? ok : null,
  };
}

function logBdTrace(logger = console, event = {}) {
  logger?.debug?.("planner_bd_flow", event);
}

function isBdQuery(userIntent = "") {
  const normalizedIntent = cleanText(String(userIntent || "").toLowerCase());
  if (!normalizedIntent) {
    return false;
  }
  return bdKeywords.some((keyword) => normalizedIntent.includes(keyword.toLowerCase()));
}

function selectBdRoute(userIntent = "", {
  activeTheme = "",
  activeDoc = null,
  activeCandidates = [],
  logger = console,
} = {}) {
  const normalizedIntent = cleanText(String(userIntent || ""));
  const docQueryRoute = resolveDocQueryRoute({
    userIntent: normalizedIntent,
    payload: {},
    activeDoc,
    activeCandidates,
    logger,
  });
  const followupAction = cleanText(docQueryRoute?.selected_target || "");
  const followupRoutingReason = cleanText(docQueryRoute?.routing_reason || "");

  if (!isBdQuery(normalizedIntent)) {
    if (cleanText(activeTheme) === "bd") {
      if (followupAction === "get_company_brain_doc_detail" || followupAction === "search_and_detail_doc") {
        return {
          action: followupAction,
          routing_reason: followupRoutingReason || "doc_query_search_and_detail",
        };
      }
    }
    return null;
  }

  if (followupAction === "get_company_brain_doc_detail" || followupAction === "search_and_detail_doc") {
    return {
      action: followupAction,
      routing_reason: followupRoutingReason || "doc_query_search_and_detail",
    };
  }

  if (!hasDocSearchIntent(normalizedIntent) && /整理|進度|进度|跟進|跟进|分析/.test(normalizedIntent)) {
    return {
      action: "search_and_detail_doc",
      routing_reason: "doc_query_search_and_detail",
    };
  }

  return {
    action: "search_company_brain_docs",
    routing_reason: "selector_search_company_brain_docs",
  };
}

function buildBdQuery(userIntent = "", payload = {}) {
  const normalizedIntent = cleanText(String(userIntent || ""));
  const payloadQuery = cleanText(payload?.q) || cleanText(payload?.query);
  return payloadQuery || normalizedIntent || "BD";
}

function supportsBdAction(action = "") {
  return [
    "search_company_brain_docs",
    "search_and_detail_doc",
    "get_company_brain_doc_detail",
  ].includes(cleanText(action));
}

function buildBdRouteResult(action = "", payload = {}) {
  const normalizedAction = cleanText(action);
  if (!normalizedAction) {
    return {
      payload,
    };
  }
  if (normalizedAction === "search_and_detail_doc") {
    return {
      preset: normalizedAction,
      payload,
    };
  }
  return {
    action: normalizedAction,
    payload,
  };
}

export function resolveBdFlowRoute({
  userIntent = "",
  payload = {},
  context = {},
  logger = console,
} = {}) {
  const selection = selectBdRoute(userIntent, {
    activeTheme: context?.activeTheme,
    activeDoc: context?.activeDoc,
    activeCandidates: context?.activeCandidates,
    logger,
  });
  const action = cleanText(selection?.action || "");
  const routingReason = cleanText(selection?.routing_reason || "") || "routing_no_match";
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};

  if (action && !cleanText(normalizedPayload.q) && !cleanText(normalizedPayload.query)) {
    const bdQuery = buildBdQuery(userIntent, normalizedPayload);
    normalizedPayload.q = bdQuery;
    normalizedPayload.query = bdQuery;
  }

  logBdTrace(logger, buildBdTraceEvent({
    eventType: "bd_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "routing_no_match",
    tool: action,
  }));

  return {
    ...buildBdRouteResult(action, normalizedPayload),
    routing_reason: routingReason,
  };
}

export function buildBdFlowPayload({
  action = "",
  userIntent = "",
  payload = {},
  context = {},
} = {}) {
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};

  if (
    (action === "search_company_brain_docs" || action === "search_and_detail_doc")
    && !cleanText(normalizedPayload.q)
    && !cleanText(normalizedPayload.query)
  ) {
    const bdQuery = buildBdQuery(userIntent, normalizedPayload);
    normalizedPayload.q = bdQuery;
    normalizedPayload.query = bdQuery;
  }

  return buildDocQueryPayload({
    action,
    userIntent,
    payload: normalizedPayload,
    activeDoc: context?.activeDoc,
    activeCandidates: context?.activeCandidates,
  });
}

export async function formatBdExecutionResult({
  selectedAction = "",
  executionResult = null,
  userIntent = "",
  payload = {},
  activeTheme = "",
  logger = console,
  ...rest
} = {}) {
  const docQueryResult = await formatDocQueryExecutionResult({
    selectedAction,
    executionResult,
    userIntent,
    payload,
    logger,
    ...rest,
  });
  const result = attachPlannerActionLayer({
    executionResult: docQueryResult,
    domain: "BD",
    activeTheme,
  });

  logBdTrace(logger, buildBdTraceEvent({
    eventType: "bd_result",
    userQuery: userIntent,
    routedIntent: cleanText(selectedAction) || null,
    tool: selectedAction,
    formatterKind: result?.formatted_output?.kind,
    traceId: result?.trace_id || null,
    ok: result?.ok === true,
  }));

  return result;
}

const plannerBdFlow = createPlannerFlow({
  id: "bd",
  ownership: {
    family: "company_brain_doc",
    contract: "single_owner_theme",
    domain: "bd",
    overlap_owner: "doc_query",
  },
  supportsAction: supportsBdAction,
  readContext({ sessionKey = "" } = {}) {
    return getPlannerDocQueryContext({ sessionKey });
  },
  resetContext({ sessionKey = "" } = {}) {
    return resetPlannerDocQueryRuntimeContext({ sessionKey });
  },
  route({
    userIntent,
    payload,
    context,
    logger,
  }) {
    return resolveBdFlowRoute({
      userIntent,
      payload,
      context,
      logger,
    });
  },
  shapePayload({
    action,
    userIntent,
    payload,
    context,
  }) {
    return buildBdFlowPayload({
      action,
      userIntent,
      payload,
      context,
    });
  },
  async formatResult({
    selectedAction,
    executionResult,
    userIntent,
    payload,
    context,
    logger,
    ...rest
  }) {
    return formatBdExecutionResult({
      selectedAction,
      executionResult,
      userIntent,
      payload,
      activeTheme: context?.activeTheme || "bd",
      logger,
      ...rest,
    });
  },
  writeContext({
    selectedAction,
    executionResult,
    sessionKey = "",
  }) {
    return syncPlannerDocQueryContext({
      selectedAction,
      executionResult,
      activeTheme: executionResult?.ok === true ? "bd" : undefined,
      sessionKey,
    });
  },
});

export { plannerBdFlow };
