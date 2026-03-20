import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  llmApiKey,
  llmBaseUrl,
  llmJsonRetryMax,
  llmModel,
  oauthBaseUrl,
  llmTemperature,
  llmTopP,
} from "./config.mjs";
import { readFileSync } from "node:fs";
import { buildCompactSystemPrompt, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import { getRegisteredAgent, listRegisteredAgents, parseRegisteredAgentCommand } from "./agent-registry.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import { createRequestId, emitToolExecutionLog } from "./runtime-observability.mjs";
import {
  compactPlannerConversationMemory as compactPlannerConversationMemoryLayer,
  getPlannerConversationMemory as getPlannerConversationMemoryLayer,
  maybeCompactPlannerConversationMemory,
  recordPlannerConversationMessages,
  resetPlannerConversationMemory,
} from "./planner-conversation-memory.mjs";
import {
  getPlannerDocQueryContext,
  hydratePlannerDocQueryRuntimeContext,
  plannerDocQueryFlow,
} from "./planner-doc-query-flow.mjs";
import { plannerBdFlow } from "./planner-bd-flow.mjs";
import { plannerDeliveryFlow } from "./planner-delivery-flow.mjs";
import { plannerOkrFlow } from "./planner-okr-flow.mjs";
import { plannerRuntimeInfoFlow } from "./planner-runtime-info-flow.mjs";
import {
  buildPlannerFlowPayload,
  formatPlannerFlowResult,
  getPlannerFlowForAction,
  resolvePlannerFlowRoute,
  resetPlannerFlowContexts,
  syncPlannerFlowContext,
} from "./planner-flow-runtime.mjs";
import {
  buildPlannerLifecycleUnfinishedItems,
  getPlannerTaskDecisionContext,
  maybeRunPlannerTaskLifecycleFollowUp,
  resetPlannerTaskLifecycleStore,
  syncPlannerActionLayerTaskLifecycle,
} from "./planner-task-lifecycle-v1.mjs";

const executiveStartSignals = [
  "agent",
  "角色",
  "角度",
  "handoff",
  "交給",
  "協作",
  "一起看",
  "拆解",
  "重新分配",
  "第二次分配",
  "第二次分派",
  "決策",
  "統一",
  "各個 agent",
  "各个 agent",
  "分別看",
  "分别看",
  "一起學習",
  "一起学习",
];

const executiveExitSignals = [
  "退出 executive 模式",
  "退出exec模式",
  "結束 executive",
  "結束exec",
  "結束這個任務",
  "換下一個任務",
];

// ---------------------------------------------------------------------------
// Executive intent helpers
// ---------------------------------------------------------------------------

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildCollaborativeWorkItems({ primaryAgentId = "", supportingAgentIds = [], objective = "" } = {}) {
  const objectiveText = cleanText(objective);
  const result = [];
  const seen = new Set();

  function push(agentId, task, role = "") {
    const normalizedAgentId = cleanText(agentId);
    const normalizedTask = cleanText(task);
    if (!normalizedAgentId || !normalizedTask || seen.has(normalizedAgentId)) {
      return;
    }
    seen.add(normalizedAgentId);
    result.push({
      agent_id: normalizedAgentId,
      task: normalizedTask,
      role,
      status: "pending",
    });
  }

  push(primaryAgentId, `主責收斂這個任務：${objectiveText}`, "primary");

  for (const agentId of supportingAgentIds) {
    if (agentId === "consult") {
      push(agentId, `從問題拆解與方案比較角度補充：${objectiveText}`, "supporting");
    } else if (agentId === "product") {
      push(agentId, `從產品需求與使用者價值角度補充：${objectiveText}`, "supporting");
    } else if (agentId === "tech") {
      push(agentId, `從技術與工程風險角度補充：${objectiveText}`, "supporting");
    } else if (agentId === "ops") {
      push(agentId, `從營運流程與落地執行角度補充：${objectiveText}`, "supporting");
    } else if (agentId === "cdo") {
      push(agentId, `從資料與治理角度補充：${objectiveText}`, "supporting");
    } else if (agentId === "cmo") {
      push(agentId, `從市場與訊息策略角度補充：${objectiveText}`, "supporting");
    } else {
      push(agentId, `從 /${agentId} 的專責角度補充：${objectiveText}`, "supporting");
    }
  }

  return result;
}

function agentCatalogText() {
  return listRegisteredAgents()
    .map((agent) => `${agent.id}: ${agent.label}`)
    .join("\n");
}

const plannerContract = JSON.parse(
  readFileSync(new URL("../docs/system/planner_contract.json", import.meta.url), "utf8"),
);

const plannerFlows = [
  plannerRuntimeInfoFlow && {
    ...plannerRuntimeInfoFlow,
    priority: 100,
    matchKeywords: [
      "runtime",
      "db path",
      "pid",
      "cwd",
      "service start",
      "service_start",
      "運行資訊",
      "运行信息",
    ],
  },
  plannerOkrFlow && {
    ...plannerOkrFlow,
    priority: 80,
    matchKeywords: [
      "okr",
      "目標",
      "kr",
      "關鍵結果",
      "关键结果",
      "週進度",
      "周进度",
      "本週 todo",
      "本周 todo",
      "本週todo",
      "本周todo",
    ],
  },
  plannerBdFlow && {
    ...plannerBdFlow,
    priority: 80,
    matchKeywords: [
      "bd",
      "商機",
      "商机",
      "客戶",
      "客户",
      "跟進",
      "跟进",
      "demo",
      "提案",
    ],
  },
  plannerDeliveryFlow && {
    ...plannerDeliveryFlow,
    priority: 80,
    matchKeywords: [
      "交付",
      "sop",
      "驗收",
      "验收",
      "導入",
      "导入",
      "onboarding",
    ],
  },
  plannerDocQueryFlow && {
    ...plannerDocQueryFlow,
    priority: 10,
  },
].filter(Boolean);

function buildPlannerFlowSnapshots(flows = plannerFlows) {
  return Array.isArray(flows)
    ? flows.map((flow) => ({
        id: cleanText(flow?.id || "") || null,
        priority: Number.isFinite(flow?.priority) ? Number(flow.priority) : 0,
        context: flow?.readContext?.() || {},
      }))
    : [];
}

function describePlannerExecutionResult(executionResult = null) {
  if (!executionResult || typeof executionResult !== "object") {
    return "planner execution missing";
  }
  if (executionResult.ok === false) {
    return `planner stopped: ${cleanText(executionResult.error || executionResult.data?.stop_reason || "business_error") || "business_error"}`;
  }
  if (cleanText(executionResult.preset)) {
    return `planner preset ${cleanText(executionResult.preset)} succeeded`;
  }
  if (cleanText(executionResult.action)) {
    return `planner action ${cleanText(executionResult.action)} succeeded`;
  }
  return "planner execution succeeded";
}

function derivePlannerUnfinishedItems({
  selection = {},
  executionResult = null,
} = {}) {
  const items = [];
  if (!cleanText(selection?.selected_action)) {
    const reason = cleanText(selection?.reason || "未命中受控工具規則，保持空選擇。");
    items.push({
      type: "selection",
      label: reason,
    });
    return items;
  }

  if (!executionResult || typeof executionResult !== "object") {
    return items;
  }

  if (executionResult.ok === false) {
    items.push({
      type: "stopped",
      label: cleanText(executionResult?.data?.stop_reason || executionResult?.error || "planner 執行失敗") || "planner 執行失敗",
    });
    return items;
  }

  const formatterKind = cleanText(executionResult?.formatted_output?.kind || "");
  if (formatterKind === "search_and_detail_candidates") {
    items.push({
      type: "candidate_selection",
      label: "等待使用者在候選文件中指定要打開的文件。",
    });
  } else if (formatterKind === "search_and_detail_not_found") {
    items.push({
      type: "not_found",
      label: "目前沒有找到可直接打開的文件，需要換關鍵詞或補更多上下文。",
    });
  }
  return items;
}

function mergePlannerUnfinishedItems(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const item of group) {
      const label = cleanText(item?.label);
      if (!label || seen.has(label)) {
        continue;
      }
      seen.add(label);
      result.push({
        type: cleanText(item?.type) || null,
        label,
      });
      if (result.length >= 5) {
        return result;
      }
    }
  }
  return result;
}

function recordPlannerConversationExchange({
  userQuery = "",
  plannerReply = "",
} = {}) {
  recordPlannerConversationMessages([
    {
      role: "user",
      content: userQuery,
      timestamp: new Date().toISOString(),
    },
    {
      role: "planner",
      content: plannerReply,
      timestamp: new Date().toISOString(),
    },
  ]);
}

function hasPlannerDocQueryRuntimeContext(context = {}) {
  return Boolean(
    cleanText(context?.activeDoc?.doc_id)
    || cleanText(context?.activeTheme)
    || (Array.isArray(context?.activeCandidates) && context.activeCandidates.length > 0)
  );
}

function restorePlannerRuntimeContextFromSummary() {
  const currentDocQueryContext = getPlannerDocQueryContext();
  if (hasPlannerDocQueryRuntimeContext(currentDocQueryContext)) {
    return currentDocQueryContext;
  }

  const latestSummary = getPlannerConversationMemoryLayer()?.latest_summary;
  if (!latestSummary || typeof latestSummary !== "object") {
    return currentDocQueryContext;
  }

  return hydratePlannerDocQueryRuntimeContext({
    activeDoc: latestSummary.active_doc,
    activeCandidates: latestSummary.active_candidates,
    activeTheme: latestSummary.active_theme,
  });
}

restorePlannerRuntimeContextFromSummary();

export function getPlannerConversationMemory() {
  return getPlannerConversationMemoryLayer();
}

export function compactPlannerConversationMemory({
  logger = console,
  reason = "manual",
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
} = {}) {
  restorePlannerRuntimeContextFromSummary();
  return compactPlannerConversationMemoryLayer({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
    logger,
    reason,
  });
}

// ---------------------------------------------------------------------------
// Planner contract helpers
// ---------------------------------------------------------------------------

function getPlannerActionContract(action = "") {
  return plannerContract?.actions?.[cleanText(action)] || null;
}

function getPlannerPresetContract(preset = "") {
  return plannerContract?.presets?.[cleanText(preset)] || null;
}

function getPlannerDecisionContract(name = "") {
  const normalizedName = cleanText(name);
  if (!normalizedName) {
    return null;
  }
  const actionContract = getPlannerActionContract(normalizedName);
  if (actionContract) {
    return {
      kind: "action",
      contract: actionContract,
    };
  }
  const presetContract = getPlannerPresetContract(normalizedName);
  if (presetContract) {
    return {
      kind: "preset",
      contract: presetContract,
    };
  }
  return null;
}

function summarizePlannerInputSchema(schema = null) {
  const requiredFields = Array.isArray(schema?.required)
    ? schema.required.map((field) => cleanText(String(field || ""))).filter(Boolean)
    : [];
  return requiredFields.length > 0 ? requiredFields.join(", ") : "(none)";
}

function plannerDecisionCatalogText() {
  const actionLines = Object.entries(plannerContract?.actions || {}).map(([name, contract]) => (
    `- ${name}: type=action; required_params=${summarizePlannerInputSchema(contract?.input_schema)}`
  ));
  const presetLines = Object.entries(plannerContract?.presets || {}).map(([name, contract]) => (
    `- ${name}: type=preset; required_params=${summarizePlannerInputSchema(contract?.input_schema)}`
  ));
  return [...actionLines, ...presetLines].join("\n");
}

