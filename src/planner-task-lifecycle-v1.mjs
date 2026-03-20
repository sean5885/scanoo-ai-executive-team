import fs from "node:fs/promises";

import { plannerTaskLifecycleV1StorePath } from "./config.mjs";
import { buildLifecycleTransition } from "./executive-lifecycle.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { nowIso, sha256 } from "./text-utils.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const STORE_VERSION = "planner_task_lifecycle_v1";
const TASK_PROGRESS_STATES = Object.freeze(["planned", "in_progress", "blocked", "done"]);
const TASK_PROGRESS_TRANSITIONS = Object.freeze({
  planned: ["in_progress", "blocked", "done"],
  in_progress: ["blocked", "done"],
  blocked: ["in_progress", "done"],
  done: [],
});
const TASK_EXECUTION_PROGRESS_STATUSES = Object.freeze(["started", "half_done", "handled", "blocked", "completed"]);
const TASK_EXECUTION_PROGRESS_LABELS = Object.freeze({
  started: "已開始",
  half_done: "完成一半",
  handled: "已處理",
  blocked: "卡點",
  completed: "已完成",
});
let inMemoryStoreOverride = null;

function createStore() {
  return {
    version: STORE_VERSION,
    tasks: {},
    scopes: {},
    latest_scope_key: null,
  };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoreForTests(store = {}) {
  return normalizeStore(store);
}

function normalizeStringList(items = [], limit = 8) {
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = cleanText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function normalizeExecutionProgressStatus(value = "") {
  const normalized = cleanText(value);
  return TASK_EXECUTION_PROGRESS_STATUSES.includes(normalized) ? normalized : null;
}

function buildExecutionProgressSummary({
  progressStatus = "",
  note = "",
} = {}) {
  const normalizedProgressStatus = normalizeExecutionProgressStatus(progressStatus);
  const normalizedNote = cleanText(note) || null;
  const label = normalizedProgressStatus ? TASK_EXECUTION_PROGRESS_LABELS[normalizedProgressStatus] : null;
  if (!label) {
    return null;
  }
  if (normalizedProgressStatus === "blocked" && normalizedNote) {
    return `${label}：${normalizedNote}`;
  }
  return label;
}

function normalizeTask(task = {}) {
  const taskState = cleanText(task.task_state || task.state || "planned") || "planned";
  const note = cleanText(task.note) || null;
  const result = cleanText(task.result) || null;
  const progressStatus = normalizeExecutionProgressStatus(task.progress_status);
  const progressSummary = cleanText(task.progress_summary)
    || buildExecutionProgressSummary({
      progressStatus,
      note,
    });
  return {
    id: cleanText(task.id),
    scope_key: cleanText(task.scope_key),
    title: cleanText(task.title),
    theme: cleanText(task.theme) || null,
    owner: cleanText(task.owner) || null,
    deadline: cleanText(task.deadline) || null,
    risks: normalizeStringList(task.risks, 8),
    source_action: cleanText(task.source_action) || null,
    source_kind: cleanText(task.source_kind) || null,
    source_trace_id: cleanText(task.source_trace_id) || null,
    source_doc_id: cleanText(task.source_doc_id) || null,
    source_title: cleanText(task.source_title) || null,
    source_match_reason: cleanText(task.source_match_reason) || null,
    source_summary: cleanText(task.source_summary) || null,
    source_status: cleanText(task.source_status) || null,
    task_state: TASK_PROGRESS_STATES.includes(taskState) ? taskState : "planned",
    progress_status: progressStatus,
    progress_summary: progressSummary,
    note,
    result,
    execution_started_at: cleanText(task.execution_started_at) || null,
    last_progress_at: cleanText(task.last_progress_at) || null,
    completed_at: cleanText(task.completed_at || task.last_completed_at) || null,
    execution_history: Array.isArray(task.execution_history)
      ? task.execution_history
          .map((item) => (
            item && typeof item === "object"
              ? {
                  task_state: cleanText(item.task_state) || null,
                  progress_status: normalizeExecutionProgressStatus(item.progress_status),
                  progress_summary: cleanText(item.progress_summary) || null,
                  note: cleanText(item.note) || null,
                  result: cleanText(item.result) || null,
                  reason: cleanText(item.reason) || null,
                  actor: cleanText(item.actor) || null,
                  at: cleanText(item.at) || null,
                }
              : null
          ))
          .filter((item) => item?.task_state || item?.progress_status || item?.note || item?.result)
          .slice(-12)
      : [],
    state_history: Array.isArray(task.state_history)
      ? task.state_history
          .map((item) => (
            item && typeof item === "object"
              ? {
                  from: cleanText(item.from) || null,
                  to: cleanText(item.to) || null,
                  reason: cleanText(item.reason) || null,
                  actor: cleanText(item.actor) || null,
                  at: cleanText(item.at) || null,
                }
              : null
          ))
          .filter((item) => item?.to)
          .slice(-12)
      : [],
    lifecycle_state: cleanText(task.lifecycle_state || "created") || "created",
    lifecycle_last_transition:
      task.lifecycle_last_transition && typeof task.lifecycle_last_transition === "object"
        ? { ...task.lifecycle_last_transition }
        : null,
    lifecycle_history: Array.isArray(task.lifecycle_history)
      ? task.lifecycle_history
          .map((item) => (
            item && typeof item === "object"
              ? {
                  from: cleanText(item.from) || null,
                  to: cleanText(item.to) || null,
                  reason: cleanText(item.reason) || null,
                  actor: cleanText(item.actor) || null,
                  at: cleanText(item.at) || null,
                }
              : null
          ))
          .filter((item) => item?.to)
          .slice(-12)
      : [],
    created_at: cleanText(task.created_at) || nowIso(),
    updated_at: cleanText(task.updated_at) || nowIso(),
    last_suggested_at: cleanText(task.last_suggested_at) || null,
    suggestion_count: Number.isFinite(task.suggestion_count) ? Number(task.suggestion_count) : 0,
  };
}

function normalizeScope(scope = {}) {
  return {
    scope_key: cleanText(scope.scope_key),
    theme: cleanText(scope.theme) || null,
    selected_action: cleanText(scope.selected_action) || null,
    user_intent: cleanText(scope.user_intent) || null,
    trace_id: cleanText(scope.trace_id) || null,
    source_kind: cleanText(scope.source_kind) || null,
    source_doc_id: cleanText(scope.source_doc_id) || null,
    source_title: cleanText(scope.source_title) || null,
    source_match_reason: cleanText(scope.source_match_reason) || null,
    last_active_task_id: cleanText(scope.last_active_task_id) || null,
    current_task_ids: normalizeStringList(scope.current_task_ids, 12),
    created_at: cleanText(scope.created_at) || nowIso(),
    updated_at: cleanText(scope.updated_at) || nowIso(),
  };
}

function normalizeStore(store = {}) {
  return {
    version: STORE_VERSION,
    tasks: Object.fromEntries(
      Object.entries(store?.tasks || {}).map(([key, value]) => [key, normalizeTask(value)]),
    ),
    scopes: Object.fromEntries(
      Object.entries(store?.scopes || {}).map(([key, value]) => [key, normalizeScope(value)]),
    ),
    latest_scope_key: cleanText(store?.latest_scope_key) || null,
  };
}

async function loadStore() {
  if (inMemoryStoreOverride) {
    return cloneValue(inMemoryStoreOverride);
  }
  const raw = await readJsonFile(plannerTaskLifecycleV1StorePath);
  return normalizeStore(raw || {});
}

async function saveStore(store = {}) {
  const normalized = normalizeStore(store);
  if (inMemoryStoreOverride) {
    inMemoryStoreOverride = cloneValue(normalized);
    return;
  }
  await writeJsonFile(plannerTaskLifecycleV1StorePath, normalized);
}

function normalizePlannerTasks(items = []) {
  return normalizeStringList(items, 5);
}

function inferTheme({ flow = null, context = {} } = {}) {
  const contextTheme = cleanText(context?.activeTheme);
  if (contextTheme) {
    return contextTheme;
  }
  const flowId = cleanText(flow?.id);
  if (["okr", "bd", "delivery"].includes(flowId)) {
    return flowId;
  }
  return null;
}

function buildScopeKey({
  selectedAction = "",
  userIntent = "",
  theme = "",
  formattedOutput = {},
} = {}) {
  const kind = cleanText(formattedOutput?.kind);
  const docId = cleanText(formattedOutput?.doc_id);
  const matchReason = cleanText(formattedOutput?.match_reason || userIntent);
  const itemKey = Array.isArray(formattedOutput?.items)
    ? formattedOutput.items
        .map((item) => cleanText(item?.doc_id || item?.title))
        .filter(Boolean)
        .slice(0, 5)
        .join("|")
    : "";
  const base = [
    cleanText(theme),
    cleanText(selectedAction),
    kind,
    docId || itemKey || matchReason,
  ].filter(Boolean).join("::");
  return base ? `planner_scope_${sha256(base).slice(0, 16)}` : null;
}

function applyTaskTransition(task = null, nextState = "", reason = "") {
  if (!task?.id) {
    return task;
  }
  if (cleanText(task.lifecycle_state) === cleanText(nextState)) {
    return task;
  }
  const transition = buildLifecycleTransition({
    from: task.lifecycle_state,
    to: nextState,
    reason,
    actor: "planner_action_layer",
  });
  if (!transition.ok) {
    return task;
  }
  return {
    ...task,
    ...transition.patch,
    lifecycle_history: [
      ...(Array.isArray(task.lifecycle_history) ? task.lifecycle_history : []),
      transition.patch.lifecycle_last_transition,
    ].slice(-12),
  };
}

function buildTaskId(scopeKey = "", title = "") {
  const normalizedScopeKey = cleanText(scopeKey);
  const normalizedTitle = cleanText(title);
  if (!normalizedScopeKey || !normalizedTitle) {
    return null;
  }
  return `planner_task_${sha256(`${normalizedScopeKey}::${normalizedTitle}`).slice(0, 16)}`;
}

function canTransitionTaskProgressState(from = "", to = "") {
  const current = cleanText(from || "planned") || "planned";
  const next = cleanText(to);
  return Boolean(next) && (TASK_PROGRESS_TRANSITIONS[current] || []).includes(next);
}

function applyTaskProgressTransition(task = null, nextState = "", reason = "", actor = "planner_task_follow_up") {
  if (!task?.id) {
    return task;
  }
  const currentState = cleanText(task.task_state || "planned") || "planned";
  const normalizedNextState = cleanText(nextState);
  if (!normalizedNextState || currentState === normalizedNextState) {
    return normalizeTask(task);
  }
  if (!canTransitionTaskProgressState(currentState, normalizedNextState)) {
    return normalizeTask(task);
  }
  return normalizeTask({
    ...task,
    task_state: normalizedNextState,
    updated_at: nowIso(),
    state_history: [
      ...(Array.isArray(task.state_history) ? task.state_history : []),
      {
        from: currentState,
        to: normalizedNextState,
        reason: cleanText(reason) || null,
        actor: cleanText(actor) || "planner_task_follow_up",
        at: nowIso(),
      },
    ].slice(-12),
  });
}

function progressStatusFromTaskState(taskState = "") {
  const normalizedTaskState = cleanText(taskState);
  if (normalizedTaskState === "in_progress") {
    return "started";
  }
  if (normalizedTaskState === "blocked") {
    return "blocked";
  }
  if (normalizedTaskState === "done") {
    return "completed";
  }
  return null;
}

function applyTaskExecutionUpdate(task = null, {
  nextState = "",
  progressStatus = "",
  note = "",
  result = "",
  reason = "",
  actor = "planner_task_follow_up",
} = {}) {
  const normalizedTask = normalizeTask(task);
  if (!normalizedTask?.id) {
    return {
      task: normalizedTask,
      changed: false,
    };
  }

  const timestamp = nowIso();
  const normalizedNextState = cleanText(nextState);
  const normalizedNote = cleanText(note) || null;
  const normalizedResult = cleanText(result) || null;
  const derivedProgressStatus = normalizeExecutionProgressStatus(progressStatus)
    || progressStatusFromTaskState(normalizedNextState);

  let nextTask = normalizedTask;
  let changed = false;
  let stateChanged = false;

  if (normalizedNextState && canTransitionTaskProgressState(normalizedTask.task_state, normalizedNextState)) {
    nextTask = applyTaskProgressTransition(nextTask, normalizedNextState, reason, actor);
    changed = cleanText(nextTask?.task_state) !== cleanText(normalizedTask.task_state);
    stateChanged = changed;
  }

  const nextProgressSummary = buildExecutionProgressSummary({
    progressStatus: derivedProgressStatus || nextTask?.progress_status,
    note: normalizedNote || nextTask?.note,
  });

  if (derivedProgressStatus && derivedProgressStatus !== nextTask.progress_status) {
    nextTask = {
      ...nextTask,
      progress_status: derivedProgressStatus,
    };
    changed = true;
  }

  if (nextProgressSummary && nextProgressSummary !== nextTask.progress_summary) {
    nextTask = {
      ...nextTask,
      progress_summary: nextProgressSummary,
    };
    changed = true;
  }

  if (normalizedNote && normalizedNote !== nextTask.note) {
    nextTask = {
      ...nextTask,
      note: normalizedNote,
    };
    changed = true;
  }

  if (normalizedResult && normalizedResult !== nextTask.result) {
    nextTask = {
      ...nextTask,
      result: normalizedResult,
    };
    changed = true;
  }

  if (
    !nextTask.execution_started_at
    && (
      cleanText(nextTask.task_state) === "in_progress"
      || ["started", "half_done", "handled"].includes(derivedProgressStatus || "")
    )
  ) {
    nextTask = {
      ...nextTask,
      execution_started_at: timestamp,
    };
    changed = true;
  }

  if (!nextTask.completed_at && cleanText(nextTask.task_state) === "done") {
    nextTask = {
      ...nextTask,
      completed_at: timestamp,
    };
    changed = true;
  }

  if (!changed) {
    return {
      task: nextTask,
      changed: false,
    };
  }

  nextTask = normalizeTask({
    ...nextTask,
    updated_at: timestamp,
    last_progress_at: timestamp,
    execution_history: [
      ...(Array.isArray(nextTask.execution_history) ? nextTask.execution_history : []),
      {
        task_state: cleanText(nextTask.task_state) || null,
        progress_status: derivedProgressStatus || nextTask.progress_status || progressStatusFromTaskState(nextTask.task_state),
        progress_summary: buildExecutionProgressSummary({
          progressStatus: derivedProgressStatus || nextTask.progress_status,
          note: normalizedNote || nextTask.note,
        }),
        note: normalizedNote || nextTask.note,
        result: normalizedResult || nextTask.result,
        reason: cleanText(reason) || null,
        actor: cleanText(actor) || "planner_task_follow_up",
        at: timestamp,
      },
    ].slice(-12),
  });

  if (!stateChanged && cleanText(nextTask.task_state) === "planned" && normalizedNextState === "planned") {
    return {
      task: nextTask,
      changed: true,
    };
  }

  return {
    task: nextTask,
    changed: true,
  };
}

function createOrUpdateLifecycleTask({
  currentTask = null,
  scopeKey = "",
  title = "",
  theme = "",
  traceId = "",
  selectedAction = "",
  formattedOutput = {},
  actionLayer = {},
} = {}) {
  const taskId = currentTask?.id || buildTaskId(scopeKey, title);
  if (!taskId) {
    return null;
  }
  const timestamp = nowIso();
  let task = normalizeTask({
    ...currentTask,
    id: taskId,
    scope_key: scopeKey,
    title,
    theme,
    owner: actionLayer?.owner,
    deadline: actionLayer?.deadline,
    risks: actionLayer?.risks,
    source_action: selectedAction,
    source_kind: formattedOutput?.kind,
    source_trace_id: traceId,
    source_doc_id: formattedOutput?.doc_id,
    source_title: formattedOutput?.title,
    source_match_reason: formattedOutput?.match_reason,
    source_summary: formattedOutput?.content_summary,
    source_status: actionLayer?.status,
    task_state: currentTask?.task_state || "planned",
    state_history: currentTask?.state_history || [],
    created_at: currentTask?.created_at || timestamp,
    updated_at: timestamp,
    last_suggested_at: timestamp,
    suggestion_count: Number.isFinite(currentTask?.suggestion_count)
      ? Number(currentTask.suggestion_count) + 1
      : 1,
  });

  if (!currentTask) {
    task = applyTaskTransition(task, "clarified", "task_created_from_action_layer");
    task = applyTaskTransition(task, "planned", "task_planned_from_next_action");
  } else if (task.lifecycle_state === "created") {
    task = applyTaskTransition(task, "clarified", "task_reobserved_from_action_layer");
    task = applyTaskTransition(task, "planned", "task_replanned_from_next_action");
  } else if (task.lifecycle_state === "clarified") {
    task = applyTaskTransition(task, "planned", "task_replanned_from_next_action");
  }

  return normalizeTask(task);
}

function buildScopeSnapshot({
  scopeKey = "",
  theme = "",
  selectedAction = "",
  userIntent = "",
  traceId = "",
  formattedOutput = {},
  taskIds = [],
  lastActiveTaskId = "",
  existingScope = null,
} = {}) {
  return normalizeScope({
    ...existingScope,
    scope_key: scopeKey,
    theme,
    selected_action: selectedAction,
    user_intent: userIntent,
    trace_id: traceId,
    source_kind: formattedOutput?.kind,
    source_doc_id: formattedOutput?.doc_id,
    source_title: formattedOutput?.title,
    source_match_reason: formattedOutput?.match_reason,
    last_active_task_id: cleanText(lastActiveTaskId) || cleanText(existingScope?.last_active_task_id) || null,
    current_task_ids: taskIds,
    created_at: existingScope?.created_at || nowIso(),
    updated_at: nowIso(),
  });
}

export async function syncPlannerActionLayerTaskLifecycle({
  flow = null,
  context = {},
  selectedAction = "",
  userIntent = "",
  executionResult = null,
  traceId = "",
} = {}) {
  const formattedOutput = executionResult?.formatted_output;
  const actionLayer = formattedOutput?.action_layer;
  const nextActions = normalizePlannerTasks(actionLayer?.next_actions);
  if (!formattedOutput || typeof formattedOutput !== "object" || !nextActions.length) {
    return null;
  }

  const theme = inferTheme({ flow, context });
  const scopeKey = buildScopeKey({
    selectedAction,
    userIntent,
    theme,
    formattedOutput,
  });
  if (!scopeKey) {
    return null;
  }

  const store = await loadStore();
  const currentTaskIds = [];
  for (const nextAction of nextActions) {
    const taskId = buildTaskId(scopeKey, nextAction);
    const currentTask = taskId ? store.tasks[taskId] : null;
    const task = createOrUpdateLifecycleTask({
      currentTask,
      scopeKey,
      title: nextAction,
      theme,
      traceId,
      selectedAction,
      formattedOutput,
      actionLayer,
    });
    if (!task?.id) {
      continue;
    }
    store.tasks[task.id] = task;
    currentTaskIds.push(task.id);
  }

  if (!currentTaskIds.length) {
    return null;
  }

  store.scopes[scopeKey] = buildScopeSnapshot({
    scopeKey,
    theme,
    selectedAction,
    userIntent,
    traceId,
    formattedOutput,
    taskIds: currentTaskIds,
    lastActiveTaskId: resolveTaskDrivingFocusTask(currentTaskIds.map((taskId) => store.tasks[taskId]).filter(Boolean))?.id,
    existingScope: store.scopes[scopeKey],
  });
  store.latest_scope_key = scopeKey;
  await saveStore(store);

  return {
    scope: cloneValue(store.scopes[scopeKey]),
    tasks: currentTaskIds.map((taskId) => cloneValue(store.tasks[taskId])).filter(Boolean),
  };
}

export function buildPlannerLifecycleUnfinishedItems(snapshot = null) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  return tasks
    .filter((task) => cleanText(task?.task_state) !== "done")
    .slice(0, 5)
    .map((task) => ({
      type: "task_lifecycle_v1",
      label: `待跟進：${cleanText(task?.title)}`,
    }));
}

function buildPlannerTaskDecisionItem(task = {}) {
  return {
    title: cleanText(task?.title) || "未命名 task",
    owner: cleanText(task?.owner) || null,
    deadline: cleanText(task?.deadline) || null,
    task_state: cleanText(task?.task_state || "planned") || "planned",
    progress_summary: cleanText(task?.progress_summary) || null,
    note: cleanText(task?.note) || null,
    risks: normalizeStringList(task?.risks, 3),
  };
}

function buildTaskDrivingMissingFields(task = {}) {
  const missing = [];
  if (!cleanText(task?.owner)) {
    missing.push("owner");
  }
  if (!cleanText(task?.deadline)) {
    missing.push("deadline");
  }
  return missing;
}

function buildTaskDrivingNextStep(task = {}) {
  const item = buildPlannerTaskDecisionItem(task);
  const missingFields = buildTaskDrivingMissingFields(task);
  const taskTitle = item.title;

  if (item.task_state === "blocked") {
    if (item.note) {
      return `優先解除阻塞：「${taskTitle}」先處理 ${item.note}`;
    }
    if (item.risks.length > 0) {
      return `優先解除阻塞：「${taskTitle}」先處理 ${item.risks[0]}`;
    }
    if (missingFields.length > 0) {
      return `優先解除阻塞：先補齊「${taskTitle}」的 ${missingFields.join(" / ")}`;
    }
    if (item.owner) {
      return `優先找 ${item.owner} 解除「${taskTitle}」阻塞`;
    }
    return `優先確認「${taskTitle}」缺少的資源與協助`;
  }

  if (item.task_state === "in_progress") {
    if (item.progress_summary && item.deadline) {
      return `延續執行：「${taskTitle}」${item.progress_summary}，先對齊 ${item.deadline} 前的下一步`;
    }
    if (item.progress_summary) {
      return `延續執行：「${taskTitle}」${item.progress_summary}，並回報下一個可執行動作`;
    }
    if (item.deadline) {
      return `延續執行：「${taskTitle}」，先對齊 ${item.deadline} 前的交付節點`;
    }
    return `延續執行：「${taskTitle}」並回報下一個可執行動作`;
  }

  if (item.task_state === "planned") {
    if (missingFields.length > 0) {
      return `先補齊「${taskTitle}」的 ${missingFields.join(" / ")}`;
    }
    if (item.owner && item.deadline) {
      return `先由 ${item.owner} 推進「${taskTitle}」，目標 ${item.deadline}`;
    }
    if (item.owner) {
      return `先由 ${item.owner} 啟動「${taskTitle}」`;
    }
    return `啟動「${taskTitle}」的下一步`;
  }

  if (item.task_state === "done") {
    return `確認「${taskTitle}」的 result 與收尾事項`;
  }

  return null;
}

function buildTaskDrivingPendingQuestion(task = {}) {
  const item = buildPlannerTaskDecisionItem(task);
  if (!item.title) {
    return null;
  }

  if (item.task_state === "blocked") {
    if (!item.note) {
      return `「${item.title}」目前卡在哪個環節？`;
    }
    if (!item.owner) {
      return `誰可以主責解除「${item.title}」的阻塞？`;
    }
    if (!item.deadline) {
      return `「${item.title}」解除阻塞後希望何時完成？`;
    }
    return null;
  }

  if (!item.owner) {
    return `誰來負責「${item.title}」？`;
  }
  if (!item.deadline && item.task_state !== "done") {
    return `「${item.title}」預計何時完成？`;
  }
  return null;
}

function buildTaskDrivingContext(tasks = []) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const focusTask = resolveTaskDrivingFocusTask(normalizedTasks);
  if (!focusTask) {
    return null;
  }

  const item = buildPlannerTaskDecisionItem(focusTask);
  return {
    mode: item.task_state === "blocked"
      ? "unblock"
      : item.task_state === "in_progress"
        ? "continue"
        : "next_step",
    task: item,
    suggested_next_step: buildTaskDrivingNextStep(focusTask),
    suggested_question: buildTaskDrivingPendingQuestion(focusTask),
  };
}

