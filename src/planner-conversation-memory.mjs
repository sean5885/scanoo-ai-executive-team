import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cleanText } from "./message-intent-utils.mjs";
import { getPlannerFlowOwnership } from "./planner-flow-runtime.mjs";

const PLANNER_SUMMARY_TRIGGER_TURNS = 6;
const PLANNER_SUMMARY_TRIGGER_CHARS = 2400;
const PLANNER_RECENT_MESSAGE_LIMIT = 4;
const DEFAULT_PLANNER_SESSION_KEY = "default";
const PLANNER_WORKING_MEMORY_SLOT_LIMIT = 6;
const PLANNER_WORKING_MEMORY_TASK_PHASES = new Set([
  "init",
  "planning",
  "executing",
  "waiting_user",
  "retrying",
  "done",
  "failed",
]);
const PLANNER_WORKING_MEMORY_TASK_STATUSES = new Set([
  "running",
  "blocked",
  "completed",
  "failed",
]);
const PLANNER_WORKING_MEMORY_HANDOFF_REASONS = new Set([
  "needs_tool",
  "needs_user_input",
  "capability_gap",
  "retry",
]);
const PLANNER_WORKING_MEMORY_SLOT_STATUSES = new Set([
  "missing",
  "filled",
  "invalid",
]);
const PLANNER_WORKING_MEMORY_SLOT_SOURCES = new Set([
  "user",
  "tool",
  "inferred",
]);
const PLANNER_WORKING_MEMORY_RETRY_STRATEGIES = new Set([
  "same_agent",
  "reroute",
  "same_agent_then_reroute",
]);
const PLANNER_WORKING_MEMORY_PLAN_STATUSES = new Set([
  "active",
  "paused",
  "completed",
  "invalidated",
]);
const PLANNER_WORKING_MEMORY_STEP_STATUSES = new Set([
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
]);
const PLANNER_WORKING_MEMORY_PLAN_STEP_LIMIT = 12;
const PLANNER_WORKING_MEMORY_PLAN_REF_LIMIT = 8;
const DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY = Object.freeze({
  max_retries: 2,
  strategy: "same_agent_then_reroute",
});
const PLANNER_WORKING_MEMORY_V1_REQUIRED_KEYS = Object.freeze([
  "current_goal",
  "inferred_task_type",
  "last_selected_agent",
  "last_selected_skill",
  "last_tool_result_summary",
  "unresolved_slots",
  "next_best_action",
  "confidence",
  "updated_at",
]);
const PLANNER_WORKING_MEMORY_PATCHABLE_KEYS = Object.freeze([
  "current_goal",
  "inferred_task_type",
  "last_selected_agent",
  "last_selected_skill",
  "last_tool_result_summary",
  "unresolved_slots",
  "next_best_action",
  "confidence",
  "task_id",
  "task_type",
  "task_phase",
  "task_status",
  "current_owner_agent",
  "previous_owner_agent",
  "handoff_reason",
  "retry_count",
  "retry_policy",
  "slot_state",
  "abandoned_task_ids",
  "execution_plan",
]);

const plannerConversationMemoryState = {
  latest_session_key: DEFAULT_PLANNER_SESSION_KEY,
  sessions: {},
};
let plannerConversationMemoryLoaded = false;

function cloneJsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolvePlannerConversationMemoryStorePath() {
  return cleanText(process.env.PLANNER_CONVERSATION_MEMORY_PATH)
    || fileURLToPath(new URL("../.data/planner-conversation-memory.json", import.meta.url));
}

function normalizePlannerConversationSessionKey(sessionKey = "") {
  return cleanText(sessionKey) || DEFAULT_PLANNER_SESSION_KEY;
}

function buildEmptyPlannerWorkingMemory() {
  return {
    current_goal: null,
    inferred_task_type: null,
    last_selected_agent: null,
    last_selected_skill: null,
    last_tool_result_summary: null,
    unresolved_slots: [],
    next_best_action: null,
    confidence: null,
    task_id: null,
    task_type: null,
    task_phase: "init",
    task_status: "running",
    current_owner_agent: null,
    previous_owner_agent: null,
    handoff_reason: null,
    retry_count: 0,
    retry_policy: { ...DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY },
    slot_state: [],
    abandoned_task_ids: [],
    execution_plan: null,
    updated_at: null,
  };
}

function normalizeWorkingMemoryString(value) {
  return cleanText(value) || null;
}

function normalizeWorkingMemorySlots(slots = []) {
  if (!Array.isArray(slots)) {
    return [];
  }
  return slots
    .map((slot) => normalizeWorkingMemoryString(slot))
    .filter(Boolean)
    .slice(0, PLANNER_WORKING_MEMORY_SLOT_LIMIT);
}

function resolveWorkingMemorySlotTtl(ttl = null) {
  if (ttl === null || ttl === undefined || ttl === "") {
    return new Date(Date.now() + (30 * 60 * 1000)).toISOString();
  }
  if (typeof ttl === "number" && Number.isFinite(ttl)) {
    try {
      return new Date(ttl).toISOString();
    } catch {
      return null;
    }
  }
  const normalized = cleanText(ttl);
  if (!normalized) {
    return null;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function isWorkingMemorySlotExpired(slot = null) {
  const ttl = cleanText(slot?.ttl || "");
  if (!ttl) {
    return false;
  }
  const expiry = Date.parse(ttl);
  if (!Number.isFinite(expiry)) {
    return true;
  }
  return expiry <= Date.now();
}

function normalizeWorkingMemorySlotState(slots = []) {
  if (!Array.isArray(slots)) {
    return [];
  }
  const normalizedSlots = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      return null;
    }
    const slotKey = normalizeWorkingMemoryString(slot.slot_key);
    const requiredBy = normalizeWorkingMemoryString(slot.required_by);
    const status = cleanText(slot.status || "");
    const source = cleanText(slot.source || "");
    const ttl = resolveWorkingMemorySlotTtl(slot.ttl);
    if (!slotKey || !PLANNER_WORKING_MEMORY_SLOT_STATUSES.has(status) || !PLANNER_WORKING_MEMORY_SLOT_SOURCES.has(source) || !ttl) {
      return null;
    }
    normalizedSlots.push({
      slot_key: slotKey,
      required_by: requiredBy,
      status,
      source,
      ttl,
    });
    if (normalizedSlots.length >= PLANNER_WORKING_MEMORY_SLOT_LIMIT) {
      break;
    }
  }
  return normalizedSlots;
}

