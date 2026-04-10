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
const WORKING_MEMORY_RETRYABLE_ERRORS = new Set([
  "tool_error",
  "runtime_exception",
]);
const DEFAULT_WORKING_MEMORY_RETRY_POLICY = Object.freeze({
  max_retries: 2,
  strategy: "same_agent_then_reroute",
});

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
  const retryableFailure = WORKING_MEMORY_RETRYABLE_ERRORS.has(plannerError);
  const nextRetryCount = retryableFailure
    ? previousRetryCount + 1
    : userResponse?.ok === true
      ? 0
      : previousRetryCount;
  const hasMissingSlots = unresolvedSlots.length > 0;
  const phaseAndStatus = (() => {
    if (hasMissingSlots) {
      return { phase: "waiting_user", status: "blocked" };
    }
    if (retryableFailure) {
      return {
        phase: nextRetryCount < retryPolicy.max_retries ? "retrying" : "failed",
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
  const handoffReason = retryableFailure
    ? "retry"
    : hasMissingSlots
      ? "needs_user_input"
      : currentOwner && previousOwner && currentOwner !== previousOwner
        ? "capability_gap"
        : null;
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
  const patch = {
    current_goal: cleanText(requestText) || previousWorkingMemory?.current_goal || null,
    inferred_task_type: taskType,
    last_selected_agent: currentOwner,
    last_selected_skill: selectedSkill,
    last_tool_result_summary: toolSummary || null,
    unresolved_slots: unresolvedSlots,
    slot_state: slotState,
    next_best_action: deriveWorkingMemoryNextBestAction({
      unresolvedSlots,
      selectedAction,
    }),
    confidence: deriveWorkingMemoryConfidence({
      userResponse,
      unresolvedSlots,
    }),
    task_id: taskId,
    task_type: taskType,
    task_phase: phaseAndStatus.phase,
    task_status: phaseAndStatus.status,
    current_owner_agent: currentOwner,
    previous_owner_agent: handoffReason ? previousOwner : cleanText(previousWorkingMemory?.previous_owner_agent || "") || null,
    handoff_reason: handoffReason,
    retry_count: nextRetryCount,
    retry_policy: retryPolicy,
    abandoned_task_ids: abandonedTaskIds,
  };
  const previousPhase = cleanText(previousWorkingMemory?.task_phase || "") || null;
  const previousStatus = cleanText(previousWorkingMemory?.task_status || "") || null;
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
          to: currentOwner,
          reason: handoffReason,
        }
      : null,
    retry_attempt: retryableFailure
      ? {
          retry_count: nextRetryCount,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
        }
      : null,
    slot_update: {
      pending_slots: unresolvedSlots,
      slot_state_count: slotState.length,
    },
    task_abandoned: topicSwitch && previousTaskId
      ? {
          task_id: previousTaskId,
          reason: "topic_switch",
        }
      : null,
  };
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
    task_abandoned: null,
  };
  if (shouldWriteWorkingMemory && typeof workingMemoryWriter === "function") {
    const previousWorkingMemoryRead = readPlannerWorkingMemoryForRouting({
      sessionKey,
    });
    const previousWorkingMemory = previousWorkingMemoryRead?.ok === true
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
  logger?.info?.("planner_working_memory", {
    stage: "planner_working_memory",
    memory_stage: "answer_boundary_write_back",
    session_key: cleanText(sessionKey) || null,
    memory_write_attempted: shouldWriteWorkingMemory && typeof workingMemoryWriter === "function",
    memory_write_succeeded: memoryWriteResult?.ok === true,
    memory_snapshot: memoryWriteResult?.observability?.memory_snapshot || null,
    task_id: memoryWriteResult?.observability?.task_id || derivedMemoryObservability.task_id || null,
    task_phase_transition: memoryWriteResult?.observability?.task_phase_transition || derivedMemoryObservability.task_phase_transition || null,
    task_status_transition: memoryWriteResult?.observability?.task_status_transition || derivedMemoryObservability.task_status_transition || null,
    agent_handoff: memoryWriteResult?.observability?.agent_handoff || derivedMemoryObservability.agent_handoff || null,
    retry_attempt: memoryWriteResult?.observability?.retry_attempt || derivedMemoryObservability.retry_attempt || null,
    slot_update: memoryWriteResult?.observability?.slot_update || derivedMemoryObservability.slot_update || null,
    task_abandoned: memoryWriteResult?.observability?.task_abandoned || derivedMemoryObservability.task_abandoned || null,
  });

  return {
    plannerResult,
    plannerEnvelope,
    userResponse,
  };
}