function resolveTaskDrivingFocusTask(tasks = []) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const blockedTask = normalizedTasks.find((task) => cleanText(task?.task_state) === "blocked");
  const inProgressTask = normalizedTasks.find((task) => cleanText(task?.task_state) === "in_progress");
  const unfinishedTask = normalizedTasks.find((task) => cleanText(task?.task_state) !== "done");
  return blockedTask || inProgressTask || unfinishedTask || null;
}

function formatPlannerTaskDecisionReference(task = {}, {
  includeProgress = false,
  includeRisk = false,
} = {}) {
  const item = buildPlannerTaskDecisionItem(task);
  const details = [`狀態=${item.task_state}`];
  if (item.owner) {
    details.push(`owner=${item.owner}`);
  }
  if (item.deadline) {
    details.push(`deadline=${item.deadline}`);
  }
  if (includeProgress && item.progress_summary) {
    details.push(item.progress_summary);
  }
  if (includeRisk && item.note) {
    details.push(`卡點=${item.note}`);
  }
  if (includeRisk && item.risks.length > 0) {
    details.push(`風險=${item.risks.join("、")}`);
  }
  return `${item.title}（${details.join("；")}）`;
}

export function buildPlannerTaskDecisionContext(snapshot = null) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  if (!tasks.length) {
    return null;
  }

  const focusTask = snapshot?.focus_task && typeof snapshot.focus_task === "object"
    ? snapshot.focus_task
    : null;
  const unfinishedTasks = tasks.filter((task) => cleanText(task?.task_state) !== "done");
  const blockedTasks = tasks.filter((task) => cleanText(task?.task_state) === "blocked");
  const inProgressTasks = tasks.filter((task) => cleanText(task?.task_state) === "in_progress");
  const taskDriving = buildTaskDrivingContext(focusTask ? [focusTask] : tasks);
  const orderedReferenceTasks = [
    ...(focusTask && cleanText(focusTask?.task_state) !== "done" ? [focusTask] : []),
    ...unfinishedTasks.filter((task) => cleanText(task?.id) !== cleanText(focusTask?.id)),
  ];

  return {
    scope_title: cleanText(snapshot?.scope?.source_title) || cleanText(snapshot?.scope?.theme) || "task lifecycle",
    theme: cleanText(snapshot?.scope?.theme) || null,
    scope_binding: formatFocusBindingReason(snapshot?.scope_reason),
    aggregate_state: resolveAggregateTaskState(tasks),
    counts: summarizeTaskStateCounts(tasks),
    focus_hint: focusTask
      ? `當前優先 task：${formatPlannerTaskDecisionReference(focusTask, {
          includeProgress: true,
          includeRisk: true,
        })}${cleanText(snapshot?.focus_reason) ? `；綁定來源=${formatFocusBindingReason(snapshot.focus_reason)}` : ""}`
      : null,
    unfinished_hint: unfinishedTasks.length > 0
      ? `優先引用未完成 task：${orderedReferenceTasks.slice(0, 3).map((task) => formatPlannerTaskDecisionReference(task, {
          includeProgress: true,
        })).join("；")}`
      : null,
    blocked_hint: blockedTasks.length > 0
      ? `需主動提醒 blocked 風險：${blockedTasks.slice(0, 3).map((task) => formatPlannerTaskDecisionReference(task, {
          includeRisk: true,
          includeProgress: true,
        })).join("；")}`
      : null,
    in_progress_hint: inProgressTasks.length > 0
      ? `可提供進度摘要：${inProgressTasks.slice(0, 3).map((task) => formatPlannerTaskDecisionReference(task, {
          includeProgress: true,
        })).join("；")}`
      : null,
    next_step_hint: cleanText(taskDriving?.suggested_next_step)
      ? `主動下一步：${cleanText(taskDriving.suggested_next_step)}`
      : null,
    unblock_question_hint: cleanText(taskDriving?.suggested_question)
      ? `若需補資源，優先確認：${cleanText(taskDriving.suggested_question)}`
      : null,
    focused_task: focusTask ? buildPlannerTaskDecisionItem(focusTask) : null,
    reference_tasks: orderedReferenceTasks.slice(0, 3).map((task) => buildPlannerTaskDecisionItem(task)),
    blocked_tasks: blockedTasks.slice(0, 3).map((task) => buildPlannerTaskDecisionItem(task)),
    in_progress_tasks: inProgressTasks.slice(0, 3).map((task) => buildPlannerTaskDecisionItem(task)),
    task_driving: taskDriving,
  };
}

