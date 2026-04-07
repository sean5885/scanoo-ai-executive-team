import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
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
const MAX_USER_FACING_NEXT_STEPS = 3;
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

function normalizeCompareText(text = "") {
  return normalizeText(String(text || ""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[「」"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function normalizePlannerDocumentItems(items = []) {
  return Array.from(
    new Map(
      (Array.isArray(items) ? items : [])
        .map((item, index) => ({
          title: normalizeText(item?.title || ""),
          doc_id: normalizeText(item?.doc_id || ""),
          url: normalizeText(item?.url || ""),
          reason: normalizeText(item?.reason || ""),
          _index: Number.isInteger(index) ? index : 0,
        }))
        .filter((item) => item.title || item.doc_id || item.url || item.reason)
        .map((item) => [
          [item.doc_id, item.title, item.url].filter(Boolean).join("::"),
          item,
        ]),
    ).values(),
  );
}

function buildPlannerDocumentLabel(item = {}) {
  return normalizeText(item?.title || item?.doc_id || "") || "未命名文件";
}

function normalizePlannerSummaryText(text = "") {
  return normalizeText(String(text || ""))
    .replace(/^內容重點[:：]\s*/u, "")
    .replace(/^checklist 可先看\d+項[:：]\s*/iu, "")
    .trim();
}

function isDeliveryKnowledgeQuery(queryText = "", execution = {}) {
  const combined = normalizeCompareText([
    queryText,
    execution?.match_reason,
    execution?.title,
    execution?.content_summary,
  ].filter(Boolean).join(" "));
  return /(交付|onboarding|導入|导入|sop|驗收|验收|checklist)/.test(combined);
}

function isLocationStyleQuery(queryText = "") {
  const normalized = normalizeText(queryText);
  return /在哪|哪裡|哪里/u.test(normalized);
}

function isChecklistStyleQuery(queryText = "") {
  const normalized = normalizeText(queryText);
  return /checklist|清單|清单|哪些項目|哪些项目|要看什麼|要看什么|重點|重点/u.test(normalized);
}

function isStartStyleQuery(queryText = "") {
  const normalized = normalizeText(queryText);
  return /怎麼開始|怎么开始|第一步|怎麼走|怎么走|流程|講給我聽|讲给我听/u.test(normalized);
}

function buildDeliverySearchAnswer({
  queryText = "",
  documentItems = [],
} = {}) {
  const topItem = documentItems[0] || {};
  const title = buildPlannerDocumentLabel(topItem);
  const reason = normalizePlannerSummaryText(topItem?.reason || "");

  if (!title || !reason) {
    return null;
  }

  if (isLocationStyleQuery(queryText)) {
    return `最直接的對應文件是「${title}」。${reason}`;
  }

  if (isChecklistStyleQuery(queryText)) {
    return `我先用「${title}」回答這題。${reason}`;
  }

  if (isStartStyleQuery(queryText)) {
    return `如果你要開始這件事，我會先從「${title}」這份文件開始。${reason}`;
  }

  return `我先用「${title}」回答這題。${reason}`;
}

function buildDeliverySearchFallbacks({
  queryText = "",
  documentItems = [],
} = {}) {
  const topLabel = buildPlannerDocumentLabel(documentItems[0] || {});
  if (!topLabel || !isDeliveryKnowledgeQuery(queryText, { title: topLabel })) {
    return [];
  }

  if (isLocationStyleQuery(queryText)) {
    return [
      `如果你要，我可以直接打開「${topLabel}」補該 SOP 的原文段落或更多位置線索。`,
      "如果你要找的是另一份 SOP，也可以直接補部門、客戶階段或 owner，我再縮小範圍。",
    ];
  }

  if (isChecklistStyleQuery(queryText)) {
    return [
      `如果你要，我可以直接把「${topLabel}」整理成可執行 checklist。`,
    ];
  }

  if (isStartStyleQuery(queryText)) {
    return [
      `如果你要，我可以把「${topLabel}」拆成 3 到 5 步的導入順序與驗收點。`,
    ];
  }

  return [
    `如果你要，我可以沿著「${topLabel}」補更多原文依據，再整理成更短的摘要或 checklist。`,
  ];
}

function normalizePlannerSkillSources(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: normalizeText(item?.id || ""),
      title: normalizeText(item?.title || ""),
      doc_id: normalizeText(item?.doc_id || item?.document_id || item?.id || ""),
      url: normalizeText(item?.url || ""),
      reason: normalizeText(item?.snippet || item?.reason || ""),
    }))
    .filter((item) => item.id || item.title || item.doc_id || item.url || item.reason);
}

