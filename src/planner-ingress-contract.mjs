import {
  cleanText,
  detectDocBoundaryIntent,
  normalizeMessageText,
} from "./message-intent-utils.mjs";

const KNOWLEDGE_KEYWORDS = [
  "知識",
  "知识",
  "查一下",
  "查詢",
  "查询",
  "搜尋",
  "搜索",
  "整理一下資料",
  "根據文件",
  "根据文件",
  "根據知識",
  "根据知识",
  "search",
  "answer",
  "wiki 空間",
  "drive",
];

const RUNTIME_INFO_KEYWORDS = [
  "runtime",
  "runtime status",
  "db path",
  "pid",
  "cwd",
  "service start",
  "service_start",
  "運行情況",
  "运行情况",
  "系統狀態",
  "系统状态",
  "運行資訊",
  "运行信息",
];

function hasAny(text, keywords = []) {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizePlannerIngressText(input = {}) {
  if (typeof input === "string") {
    return cleanText(String(input || "").toLowerCase());
  }
  return cleanText(normalizeMessageText(input).toLowerCase());
}

export function looksLikePlannerRuntimeInfoIntent(input = {}) {
  const text = normalizePlannerIngressText(input);
  if (!text) {
    return false;
  }
  return hasAny(text, RUNTIME_INFO_KEYWORDS);
}

export function resolvePlannerKnowledgeAssistantIngress(input = {}) {
  const text = normalizePlannerIngressText(input);
  if (!text) {
    return null;
  }

  const docBoundaryIntent = detectDocBoundaryIntent(text);
  if (docBoundaryIntent.wants_document_summary) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_document_summary_or_lookup",
      planner_ingress_surface: "document_summary",
    };
  }

  if (docBoundaryIntent.mentions_company_brain) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_company_brain_doc_boundary",
      planner_ingress_surface: "company_brain",
    };
  }

  if (looksLikePlannerRuntimeInfoIntent(text)) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_runtime_info",
      planner_ingress_surface: "runtime_info",
    };
  }

  if (hasAny(text, KNOWLEDGE_KEYWORDS)) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_search_answer_or_knowledge_lookup",
      planner_ingress_surface: "knowledge_lookup",
    };
  }

  return null;
}

export function looksLikePlannerIngressRequest(input = {}) {
  return Boolean(resolvePlannerKnowledgeAssistantIngress(input));
}
