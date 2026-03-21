import { executeRegisteredAgent } from "./agent-dispatcher.mjs";
import { getRegisteredAgent, parseRegisteredAgentCommand } from "./agent-registry.mjs";
import {
  buildTaskInitialization,
  finalizeExecutiveTaskTurn,
  finalizeWorkflowVerificationGate,
} from "./executive-closed-loop.mjs";
import { buildLifecycleTransition } from "./executive-lifecycle.mjs";
import { buildVisibleMessageText, cleanText } from "./message-intent-utils.mjs";
import { looksLikeExecutiveExit, looksLikeExecutiveStart, planExecutiveTurn } from "./executive-planner.mjs";
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

function sessionKeyFromScope(scope = {}, accountId = "") {
  return cleanText(scope?.session_key || scope?.chat_id || accountId);
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

export function normalizeWorkPlan(task = null, decision = null, requestText = "") {
  const plan = Array.isArray(decision?.work_items) && decision.work_items.length
    ? decision.work_items
    : Array.isArray(task?.work_plan)
      ? task.work_plan
      : [];
  const unique = [];
  const seen = new Set();
  for (const item of plan) {
    const agentId = cleanText(item?.agent_id);
    const work = cleanText(item?.task || requestText);
    if (!agentId || !work || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    unique.push({
      agent_id: agentId,
      task: work,
      role: cleanText(item?.role || ""),
      status: cleanText(item?.status || "pending") || "pending",
    });
    if (unique.length >= 8) {
      break;
    }
  }
  return unique;
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
      const status = item.status === "completed" ? "已完成" : "待處理";
      return `${index + 1}. ${prefix} /${item.agent_id}｜${status}｜${item.task}`;
    }),
  ].join("\n");
}

