import { executeRegisteredAgent } from "./agent-dispatcher.mjs";
import { getRegisteredAgent, parseRegisteredAgentCommand } from "./agent-registry.mjs";
import { runDocumentReviewTriageWorkflow } from "./document-review-triage-workflow.mjs";
import {
  buildTaskInitialization,
  finalizeExecutiveTaskTurn,
  finalizeWorkflowVerificationGate,
} from "./executive-closed-loop.mjs";
import { buildLifecycleTransition } from "./executive-lifecycle.mjs";
import { buildVisibleMessageText, cleanText } from "./message-intent-utils.mjs";
import {
  looksLikeExecutiveExit,
  looksLikeExecutiveStart,
  planExecutiveTurn,
  renderPlannerUserFacingReplyText,
} from "./executive-planner.mjs";
import { FALLBACK_DISABLED, ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import {
  appendExecutiveAgentOutput,
  appendExecutiveTaskHandoff,
  appendExecutiveTaskTurn,
  clearActiveExecutiveTask,
  getExecutiveTask,
  getActiveExecutiveTask,
  startExecutiveTask,
  updateExecutiveTask,
} from "./executive-task-state.mjs";
import { runInSingleMachineRuntimeSession } from "./single-machine-runtime-coordination.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

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

function buildExecutiveUserFacingErrorText({
  answer = "",
  limitations = [],
} = {}) {
  const normalized = normalizeUserResponse({
    payload: {
      ok: false,
      answer,
      sources: [],
      limitations,
    },
    logger: noopLogger,
    handlerName: "executiveOrchestrator",
  });
  return renderPlannerUserFacingReplyText(normalized);
}

const EXECUTIVE_MAX_ROLES = 3;
const EXECUTIVE_MAX_SUPPORTING_ROLES = EXECUTIVE_MAX_ROLES - 1;
const EXECUTIVE_MAX_KEY_POINTS = 5;
const EXECUTIVE_DEFAULT_NEXT_STEP = "如果你要，我可以接著把這版整理成更具體的執行清單。";
const EXECUTIVE_SOURCE_SECTION_PATTERN = /^來源\s*[:：]?$/i;
const EXECUTIVE_CONCLUSION_HEADINGS = new Set([
  "結論",
  "核心結論",
  "決策建議",
  "技術判斷",
  "交付狀態",
  "現況",
  "整體理解",
  "盤點結論",
  "一致性結論",
  "衝突摘要",
  "owner 建議",
  "學習結論",
  "核心問題",
  "問題定義",
  "治理目標",
  "提案目標",
  "可批准項",
  "不建議項",
  "答案",
]);
const EXECUTIVE_KEY_POINT_HEADINGS = new Set([
  "重點",
  "判斷依據",
  "主要風險",
  "使用者價值",
  "建議方向",
  "範圍",
  "非目標",
  "驗收",
  "風險",
  "受眾",
  "訊息",
  "動作建議",
  "觀察",
  "方案比較",
  "現況缺口",
  "建議指標或流程",
  "阻塞",
  "SOP 建議",
  "例外處理",
  "關鍵依據",
  "關鍵來源",
  "提案內容",
  "影響範圍",
  "條件",
  "理由",
  "替代方案",
  "依據",
  "待確認",
  "主要缺口",
  "重複或分散點",
  "不一致點",
  "涉及文件",
  "待決策問題",
  "建議確認版",
  "建議保存方式",
  "主題",
]);
const EXECUTIVE_NEXT_STEP_HEADINGS = new Set([
  "下一步",
  "建議下一步",
  "建議執行順序",
  "建議行動",
  "後續動作",
]);

function sessionKeyFromScope(scope = {}, accountId = "") {
  return cleanText(scope?.session_key || scope?.chat_id || accountId);
}

async function runWithSessionCoordination({
  accountId = "",
  sessionKey = "",
  workflow = "",
  reason = "",
  logger = noopLogger,
} = {}, work = async () => null) {
  return runInSingleMachineRuntimeSession({
    accountId,
    sessionKey,
    workflow,
    reason,
    logger,
  }, work);
}

function resolveWorkPlanPrimaryAgentId(task = null, decision = null) {
  const decisionPrimary = cleanText(decision?.next_agent_id || decision?.primary_agent_id || "");
  if (decisionPrimary && getRegisteredAgent(decisionPrimary)) {
    return decisionPrimary;
  }
  const taskPrimary = cleanText(task?.current_agent_id || task?.primary_agent_id || "");
  if (taskPrimary && getRegisteredAgent(taskPrimary)) {
    return taskPrimary;
  }
  return "generalist";
}

function deriveSupportingAgentIds(workPlan = [], primaryAgentId = "") {
  return (Array.isArray(workPlan) ? workPlan : [])
    .map((item) => cleanText(item?.agent_id || ""))
    .filter((agentId) => agentId && agentId !== primaryAgentId)
    .slice(0, EXECUTIVE_MAX_SUPPORTING_ROLES);
}

function buildOrchestrationHeader({ action = "", task = null, nextAgent = null, reason = "" } = {}) {
  if (!task || !nextAgent) {
    return "";
  }
  if (action === "start") {
    if (task.supporting_agent_ids?.length) {
      return `我先把這題交給 /${nextAgent.id} 主責收斂，並同步參考 ${task.supporting_agent_ids.map((item) => `/${item}`).join("、")} 的補充。`;
    }
    return "";
  }
  if (action === "handoff") {
    return `這一輪我改由 /${nextAgent.id} 接手${reason ? `，因為 ${reason}` : ""}。`;
  }
  if (task?.agent_outputs?.length > 1 || task?.supporting_agent_ids?.length) {
    const sources = task.agent_outputs.map((item) => `/${item.agent_id}`).filter(Boolean).slice(0, 4).join("、");
    return sources ? `我延續上一輪的判斷，並把 ${sources} 的補充一起收斂了。` : "";
  }
  return "";
}

function summarizeAgentText(text = "", maxChars = 220) {
  return cleanText(String(text || "")).slice(0, maxChars);
}

function stripListMarker(text = "") {
  return cleanText(text).replace(/^(?:[-*•]\s*|\d+[.)、]\s*|[（(]?\d+[)）]\s*|[一二三四五六七八九十]+[、.]\s*)/, "");
}