function deriveSlotStateFromUnresolvedSlots(unresolvedSlots = [], { requiredBy = null, source = "inferred" } = {}) {
  return normalizeWorkingMemorySlots(unresolvedSlots)
    .map((slotKey) => ({
      slot_key: slotKey,
      required_by: normalizeWorkingMemoryString(requiredBy),
      status: "missing",
      source: PLANNER_WORKING_MEMORY_SLOT_SOURCES.has(source) ? source : "inferred",
      ttl: resolveWorkingMemorySlotTtl(null),
    }));
}

function pruneExpiredWorkingMemorySlotState(slotState = []) {
  if (!Array.isArray(slotState)) {
    return [];
  }
  return slotState.filter((slot) => !isWorkingMemorySlotExpired(slot));
}

function deriveUnresolvedSlotsFromSlotState(slotState = []) {
  if (!Array.isArray(slotState)) {
    return [];
  }
  return Array.from(new Set(slotState
    .filter((slot) => slot?.status === "missing" || slot?.status === "invalid")
    .map((slot) => normalizeWorkingMemoryString(slot?.slot_key))
    .filter(Boolean)))
    .slice(0, PLANNER_WORKING_MEMORY_SLOT_LIMIT);
}

function normalizeWorkingMemoryConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  if (normalized < 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizeWorkingMemoryTaskPhase(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return "init";
  }
  return PLANNER_WORKING_MEMORY_TASK_PHASES.has(normalized)
    ? normalized
    : null;
}

function normalizeWorkingMemoryTaskStatus(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return "running";
  }
  return PLANNER_WORKING_MEMORY_TASK_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeWorkingMemoryHandoffReason(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }
  return PLANNER_WORKING_MEMORY_HANDOFF_REASONS.has(normalized)
    ? normalized
    : null;
}

function normalizeWorkingMemoryRetryCount(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.floor(normalized);
}

function normalizeWorkingMemoryRetryPolicy(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY };
  }
  const maxRetries = Number(value.max_retries);
  const strategy = cleanText(value.strategy || "");
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || !PLANNER_WORKING_MEMORY_RETRY_STRATEGIES.has(strategy)) {
    return null;
  }
  return {
    max_retries: Math.floor(maxRetries),
    strategy,
  };
}

function normalizeWorkingMemoryAbandonedTaskIds(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .map((taskId) => normalizeWorkingMemoryString(taskId))
    .filter(Boolean)))
    .slice(-8);
}

function normalizeWorkingMemoryExecutionPlanStatus(value = "") {
  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }
  return PLANNER_WORKING_MEMORY_PLAN_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizeWorkingMemoryExecutionPlanRefs(value = [], { limit = PLANNER_WORKING_MEMORY_PLAN_REF_LIMIT } = {}) {
  if (!Array.isArray(value)) {
    return null;
  }
  return Array.from(new Set(value
    .map((item) => normalizeWorkingMemoryString(item))
    .filter(Boolean)))
    .slice(0, limit);
}

function normalizeWorkingMemoryExecutionPlanStep(step = null, { allowPartial = false } = {}) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return null;
  }
  const hasField = (field) => Object.prototype.hasOwnProperty.call(step, field);
  const stepId = normalizeWorkingMemoryString(step.step_id);
  if (!stepId) {
    return null;
  }

  const normalizedStep = {
    step_id: stepId,
  };

  const stepType = normalizeWorkingMemoryString(step.step_type);
  if (allowPartial) {
    if (hasField("step_type")) {
      if (!stepType) {
        return null;
      }
      normalizedStep.step_type = stepType;
    }
  } else if (!stepType) {
    return null;
  } else {
    normalizedStep.step_type = stepType;
  }

  const ownerAgent = normalizeWorkingMemoryString(step.owner_agent);
  if (allowPartial) {
    if (hasField("owner_agent")) {
      if (!ownerAgent) {
        return null;
      }
      normalizedStep.owner_agent = ownerAgent;
    }
  } else if (!ownerAgent) {
    return null;
  } else {
    normalizedStep.owner_agent = ownerAgent;
  }

  const intendedAction = normalizeWorkingMemoryString(step.intended_action);
  if (allowPartial) {
    if (hasField("intended_action")) {
      if (!intendedAction) {
        return null;
      }
      normalizedStep.intended_action = intendedAction;
    }
  } else if (!intendedAction) {
    return null;
  } else {
    normalizedStep.intended_action = intendedAction;
  }

  const status = cleanText(step.status || "");
  if (allowPartial) {
    if (hasField("status")) {
      if (!PLANNER_WORKING_MEMORY_STEP_STATUSES.has(status)) {
        return null;
      }
      normalizedStep.status = status;
    }
  } else if (!PLANNER_WORKING_MEMORY_STEP_STATUSES.has(status)) {
    return null;
  } else {
    normalizedStep.status = status;
  }

  if (allowPartial) {
    if (hasField("retryable")) {
      if (typeof step.retryable !== "boolean") {
        return null;
      }
      normalizedStep.retryable = step.retryable;
    }
  } else if (typeof step.retryable !== "boolean") {
    return null;
  } else {
    normalizedStep.retryable = step.retryable;
  }

  const dependsOn = normalizeWorkingMemoryExecutionPlanRefs(step.depends_on);
  if (allowPartial) {
    if (hasField("depends_on")) {
      if (!Array.isArray(dependsOn)) {
        return null;
      }
      normalizedStep.depends_on = dependsOn;
    }
  } else if (!Array.isArray(dependsOn)) {
    return null;
  } else {
    normalizedStep.depends_on = dependsOn;
  }

  const artifactRefs = normalizeWorkingMemoryExecutionPlanRefs(step.artifact_refs);
  if (allowPartial) {
    if (hasField("artifact_refs")) {
      if (!Array.isArray(artifactRefs)) {
        return null;
      }
      normalizedStep.artifact_refs = artifactRefs;
    }
  } else if (!Array.isArray(artifactRefs)) {
    return null;
  } else {
    normalizedStep.artifact_refs = artifactRefs;
  }

  const slotRequirements = normalizeWorkingMemoryExecutionPlanRefs(step.slot_requirements, {
    limit: PLANNER_WORKING_MEMORY_SLOT_LIMIT,
  });
  if (allowPartial) {
    if (hasField("slot_requirements")) {
      if (!Array.isArray(slotRequirements)) {
        return null;
      }
      normalizedStep.slot_requirements = slotRequirements;
    }
  } else if (!Array.isArray(slotRequirements)) {
    return null;
  } else {
    normalizedStep.slot_requirements = slotRequirements;
  }

  return normalizedStep;
}