function matchesSchemaType(expectedType, value) {
  if (expectedType === "null") {
    return value === null;
  }
  if (expectedType === "boolean") {
    return typeof value === "boolean";
  }
  if (expectedType === "string") {
    return typeof value === "string";
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return true;
}

function validateAgainstSchema(schema = null, value, path = "") {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const violations = [];
  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expectedTypes.length > 0) {
    const matched = expectedTypes.some((expectedType) => matchesSchemaType(expectedType, value));
    if (!matched) {
      violations.push({
        type: "type",
        code: "type_mismatch",
        path: path || "$",
        expected: expectedTypes.join("|"),
        actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        message: `Expected ${path || "$"} to be ${expectedTypes.join("|")}.`,
      });
      return violations;
    }
  }

  if (!schema.required || !Array.isArray(schema.required) || typeof value !== "object" || value === null || Array.isArray(value)) {
    return violations;
  }

  for (const requiredKey of schema.required) {
    if (!(requiredKey in value)) {
      violations.push({
        type: "required",
        code: "missing_required",
        path: path ? `${path}.${requiredKey}` : requiredKey,
        expected: "present",
        actual: "missing",
        message: `Missing required field ${path ? `${path}.${requiredKey}` : requiredKey}.`,
      });
    }
  }

  if (!schema.properties || typeof schema.properties !== "object") {
    return violations;
  }

  for (const [propertyKey, propertySchema] of Object.entries(schema.properties)) {
    if (!(propertyKey in value)) {
      continue;
    }
    violations.push(
      ...validateAgainstSchema(
        propertySchema,
        value[propertyKey],
        path ? `${path}.${propertyKey}` : propertyKey,
      ),
    );
  }

  return violations;
}

function buildContractViolationResult({
  action = "",
  preset = "",
  phase = "",
  violations = [],
  traceId = null,
  raw = null,
} = {}) {
  const result = {
    ok: false,
    error: "contract_violation",
    data: {
      phase: cleanText(phase) || null,
      violations: Array.isArray(violations) ? violations : [],
      raw,
    },
    trace_id: traceId || null,
  };
  if (cleanText(preset)) {
    result.preset = cleanText(preset);
  } else {
    result.action = cleanText(action) || null;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Planner error normalization and stop boundary
// ---------------------------------------------------------------------------

export function normalizeError(result = null, {
  action = "",
  preset = "",
  traceId = null,
  fallbackError = "business_error",
} = {}) {
  const normalizedAction = cleanText(action) || null;
  const normalizedPreset = cleanText(preset) || null;

  if (!result || typeof result !== "object") {
    return normalizedPreset
      ? {
          ok: false,
          preset: normalizedPreset,
          error: fallbackError,
          data: { raw: result },
          trace_id: traceId || null,
        }
      : {
          ok: false,
          action: normalizedAction,
          error: fallbackError,
          data: { raw: result },
          trace_id: traceId || null,
        };
  }

  if (result.ok !== false) {
    return result;
  }

  const normalized = {
    ...result,
    ok: false,
    error: cleanText(result.error || "") || fallbackError,
    data: result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data
      : {},
    trace_id: result.trace_id ?? traceId ?? null,
  };

  if (normalizedPreset || cleanText(result.preset || "")) {
    normalized.preset = cleanText(result.preset || normalizedPreset) || null;
  } else {
    normalized.action = cleanText(result.action || normalizedAction) || null;
  }

  return normalized;
}

const plannerExecutionPolicy = {
  contract_violation: {
    self_heal: 1,
    retry: 0,
    stop_reason: "contract_violation",
  },
  tool_error: {
    self_heal: 0,
    retry: 1,
    stop_reason: "tool_error",
  },
  runtime_exception: {
    self_heal: 0,
    retry: 1,
    stop_reason: "runtime_exception",
  },
  business_error: {
    self_heal: 0,
    retry: 0,
    stop_reason: "business_error",
  },
};

function getPlannerExecutionPolicy(errorCode = "") {
  return plannerExecutionPolicy[cleanText(errorCode)] || null;
}

function getPlannerStopReason(errorCode = "", fallback = "business_error") {
  return cleanText(getPlannerExecutionPolicy(errorCode)?.stop_reason || "") || cleanText(fallback) || "business_error";
}

function getPlannerRetryBudget(errorCode = "") {
  return Number(getPlannerExecutionPolicy(errorCode)?.retry || 0);
}

function buildPlannerTraceEvent({
  eventType = "",
  action = null,
  preset = null,
  agent = null,
  traceId = null,
  ok = null,
  error = null,
  retryCount = null,
  healed = null,
  stopped = null,
  stopReason = null,
  extra = {},
} = {}) {
  return {
    stage: cleanText(eventType) || null,
    event_type: cleanText(eventType) || null,
    action: cleanText(action) || null,
    preset: cleanText(preset) || null,
    agent: cleanText(agent) || null,
    trace_id: traceId || null,
    ok: typeof ok === "boolean" ? ok : ok ?? null,
    error: cleanText(error) || null,
    retry_count: Number.isFinite(retryCount) ? retryCount : retryCount ?? null,
    healed: typeof healed === "boolean" ? healed : healed ?? null,
    stopped: typeof stopped === "boolean" ? stopped : stopped ?? null,
    stop_reason: cleanText(stopReason) || null,
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
  };
}

function logPlannerTrace(logger, level = "info", event = {}) {
  logger?.[level]?.(cleanText(event.event_type || "planner_event") || "planner_event", event);
}

function emitPlannerRuntimeTrace(logger, event = {}) {
  const level = typeof logger?.debug === "function" ? "debug" : "info";
  logPlannerTrace(logger, level, event);
}

function buildPlannerStoppedResult({
  action = "",
  preset = "",
  error = "business_error",
  data = {},
  traceId = null,
  stopReason = "",
  extra = {},
} = {}) {
  return withStopBoundary({
    ok: false,
    ...(cleanText(preset) ? { preset: cleanText(preset) } : { action: cleanText(action) || null }),
    error: cleanText(error) || "business_error",
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    trace_id: traceId || null,
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
  }, {
    action,
    preset,
    traceId,
    stopReason: getPlannerStopReason(stopReason || error, cleanText(error) || "business_error"),
  });
}

// ---------------------------------------------------------------------------
// Planner internal interface / future wrapper hook points
// ---------------------------------------------------------------------------

function buildPlannerAgentInput({
  userIntent = "",
  taskType = "",
  payload = {},
} = {}) {
  return {
    user_intent: cleanText(String(userIntent || "")) || "",
    task_type: cleanText(String(taskType || "")) || "",
    payload: normalizePlannerPayload(payload),
  };
}

function buildPlannerActionRuntimeInput({
  action = "",
  payload = {},
  baseUrl = oauthBaseUrl,
  maxRetry = 1,
} = {}) {
  return {
    action: cleanText(action) || "",
    payload: normalizePlannerPayload(payload),
    base_url: baseUrl,
    max_retry: maxRetry,
  };
}

function buildPlannerPresetRuntimeInput({
  preset = "",
  input = {},
  stopOnError = true,
} = {}) {
  return {
    preset: cleanText(preset) || "",
    input: normalizePlannerPayload(input),
    stop_on_error: stopOnError === false ? false : true,
  };
}

function buildPlannerAgentOutput({
  selectedAction = null,
  executionResult = null,
  traceId = null,
} = {}) {
  return {
    selected_action: selectedAction,
    execution_result: executionResult,
    trace_id: traceId,
  };
}

function buildPlannerMultiStepOutput({
  steps = [],
  results = [],
  traceId = null,
} = {}) {
  return {
    steps,
    results,
    trace_id: traceId,
  };
}

function buildPlannerPresetOutput({
  ok = false,
  preset = "",
  steps = [],
  results = [],
  traceId = null,
  stopped = false,
  stoppedAtStep = null,
} = {}) {
  return {
    ok,
    preset,
    steps,
    results,
    trace_id: traceId,
    stopped,
    stopped_at_step: stoppedAtStep,
  };
}

export function resetPlannerRuntimeContext() {
  resetPlannerFlowContexts(plannerFlows);
  resetPlannerConversationMemory();
  resetPlannerTaskLifecycleStore().catch(() => {});
}

function createPlannerRuntimeHooks() {
  // These are no-op attachment points reserved for a future planner-agent
  // wrapper, handoff surface, or escalation boundary. Phase 3 only makes the
  // internal interface explicit; it does not enable a new runtime layer.
  return {
    onActionDispatchStart() {},
    onActionDispatchResult() {},
    onPresetStart() {},
    onPresetResult() {},
    onHandoff() {},
    onEscalation() {},
  };
}

function maybeInvokePlannerHook(hooks, hookName, payload = {}) {
  const handler = hooks?.[hookName];
  if (typeof handler === "function") {
    handler(payload);
  }
}

function withStopBoundary(result = null, {
  action = "",
  preset = "",
  traceId = null,
  stopReason = "",
} = {}) {
  const normalized = normalizeError(result, {
    action,
    preset,
    traceId,
    fallbackError: cleanText(stopReason || "") || "business_error",
  });
  if (!normalized || typeof normalized !== "object" || normalized.ok !== false) {
    return normalized;
  }

  const existingData = normalized.data && typeof normalized.data === "object" && !Array.isArray(normalized.data)
    ? normalized.data
    : {};
  const effectiveStopReason = cleanText(existingData.stop_reason || stopReason || normalized.error || "") || "business_error";
  const nextData = {
    ...existingData,
    stopped: existingData.stopped === true ? true : true,
    stop_reason: effectiveStopReason,
  };

  if ("stopped_at_step" in existingData) {
    nextData.stopped_at_step = existingData.stopped_at_step;
  }

  return {
    ...normalized,
    data: nextData,
  };
}

// ---------------------------------------------------------------------------
// Planner retry/self-heal helpers
// ---------------------------------------------------------------------------

function withRetryCount(result = null, retryCount = 0) {
  if (!result || typeof result !== "object") {
    return result;
  }
  return {
    ...result,
    data: result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? {
          ...result.data,
          retry_count: retryCount,
        }
      : {
          retry_count: retryCount,
        },
  };
}

function withDispatchMeta(result = null, { retryCount = 0, healed = false } = {}) {
  const normalized = withRetryCount(result, retryCount);
  if (!normalized || typeof normalized !== "object" || normalized.ok !== true || healed !== true) {
    return normalized;
  }
  return {
    ...normalized,
    data: normalized.data && typeof normalized.data === "object" && !Array.isArray(normalized.data)
      ? {
          ...normalized.data,
          healed: true,
        }
      : {
          healed: true,
          retry_count: retryCount,
        },
  };
}

function shouldRetryPlannerError(result = null) {
  const errorCode = cleanText(result?.error || "");
  return getPlannerRetryBudget(errorCode) > 0;
}

function defaultHealedValue(schema = null) {
  const expectedTypes = Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : [];
  if (expectedTypes.includes("string")) {
    return "";
  }
  return null;
}

function coerceHealedValue(schema = null, value) {
  const expectedTypes = Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : [];
  if (expectedTypes.includes("string")) {
    return String(value);
  }
  if (expectedTypes.includes("number")) {
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : value;
  }
  if (expectedTypes.includes("boolean")) {
    return Boolean(value);
  }
  return value;
}

function healPlannerInput(action = "", payload = {}, violations = []) {
  const contract = getPlannerActionContract(action);
  const inputSchema = contract?.input_schema;
  if (!inputSchema || typeof payload !== "object" || payload == null || Array.isArray(payload)) {
    return { healed: false, payload };
  }

  const healedPayload = { ...payload };
  let healed = false;

  for (const violation of Array.isArray(violations) ? violations : []) {
    const path = cleanText(String(violation?.path || ""));
    const key = path.startsWith("payload.") ? path.slice("payload.".length) : "";
    if (!key || key.includes(".")) {
      continue;
    }
    const propertySchema = inputSchema?.properties?.[key] || null;
    if (!propertySchema) {
      continue;
    }

    if (violation?.code === "missing_required" || violation?.type === "required") {
      healedPayload[key] = defaultHealedValue(propertySchema);
      healed = true;
      continue;
    }

    if ((violation?.code === "type_mismatch" || violation?.type === "type") && key in healedPayload) {
      healedPayload[key] = coerceHealedValue(propertySchema, healedPayload[key]);
      healed = true;
    }
  }

  return {
    healed,
    payload: healedPayload,
  };
}

function normalizePlannerPayload(payload = {}) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
}

function resolveDispatchInput({
  action = "",
  payload = {},
  logger = console,
} = {}) {
  let effectivePayload = normalizePlannerPayload(payload);
  let selfHealRetryCount = 0;
  let healed = false;

  const inputValidation = validateInput(action, effectivePayload);
  if (inputValidation.ok) {
    return {
      ok: true,
      payload: effectivePayload,
      healed,
      selfHealRetryCount,
    };
  }

  const healingResult = healPlannerInput(action, effectivePayload, inputValidation.violations);
  if (healingResult.healed) {
    const healedValidation = validateInput(action, healingResult.payload);
    if (healedValidation.ok) {
      effectivePayload = healingResult.payload;
      healed = true;
      selfHealRetryCount = 1;
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "self_heal_attempt",
        action,
        error: "contract_violation",
        retryCount: selfHealRetryCount,
        healed: true,
      }));
      logPlannerTrace(logger, "info", buildPlannerTraceEvent({
        eventType: "planner_tool_dispatch",
        action,
        healed: true,
        retryCount: selfHealRetryCount,
      }));
      return {
        ok: true,
        payload: effectivePayload,
        healed,
        selfHealRetryCount,
      };
    }

    return {
      ok: false,
      result: buildContractViolationResult({
        action,
        phase: "input",
        violations: inputValidation.violations,
        traceId: null,
        raw: payload,
      }),
      retryCount: 1,
    };
  }

  return {
    ok: false,
    result: buildContractViolationResult({
      action,
      phase: "input",
      violations: inputValidation.violations,
      traceId: null,
      raw: payload,
    }),
    retryCount: 0,
  };
}