function normalizeForDedupe(text = "") {
  return stripListMarker(text)
    .replace(/[：:]/g, "")
    .replace(/[、，,。.；;！？!?()[\]【】"'`]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function dedupeTextItems(items = [], initialSeen = new Set()) {
  const result = [];
  const seen = initialSeen;
  for (const item of Array.isArray(items) ? items : []) {
    const text = stripListMarker(item);
    const key = normalizeForDedupe(text);
    if (!text || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function splitHeadingAndInlineContent(line = "") {
  const normalized = cleanText(line);
  const match = normalized.match(/^([^：:]{1,24})[：:]\s*(.+)$/);
  if (!match) {
    return {
      heading: normalized,
      content: "",
    };
  }
  return {
    heading: cleanText(match[1]),
    content: cleanText(match[2]),
  };
}

function classifyExecutiveSection(heading = "") {
  const normalized = cleanText(heading);
  if (!normalized) {
    return "";
  }
  if (EXECUTIVE_CONCLUSION_HEADINGS.has(normalized)) {
    return "conclusion";
  }
  if (EXECUTIVE_KEY_POINT_HEADINGS.has(normalized)) {
    return "key_points";
  }
  if (EXECUTIVE_NEXT_STEP_HEADINGS.has(normalized)) {
    return "next_step";
  }
  return "";
}

function parseExecutiveReplySections(text = "") {
  if (classifyExecutiveReplyBoundary(text).rejected) {
    return {
      conclusion: [],
      key_points: [],
      next_step: [],
      sources: [],
      body: [],
    };
  }

  const lines = String(text || "").split(/\r?\n/);
  const sections = {
    conclusion: [],
    key_points: [],
    next_step: [],
    sources: [],
    body: [],
  };
  let currentSection = "";
  let inSourceSection = false;

  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!line || !isSafeExecutiveBriefLine(line)) {
      continue;
    }

    if (EXECUTIVE_SOURCE_SECTION_PATTERN.test(line)) {
      inSourceSection = true;
      currentSection = "";
      continue;
    }

    if (inSourceSection) {
      const sourceLine = stripListMarker(line);
      if (!sourceLine) {
        continue;
      }
      sections.sources.push(cleanText(sourceLine.split("｜")[0] || sourceLine));
      continue;
    }

    const { heading, content } = splitHeadingAndInlineContent(line);
    const detectedSection = classifyExecutiveSection(heading);
    if (detectedSection) {
      currentSection = detectedSection;
      if (content) {
        sections[detectedSection].push(content);
      }
      continue;
    }

    if (currentSection && sections[currentSection]) {
      sections[currentSection].push(stripListMarker(line));
      continue;
    }

    sections.body.push(stripListMarker(line));
  }

  return sections;
}

function deriveExecutiveSections({
  primaryReplyText = "",
  supportingOutputs = [],
} = {}) {
  const parsed = parseExecutiveReplySections(primaryReplyText);
  const seen = new Set();
  let conclusionItems = dedupeTextItems(parsed.conclusion, seen);
  const supportingSummaries = dedupeTextItems(
    (Array.isArray(supportingOutputs) ? supportingOutputs : [])
      .map((item) => item?.summary || "")
      .filter(isSafeExecutiveBriefLine),
    new Set(),
  );

  if (!conclusionItems.length && parsed.body.length) {
    const dedupedBody = dedupeTextItems(parsed.body, seen);
    if (dedupedBody.length) {
      conclusionItems = [dedupedBody[0]];
      parsed.body = dedupedBody.slice(1);
    }
  }

  if (!conclusionItems.length && supportingSummaries.length) {
    conclusionItems = [supportingSummaries[0]];
    seen.add(normalizeForDedupe(supportingSummaries[0]));
  }

  const keyPointSeed = [...parsed.key_points, ...parsed.body];
  let keyPoints = dedupeTextItems(keyPointSeed, seen);
  if (!keyPoints.length) {
    keyPoints = dedupeTextItems(supportingSummaries, seen);
  }
  if (parsed.sources.length) {
    const sourcePoint = `參考來源：${dedupeTextItems(parsed.sources).join("、")}`;
    keyPoints = dedupeTextItems([...keyPoints, sourcePoint], seen);
  }
  keyPoints = keyPoints.slice(0, EXECUTIVE_MAX_KEY_POINTS);

  let nextStepItems = dedupeTextItems(parsed.next_step, new Set());
  if (!nextStepItems.length) {
    const actionLikePoint = keyPoints.find((item) => /^(先|再|接著|建議|可以|可先|需要|請)/.test(item));
    if (actionLikePoint) {
      nextStepItems = [actionLikePoint];
    }
  }
  if (!nextStepItems.length) {
    nextStepItems = [EXECUTIVE_DEFAULT_NEXT_STEP];
  }

  return {
    conclusion: conclusionItems.join(" "),
    keyPoints,
    nextStep: nextStepItems[0],
  };
}

function looksLikeAgentFailureText(text = "") {
  const normalized = cleanText(text);
  if (!normalized || !normalized.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(normalized);
    return parsed?.ok === false;
  } catch {
    return false;
  }
}

function looksLikeNestedExecutiveBoundaryJson(text = "") {
  return /^(?:\{|```)/.test(cleanText(text));
}

function parseExecutiveBoundaryJson(rawAnswer = "") {
  if (rawAnswer && typeof rawAnswer === "object") {
    if (Array.isArray(rawAnswer)) {
      return null;
    }
    return {
      kind: "json_object",
      payload: rawAnswer,
    };
  }

  let candidate = String(rawAnswer || "").trim();
  if (!candidate) {
    return null;
  }

  for (let depth = 0; depth < 2; depth += 1) {
    const fencedMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const parseTarget = fencedMatch ? fencedMatch[1].trim() : candidate;
    let parsed = null;
    try {
      parsed = JSON.parse(parseTarget);
    } catch {
      return null;
    }

    if (typeof parsed === "string") {
      const normalized = cleanText(parsed);
      if (!normalized || normalized === candidate || !looksLikeNestedExecutiveBoundaryJson(normalized)) {
        return null;
      }
      candidate = normalized;
      continue;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        kind: fencedMatch ? "json_object_fenced" : "json_object",
        payload: parsed,
      };
    }

    return null;
  }

  return null;
}

function looksLikeExecutiveEnvelopePayload(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const status = cleanText(payload.status || "").toLowerCase();
  return Boolean(
    typeof payload.ok === "boolean"
    || cleanText(payload.error || "")
    || payload.details
    || payload.context
    || payload.trace
    || payload.execution_result
    || payload.action_layer
    || status === "error"
    || status === "failed"
    || status === "blocked"
    || status === "stopped"
    || status === "escalated"
    || status === "pending_review"
    || status === "awaiting_review"
  );
}

function classifyExecutiveReplyBoundary(rawAnswer = "") {
  const parsed = parseExecutiveBoundaryJson(rawAnswer);
  if (parsed) {
    return {
      rejected: true,
      reason: looksLikeExecutiveEnvelopePayload(parsed.payload) ? "structured_envelope" : parsed.kind,
    };
  }

  const normalized = cleanText(rawAnswer);
  if (!normalized) {
    return {
      rejected: false,
      reason: "",
    };
  }

  if (/^```(?:json)?$/i.test(normalized) || normalized === "```") {
    return {
      rejected: true,
      reason: "json_fence",
    };
  }

  return {
    rejected: false,
    reason: "",
  };
}

function isSafeExecutiveBriefLine(text = "") {
  return !classifyExecutiveReplyBoundary(text).rejected;
}

function normalizeDispatchedActions(actions = []) {
  return (Array.isArray(actions) ? actions : [])
    .map((item) => {
      if (typeof item === "string") {
        const action = cleanText(item);
        return action
          ? {
              action,
              target: null,
              status: null,
            }
          : null;
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      const action = cleanText(item.action || item.name || "");
      if (!action) {
        return null;
      }

      return {
        action,
        target: cleanText(item.target || item.tool || item.agent_id || "") || null,
        status: cleanText(item.status || "") || null,
      };
    })
    .filter(Boolean)
    .slice(-12);
}

function extractReplyDispatchedActions(reply = null) {
  return normalizeDispatchedActions(
    reply?.metadata?.dispatched_actions
    || reply?.dispatched_actions
    || [],
  );
}

export function normalizeWorkPlan(task = null, decision = null, requestText = "") {
  const primaryAgentId = resolveWorkPlanPrimaryAgentId(task, decision);
  const plan = Array.isArray(decision?.work_items) && decision.work_items.length
    ? decision.work_items
    : Array.isArray(task?.work_plan)
      ? task.work_plan
      : [];
  const specialists = [];
  let mergeItem = null;
  const seen = new Set();
  for (const item of plan) {
    const requestedAgentId = cleanText(item?.agent_id || item?.agent || "");
    const agentId = requestedAgentId && getRegisteredAgent(requestedAgentId)
      ? requestedAgentId
      : primaryAgentId;
    const work = cleanText(item?.task || requestText);
    if (!agentId || !work || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    const selectedAction = cleanText(item?.selected_action || item?.action || "");
    const normalizedItem = {
      agent_id: agentId,
      task: work,
      role: cleanText(item?.role || (agentId === primaryAgentId ? "primary" : "supporting")),
      status: cleanText(item?.status || "pending") || "pending",
      ...(selectedAction ? { selected_action: selectedAction } : {}),
      ...(item?.tool_required === true ? { tool_required: true } : {}),
    };
    if (agentId === primaryAgentId) {
      mergeItem = normalizedItem;
      continue;
    }
    specialists.push(normalizedItem);
    if (specialists.length >= EXECUTIVE_MAX_SUPPORTING_ROLES) {
      break;
    }
  }

  if (!mergeItem) {
    mergeItem = {
      agent_id: primaryAgentId,
      task: cleanText(requestText || decision?.objective || task?.objective || "主責收斂這個任務"),
      role: "primary",
      status: "pending",
    };
  }

  return [...specialists.slice(0, EXECUTIVE_MAX_SUPPORTING_ROLES), mergeItem].slice(0, EXECUTIVE_MAX_ROLES);
}

export function buildVisibleWorkPlan(workPlan = [], { primaryAgentId = "" } = {}) {
  const items = Array.isArray(workPlan) ? workPlan : [];
  if (!items.length) {
    return "";
  }
  return [
    "這輪分工",
    ...items.map((item, index) => {
      const prefix = item.agent_id === primaryAgentId || item.role === "primary" ? "主責" : "支援";
      const status = item.status === "completed"
        ? "已完成"
        : item.status === "failed"
          ? "失敗"
          : item.status === "fallback"
            ? "改走 fallback"
            : "待處理";
      return `${index + 1}. ${prefix} /${item.agent_id}｜${status}｜${item.task}`;
    }),
  ].join("\n");
}

export function buildSupportingContext(outputs = []) {
  const lines = [];
  for (const item of outputs.slice(0, EXECUTIVE_MAX_SUPPORTING_ROLES)) {
    lines.push(`/${item.agent_id}`);
    lines.push(`- 子任務：${item.task}`);
    lines.push(`- 輸出：${item.summary}`);
  }
  return lines.join("\n");
}

export function buildVisibleSupportingOutputs(outputs = []) {
  const items = Array.isArray(outputs) ? outputs : [];
  if (!items.length) {
    return "";
  }
  return [
    "我另外參考了",
    ...items.slice(0, EXECUTIVE_MAX_SUPPORTING_ROLES).map((item, index) =>
      `${index + 1}. /${item.agent_id}｜子任務：${item.task}｜摘要：${summarizeAgentText(item.summary)}`,
    ),
  ].join("\n");
}

export function buildExecutiveBrief({
  header = "",
  workPlan = [],
  primaryAgentId = "",
  supportingOutputs = [],
  primaryReplyText = "",
} = {}) {
  const normalized = deriveExecutiveSections({
    primaryReplyText,
    supportingOutputs,
  });
  return [
    "結論：",
    summarizeAgentText(normalized.conclusion, 560) || "待確認",
    "",
    "重點：",
    ...(normalized.keyPoints.length
      ? normalized.keyPoints.map((item) => `- ${summarizeAgentText(item, 220)}`)
      : ["- 待確認"]),
    "",
    "下一步：",
    summarizeAgentText(normalized.nextStep, 220) || EXECUTIVE_DEFAULT_NEXT_STEP,
  ]
    .filter(Boolean)
    .join("\n");
}

async function transitionTaskLifecycle(task, nextState, reason) {
  if (!task?.id) {
    return task;
  }
  const transition = buildLifecycleTransition({
    from: task.lifecycle_state,
    to: nextState,
    reason,
  });
  if (!transition.ok) {
    return task;
  }
  return updateExecutiveTask(task.id, transition.patch);
}

async function advanceTaskLifecycle(task, steps = [], reason = "workflow_state_advanced") {
  let current = task;
  for (const nextState of Array.isArray(steps) ? steps : []) {
    if (!current?.id || current.lifecycle_state === nextState) {
      continue;
    }
    const updated = await transitionTaskLifecycle(current, nextState, reason);
    current = updated || current;
  }
  return current;
}

async function ensureMeetingWorkflowTaskUnlocked({
  accountId = "",
  event = {},
  scope = {},
  workflowState = "created",
  routingHint = "meeting_follow_up",
  objective = "",
  meta = {},
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey) {
    return null;
  }

  const traceId = cleanText(scope?.trace_id || event?.trace_id || "");
  const meetingObjective =
    cleanText(objective)
    || cleanText(event?.message?.chat_id)
    || cleanText(event?.message?.message_id)
    || "meeting_workflow";
  const existing = await getActiveExecutiveTask(accountId, sessionKey);
  let task = existing?.workflow === "meeting" ? existing : null;

  if (!task) {
    const initialization = buildTaskInitialization({
      objective: meetingObjective,
      agentId: "meeting_agent",
      requestText: meetingObjective,
      workflow: "meeting",
    });
    task = await startExecutiveTask({
      accountId,
      sessionKey,
      chatId: cleanText(event?.message?.chat_id),
      workflow: "meeting",
      workflowState,
      routingHint,
      traceId,
      objective: meetingObjective,
      primaryAgentId: "meeting_agent",
      currentAgentId: "meeting_agent",
      constraints: ["meeting workflow must wait for explicit confirmation before writeback and completion"],
      taskType: initialization.task_type,
      lifecycleState: initialization.lifecycle_state,
      goal: initialization.goal,
      successCriteria: initialization.success_criteria,
      failureCriteria: initialization.failure_criteria,
      evidenceRequirements: initialization.evidence_requirements,
      validationMethod: initialization.validation_method,
      retryPolicy: initialization.retry_policy,
      escalationPolicy: initialization.escalation_policy,
      riskLevel: initialization.risk_level,
      meta: {
        source: "meeting_workflow",
        lane: cleanText(scope?.capability_lane || ""),
        // TODO(control-unification-phase3): attach workflow-specific task schema and reflection hooks.
        ...meta,
      },
    });
    task = await advanceTaskLifecycle(task, ["clarified", "planned"], "meeting_workflow_initialized");
  }

  task = await updateExecutiveTask(task.id, {
    workflow: "meeting",
    workflow_state: workflowState,
    routing_hint: routingHint,
    trace_id: traceId || task.trace_id,
    current_agent_id: "meeting_agent",
    status: "active",
    meta,
  });

  if (workflowState === "capturing") {
    task = await advanceTaskLifecycle(task, ["executing"], "meeting_capture_started");
  }
  if (workflowState === "awaiting_confirmation") {
    task = await advanceTaskLifecycle(task, ["executing", "awaiting_result"], "meeting_summary_pending_confirmation");
  }

  return task;
}

export async function ensureMeetingWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "meeting",
    reason: "ensure_meeting_workflow_task",
  }, () => ensureMeetingWorkflowTaskUnlocked(args));
}

async function markMeetingWorkflowWritingBackUnlocked({
  accountId = "",
  scope = {},
  event = {},
  meta = {},
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey) {
    return null;
  }
  const task = await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "meeting") {
    return null;
  }
  return updateExecutiveTask(task.id, {
    workflow: "meeting",
    workflow_state: "writing_back",
    routing_hint: "meeting_confirm_write",
    trace_id: cleanText(scope?.trace_id || event?.trace_id || task.trace_id),
    status: "active",
    meta,
  });
}

export async function markMeetingWorkflowWritingBack(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "meeting",
    reason: "mark_meeting_workflow_writing_back",
  }, () => markMeetingWorkflowWritingBackUnlocked(args));
}

