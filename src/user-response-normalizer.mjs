import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
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
const MAX_USER_FACING_NEXT_STEPS = 3;
const RAW_PLANNER_VISIBLE_PAYLOAD_PATTERN = /skill_bridge|document_summarize|search_and_summarize|side_effects|get_company_brain_doc_detail|search_knowledge_base|read-runtime|authority/i;

function normalizeCompareText(text = "") {
  return normalizeText(String(text || ""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[「」"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  return execution && typeof execution === "object" && !Array.isArray(execution) ? execution : {};
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
  const nextSteps = buildPlannerNextSteps({
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
  });

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
    limitations: nextSteps,
  };
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

export function buildPlannerSuccessUserResponse(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const skillResponse = buildPlannerSkillSuccessUserResponse({
    envelope,
    execution,
  });
  if (skillResponse) {
    return skillResponse;
  }
  const kind = normalizeText(execution.kind || "");
  const documentItems = normalizePlannerDocumentItems(execution.items);
  const queryText = resolvePlannerQueryText(envelope, execution);
  const pendingItemLines = buildPendingItemRenderLines(execution.pending_items);
  const evidenceSourceLines = normalizeUserFacingAnswerSources(documentItems, {
    query: queryText,
    maxSources: MAX_USER_FACING_SOURCES,
  });

  if (kind === "get_runtime_info" || kind === "runtime_info") {
    const summary = [
      "目前 runtime 有正常回應。",
      execution.db_path ? `資料庫路徑在 ${execution.db_path}。` : null,
      Number.isFinite(execution.node_pid) ? `目前 PID 是 ${execution.node_pid}。` : null,
      execution.cwd ? `工作目錄是 ${execution.cwd}。` : null,
    ].filter(Boolean).join(" ");
    return {
      ok: true,
      answer: summary || "目前 runtime 有正常回應。",
      sources: ["runtime 即時狀態：這份回覆直接來自目前 process 的即時資訊。"],
      limitations: buildPlannerNextSteps({
        envelope,
        execution,
        fallbacks: [
        execution.service_start_time ? `這是啟動於 ${execution.service_start_time} 的即時 runtime 快照。` : "這是目前 runtime 的即時快照。",
        ],
        hasEvidence: true,
      }),
    };
  }

  if (kind === "search") {
    const query = normalizeText(execution.match_reason || "");
    return {
      ok: true,
      answer: documentItems.length > 0
        ? `我已先按目前已索引的文件，標出和「${query || "這輪需求"}」最相關的 ${documentItems.length} 份文件。`
        : normalizeText(execution.content_summary || "") || "目前沒有找到可直接對應的已索引文件。",
      sources: evidenceSourceLines,
      limitations: buildPlannerNextSteps({
        envelope,
        execution,
        documentItems,
        hasEvidence: documentItems.length > 0,
        fallbacks: documentItems.length > 0
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
    const title = normalizeText(execution.title || "");
    const docId = normalizeText(execution.doc_id || "");
    const summary = normalizeText(execution.content_summary || "");
    const effectiveSources = documentItems.length > 0
      ? documentItems
      : normalizePlannerDocumentItems([{
          title,
          doc_id: docId,
          reason: execution.match_reason || "",
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
        execution,
        documentItems: effectiveSources,
        hasEvidence: Boolean(summary || effectiveSources.length > 0),
        fallbacks: [
        execution.match_reason
          ? `如果你要，我可以繼續沿著「${execution.match_reason}」補抓更多原文依據，再整理成更短的摘要或 checklist。`
          : "如果你要，我可以先補抓更多原文依據，再把這份文件整理成更短的摘要或 checklist。",
        ],
      }),
    };
  }

  if (kind === "search_and_detail_candidates") {
    const query = normalizeText(execution.match_reason || "");
    return {
      ok: true,
      answer: `我先標出 ${documentItems.length || "多"} 份需要你確認的候選文件，因為這輪需求還沒有唯一對到單一文件。`,
      sources: evidenceSourceLines,
      limitations: buildPlannerNextSteps({
        envelope,
        execution,
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
      answer: normalizeText(execution.content_summary || "") || "目前沒有找到可以直接整理的對應文件。",
      sources: [],
      limitations: buildPlannerNextSteps({
        envelope,
        execution,
        hasEvidence: false,
        fallbacks: [
        execution.match_reason
          ? `你可以換一個更明確的文件名稱、主題或角色範圍，再重新查「${execution.match_reason}」。`
          : "你可以換一個更明確的文件名稱、主題或角色範圍再試一次。",
        "如果你預期它應該存在，也可以先同步最新雲文件後再試。",
        ],
      }),
    };
  }

  if (kind === "task_lifecycle" || kind === "task_lifecycle_update" || kind === "task_lifecycle_candidates" || kind === "pending_item_action") {
    const resolvedItemTitle = normalizeText(execution?.resolved_item?.title || "");
    const resolvedItemStatus = normalizeText(execution?.resolved_item?.status || "");
    return {
      ok: true,
      answer: normalizeText(execution.content_summary || "")
        || (resolvedItemTitle ? `已更新「${resolvedItemTitle}」。` : "已更新 pending item。"),
      sources: normalizeUserResponseList([
        resolvedItemTitle
          ? `已更新：${resolvedItemTitle}${resolvedItemStatus ? `｜狀態：${resolvedItemStatus}` : ""}`
          : null,
        ...pendingItemLines,
      ]),
      limitations: buildPlannerNextSteps({
        envelope,
        execution,
        hasEvidence: true,
        fallbacks: pendingItemLines.length > 0
          ? ["如果你要，我可以繼續幫你標記下一個 pending item。"]
          : ["目前這批 pending item 已沒有新的待處理項目。"],
      }),
    };
  }

  return {
    ok: envelope?.ok === true,
    answer: envelope?.ok === true
      ? "這次查詢已有工具回應，但目前沒有足夠已驗證內容可整理成更多重點。"
      : "這次沒有拿到可以直接交付的結果。",
    sources: [],
    limitations: [],
  };
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
    const failureReply = buildPlannedUserInputUserFacingReply(plannerEnvelope || plannerResult || envelope);
    if (failureReply) {
      const normalizedFailure = {
        ok: false,
        answer: normalizeText(failureReply.answer || "") || "這次沒有拿到可以直接交付的安全結果。",
        sources: normalizeUserFacingAnswerSources(failureReply.sources, {
          maxSources: MAX_USER_FACING_SOURCES,
        }),
        limitations: normalizeUserResponseList(failureReply.limitations),
      };
      maybeEmitPlannerVisibleAnswerTelemetry({
        envelope,
        normalizedResponse: normalizedFailure,
        traceId,
      });
      emitBoundaryLog({
        logger,
        traceId,
        handlerName,
        ok: normalizedFailure.ok,
        extraFields: buildPlannerSkillBoundaryFields(envelope),
      });
      return normalizedFailure;
    }
    const normalizedSuccess = buildPlannerSuccessUserResponse(envelope);
    maybeEmitPlannerVisibleAnswerTelemetry({
      envelope,
      normalizedResponse: normalizedSuccess,
      traceId,
    });
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: normalizedSuccess.ok,
      extraFields: buildPlannerSkillBoundaryFields(envelope),
    });
    return normalizedSuccess;
  }

  const objectPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (normalizeText(objectPayload.answer || "")) {
    const normalizedPayload = {
      ok: objectPayload.ok !== false,
      answer: normalizeText(objectPayload.answer || ""),
      sources: normalizeUserFacingAnswerSources(objectPayload.sources, {
        maxSources: MAX_USER_FACING_SOURCES,
      }),
      limitations: normalizeUserResponseList(objectPayload.limitations),
    };
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: normalizedPayload.ok,
    });
    return normalizedPayload;
  }

  const normalizedFallback = {
    ok: objectPayload.ok !== false,
    answer: normalizeText(objectPayload.message || "") || "這次沒有拿到可以直接交付的結果。",
    sources: [],
    limitations: normalizeUserResponseList([
      "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
    ]),
  };
  emitBoundaryLog({
    logger,
    traceId,
    handlerName,
    ok: normalizedFallback.ok,
  });
  return normalizedFallback;
}

export function renderUserResponseText(response = {}) {
  const normalizedResponse = normalizeUserResponse({ payload: response });
  return renderPlannerUserFacingReplyText(normalizedResponse);
}
