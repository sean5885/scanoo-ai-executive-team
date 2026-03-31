import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
  executePlannedUserInput,
} from "./executive-planner.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

function resolveEdgeExecution(result = {}) {
  return result?.execution_result && typeof result.execution_result === "object"
    ? result.execution_result
    : {};
}

function hasCanonicalExecutionData(result = {}) {
  const execution = resolveEdgeExecution(result);
  const data = execution?.data;
  return Boolean(
    data
    && typeof data === "object"
    && !Array.isArray(data)
    && (
      typeof data.answer === "string"
      || Array.isArray(data.sources)
      || Array.isArray(data.limitations)
    )
  );
}

function resolveLegacyEdgeShape(result = {}) {
  const execution = resolveEdgeExecution(result);
  if (result?.formatted_output && typeof result.formatted_output === "object" && !Array.isArray(result.formatted_output)) {
    return result.formatted_output;
  }
  if (execution?.formatted_output && typeof execution.formatted_output === "object" && !Array.isArray(execution.formatted_output)) {
    return execution.formatted_output;
  }
  return execution;
}

function withCanonicalExecutionData(result = {}, data = {}) {
  const execution = resolveEdgeExecution(result);
  return {
    ...result,
    execution_result: {
      ...execution,
      data: {
        ...(execution?.data && typeof execution.data === "object" && !Array.isArray(execution.data) ? execution.data : {}),
        ...data,
      },
    },
  };
}

function adaptPlannerResultForEdge(result = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result) || hasCanonicalExecutionData(result)) {
    return result;
  }

  const execution = resolveEdgeExecution(result);
  const legacyShape = resolveLegacyEdgeShape(result);
  const kind = String(legacyShape?.kind || execution?.kind || "").trim();
  const action = String(result?.action || execution?.action || "").trim();

  if (result?.ok === false || execution?.ok === false) {
    const reply = buildPlannedUserInputUserFacingReply(result);
    return reply
      ? withCanonicalExecutionData(result, {
          answer: reply.answer,
          sources: reply.sources,
          limitations: reply.limitations,
        })
      : result;
  }

  const isRuntimeInfo = kind === "runtime_info"
    || action === "get_runtime_info"
    || typeof legacyShape?.db_path === "string"
    || Number.isFinite(legacyShape?.node_pid)
    || typeof legacyShape?.cwd === "string";
  if (isRuntimeInfo) {
    const answer = [
      "目前 runtime 有正常回應。",
      typeof legacyShape?.db_path === "string" && legacyShape.db_path ? `資料庫路徑在 ${legacyShape.db_path}。` : "",
      Number.isFinite(legacyShape?.node_pid) ? `目前 PID 是 ${legacyShape.node_pid}。` : "",
      typeof legacyShape?.cwd === "string" && legacyShape.cwd ? `工作目錄是 ${legacyShape.cwd}。` : "",
    ].filter(Boolean).join(" ");
    const limitations = [
      typeof legacyShape?.service_start_time === "string" && legacyShape.service_start_time
        ? `這是啟動於 ${legacyShape.service_start_time} 的即時 runtime 快照。`
        : "",
    ].filter(Boolean);
    return withCanonicalExecutionData(result, {
      answer,
      sources: [],
      limitations,
    });
  }

  const items = Array.isArray(legacyShape?.items)
    ? legacyShape.items
    : Array.isArray(execution?.items)
      ? execution.items
      : [];
  if (kind === "search" && items.length > 0) {
    const matchReason = String(legacyShape?.match_reason || execution?.match_reason || "").trim();
    const subject = matchReason ? `「${matchReason}」` : "這輪查詢";
    return withCanonicalExecutionData(result, {
      answer: `我已先按目前已索引的文件，標出和 ${subject} 最相關的 ${items.length} 份文件。`,
      sources: items,
      limitations: [],
    });
  }

  return result;
}

export async function runPlannerUserInputEdge({
  text = "",
  logger = console,
  contentReader,
  baseUrl,
  authContext = null,
  signal = null,
  sessionKey = "",
  requestId = "",
  telemetryAdapter = null,
  traceId = null,
  handlerName = null,
  plannerExecutor = executePlannedUserInput,
  envelopeBuilder = buildPlannedUserInputEnvelope,
  responseNormalizer = normalizeUserResponse,
  envelopeDecorator = null,
} = {}) {
  const plannerResult = adaptPlannerResultForEdge(await plannerExecutor({
    text,
    logger,
    contentReader,
    baseUrl,
    authContext,
    signal,
    sessionKey,
    requestId,
    telemetryAdapter,
  }));

  const baseEnvelope = envelopeBuilder(plannerResult);
  const plannerEnvelope = typeof envelopeDecorator === "function"
    ? envelopeDecorator(baseEnvelope, plannerResult)
    : baseEnvelope;
  const userResponse = responseNormalizer({
    plannerResult,
    plannerEnvelope,
    requestText: text,
    logger,
    traceId,
    handlerName,
  });

  return {
    plannerResult,
    plannerEnvelope,
    userResponse,
  };
}
