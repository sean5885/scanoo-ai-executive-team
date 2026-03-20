import { classifyDocumentsLocally, classifyDocumentsSemantically } from "./lark-drive-semantic-classifier.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  getAccountPreference,
  listIndexedDocumentsForOrganization,
  setAccountPreference,
} from "./rag-repository.mjs";

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
const cloudOrganizationScopeSignals = ["雲文檔", "云文档", "雲文件", "云文件", "文檔", "文档", "文件", "drive", "wiki"];

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

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(cleanText(keyword).toLowerCase()));
}

function normalizedText(text = "") {
  return cleanText(String(text || "").toLowerCase());
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
  return Boolean(normalized) && hasAny(normalized, cloudOrganizationReReviewSignals);
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
  if (!(wantsCloudOrganization || wantsCloudOrganizationReview || wantsCloudOrganizationWhy || wantsCloudOrganizationPlainLanguage || inMode)) {
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

export async function buildCloudOrganizationPreviewReply({ accountId }) {
  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  if (!indexedDocs.length) {
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

  const candidates = indexedDocs.map((item) => ({
    id: item.id,
    title: item.title || item.document_id || item.file_token || item.node_id || "untitled",
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const classified = classifyDocumentsLocally(candidates);
  const buckets = new Map();

  for (const item of indexedDocs) {
    const result = classified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
    const bucket = buckets.get(result.category) || {
      category: result.category,
      role: categoryRoleMap[result.category] || "待人工確認",
      count: 0,
      examples: [],
    };
    bucket.count += 1;
    if (bucket.examples.length < 3) {
      bucket.examples.push(item.title || item.document_id || item.file_token || item.node_id || "untitled");
    }
    buckets.set(result.category, bucket);
  }

  const topBuckets = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return {
    text: [
      "結論",
      `我已先按本地已索引的 ${indexedDocs.length} 份雲文檔做分類預覽，並給出建議負責角色。`,
      "",
      "重點",
      ...topBuckets.map(
        (bucket) => `- ${bucket.category} -> ${bucket.role}｜${bucket.count} 份｜例如：${bucket.examples.join("、")}`,
      ),
      "",
      "下一步",
      "- 你現在可以直接接著說：哪些文檔跟某個角色無關、要怎麼重新分配、或要先看哪一類。",
      "- 如果要換話題，直接說「退出分類模式」即可。",
    ].join("\n"),
  };
}

export async function buildCloudOrganizationReviewReply({ accountId, sessionKey = "", forceReReview = false } = {}) {
  const cached = !forceReReview ? readCloudOrganizationReviewCache(accountId, sessionKey) : null;
  if (cached?.text) {
    return {
      text: cached.text,
    };
  }

  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  if (!indexedDocs.length) {
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

  const candidates = indexedDocs.map((item) => ({
    id: item.id,
    title: item.title || item.document_id || item.file_token || item.node_id || "untitled",
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const localClassified = classifyDocumentsLocally(candidates);
  const reviewSeed = indexedDocs
    .map((item) => {
      const local = localClassified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
      return { item, local };
    })
    .filter(({ local, item }) => {
      const hasSparseContent = !cleanText(item.raw_text).slice(0, 80);
      return local.confidence < 0.5 || cloudOrganizationReviewCategories.has(local.category) || hasSparseContent;
    })
    .slice(0, 24);

  if (!forceReReview) {
    const unresolved = reviewSeed.map(({ item, local }) => {
      const title = item.title || item.document_id || item.file_token || item.node_id || "untitled";
      const finalRole = categoryRoleMap[local.category] || "待人工確認";
      const reasons = [];
      if (!cleanText(item.raw_text).slice(0, 80)) {
        reasons.push("可讀內容太少，只靠標題還不夠判斷");
      }
      if (cloudOrganizationReviewCategories.has(local.category)) {
        reasons.push(`目前先放在「${finalRole}」，因為它看起來像通用文件而不是單一角色專屬文件`);
      }
      if (local.confidence < 0.55) {
        reasons.push("目前分類把握不高，直接分配很容易分錯");
      }
      if (/manual|workspace|member|administrator/i.test(cleanText(title))) {
        reasons.push("標題像操作手冊或通用教學，可能會同時服務多個角色");
      }
      return `${title}：目前暫放「${finalRole}」。${reasons[0] || "這份文件仍需要你再確認一次。"}`
    });

    return {
      text: [
        "結論",
        `我先用目前已索引的 ${indexedDocs.length} 份雲文檔，整理出最需要你二次確認的 ${reviewSeed.length} 份模糊文件。`,
        "",
        "重點",
        "- 這一輪先用本地分類結果快速整理，避免你每次追問都重新等一輪語義複審。",
        `- 目前最值得你先確認的：${Math.min(unresolved.length, 8)} 份`,
        ...unresolved.slice(0, 8).map((line) => `- ${line}`),
        "",
        "下一步",
        "- 如果你要我真的重新複審並改派，直接說「重新分配這批待確認文件」或指定某個角色，我就會再跑第二輪語義複審。",
      ].join("\n"),
    };
  }

  let semanticClassified = new Map();
  if (reviewSeed.length) {
    try {
      semanticClassified = await classifyDocumentsSemantically(
        reviewSeed.map(({ item }) => ({
          id: item.id,
          title: item.title || item.document_id || item.file_token || item.node_id || "untitled",
          type: item.source_type || "docx",
          parent_path: item.parent_path || "/",
          text: item.raw_text || "",
          content_source: item.source_type || "docx",
        })),
      );
    } catch {
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

  function explainNeedsReview(item, result) {
    const reasons = [];
    const title = cleanText(item?.title);
    const rawText = cleanText(item?.raw_text);
    if (!rawText.slice(0, 80)) {
      reasons.push("這份文件可讀內容太少，只靠標題還不夠判斷");
    }
    if (cloudOrganizationReviewCategories.has(result.category)) {
      reasons.push(`目前先放在「${categoryRoleMap[result.category] || "待人工確認"}」，因為它像通用文件而不是明確部門文件`);
    }
    if (result.confidence < 0.55) {
      reasons.push("目前分類把握不高，容易分錯");
    }
    if (/manual|workspace|member|administrator/i.test(title)) {
      reasons.push("標題像操作手冊或通用教學，可能不只屬於單一角色");
    }
    return reasons[0] || "目前看起來不像單一角色專屬文件，所以先請你確認。";
  }

  for (const { item, local } of reviewSeed) {
    const semantic = semanticClassified.get(item.id);
    const finalResult = semantic || local;
    const finalRole = categoryRoleMap[finalResult.category] || "待人工確認";
    const localRole = categoryRoleMap[local.category] || "待人工確認";
    const title = item.title || item.document_id || item.file_token || item.node_id || "untitled";

    if (finalResult.category !== local.category) {
      reassignments.push(
        `${title}：原本先放在「${localRole}」，現在改成「${finalRole}」。${explainCategory(finalResult.category)}`,
      );
      continue;
    }

    if (cloudOrganizationReviewCategories.has(finalResult.category) || finalResult.confidence < 0.55) {
      unresolved.push(`${title}：目前暫放「${finalRole}」。${explainNeedsReview(item, finalResult)}`);
    }
  }

  return {
    text: [
      "結論",
      `我已進入第二輪角色審核，先從 ${indexedDocs.length} 份已索引文檔中挑出 ${reviewSeed.length} 份模糊或泛類文檔做複審。`,
      "",
      "重點",
      "- 審核方式：先本地分類，再對模糊文檔做 MiniMax 小批量語義複審。",
      `- 待重新分配：${reassignments.length} 份`,
      ...reassignments.slice(0, 8).map((line) => `- ${line}`),
      `- 待人工確認：${unresolved.length} 份`,
      ...unresolved.slice(0, 8).map((line) => `- ${line}`),
      "",
      "下一步",
      "- 你現在可以直接說哪些文檔要保留原分配、哪些要改派，或指定先只看某個角色的待重分配清單。",
    ].join("\n"),
  };
}

export async function buildCloudOrganizationReviewReplyCached({ accountId, sessionKey = "", forceReReview = false } = {}) {
  const reply = await buildCloudOrganizationReviewReply({
    accountId,
    sessionKey,
    forceReReview,
  });
  if (reply?.text && sessionKey) {
    writeCloudOrganizationReviewCache(accountId, sessionKey, {
      text: reply.text,
      force_rereview: Boolean(forceReReview),
    });
  }
  return reply;
}

export async function buildCloudOrganizationWhyReply({ accountId }) {
  const indexedDocs = listIndexedDocumentsForOrganization(accountId, 240);
  if (!indexedDocs.length) {
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

  const candidates = indexedDocs.map((item) => ({
    id: item.id,
    title: item.title || item.document_id || item.file_token || item.node_id || "untitled",
    type: item.source_type || "docx",
    parent_path: item.parent_path || "/",
    text: item.raw_text || "",
  }));
  const localClassified = classifyDocumentsLocally(candidates);
  const unresolved = indexedDocs
    .map((item) => {
      const local = localClassified.get(item.id) || { category: "其他", confidence: 0, reason: "unclassified" };
      const title = item.title || item.document_id || item.file_token || item.node_id || "untitled";
      const rawText = cleanText(item.raw_text);
      const reasons = [];
      if (!rawText.slice(0, 80)) {
        reasons.push("可讀內容太少，只靠標題還不夠判斷");
      }
      if (cloudOrganizationReviewCategories.has(local.category)) {
        reasons.push("內容比較像通用文件，不像單一角色專屬文件");
      }
      if (local.confidence < 0.55) {
        reasons.push("目前分類把握不高，直接分配很容易分錯");
      }
      if (/manual|workspace|member|administrator/i.test(title)) {
        reasons.push("標題像操作手冊或通用教學，可能會同時服務多個角色");
      }
      return {
        title,
        role: categoryRoleMap[local.category] || "待人工確認",
        reasons,
      };
    })
    .filter((item) => item.reasons.length > 0)
    .slice(0, 6);

  if (!unresolved.length) {
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

  return {
    text: [
      "結論",
      "這些文件不是完全不能分配，而是現在只靠標題或少量內容，還不能很有把握地判定它們只屬於單一角色，所以我先放進待人工確認。",
      "",
      "重點",
      ...unresolved.map((item) => `- ${item.title}：目前先放「${item.role}」，因為${item.reasons[0]}。`),
      "",
      "下一步",
      "- 你可以直接告訴我哪些文件其實是法務、營運、HR 或知識管理，我就能幫你做第二次重新分配。",
    ].join("\n"),
  };
}