function buildPlannerDispatchUrl(tool, payload, baseUrl) {
  const resolvedPathname = typeof tool.pathnameBuilder === "function"
    ? tool.pathnameBuilder(payload)
    : tool.pathname;
  const url = new URL(resolvedPathname, baseUrl);
  if (tool.method === "GET" && payload && typeof payload === "object") {
    const queryKeys = Array.isArray(tool.queryKeys) ? tool.queryKeys : Object.keys(payload);
    for (const key of queryKeys) {
      const value = payload[key];
      if (value == null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return {
    resolvedPathname,
    url,
  };
}

function parsePlannerDispatchResponse(rawText, action = "") {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    return {
      ok: false,
      action,
      data: {
        error: "invalid_json_response",
        raw: rawText || null,
      },
      trace_id: null,
    };
  }
}

function isCompanyBrainQueryAction(action = "") {
  return [
    "list_company_brain_docs",
    "search_company_brain_docs",
    "get_company_brain_doc_detail",
  ].includes(cleanText(action));
}

function buildEmptyCompanyBrainSummary() {
  return {
    overview: "",
    headings: [],
    highlights: [],
    snippet: "",
    content_length: 0,
  };
}

function normalizeCompanyBrainListItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    doc_id: cleanText(item?.doc_id) || "",
    title: cleanText(item?.title) || "",
    source: cleanText(item?.source) || "",
    created_at: cleanText(item?.created_at) || "",
    creator: item?.creator && typeof item.creator === "object"
      ? {
          account_id: cleanText(item.creator.account_id) || "",
          open_id: cleanText(item.creator.open_id) || "",
        }
      : {
          account_id: "",
          open_id: "",
        },
    summary: item?.summary && typeof item.summary === "object"
      ? {
          overview: cleanText(item.summary.overview) || "",
          headings: Array.isArray(item.summary.headings) ? item.summary.headings.map((value) => cleanText(value)).filter(Boolean) : [],
          highlights: Array.isArray(item.summary.highlights) ? item.summary.highlights.map((value) => cleanText(value)).filter(Boolean) : [],
          snippet: cleanText(item.summary.snippet) || cleanText(item.summary.overview) || "",
          content_length: Number.isFinite(Number(item.summary.content_length)) ? Number(item.summary.content_length) : 0,
        }
      : buildEmptyCompanyBrainSummary(),
    ...(item?.match && typeof item.match === "object"
      ? {
          match: {
            type: cleanText(item.match.type) || "keyword",
            keyword_score: Number(item.match.keyword_score || 0),
            semantic_score: Number(item.match.semantic_score || 0),
            score: Number(item.match.score || 0),
          },
        }
      : {}),
  }));
}

function normalizeCompanyBrainActionResult(action = "", result = null) {
  if (!isCompanyBrainQueryAction(action) || !result || typeof result !== "object") {
    return result;
  }

  const existingEnvelope = result?.data;
  if (
    existingEnvelope
    && typeof existingEnvelope === "object"
    && !Array.isArray(existingEnvelope)
    && typeof existingEnvelope.success === "boolean"
  ) {
    return result;
  }

  const rawData = result?.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data
    : buildPlannerToolExecutionData(result);
  const success = result?.ok !== false;
  const error = cleanText(result?.error) || null;

  if (action === "get_company_brain_doc_detail") {
    const item = rawData?.doc || rawData?.item || rawData || {};
    return {
      ...result,
      data: {
        success,
        data: {
          doc: {
            doc_id: cleanText(item?.doc_id) || "",
            title: cleanText(item?.title) || "",
            source: cleanText(item?.source) || "",
            created_at: cleanText(item?.created_at) || "",
            creator: item?.creator && typeof item.creator === "object"
              ? {
                  account_id: cleanText(item.creator.account_id) || "",
                  open_id: cleanText(item.creator.open_id) || "",
                }
              : {
                  account_id: "",
                  open_id: "",
                },
          },
          summary: rawData?.summary && typeof rawData.summary === "object"
            ? {
                overview: cleanText(rawData.summary.overview) || "",
                headings: Array.isArray(rawData.summary.headings) ? rawData.summary.headings.map((value) => cleanText(value)).filter(Boolean) : [],
                highlights: Array.isArray(rawData.summary.highlights) ? rawData.summary.highlights.map((value) => cleanText(value)).filter(Boolean) : [],
                snippet: cleanText(rawData.summary.snippet) || cleanText(rawData.summary.overview) || "",
                content_length: Number.isFinite(Number(rawData.summary.content_length)) ? Number(rawData.summary.content_length) : 0,
              }
            : buildEmptyCompanyBrainSummary(),
        },
        error,
      },
    };
  }

  return {
    ...result,
    data: {
      success,
      data: {
        ...(action === "search_company_brain_docs" ? { q: cleanText(rawData?.q) || "" } : {}),
        total: Number.isFinite(Number(rawData?.total)) ? Number(rawData.total) : 0,
        items: normalizeCompanyBrainListItems(rawData?.items),
      },
      error,
    },
  };
}

function buildPlannerToolExecutionData(result = null) {
  if (!result || typeof result !== "object") {
    return {};
  }

  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    return result.data;
  }

  return Object.fromEntries(
    Object.entries(result).filter(([key]) => !["ok", "action", "preset", "error", "trace_id"].includes(key)),
  );
}

// ---------------------------------------------------------------------------
// Planner contract validation public helpers
// ---------------------------------------------------------------------------