function buildSnapshotFromStore(store = {}, scopeKey = "") {
  const normalizedScopeKey = cleanText(scopeKey);
  if (!normalizedScopeKey) {
    return null;
  }
  const scope = store?.scopes?.[normalizedScopeKey];
  if (!scope) {
    return null;
  }
  return {
    scope: cloneValue(scope),
    tasks: normalizeStringList(scope.current_task_ids, 12)
      .map((taskId) => store.tasks?.[taskId])
      .filter(Boolean)
      .map((task) => cloneValue(task)),
  };
}

function sortScopesByUpdatedAt(scopes = []) {
  return [...(Array.isArray(scopes) ? scopes : [])]
    .filter(Boolean)
    .sort((left, right) => Date.parse(right?.updated_at || 0) - Date.parse(left?.updated_at || 0));
}

function resolveScopesByDocId(store = {}, docId = "") {
  const normalizedDocId = cleanText(docId);
  if (!normalizedDocId) {
    return [];
  }
  return sortScopesByUpdatedAt(
    Object.values(store?.scopes || {}).filter((scope) => cleanText(scope?.source_doc_id) === normalizedDocId),
  );
}

function resolveScopesByTitle(store = {}, title = "") {
  const normalizedTitle = cleanText(title);
  if (!normalizedTitle) {
    return [];
  }
  return sortScopesByUpdatedAt(
    Object.values(store?.scopes || {}).filter((scope) => {
      const sourceTitle = cleanText(scope?.source_title);
      return sourceTitle ? normalizedTitle.includes(sourceTitle) || sourceTitle.includes(normalizedTitle) : false;
    }),
  );
}

