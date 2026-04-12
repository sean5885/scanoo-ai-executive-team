import {
  buildPlannedUserInputEnvelope,
  buildPlannedUserInputUserFacingReply,
  executePlannedUserInput,
  looksLikeExecutiveStart,
} from "./executive-planner.mjs";
import { randomUUID } from "node:crypto";
import { resolveRegisteredAgentFamilyRequest } from "./agent-registry.mjs";
import { parseMeetingCommand } from "./meeting-agent.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { getPlannerSkillAction } from "./planner/skill-bridge.mjs";
import { applyPlannerWorkingMemoryPatch, readPlannerWorkingMemoryForRouting } from "./planner-conversation-memory.mjs";
import { buildPlannerTaskTraceDiagnostics } from "./planner-working-memory-trace.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

const REMINDER_REQUEST_PATTERNS = [
  /提醒/u,
  /remind/i,
];

const REMINDER_TIMING_PATTERNS = [
  /晚點|晚点|待會|待会|等下|等會|等会|之後|之后|稍後|稍后/u,
  /\blater\b/i,
  /提醒我/u,
];
const WORKING_MEMORY_TOPIC_SWITCH_PATTERN = /(換個題目|换个题目|換題|换题|改問|改问|另一題|另一题|new topic|different question)/i;
const WORKING_MEMORY_DONE_PATTERN = /(完成|done|結束|结束|搞定|已完成|完成了)/i;
const DEFAULT_WORKING_MEMORY_RETRY_POLICY = Object.freeze({
  max_retries: 2,
  strategy: "same_agent_then_reroute",
});
const WORKING_MEMORY_PLAN_STATUSES = new Set([
  "active",
  "paused",
  "completed",
  "invalidated",
]);
const WORKING_MEMORY_PLAN_STEP_STATUSES = new Set([
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
]);
const WORKING_MEMORY_FAILURE_CLASSES = new Set([
  "tool_error",
  "missing_slot",
  "capability_gap",
  "invalid_artifact",
  "timeout",
  "unknown",
]);
const WORKING_MEMORY_RECOVERY_POLICIES = new Set([
  "retry_same_step",
  "reroute_owner",
  "ask_user",
  "skip_step",
  "rollback_to_step",
]);
const WORKING_MEMORY_RECOVERY_ACTIONS = new Set([
  ...WORKING_MEMORY_RECOVERY_POLICIES,
  "failed",
]);
const WORKING_MEMORY_ARTIFACT_VALIDITY_STATUSES = new Set([
  "valid",
  "invalid",
  "superseded",
  "missing",
]);
const WORKING_MEMORY_DEPENDENCY_TYPES = new Set([
  "hard",
  "soft",
]);
const WORKING_MEMORY_PLAN_ARTIFACT_LIMIT = 24;
const WORKING_MEMORY_PLAN_EDGE_LIMIT = 36;
const WORKING_MEMORY_METADATA_KEY_LIMIT = 12;
const WORKING_MEMORY_METADATA_ARRAY_LIMIT = 8;
const WORKING_MEMORY_NON_CRITICAL_STEP_TYPES = new Set([
  "non_critical",
  "optional",
  "best_effort",
]);

function resolveEdgeExecution(result = {}) {
  return result?.execution_result && typeof result.execution_result === "object"
    ? result.execution_result
    : {};
}

function hasCanonicalExecutionData(result = {}) {
  const execution = resolveEdgeExecution(result);
  const data = execution?.data;
  return Boolean(
    data
    && typeof data === "object"
    && !Array.isArray(data)
    && (
      typeof data.answer === "string"
      || Array.isArray(data.sources)
      || Array.isArray(data.limitations)
    )
  );
}

function resolveLegacyEdgeShape(result = {}) {
  const execution = resolveEdgeExecution(result);
  if (result?.formatted_output && typeof result.formatted_output === "object" && !Array.isArray(result.formatted_output)) {
    return result.formatted_output;
  }
  if (execution?.formatted_output && typeof execution.formatted_output === "object" && !Array.isArray(execution.formatted_output)) {
    return execution.formatted_output;
  }
  return execution;
}

function withCanonicalExecutionData(result = {}, data = {}) {
  const execution = resolveEdgeExecution(result);
  return {
    ...result,
    execution_result: {
      ...execution,
      data: {
        ...(execution?.data && typeof execution.data === "object" && !Array.isArray(execution.data) ? execution.data : {}),
        ...data,
      },
    },
  };
}

function looksLikeUnsupportedReminderRequest(text = "") {
  const normalized = cleanText(text);
  if (!normalized) {
    return false;
  }
  if (!REMINDER_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return REMINDER_TIMING_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildMeetingWorkflowRecoveryResult(text = "", meetingCommand = null) {
  const action = cleanText(meetingCommand?.action || "") || "start_capture";
  const actionSource = (() => {
    if (action === "capture_status") {
      return "已辨識為會議記錄狀態確認。";
    }
    if (action === "stop_capture") {
      return "已辨識為會議流程的收尾指令。";
    }
    if (action === "confirm") {
      return "已辨識為會議確認寫入指令。";
    }
    return "已辨識為會議流程入口。";
  })();
  const nextStep = (() => {
    if (action === "capture_status") {
      return "如果你要我直接往下處理，下一句可以接著說目前會議是否已開始，或直接問我要不要停止記錄。";
    }
    if (action === "stop_capture") {
      return "如果你要我收尾這場會議，下一句可以直接補會議名稱、關鍵決策，或要不要整理成摘要。";
    }
    if (action === "confirm") {
      return "如果你要我繼續這條會議寫入流程，下一句直接補確認編號或貼上要確認的內容。";
    }
    return "如果你要我直接往下接，下一句可以直接說「開始記錄」，或補上會議名稱 / 參與者。";
  })();

  return {
    ok: true,
    action: null,
    params: {},
    execution_result: {
      ok: true,
      data: {
        answer: `這句「${text}」看起來是在啟動會議流程，我先把它當成會議工作流入口來接。`,
        sources: [actionSource],
        limitations: [nextStep],
      },
    },
    why: "strict planner decision 缺失時，先回到 checked-in meeting workflow 入口做 bounded handoff。",
    alternative: {
      action: null,
      agent_id: null,
      summary: "不直接假裝已完成會議操作，只先把入口與下一步說清楚。",
    },
  };
}

function buildExecutiveBriefRecoveryResult(text = "") {
  const normalized = cleanText(text);
  const explicitAgentRequest = resolveRegisteredAgentFamilyRequest(text, {
    includeSlashCommand: true,
    includePersonaMentions: true,
    includeKnowledgeCommands: false,
  });
  const explicitAgentId = cleanText(explicitAgentRequest?.agent?.id || "");
  const signals = [];
  if (/各個 agent|各个 agent|一起看|協作|协作|統一|统一/u.test(normalized)) {
    signals.push("已辨識到多 agent 協作 / 收斂需求。");
  }
  if (/\/ceo|高層|高层|決策|决策|拍板/u.test(normalized)) {
    signals.push("這輪帶有明確的決策或高層協作訊號。");
  }
  if (explicitAgentId && explicitAgentId !== "generalist") {
    signals.push(`這輪也帶有明確的 /${explicitAgentId} owner 訊號。`);
  }

  return {
    ok: true,
    action: null,
    params: {},
    execution_result: {
      ok: true,
      data: {
        answer: explicitAgentId && explicitAgentId !== "generalist"
          ? `這句「${text}」比較像要交給 /${explicitAgentId} 從專責角度處理，我先用 owner-aware executive brief 把目標和收斂方向接住。`
          : `這句「${text}」比較像需要多人視角收斂的 executive 任務，我先按 executive brief 的方式把目標和收斂方向接住。`,
        sources: signals.length > 0 ? signals : ["這輪比較像需要由 executive lane 接手的協作任務。"],
        limitations: [
          explicitAgentId && explicitAgentId !== "generalist"
            ? `如果你要我直接往下做，貼上素材、背景或你要的輸出格式，我就先以 /${explicitAgentId} 的角度收斂。`
            : "如果你要我直接往下做，貼上這批文件、決策題目，或你想要的最終輸出格式，我就先以 generalist 收斂。",
        ],
      },
    },
    why: "strict planner decision 缺失時，先回到 checked-in executive lane 做 owner-aware brief recovery。",
    alternative: {
      action: null,
      agent_id: explicitAgentId || "generalist",
      summary: explicitAgentId && explicitAgentId !== "generalist"
        ? `不直接假裝已完成 /${explicitAgentId} 執行，只先交付可判讀的 owner-aware brief。`
        : "不直接假裝已完成多 agent 執行，只先交付可判讀的 executive brief。",
    },
  };
}

function buildReminderNoMatchRecoveryResult(text = "") {
  return {
    ok: false,
    error: ROUTING_NO_MATCH,
    action: null,
    params: {},
    execution_result: {
      ok: false,
      data: {
        answer: "提醒類需求目前還沒有接到可驗證的 reminder runtime，所以我先不假裝已經替你設好了。",
        sources: [],
        limitations: [`如果你先補明確時間與提醒內容，我可以先把「${text}」整理成可手動建立的提醒文字。`],
      },
    },
    why: "strict planner decision 缺失時，personal reminder 類需求維持 fail-closed 並回到 routing no-match。",
    alternative: {
      action: null,
      agent_id: null,
      summary: "不假裝建立提醒，只明確說明目前邊界與可交付替代方案。",
    },
  };
}

function maybeRecoverPlannerFailedAtUsageLayer({
  plannerResult = null,
  requestText = "",
} = {}) {
  if (cleanText(plannerResult?.error || "") !== "planner_failed") {
    return plannerResult;
  }

  const meetingCommand = parseMeetingCommand(requestText);
  if (meetingCommand?.action) {
    return buildMeetingWorkflowRecoveryResult(requestText, meetingCommand);
  }

  if (looksLikeExecutiveStart(requestText)) {
    return buildExecutiveBriefRecoveryResult(requestText);
  }

  if (looksLikeUnsupportedReminderRequest(requestText)) {
    return buildReminderNoMatchRecoveryResult(requestText);
  }

  return plannerResult;
}

function adaptPlannerResultForEdge(result = {}, { requestText = "" } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result) || hasCanonicalExecutionData(result)) {
    return result;
  }

  const execution = resolveEdgeExecution(result);
  const legacyShape = resolveLegacyEdgeShape(result);
  const kind = String(legacyShape?.kind || execution?.kind || "").trim();
  const action = String(result?.action || execution?.action || "").trim();

  if (result?.ok === false || execution?.ok === false) {
    const reply = buildPlannedUserInputUserFacingReply(result, { requestText });
    return reply
      ? withCanonicalExecutionData(result, {
          answer: reply.answer,
          sources: reply.sources,
          limitations: reply.limitations,
        })
      : result;
  }

  const isRuntimeInfo = kind === "runtime_info"
    || action === "get_runtime_info"
    || typeof legacyShape?.db_path === "string"
    || Number.isFinite(legacyShape?.node_pid)
    || typeof legacyShape?.cwd === "string";
  if (isRuntimeInfo) {
    const answer = [
      "目前 runtime 有正常回應。",
      typeof legacyShape?.db_path === "string" && legacyShape.db_path ? `資料庫路徑在 ${legacyShape.db_path}。` : "",
      Number.isFinite(legacyShape?.node_pid) ? `目前 PID 是 ${legacyShape.node_pid}。` : "",
      typeof legacyShape?.cwd === "string" && legacyShape.cwd ? `工作目錄是 ${legacyShape.cwd}。` : "",
    ].filter(Boolean).join(" ");
    const limitations = [
      typeof legacyShape?.service_start_time === "string" && legacyShape.service_start_time
        ? `這是啟動於 ${legacyShape.service_start_time} 的即時 runtime 快照。`
        : "",
    ].filter(Boolean);
    return withCanonicalExecutionData(result, {
      answer,
      sources: [],
      limitations,
    });
  }

  const items = Array.isArray(legacyShape?.items)
    ? legacyShape.items
    : Array.isArray(execution?.items)
      ? execution.items
      : [];
  if (kind === "search" && items.length > 0) {
    const matchReason = String(legacyShape?.match_reason || execution?.match_reason || "").trim();
    const subject = matchReason ? `「${matchReason}」` : "這輪查詢";
    return withCanonicalExecutionData(result, {
      answer: `我已先按目前已索引的文件，標出和 ${subject} 最相關的 ${items.length} 份文件。`,
      sources: items,
      limitations: [],
    });
  }

  if (kind === "search") {
    const matchReason = String(legacyShape?.match_reason || execution?.match_reason || requestText || "").trim();
    const subject = matchReason ? `「${matchReason}」` : "這輪查詢";
    const contentSummary = String(legacyShape?.content_summary || execution?.content_summary || "").trim();
    return withCanonicalExecutionData(result, {
      answer: contentSummary || `目前沒有找到和 ${subject} 直接對應的已索引文件。`,
      sources: [],
      limitations: [],
    });
  }

  if (kind === "search_and_detail") {
    const primaryItem = items[0] || null;
    const title = String(legacyShape?.title || primaryItem?.title || "").trim();
    const matchReason = String(legacyShape?.match_reason || execution?.match_reason || requestText || "").trim();
    const subject = matchReason ? `「${matchReason}」` : "這輪查詢";
    const contentSummary = String(legacyShape?.content_summary || execution?.content_summary || "").trim();
    const answer = contentSummary
      ? `${title ? `我先找到最相關的文件「${title}」。` : "我先找到目前最相關的文件。"} ${contentSummary}`.trim()
      : title
        ? `我先找到最相關的文件「${title}」，目前看起來它和 ${subject} 最相關。`
        : `我先找到目前最相關的文件，先作為 ${subject} 的第一個候選來源。`;
    return withCanonicalExecutionData(result, {
      answer,
      sources: items,
      limitations: [],
    });
  }

  return result;
}