export function validateInput(action = "", payload = {}) {
  const contract = getPlannerActionContract(action);
  if (!contract?.input_schema) {
    return { ok: true, violations: [] };
  }
  const violations = validateAgainstSchema(contract.input_schema, payload, "payload");
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function validateOutput(action = "", result = null) {
  if (!result || result.ok !== true) {
    return { ok: true, violations: [] };
  }

  const contract = getPlannerActionContract(action);
  if (!contract?.output_schema) {
    return { ok: true, violations: [] };
  }
  const violations = validateAgainstSchema(contract.output_schema, result, "result");
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function validatePresetOutput(presetName = "", result = null) {
  if (!result || result.ok !== true) {
    return { ok: true, violations: [] };
  }

  const contract = getPlannerPresetContract(presetName);
  if (!contract?.output_schema) {
    return { ok: true, violations: [] };
  }

  const violations = validateAgainstSchema(contract.output_schema, result, "result");
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function validatePlannerUserInputDecision(decision = {}) {
  const normalizedDecision = decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision
    : {};
  const action = cleanText(normalizedDecision.action || "");
  const rawParams = normalizedDecision.params;
  if (rawParams != null && (typeof rawParams !== "object" || Array.isArray(rawParams))) {
    return {
      ok: false,
      error: "planner_failed",
    };
  }
  const params = normalizePlannerPayload(normalizedDecision.params);

  if (!action) {
    return {
      ok: false,
      error: "planner_failed",
    };
  }

  const contractTarget = getPlannerDecisionContract(action);
  if (!contractTarget) {
    return {
      ok: false,
      error: "invalid_action",
      action,
      params,
    };
  }

  const violations = validateAgainstSchema(contractTarget.contract?.input_schema, params, "params");
  if (violations.length > 0) {
    return {
      ok: false,
      error: "contract_violation",
      action,
      params,
      violations,
    };
  }

  return {
    ok: true,
    action,
    params,
    target_kind: contractTarget.kind,
  };
}

// ---------------------------------------------------------------------------
// Planner tool and preset registries
// ---------------------------------------------------------------------------

const plannerToolRegistry = new Map([
  ["create_doc", {
    action: "create_doc",
    method: "POST",
    pathname: "/agent/docs/create",
  }],
  ["list_company_brain_docs", {
    action: "list_company_brain_docs",
    method: "GET",
    pathname: "/agent/company-brain/docs",
    queryKeys: ["limit"],
  }],
  ["search_company_brain_docs", {
    action: "search_company_brain_docs",
    method: "GET",
    pathname: "/agent/company-brain/search",
    queryKeys: ["q", "limit"],
  }],
  ["get_company_brain_doc_detail", {
    action: "get_company_brain_doc_detail",
    method: "GET",
    pathnameBuilder(payload = {}) {
      const docId = cleanText(String(payload.doc_id || ""));
      if (!docId) {
        throw new Error("planner_tool_missing_doc_id:get_company_brain_doc_detail");
      }
      return `/agent/company-brain/docs/${encodeURIComponent(docId)}`;
    },
    queryKeys: [],
  }],
  ["get_runtime_info", {
    action: "get_runtime_info",
    method: "GET",
    pathname: "/agent/system/runtime-info",
    queryKeys: [],
  }],
]);

const plannerPresetRegistry = new Map([
  ["create_and_list_doc", {
    preset: "create_and_list_doc",
    buildSteps({ title = "", folder_token = "", limit = 10 } = {}) {
      return [
        {
          action: "create_doc",
          payload: {
            title,
            folder_token,
          },
        },
        {
          action: "list_company_brain_docs",
          payload: {
            limit,
          },
        },
      ];
    },
  }],
  ["runtime_and_list_docs", {
    preset: "runtime_and_list_docs",
    buildSteps({ limit = 10 } = {}) {
      return [
        {
          action: "get_runtime_info",
          payload: {},
        },
        {
          action: "list_company_brain_docs",
          payload: {
            limit,
          },
        },
      ];
    },
  }],
  ["create_search_detail_list_doc", {
    preset: "create_search_detail_list_doc",
    buildSteps({ title = "", folder_token = "", q = "", doc_id = "", limit = 10 } = {}) {
      return [
        {
          action: "create_doc",
          payload: {
            title,
            folder_token,
          },
        },
        {
          action: "search_company_brain_docs",
          payload: {
            q,
            limit,
          },
        },
        {
          action: "get_company_brain_doc_detail",
          payload: {
            doc_id,
          },
        },
        {
          action: "list_company_brain_docs",
          payload: {
            limit,
          },
        },
      ];
    },
  }],
  ["search_and_detail_doc", {
    preset: "search_and_detail_doc",
    buildSteps({ q = "", doc_id = "", limit = 10 } = {}) {
      return [
        {
          action: "search_company_brain_docs",
          payload: {
            q,
            limit,
          },
        },
        {
          action: "get_company_brain_doc_detail",
          payload: {
            doc_id,
          },
        },
      ];
    },
  }],
]);

export function listPlannerTools() {
  return Array.from(plannerToolRegistry.values()).map((tool) => ({
    action: tool.action,
    method: tool.method,
    pathname: tool.pathname || null,
    has_dynamic_pathname: typeof tool.pathnameBuilder === "function",
  }));
}

export function getPlannerTool(action = "") {
  return plannerToolRegistry.get(cleanText(action));
}

export function getPlannerPreset(preset = "") {
  return plannerPresetRegistry.get(cleanText(preset));
}

// ---------------------------------------------------------------------------
// Planner selection runtime
// ---------------------------------------------------------------------------

export function selectPlannerTool({
  userIntent = "",
  taskType = "",
  logger = console,
} = {}) {
  const normalizedIntent = cleanText(String(userIntent || "").toLowerCase());
  const normalizedTaskType = cleanText(String(taskType || "").toLowerCase());

  let selectedAction = "";
  let reason = "";

  if (
    normalizedIntent.includes("建立文件並查詢")
    || normalizedIntent.includes("create then search")
    || normalizedIntent.includes("建立後搜尋文件")
    || normalizedIntent.includes("create search doc")
  ) {
    selectedAction = "create_search_detail_list_doc";
    reason = "命中完整流程任務，使用 demo preset。";
  } else if (
    normalizedIntent.includes("建立文件後列出知識庫")
    || normalizedIntent.includes("create doc then list docs")
    || normalizedIntent.includes("建立並查看文件列表")
  ) {
    selectedAction = "create_and_list_doc";
    reason = "命中複合任務，優先使用 preset。";
  } else if (
    normalizedTaskType === "doc_write"
    || normalizedIntent.includes("建立文件")
    || normalizedIntent.includes("创建文档")
    || normalizedIntent.includes("create doc")
    || normalizedIntent.includes("新建文件")
  ) {
    selectedAction = "create_doc";
    reason = "使用者意圖是建立文件，對應受控文件建立 bridge。";
  } else if (
    normalizedTaskType === "knowledge_write"
    || normalizedIntent.includes("company brain")
    || normalizedIntent.includes("知識庫文件")
    || normalizedIntent.includes("知识库文件")
    || normalizedIntent.includes("列出文件")
    || normalizedIntent.includes("list docs")
  ) {
    selectedAction = "list_company_brain_docs";
    reason = "使用者意圖是查詢已驗證文件鏡像，對應 company_brain list bridge。";
  } else if (
    normalizedIntent.includes("runtime")
    || normalizedIntent.includes("db path")
    || normalizedIntent.includes("pid")
    || normalizedIntent.includes("cwd")
    || normalizedIntent.includes("service start")
    || normalizedIntent.includes("運行資訊")
    || normalizedIntent.includes("运行信息")
  ) {
    selectedAction = "get_runtime_info";
    reason = "使用者意圖是查詢當前執行環境資訊，對應 runtime info bridge。";
  }

  if (!selectedAction) {
    reason = "未命中受控工具規則，保持空選擇。";
  }

  logger?.info?.("planner_tool_select", {
    stage: "planner_tool_select",
    user_intent: normalizedIntent || null,
    task_type: normalizedTaskType || null,
    selected_action: selectedAction || null,
    reason: reason || null,
  });

  return {
    selected_action: selectedAction || null,
    reason: reason || null,
  };
}

// ---------------------------------------------------------------------------
// Planner action dispatch runtime
// ---------------------------------------------------------------------------

export async function dispatchPlannerTool({
  action = "",
  payload = {},
  logger = console,
  baseUrl = oauthBaseUrl,
  maxRetry = 1,
} = {}) {
  const runtimeInput = buildPlannerActionRuntimeInput({
    action,
    payload,
    baseUrl,
    maxRetry,
  });
  const requestId = createRequestId("planner_tool");
  const hooks = createPlannerRuntimeHooks();
  const tool = getPlannerTool(runtimeInput.action);
  if (!tool) {
    const stoppedResult = buildPlannerStoppedResult({
      action: runtimeInput.action,
      error: "not_found",
      data: {
        message: `planner_tool_not_found:${runtimeInput.action}`,
      },
      traceId: null,
    });
    emitToolExecutionLog({
      logger,
      requestId,
      action: runtimeInput.action,
      params: runtimeInput.payload,
      success: false,
      data: buildPlannerToolExecutionData(stoppedResult),
      error: stoppedResult.error,
      traceId: stoppedResult.trace_id || null,
    });
    return stoppedResult;
  }

  const resolvedInput = resolveDispatchInput({
    action: tool.action,
    payload: runtimeInput.payload,
    logger,
  });
  if (!resolvedInput.ok) {
    logPlannerTrace(logger, "warn", buildPlannerTraceEvent({
      eventType: "planner_tool_dispatch",
      action: tool.action,
      ok: false,
      error: "contract_violation",
      extra: {
        phase: "input",
        violations: resolvedInput.result?.data?.violations || [],
      },
    }));
    const stoppedResult = withDispatchMeta(buildPlannerStoppedResult({
      action: tool.action,
      error: "contract_violation",
      data: resolvedInput.result?.data || {},
      traceId: null,
      stopReason: plannerExecutionPolicy.contract_violation.stop_reason,
    }), {
      retryCount: resolvedInput.retryCount ?? 0,
      healed: false,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "stopped",
      action: tool.action,
      ok: false,
      error: stoppedResult?.error || "contract_violation",
      retryCount: stoppedResult?.data?.retry_count ?? resolvedInput.retryCount ?? 0,
      stopped: true,
      stopReason: stoppedResult?.data?.stop_reason || "contract_violation",
      traceId: stoppedResult?.trace_id || null,
    }));
    emitToolExecutionLog({
      logger,
      requestId,
      action: tool.action,
      params: runtimeInput.payload,
      success: false,
      data: buildPlannerToolExecutionData(stoppedResult),
      error: stoppedResult.error,
      traceId: stoppedResult.trace_id || null,
    });
    return stoppedResult;
  }
  const effectivePayload = resolvedInput.payload;
  const selfHealRetryCount = resolvedInput.selfHealRetryCount;
  const healed = resolvedInput.healed;

  let stickyTraceId = null;
  let runtimeRetryCount = 0;

  async function attemptDispatch() {
    const { resolvedPathname, url } = buildPlannerDispatchUrl(tool, effectivePayload, runtimeInput.base_url);
    maybeInvokePlannerHook(hooks, "onActionDispatchStart", {
      action: tool.action,
      payload: effectivePayload,
      pathname: resolvedPathname,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "action_dispatch",
      action: tool.action,
      retryCount: runtimeRetryCount,
      healed,
      traceId: stickyTraceId || null,
    }));

    logPlannerTrace(logger, "info", buildPlannerTraceEvent({
      eventType: "planner_tool_dispatch",
      action: tool.action,
      extra: {
        method: tool.method,
        pathname: resolvedPathname,
      },
    }));

    const response = await fetch(url, {
      method: tool.method,
      headers: {
        ...(tool.method === "POST" ? { "Content-Type": "application/json" } : {}),
        "X-Request-Id": requestId,
      },
      body: tool.method === "POST"
        ? JSON.stringify(effectivePayload && typeof effectivePayload === "object" ? effectivePayload : {})
        : undefined,
    });

    const rawText = await response.text();
    const data = normalizeCompanyBrainActionResult(
      tool.action,
      parsePlannerDispatchResponse(rawText, tool.action),
    );
    maybeInvokePlannerHook(hooks, "onActionDispatchResult", {
      action: tool.action,
      result: data,
      pathname: resolvedPathname,
      status_code: response.status,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "action_result",
      action: tool.action,
      ok: Boolean(data?.ok),
      error: cleanText(data?.ok === false ? data?.error : "") || null,
      retryCount: runtimeRetryCount,
      healed,
      traceId: data?.trace_id || stickyTraceId || null,
      stopped: data?.ok === false ? true : false,
      stopReason: data?.ok === false ? getPlannerStopReason(data?.error || "", "") || null : null,
    }));

    logPlannerTrace(logger, "info", buildPlannerTraceEvent({
      eventType: "planner_tool_dispatch",
      action: tool.action,
      ok: Boolean(data?.ok),
      traceId: data?.trace_id || null,
      extra: {
        method: tool.method,
        pathname: resolvedPathname,
        status_code: response.status,
      },
    }));

    stickyTraceId = stickyTraceId || data?.trace_id || null;

    const outputValidation = validateOutput(action, data);
    if (!outputValidation.ok) {
      const result = buildContractViolationResult({
        action: tool.action,
        phase: "output",
        violations: outputValidation.violations,
        traceId: data?.trace_id || null,
        raw: data,
      });
      logPlannerTrace(logger, "warn", buildPlannerTraceEvent({
        eventType: "planner_tool_dispatch",
        action: tool.action,
        ok: false,
        error: "contract_violation",
        traceId: data?.trace_id || null,
        extra: {
          phase: "output",
          violations: outputValidation.violations,
        },
      }));
      return buildPlannerStoppedResult({
        action: tool.action,
        error: "contract_violation",
        data: result.data,
        traceId: stickyTraceId,
      });
    }

    if (data?.ok === false) {
      return normalizeError(data, {
        action: tool.action,
        traceId: stickyTraceId,
        fallbackError: "tool_error",
      });
    }

    return {
      ...data,
      trace_id: stickyTraceId || data?.trace_id || null,
    };
  }

  async function attemptWithCatch() {
    try {
      return await attemptDispatch();
    } catch (error) {
      return normalizeError({
        ok: false,
        action: tool.action,
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
        trace_id: stickyTraceId,
      }, {
        action: tool.action,
        traceId: stickyTraceId,
        fallbackError: "runtime_exception",
      });
    }
  }

  let result = await attemptWithCatch();

  while (
    runtimeRetryCount < runtimeInput.max_retry
    && result?.ok === false
    && shouldRetryPlannerError(result)
  ) {
    runtimeRetryCount += 1;
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "retry_attempt",
      action: tool.action,
      error: result.error,
      retryCount: runtimeRetryCount,
      traceId: stickyTraceId || result?.trace_id || null,
    }));
    logPlannerTrace(logger, "info", buildPlannerTraceEvent({
      eventType: "planner_tool_dispatch_retry",
      action: tool.action,
      error: result.error,
      retryCount: runtimeRetryCount,
      traceId: stickyTraceId || result?.trace_id || null,
    }));
    result = await attemptWithCatch();
  }

  const retryCount = selfHealRetryCount + runtimeRetryCount;
  const normalizedResult = result?.ok === false
    ? buildPlannerStoppedResult({
        action: tool.action,
        error: result?.error || "business_error",
        data: result?.data || {},
        traceId: stickyTraceId || result?.trace_id || null,
      })
    : result;
  if (normalizedResult?.ok === false) {
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "stopped",
      action: tool.action,
      ok: false,
      error: normalizedResult?.error || "business_error",
      retryCount,
      healed,
      stopped: true,
      stopReason: normalizedResult?.data?.stop_reason || normalizedResult?.error || "business_error",
      traceId: normalizedResult?.trace_id || null,
    }));
  }
  const finalResult = withDispatchMeta(normalizedResult, { retryCount, healed });
  emitToolExecutionLog({
    logger,
    requestId,
    action: tool.action,
    params: effectivePayload,
    success: finalResult?.ok === true,
    data: buildPlannerToolExecutionData(finalResult),
    error: finalResult?.ok === false ? finalResult?.error || "business_error" : null,
    traceId: finalResult?.trace_id || stickyTraceId || null,
  });
  return finalResult;
}

