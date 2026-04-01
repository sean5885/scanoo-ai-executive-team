import {
  buildPlannedUserInputEnvelope,
  renderPlannerUserFacingReplyText,
  resolvePlannerUserFacingFailureClass,
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
const TASK_DECOMPOSITION_CAPABILITY_ORDER = ["draft_copy", "image_asset", "outbound_delivery"];
const TASK_DECOMPOSITION_CAPABILITIES = Object.freeze({
  draft_copy: Object.freeze({
    label: "文字草稿",
    supported: true,
    patterns: [
      /(?:fb|facebook|臉書|脸书)\s*(?:貼文|帖文|post)/i,
      /(?:寫|撰寫|起草|草擬|草拟).{0,12}(?:文案|貼文|帖文|email|郵件|邮件|信件|回覆|回复|內容|内容)/i,
      /(?:文案|貼文|帖文|caption|copywriting|copy)/i,
      /(?:email|郵件|邮件|信件).{0,8}(?:草稿|內容|内容|文案)/i,
      /(?:回覆|回复).{0,8}(?:草稿|內容|内容)/i,
    ],
  }),
  image_asset: Object.freeze({
    label: "圖片素材",
    supported: false,
    patterns: [
      /(?:圖片|图片|圖像|图像|配圖|配图|海報|海报|banner|poster|image|視覺|视觉|插圖|插图|素材)/i,
    ],
    negatedPatterns: [
      /(?:先不要|不要|不用|先別|先别|暫時不要|暂时不要|不必).{0,8}(?:圖片|图片|圖像|图像|配圖|配图|海報|海报|banner|poster|image|素材)/i,
    ],
  }),
  outbound_delivery: Object.freeze({
    label: "發送或發布",
    supported: false,
    patterns: [
      /(?:發送|发送|寄出|寄給|寄给|發佈|发布|代發|代发|發布出去|发布出去)/i,
    ],
    negatedPatterns: [
      /(?:先不要|不要|不用|先別|先别|暫時不要|暂时不要|不必).{0,8}(?:發送|发送|寄出|寄給|寄给|發佈|发布|代發|代发)/i,
    ],
  }),
});

function matchesAnyPattern(text = "", patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectTaskDecomposition(requestText = "") {
  const normalized = normalizeText(requestText);
  if (!normalized) {
    return {
      requestText: "",
      capabilities: [],
      completable: [],
      blocked: [],
      isMultiIntent: false,
    };
  }

  const capabilities = TASK_DECOMPOSITION_CAPABILITY_ORDER
    .map((key) => {
      const config = TASK_DECOMPOSITION_CAPABILITIES[key];
      if (!config) {
        return null;
      }
      if (matchesAnyPattern(normalized, config.negatedPatterns || [])) {
        return null;
      }
      if (!matchesAnyPattern(normalized, config.patterns || [])) {
        return null;
      }
      return {
        key,
        label: config.label,
        supported: config.supported === true,
      };
    })
    .filter(Boolean);

  const completable = capabilities.filter((item) => item.supported === true);
  const blocked = capabilities.filter((item) => item.supported !== true);

  return {
    requestText: normalized,
    capabilities,
    completable,
    blocked,
    isMultiIntent: capabilities.length > 1,
  };
}

function hasUsableTaskDecompositionFallback(response = {}) {
  return response?.ok !== true
    && (!Array.isArray(response?.sources) || response.sources.length === 0);
}

function resolveDraftCopyChannel(requestText = "") {
  const normalized = normalizeText(requestText);
  if (/(?:fb|facebook|臉書|脸书)\s*(?:貼文|帖文|post)|(?:貼文|帖文).{0,6}(?:fb|facebook|臉書|脸书)/i.test(normalized)) {
    return "facebook_post";
  }
  if (/(?:email|郵件|邮件|信件|mail)/i.test(normalized)) {
    return "email";
  }
  if (/(?:回覆|回复|怎麼回|怎么回)/i.test(normalized)) {
    return "reply";
  }
  return "general_copy";
}

function extractDraftCopySubject(requestText = "") {
  let subject = normalizeText(requestText);
  if (!subject) {
    return "";
  }

  const stripPatterns = [
    /^(?:請|请)?(?:幫我|帮我|幫忙|帮忙|麻煩|麻烦)?/i,
    /(?:寫|撰寫|起草|草擬|草拟|做|產出|产出|生成|弄|補|整理|準備|准备|再|並且|并且|以及|同時|同时|然後|然后|最後|最后|順便|直接|先|幫|帮|並|并)/gi,
    /(?:fb|facebook|臉書|脸书|貼文|帖文|post|文案|caption|copywriting|copy|email|郵件|邮件|mail|信件|回覆|回复|圖片|图片|圖像|图像|配圖|配图|海報|海报|banner|poster|image|素材|發送|发送|寄出|寄給|寄给|發佈|发布|代發|代发)/gi,
    /(?:一張|一封|一版|一則|一個|一篇|一下|出去)/g,
    /[，,、;；:+/]/g,
    /\s+/g,
  ];

  for (const pattern of stripPatterns) {
    subject = subject.replace(pattern, " ");
  }

  subject = normalizeText(subject)
    .replace(/^(?:關於|有關|針對|关于|有关|针对)/, "")
    .replace(/^(?:這個|这个|這則|这则|這篇|这篇)/, "")
    .replace(/\s+的$/g, "")
    .replace(/(?:給我|给我|給客戶|给客户|給同事|给同事)$/g, "")
    .trim();

  if (!subject || /^(?:內容|内容|草稿|文案|貼文|帖文|圖片|图片|素材|發送|发送)$/.test(subject)) {
    return "";
  }

  return subject.slice(0, 48);
}

function buildFacebookPostDraft(subject = "") {
  const topic = subject || "這個主題";
  const hashtagBase = topic.replace(/\s+/g, "");
  return [
    `${topic}，可以先從更清楚的溝通開始。`,
    "",
    `我們把 ${topic} 先整理成一版更容易理解、也更容易採取行動的內容，讓重點不用藏在一大段資訊裡。`,
    `如果你現在就在評估 ${topic}，這一版會先幫你抓到核心價值、降低理解門檻，也更方便直接往下一步推進。`,
    "",
    "如果你想要更完整版本，留言或私訊，我可以再補一版更貼近受眾的調性。",
    "",
    `#${hashtagBase || "主題"} #Facebook貼文`,
  ].join("\n");
}

function buildEmailDraft(subject = "") {
  const topic = subject || "這件事";
  return [
    `主旨：關於 ${topic} 的初步說明`,
    "",
    "Hi,",
    "",
    `想先跟你分享一版關於 ${topic} 的簡要說明。`,
    `我們目前先把重點整理成更容易閱讀的版本，方便你快速掌握核心資訊，也更好評估下一步。`,
    "",
    "如果你願意，我可以再補上更完整的版本或直接改成對外可發送的最終稿。",
    "",
    "Best,",
  ].join("\n");
}

function buildReplyDraft(subject = "") {
  const topic = subject || "這件事";
  return [
    "這邊先回覆你一版可直接使用的內容：",
    "",
    `我們已經先把 ${topic} 的方向整理過了，接下來會先聚焦在最重要的幾個重點，避免大家在細節上來回消耗。`,
    "如果你覺得這個方向可行，我可以再把下一步拆得更具體一點。",
  ].join("\n");
}

function buildGenericCopyDraft(subject = "") {
  const topic = subject || "這個主題";
  return [
    `${topic}，值得被更清楚地說出來。`,
    "",
    `這一版先把 ${topic} 的核心價值濃縮出來，讓讀到的人更快知道它重要在哪裡、現在可以做什麼。`,
    "如果你要，我也可以接著把這版改成更口語、更銷售導向，或更正式的語氣。",
  ].join("\n");
}

function buildDraftCopyContent(requestText = "") {
  const channel = resolveDraftCopyChannel(requestText);
  const subject = extractDraftCopySubject(requestText);

  if (channel === "facebook_post") {
    return {
      label: "Facebook 貼文草稿",
      content: buildFacebookPostDraft(subject),
    };
  }
  if (channel === "email") {
    return {
      label: "Email 草稿",
      content: buildEmailDraft(subject),
    };
  }
  if (channel === "reply") {
    return {
      label: "回覆草稿",
      content: buildReplyDraft(subject),
    };
  }
  return {
    label: "文字草稿",
    content: buildGenericCopyDraft(subject),
  };
}

function buildTaskDecompositionLimitations(blocked = []) {
  const entries = blocked.map((item) => {
    if (item.key === "image_asset") {
      return "圖片這部分我目前不能直接在這裡產出成品；如果你要，我可以下一步先補圖片 prompt、構圖方向和文案搭配建議。";
    }
    if (item.key === "outbound_delivery") {
      return "發送或發布這部分我目前不能直接替你送出；你可以先手動貼上上面的內容，或我幫你再整理成最終發布版。";
    }
    return `${item.label} 這部分我目前還不能直接代做；如果你要，我可以先把替代做法列給你。`;
  });
  return normalizeUserResponseList(entries);
}

function attachHiddenUserResponseMetadata(response = {}, metadata = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(response, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return response;
}

function isPartialSuccessResponse(response = {}) {
  const answer = normalizeText(response?.answer || "");
  const sources = Array.isArray(response?.sources) ? response.sources.join("\n") : "";
  return response?.ok === true
    && (
      /我先把可直接交付的.*完成/i.test(answer)
      || /已先完成[:：]/i.test(sources)
    );
}

function deriveFailureClassFromEnvelope({
  envelope = null,
  requestText = "",
  response = null,
} = {}) {
  if (isPartialSuccessResponse(response)) {
    return "partial_success";
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return response?.ok === false ? "generic_fallback" : null;
  }

  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const executionData = resolvePlannerExecutionData(execution);
  const error = normalizeText(
    execution?.error
    || envelope?.error
    || executionData?.error
    || "",
  );
  const fallbackReason = normalizeText(
    envelope?.trace?.fallback_reason
    || executionData?.stop_reason
    || executionData?.reason
    || executionData?.routing_reason
    || error,
  );
  if (!error && response?.ok !== false) {
    return null;
  }
  return resolvePlannerUserFacingFailureClass({
    error,
    fallbackReason,
    requestText,
    action: normalizeText(envelope?.action || envelope?.trace?.chosen_action || execution?.action || ""),
  });
}

function maybeApplyTaskDecompositionFallback({
  response = null,
  requestText = "",
} = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  if (!hasUsableTaskDecompositionFallback(response)) {
    return response;
  }

  const decomposition = detectTaskDecomposition(requestText);
  if (!decomposition.isMultiIntent || decomposition.completable.length === 0 || decomposition.blocked.length === 0) {
    return response;
  }

  const draftCopy = decomposition.completable.find((item) => item.key === "draft_copy");
  if (!draftCopy) {
    return response;
  }

  const draft = buildDraftCopyContent(requestText);
  return attachHiddenUserResponseMetadata({
    ok: true,
    answer: [
      `我先把可直接交付的文字部分完成，下面是一版${draft.label}：`,
      "",
      draft.content,
    ].join("\n"),
    sources: normalizeUserResponseList([
      `已先完成：${draft.label}。`,
      decomposition.blocked.length > 0
        ? `這輪同時還有 ${decomposition.blocked.map((item) => item.label).join("、")} 需求，所以目前先交付文字部分。`
        : "",
    ]),
    limitations: buildTaskDecompositionLimitations(decomposition.blocked),
  }, {
    failure_class: "partial_success",
    reply_mode: "partial_success",
  });
}

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
  requestText = "",
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
    const normalizedResponse = maybeApplyTaskDecompositionFallback({
      response: buildPlannerSuccessUserResponse(envelope),
      requestText,
    });
    const failureClass = deriveFailureClassFromEnvelope({
      envelope,
      requestText,
      response: normalizedResponse,
    });
    attachHiddenUserResponseMetadata(normalizedResponse, {
      failure_class: failureClass,
      reply_mode: failureClass === "partial_success"
        ? "partial_success"
        : normalizedResponse.ok === true
          ? "success"
          : "fail_soft",
    });
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
  const normalizedPayload = maybeApplyTaskDecompositionFallback({
    response: buildExecutionDataUserResponse({
      executionData,
      ok: objectPayload.ok !== false && execution?.ok !== false,
    }) || buildGenericUserResponse({
      ok: objectPayload.ok !== false && execution?.ok !== false,
    }),
    requestText,
  });
  attachHiddenUserResponseMetadata(normalizedPayload, {
    failure_class: deriveFailureClassFromEnvelope({
      envelope: objectPayload,
      requestText,
      response: normalizedPayload,
    }),
    reply_mode: isPartialSuccessResponse(normalizedPayload)
      ? "partial_success"
      : normalizedPayload.ok === true
        ? "success"
        : "fail_soft",
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