function isStablePlannerAnswerBoundary({
  plannerEnvelope = null,
  userResponse = null,
} = {}) {
  return Boolean(
    plannerEnvelope
    && typeof plannerEnvelope === "object"
    && !Array.isArray(plannerEnvelope)
    && userResponse
    && typeof userResponse === "object"
    && !Array.isArray(userResponse)
    && typeof userResponse.answer === "string",
  );
}

function inferWorkingMemoryTaskType(action = "") {
  const normalizedAction = cleanText(action);
  if (!normalizedAction) {
    return null;
  }
  if (normalizedAction === "get_runtime_info") {
    return "runtime_info";
  }
  if (getPlannerSkillAction(normalizedAction)) {
    return "skill_read";
  }
  if (normalizedAction === "create_doc") {
    return "doc_write";
  }
  if (
    normalizedAction === "list_company_brain_docs"
    || normalizedAction === "search_company_brain_docs"
    || normalizedAction === "search_and_detail_doc"
    || normalizedAction === "get_company_brain_doc_detail"
  ) {
    return "document_lookup";
  }
  return "general";
}

function normalizeWorkingMemoryRetryPolicy(retryPolicy = null) {
  if (!retryPolicy || typeof retryPolicy !== "object" || Array.isArray(retryPolicy)) {
    return { ...DEFAULT_WORKING_MEMORY_RETRY_POLICY };
  }
  const maxRetries = Number(retryPolicy.max_retries);
  const strategy = cleanText(retryPolicy.strategy || "");
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || !strategy) {
    return { ...DEFAULT_WORKING_MEMORY_RETRY_POLICY };
  }
  if (!["same_agent", "reroute", "same_agent_then_reroute"].includes(strategy)) {
    return { ...DEFAULT_WORKING_MEMORY_RETRY_POLICY };
  }
  return {
    max_retries: Math.floor(maxRetries),
    strategy,
  };
}

function buildWorkingMemoryTaskId() {
  return `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function buildWorkingMemorySlotTtl() {
  return new Date(Date.now() + (30 * 60 * 1000)).toISOString();
}

function isWorkingMemoryTopicSwitch({
  requestText = "",
  previousTaskType = "",
  nextTaskType = "",
} = {}) {
  const normalizedText = cleanText(requestText);
  if (!normalizedText) {
    return false;
  }
  if (WORKING_MEMORY_TOPIC_SWITCH_PATTERN.test(normalizedText)) {
    return true;
  }
  const previousType = cleanText(previousTaskType);
  const nextType = cleanText(nextTaskType);
  return Boolean(previousType && nextType && previousType !== nextType);
}

function deriveWorkingMemorySlotState({
  plannerEnvelope = null,
  userResponse = null,
  requestText = "",
  selectedAction = "",
  previousWorkingMemory = null,
} = {}) {
  const previousSlotState = Array.isArray(previousWorkingMemory?.slot_state)
    ? previousWorkingMemory.slot_state
      .filter((slot) => {
        const ttl = cleanText(slot?.ttl || "");
        if (!ttl) {
          return true;
        }
        const expiresAt = Date.parse(ttl);
        return Number.isFinite(expiresAt) && expiresAt > Date.now();
      })
      .map((slot) => ({
        slot_key: cleanText(slot?.slot_key || ""),
        required_by: cleanText(slot?.required_by || "") || null,
        status: cleanText(slot?.status || "missing") || "missing",
        source: cleanText(slot?.source || "inferred") || "inferred",
        ttl: cleanText(slot?.ttl || "") || buildWorkingMemorySlotTtl(),
      }))
      .filter((slot) => slot.slot_key && ["missing", "filled", "invalid"].includes(slot.status))
    : [];
  const normalizedRequestText = cleanText(requestText);
  const sameTaskPromptOnly = /^(繼續|继续|再來|再来|下一步|接著|接着|same task|retry)$/i.test(normalizedRequestText);
  if (
    cleanText(previousWorkingMemory?.task_phase || "") === "waiting_user"
    && normalizedRequestText
    && !sameTaskPromptOnly
  ) {
    const missingSlot = previousSlotState.find((slot) => slot.status === "missing" || slot.status === "invalid");
    if (missingSlot) {
      missingSlot.status = "filled";
      missingSlot.source = "user";
      missingSlot.ttl = buildWorkingMemorySlotTtl();
    }
  }

  const upsertSlot = (nextSlot) => {
    const existingIndex = previousSlotState.findIndex((slot) => slot.slot_key === nextSlot.slot_key);
    if (existingIndex >= 0) {
      previousSlotState[existingIndex] = nextSlot;
      return;
    }
    previousSlotState.push(nextSlot);
  };

  const derivedMissingSlots = [];
  const formatted = plannerEnvelope?.formatted_output;
  const kind = cleanText(formatted?.kind || "");
  if (kind === "search_and_detail_candidates") {
    derivedMissingSlots.push("candidate_selection_required");
  }
  if (kind === "search_and_detail_not_found") {
    derivedMissingSlots.push("missing_document_reference");
  }
  if (derivedMissingSlots.length === 0 && userResponse?.ok !== true) {
    derivedMissingSlots.push("response_not_success");
  }
  for (const slotKey of Array.from(new Set(derivedMissingSlots))) {
    upsertSlot({
      slot_key: slotKey,
      required_by: cleanText(selectedAction) || null,
      status: slotKey === "response_not_success" ? "invalid" : "missing",
      source: "inferred",
      ttl: buildWorkingMemorySlotTtl(),
    });
  }

  if (derivedMissingSlots.length === 0 && userResponse?.ok === true) {
    for (const slot of previousSlotState) {
      if (slot.status === "missing" || slot.status === "invalid") {
        slot.status = "filled";
        slot.source = "tool";
        slot.ttl = buildWorkingMemorySlotTtl();
      }
    }
  }

  return previousSlotState.slice(0, 6);
}

function deriveWorkingMemoryUnresolvedSlots({
  slotState = [],
} = {}) {
  if (!Array.isArray(slotState)) {
    return [];
  }
  return Array.from(new Set(slotState
    .filter((slot) => slot?.status === "missing" || slot?.status === "invalid")
    .map((slot) => cleanText(slot?.slot_key || ""))
    .filter(Boolean)));
}

function deriveWorkingMemoryNextBestAction({
  unresolvedSlots = [],
  selectedAction = "",
} = {}) {
  if (unresolvedSlots.includes("candidate_selection_required") || unresolvedSlots.includes("missing_document_reference")) {
    return "search_company_brain_docs";
  }
  return cleanText(selectedAction) || null;
}

function deriveWorkingMemoryConfidence({
  userResponse = null,
  unresolvedSlots = [],
} = {}) {
  if (userResponse?.ok !== true) {
    return 0.32;
  }
  if (unresolvedSlots.length > 0) {
    return 0.62;
  }
  return Array.isArray(userResponse?.sources) && userResponse.sources.length > 0
    ? 0.9
    : 0.76;
}

function buildWorkingMemoryPlanId() {
  return `plan_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function normalizeExecutionPlanStepStatus(status = "") {
  const normalized = cleanText(status);
  return WORKING_MEMORY_PLAN_STEP_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeExecutionPlanFailureClass(failureClass = null, { allowNull = true } = {}) {
  const normalized = cleanText(failureClass || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return WORKING_MEMORY_FAILURE_CLASSES.has(normalized)
    ? normalized
    : null;
}

function normalizeExecutionPlanRecoveryPolicy(recoveryPolicy = null, { allowNull = true } = {}) {
  const normalized = cleanText(recoveryPolicy || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return WORKING_MEMORY_RECOVERY_POLICIES.has(normalized)
    ? normalized
    : null;
}

function buildDefaultExecutionPlanRecoveryState() {
  return {
    last_failure_class: null,
    recovery_attempt_count: 0,
    last_recovery_action: null,
    rollback_target_step_id: null,
  };
}

function normalizeExecutionPlanRecoveryState(value = null, { allowMissing = true } = {}) {
  if ((value === null || value === undefined || value === "") && allowMissing) {
    return buildDefaultExecutionPlanRecoveryState();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized = buildDefaultExecutionPlanRecoveryState();
  if (Object.prototype.hasOwnProperty.call(value, "last_failure_class")) {
    const failureClass = normalizeExecutionPlanFailureClass(value.last_failure_class, { allowNull: true });
    if (value.last_failure_class !== null && value.last_failure_class !== undefined && value.last_failure_class !== "" && !failureClass) {
      return null;
    }
    normalized.last_failure_class = failureClass;
  }
  if (Object.prototype.hasOwnProperty.call(value, "recovery_attempt_count")) {
    const recoveryAttemptCount = Number(value.recovery_attempt_count);
    if (!Number.isFinite(recoveryAttemptCount) || recoveryAttemptCount < 0) {
      return null;
    }
    normalized.recovery_attempt_count = Math.floor(recoveryAttemptCount);
  }
  if (Object.prototype.hasOwnProperty.call(value, "last_recovery_action")) {
    const recoveryAction = cleanText(value.last_recovery_action || "");
    if (value.last_recovery_action !== null && value.last_recovery_action !== undefined && value.last_recovery_action !== ""
      && !WORKING_MEMORY_RECOVERY_ACTIONS.has(recoveryAction)) {
      return null;
    }
    normalized.last_recovery_action = recoveryAction || null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "rollback_target_step_id")) {
    normalized.rollback_target_step_id = cleanText(value.rollback_target_step_id || "") || null;
  }
  return normalized;
}

function normalizeExecutionPlanArtifactValidityStatus(value = "", { allowNull = true } = {}) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return WORKING_MEMORY_ARTIFACT_VALIDITY_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeExecutionPlanDependencyType(value = "", { allowNull = true } = {}) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return WORKING_MEMORY_DEPENDENCY_TYPES.has(normalized)
    ? normalized
    : null;
}

function normalizeExecutionPlanMetadataValue(value = null, depth = 0) {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return cleanText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > 0) {
      return undefined;
    }
    const normalizedArray = [];
    for (const item of value) {
      const normalizedItem = normalizeExecutionPlanMetadataValue(item, depth + 1);
      if (normalizedItem === undefined || Array.isArray(normalizedItem) || (normalizedItem && typeof normalizedItem === "object")) {
        return undefined;
      }
      normalizedArray.push(normalizedItem);
      if (normalizedArray.length >= WORKING_MEMORY_METADATA_ARRAY_LIMIT) {
        break;
      }
    }
    return normalizedArray;
  }
  if (value && typeof value === "object") {
    if (depth > 0) {
      return undefined;
    }
    const normalizedObject = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = cleanText(rawKey);
      if (!key) {
        continue;
      }
      const normalizedValue = normalizeExecutionPlanMetadataValue(rawValue, depth + 1);
      if (normalizedValue === undefined || (normalizedValue && typeof normalizedValue === "object" && !Array.isArray(normalizedValue))) {
        return undefined;
      }
      normalizedObject[key] = normalizedValue;
      if (Object.keys(normalizedObject).length >= WORKING_MEMORY_METADATA_KEY_LIMIT) {
        break;
      }
    }
    return normalizedObject;
  }
  return undefined;
}