// ---------------------------------------------------------------------------
// Planner end-to-end flow runtime
// ---------------------------------------------------------------------------

export async function runPlannerToolFlow({
  userIntent = "",
  taskType = "",
  payload = {},
  logger = console,
  selector = selectPlannerTool,
  dispatcher = dispatchPlannerTool,
  presetRunner = runPlannerPreset,
  contentReader,
  baseUrl = oauthBaseUrl,
  forcedSelection = null,
  disableAutoRouting = false,
} = {}) {
  restorePlannerRuntimeContextFromSummary();
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    logger,
    reason: "pre_run_planner_tool_flow",
  });
  const agentInput = buildPlannerAgentInput({
    userIntent,
    taskType,
    payload,
  });
  const hooks = createPlannerRuntimeHooks();
  const normalizedForcedSelection = forcedSelection && typeof forcedSelection === "object"
    ? {
        selected_action: cleanText(forcedSelection.selected_action || forcedSelection.action || "") || null,
        reason: cleanText(forcedSelection.reason || "") || "forced_selection",
      }
    : null;
  const plannerDocQueryContext = getPlannerDocQueryContext();
  const taskLifecycleFollowUp = (!disableAutoRouting && !normalizedForcedSelection)
    ? await maybeRunPlannerTaskLifecycleFollowUp({
        userIntent: agentInput.user_intent,
        activeDoc: plannerDocQueryContext.activeDoc,
        activeTheme: plannerDocQueryContext.activeTheme,
        logger,
      })
    : null;
  const routedFlow = normalizedForcedSelection
    ? {
        flow: getPlannerFlowForAction(plannerFlows, normalizedForcedSelection.selected_action),
        action: null,
        payload: agentInput.payload,
        context: null,
      }
    : taskLifecycleFollowUp?.selected_action
      ? {
          flow: null,
          action: null,
          payload: agentInput.payload,
          context: null,
        }
      : disableAutoRouting
        ? {
            flow: null,
            action: null,
            payload: agentInput.payload,
            context: null,
          }
        : resolvePlannerFlowRoute({
            flows: plannerFlows,
            userIntent: agentInput.user_intent,
            payload: agentInput.payload,
            logger,
          });
  const hardRoutedAction = taskLifecycleFollowUp?.selected_action || (!disableAutoRouting ? routedFlow.action : null);
  const routedPayload = taskLifecycleFollowUp?.execution_result?.data || routedFlow.payload;
  const selection = normalizedForcedSelection
    ? normalizedForcedSelection
    : hardRoutedAction
    ? {
        selected_action: hardRoutedAction,
        reason: taskLifecycleFollowUp?.reason || "命中硬路由規則。",
      }
    : selector({
        userIntent: agentInput.user_intent,
        taskType: agentInput.task_type,
        logger,
      });

  let executionResult = null;
  let traceId = null;
  let lifecycleSnapshot = taskLifecycleFollowUp?.snapshot || null;

  if (selection.selected_action) {
    if (taskLifecycleFollowUp?.execution_result) {
      executionResult = taskLifecycleFollowUp.execution_result;
      traceId = executionResult?.trace_id || null;
    } else if (getPlannerPreset(selection.selected_action)) {
      maybeInvokePlannerHook(hooks, "onHandoff", {
        from: "planner_selection",
        to: "planner_preset",
        selected_action: selection.selected_action,
      });
      const selectedFlow = routedFlow.flow || getPlannerFlowForAction(plannerFlows, selection.selected_action);
      executionResult = await presetRunner({
        preset: selection.selected_action,
        input: buildPlannerFlowPayload({
          flow: selectedFlow,
          action: selection.selected_action,
          userIntent: agentInput.user_intent,
          payload: agentInput.payload,
          logger,
        }),
        logger,
      });
      traceId = executionResult?.trace_id || null;
      if (executionResult?.ok === false) {
        executionResult = buildPlannerStoppedResult({
          preset: selection.selected_action,
          error: executionResult?.error || "business_error",
          data: executionResult?.data || {},
          traceId,
        });
      }
    } else {
      maybeInvokePlannerHook(hooks, "onHandoff", {
        from: "planner_selection",
        to: "planner_dispatch",
        selected_action: selection.selected_action,
      });
      const selectedFlow = routedFlow.flow || getPlannerFlowForAction(plannerFlows, selection.selected_action);
      executionResult = await dispatcher({
        action: selection.selected_action,
        payload: buildPlannerFlowPayload({
          flow: selectedFlow,
          action: selection.selected_action,
          userIntent: agentInput.user_intent,
          payload: agentInput.payload,
          logger,
        }),
        logger,
      });
      traceId = executionResult?.trace_id || null;
    }
  } else {
    maybeInvokePlannerHook(hooks, "onEscalation", {
      from: "planner_selection",
      reason: selection.reason || "no_selected_action",
    });
    executionResult = buildPlannerStoppedResult({
      action: null,
      error: "business_error",
      data: {
        reason: selection.reason,
      },
      traceId: null,
    });
  }

  const selectedFlow = routedFlow.flow || getPlannerFlowForAction(plannerFlows, selection.selected_action);
  if (!taskLifecycleFollowUp?.execution_result) {
    executionResult = await formatPlannerFlowResult({
      flow: selectedFlow,
      selectedAction: selection.selected_action,
      executionResult,
      userIntent: agentInput.user_intent,
      payload: hardRoutedAction === selection.selected_action
        ? routedPayload
        : buildPlannerFlowPayload({
            flow: selectedFlow,
            action: selection.selected_action,
            userIntent: agentInput.user_intent,
            payload: agentInput.payload,
            logger,
          }),
      baseUrl,
      contentReader,
      logger,
    });
  }
  traceId = executionResult?.trace_id || traceId || null;

  logger?.info?.("planner_end_to_end", buildPlannerTraceEvent({
    eventType: "planner_end_to_end",
    ok: executionResult?.ok ?? false,
    traceId,
    extra: {
      user_intent: cleanText(String(userIntent || "").toLowerCase()) || null,
      task_type: cleanText(String(taskType || "").toLowerCase()) || null,
      selected_action: selection.selected_action || null,
    },
  }));

  if (!taskLifecycleFollowUp?.execution_result) {
    syncPlannerFlowContext({
      flow: selectedFlow,
      selectedAction: selection.selected_action,
      executionResult,
      logger,
    });
  }

  if (!taskLifecycleFollowUp?.execution_result) {
    lifecycleSnapshot = await syncPlannerActionLayerTaskLifecycle({
      flow: selectedFlow,
      context: selectedFlow?.readContext?.() || {},
      selectedAction: selection.selected_action,
      userIntent: agentInput.user_intent,
      executionResult,
      traceId,
    });
  }

  recordPlannerConversationExchange({
    userQuery: agentInput.user_intent,
    plannerReply: describePlannerExecutionResult(executionResult),
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    unfinishedItems: mergePlannerUnfinishedItems(
      derivePlannerUnfinishedItems({
        selection,
        executionResult,
      }),
      buildPlannerLifecycleUnfinishedItems(lifecycleSnapshot),
    ),
    latestSelectedAction: selection.selected_action,
    latestTraceId: traceId,
    logger,
    reason: "post_run_planner_tool_flow",
  });

  return buildPlannerAgentOutput({
    selectedAction: selection.selected_action,
    executionResult,
    traceId,
  });
}

// ---------------------------------------------------------------------------
// Planner multi-step runtime
// ---------------------------------------------------------------------------

export async function runPlannerMultiStep({
  steps = [],
  logger = console,
  dispatcher = dispatchPlannerTool,
} = {}) {
  const normalizedSteps = Array.isArray(steps)
    ? steps
        .map((step) => ({
          action: cleanText(step?.action || ""),
          payload: step?.payload && typeof step.payload === "object" ? step.payload : {},
        }))
        .filter((step) => step.action)
    : [];

  const results = [];
  let traceId = null;

  for (const step of normalizedSteps) {
    const result = await dispatcher({
      action: step.action,
      payload: step.payload,
      logger,
    });
    results.push(result);
    traceId = result?.trace_id || traceId;
  }

  logger?.info?.("planner_multi_step", buildPlannerTraceEvent({
    eventType: "planner_multi_step",
    traceId,
    extra: {
      step_count: normalizedSteps.length,
      actions: normalizedSteps.map((step) => step.action),
      ok_count: results.filter((item) => item?.ok).length,
    },
  }));

  return buildPlannerMultiStepOutput({
    steps: normalizedSteps.map((step) => ({ action: step.action })),
    results,
    traceId,
  });
}

// ---------------------------------------------------------------------------
// Planner preset runtime
// ---------------------------------------------------------------------------