function normalizeWorkingMemoryExecutionPlanSteps(steps = [], { allowPartial = false } = {}) {
  if (!Array.isArray(steps)) {
    return null;
  }
  const normalizedSteps = [];
  const seenStepIds = new Set();
  for (const step of steps) {
    const normalizedStep = normalizeWorkingMemoryExecutionPlanStep(step, { allowPartial });
    if (!normalizedStep) {
      return null;
    }
    if (seenStepIds.has(normalizedStep.step_id)) {
      return null;
    }
    seenStepIds.add(normalizedStep.step_id);
    normalizedSteps.push(normalizedStep);
    if (normalizedSteps.length >= PLANNER_WORKING_MEMORY_PLAN_STEP_LIMIT) {
      break;
    }
  }
  return normalizedSteps;
}

function normalizeWorkingMemoryExecutionPlan(value = null) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const planId = normalizeWorkingMemoryString(value.plan_id);
  const planStatus = normalizeWorkingMemoryExecutionPlanStatus(value.plan_status);
  const currentStepId = value.current_step_id === null || value.current_step_id === undefined || value.current_step_id === ""
    ? null
    : normalizeWorkingMemoryString(value.current_step_id);
  const steps = normalizeWorkingMemoryExecutionPlanSteps(value.steps);

  if (!planId || !planStatus || !Array.isArray(steps) || currentStepId === undefined) {
    return null;
  }
  if (steps.length === 0 && planStatus !== "completed" && planStatus !== "invalidated") {
    return null;
  }
  const stepIds = new Set(steps.map((step) => step.step_id));
  if (currentStepId && !stepIds.has(currentStepId)) {
    return null;
  }

  let resolvedCurrentStepId = currentStepId;
  if (!resolvedCurrentStepId && planStatus === "active") {
    const firstPendingStep = steps.find((step) =>
      step.status === "pending"
      || step.status === "running"
      || step.status === "blocked"
      || step.status === "failed");
    resolvedCurrentStepId = firstPendingStep?.step_id || null;
  }
  if (planStatus === "completed" || planStatus === "invalidated") {
    resolvedCurrentStepId = null;
  }

  return {
    plan_id: planId,
    plan_status: planStatus,
    current_step_id: resolvedCurrentStepId,
    steps,
  };
}

function normalizeWorkingMemoryExecutionPlanPatch(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const hasField = (field) => Object.prototype.hasOwnProperty.call(value, field);
  const normalizedPatch = {};

  if (hasField("plan_id")) {
    const planId = normalizeWorkingMemoryString(value.plan_id);
    if (!planId) {
      return null;
    }
    normalizedPatch.plan_id = planId;
  }
  if (hasField("plan_status")) {
    const planStatus = normalizeWorkingMemoryExecutionPlanStatus(value.plan_status);
    if (!planStatus) {
      return null;
    }
    normalizedPatch.plan_status = planStatus;
  }
  if (hasField("current_step_id")) {
    if (value.current_step_id === null || value.current_step_id === undefined || value.current_step_id === "") {
      normalizedPatch.current_step_id = null;
    } else {
      const currentStepId = normalizeWorkingMemoryString(value.current_step_id);
      if (!currentStepId) {
        return null;
      }
      normalizedPatch.current_step_id = currentStepId;
    }
  }
  if (hasField("steps")) {
    const steps = normalizeWorkingMemoryExecutionPlanSteps(value.steps, { allowPartial: true });
    if (!Array.isArray(steps)) {
      return null;
    }
    normalizedPatch.steps = steps;
  }
  if (Object.keys(normalizedPatch).length === 0) {
    return null;
  }
  return normalizedPatch;
}

function mergeWorkingMemoryExecutionPlan(basePlan = null, patch = null) {
  if (patch === null || patch === undefined) {
    return null;
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return null;
  }
  const base = normalizeWorkingMemoryExecutionPlan(basePlan);
  const mergedPlan = base
    ? {
        plan_id: base.plan_id,
        plan_status: base.plan_status,
        current_step_id: base.current_step_id,
        steps: base.steps.map((step) => ({ ...step })),
      }
    : {
        plan_id: null,
        plan_status: "active",
        current_step_id: null,
        steps: [],
      };

  if (Object.prototype.hasOwnProperty.call(patch, "plan_id")) {
    mergedPlan.plan_id = patch.plan_id;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "plan_status")) {
    mergedPlan.plan_status = patch.plan_status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "current_step_id")) {
    mergedPlan.current_step_id = patch.current_step_id;
  }
  if (Array.isArray(patch.steps)) {
    const stepOrder = mergedPlan.steps.map((step) => step.step_id);
    const stepMap = new Map(mergedPlan.steps.map((step) => [step.step_id, { ...step }]));
    for (const stepPatch of patch.steps) {
      const stepId = normalizeWorkingMemoryString(stepPatch?.step_id);
      if (!stepId) {
        return null;
      }
      if (!stepMap.has(stepId)) {
        stepMap.set(stepId, { step_id: stepId });
        stepOrder.push(stepId);
      }
      stepMap.set(stepId, {
        ...stepMap.get(stepId),
        ...stepPatch,
      });
    }
    mergedPlan.steps = stepOrder
      .map((stepId) => stepMap.get(stepId))
      .filter(Boolean);
  }

  return normalizeWorkingMemoryExecutionPlan(mergedPlan);
}

function buildExecutionPlanStepTransition(basePlan = null, nextPlan = null) {
  const normalizedBase = normalizeWorkingMemoryExecutionPlan(basePlan);
  const normalizedNext = normalizeWorkingMemoryExecutionPlan(nextPlan);
  if (!normalizedNext) {
    return null;
  }
  const baseStepMap = new Map((normalizedBase?.steps || []).map((step) => [step.step_id, step.status]));
  const nextStepMap = new Map((normalizedNext.steps || []).map((step) => [step.step_id, step.status]));
  const stepTransitions = [];
  const stepIds = Array.from(new Set([
    ...Array.from(baseStepMap.keys()),
    ...Array.from(nextStepMap.keys()),
  ]));
  for (const stepId of stepIds) {
    const fromStatus = baseStepMap.has(stepId) ? baseStepMap.get(stepId) : null;
    const toStatus = nextStepMap.has(stepId) ? nextStepMap.get(stepId) : null;
    if (fromStatus !== toStatus) {
      stepTransitions.push({
        step_id: stepId,
        from: fromStatus,
        to: toStatus,
      });
    }
  }
  const fromCurrentStep = normalizeWorkingMemoryString(normalizedBase?.current_step_id);
  const toCurrentStep = normalizeWorkingMemoryString(normalizedNext.current_step_id);
  if (stepTransitions.length === 0 && fromCurrentStep === toCurrentStep) {
    return null;
  }
  return {
    from_current_step_id: fromCurrentStep || null,
    to_current_step_id: toCurrentStep || null,
    steps: stepTransitions,
  };
}

