import { generateDocumentCommentSuggestionCard } from "./comment-suggestion-workflow.mjs";
import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
  executePlannedUserInput,
  renderPlannerUserFacingReplyText,
} from "./executive-planner.mjs";
import {
  ensureMeetingWorkflowTask,
  executeExecutiveTurn,
  finalizeMeetingWorkflowTask,
  markMeetingWorkflowWritingBack,
} from "./executive-orchestrator.mjs";
import { analyzeImageTask, buildStructuredImageContext } from "./image-understanding-service.mjs";
import {
  createManagedDocument,
  deleteDriveItem,
  ensureDocumentManagerPermission,
  getBitableApp,
  getPrimaryCalendar,
  getDocument,
  getMessage,
  listBitableRecords,
  listBitableTables,
  listCalendarEvents,
  listMessages,
  listTasks,
  updateDocument,
} from "./lark-content.mjs";
import {
  extractBitableReference,
  buildMessageText,
  buildVisibleMessageText,
  cleanText,
  collectRelatedMessageIds,
  detectDocBoundaryIntent,
  extractDocumentId,
  normalizeMessageText,
} from "./message-intent-utils.mjs";
import { classifyInputModality } from "./modality-router.mjs";
import {
  getStoredAccountContext,
  getStoredAccountContextByOpenId,
  getTenantAccessToken,
  getValidUserToken,
} from "./lark-user-auth.mjs";
import { buildLaneIntroReply } from "./capability-lane.mjs";
import {
  CLOUD_DOC_ORGANIZATION_MODE,
  buildCloudOrganizationPreviewReply,
  buildCloudOrganizationReviewReplyCached,
  buildCloudOrganizationWhyReply,
  buildCloudDocWorkflowScopeKey,
  CLOUD_DOC_WORKFLOW,
  looksLikeCloudOrganizationExit,
  looksLikeCloudOrganizationPlainLanguageRequest,
  looksLikeCloudOrganizationReReviewRequest,
  matchesCloudDocWorkflowScope,
  looksLikeCloudOrganizationRequest,
  looksLikeCloudOrganizationReviewRequest,
  looksLikeCloudOrganizationWhyRequest,
  readSessionWorkflowMode,
  resolveCloudOrganizationAction,
  writeSessionWorkflowMode,
} from "./cloud-doc-organization-workflow.mjs";
import { ensureCloudDocWorkflowTask } from "./executive-orchestrator.mjs";
import { formatIdentifierHint } from "./runtime-observability.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { createMeetingCoordinator, parseMeetingCommand } from "./meeting-agent.mjs";
import {
  getMeetingAudioCaptureStatus,
  isMeetingAudioCaptureActive,
  resolveMeetingTranscribeProvider,
  startMeetingAudioCapture,
  stopMeetingAudioCapture,
  stopMeetingAudioCaptureByMetadata,
  transcribeMeetingAudio,
} from "./meeting-audio-capture.mjs";
import {
  appendMeetingCaptureEntry,
  attachMeetingCaptureAudio,
  attachMeetingCaptureDocument,
  buildMeetingCaptureTranscript,
  clearMeetingCaptureDocument,
  getActiveMeetingCaptureSession,
  getLatestMeetingCaptureSession,
  listMeetingCaptureEntries,
  startMeetingCaptureSession,
  stopMeetingCaptureSession,
} from "./meeting-capture-store.mjs";
import { meetingDocFolderToken, meetingTranscriptPromptMaxChars } from "./config.mjs";
import {
  getAccountPreference,
  setAccountPreference,
} from "./rag-repository.mjs";
import { getActiveExecutiveTask } from "./executive-task-state.mjs";

function incomingText(event) {
  return buildVisibleMessageText(event);
}

function truncate(value, limit = 90) {
  const text = cleanText(value).replace(/\s+/g, " ");
  if (!text) {
    return "(空)";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function previewStructuredValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return truncate(String(value), 42);
  }
  if (Array.isArray(value)) {
    const text = value
      .slice(0, 3)
      .map((item) => previewStructuredValue(item))
      .filter(Boolean)
      .join(", ");
    return truncate(text, 42);
  }
  try {
    return truncate(JSON.stringify(value), 42);
  } catch {
    return truncate(String(value), 42);
  }
}

