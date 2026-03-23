import { cleanText } from "./message-intent-utils.mjs";
import { createPlannerFlow } from "./planner-flow-runtime.mjs";
import { attachPlannerActionLayer } from "./planner-action-layer.mjs";
import { hasDocSearchIntent } from "./router.js";
import {
  buildDocQueryPayload,
  formatDocQueryExecutionResult,
  getPlannerDocQueryContext,
  resetPlannerDocQueryRuntimeContext,
  selectDocQueryAction,
  syncPlannerDocQueryContext,
} from "./planner-doc-query-flow.mjs";

const okrKeywords = [
  "okr",
  "目標",
  "kr",
  "關鍵結果",
  "关键结果",
  "週進度",
  "周进度",
  "本週 todo",
  "本周 todo",
  "本週todo",
  "本周todo",
];

function buildOkrTraceEvent({
  eventType = "",
  userQuery = "",
  routedIntent = "",
  tool = "",
  traceId = null,
  formatterKind = "",
  ok = null,
} = {}) {
  return {
    stage: "planner_okr_flow",
    event_type: cleanText(eventType) || null,
    user_query: cleanText(userQuery) || null,
    routed_intent: cleanText(routedIntent) || null,
    tool: cleanText(tool) || null,
    formatter_kind: cleanText(formatterKind) || null,
    trace_id: traceId || null,
    ok: typeof ok === "boolean" ? ok : null,
  };
}

function logOkrTrace(logger = console, event = {}) {
  logger?.debug?.("planner_okr_flow", event);
}

function isOkrQuery(userIntent = "") {
  const normalizedIntent = cleanText(String(userIntent || "").toLowerCase());
  if (!normalizedIntent) {
    return false;
  }
  return okrKeywords.some((keyword) => normalizedIntent.includes(keyword.toLowerCase()));
}

function selectOkrAction(userIntent = "", {
  activeTheme = "",
  activeDoc = null,
  activeCandidates = [],
} = {}) {
  const normalizedIntent = cleanText(String(userIntent || ""));
  const followupAction = selectDocQueryAction(normalizedIntent, {
    activeDoc,
    activeCandidates,
  });

  if (!isOkrQuery(normalizedIntent)) {
    if (cleanText(activeTheme) === "okr") {
      if (followupAction === "get_company_brain_doc_detail" || followupAction === "search_and_detail_doc") {
        return followupAction;
      }
    }
    return null;
  }

  if (followupAction === "get_company_brain_doc_detail" || followupAction === "search_and_detail_doc") {
    return followupAction;
  }

  if (
    !hasDocSearchIntent(normalizedIntent)
    && /整理|解釋|说明|說明|重點|重点|進度|进度|todo|待辦|待办/.test(normalizedIntent)
  ) {
    return "search_and_detail_doc";
  }

  return "search_company_brain_docs";
}

function buildOkrQuery(userIntent = "", payload = {}) {
  const normalizedIntent = cleanText(String(userIntent || ""));
  const payloadQuery = cleanText(payload?.q) || cleanText(payload?.query);
  return payloadQuery || normalizedIntent || "OKR";
}

function supportsOkrAction(action = "") {
  return [
    "search_company_brain_docs",
    "search_and_detail_doc",
    "get_company_brain_doc_detail",
  ].includes(cleanText(action));
}

function buildOkrRouteResult(action = "", payload = {}) {
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

export function resolveOkrFlowRoute({
  userIntent = "",
  payload = {},
  context = {},
  logger = console,
} = {}) {
  const action = selectOkrAction(userIntent, {
    activeTheme: context?.activeTheme,
    activeDoc: context?.activeDoc,
    activeCandidates: context?.activeCandidates,
  });
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  if (action && !cleanText(normalizedPayload.q) && !cleanText(normalizedPayload.query)) {
    const okrQuery = buildOkrQuery(userIntent, normalizedPayload);
    normalizedPayload.q = okrQuery;
    normalizedPayload.query = okrQuery;
  }

  logOkrTrace(logger, buildOkrTraceEvent({
    eventType: "okr_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "routing_no_match",
    tool: action,
  }));

  return {
    ...buildOkrRouteResult(action, normalizedPayload),
  };
}

export function buildOkrFlowPayload({
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
    const okrQuery = buildOkrQuery(userIntent, normalizedPayload);
    normalizedPayload.q = okrQuery;
    normalizedPayload.query = okrQuery;
  }

  return buildDocQueryPayload({
    action,
    userIntent,
    payload: normalizedPayload,
    activeDoc: context?.activeDoc,
    activeCandidates: context?.activeCandidates,
  });
}

export async function formatOkrExecutionResult({
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
    domain: "OKR",
    activeTheme,
  });

  logOkrTrace(logger, buildOkrTraceEvent({
    eventType: "okr_result",
    userQuery: userIntent,
    routedIntent: cleanText(selectedAction) || null,
    tool: selectedAction,
    formatterKind: result?.formatted_output?.kind,
    traceId: result?.trace_id || null,
    ok: result?.ok === true,
  }));

  return result;
}

const plannerOkrFlow = createPlannerFlow({
  id: "okr",
  supportsAction: supportsOkrAction,
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
    return resolveOkrFlowRoute({
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
    return buildOkrFlowPayload({
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
    return formatOkrExecutionResult({
      selectedAction,
      executionResult,
      userIntent,
      payload,
      activeTheme: context?.activeTheme || "okr",
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
      activeTheme: executionResult?.ok === true ? "okr" : undefined,
      sessionKey,
    });
  },
});

export { plannerOkrFlow };