function normalizePlannerWorkingMemory(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const key of PLANNER_WORKING_MEMORY_V1_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return null;
    }
  }
  const stringFields = [
    "current_goal",
    "inferred_task_type",
    "last_selected_agent",
    "last_selected_skill",
    "last_tool_result_summary",
    "next_best_action",
    "task_id",
    "task_type",
    "task_phase",
    "task_status",
    "current_owner_agent",
    "previous_owner_agent",
    "handoff_reason",
    "updated_at",
  ];
  for (const key of stringFields) {
    if (value[key] !== null && value[key] !== undefined && typeof value[key] !== "string") {
      return null;
    }
  }
  if (!Array.isArray(value.unresolved_slots) || value.unresolved_slots.some((slot) => typeof slot !== "string")) {
    return null;
  }
  if (value.confidence !== null && value.confidence !== undefined && typeof value.confidence !== "number") {
    return null;
  }
  if (value.retry_count !== null && value.retry_count !== undefined && typeof value.retry_count !== "number") {
    return null;
  }
  if (value.retry_policy !== null && value.retry_policy !== undefined && (typeof value.retry_policy !== "object" || Array.isArray(value.retry_policy))) {
    return null;
  }
  if (value.slot_state !== null && value.slot_state !== undefined && !Array.isArray(value.slot_state)) {
    return null;
  }
  if (value.abandoned_task_ids !== null && value.abandoned_task_ids !== undefined && !Array.isArray(value.abandoned_task_ids)) {
    return null;
  }
  if (value.execution_plan !== null && value.execution_plan !== undefined && (typeof value.execution_plan !== "object" || Array.isArray(value.execution_plan))) {
    return null;
  }

  const unresolvedSlots = normalizeWorkingMemorySlots(value.unresolved_slots);
  if (unresolvedSlots.length !== value.unresolved_slots.length) {
    return null;
  }
  if (value.confidence !== null && value.confidence !== undefined && normalizeWorkingMemoryConfidence(value.confidence) === null) {
    return null;
  }
  const taskPhase = normalizeWorkingMemoryTaskPhase(value.task_phase);
  if (taskPhase === null) {
    return null;
  }
  const taskStatus = normalizeWorkingMemoryTaskStatus(value.task_status);
  if (taskStatus === null) {
    return null;
  }
  const handoffReason = normalizeWorkingMemoryHandoffReason(value.handoff_reason);
  if (value.handoff_reason !== null && value.handoff_reason !== undefined && cleanText(value.handoff_reason) && handoffReason === null) {
    return null;
  }
  const retryCount = normalizeWorkingMemoryRetryCount(value.retry_count);
  if (retryCount === null) {
    return null;
  }
  const retryPolicy = normalizeWorkingMemoryRetryPolicy(value.retry_policy);
  if (retryPolicy === null) {
    return null;
  }
  const slotStateProvided = !(value.slot_state === null || value.slot_state === undefined);
  let slotState = !slotStateProvided
    ? deriveSlotStateFromUnresolvedSlots(unresolvedSlots, {
        requiredBy: cleanText(value.last_selected_skill || value.last_selected_agent || "") || null,
        source: "inferred",
      })
    : normalizeWorkingMemorySlotState(value.slot_state);
  if (slotState === null) {
    return null;
  }
  slotState = pruneExpiredWorkingMemorySlotState(slotState);
  const unresolvedFromSlotState = deriveUnresolvedSlotsFromSlotState(slotState);
  const canonicalUnresolvedSlots = unresolvedFromSlotState.length > 0
    ? unresolvedFromSlotState
    : slotStateProvided
      ? []
      : unresolvedSlots;
  const executionPlan = normalizeWorkingMemoryExecutionPlan(value.execution_plan);
  if (value.execution_plan !== null && value.execution_plan !== undefined && value.execution_plan !== "" && executionPlan === null) {
    return null;
  }

  return {
    current_goal: normalizeWorkingMemoryString(value.current_goal),
    inferred_task_type: normalizeWorkingMemoryString(value.inferred_task_type)
      || normalizeWorkingMemoryString(value.task_type),
    last_selected_agent: normalizeWorkingMemoryString(value.last_selected_agent),
    last_selected_skill: normalizeWorkingMemoryString(value.last_selected_skill),
    last_tool_result_summary: normalizeWorkingMemoryString(value.last_tool_result_summary),
    unresolved_slots: canonicalUnresolvedSlots,
    next_best_action: normalizeWorkingMemoryString(value.next_best_action),
    confidence: normalizeWorkingMemoryConfidence(value.confidence),
    task_id: normalizeWorkingMemoryString(value.task_id),
    task_type: normalizeWorkingMemoryString(value.task_type)
      || normalizeWorkingMemoryString(value.inferred_task_type),
    task_phase: taskPhase,
    task_status: taskStatus,
    current_owner_agent: normalizeWorkingMemoryString(value.current_owner_agent)
      || normalizeWorkingMemoryString(value.last_selected_agent),
    previous_owner_agent: normalizeWorkingMemoryString(value.previous_owner_agent),
    handoff_reason: handoffReason,
    retry_count: retryCount,
    retry_policy: retryPolicy,
    slot_state: slotState,
    abandoned_task_ids: normalizeWorkingMemoryAbandonedTaskIds(value.abandoned_task_ids || []),
    execution_plan: executionPlan,
    updated_at: normalizeWorkingMemoryString(value.updated_at),
  };
}

function buildEmptyPlannerConversationSession() {
  return {
    recent_messages: [],
    latest_summary: null,
    working_memory: null,
    turns_since_summary: 0,
    chars_since_summary: 0,
    total_turns: 0,
    last_compacted_at: null,
  };
}

