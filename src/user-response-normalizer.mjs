import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
  renderPlannerUserFacingReplyText,
} from "./executive-planner.mjs";
import { normalizeText } from "./text-utils.mjs";

function emitBoundaryLog({
  logger = null,
  traceId = null,
  handlerName = null,
  ok = null,
} = {}) {
  const payload = {
    chat_output_boundary: "normalized",
    handler_name: normalizeText(handlerName || "") || "unknown_handler",
    trace_id: normalizeText(traceId || "") || null,
    ok: typeof ok === "boolean" ? ok : null,
  };
  if (logger?.info) {
    logger.info("chat_output_boundary", payload);
    return;
  }
  console.info("chat_output_boundary", payload);
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
        .map((item) => ({
          title: normalizeText(item?.title || ""),
          doc_id: normalizeText(item?.doc_id || ""),
          url: normalizeText(item?.url || ""),
          reason: normalizeText(item?.reason || ""),
        }))
        .filter((item) => item.title || item.doc_id || item.url || item.reason)
        .map((item) => [
          [item.doc_id, item.title, item.url].filter(Boolean).join("::"),
          item,
        ]),
    ).values(),
  );
}

function buildPlannerDocumentSourceLine(item = {}) {
  const label = item.title || item.doc_id || "未命名文件";
  const reason = item.reason || "這份文件出現在這輪檢索結果中。";
  if (item.url) {
    return `${label}：${reason} 連結：${item.url}`;
  }
  return `${label}：${reason}`;
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

function buildPlannerNextSteps(execution = {}, fallbacks = []) {
  const actionLayerNextSteps = Array.isArray(execution?.action_layer?.next_actions)
    ? execution.action_layer.next_actions
    : Array.isArray(execution?.action_layer?.nextSteps)
      ? execution.action_layer.nextSteps
      : [];
  return normalizeUserResponseList([
    ...actionLayerNextSteps,
    ...fallbacks,
  ]).slice(0, 3);
}

export function buildPlannerSuccessUserResponse(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const kind = normalizeText(execution.kind || "");
  const documentItems = normalizePlannerDocumentItems(execution.items);

  if (kind === "runtime_info") {
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
      limitations: buildPlannerNextSteps(execution, [
        execution.service_start_time ? `這是啟動於 ${execution.service_start_time} 的即時 runtime 快照。` : "這是目前 runtime 的即時快照。",
      ]),
    };
  }

  if (kind === "search") {
    const query = normalizeText(execution.match_reason || "");
    return {
      ok: true,
      answer: documentItems.length > 0
        ? `我已先按目前已索引的文件，標出和「${query || "這輪需求"}」最相關的 ${documentItems.length} 份文件。`
        : normalizeText(execution.content_summary || "") || "目前沒有找到可直接對應的已索引文件。",
      sources: normalizeUserResponseList(documentItems.map(buildPlannerDocumentSourceLine)),
      limitations: buildPlannerNextSteps(execution, documentItems.length > 0
        ? [
            "如果你要，我可以直接打開其中一份文件幫你整理內容。",
            "如果這是在做排除/重分配，也可以直接告訴我要保留或排除哪幾份。",
          ]
        : [
            query ? `可以換一個更精準的主題詞、文件名或角色範圍，再重新查「${query}」相關文件。` : "可以換一個更精準的主題詞、文件名或角色範圍再試一次。",
            "如果你預期它應該存在，也可以先同步最新雲文件後再試。",
          ]),
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
          reason: execution.match_reason || "這份文件直接命中這輪需求。",
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
      sources: normalizeUserResponseList(effectiveSources.map(buildPlannerDocumentSourceLine)),
      limitations: buildPlannerNextSteps(execution, [
        execution.match_reason
          ? `如果你要，我可以繼續沿著「${execution.match_reason}」補抓更多原文依據，再整理成更短的摘要或 checklist。`
          : "如果你要，我可以先補抓更多原文依據，再把這份文件整理成更短的摘要或 checklist。",
      ]),
    };
  }

  if (kind === "search_and_detail_candidates") {
    const query = normalizeText(execution.match_reason || "");
    return {
      ok: true,
      answer: `我先標出 ${documentItems.length || "多"} 份需要你確認的候選文件，因為這輪需求還沒有唯一對到單一文件。`,
      sources: normalizeUserResponseList(documentItems.map(buildPlannerDocumentSourceLine)),
      limitations: buildPlannerNextSteps(execution, [
        query ? `你可以直接回我第幾份，或告訴我只保留和「${query}」最相關的文件。` : "你可以直接回我第幾份，或貼出想看的文件名稱。",
      ]),
    };
  }

  if (kind === "search_and_detail_not_found") {
    return {
      ok: true,
      answer: normalizeText(execution.content_summary || "") || "目前沒有找到可以直接整理的對應文件。",
      sources: [],
      limitations: buildPlannerNextSteps(execution, [
        execution.match_reason
          ? `你可以換一個更明確的文件名稱、主題或角色範圍，再重新查「${execution.match_reason}」。`
          : "你可以換一個更明確的文件名稱、主題或角色範圍再試一次。",
        "如果你預期它應該存在，也可以先同步最新雲文件後再試。",
      ]),
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
        sources: normalizeUserResponseList(failureReply.sources),
        limitations: normalizeUserResponseList(failureReply.limitations),
      };
      emitBoundaryLog({
        logger,
        traceId,
        handlerName,
        ok: normalizedFailure.ok,
      });
      return normalizedFailure;
    }
    const normalizedSuccess = buildPlannerSuccessUserResponse(envelope);
    emitBoundaryLog({
      logger,
      traceId,
      handlerName,
      ok: normalizedSuccess.ok,
    });
    return normalizedSuccess;
  }

  const objectPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (normalizeText(objectPayload.answer || "")) {
    const normalizedPayload = {
      ok: objectPayload.ok !== false,
      answer: normalizeText(objectPayload.answer || ""),
      sources: normalizeUserResponseList(objectPayload.sources),
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
