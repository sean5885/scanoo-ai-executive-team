import { cleanText } from "./message-intent-utils.mjs";

function normalizeActionList(items = []) {
  return Array.isArray(items)
    ? items.map((item) => cleanText(item)).filter(Boolean).slice(0, 5)
    : [];
}

function normalizeRiskList(items = []) {
  return Array.isArray(items)
    ? items.map((item) => cleanText(item)).filter(Boolean).slice(0, 5)
    : [];
}

function themeToDomainLabel(activeTheme = "") {
  const theme = cleanText(activeTheme).toLowerCase();
  if (theme === "okr") {
    return "OKR";
  }
  if (theme === "bd") {
    return "BD";
  }
  if (theme === "delivery") {
    return "交付";
  }
  return null;
}

function canExtractStructuredFields(formattedOutput = {}) {
  const kind = cleanText(formattedOutput?.kind);
  return kind === "detail" || kind === "search_and_detail";
}

function extractLabeledField(text = "", labels = []) {
  const normalizedText = String(text || "");
  if (!normalizedText || !Array.isArray(labels) || labels.length === 0) {
    return null;
  }

  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`${escapedLabel}\\s*[:：]\\s*([^;；。\\n]+)`, "i"),
      new RegExp(`${escapedLabel}\\s*是\\s*([^;；。\\n]+)`, "i"),
      new RegExp(`${escapedLabel}\\s*為\\s*([^;；。\\n]+)`, "i"),
    ];
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      const value = cleanText(match?.[1]);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractLabeledRisks(text = "") {
  const labeled = extractLabeledField(text, ["risks", "risk", "風險", "风险"]);
  if (!labeled) {
    return [];
  }
  return normalizeRiskList(String(labeled)
    .split(/[、,，;；]/)
    .map((item) => cleanText(item)));
}

function extractStructuredActionFields({
  formattedOutput = {},
} = {}) {
  if (!canExtractStructuredFields(formattedOutput)) {
    return {
      owner: null,
      deadline: null,
      status: null,
      risks: [],
    };
  }

  const contentSummary = cleanText(formattedOutput?.content_summary);
  const owner = extractLabeledField(contentSummary, ["owner", "負責人", "负责人"]);
  const deadline = extractLabeledField(contentSummary, ["deadline", "due", "截止", "到期"]);
  const status = extractLabeledField(contentSummary, ["status", "狀態", "状态"]);
  const risks = extractLabeledRisks(contentSummary);

  return {
    owner,
    deadline,
    status,
    risks,
  };
}

function buildActionSummary({
  domainLabel = "",
  formattedOutput = {},
} = {}) {
  const kind = cleanText(formattedOutput?.kind);
  const title = cleanText(formattedOutput?.title);
  const contentSummary = cleanText(formattedOutput?.content_summary);
  const items = Array.isArray(formattedOutput?.items) ? formattedOutput.items : [];
  const label = cleanText(domainLabel);

  if (contentSummary) {
    return contentSummary;
  }
  if (kind === "search" && items.length > 0) {
    const topTitles = items
      .slice(0, 3)
      .map((item) => cleanText(item?.title))
      .filter(Boolean)
      .join("、");
    return cleanText(`找到 ${items.length} 份${label || "相關"}文件：${topTitles}`) || null;
  }
  if (kind === "detail" || kind === "search_and_detail") {
    return cleanText(`${label || "相關"}文件重點：${title || "已命中文件"}`) || null;
  }
  if (kind === "search_and_detail_candidates") {
    return cleanText(`找到多份${label || "相關"}文件，需先指定要讀哪一份。`) || null;
  }
  if (kind === "search_and_detail_not_found") {
    return cleanText(`目前沒有找到${label || "相關"}文件。`) || null;
  }
  if (title) {
    return cleanText(`${label || "相關"}文件：${title}`) || null;
  }
  return null;
}

function normalizeStructuredStatus(status = "") {
  const normalized = cleanText(status).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["blocked", "block", "卡住", "阻塞"].some((keyword) => normalized.includes(keyword))) {
    return "blocked";
  }
  if (["in_progress", "進行中", "进行中", "started", "half_done", "handled"].some((keyword) => normalized.includes(keyword))) {
    return "in_progress";
  }
  if (["done", "completed", "完成", "已完成"].some((keyword) => normalized.includes(keyword))) {
    return "done";
  }
  return null;
}

function buildActionNextActions({
  domainLabel = "",
  formattedOutput = {},
  extractedFields = {},
} = {}) {
  const kind = cleanText(formattedOutput?.kind);
  const items = Array.isArray(formattedOutput?.items) ? formattedOutput.items : [];
  const label = cleanText(domainLabel) || "相關";

  if (kind === "search" && items.length > 0) {
    return normalizeActionList(items.slice(0, 3).map((item) => (
      `查看文件：${cleanText(item?.title) || cleanText(item?.doc_id) || "未命名文件"}`
    )));
  }
  if (kind === "detail" || kind === "search_and_detail") {
    const status = normalizeStructuredStatus(extractedFields?.status);
    return normalizeActionList([
      status === "blocked"
        ? `優先解除 ${label}卡點`
        : status === "in_progress"
          ? `推進 ${label}下一個可執行步驟`
          : status === "done"
            ? `確認 ${label}驗收與結果`
            : `確認 ${label}後續跟進事項`,
      "確認 owner",
      "確認 deadline",
    ]);
  }
  if (kind === "search_and_detail_candidates") {
    return normalizeActionList(items.slice(0, 3).map((item, index) => (
      `打開第${index + 1}份：${cleanText(item?.title) || cleanText(item?.doc_id) || "未命名文件"}`
    )));
  }
  if (kind === "search_and_detail_not_found") {
    return normalizeActionList([
      "換關鍵詞重新搜尋",
      `補充更具體的${label}上下文`,
    ]);
  }
  return [];
}

function buildActionRisks({
  formattedOutput = {},
} = {}) {
  const kind = cleanText(formattedOutput?.kind);
  if (kind === "search_and_detail_candidates") {
    return ["命中多份文件，尚未唯一確定。"];
  }
  if (kind === "search_and_detail_not_found") {
    return ["目前查無相關文件，可能是關鍵詞不足或資料未入庫。"];
  }
  return [];
}

export function buildPlannerActionLayer({
  domain = "",
  activeTheme = "",
  formattedOutput = {},
} = {}) {
  const effectiveDomain = cleanText(domain) || themeToDomainLabel(activeTheme) || "";
  const extracted = extractStructuredActionFields({
    formattedOutput,
  });
  const formattedRisks = buildActionRisks({
    formattedOutput,
  });
  return {
    summary: buildActionSummary({
      domainLabel: effectiveDomain,
      formattedOutput,
    }),
    next_actions: buildActionNextActions({
      domainLabel: effectiveDomain,
      formattedOutput,
      extractedFields: extracted,
    }),
    owner: extracted.owner,
    deadline: extracted.deadline,
    risks: normalizeRiskList([
      ...formattedRisks,
      ...extracted.risks,
    ]),
    status: extracted.status,
  };
}

export function attachPlannerActionLayer({
  executionResult = null,
  domain = "",
  activeTheme = "",
} = {}) {
  if (!executionResult || typeof executionResult !== "object") {
    return executionResult;
  }
  const formattedOutput = executionResult.formatted_output;
  if (!formattedOutput || typeof formattedOutput !== "object") {
    return executionResult;
  }

  return {
    ...executionResult,
    formatted_output: {
      ...formattedOutput,
      action_layer: buildPlannerActionLayer({
        domain,
        activeTheme,
        formattedOutput,
      }),
    },
  };
}