async function finalizeMeetingWorkflowTaskUnlocked({
  accountId = "",
  scope = {},
  taskId = "",
  summaryContent = "",
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  const task = taskId
    ? await getExecutiveTask(taskId)
    : await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "meeting") {
    return null;
  }

  const finalized = await finalizeWorkflowVerificationGate({
    task,
    taskType: "meeting_processing",
    replyText: summaryContent,
    structuredResult,
    extraEvidence,
    expectedOutputSchema: {
      summary: "string",
      decisions: "array",
      action_items: "array",
    },
  });
  if (!finalized?.task) {
    return finalized;
  }

  let current = finalized.task;
  if (finalized.verification?.pass) {
    current = await updateExecutiveTask(current.id, {
      workflow_state: "completed",
      routing_hint: "",
      status: "completed",
    });
    if (accountId && sessionKey) {
      await clearActiveExecutiveTask(accountId, sessionKey, { expectedTaskId: current.id });
    }
  } else {
    if (current.lifecycle_state !== "blocked") {
      current = await transitionTaskLifecycle(current, "blocked", "meeting_verification_failed");
    }
    current = await updateExecutiveTask(current.id, {
      workflow_state: "blocked",
      routing_hint: "meeting_retry_required",
      status: "blocked",
    });
  }

  return {
    ...finalized,
    task: current,
  };
}