function resolveScopesByTheme(store = {}, theme = "") {
  const normalizedTheme = cleanText(theme);
  if (!normalizedTheme) {
    return [];
  }
  return sortScopesByUpdatedAt(
    Object.values(store?.scopes || {}).filter((scope) => cleanText(scope?.theme) === normalizedTheme),
  );
}

function resolveScopesByTaskTitle(store = {}, userIntent = "") {
  const normalizedIntent = cleanText(userIntent);
  if (!normalizedIntent) {
    return [];
  }
  const matchedScopeKeys = normalizeStringList(
    Object.values(store?.tasks || {})
      .filter((task) => {
        const title = cleanText(task?.title);
        return title ? normalizedIntent.includes(title) : false;
      })
      .map((task) => task?.scope_key),
    8,
  );
  return sortScopesByUpdatedAt(matchedScopeKeys.map((scopeKey) => store?.scopes?.[scopeKey]).filter(Boolean));
}

function resolveRelevantScope(store = {}, {
  activeDoc = null,
  activeTheme = "",
  userIntent = "",
} = {}) {
  const activeDocMatches = resolveScopesByDocId(store, activeDoc?.doc_id);
  if (activeDocMatches[0]?.scope_key) {
    return {
      scope_key: activeDocMatches[0].scope_key,
      reason: "active_doc",
    };
  }

  const activeDocTitleMatches = resolveScopesByTitle(store, activeDoc?.title);
  if (activeDocTitleMatches[0]?.scope_key) {
    return {
      scope_key: activeDocTitleMatches[0].scope_key,
      reason: "active_doc_title",
    };
  }

  const mentionedDocMatches = resolveScopesByTitle(store, userIntent);
  if (mentionedDocMatches[0]?.scope_key) {
    return {
      scope_key: mentionedDocMatches[0].scope_key,
      reason: "mentioned_doc",
    };
  }

  const mentionedTaskMatches = resolveScopesByTaskTitle(store, userIntent);
  if (mentionedTaskMatches[0]?.scope_key) {
    return {
      scope_key: mentionedTaskMatches[0].scope_key,
      reason: "mentioned_task",
    };
  }

  const themedMatches = resolveScopesByTheme(store, activeTheme);
  if (themedMatches[0]?.scope_key) {
    return {
      scope_key: themedMatches[0].scope_key,
      reason: "active_theme",
    };
  }

  return {
    scope_key: cleanText(store?.latest_scope_key) || null,
    reason: cleanText(store?.latest_scope_key) ? "latest_scope" : null,
  };
}

