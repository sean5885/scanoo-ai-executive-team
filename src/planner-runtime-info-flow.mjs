import { cleanText } from "./message-intent-utils.mjs";
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

function looksLikeRuntimeInfoQuery(userIntent = "") {
  const normalizedIntent = cleanText(String(userIntent || "").toLowerCase());
  if (!normalizedIntent) {
    return false;
  }

  return (
    normalizedIntent.includes("runtime")
    || normalizedIntent.includes("runtime status")
    || normalizedIntent.includes("db path")
    || normalizedIntent.includes("pid")
    || normalizedIntent.includes("cwd")
    || normalizedIntent.includes("service start")
    || normalizedIntent.includes("service_start")
    || normalizedIntent.includes("穩不穩")
    || normalizedIntent.includes("風險")
    || normalizedIntent.includes("運行情況")
    || normalizedIntent.includes("系統狀態")
    || normalizedIntent.includes("運行資訊")
    || normalizedIntent.includes("运行信息")
  );
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
  const action = looksLikeRuntimeInfoQuery(userIntent) ? RUNTIME_INFO_ACTION : null;
  logRuntimeInfoTrace(logger, buildRuntimeInfoTraceEvent({
    eventType: "runtime_info_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "routing_no_match",
    tool: action,
  }));
  return {
    action,
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