export async function finalizeMeetingWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "meeting",
    reason: "finalize_meeting_workflow_task",
  }, () => finalizeMeetingWorkflowTaskUnlocked(args));
}

async function ensureDocRewriteWorkflowTaskUnlocked({
  accountId = "",
  documentId = "",
  documentTitle = "",
  event = {},
  scope = {},
  workflowState = "created",
  routingHint = "doc_rewrite_follow_up",
  meta = {},
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey) {
    return null;
  }

  const traceId = cleanText(scope?.trace_id || event?.trace_id || "");
  const objective = cleanText(documentTitle || documentId || "doc_rewrite");
  const existing = await getActiveExecutiveTask(accountId, sessionKey);
  let task = existing?.workflow === "doc_rewrite" ? existing : null;

  if (!task) {
    const initialization = buildTaskInitialization({
      objective,
      agentId: "doc_rewrite",
      requestText: objective,
      workflow: "doc_rewrite",
    });
    task = await startExecutiveTask({
      accountId,
      sessionKey,
      chatId: cleanText(event?.message?.chat_id),
      workflow: "doc_rewrite",
      workflowState,
      routingHint,
      traceId,
      objective,
      primaryAgentId: "doc_rewrite",
      currentAgentId: "doc_rewrite",
      constraints: ["doc rewrite must stay in preview/review before apply and completion"],
      taskType: "doc_rewrite",
      lifecycleState: initialization.lifecycle_state,
      goal: initialization.goal,
      successCriteria: initialization.success_criteria,
      failureCriteria: initialization.failure_criteria,
      evidenceRequirements: initialization.evidence_requirements,
      validationMethod: initialization.validation_method,
      retryPolicy: initialization.retry_policy,
      escalationPolicy: initialization.escalation_policy,
      riskLevel: initialization.risk_level,
      meta: {
        source: "doc_rewrite_workflow",
        document_id: cleanText(documentId),
        // TODO(control-unification-phase3): align doc rewrite session routing with explicit confirmation artifact ownership.
        ...meta,
      },
    });
    task = await advanceTaskLifecycle(task, ["clarified", "planned"], "doc_rewrite_initialized");
  }

  task = await updateExecutiveTask(task.id, {
    workflow: "doc_rewrite",
    workflow_state: workflowState,
    routing_hint: routingHint,
    trace_id: traceId || task.trace_id,
    status: "active",
    meta: {
      document_id: cleanText(documentId) || cleanText(task.meta?.document_id || ""),
      ...meta,
    },
  });

  if (workflowState === "loading_source" || workflowState === "drafting") {
    task = await advanceTaskLifecycle(task, ["executing"], "doc_rewrite_loading_or_drafting");
  }
  if (workflowState === "awaiting_review") {
    task = await advanceTaskLifecycle(task, ["executing", "awaiting_result"], "doc_rewrite_pending_review");
  }

  return task;
}

export async function ensureDocRewriteWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "doc_rewrite",
    reason: "ensure_doc_rewrite_workflow_task",
  }, () => ensureDocRewriteWorkflowTaskUnlocked(args));
}

async function markDocRewriteApplyingUnlocked({
  accountId = "",
  scope = {},
  event = {},
  confirmationId = "",
  meta = {},
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey) {
    return null;
  }
  const task = await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "doc_rewrite") {
    return null;
  }
  if (task.workflow_state !== "awaiting_review") {
    return null;
  }
  if (
    cleanText(confirmationId)
    && cleanText(task?.meta?.confirmation_id) !== cleanText(confirmationId)
  ) {
    return null;
  }
  return updateExecutiveTask(task.id, {
    workflow: "doc_rewrite",
    workflow_state: "applying",
    routing_hint: "doc_rewrite_apply",
    trace_id: cleanText(scope?.trace_id || event?.trace_id || task.trace_id),
    status: "active",
    meta: {
      document_id: cleanText(task?.meta?.document_id || ""),
      ...(task?.meta && typeof task.meta === "object" && !Array.isArray(task.meta) ? task.meta : {}),
      ...meta,
    },
  });
}

export async function markDocRewriteApplying(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "doc_rewrite",
    reason: "mark_doc_rewrite_applying",
  }, () => markDocRewriteApplyingUnlocked(args));
}