function normalizeExecutionPlanMetadata(value = null, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === "") {
    return allowNull ? null : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = cleanText(rawKey);
    if (!key) {
      continue;
    }
    const normalizedValue = normalizeExecutionPlanMetadataValue(rawValue, 0);
    if (normalizedValue === undefined) {
      return null;
    }
    normalized[key] = normalizedValue;
    if (Object.keys(normalized).length >= WORKING_MEMORY_METADATA_KEY_LIMIT) {
      break;
    }
  }
  return normalized;
}

function normalizeExecutionPlanArtifact(artifact = null, { allowPartial = false } = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return null;
  }
  const hasField = (field) => Object.prototype.hasOwnProperty.call(artifact, field);
  const artifactId = cleanText(artifact.artifact_id || "");
  if (!artifactId) {
    return null;
  }
  const normalizedArtifact = {
    artifact_id: artifactId,
  };
  const artifactType = cleanText(artifact.artifact_type || "");
  if (allowPartial) {
    if (hasField("artifact_type")) {
      if (!artifactType) {
        return null;
      }
      normalizedArtifact.artifact_type = artifactType;
    }
  } else if (!artifactType) {
    return null;
  } else {
    normalizedArtifact.artifact_type = artifactType;
  }
  const producedByStepId = cleanText(artifact.produced_by_step_id || "");
  if (allowPartial) {
    if (hasField("produced_by_step_id")) {
      if (!producedByStepId) {
        return null;
      }
      normalizedArtifact.produced_by_step_id = producedByStepId;
    }
  } else if (!producedByStepId) {
    return null;
  } else {
    normalizedArtifact.produced_by_step_id = producedByStepId;
  }
  const validityStatus = normalizeExecutionPlanArtifactValidityStatus(artifact.validity_status, {
    allowNull: false,
  });
  if (allowPartial) {
    if (hasField("validity_status")) {
      if (!validityStatus) {
        return null;
      }
      normalizedArtifact.validity_status = validityStatus;
    }
  } else if (!validityStatus) {
    return null;
  } else {
    normalizedArtifact.validity_status = validityStatus;
  }
  const consumedByStepIds = Array.isArray(artifact.consumed_by_step_ids)
    ? artifact.consumed_by_step_ids.map((item) => cleanText(item)).filter(Boolean)
    : null;
  if (allowPartial) {
    if (hasField("consumed_by_step_ids")) {
      if (!Array.isArray(consumedByStepIds)) {
        return null;
      }
      normalizedArtifact.consumed_by_step_ids = Array.from(new Set(consumedByStepIds));
    }
  } else if (!Array.isArray(consumedByStepIds)) {
    return null;
  } else {
    normalizedArtifact.consumed_by_step_ids = Array.from(new Set(consumedByStepIds));
  }
  if (allowPartial) {
    if (hasField("supersedes_artifact_id")) {
      normalizedArtifact.supersedes_artifact_id = cleanText(artifact.supersedes_artifact_id || "") || null;
    }
  } else {
    normalizedArtifact.supersedes_artifact_id = cleanText(artifact.supersedes_artifact_id || "") || null;
  }
  const metadata = normalizeExecutionPlanMetadata(artifact.metadata, { allowNull: true });
  if (allowPartial) {
    if (hasField("metadata")) {
      if (artifact.metadata !== null && artifact.metadata !== undefined && artifact.metadata !== "" && metadata === null) {
        return null;
      }
      normalizedArtifact.metadata = metadata;
    }
  } else {
    if (artifact.metadata !== null && artifact.metadata !== undefined && artifact.metadata !== "" && metadata === null) {
      return null;
    }
    normalizedArtifact.metadata = metadata;
  }
  return normalizedArtifact;
}

function normalizeExecutionPlanArtifacts(artifacts = [], { allowPartial = false, allowMissing = true } = {}) {
  if ((artifacts === null || artifacts === undefined || artifacts === "") && allowMissing) {
    return [];
  }
  if (!Array.isArray(artifacts)) {
    return null;
  }
  const normalizedArtifacts = [];
  const seenArtifactIds = new Set();
  for (const artifact of artifacts) {
    const normalizedArtifact = normalizeExecutionPlanArtifact(artifact, { allowPartial });
    if (!normalizedArtifact) {
      return null;
    }
    if (seenArtifactIds.has(normalizedArtifact.artifact_id)) {
      return null;
    }
    seenArtifactIds.add(normalizedArtifact.artifact_id);
    normalizedArtifacts.push(normalizedArtifact);
    if (normalizedArtifacts.length >= WORKING_MEMORY_PLAN_ARTIFACT_LIMIT) {
      break;
    }
  }
  return normalizedArtifacts;
}

function normalizeExecutionPlanDependencyEdge(edge = null) {
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
    return null;
  }
  const fromStepId = cleanText(edge.from_step_id || "");
  const toStepId = cleanText(edge.to_step_id || "");
  const viaArtifactId = cleanText(edge.via_artifact_id || "");
  const dependencyType = normalizeExecutionPlanDependencyType(edge.dependency_type, {
    allowNull: false,
  });
  if (!fromStepId || !toStepId || !viaArtifactId || !dependencyType) {
    return null;
  }
  return {
    from_step_id: fromStepId,
    to_step_id: toStepId,
    via_artifact_id: viaArtifactId,
    dependency_type: dependencyType,
  };
}

function normalizeExecutionPlanDependencyEdges(edges = [], { allowMissing = true } = {}) {
  if ((edges === null || edges === undefined || edges === "") && allowMissing) {
    return [];
  }
  if (!Array.isArray(edges)) {
    return null;
  }
  const normalizedEdges = [];
  const seenKeys = new Set();
  for (const edge of edges) {
    const normalizedEdge = normalizeExecutionPlanDependencyEdge(edge);
    if (!normalizedEdge) {
      return null;
    }
    const edgeKey = `${normalizedEdge.from_step_id}->${normalizedEdge.to_step_id}#${normalizedEdge.via_artifact_id}`;
    if (seenKeys.has(edgeKey)) {
      return null;
    }
    seenKeys.add(edgeKey);
    normalizedEdges.push(normalizedEdge);
    if (normalizedEdges.length >= WORKING_MEMORY_PLAN_EDGE_LIMIT) {
      break;
    }
  }
  return normalizedEdges;
}

function validateExecutionPlanGraph(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return false;
  }
  const stepIds = new Set(Array.isArray(plan.steps) ? plan.steps.map((step) => step.step_id) : []);
  const planId = cleanText(plan.plan_id || "");
  const artifacts = Array.isArray(plan.artifacts) ? plan.artifacts : [];
  const dependencyEdges = Array.isArray(plan.dependency_edges) ? plan.dependency_edges : [];
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const canUseArchivedStep = (stepId = "", artifact = null) => {
    const normalizedStepId = cleanText(stepId || "");
    if (!normalizedStepId) {
      return false;
    }
    if (stepIds.has(normalizedStepId)) {
      return true;
    }
    const artifactPlanId = cleanText(artifact?.metadata?.plan_id || "");
    return Boolean(artifactPlanId && planId && artifactPlanId !== planId);
  };
  for (const artifact of artifacts) {
    if (!artifact?.artifact_id
      || !artifact?.artifact_type
      || !artifact?.produced_by_step_id
      || !WORKING_MEMORY_ARTIFACT_VALIDITY_STATUSES.has(cleanText(artifact?.validity_status || ""))) {
      return false;
    }
    if (!canUseArchivedStep(artifact.produced_by_step_id, artifact)) {
      return false;
    }
    for (const consumedStepId of Array.isArray(artifact.consumed_by_step_ids) ? artifact.consumed_by_step_ids : []) {
      if (!canUseArchivedStep(consumedStepId, artifact)) {
        return false;
      }
    }
  }
  for (const artifact of artifacts) {
    const supersedesId = cleanText(artifact?.supersedes_artifact_id || "");
    if (supersedesId && !artifactMap.has(supersedesId)) {
      return false;
    }
  }
  for (const edge of dependencyEdges) {
    const artifact = artifactMap.get(edge.via_artifact_id);
    if (!artifact) {
      return false;
    }
    if (!canUseArchivedStep(edge.from_step_id, artifact) || !canUseArchivedStep(edge.to_step_id, artifact)) {
      return false;
    }
    if (stepIds.has(edge.from_step_id)
      && stepIds.has(artifact.produced_by_step_id)
      && edge.from_step_id !== artifact.produced_by_step_id) {
      return false;
    }
  }
  return true;
}

function normalizeExecutionPlan(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  const planId = cleanText(plan.plan_id || "");
  const planStatus = cleanText(plan.plan_status || "");
  if (!planId || !WORKING_MEMORY_PLAN_STATUSES.has(planStatus)) {
    return null;
  }
  const steps = Array.isArray(plan.steps)
    ? plan.steps
        .map((step) => {
          const stepId = cleanText(step?.step_id || "");
          const stepType = cleanText(step?.step_type || "");
          const ownerAgent = cleanText(step?.owner_agent || "");
          const intendedAction = cleanText(step?.intended_action || "");
          const status = normalizeExecutionPlanStepStatus(step?.status || "");
          if (!stepId || !stepType || !ownerAgent || !intendedAction || !status) {
            return null;
          }
          const dependsOn = Array.isArray(step.depends_on)
            ? step.depends_on.map((item) => cleanText(item)).filter(Boolean)
            : [];
          const artifactRefs = Array.isArray(step.artifact_refs)
            ? step.artifact_refs.map((item) => cleanText(item)).filter(Boolean)
            : [];
          const slotRequirements = Array.isArray(step.slot_requirements)
            ? step.slot_requirements.map((item) => cleanText(item)).filter(Boolean)
            : [];
          const failureClass = normalizeExecutionPlanFailureClass(step?.failure_class, { allowNull: true });
          const recoveryPolicy = normalizeExecutionPlanRecoveryPolicy(step?.recovery_policy, { allowNull: true });
          const recoveryState = normalizeExecutionPlanRecoveryState(step?.recovery_state, { allowMissing: true });
          if ((step?.failure_class !== null && step?.failure_class !== undefined && step?.failure_class !== "" && !failureClass)
            || (step?.recovery_policy !== null && step?.recovery_policy !== undefined && step?.recovery_policy !== "" && !recoveryPolicy)
            || !recoveryState) {
            return null;
          }
          return {
            step_id: stepId,
            step_type: stepType,
            owner_agent: ownerAgent,
            intended_action: intendedAction,
            status,
            depends_on: Array.from(new Set(dependsOn)),
            retryable: step.retryable !== false,
            artifact_refs: Array.from(new Set(artifactRefs)),
            slot_requirements: Array.from(new Set(slotRequirements)),
            failure_class: failureClass,
            recovery_policy: recoveryPolicy,
            recovery_state: recoveryState,
          };
        })
        .filter(Boolean)
    : [];
  const artifacts = normalizeExecutionPlanArtifacts(plan.artifacts, {
    allowPartial: false,
    allowMissing: true,
  });
  const dependencyEdges = normalizeExecutionPlanDependencyEdges(plan.dependency_edges, {
    allowMissing: true,
  });
  if (steps.length === 0 && planStatus !== "completed" && planStatus !== "invalidated") {
    return null;
  }
  if (!Array.isArray(artifacts) || !Array.isArray(dependencyEdges)) {
    return null;
  }
  const currentStepId = cleanText(plan.current_step_id || "") || null;
  if (currentStepId && !steps.some((step) => step.step_id === currentStepId)) {
    return null;
  }
  const normalizedPlan = {
    plan_id: planId,
    plan_status: planStatus,
    current_step_id: currentStepId,
    steps,
    artifacts,
    dependency_edges: dependencyEdges,
  };
  if (!validateExecutionPlanGraph(normalizedPlan)) {
    return null;
  }
  return normalizedPlan;
}