export function buildSupportingContext(outputs = []) {
  const lines = [];
  for (const item of outputs.slice(0, 6)) {
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
    ...items.slice(0, 6).map((item, index) =>
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
  return [
    summarizeAgentText(primaryReplyText, 2400),
    header,
    buildVisibleWorkPlan(workPlan, { primaryAgentId }),
    buildVisibleSupportingOutputs(supportingOutputs),
  ]
    .filter(Boolean)
    .join("\n\n");
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

export async function ensureMeetingWorkflowTask({
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

export async function markMeetingWorkflowWritingBack({
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

export async function finalizeMeetingWorkflowTask({
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
      await clearActiveExecutiveTask(accountId, sessionKey);
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

export async function ensureDocRewriteWorkflowTask({
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

export async function markDocRewriteApplying({
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
  if (!task?.id || task.workflow !== "doc_rewrite") {
    return null;
  }
  return updateExecutiveTask(task.id, {
    workflow: "doc_rewrite",
    workflow_state: "applying",
    routing_hint: "doc_rewrite_apply",
    trace_id: cleanText(scope?.trace_id || event?.trace_id || task.trace_id),
    status: "active",
    meta,
  });
}

export async function finalizeDocRewriteWorkflowTask({
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
      await clearActiveExecutiveTask(accountId, sessionKey);
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

export async function ensureCloudDocWorkflowTask({
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

export async function markCloudDocApplying({
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

export async function finalizeCloudDocWorkflowTask({
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
    await clearActiveExecutiveTask(accountId, sessionKey);
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

async function runSupportingAgents({
  accountId,
  scope,
  event,
  task,
  nextAgent,
  workPlan = [],
  logger = noopLogger,
}) {
  const supportingItems = workPlan.filter((item) => item.agent_id && item.agent_id !== nextAgent.id);
  if (!supportingItems.length) {
    return [];
  }

  const settled = await Promise.allSettled(
    supportingItems.map(async (item) => {
      const agent = getRegisteredAgent(item.agent_id);
      if (!agent) {
        return null;
      }
      const reply = await executeRegisteredAgent({
        accountId,
        agent,
        requestText: item.task,
        scope,
        event,
        logger,
      });
      const summary = cleanText(reply?.text || "");
      if (!summary) {
        return null;
      }
      return {
        agent_id: agent.id,
        task: item.task,
        summary: summarizeAgentText(summary, 520),
        status: "completed",
      };
    }),
  );

  const outputs = settled
    .map((item) => (item.status === "fulfilled" ? item.value : null))
    .filter(Boolean);

  for (const item of outputs) {
    await appendExecutiveAgentOutput(task.id, item);
  }
  return outputs;
}

export async function executeExecutiveTurn({ accountId, event, scope, logger = noopLogger }) {
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
    await clearActiveExecutiveTask(accountId, sessionKey);
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
      text: JSON.stringify({
        ok: false,
        error: ROUTING_NO_MATCH,
        details: {
          message: "registered_agent_command_no_match",
        },
      }, null, 2),
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
    decision = await planExecutiveTurn({ text, activeTask, logger });
    if (decision?.error === FALLBACK_DISABLED) {
      return {
        text: JSON.stringify({
          ok: false,
          error: FALLBACK_DISABLED,
          details: {
            message: cleanText(decision.reason || "") || "executive_planner_fallback_disabled",
          },
        }, null, 2),
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

  if (!task) {
    const initialization = buildTaskInitialization({
      objective: decision.objective || requestText,
      agentId: decision.primary_agent_id || nextAgent.id,
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
      primaryAgentId: decision.primary_agent_id || nextAgent.id,
      currentAgentId: nextAgent.id,
      supportingAgentIds: decision.supporting_agent_ids || [],
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
      workPlan: normalizeWorkPlan(null, decision, requestText),
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
    if (decision.action === "handoff" && activeTask?.current_agent_id !== nextAgent.id) {
      await appendExecutiveTaskHandoff(task.id, {
        from_agent_id: activeTask?.current_agent_id,
        to_agent_id: nextAgent.id,
        reason: decision.reason,
      });
    }
    task = await updateExecutiveTask(task.id, {
      objective: decision.objective || task.objective,
      primary_agent_id: task.primary_agent_id || decision.primary_agent_id || nextAgent.id,
      current_agent_id: nextAgent.id,
      workflow_state: "active",
      routing_hint: "same_session_follow_up",
      supporting_agent_ids: decision.supporting_agent_ids?.length ? decision.supporting_agent_ids : task.supporting_agent_ids,
      pending_questions: decision.pending_questions || [],
      work_plan: normalizeWorkPlan(task, decision, requestText),
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
    agent_id: nextAgent.id,
  });

  const workPlan = normalizeWorkPlan(task, decision, requestText);
  const supportingOutputs = await runSupportingAgents({
    accountId,
    scope,
    event,
    task,
    nextAgent,
    workPlan,
    logger,
  });
  if (supportingOutputs.length) {
    task = await updateExecutiveTask(task.id, {
      work_plan: workPlan.map((item) => ({
        ...item,
        status: item.agent_id === nextAgent.id ? item.status : "completed",
      })),
    });
  }

  const reply = await executeRegisteredAgent({
    accountId,
    agent: nextAgent,
    requestText,
    scope,
    event,
    supportingContext: buildSupportingContext(
      supportingOutputs.length ? supportingOutputs : task.agent_outputs || [],
    ),
    logger,
  });
  if (!reply?.text) {
    return reply;
  }

  await appendExecutiveTaskTurn(task.id, {
    role: "assistant",
    text: reply.text,
    agent_id: nextAgent.id,
  });

  const header = buildOrchestrationHeader({
    action: decision.action,
    task,
    nextAgent,
    reason: decision.reason,
  });

  const finalized = await finalizeExecutiveTaskTurn({
    task,
    accountId,
    sessionKey,
    requestText,
    reply,
    supportingOutputs: supportingOutputs.length ? supportingOutputs : task.agent_outputs || [],
    routing: {
      current_agent_id: nextAgent.id,
      primary_agent_id: task.primary_agent_id,
      action: decision.action,
      reason: decision.reason,
    },
  });

  return {
    ...reply,
    task_state: finalized?.task?.lifecycle_state || task.lifecycle_state,
    verification: finalized?.verification || null,
    text: buildExecutiveBrief({
      header,
      workPlan,
      primaryAgentId: nextAgent.id,
      supportingOutputs: supportingOutputs.length ? supportingOutputs : task.agent_outputs || [],
      primaryReplyText: reply.text,
    }),
  };
}