async function finalizeDocRewriteWorkflowTaskUnlocked({
  accountId = "",
  scope = {},
  taskId = "",
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  const task = taskId
    ? await getExecutiveTask(taskId)
    : await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "doc_rewrite") {
    return null;
  }

  const finalized = await finalizeWorkflowVerificationGate({
    task,
    taskType: "doc_rewrite",
    replyText: "",
    structuredResult,
    extraEvidence,
    expectedOutputSchema: {
      patch_plan: "array",
      structure_preserved: "boolean",
    },
  });
  if (!finalized?.task) {
    return finalized;
  }

  let current = finalized.task;
  if (finalized.verification?.pass) {
    current = await updateExecutiveTask(current.id, {
      workflow_state: "completed",
      routing_hint: "",
      status: "completed",
    });
    if (accountId && sessionKey) {
      await clearActiveExecutiveTask(accountId, sessionKey, { expectedTaskId: current.id });
    }
  } else {
    if (current.lifecycle_state !== "blocked") {
      current = await transitionTaskLifecycle(current, "blocked", "doc_rewrite_verification_failed");
    }
    current = await updateExecutiveTask(current.id, {
      workflow_state: "blocked",
      routing_hint: "doc_rewrite_retry_required",
      status: "blocked",
    });
  }

  return {
    ...finalized,
    task: current,
  };
}

export async function finalizeDocRewriteWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "doc_rewrite",
    reason: "finalize_doc_rewrite_workflow_task",
  }, () => finalizeDocRewriteWorkflowTaskUnlocked(args));
}

async function ensureDocumentReviewWorkflowTaskUnlocked({
  accountId = "",
  requestText = "",
  event = {},
  scope = {},
  workflowState = "triaging",
  routingHint = "document_review_triaging",
  meta = {},
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey) {
    return null;
  }

  const traceId = cleanText(scope?.trace_id || event?.trace_id || "");
  const objective = cleanText(requestText || "document_review");
  const existing = await getActiveExecutiveTask(accountId, sessionKey);
  let task = existing?.workflow === "document_review" ? existing : null;

  if (!task) {
    const initialization = buildTaskInitialization({
      objective,
      agentId: "document_review",
      requestText: objective,
      workflow: "document_review",
    });
    task = await startExecutiveTask({
      accountId,
      sessionKey,
      chatId: cleanText(event?.message?.chat_id),
      workflow: "document_review",
      workflowState,
      routingHint,
      traceId,
      objective,
      primaryAgentId: "document_review",
      currentAgentId: "document_review",
      constraints: ["document review workflow must keep conclusion, referenced documents, reasons, and next actions aligned with evidence"],
      taskType: initialization.task_type,
      lifecycleState: initialization.lifecycle_state,
      goal: initialization.goal,
      successCriteria: initialization.success_criteria,
      failureCriteria: initialization.failure_criteria,
      evidenceRequirements: initialization.evidence_requirements,
      validationMethod: initialization.validation_method,
      retryPolicy: initialization.retry_policy,
      escalationPolicy: initialization.escalation_policy,
      riskLevel: initialization.risk_level,
      meta: {
        source: "document_review_workflow",
        request_text: objective,
        ...meta,
      },
    });
    task = await advanceTaskLifecycle(task, ["clarified", "planned"], "document_review_initialized");
  }

  task = await updateExecutiveTask(task.id, {
    workflow: "document_review",
    workflow_state: workflowState,
    routing_hint: routingHint,
    trace_id: traceId || task.trace_id,
    status: "active",
    meta: {
      request_text: objective || cleanText(task.meta?.request_text || ""),
      ...meta,
    },
  });

  if (workflowState === "triaging") {
    task = await advanceTaskLifecycle(task, ["executing"], "document_review_triaging");
  }

  return task;
}

export async function ensureDocumentReviewWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "document_review",
    reason: "ensure_document_review_workflow_task",
  }, () => ensureDocumentReviewWorkflowTaskUnlocked(args));
}

async function finalizeDocumentReviewWorkflowTaskUnlocked({
  accountId = "",
  scope = {},
  taskId = "",
  replyText = "",
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const sessionKey = sessionKeyFromScope(scope, accountId);
  const task = taskId
    ? await getExecutiveTask(taskId)
    : await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "document_review") {
    return null;
  }

  let reviewTask = task;
  if (reviewTask.lifecycle_state === "executing") {
    reviewTask = await transitionTaskLifecycle(reviewTask, "awaiting_result", "document_review_result_ready");
  }

  const finalized = await finalizeWorkflowVerificationGate({
    task: reviewTask,
    taskType: "document_review",
    replyText,
    structuredResult,
    extraEvidence,
    expectedOutputSchema: {
      conclusion: "string",
      referenced_documents: "array",
      reasons: "array",
      next_actions: "array",
      document_count: "number",
    },
  });
  if (!finalized?.task) {
    return finalized;
  }

  let current = finalized.task;
  if (finalized.verification?.pass) {
    current = await updateExecutiveTask(current.id, {
      workflow_state: "completed",
      routing_hint: "",
      status: "completed",
    });
    if (accountId && sessionKey) {
      await clearActiveExecutiveTask(accountId, sessionKey, { expectedTaskId: current.id });
    }
  } else {
    if (current.lifecycle_state !== "blocked") {
      current = await transitionTaskLifecycle(current, "blocked", "document_review_verification_failed");
    }
    current = await updateExecutiveTask(current.id, {
      workflow_state: "blocked",
      routing_hint: "document_review_retry_required",
      status: "blocked",
    });
  }

  return {
    ...finalized,
    task: current,
  };
}

export async function finalizeDocumentReviewWorkflowTask(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "document_review",
    reason: "finalize_document_review_workflow_task",
  }, () => finalizeDocumentReviewWorkflowTaskUnlocked(args));
}

async function executeDocumentReviewWorkflowUnlocked({
  accountId = "",
  requestText = "",
  documents = [],
  event = {},
  scope = {},
  meta = {},
} = {}) {
  const task = await ensureDocumentReviewWorkflowTaskUnlocked({
    accountId,
    requestText,
    event,
    scope,
    workflowState: "triaging",
    routingHint: "document_review_triaging",
    meta,
  });
  if (!task?.id) {
    return null;
  }

  const execution = runDocumentReviewTriageWorkflow({
    requestText,
    documents,
  });
  const finalized = await finalizeDocumentReviewWorkflowTaskUnlocked({
    accountId,
    scope,
    taskId: task.id,
    replyText: execution.reply_text,
    structuredResult: execution.structured_result,
    extraEvidence: execution.extra_evidence,
  });

  return {
    ...execution,
    ...finalized,
  };
}

export async function executeDocumentReviewWorkflow(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "document_review",
    reason: "execute_document_review_workflow",
  }, () => executeDocumentReviewWorkflowUnlocked(args));
}