function normalizePlannerConversationMemorySnapshot(snapshot = {}) {
  return {
    latest_summary: snapshot?.latest_summary && typeof snapshot.latest_summary === "object"
      ? cloneJsonSafe(snapshot.latest_summary)
      : null,
    recent_messages: Array.isArray(snapshot?.recent_messages)
      ? snapshot.recent_messages
          .map((message) => normalizePlannerConversationMessage(message))
          .filter(Boolean)
          .slice(-PLANNER_RECENT_MESSAGE_LIMIT)
      : [],
    turns_since_summary: Number.isFinite(snapshot?.turns_since_summary)
      ? Number(snapshot.turns_since_summary)
      : 0,
    chars_since_summary: Number.isFinite(snapshot?.chars_since_summary)
      ? Number(snapshot.chars_since_summary)
      : 0,
    total_turns: Number.isFinite(snapshot?.total_turns)
      ? Number(snapshot.total_turns)
      : 0,
    last_compacted_at: cleanText(snapshot?.last_compacted_at) || null,
    working_memory: Object.prototype.hasOwnProperty.call(snapshot || {}, "working_memory")
      ? cloneJsonSafe(snapshot?.working_memory)
      : null,
  };
}

function normalizePlannerConversationMemoryStore(snapshot = {}) {
  if (snapshot?.sessions && typeof snapshot.sessions === "object" && !Array.isArray(snapshot.sessions)) {
    const sessions = {};
    for (const [sessionKey, value] of Object.entries(snapshot.sessions)) {
      const normalizedKey = normalizePlannerConversationSessionKey(sessionKey);
      sessions[normalizedKey] = normalizePlannerConversationMemorySnapshot(value);
    }
    return {
      latest_session_key: normalizePlannerConversationSessionKey(snapshot?.latest_session_key),
      sessions,
    };
  }

  return {
    latest_session_key: DEFAULT_PLANNER_SESSION_KEY,
    sessions: {
      [DEFAULT_PLANNER_SESSION_KEY]: normalizePlannerConversationMemorySnapshot(snapshot),
    },
  };
}

function applyPlannerConversationMemorySnapshot(snapshot = {}) {
  const normalized = normalizePlannerConversationMemoryStore(snapshot);
  plannerConversationMemoryState.latest_session_key = normalized.latest_session_key;
  plannerConversationMemoryState.sessions = normalized.sessions;
}

function getPlannerConversationSessionState(sessionKey = "", { createIfMissing = true } = {}) {
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  if (!plannerConversationMemoryState.sessions[normalizedSessionKey] && createIfMissing) {
    plannerConversationMemoryState.sessions[normalizedSessionKey] = buildEmptyPlannerConversationSession();
  }
  return plannerConversationMemoryState.sessions[normalizedSessionKey] || null;
}

function persistPlannerConversationMemory() {
  const storePath = resolvePlannerConversationMemoryStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    latest_session_key: plannerConversationMemoryState.latest_session_key,
    sessions: plannerConversationMemoryState.sessions,
  }, null, 2));
}

function loadPlannerConversationMemoryFromStore() {
  const storePath = resolvePlannerConversationMemoryStorePath();
  try {
    const raw = readFileSync(storePath, "utf8");
    applyPlannerConversationMemorySnapshot(JSON.parse(raw));
  } catch {
    applyPlannerConversationMemorySnapshot({});
  }
  plannerConversationMemoryLoaded = true;
  return getPlannerConversationMemory();
}

function ensurePlannerConversationMemoryLoaded() {
  if (!plannerConversationMemoryLoaded) {
    loadPlannerConversationMemoryFromStore();
  }
}

function normalizePlannerConversationMessage(message = {}) {
  const role = cleanText(message.role || "");
  const content = cleanText(message.content || "");
  if (!role || !content) {
    return null;
  }
  return {
    role,
    content,
    timestamp: cleanText(message.timestamp) || null,
  };
}

function pushPlannerRecentMessage(message = null) {
  const normalized = normalizePlannerConversationMessage(message);
  if (!normalized) {
    return 0;
  }
  const sessionState = getPlannerConversationSessionState();
  sessionState.recent_messages.push(normalized);
  sessionState.recent_messages = sessionState.recent_messages
    .slice(-PLANNER_RECENT_MESSAGE_LIMIT);
  return normalized.content.length;
}

function normalizePlannerFlowSnapshot(flow = null) {
  if (!flow || typeof flow !== "object") {
    return null;
  }
  return {
    id: cleanText(flow.id) || null,
    ownership: getPlannerFlowOwnership(flow),
    context: flow.context && typeof flow.context === "object" && !Array.isArray(flow.context)
      ? cloneJsonSafe(flow.context)
      : {},
  };
}

function normalizeUnfinishedItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const label = cleanText(item?.label || item?.message || "");
      if (!label) {
        return null;
      }
      const actions = Array.isArray(item?.actions)
        ? item.actions
            .map((action) => {
              const type = cleanText(action?.type || action?.action || "");
              const actionLabel = cleanText(action?.label || "");
              if (!type || !actionLabel) {
                return null;
              }
              return {
                type,
                label: actionLabel,
              };
            })
            .filter(Boolean)
            .slice(0, 3)
        : [];
      return {
        type: cleanText(item?.type || "") || null,
        item_id: cleanText(item?.item_id || item?.id) || null,
        label,
        status: cleanText(item?.status || "pending") || "pending",
        actions,
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function deriveNextStepSuggestion({
  activeDoc = null,
  activeCandidates = [],
  activeTheme = null,
  unfinishedItems = [],
  latestSelectedAction = "",
} = {}) {
  if (activeDoc?.doc_id) {
    return `可直接追問目前${activeTheme ? `${activeTheme.toUpperCase()}主題` : ""}文件「${activeDoc.title || activeDoc.doc_id}」的內容、重點或下一步。`;
  }
  if (Array.isArray(activeCandidates) && activeCandidates.length > 0) {
    return "先請使用者指定候選文件，例如第一份或第二份，再進 detail。";
  }
  if (cleanText(activeTheme)) {
    return `沿用目前主題 ${cleanText(activeTheme)} 繼續追問相關文件、內容或下一步。`;
  }
  if (unfinishedItems.length > 0) {
    return unfinishedItems[0]?.label || "先處理未完成事項，再繼續 planner 執行。";
  }
  if (cleanText(latestSelectedAction)) {
    return `沿用最近一次 planner 動作 ${cleanText(latestSelectedAction)} 的結果，繼續下一步。`;
  }
  return "維持最近少量對話與最新摘要，按下一個 user query 繼續。";
}

function summarizeSystemArchitectureStatus() {
  return {
    planner_runtime: "executive-planner public entrypoint with internal planner flow runtime",
    context_mode: "system prompt + latest_summary + recent_messages + current_user_query",
    summary_strategy: "compact in-memory summary replaces full-history replay",
  };
}

export function shouldCompactPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const sessionState = getPlannerConversationSessionState(sessionKey);
  return (
    sessionState.turns_since_summary >= PLANNER_SUMMARY_TRIGGER_TURNS
    || sessionState.chars_since_summary >= PLANNER_SUMMARY_TRIGGER_CHARS
  );
}

