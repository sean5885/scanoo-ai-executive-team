import { classifyDocumentsLocally, classifyDocumentsSemantically } from "./lark-drive-semantic-classifier.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { syncPlannerExternalPendingItems } from "./planner-task-lifecycle-v1.mjs";
import {
  getAccountPreference,
  listIndexedDocumentsForOrganization,
  setAccountPreference,
} from "./rag-repository.mjs";
import { sha256 } from "./text-utils.mjs";

const sessionWorkflowModePrefix = "session_workflow_mode:";
const sessionWorkflowReviewCachePrefix = "session_workflow_review_cache:";
const sessionWorkflowModeTtlMs = 90 * 60 * 1000;
const sessionWorkflowReviewCacheTtlMs = 30 * 60 * 1000;

export const CLOUD_DOC_ORGANIZATION_MODE = "cloud_doc_organization";
export const CLOUD_DOC_WORKFLOW = "cloud_doc";

const cloudOrganizationActionSignals = ["分類", "分类", "歸類", "归类", "指派", "分配", "分派"];
const cloudOrganizationExitSignals = ["退出分類模式", "退出分类模式", "先不要分類", "先不要分类", "換話題", "换话题"];
const cloudOrganizationReviewSignals = [
  "去學習",
  "去学习",
  "各個角色",
  "各个角色",
  "待人工確認",
  "待人工确认",
  "二次做確認",
  "二次做确认",
  "二次確認",
  "二次确认",
  "為什麼不能直接分配",
  "为什么不能直接分配",
  "為什麼不能直接分派",
  "为什么不能直接分派",
  "不是你的",
  "不是你的涉獵範圍",
  "不是你的涉猎范围",
  "跟你無關",
  "跟你无关",
  "無關文檔",
  "无关文档",
  "第二次分配",
  "第二次分派",
  "重新分配",
  "重新分派",
  "二次做确认",
  "還有什麼內容",
  "还有什么内容",
  "需要我二次",
  "需要我再次",
];
const cloudOrganizationWhySignals = [
  "為什麼不能直接分配",
  "为什么不能直接分配",
  "為什麼不能直接分派",
  "为什么不能直接分派",
  "為什麼不能",
  "为什么不能",
  "不能直接分配",
  "不能直接分派",
];
const cloudOrganizationReReviewSignals = [
  "去學習",
  "去学习",
  "各個角色",
  "各个角色",
  "不是你的",
  "不是你的涉獵範圍",
  "不是你的涉猎范围",
  "跟你無關",
  "跟你无关",
  "無關文檔",
  "无关文档",
  "第二次分配",
  "第二次分派",
  "重新分配",
  "重新分派",
  "重新審核",
  "重新审核",
  "再審核",
  "再审核",
];
const cloudOrganizationScopedExclusionSignals = [
  "摘出去",
  "摘出",
  "移出去",
  "移出",
  "剔出去",
  "剔出",
  "排除",
  "排出去",
];
const cloudOrganizationExclusionQualifierSignals = [
  "不是",
  "不屬於",
  "不属于",
  "非 ",
  "非scanoo",
  "以外",
  "之外",
  "無關",
  "无关",
];
const cloudOrganizationPlainLanguageSignals = [
  "看不懂",
  "沒在講人話",
  "没在讲人话",
  "講人話",
  "讲人话",
  "講白話",
  "讲白话",
  "白話一點",
  "白话一点",
  "說清楚",
  "说清楚",
];
const cloudOrganizationScopeSignals = [
  "雲端文檔",
  "云端文档",
  "雲端文件",
  "云端文件",
  "雲文檔",
  "云文档",
  "雲文件",
  "云文件",
  "文檔",
  "文档",
  "文件",
  "drive",
  "wiki",
];

const categoryRoleMap = {
  工程技術: "工程/技術負責人",
  產品需求: "產品經理",
  OKR與計畫: "管理層/PMO",
  財務報銷: "財務",
  市場業務: "市場/商務",
  人事行政: "HR/行政",
  法務合約: "法務",
  投資公司: "CEO/投資關係",
  文檔: "知識管理",
  表格: "營運",
  簡報: "專案負責人",
  附件: "原文件所有者",
  快捷方式: "知識管理",
  腦圖: "專案負責人",
  其他: "待人工確認",
};

const cloudOrganizationReviewCategories = new Set(["其他", "文檔", "表格", "附件", "快捷方式", "腦圖"]);
const cloudOrganizationPendingItemStatuses = new Set(["待人工確認", "待重新分配", "待覆核"]);
const cloudOrganizationOrdinalLabels = ["第一個", "第二個", "第三個", "第四個", "第五個", "第六個", "第七個", "第八個", "第九個", "第十個"];
const cloudOrganizationTestResidualTitlePattern = /(?:\b(?:demo|verify|retry)\b|verify_failed)/iu;
const cloudOrganizationScopedSubjectPatterns = [
  /不屬於\s*([^，。,.、；;：:\n]+?)(?:的(?:內容|内容|文檔|文档|文件|集合|範圍|范围|主題|主题)|\s|$)/iu,
  /不是\s*([^，。,.、；;：:\n]+?)(?:的(?:內容|内容|文檔|文档|文件|集合|範圍|范围|主題|主题)|\s|$)/iu,
  /非\s*([^，。,.、；;：:\n]+?)(?:的(?:內容|内容|文檔|文档|文件|集合|範圍|范围|主題|主题)|\s*(?:內容|内容|文檔|文档|文件|集合|範圍|范围|主題|主题)|\s|$)/iu,
  /跟\s*([^，。,.、；;：:\n]+?)\s*(?:無關|无关)/iu,
  /([^，。,.、；;：:\n]+?)\s*(?:之外|以外)/iu,
];

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(cleanText(keyword).toLowerCase()));
}

