import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
  renderPlannerUserFacingReplyText,
} from "./executive-planner.mjs";
import { normalizeText } from "./text-utils.mjs";

export function normalizeUserResponseList(items = []) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeText(String(item || "")))
      .filter(Boolean),
  )];
}

export function buildPlannerSuccessUserResponse(envelope = {}) {
  const execution = envelope?.execution_result && typeof envelope.execution_result === "object"
    ? envelope.execution_result
    : {};
  const kind = normalizeText(execution.kind || "");

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
      sources: ["runtime 即時狀態"],
      limitations: normalizeUserResponseList([
        execution.service_start_time ? `這是啟動於 ${execution.service_start_time} 的即時 runtime 快照。` : "這是目前 runtime 的即時快照。",
      ]),
    };
  }

  if (kind === "search") {
    const items = Array.isArray(execution.items) ? execution.items : [];
    return {
      ok: true,
      answer: items.length > 0
        ? `我找到 ${items.length} 份相關文件，你可以直接指定想看哪一份。`
        : "目前沒有找到直接相關的文件。",
      sources: normalizeUserResponseList(items.map((item) => (
        [normalizeText(item?.title || ""), normalizeText(item?.doc_id || "")]
          .filter(Boolean)
          .join(" / ")
      ))),
      limitations: ["如果你要，我可以繼續打開其中一份文件幫你整理內容。"],
    };
  }

  if (kind === "detail" || kind === "search_and_detail") {
    const title = normalizeText(execution.title || "");
    const summary = normalizeText(execution.content_summary || "");
    return {
      ok: true,
      answer: [title ? `「${title}」的重點如下：` : null, summary || "我已經找到對應文件，但目前可用摘要有限。"]
        .filter(Boolean)
        .join(" "),
      sources: normalizeUserResponseList([
        [title, normalizeText(execution.doc_id || "")].filter(Boolean).join(" / "),
      ]),
      limitations: normalizeUserResponseList([
        execution.match_reason ? `這次是依照「${execution.match_reason}」命中的文件。` : null,
      ]),
    };
  }

  if (kind === "search_and_detail_candidates") {
    const items = Array.isArray(execution.items) ? execution.items : [];
    return {
      ok: true,
      answer: `我找到 ${items.length || "多"} 份可能相關的文件，還需要你指定要打開哪一份。`,
      sources: normalizeUserResponseList(items.map((item) => (
        [normalizeText(item?.title || ""), normalizeText(item?.doc_id || "")]
          .filter(Boolean)
          .join(" / ")
      ))),
      limitations: ["你可以直接回我第幾份，或貼出想看的文件名稱。"],
    };
  }

  if (kind === "search_and_detail_not_found") {
    return {
      ok: true,
      answer: "目前沒有找到可以直接整理的對應文件。",
      sources: [],
      limitations: ["可以換一個關鍵詞，或補更多上下文再試一次。"],
    };
  }

  return {
    ok: envelope?.ok === true,
    answer: envelope?.ok === true
      ? "我已經完成這次查詢。"
      : "這次沒有拿到可以直接交付的結果。",
    sources: [],
    limitations: [],
  };
}

export function normalizeUserResponse({
  plannerResult = null,
  plannerEnvelope = null,
  payload = null,
} = {}) {
  const envelope = plannerEnvelope && typeof plannerEnvelope === "object"
    ? plannerEnvelope
    : plannerResult && typeof plannerResult === "object"
      ? buildPlannedUserInputEnvelope(plannerResult)
      : null;

  if (envelope) {
    const failureReply = buildPlannedUserInputUserFacingReply(plannerEnvelope || plannerResult || envelope);
    if (failureReply) {
      return {
        ok: false,
        answer: normalizeText(failureReply.answer || "") || "這次沒有拿到可以直接交付的安全結果。",
        sources: normalizeUserResponseList(failureReply.sources),
        limitations: normalizeUserResponseList(failureReply.limitations),
      };
    }
    return buildPlannerSuccessUserResponse(envelope);
  }

  const objectPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (normalizeText(objectPayload.answer || "")) {
    return {
      ok: objectPayload.ok !== false,
      answer: normalizeText(objectPayload.answer || ""),
      sources: normalizeUserResponseList(objectPayload.sources),
      limitations: normalizeUserResponseList(objectPayload.limitations),
    };
  }

  return {
    ok: objectPayload.ok !== false,
    answer: normalizeText(objectPayload.message || "") || "這次沒有拿到可以直接交付的結果。",
    sources: [],
    limitations: normalizeUserResponseList([
      "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
    ]),
  };
}

export function renderUserResponseText(response = {}) {
  const normalizedResponse = normalizeUserResponse({ payload: response });
  return renderPlannerUserFacingReplyText(normalizedResponse);
}
