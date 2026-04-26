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

const DELIVERY_KNOWLEDGE_THEME_PATTERN = /(交付|onboarding|導入|导入|\bsop\b)/i;
const DELIVERY_KNOWLEDGE_CUE_PATTERN = /(查(?:一下|詢|询)?|搜尋|搜索|找|整理|流程|步驟|步骤|在哪(?:裡|里)?|內容|内容|講給我聽|讲给我听|怎麼做|怎么做|寫了什麼|写了什么)/i;
const DEICTIC_DOC_REFERENCE_PATTERN = /(這份文件|这份文件|那份文件|這個文件|这个文件|那個文件|那个文件|這份|这份|那份|這個|这个|那個|那个)/i;
const DEICTIC_DOC_DETAIL_CUE_PATTERN = /(在講什麼|在讲什么|寫了什麼|写了什么|內容|内容|打開|打开|讀|读|看|看看|給我看|给我看)/i;

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

function looksLikePlannerDeliveryKnowledgeIntent(input = {}) {
  const text = normalizePlannerIngressText(input);
  if (!text) {
    return false;
  }
  return DELIVERY_KNOWLEDGE_THEME_PATTERN.test(text) && DELIVERY_KNOWLEDGE_CUE_PATTERN.test(text);
}

function looksLikePlannerDeicticDocDetailIntent(input = {}) {
  const text = normalizePlannerIngressText(input);
  if (!text) {
    return false;
  }
  return DEICTIC_DOC_REFERENCE_PATTERN.test(text) && DEICTIC_DOC_DETAIL_CUE_PATTERN.test(text);
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

  if (looksLikePlannerDeliveryKnowledgeIntent(text)) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_delivery_knowledge_lookup",
      planner_ingress_surface: "delivery_knowledge",
    };
  }

  if (looksLikePlannerDeicticDocDetailIntent(text)) {
    return {
      capability_lane: "knowledge-assistant",
      lane_label: "知識助手",
      lane_reason: "message_mentions_deictic_document_detail",
      planner_ingress_surface: "document_deictic_detail",
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