export function recordPlannerConversationMessages(messages = [], { sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  if (!Array.isArray(messages)) {
    return;
  }
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  let totalChars = 0;
  for (const message of messages) {
    const normalized = normalizePlannerConversationMessage(message);
    if (!normalized) {
      continue;
    }
    sessionState.recent_messages.push(normalized);
    sessionState.recent_messages = sessionState.recent_messages.slice(-PLANNER_RECENT_MESSAGE_LIMIT);
    totalChars += normalized.content.length;
  }
  if (totalChars > 0) {
    sessionState.turns_since_summary += 1;
    sessionState.chars_since_summary += totalChars;
    sessionState.total_turns += 1;
    persistPlannerConversationMemory();
  }
}

export function buildPlannerConversationSummary({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
} = {}) {
  const normalizedFlows = Array.isArray(flows)
    ? flows.map((flow) => normalizePlannerFlowSnapshot(flow)).filter(Boolean)
    : [];
  const docFlow = normalizedFlows.find((flow) => flow.id === "doc_query");
  const activeDoc = docFlow?.context?.activeDoc || null;
  const activeCandidates = Array.isArray(docFlow?.context?.activeCandidates)
    ? docFlow.context.activeCandidates.slice(0, 5)
    : [];
  const activeTheme = cleanText(docFlow?.context?.activeTheme) || null;
  const normalizedUnfinishedItems = normalizeUnfinishedItems(unfinishedItems);

  return {
    generated_at: new Date().toISOString(),
    system_architecture_status: summarizeSystemArchitectureStatus(),
    completed_features: [
      "planner flow runtime with runtime-info / okr / delivery / doc-query flows",
      "explicit flow ownership contract for runtime_info / doc_query / okr / bd / delivery",
      "company-brain doc query pipeline with active_doc, active_candidates, and active_theme",
      "fail-soft planner dispatch, retry, self-heal, and preset execution",
    ],
    current_flows: normalizedFlows.map((flow) => ({
      id: flow.id,
      ownership: flow.ownership,
    })),
    active_doc: activeDoc && typeof activeDoc === "object" ? activeDoc : null,
    active_candidates: activeCandidates,
    active_theme: activeTheme,
    unfinished_items: normalizedUnfinishedItems,
    next_step_suggestion: deriveNextStepSuggestion({
      activeDoc,
      activeCandidates,
      activeTheme,
      unfinishedItems: normalizedUnfinishedItems,
      latestSelectedAction,
    }),
    latest_trace_id: latestTraceId || null,
  };
}

export function compactPlannerConversationMemory({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
  logger = console,
  reason = "manual",
  sessionKey = "",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  const summary = buildPlannerConversationSummary({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
  });
  sessionState.latest_summary = summary;
  sessionState.turns_since_summary = 0;
  sessionState.chars_since_summary = 0;
  sessionState.last_compacted_at = summary.generated_at;
  persistPlannerConversationMemory();
  logger?.debug?.("planner_conversation_memory", {
    stage: "planner_conversation_memory",
    event_type: "conversation_compacted",
    reason: cleanText(reason) || "manual",
    latest_trace_id: latestTraceId || null,
    session_key: normalizedSessionKey,
    recent_message_count: sessionState.recent_messages.length,
  });
  return cloneJsonSafe(summary);
}

export function maybeCompactPlannerConversationMemory({
  flows = [],
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
  logger = console,
  force = false,
  reason = "auto",
  sessionKey = "",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const sessionState = getPlannerConversationSessionState(sessionKey);
  if (!force && !shouldCompactPlannerConversationMemory({ sessionKey })) {
    return sessionState.latest_summary
      ? cloneJsonSafe(sessionState.latest_summary)
      : null;
  }
  return compactPlannerConversationMemory({
    flows,
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
    logger,
    reason,
    sessionKey,
  });
}

function getCanonicalPlannerWorkingMemoryFromSession(sessionState = null) {
  return normalizePlannerWorkingMemory(sessionState?.working_memory || null);
}

function normalizePlannerWorkingMemoryPatchValue(key, value) {
  if (key === "unresolved_slots") {
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: "invalid_working_memory_slots",
      };
    }
    const normalizedSlots = normalizeWorkingMemorySlots(value);
    if (normalizedSlots.length !== value.length) {
      return {
        ok: false,
        error: "invalid_working_memory_slots",
      };
    }
    return {
      ok: true,
      value: normalizedSlots,
    };
  }

  if (key === "slot_state") {
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: "invalid_working_memory_slot_state",
      };
    }
    const normalizedSlotState = normalizeWorkingMemorySlotState(value);
    if (!Array.isArray(normalizedSlotState)) {
      return {
        ok: false,
        error: "invalid_working_memory_slot_state",
      };
    }
    return {
      ok: true,
      value: pruneExpiredWorkingMemorySlotState(normalizedSlotState),
    };
  }

  if (key === "confidence") {
    if (value === null || value === undefined || value === "") {
      return { ok: true, value: null };
    }
    const normalizedConfidence = normalizeWorkingMemoryConfidence(value);
    if (normalizedConfidence === null) {
      return {
        ok: false,
        error: "invalid_working_memory_confidence",
      };
    }
    return {
      ok: true,
      value: normalizedConfidence,
    };
  }

  if (key === "retry_count") {
    const normalizedRetryCount = normalizeWorkingMemoryRetryCount(value);
    if (normalizedRetryCount === null) {
      return {
        ok: false,
        error: "invalid_working_memory_retry_count",
      };
    }
    return {
      ok: true,
      value: normalizedRetryCount,
    };
  }

  if (key === "retry_policy") {
    const normalizedRetryPolicy = normalizeWorkingMemoryRetryPolicy(value);
    if (normalizedRetryPolicy === null) {
      return {
        ok: false,
        error: "invalid_working_memory_retry_policy",
      };
    }
    return {
      ok: true,
      value: normalizedRetryPolicy,
    };
  }

  if (key === "task_phase") {
    const normalizedTaskPhase = normalizeWorkingMemoryTaskPhase(value);
    if (normalizedTaskPhase === null) {
      return {
        ok: false,
        error: "invalid_working_memory_task_phase",
      };
    }
    return {
      ok: true,
      value: normalizedTaskPhase,
    };
  }

  if (key === "task_status") {
    const normalizedTaskStatus = normalizeWorkingMemoryTaskStatus(value);
    if (normalizedTaskStatus === null) {
      return {
        ok: false,
        error: "invalid_working_memory_task_status",
      };
    }
    return {
      ok: true,
      value: normalizedTaskStatus,
    };
  }

  if (key === "handoff_reason") {
    if (value === null || value === undefined || value === "") {
      return {
        ok: true,
        value: null,
      };
    }
    const normalizedHandoffReason = normalizeWorkingMemoryHandoffReason(value);
    if (normalizedHandoffReason === null) {
      return {
        ok: false,
        error: "invalid_working_memory_handoff_reason",
      };
    }
    return {
      ok: true,
      value: normalizedHandoffReason,
    };
  }

  if (key === "abandoned_task_ids") {
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: "invalid_working_memory_abandoned_tasks",
      };
    }
    return {
      ok: true,
      value: normalizeWorkingMemoryAbandonedTaskIds(value),
    };
  }

  if (key === "execution_plan") {
    if (value === null || value === undefined || value === "") {
      return {
        ok: true,
        value: null,
      };
    }
    const normalizedPlanPatch = normalizeWorkingMemoryExecutionPlanPatch(value);
    if (!normalizedPlanPatch) {
      return {
        ok: false,
        error: "invalid_working_memory_execution_plan",
      };
    }
    return {
      ok: true,
      value: normalizedPlanPatch,
    };
  }

  if (key === "updated_at") {
    if (value === null || value === undefined || value === "") {
      return { ok: true, value: null };
    }
    const normalizedText = normalizeWorkingMemoryString(value);
    if (!normalizedText) {
      return {
        ok: false,
        error: "invalid_working_memory_updated_at",
      };
    }
    return {
      ok: true,
      value: normalizedText,
    };
  }

  if (value === null || value === undefined || value === "") {
    return { ok: true, value: null };
  }

  const normalizedText = normalizeWorkingMemoryString(value);
  if (!normalizedText) {
    return {
      ok: false,
      error: "invalid_working_memory_string",
    };
  }
  return {
    ok: true,
    value: normalizedText,
  };
}