function normalizedText(text = "") {
  return cleanText(String(text || "").toLowerCase());
}

function isAbortLikeError(error) {
  const code = cleanText(error?.code || "");
  const name = cleanText(error?.name || "");
  const message = cleanText(error?.message || "");
  return code === "abort_err"
    || code === "request_cancelled"
    || name === "aborterror"
    || message === "request_cancelled";
}

function normalizeCloudOrganizationScopedSubject(value = "") {
  return cleanText(String(value || ""))
    .replace(/^(?:跟|与|與|和)\s*/u, "")
    .replace(/\s*(?:的)?(?:內容|内容|文檔|文档|文件|集合|範圍|范围|主題|主题)\s*$/iu, "")
    .replace(/[，。,.、；;：:]+$/u, "")
    .trim();
}

function getCloudOrganizationItemMeta(item = {}) {
  const rawMeta = item?.meta_json;
  if (!rawMeta) {
    return {};
  }
  if (typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    return rawMeta;
  }
  if (typeof rawMeta !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(rawMeta);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getCloudOrganizationSourceMeta(item = {}) {
  const rawMeta = item?.source_meta_json;
  if (!rawMeta) {
    return {};
  }
  if (typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    return rawMeta;
  }
  if (typeof rawMeta !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(rawMeta);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getCloudOrganizationNamedField(item = {}, fieldName = "") {
  const meta = getCloudOrganizationItemMeta(item);
  return cleanText(item?.[fieldName]) || cleanText(meta?.[fieldName]);
}

function getCloudOrganizationSourceNamedField(item = {}, fieldName = "") {
  const meta = getCloudOrganizationSourceMeta(item);
  if (fieldName === "title") {
    return cleanText(item?.source_title) || cleanText(meta?.title);
  }
  return cleanText(item?.[`source_${fieldName}`]) || cleanText(meta?.[fieldName]);
}

function getCloudOrganizationDocumentTitle(item = {}) {
  return [
    getCloudOrganizationSourceNamedField(item, "title"),
    getCloudOrganizationSourceNamedField(item, "node_title"),
    getCloudOrganizationSourceNamedField(item, "document_title"),
    getCloudOrganizationSourceNamedField(item, "file_name"),
    getCloudOrganizationSourceNamedField(item, "name"),
    getCloudOrganizationNamedField(item, "title"),
    getCloudOrganizationNamedField(item, "node_title"),
    getCloudOrganizationNamedField(item, "document_title"),
    getCloudOrganizationNamedField(item, "file_name"),
    getCloudOrganizationNamedField(item, "name"),
    cleanText(item?.document_id),
    cleanText(item?.file_token),
    cleanText(item?.node_id),
  ].find(Boolean) || "untitled";
}

export function isCloudOrganizationTestResidualTitle(title = "") {
  return cloudOrganizationTestResidualTitlePattern.test(cleanText(title));
}

function isCloudOrganizationTestResidualItem(item = {}) {
  return isCloudOrganizationTestResidualTitle(getCloudOrganizationDocumentTitle(item));
}

function splitCloudOrganizationIndexedDocs(items = []) {
  return (Array.isArray(items) ? items : []).reduce((state, item) => {
    if (isCloudOrganizationTestResidualItem(item)) {
      state.testResidualDocs.push(item);
      return state;
    }
    state.businessDocs.push(item);
    return state;
  }, {
    businessDocs: [],
    testResidualDocs: [],
  });
}

function buildCloudOrganizationTestResidualSummaryLine(testResidualDocs = []) {
  const count = Array.isArray(testResidualDocs) ? testResidualDocs.length : 0;
  if (!count) {
    return "";
  }
  return `- 已自動忽略 ${count} 份測試殘留文件（名稱含 Demo / Verify / Retry / verify_failed），不納入待人工確認。`;
}

function hasCloudOrganizationTestResidualPendingItems(items = []) {
  return (Array.isArray(items) ? items : []).some((item) =>
    isCloudOrganizationTestResidualTitle(`${cleanText(item?.label)} ${cleanText(item?.text_line)}`));
}

function summarizeCloudOrganizationReasons(reasons = [], fallback = "") {
  const unique = [];
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    const normalized = cleanText(reason);
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }
  return unique.slice(0, 2).join("；") || fallback;
}

function collectCloudOrganizationReviewReasons(item = {}, result = {}) {
  const reasons = [];
  const title = cleanText(item?.title);
  const rawText = cleanText(item?.raw_text);

  if (!rawText.slice(0, 80)) {
    reasons.push("可讀內容太少，只靠標題還不夠判斷");
  }
  if (cloudOrganizationReviewCategories.has(result.category)) {
    reasons.push(`目前先放在「${categoryRoleMap[result.category] || "待人工確認"}」，因為它比較像通用文件而不是明確部門文件`);
  }
  if (result.confidence < 0.55) {
    reasons.push("目前分類把握不高，直接分配很容易分錯");
  }
  if (/manual|workspace|member|administrator/i.test(title)) {
    reasons.push("標題像操作手冊或通用教學，可能不只屬於單一角色");
  }

  return reasons;
}

function buildCloudOrganizationPendingReason({
  reason = "",
  stagingRole = "",
  originalRole = "",
  suggestedRole = "",
} = {}) {
  const parts = [];
  if (originalRole && suggestedRole) {
    parts.push(`建議從「${originalRole}」改派到「${suggestedRole}」`);
  } else if (stagingRole) {
    parts.push(`目前先暫放「${stagingRole}」`);
  }
  if (reason) {
    parts.push(reason);
  }
  return parts.join("；") || "目前還需要你再確認一次。";
}

function formatCloudOrganizationPendingItemText({
  item = {},
  status = "",
  reason = "",
  stagingRole = "",
  originalRole = "",
  suggestedRole = "",
} = {}) {
  const resolvedStatus = cleanText(status) || "待人工確認";
  const title = getCloudOrganizationDocumentTitle(item);
  const shortReason = buildCloudOrganizationPendingReason({
    reason,
    stagingRole,
    originalRole,
    suggestedRole,
  });

  return [
    `文件名：${title}`,
    cloudOrganizationPendingItemStatuses.has(resolvedStatus) ? `狀態：${resolvedStatus}` : `狀態：待人工確認`,
    `原因：${shortReason}`,
  ].join("\n");
}

export function buildCloudDocPendingActionScopeKey(scopeKey = "") {
  const normalizedScopeKey = cleanText(scopeKey);
  return normalizedScopeKey ? `cloud_doc_pending:${normalizedScopeKey}` : "";
}

function buildCloudOrganizationPendingItemId(item = {}) {
  const seed = [
    cleanText(item?.document_id),
    cleanText(item?.file_token),
    cleanText(item?.node_id),
    getCloudOrganizationDocumentTitle(item),
  ].filter(Boolean).join("::");
  return seed ? `cloud_doc_pending_${sha256(seed).slice(0, 16)}` : null;
}

function compareCloudOrganizationPendingItems(left = {}, right = {}) {
  const leftTitle = getCloudOrganizationDocumentTitle(left?.item || left).toLowerCase();
  const rightTitle = getCloudOrganizationDocumentTitle(right?.item || right).toLowerCase();
  return leftTitle.localeCompare(rightTitle)
    || cleanText(left?.document_id || left?.metadata?.document_id || "").localeCompare(
      cleanText(right?.document_id || right?.metadata?.document_id || ""),
    );
}

function buildCloudOrganizationPendingItemAction(item = {}) {
  return {
    type: "mark_resolved",
    label: "標記完成",
    metadata: {
      action: "mark_resolved",
      document_id: cleanText(item?.document_id) || null,
      file_token: cleanText(item?.file_token) || null,
    },
  };
}

function formatCloudOrganizationPendingItem({
  item = {},
  status = "",
  reason = "",
  stagingRole = "",
  originalRole = "",
  suggestedRole = "",
} = {}) {
  const resolvedStatus = cleanText(status) || "待人工確認";
  const title = getCloudOrganizationDocumentTitle(item);
  return {
    type: "cloud_doc_pending_item",
    item_id: buildCloudOrganizationPendingItemId(item),
    label: `${resolvedStatus}：${title}`,
    status: "pending",
    text_line: formatCloudOrganizationPendingItemText({
      item,
      status,
      reason,
      stagingRole,
      originalRole,
      suggestedRole,
    }),
    action_line: "操作：標記完成",
    actions: [buildCloudOrganizationPendingItemAction(item)],
    metadata: {
      action: "mark_resolved",
      document_id: cleanText(item?.document_id) || null,
      file_token: cleanText(item?.file_token) || null,
    },
  };
}

function renderCloudOrganizationPendingItems(items = []) {
  const lines = [];
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const textLines = cleanText(item?.text_line)
      .split("\n")
      .map((line) => cleanText(line))
      .filter(Boolean);
    if (textLines.length) {
      lines.push(`${index + 1}. ${textLines[0]}`);
      for (const line of textLines.slice(1)) {
        lines.push(`   ${line}`);
      }
    }
    if (cleanText(item?.action_line)) {
      const ordinalLabel = cloudOrganizationOrdinalLabels[index] || `第${index + 1}個`;
      lines.push(`   操作：回覆「${ordinalLabel}標記完成」`);
    }
  }
  return lines;
}

function buildCloudOrganizationPendingReplyText({
  conclusion = "",
  summaryLines = [],
  pendingItems = [],
} = {}) {
  const normalizedSummaryLines = (Array.isArray(summaryLines) ? summaryLines : [])
    .map((line) => cleanText(line))
    .filter(Boolean);
  const pendingLines = renderCloudOrganizationPendingItems(pendingItems);

  return [
    "結論",
    cleanText(conclusion) || "我已整理出這批文件目前最需要你處理的項目。",
    "",
    "摘要",
    ...(normalizedSummaryLines.length ? normalizedSummaryLines : ["- 目前先列出這批待處理文件。"]),
    "",
    "待處理清單",
    ...(pendingLines.length ? pendingLines : ["- 目前沒有新的待處理項目。"]),
  ].join("\n");
}

async function syncCloudOrganizationPendingItems({
  sessionKey = "",
  sourceKind = "",
  sourceTitle = "",
  sourceSummary = "",
  sourceMatchReason = "",
  pendingItems = [],
} = {}) {
  const normalizedPendingItems = Array.isArray(pendingItems)
    ? pendingItems.filter((item) => cleanText(item?.item_id) && cleanText(item?.label))
    : [];
  if (!normalizedPendingItems.length) {
    return [];
  }

  const workflowScopeKey = buildCloudDocWorkflowScopeKey({ sessionKey });
  const pendingScopeKey = buildCloudDocPendingActionScopeKey(workflowScopeKey);
  if (!pendingScopeKey) {
    return normalizedPendingItems;
  }

  const snapshot = await syncPlannerExternalPendingItems({
    scopeKey: pendingScopeKey,
    theme: "cloud_doc",
    sourceKind,
    sourceTitle,
    sourceSummary,
    sourceMatchReason,
    items: normalizedPendingItems,
  });
  const visibleTaskIds = new Set(
    (Array.isArray(snapshot?.tasks) ? snapshot.tasks : [])
      .filter((task) => cleanText(task?.pending_item_status || "pending") !== "resolved")
      .map((task) => cleanText(task?.id))
      .filter(Boolean),
  );
  if (!visibleTaskIds.size) {
    return [];
  }
  return normalizedPendingItems.filter((item) => visibleTaskIds.has(cleanText(item?.item_id)));
}

function logCloudDocReplyTrace(logger, {
  workflowHit = CLOUD_DOC_WORKFLOW,
  replyBuilderName = "",
  finalTextSourceFunction = "",
  sessionKey = "",
  forceReReview = null,
  cacheHit = null,
} = {}) {
  if (!logger || typeof logger.info !== "function") {
    return;
  }
  logger.info("cloud_doc_reply_trace", {
    workflow_hit: cleanText(workflowHit) || CLOUD_DOC_WORKFLOW,
    reply_builder_name: cleanText(replyBuilderName) || null,
    final_text_source_function: cleanText(finalTextSourceFunction) || null,
    session_key: cleanText(sessionKey) || null,
    force_rereview: typeof forceReReview === "boolean" ? forceReReview : null,
    cache_hit: typeof cacheHit === "boolean" ? cacheHit : null,
  });
}

export function looksLikeCloudOrganizationRequest(text = "") {
  const normalized = normalizedText(text);
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationActionSignals) && hasAny(normalized, cloudOrganizationScopeSignals);
}

export function looksLikeCloudOrganizationExit(text = "") {
  const normalized = normalizedText(text);
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationExitSignals);
}