function collectExecutionPlanActions({
  plannerResult = null,
  plannerEnvelope = null,
  selectedAction = "",
  previousPlan = null,
} = {}) {
  const decisionSteps = Array.isArray(plannerResult?.steps)
    ? plannerResult.steps
    : Array.isArray(plannerEnvelope?.steps)
      ? plannerEnvelope.steps
      : Array.isArray(plannerResult?.execution_result?.steps)
        ? plannerResult.execution_result.steps
        : [];
  const plannedActions = decisionSteps
    .map((step) => cleanText(step?.action || ""))
    .filter(Boolean);
  if (plannedActions.length > 0) {
    return plannedActions;
  }
  if (previousPlan?.steps?.length) {
    const actions = previousPlan.steps.map((step) => cleanText(step.intended_action)).filter(Boolean);
    const nextSelectedAction = cleanText(selectedAction);
    if (nextSelectedAction && !actions.includes(nextSelectedAction)) {
      actions.push(nextSelectedAction);
    }
    return actions;
  }
  if (cleanText(selectedAction)) {
    return [cleanText(selectedAction)];
  }
  return [];
}

function collectExecutionPlanArtifactRefs({
  userResponse = null,
  plannerEnvelope = null,
  plannerResult = null,
} = {}) {
  const refs = [];
  const append = (value) => {
    const normalized = cleanText(value);
    if (normalized) {
      refs.push(normalized);
    }
  };
  for (const source of Array.isArray(userResponse?.sources) ? userResponse.sources : []) {
    if (typeof source === "string") {
      append(source);
      continue;
    }
    append(source?.doc_id || source?.id || source?.title || source?.name);
  }
  for (const item of Array.isArray(plannerEnvelope?.formatted_output?.items)
    ? plannerEnvelope.formatted_output.items
    : []) {
    append(item?.doc_id || item?.id || item?.title || item?.name);
  }
  const traceId = cleanText(plannerResult?.trace_id || plannerResult?.execution_result?.trace_id || "");
  if (traceId) {
    append(`trace:${traceId}`);
  }
  return Array.from(new Set(refs)).slice(0, 8);
}

function resolveExecutionPlanArtifactType(step = null) {
  const intendedAction = cleanText(step?.intended_action || "");
  if (intendedAction.includes("search")) {
    return "search_result";
  }
  if (intendedAction.includes("detail") || intendedAction.includes("read")) {
    return "document_detail";
  }
  if (intendedAction.includes("runtime")) {
    return "runtime_snapshot";
  }
  return "step_output";
}

function buildExecutionPlanArtifactId({ stepId = "", existingArtifacts = [] } = {}) {
  const normalizedStepId = cleanText(stepId || "");
  if (!normalizedStepId) {
    return null;
  }
  const prefix = `${normalizedStepId}_artifact_`;
  let maxSuffix = 0;
  for (const artifact of existingArtifacts) {
    const artifactId = cleanText(artifact?.artifact_id || "");
    if (!artifactId || !artifactId.startsWith(prefix)) {
      continue;
    }
    const suffix = Number(artifactId.slice(prefix.length));
    if (Number.isFinite(suffix) && suffix > maxSuffix) {
      maxSuffix = suffix;
    }
  }
  return `${prefix}${maxSuffix + 1}`;
}

function resolveExecutionPlanActiveArtifactScope({
  artifacts = [],
  planId = "",
} = {}) {
  const normalizedPlanId = cleanText(planId || "");
  return Array.isArray(artifacts)
    ? artifacts.filter((artifact) => {
        const artifactPlanId = cleanText(artifact?.metadata?.plan_id || "");
        return !artifactPlanId || !normalizedPlanId || artifactPlanId === normalizedPlanId;
      })
    : [];
}

function resolveExecutionPlanLatestArtifactForStep({
  artifacts = [],
  planId = "",
  stepId = "",
} = {}) {
  const normalizedStepId = cleanText(stepId || "");
  if (!normalizedStepId) {
    return null;
  }
  const scopedArtifacts = resolveExecutionPlanActiveArtifactScope({
    artifacts,
    planId,
  }).filter((artifact) => cleanText(artifact?.produced_by_step_id || "") === normalizedStepId);
  if (scopedArtifacts.length === 0) {
    return null;
  }
  const preferred = scopedArtifacts
    .slice()
    .reverse()
    .find((artifact) => {
      const validityStatus = cleanText(artifact?.validity_status || "");
      return validityStatus === "valid" || validityStatus === "missing" || validityStatus === "invalid";
    });
  return preferred || scopedArtifacts[scopedArtifacts.length - 1];
}

function buildExecutionPlanDependencyEdgeKey(edge = null) {
  const fromStepId = cleanText(edge?.from_step_id || "");
  const toStepId = cleanText(edge?.to_step_id || "");
  const viaArtifactId = cleanText(edge?.via_artifact_id || "");
  if (!fromStepId || !toStepId || !viaArtifactId) {
    return null;
  }
  return `${fromStepId}->${toStepId}#${viaArtifactId}`;
}

function deriveExecutionPlanDependencyType({
  toStep = null,
} = {}) {
  return isNonCriticalExecutionPlanStep(toStep)
    ? "soft"
    : "hard";
}

function ensureMissingDependencyArtifact({
  artifacts = [],
  planId = "",
  producerStepId = "",
} = {}) {
  const normalizedProducerStepId = cleanText(producerStepId || "");
  if (!normalizedProducerStepId) {
    return null;
  }
  const artifactId = `${normalizedProducerStepId}_artifact_missing`;
  const existing = artifacts.find((artifact) => cleanText(artifact?.artifact_id || "") === artifactId) || null;
  if (existing) {
    return existing;
  }
  const fallbackArtifact = {
    artifact_id: artifactId,
    artifact_type: "missing_dependency",
    produced_by_step_id: normalizedProducerStepId,
    validity_status: "missing",
    consumed_by_step_ids: [],
    supersedes_artifact_id: null,
    metadata: {
      plan_id: cleanText(planId || "") || null,
      synthetic: true,
    },
  };
  artifacts.push(fallbackArtifact);
  return fallbackArtifact;
}

function buildExecutionPlanGraphState({
  planId = "",
  steps = [],
  previousArtifacts = [],
  previousDependencyEdges = [],
} = {}) {
  const normalizedPlanId = cleanText(planId || "");
  const stepMap = new Map(Array.isArray(steps) ? steps.map((step) => [step.step_id, step]) : []);
  const stepIds = new Set(Array.from(stepMap.keys()));
  const artifacts = Array.isArray(previousArtifacts)
    ? previousArtifacts.map((artifact) => {
        const producedByStepId = cleanText(artifact?.produced_by_step_id || "") || null;
        const metadata = artifact?.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
          ? { ...artifact.metadata }
          : {};
        if (!cleanText(metadata.plan_id || "")) {
          metadata.plan_id = producedByStepId && stepIds.has(producedByStepId)
            ? normalizedPlanId || null
            : producedByStepId
              ? `archived_${producedByStepId}`
              : "archived_unknown";
        }
        return {
          ...artifact,
          metadata,
          consumed_by_step_ids: Array.isArray(artifact?.consumed_by_step_ids)
            ? Array.from(new Set(artifact.consumed_by_step_ids.map((item) => cleanText(item)).filter(Boolean)))
            : [],
        };
      })
    : [];
  const activeEdges = [];
  for (const toStep of steps) {
    const dependsOn = Array.isArray(toStep?.depends_on)
      ? toStep.depends_on.map((item) => cleanText(item)).filter(Boolean)
      : [];
    for (const fromStepId of dependsOn) {
      const fromStep = stepMap.get(fromStepId) || null;
      if (!fromStep) {
        continue;
      }
      const latestArtifact = resolveExecutionPlanLatestArtifactForStep({
        artifacts,
        planId: normalizedPlanId,
        stepId: fromStepId,
      }) || ensureMissingDependencyArtifact({
        artifacts,
        planId: normalizedPlanId,
        producerStepId: fromStepId,
      });
      const viaArtifactId = cleanText(latestArtifact?.artifact_id || "");
      if (!viaArtifactId) {
        continue;
      }
      activeEdges.push({
        from_step_id: fromStepId,
        to_step_id: toStep.step_id,
        via_artifact_id: viaArtifactId,
        dependency_type: deriveExecutionPlanDependencyType({ toStep }),
      });
    }
  }
  const archivedEdges = Array.isArray(previousDependencyEdges)
    ? previousDependencyEdges.filter((edge) => {
        const fromStepId = cleanText(edge?.from_step_id || "");
        const toStepId = cleanText(edge?.to_step_id || "");
        if (!fromStepId || !toStepId) {
          return false;
        }
        return !stepIds.has(fromStepId) && !stepIds.has(toStepId);
      })
    : [];
  const mergedEdges = [];
  const seenEdgeKeys = new Set();
  for (const edge of [...archivedEdges, ...activeEdges]) {
    const normalizedEdge = normalizeExecutionPlanDependencyEdge(edge);
    if (!normalizedEdge) {
      continue;
    }
    const edgeKey = buildExecutionPlanDependencyEdgeKey(normalizedEdge);
    if (!edgeKey || seenEdgeKeys.has(edgeKey)) {
      continue;
    }
    seenEdgeKeys.add(edgeKey);
    mergedEdges.push(normalizedEdge);
    if (mergedEdges.length >= WORKING_MEMORY_PLAN_EDGE_LIMIT) {
      break;
    }
  }
  const consumedByMap = new Map();
  for (const edge of mergedEdges) {
    if (!consumedByMap.has(edge.via_artifact_id)) {
      consumedByMap.set(edge.via_artifact_id, new Set());
    }
    consumedByMap.get(edge.via_artifact_id).add(edge.to_step_id);
  }
  const normalizedArtifacts = artifacts
    .map((artifact) => {
      const artifactId = cleanText(artifact?.artifact_id || "");
      if (!artifactId) {
        return null;
      }
      return {
        ...artifact,
        consumed_by_step_ids: Array.from(consumedByMap.get(artifactId) || []),
      };
    })
    .filter(Boolean)
    .slice(0, WORKING_MEMORY_PLAN_ARTIFACT_LIMIT);
  return {
    artifacts: normalizedArtifacts,
    dependency_edges: mergedEdges,
  };
}

function buildExecutionPlanStepTransitions(previousPlan = null, nextPlan = null) {
  const basePlan = normalizeExecutionPlan(previousPlan);
  const currentPlan = normalizeExecutionPlan(nextPlan);
  if (!currentPlan) {
    return null;
  }
  const baseMap = new Map((basePlan?.steps || []).map((step) => [step.step_id, step.status]));
  const currentMap = new Map(currentPlan.steps.map((step) => [step.step_id, step.status]));
  const transitions = [];
  const stepIds = Array.from(new Set([
    ...Array.from(baseMap.keys()),
    ...Array.from(currentMap.keys()),
  ]));
  for (const stepId of stepIds) {
    const from = baseMap.has(stepId) ? baseMap.get(stepId) : null;
    const to = currentMap.has(stepId) ? currentMap.get(stepId) : null;
    if (from !== to) {
      transitions.push({
        step_id: stepId,
        from,
        to,
      });
    }
  }
  const fromCurrent = cleanText(basePlan?.current_step_id || "") || null;
  const toCurrent = cleanText(currentPlan.current_step_id || "") || null;
  if (transitions.length === 0 && fromCurrent === toCurrent) {
    return null;
  }
  return {
    from_current_step_id: fromCurrent,
    to_current_step_id: toCurrent,
    steps: transitions,
  };
}

function deriveFailureClassFromPlannerError(plannerError = "") {
  const normalizedError = cleanText(plannerError || "");
  if (!normalizedError) {
    return null;
  }
  if (normalizedError === "tool_error" || normalizedError === "runtime_exception") {
    return "tool_error";
  }
  if (normalizedError === "request_timeout" || normalizedError === "timeout" || normalizedError === "request_cancelled") {
    return "timeout";
  }
  if (normalizedError === "invalid_artifact" || normalizedError === "artifact_invalid") {
    return "invalid_artifact";
  }
  if (normalizedError === "missing_slot") {
    return "missing_slot";
  }
  if (normalizedError === "owner_mismatch") {
    return "capability_gap";
  }
  if (normalizedError === "capability_gap") {
    return "capability_gap";
  }
  return "unknown";
}

function deriveWorkingMemoryFailureClass({
  plannerError = "",
  unresolvedSlots = [],
  plannerEnvelope = null,
  userResponse = null,
  previousOwner = null,
  currentOwner = null,
} = {}) {
  if (Array.isArray(unresolvedSlots) && unresolvedSlots.length > 0) {
    return "missing_slot";
  }
  const errorFailureClass = deriveFailureClassFromPlannerError(plannerError);
  if (errorFailureClass) {
    return errorFailureClass;
  }
  if (cleanText(previousOwner || "") && cleanText(currentOwner || "") && cleanText(previousOwner || "") !== cleanText(currentOwner || "")
    && (plannerEnvelope?.ok === false || userResponse?.ok !== true)) {
    return "capability_gap";
  }
  if (plannerEnvelope?.ok === false || userResponse?.ok !== true) {
    return "unknown";
  }
  return null;
}