async function ensureCloudDocWorkflowTaskUnlocked({
  accountId = "",
  scope = {},
  event = {},
  workflowState = "created",
  routingHint = "cloud_doc_follow_up",
  objective = "",
  scopeKey = "",
  meta = {},
} = {}) {
  const sessionKey = cleanText(scope?.session_key || scopeKey);
  if (!accountId || !sessionKey || !cleanText(scopeKey)) {
    return null;
  }

  const traceId = cleanText(scope?.trace_id || event?.trace_id || "");
  const workflowObjective = cleanText(objective || scopeKey || "cloud_doc_workflow");
  const existing = await getActiveExecutiveTask(accountId, sessionKey);
  let task = existing?.workflow === "cloud_doc" && cleanText(existing?.meta?.scope_key) === cleanText(scopeKey)
    ? existing
    : null;

  if (!task) {
    const initialization = buildTaskInitialization({
      objective: workflowObjective,
      agentId: "cloud_doc",
      requestText: workflowObjective,
      workflow: "cloud_doc",
    });
    task = await startExecutiveTask({
      accountId,
      sessionKey,
      chatId: cleanText(event?.message?.chat_id),
      workflow: "cloud_doc",
      workflowState,
      routingHint,
      traceId,
      objective: workflowObjective,
      primaryAgentId: "cloud_doc",
      currentAgentId: "cloud_doc",
      constraints: ["cloud doc workflow must preview/review before apply and completion"],
      taskType: "cloud_doc",
      lifecycleState: initialization.lifecycle_state,
      goal: initialization.goal,
      successCriteria: initialization.success_criteria,
      failureCriteria: initialization.failure_criteria,
      evidenceRequirements: initialization.evidence_requirements,
      validationMethod: initialization.validation_method,
      retryPolicy: initialization.retry_policy,
      escalationPolicy: initialization.escalation_policy,
      riskLevel: initialization.risk_level,
      meta: {
        source: "cloud_doc_workflow",
        scope_key: cleanText(scopeKey),
        ...meta,
      },
    });
    task = await advanceTaskLifecycle(task, ["clarified", "planned"], "cloud_doc_initialized");
  }

  task = await updateExecutiveTask(task.id, {
    workflow: "cloud_doc",
    workflow_state: workflowState,
    routing_hint: routingHint,
    trace_id: traceId || task.trace_id,
    status: "active",
    meta: {
      scope_key: cleanText(scopeKey),
      ...meta,
    },
  });

  if (workflowState === "scoping" || workflowState === "previewing") {
    task = await advanceTaskLifecycle(task, ["executing"], "cloud_doc_previewing");
  }
  if (workflowState === "awaiting_review") {
    task = await advanceTaskLifecycle(task, ["executing", "awaiting_result"], "cloud_doc_pending_review");
  }

  return task;
}

export async function ensureCloudDocWorkflowTask(args = {}) {
  const sessionKey = cleanText(args.scope?.session_key || args.scopeKey);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "cloud_doc",
    reason: "ensure_cloud_doc_workflow_task",
  }, () => ensureCloudDocWorkflowTaskUnlocked(args));
}

async function markCloudDocApplyingUnlocked({
  accountId = "",
  scope = {},
  scopeKey = "",
  event = {},
  meta = {},
} = {}) {
  const sessionKey = cleanText(scope?.session_key || scopeKey);
  if (!accountId || !sessionKey || !cleanText(scopeKey)) {
    return null;
  }
  const task = await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "cloud_doc" || cleanText(task?.meta?.scope_key) !== cleanText(scopeKey)) {
    return null;
  }
  if (task.workflow_state !== "awaiting_review") {
    return null;
  }
  return updateExecutiveTask(task.id, {
    workflow: "cloud_doc",
    workflow_state: "applying",
    routing_hint: "cloud_doc_apply",
    trace_id: cleanText(scope?.trace_id || event?.trace_id || task.trace_id),
    status: "active",
    meta: {
      scope_key: cleanText(scopeKey),
      ...meta,
    },
  });
}

export async function markCloudDocApplying(args = {}) {
  const sessionKey = cleanText(args.scope?.session_key || args.scopeKey);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "cloud_doc",
    reason: "mark_cloud_doc_applying",
  }, () => markCloudDocApplyingUnlocked(args));
}

async function finalizeCloudDocWorkflowTaskUnlocked({
  accountId = "",
  scope = {},
  scopeKey = "",
  structuredResult = null,
  extraEvidence = [],
} = {}) {
  const sessionKey = cleanText(scope?.session_key || scopeKey);
  const task = await getActiveExecutiveTask(accountId, sessionKey);
  if (!task?.id || task.workflow !== "cloud_doc" || cleanText(task?.meta?.scope_key) !== cleanText(scopeKey)) {
    return null;
  }

  const finalized = await finalizeWorkflowVerificationGate({
    task,
    taskType: "cloud_doc",
    structuredResult,
    extraEvidence,
    expectedOutputSchema: {
      scope_key: "string",
    },
  });
  if (!finalized?.task) {
    return finalized;
  }

  let current = finalized.task;
  if (finalized.verification?.pass) {
    current = await updateExecutiveTask(current.id, {
      workflow_state: "completed",
      routing_hint: "",
      status: "completed",
    });
    await clearActiveExecutiveTask(accountId, sessionKey, { expectedTaskId: current.id });
  } else {
    if (current.lifecycle_state !== "blocked") {
      current = await transitionTaskLifecycle(current, "blocked", "cloud_doc_verification_failed");
    }
    current = await updateExecutiveTask(current.id, {
      workflow_state: "blocked",
      routing_hint: "cloud_doc_retry_required",
      status: "blocked",
    });
  }

  return {
    ...finalized,
    task: current,
  };
}

export async function finalizeCloudDocWorkflowTask(args = {}) {
  const sessionKey = cleanText(args.scope?.session_key || args.scopeKey);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "cloud_doc",
    reason: "finalize_cloud_doc_workflow_task",
  }, () => finalizeCloudDocWorkflowTaskUnlocked(args));
}