export function looksLikeCloudOrganizationReviewRequest(text = "") {
  const normalized = normalizedText(text);
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationReviewSignals);
}

export function looksLikeCloudOrganizationWhyRequest(text = "") {
  const normalized = normalizedText(text);
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationWhySignals);
}

export function looksLikeCloudOrganizationReReviewRequest(text = "") {
  const normalized = normalizedText(text);
  const scopedExclusionRequest = Boolean(normalized)
    && hasAny(normalized, cloudOrganizationScopeSignals)
    && hasAny(normalized, cloudOrganizationScopedExclusionSignals)
    && hasAny(normalized, cloudOrganizationExclusionQualifierSignals);
  return Boolean(normalized) && (
    hasAny(normalized, cloudOrganizationReReviewSignals)
    || scopedExclusionRequest
  );
}

export function extractCloudOrganizationScopedSubject(text = "") {
  const rawText = cleanText(String(text || ""));
  if (!rawText || !looksLikeCloudOrganizationReReviewRequest(rawText)) {
    return "";
  }

  for (const pattern of cloudOrganizationScopedSubjectPatterns) {
    const match = rawText.match(pattern);
    const subject = normalizeCloudOrganizationScopedSubject(match?.[1] || "");
    if (subject) {
      return subject;
    }
  }

  return "";
}