export async function runPlannerPreset({
  preset = "",
  input = {},
  logger = console,
  multiStepRunner = runPlannerMultiStep,
  stop_on_error = true,
} = {}) {
  const runtimeInput = buildPlannerPresetRuntimeInput({
    preset,
    input,
    stopOnError: stop_on_error,
  });
  const hooks = createPlannerRuntimeHooks();
  const selectedPreset = getPlannerPreset(runtimeInput.preset);
  if (!selectedPreset) {
    const stoppedResult = buildPlannerStoppedResult({
      preset: cleanText(runtimeInput.preset) || null,
      error: "not_found",
      data: {
        message: `planner_preset_not_found:${runtimeInput.preset}`,
      },
      traceId: null,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "stopped",
      preset: cleanText(runtimeInput.preset) || null,
      ok: false,
      error: "not_found",
      stopped: true,
      stopReason: stoppedResult?.data?.stop_reason || "not_found",
      traceId: stoppedResult?.trace_id || null,
    }));
    return stoppedResult;
  }

  try {
    maybeInvokePlannerHook(hooks, "onPresetStart", {
      preset: selectedPreset.preset,
      input: runtimeInput.input,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "preset_start",
      preset: selectedPreset.preset,
      agent: "planner_agent",
      traceId: null,
    }));
    const steps = selectedPreset.buildSteps(runtimeInput.input)
      .map((step) => ({
        action: cleanText(step?.action || ""),
        payload: step?.payload && typeof step.payload === "object" ? step.payload : {},
      }))
      .filter((step) => step.action);

    let execution;
    if (runtimeInput.stop_on_error) {
      const results = [];
      let traceId = null;
      let stopped = false;
      let stoppedAtStep = null;
      let completedEarly = false;
      let effectiveDocId = cleanText(String(runtimeInput.input?.doc_id || ""));
      for (let index = 0; index < steps.length; index += 1) {
        const step = {
          ...steps[index],
          payload: { ...(steps[index]?.payload || {}) },
        };

        if (
          ["search_and_detail_doc", "create_search_detail_list_doc"].includes(selectedPreset.preset)
          && step.action === "get_company_brain_doc_detail"
          && !cleanText(String(step.payload.doc_id || ""))
        ) {
          const searchResult = results.find((result) => result?.action === "company_brain_docs_search");
          const searchItems = Array.isArray(searchResult?.items) ? searchResult.items : [];
          if (searchItems.length !== 1) {
            completedEarly = true;
            break;
          }
          const derivedDocId = cleanText(String(searchItems[0]?.doc_id || ""));
          if (!derivedDocId) {
            completedEarly = true;
            break;
          }
          effectiveDocId = derivedDocId;
          step.payload.doc_id = effectiveDocId;
        }

        const result = await multiStepRunner({
          steps: [step],
          logger,
        });
        const singleResult = result?.results?.[0] ?? null;
        if (singleResult) {
          results.push(singleResult);
          traceId = singleResult.trace_id || traceId;
        }
        if (singleResult?.ok === false) {
          stopped = true;
          stoppedAtStep = index;
          break;
        }
      }
      execution = {
        steps: steps.slice(0, results.length).map((step) => ({ action: step.action })),
        results,
        trace_id: traceId,
        stopped,
        stopped_at_step: stoppedAtStep,
        completed_early: completedEarly,
      };
    } else {
      const multiStepExecution = await multiStepRunner({
        steps,
        logger,
      });
      execution = {
        ...multiStepExecution,
        stopped: false,
        stopped_at_step: null,
      };
    }

    const ok = execution.results.length > 0
      && execution.results.every((result) => result?.ok === true)
      && execution.stopped !== true;

    const finalResult = buildPlannerPresetOutput({
      ok,
      preset: selectedPreset.preset,
      steps: execution.steps,
      results: execution.results,
      traceId: execution.trace_id,
      stopped: execution.stopped,
      stoppedAtStep: execution.stopped_at_step,
    });

    logger?.info?.("planner_preset", buildPlannerTraceEvent({
      eventType: "planner_preset",
      preset: selectedPreset.preset,
      ok: finalResult.ok,
      stopped: finalResult.stopped,
      traceId: finalResult.trace_id || null,
      extra: {
        step_count: finalResult.steps.length,
        stopped_at_step: finalResult.stopped_at_step,
      },
    }));
    maybeInvokePlannerHook(hooks, "onPresetResult", {
      preset: selectedPreset.preset,
      result: finalResult,
    });

    const presetOutputValidation = validatePresetOutput(selectedPreset.preset, finalResult);
    if (!presetOutputValidation.ok) {
      const stoppedResult = buildPlannerStoppedResult({
        preset: selectedPreset.preset,
        error: "contract_violation",
        data: {
          phase: "preset_output",
          violations: presetOutputValidation.violations,
          raw: finalResult,
        },
        traceId: finalResult.trace_id || null,
        extra: {
          steps: finalResult.steps,
          results: finalResult.results,
          stopped: finalResult.stopped,
          stopped_at_step: finalResult.stopped_at_step,
        },
      });
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "preset_result",
        preset: selectedPreset.preset,
        ok: false,
        error: "contract_violation",
        stopped: true,
        stopReason: stoppedResult?.data?.stop_reason || "contract_violation",
        traceId: stoppedResult?.trace_id || null,
      }));
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "stopped",
        preset: selectedPreset.preset,
        ok: false,
        error: "contract_violation",
        stopped: true,
        stopReason: stoppedResult?.data?.stop_reason || "contract_violation",
        traceId: stoppedResult?.trace_id || null,
      }));
      return stoppedResult;
    }

    if (finalResult.ok === false) {
      const stoppedResult = buildPlannerStoppedResult({
        preset: selectedPreset.preset,
        error: finalResult?.error || "business_error",
        data: {
          ...(finalResult?.data || {}),
          stopped: finalResult.stopped,
          stopped_at_step: finalResult.stopped_at_step,
        },
        traceId: finalResult.trace_id || null,
        extra: {
          steps: finalResult.steps,
          results: finalResult.results,
          stopped: finalResult.stopped,
          stopped_at_step: finalResult.stopped_at_step,
        },
      });
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "preset_result",
        preset: selectedPreset.preset,
        ok: false,
        error: stoppedResult?.error || "business_error",
        stopped: Boolean(stoppedResult?.stopped ?? stoppedResult?.data?.stopped),
        stopReason: stoppedResult?.data?.stop_reason || stoppedResult?.error || "business_error",
        traceId: stoppedResult?.trace_id || null,
      }));
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "stopped",
        preset: selectedPreset.preset,
        ok: false,
        error: stoppedResult?.error || "business_error",
        stopped: true,
        stopReason: stoppedResult?.data?.stop_reason || stoppedResult?.error || "business_error",
        traceId: stoppedResult?.trace_id || null,
      }));
      return stoppedResult;
    }

    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "preset_result",
      preset: selectedPreset.preset,
      ok: true,
      stopped: false,
      traceId: finalResult.trace_id || null,
    }));
    return finalResult;
  } catch (error) {
    const stoppedResult = buildPlannerStoppedResult({
      preset: selectedPreset.preset,
      error: "runtime_exception",
      data: {
        message: error instanceof Error ? error.message : String(error),
      },
      traceId: null,
    });
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "preset_result",
      preset: selectedPreset.preset,
      ok: false,
      error: "runtime_exception",
      stopped: true,
      stopReason: stoppedResult?.data?.stop_reason || "runtime_exception",
      traceId: stoppedResult?.trace_id || null,
    }));
    emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
      eventType: "stopped",
      preset: selectedPreset.preset,
      ok: false,
      error: "runtime_exception",
      stopped: true,
      stopReason: stoppedResult?.data?.stop_reason || "runtime_exception",
      traceId: stoppedResult?.trace_id || null,
    }));
    return stoppedResult;
  }
}

// ---------------------------------------------------------------------------
// Executive turn planning runtime
// ---------------------------------------------------------------------------

export function looksLikeExecutiveExit(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && hasAny(normalized, executiveExitSignals);
}

export function looksLikeExecutiveStart(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("/exec") || normalized.startsWith("/generalist") || normalized.startsWith("/ceo")) {
    return true;
  }
  if (parseRegisteredAgentCommand(normalized)) {
    return true;
  }
  return hasAny(normalized, executiveStartSignals);
}

function heuristicPlanExecutiveTurn(text = "", activeTask = null) {
  const normalized = cleanText(text.toLowerCase());
  const wantsCollaboration = hasAny(normalized, [
    "各個 agent",
    "各个 agent",
    "一起看",
    "協作",
    "协作",
    "統一",
    "统一",
    "分別看",
    "分别看",
  ]);
  const explicitMap = [
    ["ceo", "ceo"],
    ["product", "product"],
    ["prd", "prd"],
    ["cmo", "cmo"],
    ["consult", "consult"],
    ["cdo", "cdo"],
    ["delivery", "delivery"],
    ["ops", "ops"],
    ["tech", "tech"],
  ];

  for (const [signal, agentId] of explicitMap) {
    if (normalized.includes(signal)) {
      return {
        action: activeTask ? "handoff" : "start",
        objective: text,
        primary_agent_id: activeTask?.primary_agent_id || agentId,
        next_agent_id: agentId,
        supporting_agent_ids: activeTask?.supporting_agent_ids || [],
        reason: `使用者明確提到 ${signal}`,
        pending_questions: [],
      };
    }
  }

  if (normalized.includes("分配") || normalized.includes("分類")) {
    const supporting = activeTask?.supporting_agent_ids || ["consult", "ops"];
    return {
      action: activeTask ? "continue" : "start",
      objective: activeTask?.objective || text,
      primary_agent_id: activeTask?.primary_agent_id || "cdo",
      next_agent_id: activeTask?.current_agent_id || "cdo",
      supporting_agent_ids: supporting,
      reason: "這更像治理與分配任務",
      pending_questions: [],
      work_items: wantsCollaboration
        ? buildCollaborativeWorkItems({
            primaryAgentId: activeTask?.primary_agent_id || "cdo",
            supportingAgentIds: supporting,
            objective: activeTask?.objective || text,
          })
        : [],
    };
  }

  if (normalized.includes("決策") || normalized.includes("拍板")) {
    const supporting = activeTask?.supporting_agent_ids || ["consult", "product", "tech"];
    return {
      action: activeTask ? "handoff" : "start",
      objective: activeTask?.objective || text,
      primary_agent_id: activeTask?.primary_agent_id || "ceo",
      next_agent_id: "ceo",
      supporting_agent_ids: supporting,
      reason: "這更像高層決策整合任務",
      pending_questions: [],
      work_items: wantsCollaboration
        ? buildCollaborativeWorkItems({
            primaryAgentId: activeTask?.primary_agent_id || "ceo",
            supportingAgentIds: supporting,
            objective: activeTask?.objective || text,
          })
        : [],
    };
  }

  if (wantsCollaboration) {
    const primary = activeTask?.primary_agent_id || "generalist";
    const supporting = activeTask?.supporting_agent_ids?.length
      ? activeTask.supporting_agent_ids
      : ["consult", "product"];
    return {
      action: activeTask ? "continue" : "start",
      objective: activeTask?.objective || text,
      primary_agent_id: primary,
      next_agent_id: activeTask?.current_agent_id || primary,
      supporting_agent_ids: supporting,
      reason: activeTask ? "延續多 agent 協作任務" : "使用者要求多 agent 協作",
      pending_questions: [],
      work_items: buildCollaborativeWorkItems({
        primaryAgentId: primary,
        supportingAgentIds: supporting,
        objective: activeTask?.objective || text,
      }),
    };
  }

  return {
    action: activeTask ? "continue" : "start",
    objective: activeTask?.objective || text,
    primary_agent_id: activeTask?.primary_agent_id || "generalist",
    next_agent_id: activeTask?.current_agent_id || activeTask?.primary_agent_id || "generalist",
    supporting_agent_ids: activeTask?.supporting_agent_ids || [],
    reason: activeTask ? "延續當前任務" : "預設由 generalist 啟動",
    pending_questions: [],
    work_items: activeTask?.work_plan || [],
  };
}

