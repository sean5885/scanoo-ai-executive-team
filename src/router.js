import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";

function buildRouteDecision({ action = "", preset = "", error = "" } = {}) {
  const normalizedAction = cleanText(action);
  const normalizedPreset = cleanText(preset);
  const normalizedError = cleanText(error);

  if (normalizedAction) {
    return { action: normalizedAction };
  }
  if (normalizedPreset) {
    return { preset: normalizedPreset };
  }
  return { error: normalizedError || ROUTING_NO_MATCH };
}

function getRouteTarget(routeDecision = null) {
  if (typeof routeDecision === "string") {
    return cleanText(routeDecision);
  }
  if (!routeDecision || typeof routeDecision !== "object" || Array.isArray(routeDecision)) {
    return "";
  }
  return cleanText(routeDecision.action || routeDecision.preset || "");
}

function route(q = "", { activeDoc = null, activeCandidates = [] } = {}) {
  const text = String(q || "");
  const wantsSearch = /找|搜尋|搜索|查|search/.test(text);
  const wantsOpenDetail = /打開|打开|讀|读|內容|内容|寫了什麼|写了什么/.test(text);

  if (/整理|解釋/.test(text)) return buildRouteDecision({ preset: "search_and_detail_doc" });
  if (wantsSearch) return "search_company_brain_docs";
  if (
    Array.isArray(activeCandidates)
    && activeCandidates.length > 0
    && /第(?:1|一|2|二|3|三|4|四|5|五)份|第(?:1|一|2|二|3|三|4|四|5|五)個|打開第(?:1|一|2|二|3|三|4|四|5|五)/.test(text)
  ) {
    return "get_company_brain_doc_detail";
  }
  if (/這份文件|那份文件|這個文件|這份|那份|這個/.test(text)) {
    return activeDoc?.doc_id
      ? buildRouteDecision({ action: "get_company_brain_doc_detail" })
      : buildRouteDecision({ preset: "search_and_detail_doc" });
  }
  if (/打開|讀|內容|寫了什麼/.test(text)) {
    return activeDoc?.doc_id
      ? buildRouteDecision({ action: "get_company_brain_doc_detail" })
      : buildRouteDecision({ preset: "search_and_detail_doc" });
  }
  return buildRouteDecision({ error: ROUTING_NO_MATCH });
}

export { getRouteTarget };
export { route };
export default { route };