export function looksLikeCloudOrganizationPlainLanguageRequest(text = "") {
  const normalized = normalizedText(text);
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationPlainLanguageSignals);
}

function getSessionWorkflowModePrefKey(sessionKey = "") {
  const normalized = cleanText(sessionKey);
  return normalized ? `${sessionWorkflowModePrefix}${normalized}` : "";
}

function getSessionWorkflowReviewCachePrefKey(sessionKey = "") {
  const normalized = cleanText(sessionKey);
  return normalized ? `${sessionWorkflowReviewCachePrefix}${normalized}` : "";
}

export function readSessionWorkflowMode(accountId, sessionKey = "") {
  const prefKey = getSessionWorkflowModePrefKey(sessionKey);
  if (!accountId || !prefKey) {
    return null;
  }
  const raw = getAccountPreference(accountId, prefKey);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const mode = cleanText(parsed?.mode);
    const updatedAtMs = Number(parsed?.updated_at_ms || 0);
    if (!mode || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
      return null;
    }
    if (Date.now() - updatedAtMs > sessionWorkflowModeTtlMs) {
      setAccountPreference(accountId, prefKey, null);
      return null;
    }
    return mode;
  } catch {
    return null;
  }
}

export function writeSessionWorkflowMode(accountId, sessionKey = "", mode = "") {
  const prefKey = getSessionWorkflowModePrefKey(sessionKey);
  if (!accountId || !prefKey) {
    return null;
  }
  if (!mode) {
    return setAccountPreference(accountId, prefKey, null);
  }
  return setAccountPreference(
    accountId,
    prefKey,
    JSON.stringify({
      mode,
      updated_at_ms: Date.now(),
    }),
  );
}