function looksLikeCurrentTaskFollowUp(userIntent = "") {
  const normalizedIntent = cleanText(userIntent);
  if (!normalizedIntent) {
    return false;
  }
  return /(這個|这个|這份|这份|這份文件|这份文件|現在怎麼辦|现在怎么办|接下來|接下来|下一步|怎麼推進|怎么推进|如何推進|如何推进|怎麼處理|怎么处理|還要做什麼|还要做什么)/i.test(normalizedIntent);
}

function resolveTaskTitleTargetMatches(tasks = [], userIntent = "") {
  const normalizedIntent = cleanText(userIntent);
  if (!normalizedIntent) {
    return [];
  }
  return tasks.filter((task) => {
    const title = cleanText(task?.title);
    return title ? normalizedIntent.includes(title) : false;
  });
}

function resolveFocusedTask(tasks = [], {
  scope = null,
  scopeReason = "",
  activeDoc = null,
  activeTheme = "",
  userIntent = "",
} = {}) {
  const visibleTasks = Array.isArray(tasks) ? tasks : [];
  if (!visibleTasks.length) {
    return {
      task: null,
      reason: null,
    };
  }

  const taskTitleMatches = resolveTaskTitleTargetMatches(visibleTasks, userIntent);
  if (taskTitleMatches.length === 1) {
    return {
      task: taskTitleMatches[0],
      reason: "task_title",
    };
  }

  const ownerMatches = resolveOwnerTargetMatches(visibleTasks, userIntent);
  if (ownerMatches.length === 1) {
    return {
      task: ownerMatches[0],
      reason: "owner",
    };
  }

  const lastActiveTaskId = cleanText(scope?.last_active_task_id);
  const lastActiveTask = lastActiveTaskId
    ? visibleTasks.find((task) => cleanText(task?.id) === lastActiveTaskId) || null
    : null;
  if (lastActiveTask && looksLikeCurrentTaskFollowUp(userIntent)) {
    return {
      task: lastActiveTask,
      reason: "current_task",
    };
  }

  if (lastActiveTask && (cleanText(activeDoc?.doc_id) || cleanText(activeDoc?.title) || cleanText(activeTheme) || cleanText(scopeReason))) {
    return {
      task: lastActiveTask,
      reason: cleanText(scopeReason) || "scope_context",
    };
  }

  return {
    task: resolveTaskDrivingFocusTask(visibleTasks),
    reason: "task_driving",
  };
}

function formatFocusBindingReason(reason = "") {
  switch (cleanText(reason)) {
    case "current_task":
      return "沿用當前 task";
    case "active_doc":
      return "沿用 active_doc";
    case "active_doc_title":
      return "沿用 active_doc title";
    case "mentioned_doc":
      return "命中文件名稱";
    case "mentioned_task":
    case "task_title":
      return "命中 task 名稱";
    case "owner":
      return "命中 owner";
    case "active_theme":
      return "沿用 active_theme";
    case "latest_scope":
      return "沿用最近 scope";
    case "task_driving":
      return "沿用 task driving";
    default:
      return cleanText(reason) || null;
  }
}