function buildPlannerEvidenceGapAnswer({
  title = "",
  docId = "",
} = {}) {
  const label = normalizeText(title || docId || "");
  if (label) {
    return `我先定位到「${label}」，但目前可用來源不足，所以先不補更多內容細節。`;
  }
  return "我先定位到對應文件，但目前可用來源不足，所以先不補更多內容細節。";
}

function resolvePlannerQueryText(envelope = {}, execution = {}) {
  return normalizeText(
    envelope?.params?.q
    || envelope?.params?.query
    || execution?.match_reason
    || execution?.title
    || execution?.doc_id
    || "",
  );
}

function classifyPlannerQueryIntent(queryText = "", execution = {}) {
  const normalizedQuery = normalizeCompareText(queryText);
  const normalizedSummary = normalizeCompareText(execution?.content_summary || "");
  const combined = [normalizedQuery, normalizedSummary].filter(Boolean).join(" ");

  if (/(debug|除錯|排查|錯誤|错误|異常|异常|bug|trace|log|timeout|失敗|失败|卡住|為什麼.*(壞|錯|错|失敗|失败)|怎麼修|怎么修|原因)/.test(combined)) {
    return "debug";
  }

  if (/(決策|决定|比較|比较|取捨|取舍|風險|风险|評估|评估|該不該|该不该|要不要|選哪|选哪|方案|tradeoff)/.test(combined)) {
    return "decision";
  }

  return "lookup";
}

function buildQueryAwareNextSteps({
  queryType = "lookup",
  queryText = "",
  documentItems = [],
  hasEvidence = false,
} = {}) {
  const normalizedQuery = normalizeText(queryText || "");
  const topLabel = buildPlannerDocumentLabel(documentItems[0] || {});

  if (queryType === "debug") {
    if (hasEvidence) {
      return [
        topLabel
          ? `可以先對照「${topLabel}」這份已命中的文件確認現象是否一致；若你補上錯誤訊息、trace 關鍵字或觸發步驟，我可以再沿著同一批來源縮小範圍。`
          : "如果你補上錯誤訊息、trace 關鍵字或觸發步驟，我可以沿著這批已命中的來源繼續縮小範圍。",
      ];
    }
    return [
      normalizedQuery
        ? `目前證據還不夠定位「${normalizedQuery}」的原因；下一步可以補錯誤訊息、trace 關鍵字或觸發步驟，我再只沿著相關文件繼續查。`
        : "目前證據還不夠定位原因；下一步可以補錯誤訊息、trace 關鍵字或觸發步驟，我再只沿著相關文件繼續查。",
    ];
  }

  if (queryType === "decision") {
    if (hasEvidence) {
      return [
        documentItems.length > 1
          ? "建議先把這輪命中的文件放在一起比較差異、風險與適用範圍，再決定要採哪個方向。"
          : "如果這是在做決策，建議再補一份可比較的對照文件或驗證條件，避免只靠單一來源下判斷。",
      ];
    }
    return [
      normalizedQuery
        ? `目前證據還不足以直接判斷「${normalizedQuery}」；下一步可以指定要比較的方案、文件或驗證條件，我再沿著那個方向整理。`
        : "目前證據還不足以直接下判斷；下一步可以指定要比較的方案、文件或驗證條件，我再沿著那個方向整理。",
    ];
  }

  if (hasEvidence) {
    return [
      topLabel
        ? `如果你要，我可以繼續打開「${topLabel}」或同一組相關文件，補更多原文依據後再整理成摘要或 checklist。`
        : "如果你要，我可以沿著這組已命中的文件補更多原文依據，再整理成摘要或 checklist。",
    ];
  }

  return [
    normalizedQuery
      ? `可以換更精準的文件名、主題詞或角色範圍，再重新查「${normalizedQuery}」。`
      : "可以換更精準的文件名、主題詞或角色範圍再試一次。",
  ];
}