function normalizePlannerWorkingMemoryPatch(patch = null) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {
      ok: false,
      error: "invalid_working_memory_patch",
      updates: {},
    };
  }

  const updates = {};
  const updateKeys = PLANNER_WORKING_MEMORY_PATCHABLE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(patch, key));

  for (const key of updateKeys) {
    const normalizedValue = normalizePlannerWorkingMemoryPatchValue(key, patch[key]);
    if (normalizedValue.ok !== true) {
      return {
        ok: false,
        error: normalizedValue.error || "invalid_working_memory_patch",
        field: key,
        updates: {},
      };
    }
    updates[key] = normalizedValue.value;
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      error: "empty_working_memory_patch",
      updates: {},
    };
  }

  return {
    ok: true,
    updates,
  };
}

export function readPlannerWorkingMemoryForRouting({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey, {
    createIfMissing: false,
  });
  const rawWorkingMemory = sessionState?.working_memory;
  const normalizedWorkingMemory = getCanonicalPlannerWorkingMemoryFromSession(sessionState);
  const hasRawMemory = rawWorkingMemory !== null && rawWorkingMemory !== undefined;
  const hit = Boolean(normalizedWorkingMemory);
  const missReason = !hasRawMemory
    ? "missing"
    : hit
      ? null
      : "invalid_format";
  return {
    ok: true,
    data: hit ? cloneJsonSafe(normalizedWorkingMemory) : null,
    reason: missReason,
    observability: {
      memory_read_attempted: true,
      memory_hit: hit,
      memory_miss: !hit,
      memory_snapshot: hit ? cloneJsonSafe(normalizedWorkingMemory) : null,
      task_id: hit ? cleanText(normalizedWorkingMemory?.task_id || "") || null : null,
    },
  };
}

export function getPlannerWorkingMemory({ sessionKey = "" } = {}) {
  const readResult = readPlannerWorkingMemoryForRouting({ sessionKey });
  return readResult.ok === true && readResult.data
    ? readResult.data
    : null;
}

