import { cleanText } from "./message-intent-utils.mjs";
import { createPlannerFlow } from "./planner-flow-runtime.mjs";
import { attachPlannerActionLayer } from "./planner-action-layer.mjs";
import {
  buildDocQueryPayload,
  formatDocQueryExecutionResult,
  getPlannerDocQueryContext,
  resetPlannerDocQueryRuntimeContext,
  selectDocQueryAction,
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

function selectBdAction(userIntent = "", {
  activeTheme = "",
  activeDoc = null,
  activeCandidates = [],
} = {}) {
  const normalizedIntent = cleanText(String(userIntent || ""));
  if (!isBdQuery(normalizedIntent)) {
    if (cleanText(activeTheme) === "bd") {
      const followupAction = selectDocQueryAction(normalizedIntent, {
        activeDoc,
        activeCandidates,
      });
      if (followupAction === "get_company_brain_doc_detail" || followupAction === "search_and_detail_doc") {
        return followupAction;
      }
    }
    return null;
  }

  if (/整理|進度|进度|跟進|跟进|分析/.test(normalizedIntent)) {
    return "search_and_detail_doc";
  }

  return "search_company_brain_docs";
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

export function resolveBdFlowRoute({
  userIntent = "",
  payload = {},
  context = {},
  logger = console,
} = {}) {
  const action = selectBdAction(userIntent, {
    activeTheme: context?.activeTheme,
    activeDoc: context?.activeDoc,
    activeCandidates: context?.activeCandidates,
  });
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};

  if (action && !cleanText(normalizedPayload.q) && !cleanText(normalizedPayload.query)) {
    const bdQuery = buildBdQuery(userIntent, normalizedPayload);
    normalizedPayload.q = bdQuery;
    normalizedPayload.query = bdQuery;
  }

  logBdTrace(logger, buildBdTraceEvent({
    eventType: "bd_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "selector_fallback",
    tool: action,
  }));

  return {
    action,
    payload: normalizedPayload,
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
  supportsAction: supportsBdAction,
  readContext() {
    return getPlannerDocQueryContext();
  },
  resetContext() {
    return resetPlannerDocQueryRuntimeContext();
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
  }) {
    return syncPlannerDocQueryContext({
      selectedAction,
      executionResult,
      activeTheme: executionResult?.ok === true ? "bd" : undefined,
    });
  },
});

export { plannerBdFlow };