function buildPlannerNextSteps({
  envelope = {},
  execution = {},
  fallbacks = [],
  documentItems = [],
  hasEvidence = false,
} = {}) {
  const actionLayerNextSteps = Array.isArray(execution?.action_layer?.next_actions)
    ? execution.action_layer.next_actions
    : Array.isArray(execution?.action_layer?.nextSteps)
      ? execution.action_layer.nextSteps
      : [];
  const queryText = resolvePlannerQueryText(envelope, execution);
  const queryType = classifyPlannerQueryIntent(queryText, execution);
  const queryAwareNextSteps = buildQueryAwareNextSteps({
    queryType,
    queryText,
    documentItems,
    hasEvidence,
  });
  return normalizeUserResponseList([
    ...actionLayerNextSteps,
    ...queryAwareNextSteps,
    ...fallbacks,
  ]).slice(0, MAX_USER_FACING_NEXT_STEPS);
}

function buildPendingItemRenderLines(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return normalizeUserResponseList(items.map((item) => {
    const label = normalizeText(item?.label || "");
    if (!label) {
      return null;
    }
    const actionLabels = normalizeUserResponseList(
      (Array.isArray(item?.actions) ? item.actions : []).map((action) => `操作：${normalizeText(action?.label || "")}`),
    );
    return actionLabels.length > 0
      ? `${label}｜${actionLabels.join("、")}`
      : label;
  })).slice(0, 5);
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

function buildPlannerSkillSuccessUserResponse({
  envelope = {},
  execution = {},
} = {}) {
  const skillData = execution?.data && typeof execution.data === "object" && !Array.isArray(execution.data)
    ? execution.data
    : {};
  if (normalizeText(skillData.bridge || "") !== "skill_bridge") {
    return null;
  }

  const queryText = normalizeText(
    skillData.query
    || skillData.title
    || skillData.doc_id
    || resolvePlannerQueryText(envelope, execution),
  );
  const documentItems = normalizePlannerSkillSources(skillData.sources);
  const hasEvidence = Boolean(
    normalizeText(skillData.summary || "")
    || documentItems.length > 0
    || skillData.found === true,
  );
  const fallbackLimitations = normalizeUserResponseList(Array.isArray(skillData.limitations) ? skillData.limitations : []);

  return {
    ok: true,
    answer: normalizeText(skillData.summary || "")
      || (skillData.found === true
        ? "我已用既有受控 answer pipeline 整理這輪 skill 結果。"
        : "目前沒有找到可以直接整理的已驗證內容。"),
    sources: normalizeUserFacingAnswerSources(documentItems, {
      query: queryText,
      maxSources: MAX_USER_FACING_SOURCES,
    }),
    limitations: buildPlannerNextSteps({
      envelope,
      execution: {
        match_reason: queryText,
        content_summary: normalizeText(skillData.summary || ""),
      },
      documentItems,
      hasEvidence,
      fallbacks: fallbackLimitations.length > 0
        ? fallbackLimitations
        : hasEvidence
          ? ["如果你要，我可以沿著這批已驗證來源繼續整理成更短的摘要或 checklist。"]
          : ["如果你要，我可以換更精準的文件名、主題詞或 doc_id 再查一次。"],
    }),
  };
}

function resolvePlannerPresentationExecution(envelope = {}, execution = {}) {
  const formattedOutput = execution?.formatted_output && typeof execution.formatted_output === "object" && !Array.isArray(execution.formatted_output)
    ? execution.formatted_output
    : envelope?.formatted_output && typeof envelope.formatted_output === "object" && !Array.isArray(envelope.formatted_output)
      ? envelope.formatted_output
      : null;
  return formattedOutput
    ? {
        ...execution,
        ...formattedOutput,
      }
    : execution;
}

export function buildPlannerSuccessUserResponse(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const executionData = resolvePlannerExecutionData(execution);
  const canonicalResponse = buildExecutionDataUserResponse({
    executionData,
    ok: envelope?.ok === true && execution?.ok !== false,
  });
  if (canonicalResponse) {
    return canonicalResponse;
  }

  const presentableExecution = resolvePlannerPresentationExecution(envelope, execution);
  const hasFormattedOutput = presentableExecution !== execution;
  const skillResponse = buildPlannerSkillSuccessUserResponse({
    envelope,
    execution: presentableExecution,
  });
  if (skillResponse) {
    return skillResponse;
  }

  const kind = normalizeText(presentableExecution.kind || "");
  const documentItems = normalizePlannerDocumentItems(presentableExecution.items);
  const queryText = resolvePlannerQueryText(envelope, presentableExecution);
  const pendingItemLines = buildPendingItemRenderLines(presentableExecution.pending_items);
  const evidenceSourceLines = normalizeUserFacingAnswerSources(documentItems, {
    query: queryText,
    maxSources: MAX_USER_FACING_SOURCES,
  });

  if (kind === "get_runtime_info" || kind === "runtime_info") {
    const summary = [
      "目前 runtime 有正常回應。",
      presentableExecution.db_path ? `資料庫路徑在 ${presentableExecution.db_path}。` : null,
      Number.isFinite(presentableExecution.node_pid) ? `目前 PID 是 ${presentableExecution.node_pid}。` : null,
      presentableExecution.cwd ? `工作目錄是 ${presentableExecution.cwd}。` : null,
    ].filter(Boolean).join(" ");
    return {
      ok: true,
      answer: summary || "目前 runtime 有正常回應。",
      sources: ["runtime 即時狀態：這份回覆直接來自目前 process 的即時資訊。"],
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        fallbacks: [
          presentableExecution.service_start_time
            ? `這是啟動於 ${presentableExecution.service_start_time} 的即時 runtime 快照。`
            : "這是目前 runtime 的即時快照。",
        ],
        hasEvidence: true,
      }),
    };
  }

  if (!hasFormattedOutput) {
    return buildGenericUserResponse({
      ok: envelope?.ok === true && execution?.ok !== false,
    });
  }

  if (kind === "search") {
    const query = normalizeText(presentableExecution.match_reason || "");
    const deliverySearchAnswer = isDeliveryKnowledgeQuery(query, presentableExecution) && documentItems.length > 0
      ? buildDeliverySearchAnswer({
          queryText: query,
          documentItems,
        })
      : null;
    const deliverySearchFallbacks = isDeliveryKnowledgeQuery(query, presentableExecution)
      ? buildDeliverySearchFallbacks({
          queryText: query,
          documentItems,
        })
      : [];
    return {
      ok: true,
      answer: deliverySearchAnswer || (documentItems.length > 0
        ? `我已先按目前已索引的文件，標出和「${query || "這輪需求"}」最相關的 ${documentItems.length} 份文件。`
        : normalizeText(presentableExecution.content_summary || "") || "目前沒有找到可直接對應的已索引文件。"),
      sources: evidenceSourceLines,
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        documentItems,
        hasEvidence: documentItems.length > 0,
        fallbacks: deliverySearchFallbacks.length > 0
          ? deliverySearchFallbacks
          : documentItems.length > 0
          ? [
              "如果這是在做排除/重分配，也可以直接告訴我要保留或排除哪幾份。",
            ]
          : [
              "如果你預期它應該存在，也可以先同步最新雲文件後再試。",
            ],
      }),
    };
  }

  if (kind === "detail" || kind === "search_and_detail") {
    const title = normalizeText(presentableExecution.title || "");
    const docId = normalizeText(presentableExecution.doc_id || "");
    const summary = normalizeText(presentableExecution.content_summary || "");
    const effectiveSources = documentItems.length > 0
      ? documentItems
      : normalizePlannerDocumentItems([{
          title,
          doc_id: docId,
          reason: presentableExecution.match_reason || "",
        }]);
    return {
      ok: true,
      answer: summary
        ? [
            title
              ? `我先以「${title}」作為這輪最直接的對應文件。`
              : docId
                ? `我先以文件 ${docId} 作為這輪最直接的對應文件。`
                : null,
            summary,
          ]
            .filter(Boolean)
            .join(" ")
        : buildPlannerEvidenceGapAnswer({ title, docId }),
      sources: normalizeUserResponseList([
        ...normalizeUserFacingAnswerSources(effectiveSources, {
          query: queryText,
          maxSources: MAX_USER_FACING_SOURCES,
        }),
        ...pendingItemLines,
      ]),
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        documentItems: effectiveSources,
        hasEvidence: Boolean(summary || effectiveSources.length > 0),
        fallbacks: [
          presentableExecution.match_reason
            ? `如果你要，我可以繼續沿著「${presentableExecution.match_reason}」補抓更多原文依據，再整理成更短的摘要或 checklist。`
            : "如果你要，我可以先補抓更多原文依據，再把這份文件整理成更短的摘要或 checklist。",
        ],
      }),
    };
  }

  if (kind === "search_and_detail_candidates") {
    const query = normalizeText(presentableExecution.match_reason || "");
    return {
      ok: true,
      answer: `我先標出 ${documentItems.length || "多"} 份需要你確認的候選文件，因為這輪需求還沒有唯一對到單一文件。`,
      sources: evidenceSourceLines,
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        documentItems,
        hasEvidence: documentItems.length > 0,
        fallbacks: [
          query ? `你可以直接回我第幾份，或告訴我只保留和「${query}」最相關的文件。` : "你可以直接回我第幾份，或貼出想看的文件名稱。",
        ],
      }),
    };
  }

  if (kind === "search_and_detail_not_found") {
    return {
      ok: true,
      answer: normalizeText(presentableExecution.content_summary || "") || "目前沒有找到可以直接整理的對應文件。",
      sources: [],
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        hasEvidence: false,
        fallbacks: [
          presentableExecution.match_reason
            ? `你可以換一個更明確的文件名稱、主題或角色範圍，再重新查「${presentableExecution.match_reason}」。`
            : "你可以換一個更明確的文件名稱、主題或角色範圍再試一次。",
          "如果你預期它應該存在，也可以先同步最新雲文件後再試。",
        ],
      }),
    };
  }

  if (kind === "task_lifecycle" || kind === "task_lifecycle_update" || kind === "task_lifecycle_candidates" || kind === "pending_item_action") {
    const resolvedItemTitle = normalizeText(presentableExecution?.resolved_item?.title || "");
    const resolvedItemStatus = normalizeText(presentableExecution?.resolved_item?.status || "");
    return {
      ok: envelope?.ok === true && execution?.ok !== false,
      answer: normalizeText(presentableExecution.content_summary || "")
        || (resolvedItemTitle ? `已更新「${resolvedItemTitle}」。` : "已更新 pending item。"),
      sources: normalizeUserResponseList([
        resolvedItemTitle
          ? `已更新：${resolvedItemTitle}${resolvedItemStatus ? `｜狀態：${resolvedItemStatus}` : ""}`
          : null,
        ...pendingItemLines,
      ]),
      limitations: buildPlannerNextSteps({
        envelope,
        execution: presentableExecution,
        hasEvidence: true,
        fallbacks: pendingItemLines.length > 0
          ? ["如果你要，我可以繼續幫你標記下一個 pending item。"]
          : ["目前這批 pending item 已沒有新的待處理項目。"],
      }),
    };
  }

  return buildGenericUserResponse({
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
    const failureReply = buildPlannedUserInputUserFacingReply(envelope, { requestText });
    const baseResponse = failureReply
      ? {
          ok: false,
          answer: normalizeText(failureReply.answer || "") || "這次沒有拿到可以直接交付的安全結果。",
          sources: normalizeUserFacingAnswerSources(failureReply.sources, {
            maxSources: MAX_USER_FACING_SOURCES,
          }),
          limitations: normalizeUserResponseList(failureReply.limitations),
        }
      : buildPlannerSuccessUserResponse(envelope);
    const normalizedResponse = maybeApplyTaskDecompositionFallback({
      response: baseResponse,
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
  if (isCanonicalUserFacingResponse(objectPayload) || typeof objectPayload.answer === "string") {
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: objectPayload.ok !== false,
    });
    return {
      ok: objectPayload.ok !== false,
      answer: normalizeText(objectPayload.answer || ""),
      sources: normalizeUserFacingAnswerSources(objectPayload.sources, {
        maxSources: MAX_USER_FACING_SOURCES,
      }),
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