function formatPlannerTaskDecisionPromptSection(taskDecisionContext = null) {
  if (!taskDecisionContext || typeof taskDecisionContext !== "object") {
    return "none";
  }
  const counts = taskDecisionContext?.counts || {};
  const blockedTasks = Array.isArray(taskDecisionContext?.blocked_tasks) ? taskDecisionContext.blocked_tasks : [];
  const inProgressTasks = Array.isArray(taskDecisionContext?.in_progress_tasks) ? taskDecisionContext.in_progress_tasks : [];
  const referenceTasks = Array.isArray(taskDecisionContext?.reference_tasks) ? taskDecisionContext.reference_tasks : [];
  const focusedTask = taskDecisionContext?.focused_task && typeof taskDecisionContext.focused_task === "object"
    ? taskDecisionContext.focused_task
    : null;
  return [
    cleanText(taskDecisionContext?.scope_title)
      ? `scope_title: ${cleanText(taskDecisionContext.scope_title)}`
      : "",
    cleanText(taskDecisionContext?.theme)
      ? `theme: ${cleanText(taskDecisionContext.theme)}`
      : "",
    cleanText(taskDecisionContext?.scope_binding)
      ? `scope_binding: ${cleanText(taskDecisionContext.scope_binding)}`
      : "",
    cleanText(taskDecisionContext?.aggregate_state)
      ? `aggregate_state: ${cleanText(taskDecisionContext.aggregate_state)}`
      : "",
    `counts: planned ${Number(counts?.planned || 0)}, in_progress ${Number(counts?.in_progress || 0)}, blocked ${Number(counts?.blocked || 0)}, done ${Number(counts?.done || 0)}`,
    focusedTask
      ? `當前優先 task：${cleanText(focusedTask?.title)}`
      : "",
    cleanText(taskDecisionContext?.focus_hint)
      ? cleanText(taskDecisionContext.focus_hint)
      : "",
    blockedTasks.length > 0
      ? `需主動提醒 blocked 風險：${blockedTasks.slice(0, 2).map((task) => cleanText(task?.title)).filter(Boolean).join("、")}`
      : "",
    inProgressTasks.length > 0
      ? `可提供進度摘要：${inProgressTasks.slice(0, 2).map((task) => cleanText(task?.title)).filter(Boolean).join("、")}`
      : "",
    referenceTasks.length > 0
      ? `優先引用未完成 task：${referenceTasks.slice(0, 3).map((task) => cleanText(task?.title)).filter(Boolean).join("、")}`
      : "",
    cleanText(taskDecisionContext?.next_step_hint)
      ? cleanText(taskDecisionContext.next_step_hint)
      : "",
    cleanText(taskDecisionContext?.unblock_question_hint)
      ? cleanText(taskDecisionContext.unblock_question_hint)
      : "",
  ].filter(Boolean).join("\n");
}

async function buildPlannerPrompt({ text, activeTask = null } = {}) {
  const memorySnapshot = getPlannerConversationMemoryLayer();
  const latestSummary = memorySnapshot?.latest_summary || null;
  const recentMessages = Array.isArray(memorySnapshot?.recent_messages) ? memorySnapshot.recent_messages : [];
  const plannerDocQueryContext = getPlannerDocQueryContext();
  const taskDecisionContext = await getPlannerTaskDecisionContext({
    activeDoc: plannerDocQueryContext?.activeDoc || null,
    activeTheme: plannerDocQueryContext?.activeTheme || "",
    userIntent: text,
  });
  const systemPrompt = buildCompactSystemPrompt("你是 executive planner，負責在多 agent 系統中為當前回合選擇最合適的 agent。", [
    "只輸出 JSON。",
    "不要輸出 Markdown、不要輸出程式碼區塊、不要補充 JSON 以外的說明。",
    "若當前訊息是延續上一個任務，優先 continue 或 handoff，不要重建新任務。",
    "agent_id 只能從提供的 registry 中選。",
    "只有在專業化真的會提升結果時才委派 specialist。",
    "如果一般回覆就夠，不要過度規劃。",
    "clarify 只在缺少關鍵資訊且真的阻塞下一步時才可使用。",
    "handoff 只在 next_agent_id 與目前主責 agent 不同且能明顯提升結果時才可使用。",
    "若 planner_task_context 有 focus_hint，優先沿用該 task，不要泛化成整體 snapshot。",
    "若 planner_task_context 顯示有 unfinished task，優先引用既有 task，不要忽略已存在的推進脈絡。",
    "若 planner_task_context 顯示有 blocked task，需主動把風險與 unblock 需求反映到決策理由。",
    "若 planner_task_context 顯示有 in_progress task，優先延續並利用現有進度摘要，不要重起平行任務。",
    "若 planner_task_context 已提供主動下一步，優先把它轉成 work_items，而不是只做被動 continue。",
    "明確區分 list、search、detail：列出文件是 list；查資料、找文件、搜尋內容是 search；查看某文件內容、讀某文檔是 detail/read。",
    "若使用者是在找資料、搜尋內容、查某個文檔，必須先嘗試對應 tool；不要未調 tool 就直接 fail-soft。",
    "若需要判斷找不到，前提必須是已經嘗試過對應 tool；禁止用純文字直接回答找不到。",
    "pending_questions 僅保留必要問題，使用短句，最多 4 條。",
    "work_items 僅保留必要工作項，每項必須有 agent_id、task、role，最多 8 條。",
  ]);

  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
    maxTokens: 900,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "planner_goal",
        label: "planner_goal",
        text: [
          "輸出單一合法 JSON 物件，不要有前後文。",
          '固定 shape：{"action":"start|continue|handoff|clarify","objective":"...","primary_agent_id":"...","next_agent_id":"...","supporting_agent_ids":["..."],"reason":"...","pending_questions":["..."],"work_items":[{"agent_id":"...","task":"...","role":"primary|supporting"}]}',
          "action 只能是 start、continue、handoff、clarify。",
          "objective 必須是當前回合的單一句任務目標，避免空泛描述。",
          "primary_agent_id、next_agent_id 必須來自 registry。",
          "若不需要 supporting agent，supporting_agent_ids 回傳空陣列。",
          "若不需要問題，pending_questions 回傳空陣列。",
          "若不需要工作項，work_items 回傳空陣列。",
          "若資訊不足但仍可繼續，不要選 clarify；優先 start 或 continue。",
          "若 planner_task_context 有 focus_hint，決策時先沿用該 task 與其文件/主題上下文。",
          "若 planner_task_context 有 unfinished_hint，決策時優先引用既有 task。",
          "若 planner_task_context 有 blocked_hint，reason 應明確反映 blocked 風險或 unblock 需求。",
          "若 planner_task_context 有 in_progress_hint，reason 應明確反映目前進度或延續中的工作。",
          "若 planner_task_context 有 next_step_hint，work_items 應主動帶出下一步執行。",
          "若 planner_task_context 有 unblock_question_hint，僅在真的缺資源時才把它放進 pending_questions。",
          "若使用者是要列出文件，應走 list 類能力；若是找資料、找文件、搜尋內容，應走 search 類能力；若是查看某文件內容、讀某文檔，應走 detail/read 類能力。",
          "不可把 list、search、detail 混用：list 不等於 search，search 不等於 detail。",
          "不可在未先嘗試對應 tool 的情況下，直接輸出找不到、無資料、或 fail-soft 停止。",
        ].join("\n"),
        required: true,
        maxTokens: 260,
      },
      {
        name: "agent_registry",
        label: "agent_registry",
        text: agentCatalogText(),
        required: true,
        maxTokens: 220,
      },
      {
        name: "latest_summary",
        label: "latest_summary",
        text: latestSummary ? trimTextForBudget(JSON.stringify(latestSummary, null, 2), 1100) : "none",
        summaryText: latestSummary ? trimTextForBudget(JSON.stringify(latestSummary, null, 2), 420) : "none",
        required: true,
        maxTokens: 160,
      },
      {
        name: "recent_dialogue",
        label: "recent_dialogue",
        text: recentMessages.length > 0
          ? recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n")
          : "none",
        summaryText: recentMessages.length > 0
          ? recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n")
          : "none",
        required: true,
        maxTokens: 120,
      },
      {
        name: "planner_task_context",
        label: "planner_task_context",
        text: trimTextForBudget(formatPlannerTaskDecisionPromptSection(taskDecisionContext), 900),
        summaryText: trimTextForBudget(formatPlannerTaskDecisionPromptSection(taskDecisionContext), 420),
        required: true,
        maxTokens: 180,
      },
      {
        name: "active_task",
        label: "active_task",
        text: activeTask ? trimTextForBudget(JSON.stringify(activeTask, null, 2), 900) : "none",
        summaryText: activeTask ? trimTextForBudget(JSON.stringify(activeTask, null, 2), 420) : "none",
        maxTokens: 220,
      },
      {
        name: "user_request",
        label: "user_request",
        text,
        required: true,
        maxTokens: 140,
      },
    ],
  });

  return {
    systemPrompt,
    prompt: governed.prompt,
    taskDecisionContext,
  };
}

function parsePlannerJson(text = "") {
  const normalized = String(text || "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("executive_planner_missing_json");
  }
  return JSON.parse(normalized.slice(start, end + 1));
}

function parseStrictPlannerUserInputJson(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    throw new Error("planner_user_input_non_json");
  }
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("planner_user_input_invalid_json_object");
  }
  return parsed;
}