export async function executeWorkItemsSequentially({
  accountId,
  scope,
  event,
  task = null,
  workPlan = [],
  requestText = "",
  mergeAgentId = "",
  logger = noopLogger,
  executeAgentFn = executeRegisteredAgent,
}) {
  const designatedMergeAgentId = cleanText(mergeAgentId || task?.current_agent_id || task?.primary_agent_id || "")
    || "generalist";
  const normalizedPlan = normalizeWorkPlan(
    task,
    {
      primary_agent_id: designatedMergeAgentId,
      next_agent_id: designatedMergeAgentId,
      work_items: workPlan,
    },
    requestText,
  );
  const specialistItems = normalizedPlan.slice(0, -1);
  const mergeItem = normalizedPlan.at(-1) || {
    agent_id: designatedMergeAgentId,
    task: cleanText(requestText) || "主責收斂這個任務",
    role: "primary",
    status: "pending",
  };
  const outputs = [];
  const failedAgents = [];
  const executedSpecialists = [];
  const dispatchedActions = [];

  for (const item of specialistItems) {
    const agent = getRegisteredAgent(item.agent_id);
    if (!agent) {
      failedAgents.push({
        agent_id: item.agent_id,
        task: item.task,
        error: "agent_not_found",
      });
      executedSpecialists.push({
        ...item,
        status: "failed",
      });
      continue;
    }
    try {
      const reply = await executeAgentFn({
        accountId,
        agent,
        requestText: item.task,
        scope,
        event,
        logger,
      });
      const summary = cleanText(reply?.text || "");
      dispatchedActions.push(...extractReplyDispatchedActions(reply));
      const boundary = classifyExecutiveReplyBoundary(reply?.text || "");
      if (!summary || looksLikeAgentFailureText(summary) || boundary.rejected) {
        logger.warn("executive_specialist_output_rejected", {
          agent_id: agent.id,
          reason: boundary.reason || "empty_or_failed_reply",
        });
        failedAgents.push({
          agent_id: agent.id,
          task: item.task,
          error: boundary.reason ? `rejected_${boundary.reason}` : "empty_or_failed_reply",
        });
        executedSpecialists.push({
          ...item,
          status: "failed",
        });
        continue;
      }
      const output = {
        agent_id: agent.id,
        task: item.task,
        summary: summarizeAgentText(summary, 520),
        status: "completed",
      };
      outputs.push(output);
      executedSpecialists.push({
        ...item,
        status: "completed",
      });
      if (task?.id) {
        await appendExecutiveAgentOutput(task.id, output);
      }
    } catch (error) {
      logger.warn("executive_specialist_failed", {
        agent_id: agent.id,
        error: logger.compactError(error),
      });
      failedAgents.push({
        agent_id: agent.id,
        task: item.task,
        error: cleanText(error?.message || "") || "specialist_failed",
      });
      executedSpecialists.push({
        ...item,
        status: "failed",
      });
    }
  }

  const fallbackUsed = failedAgents.length > 0;
  const mergeCandidates = fallbackUsed
    ? ["generalist"]
    : [mergeItem.agent_id, "generalist"].filter((agentId, index, list) => agentId && list.indexOf(agentId) === index);

  let mergeAgent = null;
  let reply = null;
  for (const candidateId of mergeCandidates) {
    const agent = getRegisteredAgent(candidateId);
    if (!agent) {
      continue;
    }
    try {
      const candidateReply = await executeAgentFn({
        accountId,
        agent,
        requestText: mergeItem.task || requestText,
        scope,
        event,
        supportingContext: buildSupportingContext(outputs),
        logger,
      });
      dispatchedActions.push(...extractReplyDispatchedActions(candidateReply));
      const boundary = classifyExecutiveReplyBoundary(candidateReply?.text || "");
      if (!cleanText(candidateReply?.text || "") || looksLikeAgentFailureText(candidateReply?.text || "") || boundary.rejected) {
        throw new Error("merge_agent_failed");
      }
      mergeAgent = agent;
      reply = candidateReply;
      break;
    } catch (error) {
      logger.warn("executive_merge_agent_failed", {
        agent_id: agent.id,
        error: logger.compactError(error),
      });
    }
  }

  const finalWorkPlan = [];
  const finalSeen = new Set();
  for (const item of [...executedSpecialists, {
    agent_id: cleanText(mergeAgent?.id || mergeItem.agent_id || "generalist") || "generalist",
    task: mergeItem.task || requestText,
    role: "primary",
    status: reply?.text ? "completed" : "failed",
    ...(mergeItem.selected_action ? { selected_action: mergeItem.selected_action } : {}),
    ...(mergeItem.tool_required === true ? { tool_required: true } : {}),
  }]) {
    if (!item?.agent_id || finalSeen.has(item.agent_id)) {
      continue;
    }
    finalSeen.add(item.agent_id);
    finalWorkPlan.push(item);
    if (finalWorkPlan.length >= EXECUTIVE_MAX_ROLES) {
      break;
    }
  }

  return {
    reply,
    mergeAgent: mergeAgent || getRegisteredAgent("generalist"),
    supportingOutputs: outputs,
    finalWorkPlan,
    failedAgents,
    fallbackUsed,
    dispatchedActions: normalizeDispatchedActions(dispatchedActions),
  };
}