function classifyTaskLifecycleIntent(userIntent = "") {
  const text = cleanText(userIntent);
  if (!text) {
    return null;
  }

  const result = extractTaskLifecycleUpdateField(text, {
    labels: ["結果", "result"],
    stopLabels: ["備註", "备注", "note"],
  });
  const note = extractTaskLifecycleUpdateField(text, {
    labels: ["備註", "备注", "note", "卡點", "卡住的原因", "阻塞原因"],
    stopLabels: ["結果", "result"],
  });

  if (/完成一半|做完一半|已做一半|一半了|half done/i.test(text)) {
    return {
      selected_action: "update_task_lifecycle_v1",
      query_type: "state_update",
      target_state: "in_progress",
      progress_status: "half_done",
      note,
      result,
    };
  }
  if (/已處理|已处理|處理過了|处理过了|處理中|处理中/i.test(text)) {
    return {
      selected_action: "update_task_lifecycle_v1",
      query_type: "state_update",
      target_state: "in_progress",
      progress_status: "handled",
      note,
      result,
    };
  }

  if (/開始處理|開始做|已開始|正在做|進行中|in progress/i.test(text)) {
    return {
      selected_action: "update_task_lifecycle_v1",
      query_type: "state_update",
      target_state: "in_progress",
      progress_status: "started",
      note,
      result,
    };
  }
  if (/(卡點|卡住了|阻塞了|blocked)/i.test(text) && !/卡住了嗎|blocked\?/i.test(text)) {
    return {
      selected_action: "update_task_lifecycle_v1",
      query_type: "state_update",
      target_state: "blocked",
      progress_status: "blocked",
      note,
      result,
    };
  }
  if (/完成了|已完成|done/i.test(text) && !/完成了嗎|done\?/i.test(text)) {
    return {
      selected_action: "update_task_lifecycle_v1",
      query_type: "state_update",
      target_state: "done",
      progress_status: "completed",
      note,
      result,
    };
  }
  if (/(結果|result)/i.test(text)) {
    return {
      selected_action: "read_task_lifecycle_v1",
      query_type: "result",
      target_state: null,
    };
  }
  if (/(備註|备注|note)/i.test(text)) {
    return {
      selected_action: "read_task_lifecycle_v1",
      query_type: "note",
      target_state: null,
    };
  }
  if (/誰負責|负责人|owner/i.test(text)) {
    return {
      selected_action: "read_task_lifecycle_v1",
      query_type: "owner",
      target_state: null,
    };
  }
  if (/何時到期|什麼時候到期|何時截止|什么时候到期|什么时候截止|deadline|到期|截止/i.test(text)) {
    return {
      selected_action: "read_task_lifecycle_v1",
      query_type: "deadline",
      target_state: null,
    };
  }
  if (/進度|状态|狀態|status|完成了嗎|卡住了嗎|blocked\?/i.test(text)) {
    return {
      selected_action: "read_task_lifecycle_v1",
      query_type: "status",
      target_state: null,
    };
  }
  return null;
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTaskLifecycleUpdateField(text = "", {
  labels = [],
  stopLabels = [],
} = {}) {
  const normalized = cleanText(text);
  if (!normalized || !Array.isArray(labels) || labels.length === 0) {
    return null;
  }

  const stopPattern = Array.isArray(stopLabels) && stopLabels.length > 0
    ? `(?=\\s*(?:${stopLabels.map((label) => escapeRegExp(label)).join("|")})\\s*(?:是|為|:|：)|$)`
    : "$";
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);
    const patterns = [
      new RegExp(`${escapedLabel}\\s*(?:是|為|:|：)\\s*(.+?)${stopPattern}`, "i"),
      new RegExp(`${escapedLabel}\\s*(.+?)${stopPattern}`, "i"),
    ];
    for (const pattern of patterns) {
      const value = cleanText(normalized.match(pattern)?.[1])?.replace(/^[，,；;。\s]+|[，,；;。\s]+$/g, "");
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function summarizeTaskStateCounts(tasks = []) {
  const counts = {
    planned: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const state = cleanText(task?.task_state || "planned") || "planned";
    if (state in counts) {
      counts[state] += 1;
    }
  }
  return counts;
}

function parseChineseOrdinalNumber(value = "") {
  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }
  const map = {
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (normalized === "十") {
    return 10;
  }
  if (normalized.startsWith("十")) {
    const tail = map[normalized.slice(1)];
    return tail ? 10 + tail : null;
  }
  if (normalized.endsWith("十")) {
    const head = map[normalized[0]];
    return head ? head * 10 : null;
  }
  if (normalized.includes("十")) {
    const [headPart, tailPart] = normalized.split("十");
    const head = map[headPart] || 0;
    const tail = map[tailPart] || 0;
    return head * 10 + tail || null;
  }
  return map[normalized] || null;
}

function resolveTaskOrdinalIndex(userIntent = "") {
  const normalized = cleanText(userIntent);
  if (!normalized) {
    return null;
  }
  const digitMatch = normalized.match(/第\s*(\d+)\s*個/);
  if (digitMatch) {
    const index = Number.parseInt(digitMatch[1], 10);
    return Number.isFinite(index) && index >= 1 ? index - 1 : null;
  }
  const chineseMatch = normalized.match(/第\s*([一二兩三四五六七八九十]+)\s*個/);
  if (chineseMatch) {
    const index = parseChineseOrdinalNumber(chineseMatch[1]);
    return Number.isFinite(index) && index >= 1 ? index - 1 : null;
  }
  return null;
}

function resolveOwnerTargetMatches(tasks = [], userIntent = "") {
  const normalized = cleanText(userIntent);
  if (!normalized) {
    return [];
  }
  return tasks.filter((task) => {
    const owner = cleanText(task?.owner);
    return owner ? normalized.includes(owner) : false;
  });
}

function resolveTaskTarget({
  tasks = [],
  userIntent = "",
} = {}) {
  const normalizedIntent = cleanText(userIntent);
  const visibleTasks = Array.isArray(tasks) ? tasks : [];
  const ordinalIndex = resolveTaskOrdinalIndex(normalizedIntent);
  if (ordinalIndex != null) {
    const task = visibleTasks[ordinalIndex] || null;
    if (task) {
      return {
        mode: "single",
        reason: "ordinal",
        tasks: [task],
        candidates: [],
      };
    }
    return {
      mode: "ambiguous",
      reason: "ordinal_out_of_range",
      tasks: [],
      candidates: visibleTasks.slice(0, 5),
    };
  }

  const ownerMatches = resolveOwnerTargetMatches(visibleTasks, normalizedIntent);
  if (ownerMatches.length === 1) {
    return {
      mode: "single",
      reason: "owner",
      tasks: ownerMatches,
      candidates: [],
    };
  }
  if (ownerMatches.length > 1) {
    return {
      mode: "ambiguous",
      reason: "owner",
      tasks: [],
      candidates: ownerMatches.slice(0, 5),
    };
  }

  if (/這個/.test(normalizedIntent)) {
    const notDoneTasks = visibleTasks.filter((task) => cleanText(task?.task_state) !== "done");
    if (notDoneTasks.length === 1) {
      return {
        mode: "single",
        reason: "this",
        tasks: [notDoneTasks[0]],
        candidates: [],
      };
    }
    if (visibleTasks.length === 1) {
      return {
        mode: "single",
        reason: "this",
        tasks: [visibleTasks[0]],
        candidates: [],
      };
    }
    return {
      mode: "ambiguous",
      reason: "this",
      tasks: [],
      candidates: visibleTasks.slice(0, 5),
    };
  }

  return {
    mode: "all",
    reason: "default",
    tasks: visibleTasks,
    candidates: [],
  };
}

function resolveAggregateTaskState(tasks = []) {
  const counts = summarizeTaskStateCounts(tasks);
  if (counts.blocked > 0) {
    return "blocked";
  }
  if (counts.in_progress > 0) {
    return "in_progress";
  }
  if (counts.planned > 0) {
    return "planned";
  }
  if (counts.done > 0) {
    return "done";
  }
  return null;
}

function resolveSharedOwner(tasks = []) {
  const owners = normalizeStringList(tasks.map((task) => task?.owner), 5);
  return owners.length === 1 ? owners[0] : null;
}

function resolveSharedDeadline(tasks = []) {
  const deadlines = normalizeStringList(tasks.map((task) => task?.deadline), 5);
  return deadlines.length === 1 ? deadlines[0] : deadlines[0] || null;
}

function buildSingleTaskExecutionReadSummary(task = null, queryType = "") {
  const title = cleanText(task?.title) || "未命名 task";
  const taskState = cleanText(task?.task_state) || "planned";
  const progressSummary = cleanText(task?.progress_summary) || null;
  const owner = cleanText(task?.owner) || null;
  const deadline = cleanText(task?.deadline) || null;
  const note = cleanText(task?.note) || null;
  const result = cleanText(task?.result) || null;

  if (cleanText(queryType) === "owner") {
    return owner
      ? `task「${title}」目前負責人：${owner}。`
      : `task「${title}」目前尚未標出負責人。`;
  }
  if (cleanText(queryType) === "deadline") {
    return deadline
      ? `task「${title}」目前到期時間：${deadline}。`
      : `task「${title}」目前尚未標出到期時間。`;
  }
  if (cleanText(queryType) === "result") {
    return result
      ? `task「${title}」目前 result：${result}。`
      : `task「${title}」目前尚未記錄 result。`;
  }
  if (cleanText(queryType) === "note") {
    return note
      ? `task「${title}」目前 note：${note}。`
      : `task「${title}」目前尚未記錄 note。`;
  }

  let summary = `task「${title}」目前為 ${taskState}`;
  if (progressSummary) {
    summary += `（${progressSummary}）`;
  }
  summary += "。";
  if (note) {
    summary += `note：${note}。`;
  }
  if (result) {
    summary += `result：${result}。`;
  }
  return summary;
}

function summarizeTaskLifecycleFollowUp({
  queryType = "",
  targetState = "",
  updatedCount = 0,
  tasks = [],
  targetMode = "all",
  targetReason = "",
} = {}) {
  if (cleanText(targetMode) === "ambiguous") {
    return cleanText(targetReason) === "ordinal_out_of_range"
      ? "找不到對應序號的 task，請改用有效的第N個。"
      : "目前無法唯一定位 task，請指定第一個、第二個，或帶 owner 的 task。";
  }

  if (tasks.length === 1) {
    const task = tasks[0];
    if (cleanText(queryType) === "state_update") {
      if (updatedCount > 0) {
        return buildSingleTaskExecutionReadSummary(task, "status").replace("目前為", "已更新為");
      }
      return "目前沒有可更新的 task 變化。";
    }
    return buildSingleTaskExecutionReadSummary(task, queryType);
  }

  const counts = summarizeTaskStateCounts(tasks);
  if (cleanText(queryType) === "state_update" && cleanText(targetState)) {
    if (updatedCount > 0) {
      return `已將 ${updatedCount} 個 task 更新為 ${targetState}。`;
    }
    return `目前沒有可更新為 ${targetState} 的 task。`;
  }

  if (cleanText(queryType) === "owner") {
    const owners = normalizeStringList(tasks.map((task) => task?.owner), 5);
    return owners.length
      ? `目前 task 負責人：${owners.join("、")}。`
      : "目前 task 尚未標出負責人。";
  }

  if (cleanText(queryType) === "deadline") {
    const deadlines = normalizeStringList(tasks.map((task) => task?.deadline), 5);
    return deadlines.length
      ? `目前 task 到期時間：${deadlines.join("、")}。`
      : "目前 task 尚未標出到期時間。";
  }
  if (cleanText(queryType) === "result") {
    const results = tasks
      .map((task) => cleanText(task?.result))
      .filter(Boolean)
      .slice(0, 5);
    return results.length
      ? `目前 task result：${results.join("、")}。`
      : "目前 task 尚未記錄 result。";
  }
  if (cleanText(queryType) === "note") {
    const notes = tasks
      .map((task) => cleanText(task?.note))
      .filter(Boolean)
      .slice(0, 5);
    return notes.length
      ? `目前 task note：${notes.join("、")}。`
      : "目前 task 尚未記錄 note。";
  }

  return `目前 task 狀態：planned ${counts.planned} 個、in_progress ${counts.in_progress} 個、blocked ${counts.blocked} 個、done ${counts.done} 個。`;
}

function buildTaskLifecycleActionNextActions({
  tasks = [],
  targetMode = "all",
} = {}) {
  if (cleanText(targetMode) === "ambiguous") {
    return tasks
      .slice(0, 5)
      .map((task, index) => `第${index + 1}個：${cleanText(task?.title) || "未命名 task"}`);
  }

  return tasks
    .filter((task) => cleanText(task?.task_state) !== "done")
    .map((task) => buildTaskDrivingNextStep(task))
    .filter(Boolean)
    .slice(0, 5);
}

function buildTaskLifecycleFormattedOutput({
  scope = {},
  tasks = [],
  userIntent = "",
  queryType = "",
  targetState = "",
  updatedCount = 0,
  targetMode = "all",
  targetReason = "",
} = {}) {
  const summary = summarizeTaskLifecycleFollowUp({
    queryType,
    targetState,
    updatedCount,
    tasks,
    targetMode,
    targetReason,
  });
  const candidatesMode = cleanText(targetMode) === "ambiguous";
  return {
    kind: candidatesMode
      ? "task_lifecycle_candidates"
      : cleanText(queryType) === "state_update"
        ? "task_lifecycle_update"
        : "task_lifecycle",
    title: cleanText(scope?.source_title) || cleanText(scope?.theme) || "task lifecycle",
    doc_id: cleanText(scope?.source_doc_id) || null,
    items: tasks.slice(0, 5).map((task) => ({
      title: cleanText(task?.title) || "未命名 task",
      doc_id: cleanText(task?.id) || null,
    })),
    match_reason: cleanText(userIntent) || null,
    content_summary: summary,
    found: tasks.length > 0,
    action_layer: {
      summary,
      next_actions: buildTaskLifecycleActionNextActions({
        tasks,
        targetMode,
      }),
      owner: resolveSharedOwner(tasks),
      deadline: resolveSharedDeadline(tasks),
      risks: normalizeStringList([
        ...(candidatesMode ? ["目前無法唯一定位 task。"] : []),
        ...tasks.flatMap((task) => task?.risks || []),
      ], 8),
      status: candidatesMode ? null : resolveAggregateTaskState(tasks),
    },
  };
}

function buildTaskLifecycleTraceId(scopeKey = "", userIntent = "", targetState = "") {
  const seed = `${cleanText(scopeKey)}::${cleanText(userIntent)}::${cleanText(targetState)}::${nowIso()}`;
  return `trace_task_lifecycle_${sha256(seed).slice(0, 12)}`;
}

export async function maybeRunPlannerTaskLifecycleFollowUp({
  userIntent = "",
  activeDoc = null,
  activeTheme = "",
  logger = console,
} = {}) {
  const intent = classifyTaskLifecycleIntent(userIntent);
  if (!intent?.selected_action) {
    return null;
  }

  const store = await loadStore();
  const scopeSelection = resolveRelevantScope(store, {
    activeDoc,
    activeTheme,
    userIntent,
  });
  const scopeKey = scopeSelection.scope_key;
  const snapshot = buildSnapshotFromStore(store, scopeKey);
  if (!snapshot?.tasks?.length) {
    return null;
  }

  const targetResolution = resolveTaskTarget({
    tasks: snapshot.tasks,
    userIntent,
  });
  const targetTasks = targetResolution.mode === "all"
    ? snapshot.tasks
    : targetResolution.mode === "single"
      ? targetResolution.tasks
      : targetResolution.candidates;

  let updatedCount = 0;
  let mutated = false;
  if (intent.target_state && targetResolution.mode !== "ambiguous") {
    for (const task of targetTasks) {
      const updateResult = applyTaskExecutionUpdate(task, {
        nextState: intent.target_state,
        progressStatus: intent.progress_status,
        note: intent.note,
        result: intent.result,
        reason: `follow_up:${cleanText(userIntent)}`,
      });
      const nextTask = updateResult.task;
      if (updateResult.changed) {
        updatedCount += 1;
        mutated = true;
      }
      store.tasks[nextTask.id] = nextTask;
    }
    if (mutated && snapshot.scope?.scope_key) {
      store.scopes[snapshot.scope.scope_key] = normalizeScope({
        ...snapshot.scope,
        updated_at: nowIso(),
      });
      await saveStore(store);
    }
  }

  const nextLastActiveTaskId = targetResolution.mode === "single"
    ? cleanText(targetTasks?.[0]?.id) || cleanText(snapshot?.scope?.last_active_task_id) || null
    : cleanText(snapshot?.scope?.last_active_task_id) || null;
  if (snapshot.scope?.scope_key && nextLastActiveTaskId && nextLastActiveTaskId !== cleanText(store.scopes?.[snapshot.scope.scope_key]?.last_active_task_id)) {
    store.scopes[snapshot.scope.scope_key] = normalizeScope({
      ...store.scopes[snapshot.scope.scope_key],
      last_active_task_id: nextLastActiveTaskId,
      updated_at: mutated ? nowIso() : store.scopes[snapshot.scope.scope_key]?.updated_at,
    });
    await saveStore(store);
  }

  const refreshedSnapshot = buildSnapshotFromStore(store, scopeKey) || snapshot;
  const visibleTasks = targetResolution.mode === "all"
    ? refreshedSnapshot.tasks
    : targetResolution.mode === "single"
      ? targetResolution.tasks
          .map((task) => store.tasks?.[task.id] || task)
          .filter(Boolean)
      : targetResolution.candidates;
  const traceId = buildTaskLifecycleTraceId(scopeKey, userIntent, intent.target_state);
  const executionResult = {
    ok: true,
    action: intent.selected_action,
    data: {
      scope: refreshedSnapshot.scope,
      tasks: visibleTasks,
      query_type: intent.query_type,
      target_state: intent.target_state || null,
      updated_count: updatedCount,
      target_mode: targetResolution.mode,
      target_reason: targetResolution.reason,
    },
    formatted_output: buildTaskLifecycleFormattedOutput({
      scope: refreshedSnapshot.scope,
      tasks: visibleTasks,
      userIntent,
      queryType: intent.query_type,
      targetState: intent.target_state,
      updatedCount,
      targetMode: targetResolution.mode,
      targetReason: targetResolution.reason,
    }),
    trace_id: traceId,
  };

  logger?.debug?.("planner_task_lifecycle_v1", {
    stage: "planner_task_lifecycle_v1",
    event_type: intent.target_state ? "task_follow_up_update" : "task_follow_up_read",
    query_type: intent.query_type,
    target_state: intent.target_state || null,
    updated_count: updatedCount,
    scope_key: refreshedSnapshot.scope?.scope_key || null,
    source_doc_id: refreshedSnapshot.scope?.source_doc_id || null,
    task_count: visibleTasks.length,
    target_mode: targetResolution.mode,
    target_reason: targetResolution.reason,
    trace_id: traceId,
  });

  return {
    selected_action: intent.selected_action,
    reason: "命中 planner task lifecycle follow-up。",
    execution_result: executionResult,
    snapshot: refreshedSnapshot,
  };
}

export async function getLatestPlannerTaskLifecycleSnapshot() {
  const store = await loadStore();
  return buildSnapshotFromStore(store, cleanText(store.latest_scope_key));
}

export async function getPlannerTaskDecisionContext({
  activeDoc = null,
  activeTheme = "",
  userIntent = "",
} = {}) {
  const store = await loadStore();
  const scopeSelection = resolveRelevantScope(store, {
    activeDoc,
    activeTheme,
    userIntent,
  });
  const snapshot = buildSnapshotFromStore(store, scopeSelection.scope_key);
  if (!snapshot?.tasks?.length) {
    return null;
  }
  const focusResolution = resolveFocusedTask(snapshot.tasks, {
    scope: snapshot.scope,
    scopeReason: scopeSelection.reason,
    activeDoc,
    activeTheme,
    userIntent,
  });
  return buildPlannerTaskDecisionContext({
    ...snapshot,
    scope_reason: scopeSelection.reason,
    focus_task: focusResolution.task,
    focus_reason: focusResolution.reason,
  });
}

export async function getPlannerTaskLifecycleStore() {
  const store = await loadStore();
  return cloneValue(store);
}

export function useInMemoryPlannerTaskLifecycleStoreForTests() {
  inMemoryStoreOverride = createStore();
}

export function replacePlannerTaskLifecycleStoreForTests(store = {}) {
  inMemoryStoreOverride = normalizeStoreForTests(store);
}

export async function resetPlannerTaskLifecycleStoreForTests() {
  if (inMemoryStoreOverride) {
    inMemoryStoreOverride = createStore();
    return;
  }
  await writeJsonFile(plannerTaskLifecycleV1StorePath, createStore());
}

export function restorePlannerTaskLifecycleStoreForTests() {
  inMemoryStoreOverride = null;
}

export async function resetPlannerTaskLifecycleStore() {
  if (inMemoryStoreOverride) {
    inMemoryStoreOverride = createStore();
    return;
  }
  await fs.rm(plannerTaskLifecycleV1StorePath, { force: true }).catch(() => {});
}