export function resolveCloudOrganizationAction({ text = "", activeWorkflowMode = null } = {}) {
  const wantsCloudOrganization = looksLikeCloudOrganizationRequest(text);
  const wantsCloudOrganizationReview = looksLikeCloudOrganizationReviewRequest(text);
  const wantsCloudOrganizationWhy = looksLikeCloudOrganizationWhyRequest(text);
  const wantsCloudOrganizationReReview = looksLikeCloudOrganizationReReviewRequest(text);
  const wantsCloudOrganizationPlainLanguage = looksLikeCloudOrganizationPlainLanguageRequest(text);
  const wantsExitCloudOrganization = looksLikeCloudOrganizationExit(text);
  const inMode = activeWorkflowMode === CLOUD_DOC_ORGANIZATION_MODE;

  if (wantsExitCloudOrganization && inMode) {
    return "exit";
  }
  if (!(wantsCloudOrganization || wantsCloudOrganizationReview || wantsCloudOrganizationWhy || wantsCloudOrganizationReReview || wantsCloudOrganizationPlainLanguage || inMode)) {
    return "none";
  }
  if (wantsCloudOrganizationWhy) {
    return "why";
  }
  if (wantsCloudOrganizationReReview) {
    return "rereview";
  }
  if (wantsCloudOrganizationReview || wantsCloudOrganizationPlainLanguage || (inMode && !wantsCloudOrganization)) {
    return "review";
  }
  return "preview";
}

export function buildCloudDocWorkflowScopeKey({
  sessionKey = "",
  folderToken = "",
  spaceId = "",
  parentNodeToken = "",
  spaceName = "",
} = {}) {
  if (cleanText(folderToken)) {
    return `drive:${cleanText(folderToken)}`;
  }
  if (cleanText(spaceId) || cleanText(parentNodeToken) || cleanText(spaceName)) {
    return `wiki:${cleanText(spaceId) || cleanText(parentNodeToken) || cleanText(spaceName)}`;
  }
  if (cleanText(sessionKey)) {
    return `chat:${cleanText(sessionKey)}`;
  }
  return "";
}

export function matchesCloudDocWorkflowScope(task = null, scopeKey = "") {
  if (!task?.id || cleanText(task.workflow) !== CLOUD_DOC_WORKFLOW) {
    return false;
  }
  return cleanText(task?.meta?.scope_key) === cleanText(scopeKey);
}

export function buildCloudDocStructuredResult({
  scopeKey = "",
  scopeType = "",
  preview = null,
  apply = null,
  mode = "preview",
} = {}) {
  const previewPlan = preview?.target_folders || preview?.moves
    ? {
        target_folders: Array.isArray(preview?.target_folders) ? preview.target_folders : [],
        moves: Array.isArray(preview?.moves) ? preview.moves : [],
      }
    : apply?.preview_plan && typeof apply.preview_plan === "object"
      ? {
          target_folders: Array.isArray(apply.preview_plan.target_folders) ? apply.preview_plan.target_folders : [],
          moves: Array.isArray(apply.preview_plan.moves) ? apply.preview_plan.moves : [],
        }
      : null;
  const applyMoves = Array.isArray(apply?.moves) ? apply.moves : [];
  return {
    scope_key: cleanText(scopeKey),
    scope_type: cleanText(scopeType),
    preview_plan: previewPlan,
    preview_result: preview || null,
    apply_result: apply || null,
    skipped_items: applyMoves.filter((item) => cleanText(item?.status) === "skipped"),
    conflict_items: [],
    preview_required: mode !== "apply",
  };
}