export function applyPlannerWorkingMemoryPatch({
  patch = null,
  sessionKey = "",
  source = "unknown",
} = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const normalizedPatch = normalizePlannerWorkingMemoryPatch(patch);
  if (normalizedPatch.ok !== true) {
    return {
      ok: false,
      error: normalizedPatch.error || "invalid_working_memory_patch",
      field: normalizedPatch.field || null,
      source: cleanText(source) || "unknown",
      data: null,
      observability: {
        memory_write_attempted: true,
        memory_write_succeeded: false,
        memory_snapshot: null,
      },
    };
  }

  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  const baseMemory = getCanonicalPlannerWorkingMemoryFromSession(sessionState) || buildEmptyPlannerWorkingMemory();
  const draftMemory = {
    ...baseMemory,
    ...normalizedPatch.updates,
    updated_at: new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(normalizedPatch.updates, "execution_plan")) {
    draftMemory.execution_plan = normalizedPatch.updates.execution_plan === null
      ? null
      : mergeWorkingMemoryExecutionPlan(baseMemory.execution_plan, normalizedPatch.updates.execution_plan);
    if (normalizedPatch.updates.execution_plan !== null && !draftMemory.execution_plan) {
      return {
        ok: false,
        error: "invalid_working_memory_execution_plan",
        field: "execution_plan",
        source: cleanText(source) || "unknown",
        data: null,
        observability: {
          memory_write_attempted: true,
          memory_write_succeeded: false,
          memory_snapshot: null,
        },
      };
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch.updates, "slot_state")
    && !Object.prototype.hasOwnProperty.call(normalizedPatch.updates, "unresolved_slots")) {
    draftMemory.unresolved_slots = deriveUnresolvedSlotsFromSlotState(draftMemory.slot_state);
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch.updates, "unresolved_slots")
    && !Object.prototype.hasOwnProperty.call(normalizedPatch.updates, "slot_state")) {
    draftMemory.slot_state = deriveSlotStateFromUnresolvedSlots(draftMemory.unresolved_slots, {
      requiredBy: cleanText(draftMemory.last_selected_skill || draftMemory.current_owner_agent || draftMemory.last_selected_agent || "") || null,
      source: "inferred",
    });
  }
  draftMemory.slot_state = pruneExpiredWorkingMemorySlotState(
    normalizeWorkingMemorySlotState(draftMemory.slot_state) || [],
  );
  draftMemory.unresolved_slots = deriveUnresolvedSlotsFromSlotState(draftMemory.slot_state);
  const nextMemory = normalizePlannerWorkingMemory(draftMemory);
  if (!nextMemory) {
    return {
      ok: false,
      error: "invalid_working_memory_patch",
      field: null,
      source: cleanText(source) || "unknown",
      data: null,
      observability: {
        memory_write_attempted: true,
        memory_write_succeeded: false,
        memory_snapshot: null,
      },
    };
  }
  sessionState.working_memory = nextMemory;
  persistPlannerConversationMemory();

  const taskPhaseTransition = baseMemory.task_phase !== nextMemory.task_phase
    ? `${baseMemory.task_phase || "init"}->${nextMemory.task_phase || "init"}`
    : null;
  const taskStatusTransition = baseMemory.task_status !== nextMemory.task_status
    ? `${baseMemory.task_status || "running"}->${nextMemory.task_status || "running"}`
    : null;
  const agentHandoff = cleanText(baseMemory.current_owner_agent || "") !== cleanText(nextMemory.current_owner_agent || "")
    && cleanText(nextMemory.current_owner_agent || "")
    ? {
        from: cleanText(baseMemory.current_owner_agent || "") || null,
        to: cleanText(nextMemory.current_owner_agent || "") || null,
        reason: cleanText(nextMemory.handoff_reason || "") || null,
      }
    : null;
  const retryAttempt = Number(nextMemory.retry_count || 0) > Number(baseMemory.retry_count || 0)
    ? {
        from: Number(baseMemory.retry_count || 0),
        to: Number(nextMemory.retry_count || 0),
        strategy: cleanText(nextMemory.retry_policy?.strategy || "") || null,
        max_retries: Number.isFinite(Number(nextMemory.retry_policy?.max_retries))
          ? Number(nextMemory.retry_policy.max_retries)
          : null,
      }
    : null;
  const baseSlotStateDigest = JSON.stringify(baseMemory.slot_state || []);
  const nextSlotStateDigest = JSON.stringify(nextMemory.slot_state || []);
  const slotUpdate = baseSlotStateDigest !== nextSlotStateDigest
    ? {
        missing: deriveUnresolvedSlotsFromSlotState((nextMemory.slot_state || []).filter((slot) => slot.status === "missing")),
        filled_count: (nextMemory.slot_state || []).filter((slot) => slot.status === "filled").length,
        invalid_count: (nextMemory.slot_state || []).filter((slot) => slot.status === "invalid").length,
      }
    : null;
  const taskAbandoned = Array.isArray(nextMemory.abandoned_task_ids)
    && Array.isArray(baseMemory.abandoned_task_ids)
    && nextMemory.abandoned_task_ids.length > baseMemory.abandoned_task_ids.length
    ? nextMemory.abandoned_task_ids[nextMemory.abandoned_task_ids.length - 1]
    : null;
  const basePlan = normalizeWorkingMemoryExecutionPlan(baseMemory.execution_plan);
  const nextPlan = normalizeWorkingMemoryExecutionPlan(nextMemory.execution_plan);
  const planStepTransition = buildExecutionPlanStepTransition(basePlan, nextPlan);
  const planInvalidated = (() => {
    if (!basePlan) {
      return null;
    }
    if (basePlan.plan_status !== "invalidated" && nextPlan?.plan_status === "invalidated") {
      return {
        plan_id: basePlan.plan_id,
        reason: "invalidated",
      };
    }
    if (nextPlan?.plan_id && basePlan.plan_id !== nextPlan.plan_id) {
      return {
        plan_id: basePlan.plan_id,
        reason: "replaced_by_new_plan",
      };
    }
    return null;
  })();

  return {
    ok: true,
    source: cleanText(source) || "unknown",
    data: cloneJsonSafe(nextMemory),
    observability: {
      memory_write_attempted: true,
      memory_write_succeeded: true,
      memory_snapshot: cloneJsonSafe(nextMemory),
      task_id: cleanText(nextMemory.task_id || "") || null,
      task_phase_transition: taskPhaseTransition,
      task_status_transition: taskStatusTransition,
      agent_handoff: agentHandoff,
      retry_attempt: retryAttempt,
      slot_update: slotUpdate,
      plan_id: cleanText(nextPlan?.plan_id || "") || null,
      plan_status: cleanText(nextPlan?.plan_status || "") || null,
      current_step: cleanText(nextPlan?.current_step_id || "") || null,
      step_transition: planStepTransition,
      plan_invalidated: planInvalidated,
      task_abandoned: taskAbandoned
        ? {
            task_id: taskAbandoned,
            reason: "topic_switch",
          }
        : null,
    },
  };
}

export function getPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = normalizePlannerConversationSessionKey(sessionKey);
  plannerConversationMemoryState.latest_session_key = normalizedSessionKey;
  const sessionState = getPlannerConversationSessionState(normalizedSessionKey);
  return cloneJsonSafe({
    latest_summary: sessionState.latest_summary,
    recent_messages: sessionState.recent_messages,
    turns_since_summary: sessionState.turns_since_summary,
    chars_since_summary: sessionState.chars_since_summary,
    total_turns: sessionState.total_turns,
    last_compacted_at: sessionState.last_compacted_at,
    working_memory: getCanonicalPlannerWorkingMemoryFromSession(sessionState),
  });
}

export function resetPlannerConversationMemory({ sessionKey = "" } = {}) {
  ensurePlannerConversationMemoryLoaded();
  const normalizedSessionKey = cleanText(sessionKey);
  if (!normalizedSessionKey) {
    plannerConversationMemoryState.latest_session_key = DEFAULT_PLANNER_SESSION_KEY;
    plannerConversationMemoryState.sessions = {};
    rmSync(resolvePlannerConversationMemoryStorePath(), { force: true });
    return;
  }
  delete plannerConversationMemoryState.sessions[normalizePlannerConversationSessionKey(normalizedSessionKey)];
  if (plannerConversationMemoryState.latest_session_key === normalizePlannerConversationSessionKey(normalizedSessionKey)) {
    plannerConversationMemoryState.latest_session_key = DEFAULT_PLANNER_SESSION_KEY;
  }
  persistPlannerConversationMemory();
}

export function reloadPlannerConversationMemory() {
  plannerConversationMemoryLoaded = false;
  return loadPlannerConversationMemoryFromStore();
}

ensurePlannerConversationMemoryLoaded();