function isNonCriticalExecutionPlanStep(step = null) {
  const stepType = cleanText(step?.step_type || "");
  return WORKING_MEMORY_NON_CRITICAL_STEP_TYPES.has(stepType);
}

function resolveExecutionPlanRollbackTargetStepId({
  step = null,
  stepMap = new Map(),
  artifacts = [],
  dependencyEdges = [],
  fallbackPreviousStepId = null,
} = {}) {
  const stepId = cleanText(step?.step_id || "");
  const artifactMap = new Map(Array.isArray(artifacts)
    ? artifacts.map((artifact) => [cleanText(artifact?.artifact_id || ""), artifact]).filter(([artifactId]) => Boolean(artifactId))
    : []);
  const hardIncomingEdges = Array.isArray(dependencyEdges)
    ? dependencyEdges.filter((edge) =>
      cleanText(edge?.to_step_id || "") === stepId
      && cleanText(edge?.dependency_type || "") === "hard")
    : [];
  for (const edge of hardIncomingEdges) {
    const artifact = artifactMap.get(cleanText(edge?.via_artifact_id || ""));
    const producerStepId = cleanText(artifact?.produced_by_step_id || "");
    if (producerStepId && stepMap.has(producerStepId)) {
      return producerStepId;
    }
  }
  const dependsOn = Array.isArray(step?.depends_on)
    ? step.depends_on.map((item) => cleanText(item)).filter(Boolean)
    : [];
  for (let index = dependsOn.length - 1; index >= 0; index -= 1) {
    const candidate = dependsOn[index];
    if (candidate && stepMap.has(candidate)) {
      return candidate;
    }
  }
  const artifactRefs = Array.isArray(step?.artifact_refs)
    ? step.artifact_refs.map((item) => cleanText(item)).filter(Boolean)
    : [];
  for (const ref of artifactRefs) {
    const matched = ref.match(/^step:(.+)$/i) || ref.match(/^from_step:(.+)$/i);
    const stepId = cleanText(matched?.[1] || "");
    if (stepId && stepMap.has(stepId)) {
      return stepId;
    }
  }
  const fallbackStepId = cleanText(fallbackPreviousStepId || "");
  return fallbackStepId && stepMap.has(fallbackStepId)
    ? fallbackStepId
    : null;
}

function resolveExecutionPlanRecoveryDecision({
  failureClass = null,
  step = null,
  stepMap = new Map(),
  artifacts = [],
  dependencyEdges = [],
  activeStepIndex = null,
  steps = [],
  previousRetryCount = 0,
  retryPolicy = DEFAULT_WORKING_MEMORY_RETRY_POLICY,
  previousOwner = null,
  currentOwner = null,
} = {}) {
  if (!failureClass || !step) {
    return {
      recovery_action: null,
      recovery_policy: null,
      rollback_target_step_id: null,
      reroute_owner_agent: null,
    };
  }

  if (failureClass === "missing_slot") {
    return {
      recovery_action: "ask_user",
      recovery_policy: "ask_user",
      rollback_target_step_id: null,
      reroute_owner_agent: null,
    };
  }

  if (failureClass === "capability_gap") {
    const rerouteOwner = cleanText(currentOwner || "") || cleanText(previousOwner || "") || cleanText(step.owner_agent || "") || null;
    return {
      recovery_action: "reroute_owner",
      recovery_policy: "reroute_owner",
      rollback_target_step_id: null,
      reroute_owner_agent: rerouteOwner,
    };
  }

  if (failureClass === "invalid_artifact") {
    const fallbackPreviousStepId = activeStepIndex !== null && activeStepIndex > 0
      ? cleanText(steps[activeStepIndex - 1]?.step_id || "") || null
      : null;
    const rollbackTargetStepId = resolveExecutionPlanRollbackTargetStepId({
      step,
      stepMap,
      artifacts,
      dependencyEdges,
      fallbackPreviousStepId,
    });
    if (rollbackTargetStepId) {
      return {
        recovery_action: "rollback_to_step",
        recovery_policy: "rollback_to_step",
        rollback_target_step_id: rollbackTargetStepId,
        reroute_owner_agent: null,
      };
    }
    return {
      recovery_action: "ask_user",
      recovery_policy: "ask_user",
      rollback_target_step_id: null,
      reroute_owner_agent: null,
    };
  }

  if (failureClass === "tool_error" || failureClass === "timeout") {
    const retryBudget = Number.isFinite(Number(retryPolicy?.max_retries))
      ? Number(retryPolicy.max_retries)
      : DEFAULT_WORKING_MEMORY_RETRY_POLICY.max_retries;
    if (step.retryable !== false && Number(previousRetryCount) < retryBudget) {
      return {
        recovery_action: "retry_same_step",
        recovery_policy: "retry_same_step",
        rollback_target_step_id: null,
        reroute_owner_agent: null,
      };
    }
    if (isNonCriticalExecutionPlanStep(step)) {
      return {
        recovery_action: "skip_step",
        recovery_policy: "skip_step",
        rollback_target_step_id: null,
        reroute_owner_agent: null,
      };
    }
    const ownerAgent = cleanText(step.owner_agent || "");
    if (ownerAgent && ownerAgent !== "planner_agent") {
      return {
        recovery_action: "reroute_owner",
        recovery_policy: "reroute_owner",
        rollback_target_step_id: null,
        reroute_owner_agent: cleanText(previousOwner || "") || ownerAgent || null,
      };
    }
    return {
      recovery_action: "ask_user",
      recovery_policy: "ask_user",
      rollback_target_step_id: null,
      reroute_owner_agent: null,
    };
  }

  return {
    recovery_action: "ask_user",
    recovery_policy: "ask_user",
    rollback_target_step_id: null,
    reroute_owner_agent: null,
  };
}