function previewBitableRecords(items = []) {
  return items
    .slice(0, 3)
    .map((item, index) => {
      const entries = Object.entries(item?.fields || {})
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${previewStructuredValue(value)}`)
        .join("；");
      return `- ${index + 1}. ${entries || "(空記錄)"}`;
    })
    .join("\n");
}

export {
  looksLikeCloudOrganizationExit,
  looksLikeCloudOrganizationPlainLanguageRequest,
  looksLikeCloudOrganizationReReviewRequest,
  looksLikeCloudOrganizationRequest,
  looksLikeCloudOrganizationReviewRequest,
  looksLikeCloudOrganizationWhyRequest,
} from "./cloud-doc-organization-workflow.mjs";

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

const recentConversationSummarySignals = [
  "最近對話",
  "最近对话",
  "最近聊天",
  "最近訊息",
  "最近消息",
  "總結最近",
  "总结最近",
  "總結對話",
  "总结对话",
  "整理對話",
  "整理对话",
  "整理聊天",
];

function looksLikeExplicitDocOrKnowledgeRoutingRequest(text = "") {
  const normalized = cleanText(text);
  if (!normalized) {
    return false;
  }

  const cloudDocAction = resolveCloudOrganizationAction({ text: normalized });
  const docBoundaryIntent = detectDocBoundaryIntent(normalized);

  return docBoundaryIntent.is_high_confidence_doc_boundary || cloudDocAction !== "none";
}

function buildLaneTrace({
  scope,
  chosenAction = null,
  fallbackReason = null,
} = {}) {
  return {
    chosen_lane: cleanText(scope?.capability_lane || "personal-assistant") || "personal-assistant",
    chosen_action: cleanText(chosenAction) || null,
    fallback_reason: cleanText(fallbackReason) || null,
  };
}

function attachLaneTrace(envelope = {}, {
  scope,
  chosenAction = null,
  fallbackReason = null,
} = {}) {
  return {
    ...(envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : {}),
    trace: {
      ...(envelope?.trace && typeof envelope.trace === "object" && !Array.isArray(envelope.trace) ? envelope.trace : {}),
      ...buildLaneTrace({
        scope,
        chosenAction: chosenAction || envelope?.trace?.chosen_action,
        fallbackReason: fallbackReason || envelope?.trace?.fallback_reason,
      }),
    },
  };
}

function buildLaneStructuredErrorEnvelope({
  scope,
  error = "business_error",
  chosenAction = null,
  fallbackReason = "",
  details = {},
} = {}) {
  return attachLaneTrace({
    ok: false,
    error: cleanText(error) || "business_error",
    details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
  }, {
    scope,
    chosenAction,
    fallbackReason: cleanText(fallbackReason) || cleanText(error) || "business_error",
  });
}

function buildLaneRoutingNoMatchReply({ scope, lanePlan, message = "no_supported_lane_action" } = {}) {
  return {
    text: [
      "答案",
      "我這次沒有找到可以安全執行的對應操作，所以先不回 internal routing 錯誤。",
      "",
      "來源",
      "- 這次沒有對外提供可引用來源。",
      "",
      "待確認/限制",
      `- 目前 lane=${cleanText(scope?.capability_lane || "personal-assistant") || "personal-assistant"} 需要更明確的指令才能接續處理。`,
      "- 詳細 routing reason 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
    ].join("\n"),
  };
}

function buildLaneSemanticMismatchReply() {
  return {
    text: [
      "答案",
      "這則訊息比較像文件或知識庫請求，所以我先不在 personal lane 亂回。",
      "",
      "來源",
      "- 這次沒有對外提供可引用來源。",
      "",
      "待確認/限制",
      "- 請直接說要我找文件、打開某份文件，或整理某份文件重點，我會改走對應的知識/文件路徑。",
      "- internal semantic trace 仍保留在 runtime/log，不會直接暴露在回覆裡。",
    ].join("\n"),
  };
}

function buildLanePermissionDeniedReply() {
  return {
    text: [
      "答案",
      "要整理最近對話，我現在還需要你的 user OAuth 才能安全讀取個人對話內容。",
      "",
      "來源",
      "- 這次沒有對外提供可引用來源。",
      "",
      "待確認/限制",
      "- 目前不會把 internal permission error 或 trace 直接回給你。",
      "- 等 user OAuth 恢復後，我就能繼續整理最近對話。",
    ].join("\n"),
  };
}

export function resolveLaneExecutionPlan({ event, scope } = {}) {
  const lane = cleanText(scope?.capability_lane || "personal-assistant") || "personal-assistant";
  const text = normalizeMessageText(event);

  if (lane === "knowledge-assistant") {
    return buildLaneTrace({
      scope,
      chosenAction: "planner_user_input",
      fallbackReason: null,
    });
  }

  if (lane === "doc-editor") {
    return buildLaneTrace({
      scope,
      chosenAction: "doc_editor_workflow",
      fallbackReason: null,
    });
  }

  if (lane === "group-shared-assistant") {
    if (hasAny(text, ["回覆", "回复", "怎麼回", "怎么回"])) {
      return buildLaneTrace({
        scope,
        chosenAction: "draft_group_reply",
      });
    }
    if (hasAny(text, [...recentConversationSummarySignals, "總結", "总结", "整理"])) {
      return buildLaneTrace({
        scope,
        chosenAction: "summarize_recent_dialogue",
      });
    }
    return buildLaneTrace({
      scope,
      chosenAction: null,
      fallbackReason: ROUTING_NO_MATCH,
    });
  }

  if (hasAny(text, ["日程", "行程", "calendar", "會議", "会议"])) {
    return buildLaneTrace({
      scope,
      chosenAction: "calendar_summary",
    });
  }

  if (hasAny(text, ["任務", "task", "待辦", "todo"])) {
    return buildLaneTrace({
      scope,
      chosenAction: "tasks_summary",
    });
  }

  if (hasAny(text, recentConversationSummarySignals)) {
    return buildLaneTrace({
      scope,
      chosenAction: "summarize_recent_dialogue",
    });
  }

  if (
    looksLikeExplicitDocOrKnowledgeRoutingRequest(text)
  ) {
    return buildLaneTrace({
      scope,
      chosenAction: null,
      fallbackReason: "semantic_mismatch_document_request_in_personal_lane",
    });
  }

  return buildLaneTrace({
    scope,
    chosenAction: null,
    fallbackReason: ROUTING_NO_MATCH,
  });
}

const meetingCaptureStatusSignals = [
  "在持續記錄中嗎",
  "在持续记录中吗",
  "還在記錄嗎",
  "还在记录吗",
  "還有在記錄嗎",
  "还有在记录吗",
  "有在記錄嗎",
  "有在记录吗",
  "有在錄嗎",
  "有在录吗",
  "還在錄嗎",
  "还在录吗",
  "持續記錄中嗎",
  "持续记录中吗",
  "還在聽嗎",
  "还在听吗",
];

const deleteMeetingDocSignals = [
  "刪掉",
  "刪除",
  "删除",
  "直接刪掉",
  "直接删除",
  "把這個文檔刪掉",
  "把這個文档删掉",
  "把這個文件刪掉",
  "把这个文档删掉",
  "這個文檔可以直接刪掉",
  "这个文档可以直接删掉",
];

const chatOnlyFailureSignals = [
  "直接在對話裡寫給我",
  "直接在对话里写给我",
  "不用再建立新文檔",
  "不用再建立新文档",
  "不需要再建立新文檔",
  "不需要再建立新文档",
  "不要再建立新文檔",
  "不要再建立新文档",
  "不用建文檔",
  "不用建文档",
];

const meetingFailurePreferenceKey = "meeting_failure_report_mode";

export function shouldPreferActiveExecutiveTask({
  activeTask = null,
  lane = "",
  wantsCloudOrganizationFollowUp = false,
} = {}) {
  if (!activeTask?.id || activeTask?.status !== "active") {
    return false;
  }
  const workflow = cleanText(activeTask.workflow);
  if (workflow === "meeting") {
    return true;
  }
  if (workflow !== "executive") {
    return false;
  }
  if (wantsCloudOrganizationFollowUp && lane === "personal-assistant") {
    return true;
  }
  return true;
}

export function looksLikeMeetingCaptureStatusQuery(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && hasAny(normalized, meetingCaptureStatusSignals);
}

export function looksLikeDeleteMeetingDocRequest(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && hasAny(normalized, deleteMeetingDocSignals);
}

export function looksLikeChatOnlyFailurePreference(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && hasAny(normalized, chatOnlyFailureSignals);
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    if (!error) {
      return null;
    }
    if (error instanceof Error) {
      return { name: error.name || "Error", message: error.message || "unknown_error" };
    }
    return { message: typeof error === "string" ? error : String(error) };
  },
};

async function runLoggedStep(logger, event, fields, fn) {
  const startedAt = Date.now();
  logger.info(`${event}_started`, fields);
  try {
    const result = await fn();
    logger.info(`${event}_succeeded`, {
      ...fields,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.error(`${event}_failed`, {
      ...fields,
      duration_ms: Date.now() - startedAt,
      error: logger.compactError(error),
    });
    throw error;
  }
}

const meetingCoordinator = createMeetingCoordinator();

async function resolveReferencedDocumentId(event, accessToken, logger = noopLogger) {
  const directDocumentId = extractDocumentId(event);
  if (directDocumentId) {
    logger.info("doc_resolution_hit", {
      source: "current_message",
      document_id: formatIdentifierHint(directDocumentId),
    });
    return {
      documentId: directDocumentId,
      source: "current_message",
    };
  }

  for (const relatedMessageId of collectRelatedMessageIds(event)) {
    try {
      const related = await getMessage(accessToken, relatedMessageId);
      const relatedDocumentId = extractDocumentId({ message: related });
      if (relatedDocumentId) {
        logger.info("doc_resolution_hit", {
          source: "referenced_message",
          document_id: formatIdentifierHint(relatedDocumentId),
          referenced_message_id: formatIdentifierHint(relatedMessageId),
        });
        return {
          documentId: relatedDocumentId,
          source: "referenced_message",
          referencedMessageId: relatedMessageId,
        };
      }
    } catch {
      logger.warn("doc_resolution_related_message_failed", {
        referenced_message_id: formatIdentifierHint(relatedMessageId),
      });
      // Ignore one failed related-message lookup and continue.
    }
  }

  logger.warn("doc_resolution_miss", {
    related_message_count: collectRelatedMessageIds(event).length,
  });
  return {
    documentId: "",
    source: "none",
  };
}

function startOfDayUnix() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor(now.getTime() / 1000);
}

function endOfDayUnix() {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return Math.floor(now.getTime() / 1000);
}

async function resolveAuthContext(event, logger = noopLogger, { allowTenantFallback = false } = {}) {
  const senderOpenId = cleanText(event?.sender?.sender_id?.open_id);
  const scoped = senderOpenId ? await getStoredAccountContextByOpenId(senderOpenId) : null;
  const fallback = scoped || (await getStoredAccountContext());
  if (!fallback?.account?.id) {
    logger.warn("missing_auth_context", {
      sender_open_id: formatIdentifierHint(senderOpenId),
    });
    return null;
  }
  let token = null;
  let tokenKind = "user";
  try {
    token = await getValidUserToken(fallback.account.id);
  } catch (error) {
    logger.warn("user_token_refresh_failed", {
      account_id: formatIdentifierHint(fallback.account.id),
      error: logger.compactError(error),
    });
    if (!allowTenantFallback) {
      throw error;
    }
  }
  if (!token?.access_token) {
    if (!allowTenantFallback) {
      logger.warn("missing_valid_user_token", {
        account_id: formatIdentifierHint(fallback.account.id),
      });
      return null;
    }
    token = await getTenantAccessToken();
    tokenKind = "tenant";
    logger.info("tenant_token_fallback_enabled", {
      account_id: formatIdentifierHint(fallback.account.id),
    });
  }
  return {
    account: fallback.account,
    token,
    tokenKind,
  };
}

async function executeKnowledgeAssistant({ event, scope, logger = noopLogger }) {
  const lanePlan = resolveLaneExecutionPlan({ event, scope });
  logger.info("lane_execution_planned", lanePlan);
  const context = await resolveAuthContext(event, logger, { allowTenantFallback: true });
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = incomingText(event);
  if (!text) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const plannedResult = await executePlannedUserInput({
    text,
    logger,
    sessionKey: cleanText(scope?.session_key || scope?.chat_id || event?.message?.chat_id || ""),
  });
  const userFacingReply = buildPlannedUserInputUserFacingReply(plannedResult);
  if (userFacingReply) {
    logger.info("lane_execution_user_fallback", {
      chosen_action: cleanText(plannedResult?.action || plannedResult?.steps?.[0]?.action || "") || null,
      planner_error: cleanText(plannedResult?.error || plannedResult?.execution_result?.error || "") || null,
    });
    return {
      text: renderPlannerUserFacingReplyText(userFacingReply),
    };
  }

  const plannerEnvelope = attachLaneTrace(
    buildPlannedUserInputEnvelope(plannedResult),
    {
      scope,
    },
  );
  logger.info("lane_execution_result", plannerEnvelope.trace);
  return {
    text: JSON.stringify(plannerEnvelope, null, 2),
  };
}

async function executeBitableLinkRequest({ event, scope, logger = noopLogger }) {
  const bitableRef = extractBitableReference(event);
  if (!bitableRef?.app_token) {
    return null;
  }

  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  logger.info("bitable_resolution_hit", {
    app_token: formatIdentifierHint(bitableRef.app_token),
    table_id: formatIdentifierHint(bitableRef.table_id),
    source: "message_link",
  });

  const app = await getBitableApp(context.token, bitableRef.app_token);
  const tables = await listBitableTables(context.token, bitableRef.app_token, {
    pageSize: 20,
  });

  const targetTableId =
    bitableRef.table_id ||
    app.default_table_id ||
    (tables.items?.length === 1 ? tables.items[0].table_id : "");
  const targetTable = (tables.items || []).find((item) => item.table_id === targetTableId) || null;

  let records = null;
  if (targetTableId) {
    records = await listBitableRecords(context.token, bitableRef.app_token, targetTableId, {
      pageSize: 5,
      viewId: bitableRef.view_id || undefined,
    });
  }

  const tablePreview =
    (tables.items || []).slice(0, 6).map((item) => `- ${item.name || item.table_id}`).join("\n") || "- 目前沒有抓到表格";

  return {
    text: [
      "結論",
      `我已直接解析這個 Bitable 連結，不需要你另外手動貼 app_token。`,
      "",
      "重點",
      `- Base：${app.name || app.app_token || bitableRef.app_token}`,
      `- 目前共抓到 ${tables.total ?? tables.items?.length ?? 0} 張表。`,
      targetTable
        ? `- 這次連結指向的表格：${targetTable.name || targetTable.table_id}`
        : "- 這次連結沒有明確指定表格，所以我先只讀 base 結構。",
      tablePreview,
      records
        ? `- 已讀到 ${records.items?.length ?? 0} 筆記錄預覽：\n${previewBitableRecords(records.items || [])}`
        : "- 如果你要我繼續看資料內容，我可以接著讀指定表格的記錄。",
      "",
      "下一步",
      targetTable
        ? "- 你可以直接叫我整理這張表、找欄位結構、或分析裡面的資料。"
        : "- 你可以直接指定要我看哪一張表，我就繼續往下讀記錄。",
    ].join("\n"),
  };
}

function buildImageAnalysisReply(analysis, { multimodal = false } = {}) {
  if (!analysis?.ok) {
    return {
      text: [
        "結論",
        multimodal ? "我已先把這條圖文任務分流到圖片理解路徑，但目前還沒有拿到可用的圖片分析結果。" : "我已把這條圖片任務分流到圖片理解路徑，但目前還沒有拿到可用的圖片分析結果。",
        "",
        "重點",
        `- 圖片供應商：${analysis?.provider || "待確認"}`,
        `- 原因：${analysis?.reason || "待確認"}`,
        "",
        "下一步",
        "- 請提供可直接存取的圖片 URL，或補齊 Nano Banana 設定後再重試。",
      ].join("\n"),
    };
  }

  const lines = [
    "結論",
    multimodal && analysis.text_summary
      ? analysis.text_summary
      : analysis.scene_summary || "我已完成圖片結構化理解。",
    "",
    "重點",
    `- 圖片供應商：${analysis.provider}${analysis.model ? ` (${analysis.model})` : ""}`,
    analysis.detected_objects?.length ? `- detected_objects：${analysis.detected_objects.join("、")}` : null,
    analysis.key_entities?.length ? `- key_entities：${analysis.key_entities.join("、")}` : null,
    analysis.visible_text ? `- visible_text：${analysis.visible_text}` : null,
    analysis.extracted_notes?.length ? `- extracted_notes：${analysis.extracted_notes.join("、")}` : null,
    analysis.confidence != null ? `- confidence：${analysis.confidence}` : null,
  ].filter(Boolean);

  if (!multimodal) {
    lines.push("");
    lines.push("下一步");
    lines.push("- 如果你要，我可以再根據這份結構化結果幫你做摘要、整理或決策建議。");
  }

  return {
    text: lines.join("\n"),
  };
}

async function executeImageTaskReply({ event, logger = noopLogger }) {
  const modality = classifyInputModality(event);
  if (modality.modality === "text") {
    return null;
  }

  const context = await resolveAuthContext(event, logger, { allowTenantFallback: true }).catch(() => null);
  let analysis;
  try {
    analysis = await runLoggedStep(
      logger,
      "image_analysis",
      {
        modality: modality.modality,
        image_count: modality.imageInputs.length,
      },
      () =>
        analyzeImageTask({
          task: modality.text,
          textContext: buildVisibleMessageText(event),
          imageInputs: modality.imageInputs,
          accessToken: context?.token?.access_token || "",
          tokenType: context?.tokenKind || "user",
        }),
    );
  } catch (error) {
    if (shouldFallbackImageTaskToTextLane({ modality: modality.modality, text: modality.text, error })) {
      logger.info("image_task_fallback_to_text_lane", {
        modality: modality.modality,
        reason: "image_analysis_exception",
        error: logger.compactError(error),
      });
      return null;
    }
    throw error;
  }
  logger.info("image_task_routed", {
    modality: modality.modality,
    image_count: modality.imageInputs.length,
    provider: analysis?.provider || "none",
    ok: Boolean(analysis?.ok),
  });
  if (!analysis?.ok && shouldFallbackImageTaskToTextLane({ modality: modality.modality, text: modality.text, analysis })) {
    logger.info("image_task_fallback_to_text_lane", {
      modality: modality.modality,
      reason: analysis?.reason || "image_analysis_unavailable",
    });
    return null;
  }
  return buildImageAnalysisReply(analysis, {
    multimodal: modality.modality === "multimodal",
  });
}

export function shouldFallbackImageTaskToTextLane({ modality = "", text = "", analysis = null, error = null } = {}) {
  if (modality !== "multimodal") {
    return false;
  }
  if (cleanText(text).length < 6) {
    return false;
  }
  if (error) {
    return true;
  }
  return !analysis?.ok;
}

function formatUnixDate(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "待確認";
  }

  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) {
    return "待確認";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function toUnixSeconds(date) {
  return String(Math.floor(date.getTime() / 1000));
}

function normalizeCalendarTimestamp(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function pickCalendarMeetingEvent(events = [], now = Date.now()) {
  const candidates = events
    .map((event) => {
      const startMs = normalizeCalendarTimestamp(event.start_time);
      const endMs = normalizeCalendarTimestamp(event.end_time);
      return {
        ...event,
        startMs,
        endMs,
      };
    })
    .filter((event) => event.meeting_url && event.startMs && event.endMs);

  const active = candidates
    .filter((event) => event.startMs <= now && now <= event.endMs)
    .sort((left, right) => left.endMs - right.endMs)[0];
  if (active) {
    return active;
  }

  const upcoming = candidates
    .filter((event) => event.startMs >= now)
    .sort((left, right) => left.startMs - right.startMs)[0];
  return upcoming || null;
}

async function resolveCalendarBackedMeeting({ accessToken, text = "" } = {}) {
  const calendar = await getPrimaryCalendar(accessToken);
  if (!calendar?.calendar_id) {
    return null;
  }

  const now = new Date();
  const startWindow = new Date(now.getTime() - 60 * 60 * 1000);
  const endWindow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const events = await listCalendarEvents(accessToken, calendar.calendar_id, {
    pageSize: 20,
    startTime: toUnixSeconds(startWindow),
    endTime: toUnixSeconds(endWindow),
    anchorTime: toUnixSeconds(now),
  });

  const selected = pickCalendarMeetingEvent(events.items || [], now.getTime());
  if (!selected) {
    return null;
  }
  return {
    calendar,
    event: selected,
  };
}

function buildMeetingCaptureSessionPayload({ accountId, chatId, startedByOpenId, sourceMessageId, meeting } = {}) {
  return {
    accountId,
    chatId,
    startedByOpenId,
    sourceMessageId,
    sourceKind: meeting?.event ? "calendar_event" : "",
    eventId: cleanText(meeting?.event?.event_id),
    eventSummary: cleanText(meeting?.event?.summary),
    meetingUrl: cleanText(meeting?.event?.meeting_url),
    eventStartTime: cleanText(meeting?.event?.start_time),
    eventEndTime: cleanText(meeting?.event?.end_time),
  };
}

function buildMeetingCaptureDocTitle({ eventSummary = "", eventStartTime = "", chatId = "" } = {}) {
  const date = formatUnixDate(eventStartTime || Date.now());
  const base = cleanText(eventSummary) || `meeting_${cleanText(chatId).slice(-6) || "capture"}`;
  return `${base}_${date}_meeting_capture`;
}

function buildMeetingDraftDocContent({ title = "", eventSummary = "", meetingUrl = "" } = {}) {
  return [
    "# 會議紀要草稿",
    "",
    `標題：${cleanText(title) || "待確認"}`,
    eventSummary ? `會議：${eventSummary}` : "",
    meetingUrl ? `會議連結：${meetingUrl}` : "",
    "",
    "狀態：錄音與文字記錄進行中",
    "",
    "## 原始轉譯",
    "- 會議進行中，結束後自動寫入。",
    "",
    "## 整理後紀要",
    "- 會議結束後自動生成。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalMeetingDocContent({
  title = "",
  summaryContent = "",
  transcriptText = "",
  eventSummary = "",
  meetingUrl = "",
} = {}) {
  return [
    "# 會議紀要",
    "",
    `標題：${cleanText(title) || "待確認"}`,
    eventSummary ? `會議：${eventSummary}` : "",
    meetingUrl ? `會議連結：${meetingUrl}` : "",
    "",
    "## 整理後紀要",
    summaryContent || "- 待確認",
    "",
    "## 原始轉譯",
    transcriptText || "- 無",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFailedMeetingDocContent({
  title = "",
  eventSummary = "",
  meetingUrl = "",
  audioReason = "",
  hasChatNotes = false,
} = {}) {
  return [
    "# 會議紀要",
    "",
    `標題：${cleanText(title) || "待確認"}`,
    eventSummary ? `會議：${eventSummary}` : "",
    meetingUrl ? `會議連結：${meetingUrl}` : "",
    "",
    "## 目前狀態",
    "- 這份文檔目前不是有效的會議逐字稿。",
    "- 本次錄音沒有轉出可用文字內容。",
    audioReason ? `- 轉譯結果：${audioReason}` : "",
    hasChatNotes ? "- 聊天室只收到了少量控制訊息或低訊號補充，未形成可用會議內容。" : "- 會議期間沒有收到可用聊天補充內容。",
    "",
    "## 下一步",
    "- 下次請確認現場聲音有被麥克風實際收進去。",
    "- 若是線下會議，建議中途把重點、決議、TODO 貼進聊天室，避免只留下空白音訊。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function ensureMeetingCaptureDoc({ accessToken, tokenType = "user", session, fallbackTitle = "" } = {}) {
  if (session?.target_document_id) {
    await ensureDocumentManagerPermission(accessToken, session.target_document_id, {
      tokenType,
      managerOpenId: session?.started_by_open_id || "",
    });
    return {
      document_id: session.target_document_id,
      title: session.target_document_title || fallbackTitle || session.target_document_id,
      url: session.target_document_url || "",
      existed: true,
    };
  }
  const created = await createManagedDocument(
    accessToken,
    fallbackTitle || buildMeetingCaptureDocTitle({
      eventSummary: session?.event_summary,
      eventStartTime: session?.event_start_time,
      chatId: session?.chat_id,
    }),
    meetingDocFolderToken || undefined,
    {
      tokenType,
      managerOpenId: session?.started_by_open_id || "",
    },
  );
  attachMeetingCaptureDocument(session?.id, {
    documentId: created.document_id,
    title: created.title,
    url: created.url,
  });
  return {
    ...created,
    existed: false,
  };
}

async function maybeStartMeetingAudio(sessionId) {
  if (!sessionId) {
    return null;
  }
  try {
    return await startMeetingAudioCapture(sessionId);
  } catch (error) {
    return {
      started: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Meeting recording / transcription runtime boundary
// ---------------------------------------------------------------------------

function buildMeetingTranscriptText({ audioTranscript = null, chatTranscript = "" } = {}) {
  return [
    audioTranscript?.ok ? `【本機錄音轉譯】\n${audioTranscript.text}` : "",
    chatTranscript ? `【聊天補充】\n${chatTranscript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hasUsableMeetingTranscript(text) {
  return Boolean(cleanText(text));
}

async function executeMeetingCommand({ event, scope, logger = noopLogger }) {
  const command = parseMeetingCommand(normalizeMessageText(event));
  if (!command) {
    return null;
  }

  const context = await resolveAuthContext(event, logger, { allowTenantFallback: true });
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  if (command.action === "start_capture_calendar") {
    const meeting = context.tokenKind === "user"
      ? await resolveCalendarBackedMeeting({
          accessToken: context.token,
          text: normalizeMessageText(event),
        })
      : null;
    if (!meeting?.event) {
      return {
        text: [
          "結論",
          "我沒有找到目前正在進行中，或接下來最近一場帶會議連結的 Calendar 事件。",
          "",
          "下一步",
          "- 你可以先在行事曆把這場會議建好並帶上 meeting URL。",
          "- 或直接說「我要開會了」，先用聊天室記錄模式開始。",
        ].join("\n"),
      };
    }

    const activeSession = startMeetingCaptureSession({
      accountId: context.account.id,
      chatId: cleanText(event?.message?.chat_id),
      startedByOpenId: cleanText(event?.sender?.sender_id?.open_id),
      sourceMessageId: cleanText(event?.message?.message_id),
      sourceKind: "calendar_event",
      eventId: cleanText(meeting.event.event_id),
      eventSummary: cleanText(meeting.event.summary),
      meetingUrl: cleanText(meeting.event.meeting_url),
      eventStartTime: cleanText(meeting.event.start_time),
      eventEndTime: cleanText(meeting.event.end_time),
    });
    const currentEntries = listMeetingCaptureEntries(activeSession.id);
    const audio = await maybeStartMeetingAudio(activeSession.id);
    if (audio?.started) {
      attachMeetingCaptureAudio(activeSession.id, {
        filePath: audio.file_path,
        deviceName: audio.device_name,
        pid: audio.pid,
        startedAt: audio.started_at,
        stoppedAt: "",
      });
    }
    const meetingDoc = await runLoggedStep(
      logger,
      "meeting_doc_prepare",
      { session_id: formatIdentifierHint(activeSession.id) },
      () =>
        ensureMeetingCaptureDoc({
          accessToken: context.token,
          tokenType: context.tokenKind,
          session: activeSession,
          fallbackTitle: buildMeetingCaptureDocTitle({
            eventSummary: meeting.event.summary,
            eventStartTime: meeting.event.start_time,
            chatId: cleanText(event?.message?.chat_id),
          }),
        }),
    );
    await runLoggedStep(
      logger,
      "meeting_doc_update",
      { document_id: formatIdentifierHint(meetingDoc.document_id), mode: "replace" },
      () =>
        updateDocument(
          context.token,
          meetingDoc.document_id,
          buildMeetingDraftDocContent({
            title: meetingDoc.title,
            eventSummary: meeting.event.summary,
            meetingUrl: meeting.event.meeting_url,
          }),
          "replace",
          context.tokenKind,
        ),
    );
    await ensureMeetingWorkflowTask({
      accountId: context.account.id,
      event,
      scope,
      workflowState: "capturing",
      routingHint: "meeting_capture",
      objective: meeting?.event?.summary || "meeting_capture",
      meta: {
        source: "meeting_start_capture_calendar",
        meeting_session_mode: "calendar_event",
      },
    });
    return {
      text: [
        "結論",
        currentEntries.length > 0 ? "我已把這次旁聽綁到目前的會議記錄模式，會繼續沿用既有記錄。" : "我已從 Calendar 鎖定這場會議，並進入會議記錄模式。",
        "",
        "重點",
        `- 會議：${meeting.event.summary || meeting.event.event_id}`,
        `- 時間：${formatUnixDate(meeting.event.start_time)} ~ ${formatUnixDate(meeting.event.end_time)}`,
        `- meeting_url：${meeting.event.meeting_url}`,
        `- 會議文檔：${meetingDoc.url || meetingDoc.document_id}`,
        audio?.started
          ? `- 本機錄音已啟動：${audio.device_name}`
          : `- 本機錄音未啟動：${audio?.reason || "unknown_reason"}`,
        `- 轉譯路徑：${resolveMeetingTranscribeProvider() === "faster_whisper" ? "本機 faster-whisper" : "OpenAI-compatible API"}`,
        "- 我現在會先在這個聊天室持續累積文字記錄；結束時你只要說「會議結束了」。",
        "- 目前這一步會先做本機錄音與聊天室文字累積，不會自動代你發言。",
      ].join("\n"),
    };
  }

  if (command.action === "start_capture") {
    const meeting = context.tokenKind === "user"
      ? await resolveCalendarBackedMeeting({
          accessToken: context.token,
          text: normalizeMessageText(event),
        })
      : null;
    const activeSession = startMeetingCaptureSession(buildMeetingCaptureSessionPayload({
      accountId: context.account.id,
      chatId: cleanText(event?.message?.chat_id),
      startedByOpenId: cleanText(event?.sender?.sender_id?.open_id),
      sourceMessageId: cleanText(event?.message?.message_id),
      meeting,
    }));
    const currentEntries = listMeetingCaptureEntries(activeSession.id);
    const audio = await maybeStartMeetingAudio(activeSession.id);
    if (audio?.started) {
      attachMeetingCaptureAudio(activeSession.id, {
        filePath: audio.file_path,
        deviceName: audio.device_name,
        pid: audio.pid,
        startedAt: audio.started_at,
        stoppedAt: "",
      });
    }
    const meetingDoc = await runLoggedStep(
      logger,
      "meeting_doc_prepare",
      { session_id: formatIdentifierHint(activeSession.id) },
      () =>
        ensureMeetingCaptureDoc({
          accessToken: context.token,
          tokenType: context.tokenKind,
          session: activeSession,
          fallbackTitle: buildMeetingCaptureDocTitle({
            eventSummary: meeting?.event?.summary,
            eventStartTime: meeting?.event?.start_time || event?.message?.create_time,
            chatId: cleanText(event?.message?.chat_id),
          }),
        }),
    );
    await runLoggedStep(
      logger,
      "meeting_doc_update",
      { document_id: formatIdentifierHint(meetingDoc.document_id), mode: "replace" },
      () =>
        updateDocument(
          context.token,
          meetingDoc.document_id,
          buildMeetingDraftDocContent({
            title: meetingDoc.title,
            eventSummary: meeting?.event?.summary,
            meetingUrl: meeting?.event?.meeting_url,
          }),
          "replace",
          context.tokenKind,
        ),
    );
    await ensureMeetingWorkflowTask({
      accountId: context.account.id,
      event,
      scope,
      workflowState: "capturing",
      routingHint: "meeting_capture",
      objective: meeting?.event?.summary || "meeting_capture",
      meta: {
        source: "meeting_start_capture",
        meeting_session_mode: meeting?.event ? "calendar_event" : "chat_capture",
      },
    });
    return {
      text: [
        "結論",
        currentEntries.length > 0
          ? "會議記錄模式已在進行中，我會繼續在這個聊天室安靜記錄。"
          : meeting?.event
            ? "我已自動從 Calendar 鎖定目前這場會議，並進入會議記錄模式。"
            : "我已進入會議記錄模式，接下來這個聊天室的文字我會先幫你累積成會議逐字筆記。",
        "",
        "重點",
        meeting?.event ? `- 會議：${meeting.event.summary || meeting.event.event_id}` : null,
        meeting?.event ? `- meeting_url：${meeting.event.meeting_url}` : null,
        `- 會議文檔：${meetingDoc.url || meetingDoc.document_id}`,
        audio?.started
          ? `- 本機錄音已啟動：${audio.device_name}`
          : `- 本機錄音未啟動：${audio?.reason || "unknown_reason"}`,
        `- 轉譯路徑：${resolveMeetingTranscribeProvider() === "faster_whisper" ? "本機 faster-whisper" : "OpenAI-compatible API"}`,
        "- 會議進行中我不會每句都插話，避免干擾。",
        "- 你說「會議結束了」或輸入 `/meeting stop` 後，我會自動整理成待確認摘要。",
        "- 如果你中途貼會議文檔或補充重點，我也會一起納入。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (command.action === "stop_capture") {
    const activeSession = getActiveMeetingCaptureSession(context.account.id, cleanText(event?.message?.chat_id));
    if (!activeSession) {
      return {
        text: [
          "結論",
          "目前沒有進行中的會議記錄模式。",
          "",
          "下一步",
          "- 你可以先說「我要開會了」或按 `會議`，我就開始記錄。",
        ].join("\n"),
      };
    }

    const entries = listMeetingCaptureEntries(activeSession.id);
    stopMeetingCaptureSession(activeSession.id);
    const audioRecording = await stopMeetingAudioCaptureByMetadata(activeSession.id, activeSession);
    if (audioRecording) {
      attachMeetingCaptureAudio(activeSession.id, {
        filePath: audioRecording.file_path,
        deviceName: audioRecording.device_name,
        pid: null,
        startedAt: audioRecording.started_at,
        stoppedAt: new Date().toISOString(),
      });
    }
    const audioTranscript = audioRecording?.file_path ? await transcribeMeetingAudio(audioRecording.file_path) : null;
    const chatTranscript = buildMeetingCaptureTranscript(entries, {
      maxEntries: 80,
      maxChars: meetingTranscriptPromptMaxChars,
    });
    const transcriptText = buildMeetingTranscriptText({
      audioTranscript,
      chatTranscript,
    });
    const meetingDoc = await ensureMeetingCaptureDoc({
      accessToken: context.token,
      tokenType: context.tokenKind,
      session: activeSession,
      fallbackTitle: buildMeetingCaptureDocTitle({
        eventSummary: activeSession.event_summary,
        eventStartTime: activeSession.event_start_time || event?.message?.create_time,
        chatId: cleanText(event?.message?.chat_id),
      }),
    });
    if (!hasUsableMeetingTranscript(transcriptText)) {
      const failureMode = getAccountPreference(context.account.id, meetingFailurePreferenceKey);
      let deletedFailureDoc = false;
      if (failureMode === "chat_only" && meetingDoc?.document_id) {
        try {
          await runLoggedStep(
            logger,
            "meeting_doc_delete",
            { document_id: formatIdentifierHint(meetingDoc.document_id) },
            () =>
              deleteDriveItem(
                context.token,
                meetingDoc.document_id,
                "docx",
                context.tokenKind,
              ),
          );
          clearMeetingCaptureDocument(activeSession.id);
          deletedFailureDoc = true;
        } catch (error) {
          logger.warn("meeting_doc_delete_failed_fallback_to_failure_doc", {
            document_id: formatIdentifierHint(meetingDoc.document_id),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!deletedFailureDoc) {
        await runLoggedStep(
          logger,
          "meeting_doc_update",
          { document_id: formatIdentifierHint(meetingDoc.document_id), mode: "replace" },
          () =>
            updateDocument(
              context.token,
              meetingDoc.document_id,
              buildFailedMeetingDocContent({
                title: meetingDoc.title,
                eventSummary: activeSession.event_summary,
                meetingUrl: activeSession.meeting_url,
                audioReason: audioTranscript?.ok ? "" : audioTranscript?.reason || "",
                hasChatNotes: entries.length > 0,
              }),
              "replace",
              context.tokenKind,
            ),
        );
      }
      return {
        text: [
          "結論",
          "我已結束會議記錄模式，但這次沒有取得可用的會議逐字稿。",
          "",
          "重點",
          audioTranscript?.ok ? null : `- 錄音轉譯結果：${audioTranscript?.reason || "待確認"}`,
          entries.length > 0 ? "- 聊天室裡只有控制訊息或低訊號內容，沒有形成可用紀要。" : "- 聊天室裡也沒有補充可用會議內容。",
          deletedFailureDoc ? "- 我已依你的偏好直接刪掉這次失敗的會議文檔。" : null,
          "",
          "下一步",
          deletedFailureDoc ? "- 我已直接在聊天裡說明，不再另外留失敗文檔。" : `- 我已把說明寫進文檔：${meetingDoc.url || meetingDoc.document_id}`,
          "- 下次開會時，直接在這個聊天室同步文字、逐字稿或會議重點給我。",
        ].join("\n"),
      };
    }

    const result = await meetingCoordinator.renderMeetingMinutes({
      accountId: context.account.id,
      transcriptText,
      metadata: {
        date: formatUnixDate(activeSession.event_start_time || event?.message?.create_time),
        source: activeSession.event_summary || "chat_meeting_capture",
      },
      chatId: cleanText(event?.message?.chat_id),
      sourceMeetingId: cleanText(event?.message?.message_id),
    });
    await runLoggedStep(
      logger,
      "meeting_doc_update",
      { document_id: formatIdentifierHint(meetingDoc.document_id), mode: "replace" },
      () =>
        updateDocument(
          context.token,
          meetingDoc.document_id,
          buildFinalMeetingDocContent({
            title: meetingDoc.title,
            summaryContent: result.summary_content,
            transcriptText,
            eventSummary: activeSession.event_summary,
            meetingUrl: activeSession.meeting_url,
          }),
          "replace",
          context.tokenKind,
        ),
    );
    await ensureMeetingWorkflowTask({
      accountId: context.account.id,
      event,
      scope,
      workflowState: "awaiting_confirmation",
      routingHint: "meeting_confirmation_pending",
      objective: activeSession.event_summary || result.project_name || "meeting_summary_confirmation",
      meta: {
        source: "meeting_stop_capture",
        source_meeting_id: cleanText(event?.message?.message_id),
        target_document_id: meetingDoc.document_id,
      },
    });

    return {
      text: [
        "結論",
        "我已結束這次會議記錄，並把可直接使用的會議紀要寫進新文檔。",
        "",
        "重點",
        `- 本次共收集 ${entries.length} 段會議文字。`,
        audioRecording?.file_path ? `- 錄音檔：${audioRecording.file_path}` : null,
        audioTranscript?.ok
          ? `- 本機錄音已完成轉譯，長度約 ${audioTranscript.text.length} 字。`
          : audioRecording?.file_path
            ? `- 本機錄音未成功轉譯：${audioTranscript?.reason || "unknown_reason"}`
            : null,
        audioTranscript?.ok && audioTranscript.provider
          ? `- 轉譯供應商：${audioTranscript.provider}${audioTranscript.model ? ` (${audioTranscript.model})` : ""}`
          : null,
        activeSession.event_summary ? `- 對應會議：${activeSession.event_summary}` : null,
        `- 會議類型：${result.meeting_type === "weekly" ? "weekly" : "general"}`,
        `- 會議文檔：${meetingDoc.url || meetingDoc.document_id}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (command.action === "confirm") {
    await markMeetingWorkflowWritingBack({
      accountId: context.account.id,
      scope,
      event,
      meta: {
        source: "meeting_confirm",
        confirmation_id: command.confirmation_id,
      },
    });
    const result = await runLoggedStep(
      logger,
      "meeting_confirm_write",
      { confirmation_id: formatIdentifierHint(command.confirmation_id) },
      () =>
        meetingCoordinator.confirmMeetingWrite({
          accountId: context.account.id,
          accountOpenId: context.account.open_id || "",
          accessToken: context.token,
          confirmationId: command.confirmation_id,
        }),
    );
    if (!result) {
      return {
        text: [
          "結論",
          "這個 meeting confirmation 不存在、已過期，或不屬於你目前的授權帳號。",
          "",
          "下一步",
          "- 請重新執行一次 /meeting 生成新的摘要預覽。",
        ].join("\n"),
      };
    }

    await finalizeMeetingWorkflowTask({
      accountId: context.account.id,
      scope,
      summaryContent: result.structured_result?.summary || "",
      structuredResult: result.structured_result,
      extraEvidence: [
        {
          type: "file_updated",
          summary: `document:${result.target_document?.document_id || ""}`,
        },
        {
          type: "DB_write_confirmed",
          summary: "meeting_document_mapping_saved",
        },
        ...(Array.isArray(result.knowledge_proposals) && result.knowledge_proposals.length
          ? [
              {
                type: "knowledge_proposal_created",
                summary: `knowledge_proposals:${result.knowledge_proposals.length}`,
              },
            ]
          : []),
      ],
    });

    return {
      text: [
        "結論",
        "我已完成確認並寫入對應文檔。",
        "",
        "重點",
        `- 會議類型：${result.meeting_type === "weekly" ? "weekly" : "general"}`,
        `- 目標文檔：${result.target_document.title || result.target_document.document_id}`,
        result.write_result?.deduplicated ? "- 這次內容與現有紀要重複，已略過重複插入。" : "- 新紀要已插入文檔最上方。",
        result.meeting_type === "weekly"
          ? `- 週會 Todo tracker 已更新 ${result.tracker_updates.length} 筆。`
          : "- 本次不更新週會 Todo tracker。",
      ].join("\n"),
    };
  }

  const documentRef = await resolveReferencedDocumentId(event, context.token, logger);
  let transcriptText = command.content;
  let referencedDocument = null;
  if (documentRef.documentId) {
    referencedDocument = await getDocument(context.token, documentRef.documentId);
    transcriptText = referencedDocument.content || transcriptText;
  }

  if (!cleanText(transcriptText)) {
    if (command.wake_source === "natural_language_intent") {
      return {
        text: [
          "結論",
          "我有會議整理流程，但目前不是自動入會型 agent。",
          "",
          "重點",
          "- 我可以在你貼逐字稿、回覆會議文檔，或會後把內容丟給我後，先整理摘要給你確認。",
          "- 你確認後，我再把內容寫進指定文檔或第二部分。",
          "",
          "下一步",
          "- 直接輸入：/meeting <逐字稿>",
          "- 或回覆一份會議文檔後再輸入：/meeting",
        ].join("\n"),
      };
    }

    return {
      text: [
        "結論",
        "我已切到 /meeting，但這次沒有拿到可整理的會議內容。",
        "",
        "下一步",
        "- 直接把逐字稿貼在 /meeting 後面，或回覆一份會議文件後再輸入 /meeting。",
      ].join("\n"),
    };
  }

  const result = await meetingCoordinator.processMeetingPreview({
    accountId: context.account.id,
    accessToken: context.token,
    transcriptText,
    metadata: {
      date: formatUnixDate(event?.message?.create_time),
      source: referencedDocument?.title || null,
    },
    chatId: cleanText(event?.message?.chat_id),
    sourceMeetingId: cleanText(event?.message?.message_id),
  });
  await ensureMeetingWorkflowTask({
    accountId: context.account.id,
    event,
    scope,
    workflowState: "awaiting_confirmation",
    routingHint: "meeting_confirmation_pending",
    objective: result.project_name || "meeting_summary_confirmation",
    meta: {
      source: "meeting_preview",
      confirmation_id: result.confirmation?.confirmation_id || "",
      target_group_chat_id: result.target_group_chat_id,
    },
  });

  return {
    text: [
      "結論",
      "我已先把會議摘要發到指定群組，現在停在待確認，不會先寫文檔。",
      "",
      "重點",
      `- 會議類型：${result.meeting_type === "weekly" ? "weekly" : "general"}`,
      `- 專案鍵：${result.project_name}`,
      `- 目標群組：${result.target_group_chat_id}`,
      `- 文檔目標：${result.target_document.title}${result.target_document.existed ? "（已找到既有文檔）" : "（確認後會自動建立）"}`,
      "",
      "下一步",
      `- 若確認寫入文檔，請回覆：/meeting confirm ${result.confirmation.confirmation_id}`,
    ].join("\n"),
  };
}

async function captureMeetingEntryIfActive({ event, scope, logger = noopLogger }) {
  const text = cleanText(incomingText(event));
  if (!text) {
    return null;
  }

  const context = await resolveAuthContext(event, logger, { allowTenantFallback: true });
  if (!context) {
    return null;
  }

  const activeSession = getActiveMeetingCaptureSession(context.account.id, cleanText(event?.message?.chat_id));
  if (!activeSession) {
    return null;
  }

  if (looksLikeMeetingCaptureStatusQuery(text)) {
    const audioStatus = getMeetingAudioCaptureStatus(activeSession.id, activeSession);
    return {
      text: [
        "結論",
        "會議記錄模式仍在進行中，我會繼續在這個聊天室安靜記錄。",
        "",
        "重點",
        `- 會議文檔：${activeSession.target_document_url || activeSession.target_document_id || "待確認"}`,
        `- 本機錄音：${audioStatus.active ? `進行中${audioStatus.device_name ? ` (${audioStatus.device_name})` : ""}` : "未啟動或已停止"}`,
        `- 轉譯路徑：${resolveMeetingTranscribeProvider() === "faster_whisper" ? "本機 faster-whisper" : "OpenAI-compatible API"}`,
        "- 你說「會議結束了」或輸入 `/meeting stop` 後，我會自動整理摘要。",
      ].join("\n"),
    };
  }

  const modality = classifyInputModality(event);
  let captureContent = text;
  if ((modality.modality === "image" || modality.modality === "multimodal") && modality.imageInputs.length) {
    const imageAnalysis = await analyzeImageTask({
      task: text,
      textContext: buildVisibleMessageText(event),
      imageInputs: modality.imageInputs,
    });
    const imageContext = imageAnalysis?.ok
      ? buildStructuredImageContext(imageAnalysis)
      : `image_capture_status: ${imageAnalysis?.reason || "unavailable"}`;
    captureContent = [
      "[會議附圖]",
      imageContext,
      text ? `補充文字：${text}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  appendMeetingCaptureEntry({
    sessionId: activeSession.id,
    messageId: cleanText(event?.message?.message_id),
    senderOpenId: cleanText(event?.sender?.sender_id?.open_id),
    senderLabel: cleanText(event?.sender?.sender_id?.open_id || event?.sender?.sender_type),
    content: captureContent,
    createdAt: event?.message?.create_time ? new Date(Number.parseInt(event.message.create_time, 10)).toISOString() : "",
  });

  logger.info("meeting_capture_entry_appended", {
    chat_id: formatIdentifierHint(cleanText(event?.message?.chat_id)),
    message_id: formatIdentifierHint(cleanText(event?.message?.message_id)),
    session_id: formatIdentifierHint(activeSession.id),
  });
  return { suppressReply: true };
}

async function executeDocEditor({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = incomingText(event);
  const sessionKey = cleanText(scope?.session_key || scope?.chat_id || event?.message?.chat_id);
  const activeTask = context.account.id && sessionKey
    ? await getActiveExecutiveTask(context.account.id, sessionKey)
    : null;
  const activeDocRewriteTask = activeTask?.workflow === "doc_rewrite" ? activeTask : null;
  const documentRef = await resolveReferencedDocumentId(event, context.token, logger);
  const documentId = documentRef.documentId || cleanText(activeDocRewriteTask?.meta?.document_id || "");
  if (!documentId) {
    logger.warn("doc_editor_missing_document_id", {
      related_message_count: collectRelatedMessageIds(event).length,
    });
    return {
      text: [
        "結論",
        "我已切到文檔編輯模式，但這次訊息裡沒有解析到可讀取的文件 token。",
        "",
        "重點",
        "- 你這次很可能是傳了文件卡片或回覆了一則文件分享訊息。",
        "- 目前我會先讀當前訊息，再補讀你回覆的上游訊息；如果兩邊都沒有 token，就無法直接打開正文。",
        "",
        "下一步",
        "- 直接貼 doc 連結或 document_id，我就能直接打開。",
      ].join("\n"),
    };
  }

  if (hasAny(normalizeMessageText({ text }), ["評論", "评论", "改稿", "rewrite", "修改"])) {
    const result = await generateDocumentCommentSuggestionCard({
      accessToken: context.token,
      accountId: context.account.id,
      documentId,
      messageId: "",
      replyInThread: true,
      resolveComments: false,
      markSeen: false,
    });
    if (!result.has_new_comments) {
      return {
        text: [
          "結論",
          "目前這份文件沒有新的未處理評論需要生成改稿建議。",
          "",
          "重點",
          "- 如果你要，我還是可以直接讀正文後幫你提出優化建議。",
          "",
          "下一步",
          "- 你也可以直接叫我讀這份文件並整理修改方向。",
        ].join("\n"),
      };
    }
    return {
      cardTitle: result.rewrite_preview_card?.title || "評論改稿建議",
      text: result.rewrite_preview_card?.content || "我已生成評論改稿建議。",
      replyMode: "card",
      accessToken: context.token,
    };
  }

  const document = await getDocument(context.token, documentId);
  return {
    text: [
      "結論",
      `我已讀到「${document.title || document.document_id}」。`,
      "",
      "重點",
      documentRef.source === "referenced_message"
        ? `- 這份文件是從你回覆的上一則訊息裡解析出來的。`
        : activeDocRewriteTask && !documentRef.documentId
          ? "- 這份文件是沿用目前 active doc rewrite task 綁定的文檔。"
          : "- 這份文件是直接從你這次訊息裡解析出來的。",
      `- 文檔摘要：${truncate(document.content, 180)}`,
      "",
      "下一步",
      "- 如果你要，我可以接著抓評論、整理修改建議，或直接生成改稿預覽。",
    ].join("\n"),
  };
}

async function executePersonalAssistant({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger, { allowTenantFallback: true });
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = normalizeMessageText(event);
  const lanePlan = resolveLaneExecutionPlan({ event, scope });
  logger.info("lane_execution_planned", lanePlan);
  const chatId = cleanText(event?.message?.chat_id);
  const sessionKey = cleanText(scope?.session_key || scope?.chat_id || chatId);
  const cloudDocScopeKey = buildCloudDocWorkflowScopeKey({ sessionKey });
  const recentMeetingSession = getLatestMeetingCaptureSession(context.account.id, chatId);
  const activeTask = await getActiveExecutiveTask(context.account.id, sessionKey);
  const activeCloudDocTask = matchesCloudDocWorkflowScope(activeTask, cloudDocScopeKey) ? activeTask : null;
  const wantsDeleteMeetingDoc = looksLikeDeleteMeetingDocRequest(text);
  const wantsChatOnlyFailure = looksLikeChatOnlyFailurePreference(text);
  const activeWorkflowMode = readSessionWorkflowMode(context.account.id, sessionKey);
  const cloudOrganizationAction = resolveCloudOrganizationAction({
    text,
    activeWorkflowMode,
  });

  if (wantsDeleteMeetingDoc || wantsChatOnlyFailure) {
    const lines = ["結論"];
    let deleted = false;

    if (wantsChatOnlyFailure) {
      setAccountPreference(context.account.id, meetingFailurePreferenceKey, "chat_only");
      lines.push("之後如果只是錄音/轉譯失敗，我會直接在聊天回你，不再另外建立失敗說明文檔。");
    } else {
      lines.push("我已收到這次的文檔清理要求。");
    }

    if (wantsDeleteMeetingDoc && recentMeetingSession?.target_document_id) {
      try {
        await deleteDriveItem(
          context.token,
          recentMeetingSession.target_document_id,
          "docx",
          context.tokenKind,
        );
        clearMeetingCaptureDocument(recentMeetingSession.id);
        deleted = true;
      } catch (error) {
        lines.push("");
        lines.push("重點");
        lines.push(`- 我有找到最近那份 Lobster 文檔，但刪除時失敗：${error?.message || "unknown_error"}`);
      }
    }

    if (deleted) {
      lines.push("");
      lines.push("重點");
      lines.push("- 我已刪掉剛剛那份 Lobster 生成的文檔。");
    } else if (wantsDeleteMeetingDoc && !recentMeetingSession?.target_document_id) {
      lines.push("");
      lines.push("重點");
      lines.push("- 這個聊天室最近沒有找到可刪除的 Lobster 文檔。");
    }

    lines.push("");
    lines.push("下一步");
    lines.push("- 之後你直接說刪掉、不要留失敗文檔，我會直接按這個偏好處理。");
    return { text: lines.join("\n") };
  }

  if (cloudOrganizationAction === "exit") {
    writeSessionWorkflowMode(context.account.id, sessionKey, null);
    return {
      text: [
        "結論",
        "我已退出雲文檔分類/角色分配模式。",
        "",
        "重點",
        "- 後續訊息不會再自動延續剛剛那條文檔分類工作流。",
        "",
        "下一步",
        "- 你現在可以直接換話題，或之後再重新叫我做文檔分類。",
      ].join("\n"),
    };
  }

  if (cloudOrganizationAction !== "none") {
    writeSessionWorkflowMode(context.account.id, sessionKey, CLOUD_DOC_ORGANIZATION_MODE);
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: {
        session_key: sessionKey,
        trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
      },
      event,
      workflowState: "scoping",
      routingHint: "cloud_doc_scoping",
      objective: "cloud_doc_chat_scope",
      scopeKey: cloudDocScopeKey,
      meta: {
        scope_type: "chat_scope",
      },
    });
    if (cloudOrganizationAction === "why") {
      const reply = await buildCloudOrganizationWhyReply({
        accountId: context.account.id,
      });
      await ensureCloudDocWorkflowTask({
        accountId: context.account.id,
        scope: {
          session_key: sessionKey,
          trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
        },
        event,
        workflowState: "awaiting_review",
        routingHint: "cloud_doc_review_pending",
        objective: "cloud_doc_chat_scope",
        scopeKey: cloudDocScopeKey,
        meta: {
          scope_type: "chat_scope",
          last_action: "why",
        },
      });
      return reply;
    }
    if (cloudOrganizationAction === "review" || cloudOrganizationAction === "rereview") {
      const reply = await buildCloudOrganizationReviewReplyCached({
        accountId: context.account.id,
        sessionKey,
        forceReReview: cloudOrganizationAction === "rereview",
      });
      await ensureCloudDocWorkflowTask({
        accountId: context.account.id,
        scope: {
          session_key: sessionKey,
          trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
        },
        event,
        workflowState: "awaiting_review",
        routingHint: "cloud_doc_review_pending",
        objective: "cloud_doc_chat_scope",
        scopeKey: cloudDocScopeKey,
        meta: {
          scope_type: "chat_scope",
          last_action: cloudOrganizationAction,
        },
      });
      return reply;
    }
    const reply = await buildCloudOrganizationPreviewReply({
      accountId: context.account.id,
    });
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: {
        session_key: sessionKey,
        trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
      },
      event,
      workflowState: "previewing",
      routingHint: "cloud_doc_preview",
      objective: "cloud_doc_chat_scope",
      scopeKey: cloudDocScopeKey,
      meta: {
        scope_type: "chat_scope",
        last_action: "preview",
      },
    });
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: {
        session_key: sessionKey,
        trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
      },
      event,
      workflowState: "awaiting_review",
      routingHint: "cloud_doc_review_pending",
      objective: "cloud_doc_chat_scope",
      scopeKey: cloudDocScopeKey,
      meta: {
        scope_type: "chat_scope",
        last_action: "preview",
      },
    });
    return reply;
  }

  if (activeCloudDocTask && activeCloudDocTask.status === "active") {
    writeSessionWorkflowMode(context.account.id, sessionKey, CLOUD_DOC_ORGANIZATION_MODE);
    const reply = await buildCloudOrganizationReviewReplyCached({
      accountId: context.account.id,
      sessionKey,
      forceReReview: false,
    });
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: {
        session_key: sessionKey,
        trace_id: cleanText(scope?.trace_id || event?.trace_id || ""),
      },
      event,
      workflowState: "awaiting_review",
      routingHint: "cloud_doc_review_pending",
      objective: "cloud_doc_chat_scope",
      scopeKey: cloudDocScopeKey,
      meta: {
        scope_type: "chat_scope",
        last_action: "review",
      },
    });
    return reply;
  }

  if (context.tokenKind === "tenant") {
    if (lanePlan.chosen_action === "summarize_recent_dialogue") {
      return buildLanePermissionDeniedReply();
    }
    return {
      text: [
        "結論",
        "我先用本機會議/私聊保底模式接住這則訊息。",
        "",
        "重點",
        "- 目前你的 user OAuth refresh 有問題，所以我先不做需要個人授權的日程/任務讀取。",
        "- 但像會議記錄、文檔建立、文字整理這類本機/應用側流程仍可繼續。",
        "",
        "下一步",
        "- 你可以直接說要我開始記錄會議、整理內容，或等會議結束後貼逐字內容給我。",
      ].join("\n"),
    };
  }

  if (lanePlan.fallback_reason === "semantic_mismatch_document_request_in_personal_lane") {
    return buildLaneSemanticMismatchReply();
  }

  if (lanePlan.fallback_reason === ROUTING_NO_MATCH) {
    return buildLaneRoutingNoMatchReply({
      scope,
      lanePlan,
      message: "personal_lane_requires_explicit_supported_action",
    });
  }

  if (hasAny(text, ["日程", "行程", "calendar", "會議", "会议"])) {
    const calendar = await getPrimaryCalendar(context.token);
    const events = await listCalendarEvents(context.token, calendar.calendar_id, {
      startTime: startOfDayUnix().toString(),
      endTime: endOfDayUnix().toString(),
    });
    const items = (events.items || []).slice(0, 5).map((item) => `- ${item.summary || "(未命名日程)"}`).join("\n") || "- 今天還沒有抓到日程";
    return {
      text: ["結論", "我先幫你看今天的日程。", "", "重點", items, "", "下一步", "- 如果你要，我可以再幫你整理成可直接轉發的行程摘要。"].join("\n"),
    };
  }

  if (hasAny(text, ["任務", "task", "待辦", "todo"])) {
    const tasks = await listTasks(context.token, {});
    const items = (tasks.items || []).slice(0, 5).map((item) => `- ${item.summary || "(未命名任務)"}`).join("\n") || "- 目前沒有抓到任務";
    return {
      text: ["結論", "我先幫你看目前任務。", "", "重點", items, "", "下一步", "- 如果你要，我可以再幫你挑出最該先做的 3 件事。"].join("\n"),
    };
  }

  if (lanePlan.chosen_action === "summarize_recent_dialogue" && chatId) {
    const messages = await listMessages(context.token, chatId, {
      containerIdType: "chat",
      pageSize: 8,
    });
    const items = (messages.items || [])
      .slice(0, 5)
      .map((item) => `- ${truncate(item.text || item.content, 96)}`)
      .join("\n") || "- 目前沒有抓到足夠的最近對話";
    return {
      text: [
        "結論",
        "我先幫你總結最近這段對話。",
        "",
        "重點",
        items,
        "",
        "下一步",
        "- 如果你要，我可以把這段整理成待辦、回覆草稿，或改成更短的摘要。",
      ].join("\n"),
    };
  }

  return buildLaneRoutingNoMatchReply({
    scope,
    lanePlan,
    message: "personal_lane_requires_explicit_supported_action",
  });
}

async function executeGroupSharedAssistant({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = normalizeMessageText(event);
  const lanePlan = resolveLaneExecutionPlan({ event, scope });
  logger.info("lane_execution_planned", lanePlan);
  const chatId = cleanText(event?.message?.chat_id);
  if (chatId && hasAny(text, ["總結", "总结", "整理", "回覆", "回复", "怎麼回", "怎么回"])) {
    const messages = await listMessages(context.token, chatId, {
      containerIdType: "chat",
      pageSize: 8,
    });
    const items = (messages.items || [])
      .slice(0, 5)
      .map((item) => `- ${truncate(item.text || item.content, 96)}`)
      .join("\n") || "- 目前沒有抓到足夠的群聊內容";
    return {
      text: [
        "結論",
        "我先用群組共享模式整理這段對話。",
        "",
        "重點",
        items,
        "",
        "下一步",
        "- 如果你要，我可以直接幫你起一版群裡可發出的回覆。",
      ].join("\n"),
    };
  }

  return buildLaneRoutingNoMatchReply({
    scope,
    lanePlan,
    message: "group_lane_requires_explicit_supported_action",
  });
}

export async function executeCapabilityLane({ event, scope, logger = noopLogger }) {
  const meetingReply = await executeMeetingCommand({ event, scope, logger });
  if (meetingReply) {
    return meetingReply;
  }

  const meetingCaptureReply = await captureMeetingEntryIfActive({ event, scope, logger });
  if (meetingCaptureReply) {
    return meetingCaptureReply;
  }

  const lane = scope?.capability_lane || "personal-assistant";
  logger.info("lane_selected", {
    chosen_lane: lane,
  });
  const agentContext = await resolveAuthContext(event, logger, { allowTenantFallback: true });
  const normalizedText = normalizeMessageText(event);
  const sessionKey = cleanText(scope?.session_key || scope?.chat_id || event?.message?.chat_id);
  const activeExecutiveTask = agentContext?.account?.id && sessionKey
    ? await getActiveExecutiveTask(agentContext.account.id, sessionKey)
    : null;
  const activeWorkflowMode = agentContext?.account?.id
    ? readSessionWorkflowMode(agentContext.account.id, sessionKey)
    : null;
  const wantsCloudOrganizationFollowUp = resolveCloudOrganizationAction({
    text: normalizedText,
    activeWorkflowMode,
  }) !== "none";
  const preferActiveExecutiveTask =
    cleanText(activeExecutiveTask?.workflow) === "executive"
    && shouldPreferActiveExecutiveTask({
      activeTask: activeExecutiveTask,
      lane,
      wantsCloudOrganizationFollowUp,
    });

  if (agentContext?.account?.id && (preferActiveExecutiveTask || !(lane === "personal-assistant" && wantsCloudOrganizationFollowUp))) {
    const executiveReply = await executeExecutiveTurn({
      accountId: agentContext.account.id,
      event,
      scope,
      logger,
    });
    if (executiveReply) {
      return executiveReply;
    }
  }

  // TODO(control-unification-phase2): move meeting/doc-rewrite/cloud-doc follow-up routing onto workflow-state machines.

  if (cleanText(activeExecutiveTask?.workflow) === "doc_rewrite") {
    return executeDocEditor({ event, scope, logger });
  }
  if (cleanText(activeExecutiveTask?.workflow) === CLOUD_DOC_WORKFLOW) {
    const cloudDocScopeKey = buildCloudDocWorkflowScopeKey({
      sessionKey,
    });
    if (matchesCloudDocWorkflowScope(activeExecutiveTask, cloudDocScopeKey)) {
      return executePersonalAssistant({ event, scope, logger });
    }
  }

  const imageReply = await executeImageTaskReply({ event, logger });
  if (imageReply) {
    return imageReply;
  }

  const bitableReply = await executeBitableLinkRequest({ event, scope, logger });
  if (bitableReply) {
    return bitableReply;
  }

  if (lane === "knowledge-assistant") {
    return executeKnowledgeAssistant({ event, scope, logger });
  }
  if (lane === "doc-editor") {
    return executeDocEditor({ event, scope, logger });
  }
  if (lane === "group-shared-assistant") {
    return executeGroupSharedAssistant({ event, scope, logger });
  }
  return executePersonalAssistant({ event, scope, logger });
}