function readCloudOrganizationReviewCache(accountId, sessionKey = "") {
  const prefKey = getSessionWorkflowReviewCachePrefKey(sessionKey);
  if (!accountId || !prefKey) {
    return null;
  }
  const raw = getAccountPreference(accountId, prefKey);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.text || !parsed?.cached_at_ms) {
      return null;
    }
    const cachedAtMs = Number(parsed.cached_at_ms || 0);
    if (!Number.isFinite(cachedAtMs) || cachedAtMs <= 0) {
      return null;
    }
    if (Date.now() - cachedAtMs > sessionWorkflowReviewCacheTtlMs) {
      setAccountPreference(accountId, prefKey, null);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCloudOrganizationReviewCache(accountId, sessionKey = "", payload = null) {
  const prefKey = getSessionWorkflowReviewCachePrefKey(sessionKey);
  if (!accountId || !prefKey) {
    return null;
  }
  if (!payload) {
    return setAccountPreference(accountId, prefKey, null);
  }
  return setAccountPreference(
    accountId,
    prefKey,
    JSON.stringify({
      ...payload,
      cached_at_ms: Date.now(),
    }),
  );
}

export function clearCloudOrganizationReviewCache(accountId, sessionKey = "") {
  return writeCloudOrganizationReviewCache(accountId, sessionKey, null);
}

export async function buildCloudOrganizationPreviewReply({
  accountId,
  logger = null,
  replyBuilderName = "buildCloudOrganizationPreviewReply",
} = {}) {
  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  const { businessDocs, testResidualDocs } = splitCloudOrganizationIndexedDocs(indexedDocs);
  if (!indexedDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationPreviewReply",
    });
    return {
      text: [
        "結論",
        "我還沒有抓到可分類的已索引雲文檔。",
        "",
        "重點",
        "- 這條需求已正確識別成文檔分類/角色分配工作流。",
        "- 但目前本地索引裡沒有可用文檔內容，所以無法先做分類與角色建議。",
        "",
        "下一步",
        "- 先做一次同步，或直接指定要整理的 Drive 資料夾 / Wiki 空間，我就能幫你出分類預覽。",
      ].join("\n"),
    };
  }

  if (!businessDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationPreviewReply",
    });
    return {
      text: [
        "結論",
        `目前已索引的 ${indexedDocs.length} 份雲文檔都被判定為測試殘留，暫不納入正式分類預覽。`,
        "",
        "重點",
        buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
        "",
        "下一步",
        "- 如果你要，我可以直接把這批測試殘留移到垃圾桶，或等下一輪同步後再整理正式文件。",
      ].filter(Boolean).join("\n"),
    };
  }

  const candidates = businessDocs.map((item) => ({
    id: item.id,
    title: getCloudOrganizationDocumentTitle(item),
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const classified = classifyDocumentsLocally(candidates);
  const buckets = new Map();

  for (const item of businessDocs) {
    const result = classified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
    const bucket = buckets.get(result.category) || {
      category: result.category,
      role: categoryRoleMap[result.category] || "待人工確認",
      count: 0,
      examples: [],
    };
    bucket.count += 1;
    if (bucket.examples.length < 3) {
      bucket.examples.push(getCloudOrganizationDocumentTitle(item));
    }
    buckets.set(result.category, bucket);
  }

  const topBuckets = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  logCloudDocReplyTrace(logger, {
    replyBuilderName,
    finalTextSourceFunction: "buildCloudOrganizationPreviewReply",
  });
  return {
    text: [
      "結論",
      `我已先按本地已索引的 ${businessDocs.length} 份雲文檔做分類預覽，並給出建議負責角色。`,
      "",
      "重點",
      ...topBuckets.map(
        (bucket) => `- ${bucket.category} -> ${bucket.role}｜${bucket.count} 份｜例如：${bucket.examples.join("、")}`,
      ),
      buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
      "",
      "下一步",
      "- 你現在可以直接接著說：哪些文檔跟某個角色無關、要怎麼重新分配、或要先看哪一類。",
      "- 如果要換話題，直接說「退出分類模式」即可。",
    ].join("\n"),
  };
}

export async function buildCloudOrganizationReviewReply({
  accountId,
  sessionKey = "",
  forceReReview = false,
  logger = null,
  signal = null,
  replyBuilderName = "buildCloudOrganizationReviewReply",
} = {}) {
  const cached = !forceReReview ? readCloudOrganizationReviewCache(accountId, sessionKey) : null;
  const cachedPendingItems = Array.isArray(cached?.pending_items) ? cached.pending_items : [];
  const shouldBypassCache = hasCloudOrganizationTestResidualPendingItems(cachedPendingItems);
  if (cached?.text && !shouldBypassCache) {
    const cachedPendingItems = await syncCloudOrganizationPendingItems({
      sessionKey,
      sourceKind: forceReReview ? "cloud_doc_rereview" : "cloud_doc_review",
      sourceTitle: forceReReview ? "Cloud Doc Rereview" : "Cloud Doc Review",
      sourceSummary: cached.text,
      sourceMatchReason: forceReReview ? "重新複審待人工確認文件" : "待人工確認文件",
      pendingItems: cachedPendingItems,
    });
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "readCloudOrganizationReviewCache",
      sessionKey,
      forceReReview,
      cacheHit: true,
    });
    return {
      text: cached.text,
      pending_items: cachedPendingItems,
    };
  }

  if (cached?.text && shouldBypassCache) {
    clearCloudOrganizationReviewCache(accountId, sessionKey);
  }

  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  const { businessDocs, testResidualDocs } = splitCloudOrganizationIndexedDocs(indexedDocs);
  if (!indexedDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationReviewReply",
      sessionKey,
      forceReReview,
      cacheHit: false,
    });
    return {
      text: [
        "結論",
        "目前沒有可做第二輪角色審核的已索引文檔。",
        "",
        "下一步",
        "- 先做同步，之後我再幫你跑第二輪「待重新分配 / 待人工確認」審核。",
      ].join("\n"),
    };
  }

  if (!businessDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationReviewReply",
      sessionKey,
      forceReReview,
      cacheHit: false,
    });
    return {
      text: [
        "結論",
        `目前已索引的 ${indexedDocs.length} 份文檔都已判定為測試殘留，不再進入待人工確認。`,
        "",
        "摘要",
        buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
        "",
        "待處理清單",
        "- 目前沒有新的待人工確認項目。",
      ].filter(Boolean).join("\n"),
      pending_items: [],
    };
  }

  const candidates = businessDocs.map((item) => ({
    id: item.id,
    title: getCloudOrganizationDocumentTitle(item),
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const localClassified = classifyDocumentsLocally(candidates);
  const reviewSeed = businessDocs
    .map((item) => {
      const local = localClassified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
      return { item, local };
    })
    .filter(({ local, item }) => {
      const hasSparseContent = !cleanText(item.raw_text).slice(0, 80);
      return local.confidence < 0.5 || cloudOrganizationReviewCategories.has(local.category) || hasSparseContent;
    })
    .sort(compareCloudOrganizationPendingItems)
    .slice(0, 24);

  if (!forceReReview) {
    const unresolved = reviewSeed.map(({ item, local }) => {
      const finalRole = categoryRoleMap[local.category] || "待人工確認";
      return formatCloudOrganizationPendingItem({
        item,
        status: "待人工確認",
        stagingRole: finalRole,
        reason: summarizeCloudOrganizationReasons(
          collectCloudOrganizationReviewReasons(item, local),
          "這份文件仍需要你再確認一次。",
        ),
      });
    });
    const visibleUnresolved = await syncCloudOrganizationPendingItems({
      sessionKey,
      sourceKind: "cloud_doc_review",
      sourceTitle: "Cloud Doc Review",
      sourceSummary: `待人工確認：${unresolved.length} 份`,
      sourceMatchReason: "待人工確認文件",
      pendingItems: unresolved,
    });

    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationReviewReply",
      sessionKey,
      forceReReview,
      cacheHit: false,
    });
    return {
      text: buildCloudOrganizationPendingReplyText({
        conclusion: `我先用目前已索引的 ${businessDocs.length} 份雲文檔，整理出最需要你二次確認的 ${reviewSeed.length} 份模糊文件。`,
        summaryLines: [
          "- 這一輪先用本地分類結果快速整理，避免你每次追問都重新等一輪語義複審。",
          `- 待人工確認：${visibleUnresolved.length} 份`,
          buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
        ],
        pendingItems: visibleUnresolved,
      }),
      pending_items: visibleUnresolved,
    };
  }

  let semanticClassified = new Map();
  if (reviewSeed.length) {
    try {
      semanticClassified = await classifyDocumentsSemantically(
        reviewSeed.map(({ item }) => ({
          id: item.id,
          title: getCloudOrganizationDocumentTitle(item),
          type: item.source_type || "docx",
          parent_path: item.parent_path || "/",
          text: item.raw_text || "",
          content_source: item.source_type || "docx",
        })),
        { signal },
      );
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) {
        throw error;
      }
      semanticClassified = new Map();
    }
  }

  const reassignments = [];
  const unresolved = [];

  function explainCategory(category = "") {
    const role = categoryRoleMap[category] || "待人工確認";
    if (category === "法務合約") {
      return "內容更像正式規範、合約或法律治理文件，較適合法務看。";
    }
    if (category === "知識管理" || category === "文檔" || category === "附件" || category === "快捷方式") {
      return "這份文件目前只知道像通用說明或知識文件，還不夠明確。";
    }
    if (category === "工程技術") {
      return "內容更像工程或技術操作資料，先交工程/技術負責人。";
    }
    if (category === "產品需求") {
      return "內容更像產品需求、規格或產品決策資料，先交產品角色。";
    }
    if (category === "OKR與計畫") {
      return "內容更像目標、規劃或追蹤資料，先交管理層/PMO。";
    }
    if (category === "市場業務") {
      return "內容更像市場、品牌或商務資料，先交市場/商務角色。";
    }
    if (category === "投資公司") {
      return "內容更像公司治理、董事會或投資關係資料，先交 CEO/投資關係。";
    }
    return `我目前先把它放在「${role}」，但還需要下一輪確認。`;
  }

  for (const { item, local } of reviewSeed) {
    const semantic = semanticClassified.get(item.id);
    const finalResult = semantic || local;
    const finalRole = categoryRoleMap[finalResult.category] || "待人工確認";
    const localRole = categoryRoleMap[local.category] || "待人工確認";

    if (finalResult.category !== local.category) {
      reassignments.push(
        formatCloudOrganizationPendingItem({
          item,
          status: "待重新分配",
          originalRole: localRole,
          suggestedRole: finalRole,
          reason: explainCategory(finalResult.category),
        }),
      );
      continue;
    }

    if (cloudOrganizationReviewCategories.has(finalResult.category) || finalResult.confidence < 0.55) {
      unresolved.push(
        formatCloudOrganizationPendingItem({
          item,
          status: "待人工確認",
          stagingRole: finalRole,
          reason: summarizeCloudOrganizationReasons(
            collectCloudOrganizationReviewReasons(item, finalResult),
            "目前看起來不像單一角色專屬文件，所以先請你確認。",
          ),
        }),
      );
    }
  }
  const syncedRereviewItems = await syncCloudOrganizationPendingItems({
    sessionKey,
    sourceKind: "cloud_doc_rereview",
    sourceTitle: "Cloud Doc Rereview",
    sourceSummary: `待重新分配：${reassignments.length} 份；待人工確認：${unresolved.length} 份`,
    sourceMatchReason: "待重新分配 / 待人工確認文件",
    pendingItems: [...reassignments, ...unresolved],
  });
  const visibleReassignments = syncedRereviewItems.filter((item) => cleanText(item?.text_line).includes("狀態：待重新分配"));
  const visibleUnresolved = syncedRereviewItems.filter((item) => cleanText(item?.text_line).includes("狀態：待人工確認"));

  logCloudDocReplyTrace(logger, {
    replyBuilderName,
    finalTextSourceFunction: "buildCloudOrganizationReviewReply",
    sessionKey,
    forceReReview,
    cacheHit: false,
  });
  return {
    text: buildCloudOrganizationPendingReplyText({
      conclusion: `我已進入第二輪角色審核，先從 ${businessDocs.length} 份已索引文檔中挑出 ${reviewSeed.length} 份模糊或泛類文檔做複審。`,
      summaryLines: [
        "- 審核方式：先本地分類，再對模糊文檔做 MiniMax 小批量語義複審。",
        `- 待重新分配：${visibleReassignments.length} 份`,
        `- 待人工確認：${visibleUnresolved.length} 份`,
        buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
      ],
      pendingItems: [
        ...visibleReassignments,
        ...visibleUnresolved,
      ],
    }),
    pending_items: [
      ...visibleReassignments,
      ...visibleUnresolved,
    ],
  };
}