function buildWorkingMemoryExecutionPlanPatch({
  plannerResult = null,
  plannerEnvelope = null,
  userResponse = null,
  previousWorkingMemory = null,
  selectedAction = "",
  currentOwner = null,
  previousOwner = null,
  unresolvedSlots = [],
  topicSwitch = false,
  phaseAndStatus = { phase: "planning", status: "running" },
  failureClass = null,
  previousRetryCount = 0,
  retryPolicy = DEFAULT_WORKING_MEMORY_RETRY_POLICY,
} = {}) {
  const previousPlan = normalizeExecutionPlan(previousWorkingMemory?.execution_plan);
  const planActions = collectExecutionPlanActions({
    plannerResult,
    plannerEnvelope,
    selectedAction,
    previousPlan,
  });
  if (planActions.length === 0) {
    return {
      patch: null,
      phaseAndStatus,
      current_owner_agent: cleanText(currentOwner || previousWorkingMemory?.current_owner_agent || "") || null,
      observability: {
        plan_id: null,
        plan_status: null,
        current_step: null,
        step_transition: null,
        plan_invalidated: null,
        failure_class: null,
        recovery_policy: null,
        recovery_action: null,
        recovery_attempt_count: null,
        rollback_target_step_id: null,
        skipped_step_ids: null,
        artifact_id: null,
        artifact_type: null,
        validity_status: null,
        produced_by_step_id: null,
        affected_downstream_steps: null,
        dependency_type: null,
        artifact_superseded: false,
        dependency_blocked_step: null,
        resumed_from_waiting_user: false,
        resumed_from_retry: false,
      },
    };
  }

  const planId = (topicSwitch || !previousPlan)
    ? buildWorkingMemoryPlanId()
    : previousPlan.plan_id;
  const ownerAgent = cleanText(currentOwner || previousWorkingMemory?.current_owner_agent || previousWorkingMemory?.last_selected_agent || "") || "planner_agent";
  const runtimeResult = plannerResult?.execution_result && typeof plannerResult.execution_result === "object"
    ? plannerResult.execution_result
    : {};
  const runtimeCurrentStepIndex = Number.isInteger(runtimeResult.current_step_index)
    ? Number(runtimeResult.current_step_index)
    : null;
  const runtimeStoppedAtStep = Number.isInteger(runtimeResult.stopped_at_step)
    ? Number(runtimeResult.stopped_at_step)
    : null;
  const previousSteps = Array.isArray(previousPlan?.steps) ? previousPlan.steps : [];
  const previousArtifacts = Array.isArray(previousPlan?.artifacts) ? previousPlan.artifacts : [];
  const previousDependencyEdges = Array.isArray(previousPlan?.dependency_edges) ? previousPlan.dependency_edges : [];
  const usedPreviousStepIds = new Set();
  const steps = [];
  for (let index = 0; index < planActions.length; index += 1) {
    const action = planActions[index];
    const previousByIndex = previousSteps[index];
    const previousByAction = previousSteps.find((step) =>
      step.intended_action === action && !usedPreviousStepIds.has(step.step_id));
    const previousStep = previousByIndex?.intended_action === action
      ? previousByIndex
      : previousByAction || null;
    if (previousStep?.step_id) {
      usedPreviousStepIds.add(previousStep.step_id);
    }
    const stepId = topicSwitch
      ? `${planId}_step_${index + 1}`
      : cleanText(previousStep?.step_id || "") || `${planId}_step_${index + 1}`;
    const dependsOn = Array.isArray(previousStep?.depends_on) && previousStep.depends_on.length > 0
      ? previousStep.depends_on.map((item) => cleanText(item)).filter(Boolean)
      : index > 0
        ? [steps[index - 1].step_id]
        : [];
    const previousFailureClass = normalizeExecutionPlanFailureClass(previousStep?.failure_class, { allowNull: true });
    const previousRecoveryPolicy = normalizeExecutionPlanRecoveryPolicy(previousStep?.recovery_policy, { allowNull: true });
    const previousRecoveryState = normalizeExecutionPlanRecoveryState(previousStep?.recovery_state, { allowMissing: true })
      || buildDefaultExecutionPlanRecoveryState();
    steps.push({
      step_id: stepId,
      step_type: cleanText(previousStep?.step_type || "") || "planner_action",
      owner_agent: cleanText(previousStep?.owner_agent || "") || ownerAgent,
      intended_action: action,
      status: normalizeExecutionPlanStepStatus(previousStep?.status || "") || "pending",
      depends_on: dependsOn,
      retryable: previousStep?.retryable !== false,
      artifact_refs: Array.isArray(previousStep?.artifact_refs) ? previousStep.artifact_refs.slice(0, 8) : [],
      slot_requirements: Array.isArray(previousStep?.slot_requirements) ? previousStep.slot_requirements.slice(0, 6) : [],
      failure_class: previousFailureClass,
      recovery_policy: previousRecoveryPolicy,
      recovery_state: previousRecoveryState,
    });
  }

  if (steps.length === 0) {
    return {
      patch: null,
      phaseAndStatus,
      current_owner_agent: null,
      observability: {
        plan_id: null,
        plan_status: null,
        current_step: null,
        step_transition: null,
        plan_invalidated: null,
        failure_class: null,
        recovery_policy: null,
        recovery_action: null,
        recovery_attempt_count: null,
        rollback_target_step_id: null,
        skipped_step_ids: null,
        artifact_id: null,
        artifact_type: null,
        validity_status: null,
        produced_by_step_id: null,
        affected_downstream_steps: null,
        dependency_type: null,
        artifact_superseded: false,
        dependency_blocked_step: null,
        resumed_from_waiting_user: false,
        resumed_from_retry: false,
      },
    };
  }

  const completedCount = runtimeCurrentStepIndex !== null
    ? Math.max(0, Math.min(runtimeCurrentStepIndex, steps.length))
    : 0;
  for (let index = 0; index < completedCount; index += 1) {
    steps[index].status = "completed";
  }
  const selectedStepIndex = selectedAction
    ? steps.findIndex((step) => step.intended_action === selectedAction)
    : -1;
  const successfulTurnWithoutRuntimeIndex = runtimeCurrentStepIndex === null
    && selectedStepIndex >= 0
    && userResponse?.ok === true
    && phaseAndStatus.phase !== "waiting_user"
    && phaseAndStatus.phase !== "failed"
    && !failureClass;
  if (successfulTurnWithoutRuntimeIndex) {
    for (let index = 0; index < selectedStepIndex; index += 1) {
      if (steps[index].status !== "completed" && steps[index].status !== "skipped") {
        steps[index].status = "completed";
      }
    }
    steps[selectedStepIndex].status = "completed";
  }
  if (runtimeStoppedAtStep !== null && steps[runtimeStoppedAtStep]) {
    steps[runtimeStoppedAtStep].status = "failed";
  }

  let activeStepIndex = (() => {
    if (runtimeStoppedAtStep !== null && steps[runtimeStoppedAtStep]) {
      return runtimeStoppedAtStep;
    }
    if (runtimeCurrentStepIndex !== null && runtimeCurrentStepIndex >= 0 && runtimeCurrentStepIndex < steps.length) {
      return runtimeCurrentStepIndex;
    }
    if (successfulTurnWithoutRuntimeIndex && selectedStepIndex >= 0) {
      const nextIndex = selectedStepIndex + 1;
      if (nextIndex < steps.length) {
        return nextIndex;
      }
      return null;
    }
    if (selectedStepIndex >= 0) {
      return selectedStepIndex;
    }
    return steps.findIndex((step) => step.status !== "completed" && step.status !== "skipped");
  })();

  if (activeStepIndex < 0) {
    activeStepIndex = null;
  }

  let resolvedPhaseAndStatus = {
    phase: cleanText(phaseAndStatus?.phase || "") || "planning",
    status: cleanText(phaseAndStatus?.status || "") || "running",
  };
  let resolvedOwnerAgent = cleanText(currentOwner || "") || ownerAgent;
  let appliedRecoveryAction = null;
  let appliedRecoveryPolicy = null;
  let appliedRollbackTargetStepId = null;
  let appliedRecoveryAttemptCount = null;
  let graphState = buildExecutionPlanGraphState({
    planId,
    steps,
    previousArtifacts,
    previousDependencyEdges,
  });
  const activeStep = activeStepIndex !== null
    ? steps[activeStepIndex]
    : null;
  const hasFailure = Boolean(failureClass);
  if (activeStep && hasFailure) {
    const stepMap = new Map(steps.map((step) => [step.step_id, step]));
    const recoveryDecision = resolveExecutionPlanRecoveryDecision({
      failureClass,
      step: activeStep,
      stepMap,
      artifacts: graphState.artifacts,
      dependencyEdges: graphState.dependency_edges,
      activeStepIndex,
      steps,
      previousRetryCount,
      retryPolicy,
      previousOwner,
      currentOwner,
    });
    const previousRecoveryState = normalizeExecutionPlanRecoveryState(activeStep.recovery_state, { allowMissing: true })
      || buildDefaultExecutionPlanRecoveryState();
    const nextRecoveryAttemptCount = Number(previousRecoveryState.recovery_attempt_count || 0) + 1;
    activeStep.failure_class = failureClass;
    activeStep.recovery_policy = recoveryDecision.recovery_policy || null;
    activeStep.recovery_state = {
      ...previousRecoveryState,
      last_failure_class: failureClass,
      recovery_attempt_count: nextRecoveryAttemptCount,
      last_recovery_action: recoveryDecision.recovery_action || "failed",
      rollback_target_step_id: recoveryDecision.rollback_target_step_id || null,
    };
    appliedRecoveryAction = recoveryDecision.recovery_action || "failed";
    appliedRecoveryPolicy = recoveryDecision.recovery_policy || null;
    appliedRollbackTargetStepId = recoveryDecision.rollback_target_step_id || null;
    appliedRecoveryAttemptCount = nextRecoveryAttemptCount;
    if (appliedRecoveryAction === "ask_user") {
      steps[activeStepIndex].status = "blocked";
      steps[activeStepIndex].slot_requirements = Array.from(new Set(unresolvedSlots)).slice(0, 6);
      resolvedPhaseAndStatus = { phase: "waiting_user", status: "blocked" };
    } else if (appliedRecoveryAction === "retry_same_step") {
      steps[activeStepIndex].status = "failed";
      resolvedPhaseAndStatus = { phase: "retrying", status: "failed" };
    } else if (appliedRecoveryAction === "reroute_owner") {
      steps[activeStepIndex].status = "failed";
      const rerouteOwnerAgent = cleanText(recoveryDecision.reroute_owner_agent || "") || null;
      if (rerouteOwnerAgent) {
        steps[activeStepIndex].owner_agent = rerouteOwnerAgent;
        resolvedOwnerAgent = rerouteOwnerAgent;
      }
      resolvedPhaseAndStatus = { phase: "retrying", status: "failed" };
    } else if (appliedRecoveryAction === "skip_step" && isNonCriticalExecutionPlanStep(activeStep)) {
      steps[activeStepIndex].status = "skipped";
      steps[activeStepIndex].recovery_state.last_recovery_action = "skip_step";
      let nextStepIndex = null;
      for (let index = activeStepIndex + 1; index < steps.length; index += 1) {
        if (steps[index].status !== "completed" && steps[index].status !== "skipped") {
          nextStepIndex = index;
          break;
        }
      }
      activeStepIndex = nextStepIndex;
      if (activeStepIndex !== null && steps[activeStepIndex] && steps[activeStepIndex].status === "pending") {
        steps[activeStepIndex].status = "running";
      }
      resolvedPhaseAndStatus = { phase: "executing", status: "running" };
    } else if (appliedRecoveryAction === "rollback_to_step" && appliedRollbackTargetStepId) {
      const rollbackTargetIndex = steps.findIndex((step) => step.step_id === appliedRollbackTargetStepId);
      if (rollbackTargetIndex >= 0) {
        for (let index = rollbackTargetIndex; index < steps.length; index += 1) {
          if (index === rollbackTargetIndex) {
            steps[index].status = "running";
          } else if (steps[index].status !== "completed") {
            steps[index].status = "pending";
          }
        }
        activeStepIndex = rollbackTargetIndex;
        resolvedPhaseAndStatus = { phase: "executing", status: "running" };
      } else {
        appliedRecoveryAction = "ask_user";
        steps[activeStepIndex].status = "blocked";
        steps[activeStepIndex].slot_requirements = Array.from(new Set(unresolvedSlots)).slice(0, 6);
        resolvedPhaseAndStatus = { phase: "waiting_user", status: "blocked" };
      }
    } else {
      steps[activeStepIndex].status = "failed";
      steps[activeStepIndex].recovery_state.last_recovery_action = "failed";
      appliedRecoveryAction = "failed";
      resolvedPhaseAndStatus = { phase: "failed", status: "failed" };
    }
  } else if (activeStepIndex !== null) {
    if (resolvedPhaseAndStatus.phase === "waiting_user") {
      steps[activeStepIndex].status = "blocked";
      steps[activeStepIndex].slot_requirements = Array.from(new Set(unresolvedSlots)).slice(0, 6);
    } else if (resolvedPhaseAndStatus.phase === "failed") {
      steps[activeStepIndex].status = "failed";
    } else if (resolvedPhaseAndStatus.phase === "executing" || resolvedPhaseAndStatus.phase === "retrying") {
      if (steps[activeStepIndex].status !== "completed") {
        steps[activeStepIndex].status = "running";
      }
      steps[activeStepIndex].slot_requirements = Array.from(new Set(unresolvedSlots)).slice(0, 6);
    }
  }

  const artifactRefs = collectExecutionPlanArtifactRefs({
    userResponse,
    plannerEnvelope,
    plannerResult,
  });
  const previousStepStatusMap = new Map(previousSteps.map((step) => [step.step_id, cleanText(step?.status || "") || null]));
  const producedStepIds = steps
    .filter((step) => {
      const previousStatus = previousStepStatusMap.get(step.step_id);
      return cleanText(step?.status || "") === "completed" && previousStatus !== "completed";
    })
    .map((step) => step.step_id);
  const mutableArtifacts = Array.isArray(graphState.artifacts)
    ? graphState.artifacts.map((artifact) => ({ ...artifact }))
    : [];
  let observedArtifactId = null;
  let observedDependencyType = null;
  let observedAffectedDownstreamSteps = null;
  let observedDependencyBlockedStep = null;
  let observedArtifactSuperseded = false;
  for (const stepId of producedStepIds) {
    const producerStep = steps.find((step) => step.step_id === stepId) || null;
    if (!producerStep) {
      continue;
    }
    const previousArtifact = resolveExecutionPlanLatestArtifactForStep({
      artifacts: mutableArtifacts,
      planId,
      stepId,
    });
    if (previousArtifact) {
      previousArtifact.validity_status = "superseded";
      observedArtifactSuperseded = true;
    }
    const nextArtifactId = buildExecutionPlanArtifactId({
      stepId,
      existingArtifacts: mutableArtifacts,
    });
    if (!nextArtifactId) {
      continue;
    }
    mutableArtifacts.push({
      artifact_id: nextArtifactId,
      artifact_type: resolveExecutionPlanArtifactType(producerStep),
      produced_by_step_id: stepId,
      validity_status: "valid",
      consumed_by_step_ids: [],
      supersedes_artifact_id: cleanText(previousArtifact?.artifact_id || "") || null,
      metadata: {
        plan_id: planId,
        source_refs: artifactRefs,
      },
    });
    producerStep.artifact_refs = Array.from(new Set([
      nextArtifactId,
      ...artifactRefs,
    ])).slice(0, 8);
    observedArtifactId = nextArtifactId;
  }
  if (producedStepIds.length === 0) {
    const artifactStepIndex = activeStepIndex !== null
      ? activeStepIndex
      : Math.max(0, steps.length - 1);
    if (steps[artifactStepIndex] && artifactRefs.length > 0) {
      steps[artifactStepIndex].artifact_refs = Array.from(new Set([
        ...steps[artifactStepIndex].artifact_refs,
        ...artifactRefs,
      ])).slice(0, 8);
    }
  }
  graphState = buildExecutionPlanGraphState({
    planId,
    steps,
    previousArtifacts: mutableArtifacts,
    previousDependencyEdges: graphState.dependency_edges,
  });
  if (hasFailure && failureClass === "invalid_artifact" && activeStep) {
    const activeStepId = cleanText(activeStep.step_id || "");
    const artifactMap = new Map(graphState.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
    const hardIncomingEdges = graphState.dependency_edges.filter((edge) =>
      cleanText(edge?.to_step_id || "") === activeStepId
      && cleanText(edge?.dependency_type || "") === "hard");
    const impactedArtifactIds = hardIncomingEdges
      .map((edge) => cleanText(edge?.via_artifact_id || ""))
      .filter((artifactId) => artifactId && artifactMap.has(artifactId));
    const fallbackArtifactIds = Array.isArray(activeStep.artifact_refs)
      ? activeStep.artifact_refs
          .map((artifactId) => cleanText(artifactId || ""))
          .filter((artifactId) => artifactId && artifactMap.has(artifactId))
      : [];
    const targetArtifactIds = Array.from(new Set(
      impactedArtifactIds.length > 0 ? impactedArtifactIds : fallbackArtifactIds,
    ));
    for (const artifactId of targetArtifactIds) {
      const artifact = artifactMap.get(artifactId);
      if (!artifact) {
        continue;
      }
      artifact.validity_status = "invalid";
      observedArtifactId = artifactId;
      observedDependencyType = "hard";
    }
    graphState = buildExecutionPlanGraphState({
      planId,
      steps,
      previousArtifacts: graphState.artifacts,
      previousDependencyEdges: graphState.dependency_edges,
    });
    if (targetArtifactIds.length > 0) {
      const affectedDownstreamSteps = graphState.dependency_edges
        .filter((edge) =>
          targetArtifactIds.includes(cleanText(edge?.via_artifact_id || ""))
          && cleanText(edge?.dependency_type || "") === "hard")
        .map((edge) => cleanText(edge?.to_step_id || ""))
        .filter(Boolean);
      const uniqueAffectedDownstreamSteps = Array.from(new Set(affectedDownstreamSteps));
      observedAffectedDownstreamSteps = uniqueAffectedDownstreamSteps.length > 0
        ? uniqueAffectedDownstreamSteps
        : null;
      observedDependencyBlockedStep = uniqueAffectedDownstreamSteps.find((stepId) => {
        const stepStatus = cleanText((steps.find((step) => step.step_id === stepId) || {}).status || "");
        return stepStatus === "blocked" || stepStatus === "failed" || stepStatus === "running";
      }) || cleanText(activeStep.step_id || "") || null;
    }
  }
  const observedArtifact = observedArtifactId
    ? graphState.artifacts.find((artifact) => artifact.artifact_id === observedArtifactId) || null
    : null;
  if (!observedDependencyType && observedArtifact) {
    const hardEdgeCount = graphState.dependency_edges.filter((edge) =>
      edge.via_artifact_id === observedArtifact.artifact_id && edge.dependency_type === "hard").length;
    const softEdgeCount = graphState.dependency_edges.filter((edge) =>
      edge.via_artifact_id === observedArtifact.artifact_id && edge.dependency_type === "soft").length;
    observedDependencyType = hardEdgeCount > 0
      ? "hard"
      : softEdgeCount > 0
        ? "soft"
        : null;
  }
  if (!observedAffectedDownstreamSteps && observedArtifact) {
    const downstreamSteps = graphState.dependency_edges
      .filter((edge) => edge.via_artifact_id === observedArtifact.artifact_id)
      .map((edge) => cleanText(edge?.to_step_id || ""))
      .filter(Boolean);
    observedAffectedDownstreamSteps = downstreamSteps.length > 0
      ? Array.from(new Set(downstreamSteps))
      : null;
  }

  const allStepsCompleted = steps.every((step) => step.status === "completed" || step.status === "skipped");
  const planStatus = (() => {
    if (allStepsCompleted || resolvedPhaseAndStatus.phase === "done") {
      return "completed";
    }
    if (resolvedPhaseAndStatus.phase === "waiting_user") {
      return "paused";
    }
    if (resolvedPhaseAndStatus.phase === "failed" || appliedRecoveryAction === "failed") {
      return "paused";
    }
    return "active";
  })();
  const currentStepId = planStatus === "completed"
    ? null
    : activeStepIndex !== null
      ? steps[activeStepIndex].step_id
      : steps.find((step) => step.status !== "completed" && step.status !== "skipped")?.step_id || null;
  const nextPlan = {
    plan_id: planId,
    plan_status: planStatus,
    current_step_id: currentStepId,
    steps,
    artifacts: graphState.artifacts,
    dependency_edges: graphState.dependency_edges,
  };
  const previousPhase = cleanText(previousWorkingMemory?.task_phase || "");
  const previousStatus = cleanText(previousWorkingMemory?.task_status || "");
  const stepTransition = buildExecutionPlanStepTransitions(previousPlan, nextPlan);
  const skippedStepIds = Array.isArray(stepTransition?.steps)
    ? stepTransition.steps
        .filter((step) => cleanText(step?.to || "") === "skipped")
        .map((step) => cleanText(step?.step_id || ""))
        .filter(Boolean)
    : [];
  return {
    patch: nextPlan,
    phaseAndStatus: resolvedPhaseAndStatus,
    current_owner_agent: resolvedOwnerAgent,
    observability: {
      plan_id: nextPlan.plan_id,
      plan_status: nextPlan.plan_status,
      current_step: nextPlan.current_step_id,
      step_transition: stepTransition,
      plan_invalidated: topicSwitch && previousPlan
        ? {
            plan_id: previousPlan.plan_id,
            reason: "topic_switch",
          }
        : null,
      failure_class: hasFailure ? failureClass : null,
      recovery_policy: appliedRecoveryPolicy,
      recovery_action: appliedRecoveryAction,
      recovery_attempt_count: appliedRecoveryAttemptCount,
      rollback_target_step_id: appliedRollbackTargetStepId,
      skipped_step_ids: skippedStepIds.length > 0 ? skippedStepIds : null,
      artifact_id: observedArtifact?.artifact_id || null,
      artifact_type: observedArtifact?.artifact_type || null,
      validity_status: observedArtifact?.validity_status || null,
      produced_by_step_id: observedArtifact?.produced_by_step_id || null,
      affected_downstream_steps: observedAffectedDownstreamSteps,
      dependency_type: observedDependencyType,
      artifact_superseded: observedArtifactSuperseded === true,
      dependency_blocked_step: observedDependencyBlockedStep,
      resumed_from_waiting_user: previousPhase === "waiting_user"
        && resolvedPhaseAndStatus.phase === "executing",
      resumed_from_retry: (previousPhase === "retrying" || previousStatus === "failed")
        && resolvedPhaseAndStatus.phase === "executing",
    },
  };
}

function buildWorkingMemoryPatch({
  requestText = "",
  plannerResult = null,
  plannerEnvelope = null,
  userResponse = null,
  previousWorkingMemory = null,
} = {}) {
  const selectedAction = cleanText(
    plannerEnvelope?.action
    || plannerResult?.action
    || plannerEnvelope?.trace?.chosen_action
    || "",
  );
  const taskType = inferWorkingMemoryTaskType(selectedAction)
    || cleanText(previousWorkingMemory?.task_type || previousWorkingMemory?.inferred_task_type || "")
    || "general";
  const topicSwitch = isWorkingMemoryTopicSwitch({
    requestText,
    previousTaskType: cleanText(previousWorkingMemory?.task_type || previousWorkingMemory?.inferred_task_type || ""),
    nextTaskType: taskType,
  });
  const previousTaskId = cleanText(previousWorkingMemory?.task_id || "") || null;
  const taskId = (!previousTaskId || topicSwitch)
    ? buildWorkingMemoryTaskId()
    : previousTaskId;
  const slotState = deriveWorkingMemorySlotState({
    plannerEnvelope,
    userResponse,
    requestText,
    selectedAction,
    previousWorkingMemory,
  });
  const unresolvedSlots = deriveWorkingMemoryUnresolvedSlots({
    slotState,
  });
  const unresolvedUserSlots = unresolvedSlots.filter((slotKey) => cleanText(slotKey || "") !== "response_not_success");
  const selectedSkill = getPlannerSkillAction(selectedAction)
    ? selectedAction
    : null;
  const previousOwner = cleanText(previousWorkingMemory?.current_owner_agent || previousWorkingMemory?.last_selected_agent || "") || null;
  const currentOwner = cleanText(plannerResult?.synthetic_agent_hint?.agent || previousOwner || "") || null;
  const retryPolicy = normalizeWorkingMemoryRetryPolicy(previousWorkingMemory?.retry_policy);
  const previousRetryCount = Number.isFinite(Number(previousWorkingMemory?.retry_count))
    ? Number(previousWorkingMemory.retry_count)
    : 0;
  const plannerError = cleanText(
    plannerEnvelope?.execution_result?.error
    || plannerEnvelope?.error
    || plannerResult?.execution_result?.error
    || plannerResult?.error
    || "",
  );
  const failureClass = deriveWorkingMemoryFailureClass({
    plannerError,
    unresolvedSlots: unresolvedUserSlots,
    plannerEnvelope,
    userResponse,
    previousOwner,
    currentOwner,
  });
  const hasMissingSlots = unresolvedUserSlots.length > 0;
  const initialPhaseAndStatus = (() => {
    if (hasMissingSlots) {
      return { phase: "waiting_user", status: "blocked" };
    }
    if (failureClass === "tool_error" || failureClass === "timeout") {
      return {
        phase: previousRetryCount + 1 < retryPolicy.max_retries ? "retrying" : "failed",
        status: "failed",
      };
    }
    if (failureClass === "capability_gap" || failureClass === "invalid_artifact" || failureClass === "unknown") {
      return {
        phase: "failed",
        status: "failed",
      };
    }
    if (plannerEnvelope?.ok === false || userResponse?.ok !== true) {
      return {
        phase: "failed",
        status: "failed",
      };
    }
    if (selectedAction === "mark_resolved" || WORKING_MEMORY_DONE_PATTERN.test(cleanText(requestText))) {
      return { phase: "done", status: "completed" };
    }
    if (selectedAction) {
      return { phase: "executing", status: "running" };
    }
    return { phase: "planning", status: "running" };
  })();
  const previousAbandonedTaskIds = Array.isArray(previousWorkingMemory?.abandoned_task_ids)
    ? previousWorkingMemory.abandoned_task_ids
        .map((task) => cleanText(task))
        .filter(Boolean)
    : [];
  const abandonedTaskIds = topicSwitch && previousTaskId
    ? Array.from(new Set([...previousAbandonedTaskIds, previousTaskId])).slice(-8)
    : previousAbandonedTaskIds;
  const toolSummary = cleanText(
    plannerEnvelope?.formatted_output?.content_summary
    || plannerResult?.formatted_output?.content_summary
    || userResponse?.answer
    || "",
  );
  const executionPlan = buildWorkingMemoryExecutionPlanPatch({
    plannerResult,
    plannerEnvelope,
    userResponse,
    previousWorkingMemory,
    selectedAction,
    currentOwner,
    previousOwner,
    unresolvedSlots: unresolvedUserSlots,
    topicSwitch,
    phaseAndStatus: initialPhaseAndStatus,
    failureClass,
    previousRetryCount,
    retryPolicy,
  });
  const resolvedPhaseAndStatus = executionPlan.phaseAndStatus
    && typeof executionPlan.phaseAndStatus === "object"
    && !Array.isArray(executionPlan.phaseAndStatus)
    ? executionPlan.phaseAndStatus
    : initialPhaseAndStatus;
  const recoveryAction = cleanText(executionPlan.observability?.recovery_action || "") || null;
  const recoveryAttempted = Boolean(failureClass) && (
    recoveryAction === "retry_same_step"
    || recoveryAction === "reroute_owner"
    || recoveryAction === "rollback_to_step"
    || recoveryAction === "skip_step"
  );
  const nextRetryCount = recoveryAttempted
    ? previousRetryCount + 1
    : userResponse?.ok === true
      ? 0
      : previousRetryCount;
  const resolvedCurrentOwner = cleanText(executionPlan.current_owner_agent || currentOwner || "") || null;
  const handoffReason = recoveryAction === "ask_user" || hasMissingSlots
    ? "needs_user_input"
    : recoveryAction === "reroute_owner" || failureClass === "capability_gap"
      ? "capability_gap"
      : recoveryAttempted
        ? "retry"
        : resolvedCurrentOwner && previousOwner && resolvedCurrentOwner !== previousOwner
          ? "capability_gap"
          : null;
  const patch = {
    current_goal: cleanText(requestText) || previousWorkingMemory?.current_goal || null,
    inferred_task_type: taskType,
    last_selected_agent: resolvedCurrentOwner,
    last_selected_skill: selectedSkill,
    last_tool_result_summary: toolSummary || null,
    unresolved_slots: unresolvedUserSlots,
    slot_state: slotState,
    next_best_action: deriveWorkingMemoryNextBestAction({
      unresolvedSlots: unresolvedUserSlots,
      selectedAction,
    }),
    confidence: deriveWorkingMemoryConfidence({
      userResponse,
      unresolvedSlots,
    }),
    task_id: taskId,
    task_type: taskType,
    task_phase: resolvedPhaseAndStatus.phase,
    task_status: resolvedPhaseAndStatus.status,
    current_owner_agent: resolvedCurrentOwner,
    previous_owner_agent: handoffReason ? previousOwner : cleanText(previousWorkingMemory?.previous_owner_agent || "") || null,
    handoff_reason: handoffReason,
    retry_count: nextRetryCount,
    retry_policy: retryPolicy,
    abandoned_task_ids: abandonedTaskIds,
    ...(executionPlan.patch
      ? { execution_plan: executionPlan.patch }
      : {}),
  };
  const previousPhase = cleanText(previousWorkingMemory?.task_phase || "") || null;
  const previousStatus = cleanText(previousWorkingMemory?.task_status || "") || null;
  const readinessFromExecution = (() => {
    const readinessCandidate = plannerEnvelope?.execution_result?.data?.readiness
      || plannerResult?.execution_result?.data?.readiness
      || null;
    return readinessCandidate
      && typeof readinessCandidate === "object"
      && !Array.isArray(readinessCandidate)
      ? readinessCandidate
      : null;
  })();
  const observability = {
    task_id: taskId,
    task_phase_transition: previousPhase && previousPhase !== patch.task_phase
      ? `${previousPhase}->${patch.task_phase}`
      : null,
    task_status_transition: previousStatus && previousStatus !== patch.task_status
      ? `${previousStatus}->${patch.task_status}`
      : null,
    agent_handoff: handoffReason
      ? {
          from: previousOwner,
          to: resolvedCurrentOwner,
          reason: handoffReason,
        }
      : null,
    retry_attempt: recoveryAttempted
      ? {
          from: previousRetryCount,
          retry_count: nextRetryCount,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: recoveryAction === "reroute_owner" ? "reroute" : "same_step",
        }
      : null,
    slot_update: {
      pending_slots: unresolvedUserSlots,
      slot_state_count: slotState.length,
    },
    plan_id: executionPlan.observability?.plan_id || null,
    plan_status: executionPlan.observability?.plan_status || null,
    current_step: executionPlan.observability?.current_step || null,
    step_transition: executionPlan.observability?.step_transition || null,
    plan_invalidated: executionPlan.observability?.plan_invalidated || null,
    failure_class: executionPlan.observability?.failure_class || null,
    recovery_policy: executionPlan.observability?.recovery_policy || null,
    recovery_action: executionPlan.observability?.recovery_action || null,
    recovery_attempt_count: executionPlan.observability?.recovery_attempt_count ?? null,
    rollback_target_step_id: executionPlan.observability?.rollback_target_step_id || null,
    skipped_step_ids: executionPlan.observability?.skipped_step_ids || null,
    artifact_id: executionPlan.observability?.artifact_id || null,
    artifact_type: executionPlan.observability?.artifact_type || null,
    validity_status: executionPlan.observability?.validity_status || null,
    produced_by_step_id: executionPlan.observability?.produced_by_step_id || null,
    affected_downstream_steps: executionPlan.observability?.affected_downstream_steps || null,
    dependency_type: executionPlan.observability?.dependency_type || null,
    artifact_superseded: executionPlan.observability?.artifact_superseded === true,
    dependency_blocked_step: executionPlan.observability?.dependency_blocked_step || null,
    readiness: readinessFromExecution
      ? {
          is_ready: readinessFromExecution.is_ready === true,
          blocking_reason_codes: Array.isArray(readinessFromExecution.blocking_reason_codes)
            ? readinessFromExecution.blocking_reason_codes
            : [],
          missing_slots: Array.isArray(readinessFromExecution.missing_slots)
            ? readinessFromExecution.missing_slots
            : [],
          invalid_artifacts: Array.isArray(readinessFromExecution.invalid_artifacts)
            ? readinessFromExecution.invalid_artifacts
            : [],
          blocked_dependencies: Array.isArray(readinessFromExecution.blocked_dependencies)
            ? readinessFromExecution.blocked_dependencies
            : [],
          owner_ready: readinessFromExecution.owner_ready !== false,
          recovery_ready: readinessFromExecution.recovery_ready !== false,
          recommended_action: cleanText(readinessFromExecution.recommended_action || "") || null,
        }
      : null,
    blocking_reason_codes: Array.isArray(readinessFromExecution?.blocking_reason_codes)
      ? readinessFromExecution.blocking_reason_codes
      : [],
    missing_slots: Array.isArray(readinessFromExecution?.missing_slots)
      ? readinessFromExecution.missing_slots
      : [],
    invalid_artifacts: Array.isArray(readinessFromExecution?.invalid_artifacts)
      ? readinessFromExecution.invalid_artifacts
      : [],
    blocked_dependencies: Array.isArray(readinessFromExecution?.blocked_dependencies)
      ? readinessFromExecution.blocked_dependencies
      : [],
    owner_ready: typeof readinessFromExecution?.owner_ready === "boolean"
      ? readinessFromExecution.owner_ready
      : null,
    recovery_ready: typeof readinessFromExecution?.recovery_ready === "boolean"
      ? readinessFromExecution.recovery_ready
      : null,
    recommended_action: cleanText(readinessFromExecution?.recommended_action || "") || null,
    resumed_from_waiting_user: executionPlan.observability?.resumed_from_waiting_user === true,
    resumed_from_retry: executionPlan.observability?.resumed_from_retry === true,
    task_abandoned: topicSwitch && previousTaskId
      ? {
          task_id: previousTaskId,
          reason: "topic_switch",
        }
      : null,
  };
  if (Array.isArray(unresolvedSlots) && unresolvedSlots.length > unresolvedUserSlots.length) {
    observability.slot_update = {
      pending_slots: unresolvedUserSlots,
      slot_state_count: slotState.length,
      technical_slots: unresolvedSlots.filter((slotKey) => cleanText(slotKey || "") === "response_not_success"),
    };
  }
  return {
    patch,
    observability,
  };
}

export async function runPlannerUserInputEdge({
  text = "",
  logger = console,
  contentReader,
  baseUrl,
  authContext = null,
  signal = null,
  sessionKey = "",
  requestId = "",
  telemetryAdapter = null,
  traceId = null,
  handlerName = null,
  plannerExecutor = executePlannedUserInput,
  envelopeBuilder = buildPlannedUserInputEnvelope,
  responseNormalizer = normalizeUserResponse,
  envelopeDecorator = null,
  workingMemoryWriter = applyPlannerWorkingMemoryPatch,
} = {}) {
  const executedPlannerResult = await plannerExecutor({
    text,
    logger,
    contentReader,
    baseUrl,
    authContext,
    signal,
    sessionKey,
    requestId,
    telemetryAdapter,
  });
  const recoveredPlannerResult = maybeRecoverPlannerFailedAtUsageLayer({
    plannerResult: executedPlannerResult,
    requestText: text,
  });
  const plannerResult = adaptPlannerResultForEdge(recoveredPlannerResult, {
    requestText: text,
  });

  const baseEnvelope = envelopeBuilder(plannerResult);
  const plannerEnvelope = typeof envelopeDecorator === "function"
    ? envelopeDecorator(baseEnvelope, plannerResult)
    : baseEnvelope;
  const userResponse = responseNormalizer({
    plannerResult,
    plannerEnvelope,
    requestText: text,
    logger,
    traceId,
    handlerName,
  });
  const shouldWriteWorkingMemory = isStablePlannerAnswerBoundary({
    plannerEnvelope,
    userResponse,
  });
  let memoryWriteResult = {
    ok: false,
    observability: {
      memory_write_attempted: false,
      memory_write_succeeded: false,
      memory_snapshot: null,
    },
  };
  let derivedMemoryObservability = {
    task_id: null,
    task_phase_transition: null,
    task_status_transition: null,
    agent_handoff: null,
    retry_attempt: null,
    slot_update: null,
    plan_id: null,
    plan_status: null,
    current_step: null,
    step_transition: null,
    plan_invalidated: null,
    failure_class: null,
    recovery_policy: null,
    recovery_action: null,
    recovery_attempt_count: null,
    rollback_target_step_id: null,
    skipped_step_ids: null,
    artifact_id: null,
    artifact_type: null,
    validity_status: null,
    produced_by_step_id: null,
    affected_downstream_steps: null,
    dependency_type: null,
    artifact_superseded: false,
    dependency_blocked_step: null,
    readiness: null,
    blocking_reason_codes: [],
    missing_slots: [],
    invalid_artifacts: [],
    blocked_dependencies: [],
    owner_ready: null,
    recovery_ready: null,
    recommended_action: null,
    resumed_from_waiting_user: false,
    resumed_from_retry: false,
    task_abandoned: null,
  };
  let previousWorkingMemory = null;
  if (shouldWriteWorkingMemory && typeof workingMemoryWriter === "function") {
    const previousWorkingMemoryRead = readPlannerWorkingMemoryForRouting({
      sessionKey,
    });
    previousWorkingMemory = previousWorkingMemoryRead?.ok === true
      && previousWorkingMemoryRead?.data
      && typeof previousWorkingMemoryRead.data === "object"
      && !Array.isArray(previousWorkingMemoryRead.data)
      ? previousWorkingMemoryRead.data
      : null;
    const memoryPatchPayload = buildWorkingMemoryPatch({
      requestText: text,
      plannerResult,
      plannerEnvelope,
      userResponse,
      previousWorkingMemory,
    });
    derivedMemoryObservability = {
      ...derivedMemoryObservability,
      ...(memoryPatchPayload?.observability && typeof memoryPatchPayload.observability === "object"
        ? memoryPatchPayload.observability
        : {}),
    };
    memoryWriteResult = await workingMemoryWriter({
      patch: memoryPatchPayload.patch,
      sessionKey,
      source: "planner_answer_boundary_v1",
    }) || memoryWriteResult;
  }
  const mergedMemoryObservability = {
    ...derivedMemoryObservability,
    ...(memoryWriteResult?.observability && typeof memoryWriteResult.observability === "object"
      ? memoryWriteResult.observability
      : {}),
  };
  const taskTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    memorySnapshot: mergedMemoryObservability.memory_snapshot || null,
    previousMemorySnapshot: previousWorkingMemory,
    observability: mergedMemoryObservability,
  });
  logger?.info?.("planner_working_memory", {
    stage: "planner_working_memory",
    memory_stage: "answer_boundary_write_back",
    session_key: cleanText(sessionKey) || null,
    memory_write_attempted: shouldWriteWorkingMemory && typeof workingMemoryWriter === "function",
    memory_write_succeeded: memoryWriteResult?.ok === true,
    memory_snapshot: mergedMemoryObservability.memory_snapshot || null,
    task_id: mergedMemoryObservability.task_id || null,
    task_phase_transition: mergedMemoryObservability.task_phase_transition || null,
    task_status_transition: mergedMemoryObservability.task_status_transition || null,
    agent_handoff: mergedMemoryObservability.agent_handoff || null,
    retry_attempt: mergedMemoryObservability.retry_attempt || null,
    slot_update: mergedMemoryObservability.slot_update || null,
    plan_id: mergedMemoryObservability.plan_id || null,
    plan_status: mergedMemoryObservability.plan_status || null,
    current_step: mergedMemoryObservability.current_step || null,
    step_transition: mergedMemoryObservability.step_transition || null,
    plan_invalidated: mergedMemoryObservability.plan_invalidated || null,
    failure_class: mergedMemoryObservability.failure_class || null,
    recovery_policy: mergedMemoryObservability.recovery_policy || null,
    recovery_action: mergedMemoryObservability.recovery_action || null,
    recovery_attempt_count: Number.isFinite(Number(mergedMemoryObservability.recovery_attempt_count))
      ? Number(mergedMemoryObservability.recovery_attempt_count)
      : null,
    rollback_target_step_id: mergedMemoryObservability.rollback_target_step_id || null,
    skipped_step_ids: Array.isArray(mergedMemoryObservability.skipped_step_ids)
      ? mergedMemoryObservability.skipped_step_ids
      : null,
    artifact_id: mergedMemoryObservability.artifact_id || null,
    artifact_type: mergedMemoryObservability.artifact_type || null,
    validity_status: mergedMemoryObservability.validity_status || null,
    produced_by_step_id: mergedMemoryObservability.produced_by_step_id || null,
    affected_downstream_steps: Array.isArray(mergedMemoryObservability.affected_downstream_steps)
      ? mergedMemoryObservability.affected_downstream_steps
      : null,
    dependency_type: mergedMemoryObservability.dependency_type || null,
    artifact_superseded: mergedMemoryObservability.artifact_superseded === true,
    dependency_blocked_step: mergedMemoryObservability.dependency_blocked_step || null,
    readiness: mergedMemoryObservability.readiness || null,
    blocking_reason_codes: Array.isArray(mergedMemoryObservability.blocking_reason_codes)
      ? mergedMemoryObservability.blocking_reason_codes
      : [],
    missing_slots: Array.isArray(mergedMemoryObservability.missing_slots)
      ? mergedMemoryObservability.missing_slots
      : [],
    invalid_artifacts: Array.isArray(mergedMemoryObservability.invalid_artifacts)
      ? mergedMemoryObservability.invalid_artifacts
      : [],
    blocked_dependencies: Array.isArray(mergedMemoryObservability.blocked_dependencies)
      ? mergedMemoryObservability.blocked_dependencies
      : [],
    owner_ready: typeof mergedMemoryObservability.owner_ready === "boolean"
      ? mergedMemoryObservability.owner_ready
      : null,
    recovery_ready: typeof mergedMemoryObservability.recovery_ready === "boolean"
      ? mergedMemoryObservability.recovery_ready
      : null,
    recommended_action: cleanText(mergedMemoryObservability.recommended_action || "") || null,
    resumed_from_waiting_user: mergedMemoryObservability.resumed_from_waiting_user === true,
    resumed_from_retry: mergedMemoryObservability.resumed_from_retry === true,
    task_abandoned: mergedMemoryObservability.task_abandoned || null,
    task_trace_summary: taskTrace.summary,
    task_trace_diff: taskTrace.diff,
    task_trace_snapshot: taskTrace.snapshot,
    task_trace_text: taskTrace.text,
    task_trace_event_alignment: taskTrace.event_alignment,
  });

  return {
    plannerResult,
    plannerEnvelope,
    userResponse,
  };
}