export async function requestPlannerJson({
  systemPrompt,
  prompt,
  sessionIdSuffix = "executive-planner",
} = {}) {
  if (!llmApiKey) {
    return callOpenClawTextGeneration({
      systemPrompt,
      prompt,
      sessionIdSuffix,
    });
  }

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: llmTemperature,
      top_p: llmTopP,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `executive_planner_failed:${response.status}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function buildPlannerUserInputPrompt({ text = "" } = {}) {
  restorePlannerRuntimeContextFromSummary();
  const latestSummary = getPlannerConversationMemoryLayer()?.latest_summary || null;
  const recentMessages = (getPlannerConversationMemoryLayer()?.recent_messages || []).slice(-4);
  const docQueryContext = getPlannerDocQueryContext();
  const systemPrompt = buildCompactSystemPrompt("你是 Lobster user-input planner。", [
    "所有 user input 必須先被規劃成受控 planner action/preset，禁止直接回答問題。",
    "只輸出單一合法 JSON object，不要 Markdown、不要 code fence、不要前後文、不要多餘欄位。",
    '固定 shape：{"action":"...","params":{}}',
    "action 必須完全對應 target_catalog 裡的名稱。",
    "params 必須是 object，且需符合對應 contract 的 required params。",
    "如果已有 active_doc 或 active_candidates，優先利用那些 doc_id 做 detail/read 決策。",
    "看文件列表用 list，找資料用 search，讀某份文件內容才用 detail；不要混用。",
    "若無法安全決策，不要輸出自然語言說明。",
  ]);

  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
    maxTokens: 700,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "planner_goal",
        label: "planner_goal",
        text: [
          "輸出單一合法 JSON 物件，不要有前後文。",
          '唯一合法 shape：{"action":"...","params":{}}',
          "action 必須來自 target_catalog。",
          "params 只能放該 action/preset 需要的欄位。",
          "不可直接回答使用者問題，不可輸出 free text fallback。",
        ].join("\n"),
        required: true,
        maxTokens: 120,
      },
      {
        name: "target_catalog",
        label: "target_catalog",
        text: plannerDecisionCatalogText(),
        required: true,
        maxTokens: 220,
      },
      {
        name: "latest_summary",
        label: "latest_summary",
        text: latestSummary ? trimTextForBudget(JSON.stringify(latestSummary, null, 2), 900) : "none",
        summaryText: latestSummary ? trimTextForBudget(JSON.stringify(latestSummary, null, 2), 420) : "none",
        maxTokens: 110,
      },
      {
        name: "doc_query_context",
        label: "doc_query_context",
        text: trimTextForBudget(JSON.stringify(docQueryContext || {}, null, 2), 600),
        summaryText: trimTextForBudget(JSON.stringify(docQueryContext || {}, null, 2), 260),
        required: true,
        maxTokens: 90,
      },
      {
        name: "recent_dialogue",
        label: "recent_dialogue",
        text: recentMessages.length > 0
          ? recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n")
          : "none",
        summaryText: recentMessages.length > 0
          ? recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n")
          : "none",
        maxTokens: 80,
      },
      {
        name: "user_request",
        label: "user_request",
        text,
        required: true,
        maxTokens: 100,
      },
    ],
  });

  return {
    systemPrompt,
    prompt: governed.prompt,
  };
}

export async function planUserInputAction({ text = "", requester = requestPlannerJson } = {}) {
  restorePlannerRuntimeContextFromSummary();
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    reason: "pre_plan_user_input_action",
  });
  let promptInput = await buildPlannerUserInputPrompt({ text });
  let prompt = promptInput.prompt;
  let lastInvalidDecision = null;

  for (let attempt = 0; attempt <= llmJsonRetryMax; attempt += 1) {
    try {
      const raw = await requester({
        systemPrompt: promptInput.systemPrompt,
        prompt,
        sessionIdSuffix: cleanText(text).slice(0, 48) || "user-input-planner",
      });
      const parsed = parseStrictPlannerUserInputJson(raw);
      const validation = validatePlannerUserInputDecision(parsed);
      if (validation.ok) {
        const decision = {
          action: validation.action,
          params: validation.params,
        };
        recordPlannerConversationExchange({
          userQuery: text,
          plannerReply: JSON.stringify(decision),
        });
        maybeCompactPlannerConversationMemory({
          flows: buildPlannerFlowSnapshots(plannerFlows),
          latestSelectedAction: decision.action,
          reason: "post_plan_user_input_action",
        });
        return decision;
      }

      if (validation.error === "invalid_action" || validation.error === "contract_violation") {
        lastInvalidDecision = validation;
        break;
      }
    } catch {
      // Continue into the bounded retry path below.
    }

    if (attempt >= llmJsonRetryMax) {
      break;
    }
    promptInput = await buildPlannerUserInputPrompt({
      text: `${text}\n請只輸出合法 JSON，且僅能使用 target_catalog 的 action。`,
    });
    prompt = promptInput.prompt;
  }

  const errorResult = lastInvalidDecision
    ? {
        error: lastInvalidDecision.error,
        action: lastInvalidDecision.action,
        params: lastInvalidDecision.params,
        ...(lastInvalidDecision.violations ? { violations: lastInvalidDecision.violations } : {}),
      }
    : { error: "planner_failed" };

  recordPlannerConversationExchange({
    userQuery: text,
    plannerReply: JSON.stringify(errorResult),
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    reason: "post_plan_user_input_action_failed",
  });
  return errorResult;
}

export async function executePlannedUserInput({
  text = "",
  requester = requestPlannerJson,
  logger = console,
  contentReader,
  baseUrl = oauthBaseUrl,
} = {}) {
  const decision = await planUserInputAction({ text, requester });
  if (decision?.error) {
    return {
      ok: false,
      ...decision,
      execution_result: null,
      trace_id: null,
    };
  }

  const runtimeResult = await runPlannerToolFlow({
    userIntent: text,
    payload: decision.params,
    logger,
    contentReader,
    baseUrl,
    forcedSelection: {
      selected_action: decision.action,
      reason: "strict_user_input_planner",
    },
    disableAutoRouting: true,
  });

  return {
    ok: runtimeResult?.execution_result?.ok === true,
    action: decision.action,
    params: decision.params,
    error: cleanText(runtimeResult?.execution_result?.error || "") || null,
    execution_result: runtimeResult?.execution_result || null,
    trace_id: runtimeResult?.trace_id || null,
  };
}

export function buildPlannedUserInputEnvelope(result = {}) {
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      error: "planner_failed",
      trace_id: null,
    };
  }

  if (result.error && !result.execution_result) {
    return {
      ok: false,
      error: cleanText(result.error || "") || "planner_failed",
      ...(cleanText(result.action || "") ? { action: cleanText(result.action) } : {}),
      params: normalizePlannerPayload(result.params),
      ...(Array.isArray(result.violations) ? { violations: result.violations } : {}),
      trace_id: result.trace_id || null,
    };
  }

  return {
    ok: result.ok === true,
    action: cleanText(result.action || "") || null,
    params: normalizePlannerPayload(result.params),
    error: cleanText(result.error || "") || null,
    execution_result: result.execution_result?.formatted_output || result.execution_result || null,
    trace_id: result.trace_id || null,
  };
}

function normalizePlannerDecision(decision = {}, fallbackText = "") {
  const primaryAgentId = cleanText(decision.primary_agent_id || decision.primary_agent || "");
  const nextAgentId = cleanText(decision.next_agent_id || decision.next_agent || primaryAgentId);
  return {
    action: cleanText(decision.action || "continue") || "continue",
    objective: cleanText(decision.objective || fallbackText),
    primary_agent_id: getRegisteredAgent(primaryAgentId) ? primaryAgentId : "generalist",
    next_agent_id: getRegisteredAgent(nextAgentId) ? nextAgentId : getRegisteredAgent(primaryAgentId) ? primaryAgentId : "generalist",
    supporting_agent_ids: (Array.isArray(decision.supporting_agent_ids) ? decision.supporting_agent_ids : [])
      .map((item) => cleanText(item))
      .filter((item) => getRegisteredAgent(item)),
    reason: cleanText(decision.reason || ""),
    pending_questions: Array.isArray(decision.pending_questions)
      ? decision.pending_questions.map((item) => cleanText(item)).filter(Boolean).slice(0, 4)
      : [],
    work_items: (Array.isArray(decision.work_items) ? decision.work_items : [])
      .map((item) => ({
        agent_id: cleanText(item?.agent_id || item?.agent || ""),
        task: cleanText(item?.task || ""),
        role: cleanText(item?.role || ""),
        status: "pending",
      }))
      .filter((item) => getRegisteredAgent(item.agent_id) && item.task)
      .slice(0, 8),
  };
}

function enrichPlannerDecisionWithTaskDriving(decision = {}, {
  taskDecisionContext = null,
} = {}) {
  const taskDriving = taskDecisionContext?.task_driving;
  if (!taskDriving || typeof taskDriving !== "object") {
    return decision;
  }

  const normalizedDecision = decision && typeof decision === "object"
    ? {
        ...decision,
        pending_questions: Array.isArray(decision.pending_questions) ? [...decision.pending_questions] : [],
        work_items: Array.isArray(decision.work_items) ? [...decision.work_items] : [],
      }
    : {
        pending_questions: [],
        work_items: [],
      };

  if (normalizedDecision.work_items.length === 0 && cleanText(taskDriving?.suggested_next_step)) {
    const agentId = getRegisteredAgent(cleanText(normalizedDecision.next_agent_id || ""))
      ? cleanText(normalizedDecision.next_agent_id)
      : getRegisteredAgent(cleanText(normalizedDecision.primary_agent_id || ""))
        ? cleanText(normalizedDecision.primary_agent_id)
        : "generalist";
    normalizedDecision.work_items = [{
      agent_id: agentId,
      task: cleanText(taskDriving.suggested_next_step),
      role: "primary",
      status: "pending",
    }];
  }

  if (normalizedDecision.pending_questions.length === 0 && cleanText(taskDriving?.suggested_question)) {
    normalizedDecision.pending_questions = [cleanText(taskDriving.suggested_question)];
  }

  if (!cleanText(normalizedDecision.reason) && cleanText(taskDriving?.suggested_next_step)) {
    normalizedDecision.reason = taskDriving.mode === "unblock"
      ? `延續既有 task，優先解除阻塞：${cleanText(taskDriving?.task?.title) || "未命名 task"}`
      : taskDriving.mode === "continue"
        ? `延續既有 task，推進下一個可執行動作：${cleanText(taskDriving?.task?.title) || "未命名 task"}`
        : `延續既有 task，主動推進下一步：${cleanText(taskDriving?.task?.title) || "未命名 task"}`;
  }

  return normalizedDecision;
}

export async function planExecutiveTurn({ text = "", activeTask = null, requester = requestPlannerJson } = {}) {
  restorePlannerRuntimeContextFromSummary();
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    reason: "pre_plan_executive_turn",
  });
  const promptInput = await buildPlannerPrompt({ text, activeTask });
  let prompt = promptInput.prompt;

  for (let attempt = 0; attempt <= llmJsonRetryMax; attempt += 1) {
    try {
      const raw = await requester({
        systemPrompt: promptInput.systemPrompt,
        prompt,
        sessionIdSuffix: cleanText(activeTask?.id || text).slice(0, 48) || "executive-planner",
      });
      const normalizedDecision = enrichPlannerDecisionWithTaskDriving(
        normalizePlannerDecision(parsePlannerJson(raw), text),
        {
          taskDecisionContext: promptInput.taskDecisionContext,
        },
      );
      recordPlannerConversationExchange({
        userQuery: text,
        plannerReply: JSON.stringify({
          action: normalizedDecision.action,
          primary_agent_id: normalizedDecision.primary_agent_id,
          next_agent_id: normalizedDecision.next_agent_id,
          reason: normalizedDecision.reason,
        }),
      });
      maybeCompactPlannerConversationMemory({
        flows: buildPlannerFlowSnapshots(plannerFlows),
        unfinishedItems: normalizedDecision.pending_questions.map((question) => ({
          type: "pending_question",
          label: question,
        })),
        latestSelectedAction: normalizedDecision.action,
        reason: "post_plan_executive_turn",
      });
      return normalizedDecision;
    } catch {
      if (attempt >= llmJsonRetryMax) {
        break;
      }
      prompt = (await buildPlannerPrompt({ text: `${text}\n請只輸出合法 JSON。`, activeTask })).prompt;
    }
  }

  const fallbackDecision = enrichPlannerDecisionWithTaskDriving(
    heuristicPlanExecutiveTurn(text, activeTask),
    {
      taskDecisionContext: promptInput.taskDecisionContext,
    },
  );
  recordPlannerConversationExchange({
    userQuery: text,
    plannerReply: JSON.stringify({
      action: fallbackDecision.action,
      primary_agent_id: fallbackDecision.primary_agent_id,
      next_agent_id: fallbackDecision.next_agent_id,
      reason: fallbackDecision.reason,
    }),
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows),
    unfinishedItems: fallbackDecision.pending_questions.map((question) => ({
      type: "pending_question",
      label: question,
    })),
    latestSelectedAction: fallbackDecision.action,
    reason: "post_plan_executive_turn_fallback",
  });
  return fallbackDecision;
}