async function executeExecutiveTurnUnlocked({
  accountId,
  event,
  scope,
  logger = noopLogger,
  planExecutiveTurnFn = planExecutiveTurn,
}) {
  const text = buildVisibleMessageText(event);
  const sessionKey = sessionKeyFromScope(scope, accountId);
  if (!accountId || !sessionKey || !cleanText(text)) {
    return null;
  }

  const activeTask = await getActiveExecutiveTask(accountId, sessionKey);
  if (looksLikeExecutiveExit(text)) {
    if (!activeTask) {
      return null;
    }
    const closedTask = await transitionTaskLifecycle(activeTask, "blocked", "user_requested_exit");
    await updateExecutiveTask(activeTask.id, {
      status: "ended_by_user",
      workflow_state: "inactive",
      meta: {
        closed_by_user: true,
      },
    });
    await clearActiveExecutiveTask(accountId, sessionKey, { expectedTaskId: activeTask.id });
    return {
      text: [
        "Executive Team",
        "- 我已結束這個多 agent 任務。",
        "- 之後的新訊息不會再自動延續剛剛那個 task。",
        closedTask?.trace_id ? `- trace_id：${closedTask.trace_id}` : "",
      ].join("\n"),
    };
  }

  const slashCommand = parseRegisteredAgentCommand(text);
  if (slashCommand?.error === ROUTING_NO_MATCH) {
    return {
      text: [
        "結論",
        "這個 slash 指令沒有命中任何已註冊的 registered agent。",
        "",
        "重點",
        "請改用已存在的 `/generalist`、`/ceo`、`/product`、`/prd`、`/cmo`、`/consult`、`/cdo`、`/delivery`、`/ops`、`/tech` 或既有 `/knowledge *` 子指令。",
      ].join("\n"),
    };
  }
  if (!slashCommand && !activeTask && !looksLikeExecutiveStart(text)) {
    return null;
  }

  let decision = null;
  let task = activeTask;
  let nextAgent = null;
  let requestText = text;

  if (slashCommand?.agent) {
    nextAgent = slashCommand.agent;
    requestText = slashCommand.body || text;
    decision = {
      action: !activeTask ? "start" : activeTask.current_agent_id === nextAgent.id ? "continue" : "handoff",
      objective: activeTask?.objective || requestText,
      primary_agent_id: activeTask?.primary_agent_id || nextAgent.id,
      next_agent_id: nextAgent.id,
      supporting_agent_ids: activeTask?.supporting_agent_ids || [],
      reason: "使用者明確指定 agent",
      why: `使用者直接指定 /${nextAgent.id}，所以這輪不再重新做 agent 選擇。`,
      alternative: {
        action: activeTask ? "continue" : "clarify",
        agent_id: activeTask?.current_agent_id || null,
        summary: activeTask
          ? "也可維持目前 agent 繼續，但這輪以使用者明確指定為優先。"
          : "也可先問澄清問題，但這輪指定對象已經足夠明確。",
      },
      pending_questions: [],
    };
  } else {
    decision = await planExecutiveTurnFn({ text, activeTask, logger, sessionKey });
    if (decision?.error === FALLBACK_DISABLED) {
      const failureEnvelope = {
        ok: false,
        error: FALLBACK_DISABLED,
        details: {
          message: cleanText(decision.reason || "") || "executive_planner_fallback_disabled",
        },
        context: {
          objective: cleanText(decision.objective || requestText || "") || null,
          primary_agent_id: cleanText(decision.primary_agent_id || "") || null,
          next_agent_id: cleanText(decision.next_agent_id || "") || null,
          supporting_agent_ids: Array.isArray(decision.supporting_agent_ids)
            ? decision.supporting_agent_ids.map((item) => cleanText(item)).filter(Boolean)
            : [],
          why: cleanText(decision.why || "") || null,
          alternative: decision.alternative || null,
        },
      };
      return {
        text: buildExecutiveUserFacingErrorText({
          answer: "這輪 executive planner 暫時沒有產出可安全執行的決策，所以我先不直接顯示未整理的系統錯誤。",
          limitations: [
            "內部錯誤原因與 decision context 已保留在程式層與 runtime/log，這裡先不直接暴露 raw JSON。",
            cleanText(decision?.alternative?.summary || "")
              || "如果你要繼續，可以改用明確的 agent slash 指令，或把任務目標說得更具體一點後再試。",
          ],
        }),
        error: failureEnvelope.error,
        details: failureEnvelope.details,
        context: failureEnvelope.context,
      };
    }
    nextAgent = getRegisteredAgent(decision.next_agent_id) || getRegisteredAgent("generalist");
  }

  logger?.info?.("executive_orchestrator_decision", {
    trace_id: cleanText(scope?.trace_id || event?.trace_id || activeTask?.trace_id || "") || null,
    action: cleanText(decision?.action || "") || null,
    primary_agent_id: cleanText(decision?.primary_agent_id || "") || null,
    next_agent_id: cleanText(decision?.next_agent_id || "") || null,
    reason: cleanText(decision?.reason || "") || null,
    reasoning: {
      why: cleanText(decision?.why || "") || null,
      alternative: decision?.alternative || null,
    },
  });

  const primaryAgentId = resolveWorkPlanPrimaryAgentId(task, decision);
  const plannedWorkPlan = normalizeWorkPlan(task, decision, requestText);
  const plannedSupportingAgentIds = deriveSupportingAgentIds(plannedWorkPlan, primaryAgentId);

  if (!task) {
    const initialization = buildTaskInitialization({
      objective: decision.objective || requestText,
      agentId: primaryAgentId,
      requestText,
      workflow: slashCommand ? "slash_agent" : "executive_planner",
    });
    task = await startExecutiveTask({
      accountId,
      sessionKey,
      chatId: cleanText(event?.message?.chat_id),
      workflow: "executive",
      workflowState: "active",
      routingHint: "same_session_follow_up",
      traceId: cleanText(scope?.trace_id || event?.trace_id || ""),
      objective: decision.objective || requestText,
      primaryAgentId,
      currentAgentId: primaryAgentId,
      supportingAgentIds: plannedSupportingAgentIds,
      pendingQuestions: decision.pending_questions || [],
      constraints: ["多輪 follow-up 應延續同一個 executive task，除非使用者明確切換或退出"],
      taskType: initialization.task_type,
      lifecycleState: initialization.lifecycle_state,
      goal: initialization.goal,
      successCriteria: initialization.success_criteria,
      failureCriteria: initialization.failure_criteria,
      evidenceRequirements: initialization.evidence_requirements,
      validationMethod: initialization.validation_method,
      retryPolicy: initialization.retry_policy,
      escalationPolicy: initialization.escalation_policy,
      riskLevel: initialization.risk_level,
      workPlan: plannedWorkPlan,
      meta: {
        source: slashCommand ? "slash_agent" : "executive_planner",
        lane: cleanText(scope?.capability_lane || ""),
        last_reason: decision.reason || "",
        last_why: decision.why || "",
        last_alternative: decision.alternative || null,
        // TODO(control-unification-phase2): replace free-form meta with workflow-specific active_task contract.
      },
    });
    task = await transitionTaskLifecycle(task, "clarified", "task_initialized");
    task = await transitionTaskLifecycle(task, "planned", "planner_selected_agent");
  } else {
    if (decision.action === "handoff" && activeTask?.current_agent_id !== primaryAgentId) {
      await appendExecutiveTaskHandoff(task.id, {
        from_agent_id: activeTask?.current_agent_id,
        to_agent_id: primaryAgentId,
        reason: decision.reason,
      });
    }
    task = await updateExecutiveTask(task.id, {
      objective: decision.objective || task.objective,
      primary_agent_id: task.primary_agent_id || primaryAgentId,
      current_agent_id: primaryAgentId,
      workflow_state: "active",
      routing_hint: "same_session_follow_up",
      supporting_agent_ids: plannedSupportingAgentIds.length ? plannedSupportingAgentIds : task.supporting_agent_ids,
      pending_questions: decision.pending_questions || [],
      work_plan: plannedWorkPlan,
      meta: {
        last_reason: decision.reason || "",
        last_why: decision.why || "",
        last_alternative: decision.alternative || null,
      },
    });
  }

  task = await transitionTaskLifecycle(task, "executing", "starting_agent_execution");

  await appendExecutiveTaskTurn(task.id, {
    role: "user",
    text: requestText,
    agent_id: primaryAgentId,
  });

  const execution = await executeWorkItemsSequentially({
    accountId,
    scope,
    event,
    task,
    workPlan: plannedWorkPlan,
    requestText,
    mergeAgentId: primaryAgentId,
    logger,
  });
  const reply = execution.reply;
  if (!reply?.text) {
    return reply;
  }

  const effectiveMergeAgent = execution.mergeAgent || getRegisteredAgent(primaryAgentId) || getRegisteredAgent("generalist");
  const supportingOutputs = execution.supportingOutputs.length ? execution.supportingOutputs : task.agent_outputs || [];
  task = await updateExecutiveTask(task.id, {
    current_agent_id: effectiveMergeAgent.id,
    supporting_agent_ids: deriveSupportingAgentIds(execution.finalWorkPlan, effectiveMergeAgent.id),
    work_plan: execution.finalWorkPlan,
  });

  await appendExecutiveTaskTurn(task.id, {
    role: "assistant",
    text: reply.text,
    agent_id: effectiveMergeAgent.id,
  });

  const header = buildOrchestrationHeader({
    action: decision.action,
    task,
    nextAgent: effectiveMergeAgent,
    reason: execution.fallbackUsed
      ? `${cleanText(decision.reason || "") || "specialist failed"}，所以改由 /generalist fail-soft 收斂`
      : decision.reason,
  });

  const finalized = await finalizeExecutiveTaskTurn({
    task,
    accountId,
    sessionKey,
    requestText,
    reply,
    supportingOutputs: supportingOutputs.length ? supportingOutputs : task.agent_outputs || [],
    routing: {
      current_agent_id: effectiveMergeAgent.id,
      primary_agent_id: task.primary_agent_id,
      action: decision.action,
      reason: decision.reason,
      dispatched_actions: execution.dispatchedActions,
      fallback_used: execution.fallbackUsed,
      synthetic_agent_hint: null,
    },
  });

  return {
    ...reply,
    task_state: finalized?.task?.lifecycle_state || task.lifecycle_state,
    verification: finalized?.verification || null,
    text: buildExecutiveBrief({
      header,
      workPlan: execution.finalWorkPlan,
      primaryAgentId: effectiveMergeAgent.id,
      supportingOutputs: supportingOutputs.length ? supportingOutputs : task.agent_outputs || [],
      primaryReplyText: reply.text,
    }),
  };
}

export async function executeExecutiveTurn(args = {}) {
  const sessionKey = sessionKeyFromScope(args.scope, args.accountId);
  return runWithSessionCoordination({
    accountId: args.accountId,
    sessionKey,
    workflow: "executive",
    reason: "execute_executive_turn",
    logger: args.logger || noopLogger,
  }, () => executeExecutiveTurnUnlocked(args));
}
