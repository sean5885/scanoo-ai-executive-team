import {
  buildPlannedUserInputEnvelope,
  renderPlannerUserFacingReplyText,
} from "./executive-planner.mjs";
import { getPlannerSkillAction } from "./planner/skill-bridge.mjs";
import {
  emitPlannerVisibleTelemetryEvent,
  getPlannerVisibleTelemetryContext,
  hasPlannerVisibleTelemetryEvent,
  updatePlannerVisibleTelemetryContext,
} from "./planner-visible-live-telemetry-runtime.mjs";
import { normalizeUserFacingAnswerSources } from "./answer-source-mapper.mjs";
import { normalizeText } from "./text-utils.mjs";

const MAX_USER_FACING_SOURCES = 3;
const RAW_PLANNER_VISIBLE_PAYLOAD_PATTERN = /skill_bridge|document_summarize|search_and_summarize|side_effects|get_company_brain_doc_detail|search_knowledge_base|read-runtime|authority/i;

function emitBoundaryLog({
  logger = null,
  traceId = null,
  handlerName = null,
  ok = null,
  extraFields = {},
} = {}) {
  const payload = {
    chat_output_boundary: "normalized",
    handler_name: normalizeText(handlerName || "") || "unknown_handler",
    trace_id: normalizeText(traceId || "") || null,
    ok: typeof ok === "boolean" ? ok : null,
    ...(extraFields && typeof extraFields === "object" && !Array.isArray(extraFields) ? extraFields : {}),
  };
  if (logger?.info) {
    logger.info("chat_output_boundary", payload);
    return;
  }
  console.info("chat_output_boundary", payload);
}

function resolvePlannerExecutionData(execution = {}) {
  if (execution?.data && typeof execution.data === "object" && !Array.isArray(execution.data)) {
    return execution.data;
  }
  return {};
}

function buildPlannerSkillBoundaryFields(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const executionData = resolvePlannerExecutionData(execution);
  if (normalizeText(executionData.bridge || "") !== "skill_bridge") {
    return {};
  }

  const registryEntry = getPlannerSkillAction(
    normalizeText(envelope?.action || execution?.action || executionData.skill || ""),
  );

  return {
    planner_skill_boundary: "answer_pipeline",
    planner_skill_action: normalizeText(registryEntry?.action || execution?.action || envelope?.action || "") || null,
    planner_skill_name: normalizeText(registryEntry?.skill_name || executionData.skill || "") || null,
    planner_skill_surface_layer: normalizeText(registryEntry?.surface_layer || "") || null,
    planner_skill_promotion_stage: normalizeText(registryEntry?.promotion_stage || "") || null,
    planner_skill_answer_pipeline_enforced: true,
    planner_skill_raw_payload_blocked: true,
  };
}

function buildPlannerVisibleAnswerShapeSignature(response = {}) {
  const answerLength = normalizeText(response?.answer || "").length;
  const sourceCount = Array.isArray(response?.sources) ? response.sources.length : 0;
  const limitationCount = Array.isArray(response?.limitations) ? response.limitations.length : 0;
  const status = response?.ok === true ? "ok" : "error";
  return `${status}:${answerLength}:${sourceCount}:${limitationCount}`;
}

function maybeEmitPlannerVisibleAnswerTelemetry({
  envelope = null,
  normalizedResponse = null,
  traceId = null,
} = {}) {
  const context = getPlannerVisibleTelemetryContext(envelope);
  if (!context || hasPlannerVisibleTelemetryEvent(context, "planner_visible_answer_generated")) {
    return;
  }

  const response = normalizedResponse && typeof normalizedResponse === "object" && !Array.isArray(normalizedResponse)
    ? normalizedResponse
    : {};
  const boundaryFields = buildPlannerSkillBoundaryFields(envelope || {});
  const answerSkillAction = normalizeText(
    boundaryFields.planner_skill_action
    || envelope?.action
    || envelope?.execution_result?.action
    || "",
  ) || null;
  const responseText = [
    response.answer,
    ...(Array.isArray(response.sources) ? response.sources : []),
    ...(Array.isArray(response.limitations) ? response.limitations : []),
  ].filter(Boolean).join("\n");
  const answerContractOk = typeof response.answer === "string"
    && Array.isArray(response.sources)
    && Array.isArray(response.limitations);
  const rawPayloadBlocked = !RAW_PLANNER_VISIBLE_PAYLOAD_PATTERN.test(responseText);
  const answerConsistencyProxyOk = answerContractOk
    && rawPayloadBlocked
    && (!context.selected_skill || answerSkillAction === context.selected_skill);

  updatePlannerVisibleTelemetryContext(context, {
    trace_id: normalizeText(traceId || envelope?.trace_id || "") || context.trace_id,
  });
  emitPlannerVisibleTelemetryEvent({
    event: "planner_visible_answer_generated",
    context,
    extra: {
      answer_pipeline_enforced: true,
      raw_payload_blocked: rawPayloadBlocked,
      answer_contract_ok: answerContractOk,
      answer_consistency_proxy_ok: answerConsistencyProxyOk,
      answer_skill_action: answerSkillAction,
      source_count: Array.isArray(response.sources) ? response.sources.length : 0,
      limitation_count: Array.isArray(response.limitations) ? response.limitations.length : 0,
      answer_shape_signature: buildPlannerVisibleAnswerShapeSignature(response),
      response_status: response.ok === true ? "success" : "error",
    },
  });
}