export async function buildCloudOrganizationReviewReplyCached({
  accountId,
  sessionKey = "",
  forceReReview = false,
  logger = null,
  signal = null,
} = {}) {
  const reply = await buildCloudOrganizationReviewReply({
    accountId,
    sessionKey,
    forceReReview,
    logger,
    signal,
    replyBuilderName: "buildCloudOrganizationReviewReplyCached",
  });
  if (reply?.text && sessionKey) {
    writeCloudOrganizationReviewCache(accountId, sessionKey, {
      text: reply.text,
      force_rereview: Boolean(forceReReview),
      pending_items: Array.isArray(reply?.pending_items) ? reply.pending_items : [],
    });
  }
  return reply;
}

export async function buildCloudOrganizationWhyReply({
  accountId,
  sessionKey = "",
  logger = null,
  replyBuilderName = "buildCloudOrganizationWhyReply",
} = {}) {
  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  const { businessDocs, testResidualDocs } = splitCloudOrganizationIndexedDocs(indexedDocs);
  if (!indexedDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationWhyReply",
    });
    return {
      text: [
        "結論",
        "現在還沒有可解釋的待人工確認文檔，因為本地索引裡沒有抓到可用文檔。",
        "",
        "下一步",
        "- 先做同步，之後我再告訴你哪些文檔需要人工確認，以及原因。",
      ].join("\n"),
    };
  }

  if (!businessDocs.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationWhyReply",
    });
    return {
      text: [
        "結論",
        "目前沒有需要人工確認的正式文檔，因為已索引項目都被判定為測試殘留。",
        "",
        "重點",
        buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
        "",
        "下一步",
        "- 如果你要，我可以直接整理這批測試殘留的移除清單。",
      ].filter(Boolean).join("\n"),
      pending_items: [],
    };
  }

  const candidates = businessDocs.map((item) => ({
    id: item.id,
    title: getCloudOrganizationDocumentTitle(item),
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const localClassified = classifyDocumentsLocally(candidates);
  const unresolved = businessDocs
    .map((item) => {
      const local = localClassified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
      const reasons = collectCloudOrganizationReviewReasons(item, local);
      return {
        item,
        role: categoryRoleMap[local.category] || "待人工確認",
        reasons,
      };
    })
    .filter((item) => item.reasons.length > 0)
    .sort(compareCloudOrganizationPendingItems)
    .slice(0, 24);

  if (!unresolved.length) {
    logCloudDocReplyTrace(logger, {
      replyBuilderName,
      finalTextSourceFunction: "buildCloudOrganizationWhyReply",
    });
    return {
      text: [
        "結論",
        "這批文檔不是不能分配，而是目前沒有明顯需要人工確認的高風險項目。",
        "",
        "重點",
        "- 也就是說，現在大部分文檔都已經能先按目前角色分配處理。",
        "",
        "下一步",
        "- 如果你要，我可以直接列出目前最值得你手動確認的前 3 份文檔。",
      ].join("\n"),
    };
  }

  logCloudDocReplyTrace(logger, {
    replyBuilderName,
    finalTextSourceFunction: "buildCloudOrganizationWhyReply",
  });
  const visibleUnresolved = await syncCloudOrganizationPendingItems({
    sessionKey,
    sourceKind: "cloud_doc_why",
    sourceTitle: "Cloud Doc Why Review",
    sourceSummary: `待人工確認：${unresolved.length} 份`,
    sourceMatchReason: "待人工確認文件原因",
    pendingItems: unresolved.map((item) =>
      formatCloudOrganizationPendingItem({
        item: item.item,
        status: "待人工確認",
        stagingRole: item.role,
        reason: summarizeCloudOrganizationReasons(
          item.reasons,
          "目前看起來還不能很有把握地直接分配。",
        ),
      })),
  });

  return {
    text: buildCloudOrganizationPendingReplyText({
      conclusion: "這些文件不是完全不能分配，而是現在只靠標題或少量內容，還不能很有把握地判定它們只屬於單一角色，所以我先放進待人工確認。",
      summaryLines: [
        `- 待人工確認：${visibleUnresolved.length} 份`,
        buildCloudOrganizationTestResidualSummaryLine(testResidualDocs),
      ],
      pendingItems: visibleUnresolved,
    }),
    pending_items: visibleUnresolved,
  };
}
