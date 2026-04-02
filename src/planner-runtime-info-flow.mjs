import { cleanText } from "./message-intent-utils.mjs";
import { looksLikePlannerRuntimeInfoIntent } from "./planner-ingress-contract.mjs";
import { createPlannerFlow } from "./planner-flow-runtime.mjs";

const plannerRuntimeInfoContext = Object.freeze({});
const RUNTIME_INFO_ACTION = "get_runtime_info";

function buildRuntimeInfoTraceEvent({
  eventType = "",
  userQuery = "",
  routedIntent = "",
  tool = "",
  formatterKind = "",
  traceId = null,
  ok = null,
} = {}) {
  return {
    stage: "planner_runtime_info_flow",
    event_type: cleanText(eventType) || null,
    user_query: cleanText(userQuery) || null,
    routed_intent: cleanText(routedIntent) || null,
    tool: cleanText(tool) || null,
    formatter_kind: cleanText(formatterKind) || null,
    trace_id: traceId || null,
    ok: typeof ok === "boolean" ? ok : null,
  };
}

function logRuntimeInfoTrace(logger = console, event = {}) {
  logger?.debug?.("planner_runtime_info_flow", event);
}

function buildRuntimeInfoFormattedOutput(result = null) {
  return {
    kind: RUNTIME_INFO_ACTION,
    db_path: cleanText(result?.data?.db_path) || null,
    node_pid: Number.isFinite(result?.data?.node_pid) ? result.data.node_pid : null,
    cwd: cleanText(result?.data?.cwd) || null,
    service_start_time: cleanText(result?.data?.service_start_time) || null,
  };
}

function withFormattedOutput(result = null, formattedOutput = null) {
  if (!result || typeof result !== "object" || !formattedOutput) {
    return result;
  }
  return {
    ...result,
    formatted_output: formattedOutput,
  };
}

function supportsRuntimeInfoAction(action = "") {
  return cleanText(action) === RUNTIME_INFO_ACTION;
}

export function resolveRuntimeInfoRoute({
  userIntent = "",
  payload = {},
  logger = console,
} = {}) {
  const action = looksLikePlannerRuntimeInfoIntent(userIntent) ? RUNTIME_INFO_ACTION : null;
  const routingReason = action ? "selector_get_runtime_info" : "routing_no_match";
  logRuntimeInfoTrace(logger, buildRuntimeInfoTraceEvent({
    eventType: "runtime_info_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "routing_no_match",
    tool: action,
  }));
  return {
    action,
    routing_reason: routingReason,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {},
  };
}

export async function formatRuntimeInfoExecutionResult({
  selectedAction = "",
  executionResult = null,
  userIntent = "",
  logger = console,
} = {}) {
  if (!supportsRuntimeInfoAction(selectedAction) || !executionResult || typeof executionResult !== "object") {
    return executionResult;
  }

  if (executionResult.ok !== true) {
    return executionResult;
  }

  const result = withFormattedOutput(executionResult, buildRuntimeInfoFormattedOutput(executionResult));
  logRuntimeInfoTrace(logger, buildRuntimeInfoTraceEvent({
    eventType: "runtime_info_result",
    userQuery: userIntent,
    routedIntent: RUNTIME_INFO_ACTION,
    tool: selectedAction,
    formatterKind: result?.formatted_output?.kind,
    traceId: result?.trace_id || null,
    ok: true,
  }));
  return result;
}

export function getPlannerRuntimeInfoContext() {
  return plannerRuntimeInfoContext;
}

export function resetPlannerRuntimeInfoContext() {
  return plannerRuntimeInfoContext;
}

export function syncPlannerRuntimeInfoContext() {
  return plannerRuntimeInfoContext;
}

const plannerRuntimeInfoFlow = createPlannerFlow({
  id: "runtime_info",
  ownership: {
    family: "runtime",
    contract: "single_owner",
    domain: "runtime_info",
  },
  supportsAction: supportsRuntimeInfoAction,
  readContext() {
    return getPlannerRuntimeInfoContext();
  },
  resetContext() {
    return resetPlannerRuntimeInfoContext();
  },
  route({
    userIntent,
    payload,
    logger,
  }) {
    return resolveRuntimeInfoRoute({
      userIntent,
      payload,
      logger,
    });
  },
  shapePayload({ payload }) {
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  },
  async formatResult({
    selectedAction,
    executionResult,
    userIntent,
    logger,
  }) {
    return formatRuntimeInfoExecutionResult({
      selectedAction,
      executionResult,
      userIntent,
      logger,
    });
  },
  writeContext() {
    return syncPlannerRuntimeInfoContext();
  },
});

export { plannerRuntimeInfoFlow };