export function normalizeUserResponseList(items = []) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeText(String(item || "")))
      .filter(Boolean),
  )];
}

function buildGenericUserResponse({ ok = false } = {}) {
  return {
    ok: ok === true,
    answer: ok === true
      ? "這次我先沒有整理出可直接交付的內容。"
      : "這次我先沒有整理出足夠內容，但不會亂補。",
    sources: [],
    limitations: ok === true
      ? []
      : ["如果你願意，可以換個說法、補一點上下文，或直接把目標資料貼給我。"],
  };
}

function hasCanonicalUserResponseData(executionData = {}) {
  return Boolean(
    normalizeText(executionData?.answer || "")
    || Array.isArray(executionData?.sources)
    || Array.isArray(executionData?.limitations),
  );
}

function buildExecutionDataUserResponse({
  executionData = {},
  ok = false,
} = {}) {
  if (!hasCanonicalUserResponseData(executionData)) {
    return null;
  }

  const normalizedResponse = {
    ok: ok === true,
    answer: normalizeText(executionData.answer || ""),
    sources: normalizeUserFacingAnswerSources(executionData.sources, {
      maxSources: MAX_USER_FACING_SOURCES,
    }),
    limitations: normalizeUserResponseList(executionData.limitations),
  };

  if (!normalizedResponse.answer) {
    const hasSources = normalizedResponse.sources.length > 0;
    const hasLimitations = normalizedResponse.limitations.length > 0;
    normalizedResponse.answer = hasSources || hasLimitations
      ? normalizedResponse.ok === true
        ? "我先把目前能確認的部分整理給你。"
        : "我先把目前能確認的部分整理給你，還沒確認的放在下一步。"
      : normalizedResponse.ok === true
        ? "這次我先沒有整理出可直接交付的內容。"
        : "這次我先沒有整理出足夠內容，但不會亂補。";
  }

  return normalizedResponse;
}

export function buildPlannerSuccessUserResponse(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const executionData = resolvePlannerExecutionData(execution);
  return buildExecutionDataUserResponse({
    executionData,
    ok: envelope?.ok === true && execution?.ok !== false,
  }) || buildGenericUserResponse({
    ok: envelope?.ok === true && execution?.ok !== false,
  });
}

export function normalizeUserResponse({
  plannerResult = null,
  plannerEnvelope = null,
  payload = null,
  logger = null,
  traceId = null,
  handlerName = null,
} = {}) {
  const envelope = plannerEnvelope && typeof plannerEnvelope === "object"
    ? plannerEnvelope
    : plannerResult && typeof plannerResult === "object"
      ? buildPlannedUserInputEnvelope(plannerResult)
      : null;

  if (envelope) {
    const normalizedResponse = buildPlannerSuccessUserResponse(envelope);
    maybeEmitPlannerVisibleAnswerTelemetry({
      envelope,
      normalizedResponse,
      traceId,
    });
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: normalizedResponse.ok,
      extraFields: buildPlannerSkillBoundaryFields(envelope),
    });
    return normalizedResponse;
  }

  const objectPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (isCanonicalUserFacingResponse(objectPayload)) {
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: objectPayload.ok,
    });
    return {
      ok: objectPayload.ok === true,
      answer: normalizeText(objectPayload.answer || ""),
      sources: normalizeUserResponseList(objectPayload.sources),
      limitations: normalizeUserResponseList(objectPayload.limitations),
    };
  }
  const execution = objectPayload?.execution_result && typeof objectPayload.execution_result === "object"
    ? objectPayload.execution_result
    : {};
  const executionData = resolvePlannerExecutionData(execution);
  const normalizedPayload = buildExecutionDataUserResponse({
    executionData,
    ok: objectPayload.ok !== false && execution?.ok !== false,
  }) || buildGenericUserResponse({
    ok: objectPayload.ok !== false && execution?.ok !== false,
  });

  emitBoundaryLog({
    logger,
    traceId,
    handlerName,
    ok: normalizedPayload.ok,
  });
  return normalizedPayload;
}

function isCanonicalUserFacingResponse(response = {}) {
  return Boolean(
    response
    && typeof response === "object"
    && !Array.isArray(response)
    && typeof response.answer === "string"
    && Array.isArray(response.sources)
    && Array.isArray(response.limitations)
  );
}

export function renderUserResponseText(response = {}) {
  const normalizedResponse = isCanonicalUserFacingResponse(response)
    ? response
    : normalizeUserResponse({ payload: response });
  return renderPlannerUserFacingReplyText(normalizedResponse);
}
