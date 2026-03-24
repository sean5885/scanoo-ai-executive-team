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
import {
  buildCompactSystemPrompt,
  compactListItems,
  governPromptSections,
  trimTextForBudget,
} from "./agent-token-governance.mjs";
import { getRegisteredAgent, listRegisteredAgents, parseRegisteredAgentCommand } from "./agent-registry.mjs";
import {
  buildExplicitUserAuthHeaders,
  normalizeExplicitUserAuthContext,
} from "./explicit-user-auth.mjs";
import { getDocumentCreateGovernanceContract } from "./lark-write-guard.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import { FALLBACK_DISABLED, INVALID_ACTION, ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { hasDocSearchIntent, hasScopedDocExclusionSearchIntent } from "./router.js";
import { createRequestId, emitRateLimitedAlert, emitToolExecutionLog } from "./runtime-observability.mjs";
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
import { executeAgent } from "./planner/agent-executor.mjs";
import { runAgentExecution } from "./planner/agent-runtime.mjs";
import {
  buildPlannerLifecycleUnfinishedItems,
  getLatestPlannerTaskLifecycleSnapshot,
  getPlannerTaskDecisionContext,
  handlePlannerPendingItemAction,
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

const EXECUTIVE_MAX_ROLES = 3;
const EXECUTIVE_MAX_SUPPORTING_ROLES = EXECUTIVE_MAX_ROLES - 1;
const PLANNER_CONTEXT_WINDOW_MAX_CHARS = 2400;
const PLANNER_CONTEXT_WINDOW_SUMMARY_MAX_CHARS = 640;
const PLANNER_RECENT_STEP_LIMIT = 6;
const PLANNER_HIGH_WEIGHT_DOC_LIMIT = 3;
const PLANNER_FAILED_ALERT_KEY = "planner_failed:user_input_planner";
const PLANNER_EXPLICIT_AUTH_ACTIONS = new Set([
  "list_company_brain_docs",
  "search_company_brain_docs",
  "get_company_brain_doc_detail",
]);

const executiveCollaborationSignals = [
  "各個 agent",
  "各个 agent",
  "多 agent",
  "多個 agent",
  "多个 agent",
  "multi-agent",
  "協作",
  "协作",
  "一起看",
  "一起評估",
  "一起评估",
  "一起拆解",
  "分別看",
  "分别看",
  "統一收斂",
  "统一收敛",
];

const executiveCompoundSignals = [
  "同時",
  "同时",
  "以及",
  "並且",
  "并且",
  "還有",
  "还有",
  "最後",
  "最后",
];

const executiveDeterministicRoleSignals = [
  {
    agentId: "consult",
    keywords: ["拆解", "比較", "比较", "診斷", "诊断", "方案"],
  },
  {
    agentId: "product",
    keywords: ["產品", "产品", "需求", "使用者", "用户", "功能", "價值", "价值"],
  },
  {
    agentId: "tech",
    keywords: ["技術", "技术", "工程", "架構", "架构", "系統設計", "系统设计", "程式", "代码", "api"],
  },
  {
    agentId: "cmo",
    keywords: ["市場", "市场", "定位", "訊息", "信息", "行銷", "营销", "growth", "gtm"],
  },
  {
    agentId: "ops",
    keywords: ["營運", "运营", "流程", "落地", "執行", "执行", "sop"],
  },
  {
    agentId: "cdo",
    keywords: ["數據", "数据", "治理", "指標", "指标", "分配", "分類", "分类"],
  },
  {
    agentId: "delivery",
    keywords: ["交付", "驗收", "验收", "導入", "导入", "里程碑"],
  },
  {
    agentId: "prd",
    keywords: ["prd", "規格", "规格", "spec"],
  },
  {
    agentId: "ceo",
    keywords: ["決策", "决策", "拍板", "取捨", "取舍", "資源", "资源"],
  },
];

const executiveSelectableAgentIds = [
  "generalist",
  "ceo",
  "product",
  "prd",
  "cmo",
  "consult",
  "cdo",
  "delivery",
  "ops",
  "tech",
];

function emitPlannerFailedAlert({ text = "", reason = "", source = "planner" } = {}) {
  const textHint = cleanText(text);
  emitRateLimitedAlert({
    code: "planner_failed",
    scope: source,
    dedupeKey: PLANNER_FAILED_ALERT_KEY,
    message: "Planner failed to produce a valid strict JSON decision.",
    details: {
      reason: cleanText(reason) || null,
      text_hint: textHint ? textHint.slice(0, 160) : null,
    },
  });
}

function actionRequiresExplicitUserAuth(action = "") {
  return PLANNER_EXPLICIT_AUTH_ACTIONS.has(cleanText(action));
}

function normalizePlannerAuthContext(authContext = null) {
  return normalizeExplicitUserAuthContext(authContext);
}

// ---------------------------------------------------------------------------
// Executive intent helpers
// ---------------------------------------------------------------------------

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function looksLikeUnsupportedSlashPlannerRequest(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  if (!normalized || !normalized.startsWith("/")) {
    return false;
  }
  return !parseRegisteredAgentCommand(normalized);
}

function looksLikeMissingAgentPlannerRequest(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  if (!normalized || !normalized.includes("agent")) {
    return false;
  }
  return /(不存在|不存在的|沒有這個|没有这个|unknown|invalid|not exist)/i.test(normalized);
}
function uniqueRegisteredAgentIds(agentIds = [], maxItems = EXECUTIVE_MAX_ROLES) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(agentIds) ? agentIds : []) {
    const agentId = cleanText(item);
    if (!agentId || !getRegisteredAgent(agentId) || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    result.push(agentId);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function findFirstKeywordIndex(text = "", keywords = []) {
  let matchIndex = Number.POSITIVE_INFINITY;
  for (const keyword of Array.isArray(keywords) ? keywords : []) {
    const index = text.indexOf(keyword);
    if (index >= 0 && index < matchIndex) {
      matchIndex = index;
    }
  }
  return Number.isFinite(matchIndex) ? matchIndex : -1;
}

function findExplicitAgentMentionIndex(text = "", agentId = "") {
  const normalizedAgentId = cleanText(agentId);
  if (!text || !normalizedAgentId) {
    return -1;
  }
  const slashIndex = text.indexOf(`/${normalizedAgentId}`);
  if (slashIndex >= 0) {
    return slashIndex;
  }
  if (/^[a-z_]+$/.test(normalizedAgentId)) {
    const pattern = new RegExp(`(^|[^a-z0-9_])${normalizedAgentId}(?=$|[^a-z0-9_])`, "i");
    const match = pattern.exec(text);
    return match ? Number(match.index || 0) + match[1].length : -1;
  }
  return text.indexOf(normalizedAgentId);
}

function collectExplicitExecutiveAgentIds(text = "") {
  const matches = executiveSelectableAgentIds
    .map((agentId, order) => ({
      agentId,
      order,
      index: findExplicitAgentMentionIndex(text, agentId),
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || left.order - right.order)
    .map((item) => item.agentId);
  return uniqueRegisteredAgentIds(matches, EXECUTIVE_MAX_ROLES);
}

function detectDeterministicSpecialistAgentIds(text = "") {
  const matches = executiveDeterministicRoleSignals
    .map((rule, order) => ({
      agentId: rule.agentId,
      order,
      index: findFirstKeywordIndex(text, rule.keywords),
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || left.order - right.order)
    .map((item) => item.agentId);
  return uniqueRegisteredAgentIds(matches, EXECUTIVE_MAX_ROLES);
}

function hasExecutiveCompoundIntent(text = "") {
  return hasAny(text, executiveCollaborationSignals) || hasAny(text, executiveCompoundSignals);
}

function limitExecutiveWorkItems(workItems = [], {
  allowedAgentIds = [],
  maxItems = EXECUTIVE_MAX_ROLES,
} = {}) {
  const allowed = new Set(uniqueRegisteredAgentIds(allowedAgentIds, EXECUTIVE_MAX_ROLES));
  const result = [];
  const seen = new Set();

  for (const item of Array.isArray(workItems) ? workItems : []) {
    const agentId = cleanText(item?.agent_id || item?.agent || "");
    const task = cleanText(item?.task || "");
    if (!agentId || !task || seen.has(agentId) || (allowed.size > 0 && !allowed.has(agentId))) {
      continue;
    }
    seen.add(agentId);
    result.push({
      agent_id: agentId,
      task,
      role: cleanText(item?.role || ""),
      status: "pending",
    });
    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function buildSingleAgentWorkItems({
  primaryAgentId = "",
  objective = "",
  existingWorkItems = [],
} = {}) {
  const normalizedPrimaryAgentId = cleanText(primaryAgentId) || "generalist";
  const keptItems = limitExecutiveWorkItems(existingWorkItems, {
    allowedAgentIds: [normalizedPrimaryAgentId],
    maxItems: 1,
  }).map((item) => ({
    ...item,
    role: "primary",
    status: "pending",
  }));

  if (keptItems.length > 0) {
    return keptItems;
  }

  const task = normalizedPrimaryAgentId === "generalist"
    ? `主責收斂這個任務：${cleanText(objective)}`
    : `從 /${normalizedPrimaryAgentId} 的專責角度處理：${cleanText(objective)}`;

  return task
    ? [{
        agent_id: normalizedPrimaryAgentId,
        task,
        role: "primary",
        status: "pending",
      }]
    : [];
}

function trimExecutiveDecisionRoleCounts(decision = {}) {
  const primaryAgentId = getRegisteredAgent(cleanText(decision.primary_agent_id || ""))
    ? cleanText(decision.primary_agent_id)
    : "generalist";
  const supportingAgentIds = uniqueRegisteredAgentIds(
    (Array.isArray(decision.supporting_agent_ids) ? decision.supporting_agent_ids : [])
      .map((item) => cleanText(item))
      .filter((item) => item && item !== primaryAgentId),
    EXECUTIVE_MAX_SUPPORTING_ROLES,
  );
  const allowedAgentIds = [primaryAgentId, ...supportingAgentIds];

  return {
    ...decision,
    primary_agent_id: primaryAgentId,
    next_agent_id: getRegisteredAgent(cleanText(decision.next_agent_id || ""))
      ? cleanText(decision.next_agent_id)
      : primaryAgentId,
    supporting_agent_ids: supportingAgentIds,
    work_items: limitExecutiveWorkItems(decision.work_items, {
      allowedAgentIds,
      maxItems: EXECUTIVE_MAX_ROLES,
    }),
  };
}

function formatExecutiveAgentLabels(agentIds = []) {
  return uniqueRegisteredAgentIds(agentIds, EXECUTIVE_MAX_ROLES)
    .map((agentId) => `/${agentId}`)
    .join("、");
}

function buildDeterministicExecutiveSelectionReason({
  mode = "",
  primaryAgentId = "",
  supportingAgentIds = [],
} = {}) {
  const primaryLabel = formatExecutiveAgentLabels([primaryAgentId]) || "/generalist";
  const supportingLabels = formatExecutiveAgentLabels(supportingAgentIds);

  if (mode === "compound") {
    return supportingLabels
      ? `複合請求命中 distinct specialist 需求，改由 ${primaryLabel} 主責，並補充 ${supportingLabels}。`
      : `複合請求命中 distinct specialist 需求，改由 ${primaryLabel} 主責收斂。`;
  }

  if (mode === "explicit") {
    return `使用者明確指定 ${primaryLabel}，不擴張額外 specialist。`;
  }

  return `簡單單一意圖請求，維持由 ${primaryLabel} 單一處理。`;
}

function didExecutiveSelectionChange(originalDecision = {}, nextDecision = {}) {
  const originalSupporting = uniqueRegisteredAgentIds(
    originalDecision.supporting_agent_ids,
    EXECUTIVE_MAX_SUPPORTING_ROLES,
  );
  const nextSupporting = uniqueRegisteredAgentIds(
    nextDecision.supporting_agent_ids,
    EXECUTIVE_MAX_SUPPORTING_ROLES,
  );

  return (
    cleanText(originalDecision.primary_agent_id || "") !== cleanText(nextDecision.primary_agent_id || "")
    || cleanText(originalDecision.next_agent_id || "") !== cleanText(nextDecision.next_agent_id || "")
    || JSON.stringify(originalSupporting) !== JSON.stringify(nextSupporting)
  );
}

function resolveExecutiveSelectionReason({
  originalDecision = {},
  nextDecision = {},
  deterministicReason = "",
} = {}) {
  const normalizedDeterministicReason = cleanText(deterministicReason);
  if (didExecutiveSelectionChange(originalDecision, nextDecision)) {
    return normalizedDeterministicReason;
  }
  return cleanText(originalDecision.reason);
}
function applyDeterministicExecutiveAgentSelection(decision = {}, fallbackText = "", activeTask = null) {
  const normalizedText = cleanText(String(fallbackText || "").toLowerCase());
  const normalizedDecision = trimExecutiveDecisionRoleCounts(decision);
  if (!normalizedText) {
    return normalizedDecision;
  }

  const explicitAgentIds = collectExplicitExecutiveAgentIds(normalizedText)
    .filter((agentId) => agentId !== "generalist");
  const hasSelectionOverride = explicitAgentIds.length > 0 || hasExecutiveCompoundIntent(normalizedText);

  if (activeTask?.id && !hasSelectionOverride) {
    return normalizedDecision;
  }

  const detectedAgentIds = uniqueRegisteredAgentIds([
    ...explicitAgentIds,
    ...detectDeterministicSpecialistAgentIds(normalizedText),
  ], EXECUTIVE_MAX_ROLES);
  const objective = cleanText(normalizedDecision.objective || fallbackText);
  const shouldSeedSingleRoleWorkItems = normalizedDecision.work_items.length > 0
    || normalizedDecision.action === "start"
    || normalizedDecision.action === "handoff";
  const singleRoleFallbackReason = normalizedDecision.action === "start" || normalizedDecision.action === "handoff";

  if (hasExecutiveCompoundIntent(normalizedText) && detectedAgentIds.length >= 2) {
    const primaryAgentId = explicitAgentIds[0] || "generalist";
    const supportingAgentIds = uniqueRegisteredAgentIds(
      detectedAgentIds.filter((agentId) => agentId !== primaryAgentId),
      EXECUTIVE_MAX_SUPPORTING_ROLES,
    );
    const nextDecision = trimExecutiveDecisionRoleCounts({
      ...normalizedDecision,
      primary_agent_id: primaryAgentId,
      next_agent_id: primaryAgentId,
      supporting_agent_ids: supportingAgentIds,
      work_items: buildCollaborativeWorkItems({
        primaryAgentId,
        supportingAgentIds,
        objective,
      }),
    });
    return {
      ...nextDecision,
      reason: resolveExecutiveSelectionReason({
        originalDecision: normalizedDecision,
        nextDecision,
        deterministicReason: buildDeterministicExecutiveSelectionReason({
          mode: "compound",
          primaryAgentId,
          supportingAgentIds,
        }),
      }),
    };
  }

  if (explicitAgentIds.length > 0) {
    const primaryAgentId = explicitAgentIds[0];
    const nextDecision = trimExecutiveDecisionRoleCounts({
      ...normalizedDecision,
      primary_agent_id: primaryAgentId,
      next_agent_id: primaryAgentId,
      supporting_agent_ids: [],
      work_items: shouldSeedSingleRoleWorkItems
        ? buildSingleAgentWorkItems({
            primaryAgentId,
            objective,
            existingWorkItems: normalizedDecision.work_items,
          })
        : [],
    });
    return {
      ...nextDecision,
      reason: resolveExecutiveSelectionReason({
        originalDecision: normalizedDecision,
        nextDecision,
        deterministicReason: buildDeterministicExecutiveSelectionReason({
          mode: "explicit",
          primaryAgentId,
        }),
      }),
    };
  }

  const nextDecision = trimExecutiveDecisionRoleCounts({
    ...normalizedDecision,
    primary_agent_id: "generalist",
    next_agent_id: "generalist",
    supporting_agent_ids: [],
    work_items: shouldSeedSingleRoleWorkItems
      ? buildSingleAgentWorkItems({
          primaryAgentId: "generalist",
          objective,
          existingWorkItems: normalizedDecision.work_items,
        })
      : [],
  });
  return {
    ...nextDecision,
    reason: resolveExecutiveSelectionReason({
      originalDecision: normalizedDecision,
      nextDecision,
      deterministicReason: buildDeterministicExecutiveSelectionReason({
        mode: singleRoleFallbackReason ? "single_start" : "single_continue",
        primaryAgentId: "generalist",
      }),
    }),
  };
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
    if (result.length >= EXECUTIVE_MAX_ROLES) {
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

  for (const agentId of supportingAgentIds.slice(0, EXECUTIVE_MAX_SUPPORTING_ROLES)) {
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

function normalizePublicPlannerErrorCode(error = "") {
  const normalizedError = cleanText(error);
  if (normalizedError === INVALID_ACTION) {
    return "invalid_action";
  }
  return normalizedError;
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
      "runtime status",
      "db path",
      "pid",
      "cwd",
      "service start",
      "service_start",
      "穩不穩",
      "風險",
      "運行情況",
      "系統狀態",
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

function buildPlannerFlowSnapshots(flows = plannerFlows, { sessionKey = "" } = {}) {
  return Array.isArray(flows)
    ? flows.map((flow) => ({
        id: cleanText(flow?.id || "") || null,
        priority: Number.isFinite(flow?.priority) ? Number(flow.priority) : 0,
        context: flow?.readContext?.({ sessionKey }) || {},
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

function normalizePlannerUserFacingList(items = []) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => cleanText(item))
      .filter(Boolean),
  )];
}

function buildPlannerUserFacingAnswer({
  error = "",
  fallbackReason = "",
} = {}) {
  const normalizedError = cleanText(error);
  const normalizedFallbackReason = cleanText(fallbackReason);

  if (normalizedError === "missing_user_access_token") {
    return "這次我先不直接查文件，因為目前這條文件路徑是 auth-required，而這輪請求沒有帶到可驗證的 Lark 使用者授權。";
  }
  if (normalizedError === "oauth_reauth_required") {
    return "這次我先不直接查文件，因為目前這條文件路徑是 auth-required，而現有的 Lark 使用者授權已失效，需要重新登入授權。";
  }
  if (normalizedError === "semantic_mismatch") {
    return "我先沒有直接執行原本那個內部動作，因為它和你這輪的需求不一致。";
  }
  if (
    normalizedError === "routing_error"
    || normalizedFallbackReason === "routing_error"
    || normalizedFallbackReason === "routing_no_match"
    || normalizedFallbackReason === ROUTING_NO_MATCH
  ) {
    return "我這次沒有找到可以安全執行的受控操作，所以先用自然語言接住這個請求。";
  }
  if (normalizedError === "invalid_action" || normalizedError === INVALID_ACTION) {
    return "我這次沒有採用那個內部動作，因為它不在目前允許直接執行的受控範圍內。";
  }
  if (normalizedError === "request_timeout") {
    return "這次處理逾時了，我還沒有拿到可以安全交付的結果。";
  }
  if (normalizedError === "request_cancelled") {
    return "這次處理被中斷了，所以我先不回傳不完整結果。";
  }
  if (normalizedError === "business_error") {
    return "這次操作沒有安全完成，所以我先用人話說明目前狀態。";
  }
  return "這次沒有拿到可以直接交付的安全結果，所以我先用自然語言說明目前狀態。";
}

function buildPlannerUserFacingLimitations({
  error = "",
  fallbackReason = "",
  action = "",
} = {}) {
  const normalizedError = cleanText(error);
  const normalizedFallbackReason = cleanText(fallbackReason);
  const normalizedAction = cleanText(action);

  if (normalizedError === "missing_user_access_token") {
    return normalizePlannerUserFacingList([
      "目前文件搜尋/閱讀路徑是明確的 auth-required 邊界，必須帶使用者 token，不能再默默改用本地 stored token 或空結果。",
      "請從有帶授權的 Lark 對話重新送出這輪需求，或先完成登入授權。",
    ]);
  }
  if (normalizedError === "oauth_reauth_required") {
    return normalizePlannerUserFacingList([
      "目前文件搜尋/閱讀路徑仍在 auth-required 邊界內，不會在授權失效時偷偷退回其他 token 或空結果。",
      `請先重新登入授權：${oauthBaseUrl}/oauth/lark/login`,
    ]);
  }
  if (normalizedError === "semantic_mismatch") {
    return normalizePlannerUserFacingList([
      "系統已先嘗試改走較合理的 reroute；如果仍然沒命中，就不會把內部錯誤直接丟給你。",
      "如果你是要找文件、看文件內容、查 runtime 或建立文件，可以直接把目標說得更明確一點。",
    ]);
  }
  if (
    normalizedError === "routing_error"
    || normalizedFallbackReason === "routing_error"
    || normalizedFallbackReason === "routing_no_match"
    || normalizedFallbackReason === ROUTING_NO_MATCH
  ) {
    return normalizePlannerUserFacingList([
      "目前這條受控路徑主要支援文件查找、文件閱讀、runtime 查詢與部分文件建立流程。",
      "這次沒有把 internal routing reason、error code 或 trace 直接暴露到對外回覆。",
    ]);
  }
  if (normalizedError === "invalid_action" || normalizedError === INVALID_ACTION) {
    return normalizePlannerUserFacingList([
      normalizedAction ? `內部動作 ${normalizedAction} 不會直接暴露給使用者。` : "這類 internal action 不會直接暴露給使用者。",
      "請直接描述你要完成的事，系統會再走受控 action 選擇。",
    ]);
  }
  if (normalizedError === "request_timeout") {
    return normalizePlannerUserFacingList([
      "詳細 trace 仍保留在 runtime 與 logs，但不會直接出現在對外回覆。",
      "可以稍後重試，或把需求再縮小一點。",
    ]);
  }
  if (normalizedError === "request_cancelled") {
    return normalizePlannerUserFacingList([
      "這次請求在完成前被取消，所以沒有可安全交付的最終結果。",
    ]);
  }
  return normalizePlannerUserFacingList([
    "詳細 internal trace 仍保留在 runtime 與 logs，但不會直接出現在對外回覆。",
  ]);
}

export function renderPlannerUserFacingReplyText({
  answer = "",
  sources = [],
  limitations = [],
} = {}) {
  const normalizedSources = normalizePlannerUserFacingList(sources);
  const normalizedLimitations = normalizePlannerUserFacingList(limitations);

  return [
    "結論",
    cleanText(answer) || "目前沒有可直接交付的結果。",
    "",
    "重點",
    ...(normalizedSources.length > 0 ? normalizedSources.map((item) => `- ${item}`) : ["- 目前沒有足夠已驗證來源可補更多重點。"]),
    "",
    "下一步",
    ...(normalizedLimitations.length > 0 ? normalizedLimitations.map((item) => `- ${item}`) : ["- 目前沒有更具體的下一步。"]),
  ].join("\n");
}

export function buildPlannedUserInputUserFacingReply(result = {}) {
  const envelope = buildPlannedUserInputEnvelope(result);
  const executionError = cleanText(envelope?.execution_result?.error || "");
  const topLevelError = cleanText(envelope?.error || "");
  const errorCode = executionError || topLevelError;

  if (!errorCode) {
    return null;
  }

  const fallbackReason = cleanText(
    envelope?.trace?.fallback_reason
    || envelope?.execution_result?.data?.reason
    || envelope?.execution_result?.data?.routing_reason
    || errorCode,
  ) || errorCode;

  return {
    ok: false,
    answer: buildPlannerUserFacingAnswer({
      error: errorCode,
      fallbackReason,
    }),
    sources: [],
    limitations: buildPlannerUserFacingLimitations({
      error: errorCode,
      fallbackReason,
      action: envelope?.action || envelope?.trace?.chosen_action || "",
    }),
  };
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
  sessionKey = "",
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
  ], { sessionKey });
}

function hasPlannerDocQueryRuntimeContext(context = {}) {
  return Boolean(
    cleanText(context?.activeDoc?.doc_id)
    || cleanText(context?.activeTheme)
    || (Array.isArray(context?.activeCandidates) && context.activeCandidates.length > 0)
  );
}

function restorePlannerRuntimeContextFromSummary({ sessionKey = "" } = {}) {
  const currentDocQueryContext = getPlannerDocQueryContext({ sessionKey });
  if (hasPlannerDocQueryRuntimeContext(currentDocQueryContext)) {
    return currentDocQueryContext;
  }

  const latestSummary = getPlannerConversationMemoryLayer({ sessionKey })?.latest_summary;
  if (!latestSummary || typeof latestSummary !== "object") {
    return currentDocQueryContext;
  }

  return hydratePlannerDocQueryRuntimeContext({
    activeDoc: latestSummary.active_doc,
    activeCandidates: latestSummary.active_candidates,
    activeTheme: latestSummary.active_theme,
    sessionKey,
  });
}

restorePlannerRuntimeContextFromSummary();

export function getPlannerConversationMemory({ sessionKey = "" } = {}) {
  return getPlannerConversationMemoryLayer({ sessionKey });
}

export function compactPlannerConversationMemory({
  logger = console,
  reason = "manual",
  unfinishedItems = [],
  latestSelectedAction = "",
  latestTraceId = null,
  sessionKey = "",
} = {}) {
  restorePlannerRuntimeContextFromSummary({ sessionKey });
  return compactPlannerConversationMemoryLayer({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    unfinishedItems,
    latestSelectedAction,
    latestTraceId,
    logger,
    reason,
    sessionKey,
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

function normalizePlannerAbortCode(value = "") {
  const normalized = cleanText(value);
  if (normalized === "request_timeout" || normalized === "request_cancelled") {
    return normalized;
  }
  return "request_cancelled";
}

function isPlannerAbortCode(value = "") {
  const normalized = cleanText(value);
  return normalized === "request_timeout" || normalized === "request_cancelled";
}

function derivePlannerAbortInfo({
  signal = null,
  error = null,
} = {}) {
  const source = signal?.aborted ? signal.reason || error : error;
  if (!source && !signal?.aborted) {
    return null;
  }

  const codeCandidate = cleanText(source?.code || error?.code || "");
  const nameCandidate = cleanText(source?.name || error?.name || "");
  if (!signal?.aborted && !isPlannerAbortCode(codeCandidate) && nameCandidate !== "AbortError") {
    return null;
  }

  const code = normalizePlannerAbortCode(codeCandidate || (signal?.aborted ? "request_cancelled" : ""));
  const timeoutMs = Number.isFinite(Number(source?.timeout_ms))
    ? Number(source.timeout_ms)
    : Number.isFinite(Number(error?.timeout_ms))
      ? Number(error.timeout_ms)
      : null;
  const message = cleanText(source?.message || error?.message || "")
    || (code === "request_timeout"
      ? "Request timed out before completion."
      : "Request was cancelled before completion.");

  return {
    code,
    message,
    timeout_ms: timeoutMs,
  };
}

function throwIfPlannerSignalAborted(signal) {
  const abortInfo = derivePlannerAbortInfo({ signal });
  if (!abortInfo) {
    return;
  }
  const error = new Error(abortInfo.message);
  error.name = "AbortError";
  error.code = abortInfo.code;
  if (abortInfo.timeout_ms != null) {
    error.timeout_ms = abortInfo.timeout_ms;
  }
  throw error;
}

function buildPlannerAbortResult({
  action = "",
  preset = "",
  signal = null,
  error = null,
  traceId = null,
} = {}) {
  const abortInfo = derivePlannerAbortInfo({ signal, error });
  if (!abortInfo) {
    return null;
  }

  return buildPlannerStoppedResult({
    action,
    preset,
    error: abortInfo.code,
    data: {
      message: abortInfo.message,
      aborted: true,
      ...(abortInfo.timeout_ms != null ? { timeout_ms: abortInfo.timeout_ms } : {}),
    },
    traceId: traceId || null,
    stopReason: abortInfo.code,
  });
}

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
  [INVALID_ACTION]: {
    self_heal: 0,
    retry: 0,
    stop_reason: INVALID_ACTION,
  },
  [ROUTING_NO_MATCH]: {
    self_heal: 0,
    retry: 0,
    stop_reason: ROUTING_NO_MATCH,
  },
  [FALLBACK_DISABLED]: {
    self_heal: 0,
    retry: 0,
    stop_reason: FALLBACK_DISABLED,
  },
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
  request_timeout: {
    self_heal: 0,
    retry: 0,
    stop_reason: "request_timeout",
  },
  request_cancelled: {
    self_heal: 0,
    retry: 0,
    stop_reason: "request_cancelled",
  },
  business_error: {
    self_heal: 0,
    retry: 0,
    stop_reason: "business_error",
  },
  entry_governance_required: {
    self_heal: 0,
    retry: 0,
    stop_reason: "entry_governance_required",
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

function normalizeDecisionAlternative(value = null, fallback = {}) {
  const fallbackAction = cleanText(fallback?.action || "") || null;
  const fallbackAgentId = cleanText(fallback?.agent_id || "") || null;
  const fallbackSummary = cleanText(fallback?.summary || "") || "";

  if (typeof value === "string") {
    const summary = cleanText(value);
    return {
      action: fallbackAction,
      agent_id: fallbackAgentId,
      summary: summary || fallbackSummary || null,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      action: fallbackAction,
      agent_id: fallbackAgentId,
      summary: fallbackSummary || null,
    };
  }

  const action = cleanText(value.action || value.selected_action || "") || fallbackAction;
  const agentId = cleanText(value.agent_id || value.next_agent_id || "") || fallbackAgentId;
  const summary = cleanText(value.summary || value.reason || "") || fallbackSummary;
  return {
    action: action || null,
    agent_id: agentId || null,
    summary: summary || null,
  };
}

function normalizeDecisionReasoning({
  why = "",
  alternative = null,
} = {}) {
  return {
    why: cleanText(why) || null,
    alternative: normalizeDecisionAlternative(alternative),
  };
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
  reasoning = null,
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
    reasoning: reasoning ? normalizeDecisionReasoning(reasoning) : null,
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

function normalizePlannerAgentLane(value = "") {
  const normalized = cleanText(String(value || "").toLowerCase()).replace(/[\s-]+/g, "_");
  if (!normalized) {
    return null;
  }
  if (["meeting", "meeting_processing"].includes(normalized)) {
    return "meeting";
  }
  if (["runtime", "runtime_info"].includes(normalized)) {
    return "runtime";
  }
  if (["mixed", "multi_step", "cross_lane"].includes(normalized)) {
    return "mixed";
  }
  if ([
    "doc",
    "doc_query",
    "doc_write",
    "doc_rewrite",
    "cloud_doc",
    "search",
    "detail",
    "knowledge",
    "list_docs",
  ].includes(normalized)) {
    return "doc";
  }
  return null;
}

function derivePlannerAgentLane({
  taskType = "",
  payload = {},
  selectedAction = "",
} = {}) {
  const payloadLane = normalizePlannerAgentLane(
    payload?.lane || payload?.agent_lane || payload?.capability_lane || "",
  );
  if (payloadLane) {
    return payloadLane;
  }

  const taskLane = normalizePlannerAgentLane(taskType);
  if (taskLane) {
    return taskLane;
  }

  const action = cleanText(selectedAction || "");
  if (action === "get_runtime_info") {
    return "runtime";
  }
  if (action === "runtime_and_list_docs") {
    return "mixed";
  }
  if ([
    "create_doc",
    "list_company_brain_docs",
    "search_company_brain_docs",
    "get_company_brain_doc_detail",
    "search_and_detail_doc",
    "create_and_list_doc",
    "create_search_detail_list_doc",
    "update_learning_state",
    "ingest_learning_doc",
  ].includes(action)) {
    return "doc";
  }

  return null;
}

export function resolvePlannerAgentExecution({
  taskType = "",
  payload = {},
  selectedAction = "",
} = {}) {
  const lane = derivePlannerAgentLane({
    taskType,
    payload,
    selectedAction,
  });

  return runAgentExecution(executeAgent({ lane }));
}

function buildPlannerAgentOutput({
  selectedAction = null,
  executionResult = null,
  traceId = null,
  routingReason = null,
  taskType = "",
  payload = {},
} = {}) {
  return {
    selected_action: selectedAction,
    execution_result: executionResult,
    routing_reason: cleanText(routingReason) || null,
    synthetic_agent_hint: resolvePlannerAgentExecution({
      taskType,
      payload,
      selectedAction,
    }),
    trace_id: traceId,
  };
}

function attachPlannerPendingItems({
  executionResult = null,
  lifecycleSnapshot = null,
} = {}) {
  if (!executionResult || typeof executionResult !== "object") {
    return executionResult;
  }
  const formattedOutput = executionResult?.formatted_output;
  if (!formattedOutput || typeof formattedOutput !== "object") {
    return executionResult;
  }

  const pendingItems = buildPlannerLifecycleUnfinishedItems(lifecycleSnapshot);
  return {
    ...executionResult,
    formatted_output: {
      ...formattedOutput,
      pending_items: pendingItems,
    },
  };
}

export function buildPlannerPendingItemActionResult({
  actionResult = null,
  task = null,
  userIntent = "",
} = {}) {
  if (!actionResult || typeof actionResult !== "object") {
    return actionResult;
  }
  const title = cleanText(task?.title) || "未命名 pending item";
  const pendingItems = Array.isArray(actionResult?.data?.pending_items) ? actionResult.data.pending_items : [];
  const summary = title
    ? `已將「${title}」標記完成。`
    : "已將這個 pending item 標記完成。";
  return {
    ...actionResult,
    formatted_output: {
      kind: "pending_item_action",
      title,
      doc_id: cleanText(task?.id) || null,
      items: pendingItems
        .map((item) => ({
          title: cleanText(item?.label || ""),
          doc_id: cleanText(item?.item_id || item?.id || "") || null,
        }))
        .filter((item) => item.title || item.doc_id)
        .slice(0, 5),
      match_reason: cleanText(userIntent) || null,
      content_summary: summary,
      found: true,
      resolved_item: {
        title,
        item_id: cleanText(task?.id) || null,
        status: cleanText(actionResult?.data?.status || "") || "resolved",
      },
      pending_items: pendingItems,
      action_layer: {
        summary,
        next_actions: pendingItems.map((item) => cleanText(item?.label)).filter(Boolean).slice(0, 5),
        owner: cleanText(task?.owner) || null,
        deadline: cleanText(task?.deadline) || null,
        risks: Array.isArray(task?.risks) ? task.risks : [],
        status: cleanText(actionResult?.data?.status || "") || "resolved",
      },
    },
  };
}

function buildPlannerMultiStepOutput({
  ok = true,
  steps = [],
  results = [],
  traceId = null,
  error = null,
  stopped = false,
  stoppedAtStep = null,
  currentStepIndex = null,
  lastError = null,
  retryCount = 0,
} = {}) {
  return {
    ok,
    steps,
    results,
    trace_id: traceId,
    error: cleanText(error) || null,
    stopped: stopped === true,
    stopped_at_step: Number.isInteger(stoppedAtStep) ? stoppedAtStep : null,
    current_step_index: Number.isInteger(currentStepIndex) ? currentStepIndex : currentStepIndex === 0 ? 0 : null,
    last_error: lastError && typeof lastError === "object" && !Array.isArray(lastError)
      ? {
          error: cleanText(lastError.error || "") || null,
          trace_id: lastError.trace_id ?? null,
          data: lastError.data && typeof lastError.data === "object" && !Array.isArray(lastError.data)
            ? lastError.data
            : {},
        }
      : null,
    retry_count: Number.isFinite(retryCount) ? Number(retryCount) : 0,
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
  currentStepIndex = null,
  lastError = null,
  retryCount = 0,
  error = null,
} = {}) {
  return {
    ok,
    preset,
    steps,
    results,
    trace_id: traceId,
    stopped,
    stopped_at_step: stoppedAtStep,
    current_step_index: Number.isInteger(currentStepIndex) ? currentStepIndex : currentStepIndex === 0 ? 0 : null,
    last_error: lastError && typeof lastError === "object" && !Array.isArray(lastError)
      ? {
          error: cleanText(lastError.error || "") || null,
          trace_id: lastError.trace_id ?? null,
          data: lastError.data && typeof lastError.data === "object" && !Array.isArray(lastError.data)
            ? lastError.data
            : {},
        }
      : null,
    retry_count: Number.isFinite(retryCount) ? Number(retryCount) : 0,
    error: cleanText(error) || null,
  };
}

export function resetPlannerRuntimeContext({ sessionKey = "" } = {}) {
  resetPlannerFlowContexts(plannerFlows, { sessionKey });
  resetPlannerConversationMemory({ sessionKey });
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

function normalizePlannerStepIndex(value, stepCount = 0, fallback = 0) {
  if (!Number.isInteger(value)) {
    return Math.min(Math.max(Number.isInteger(fallback) ? fallback : 0, 0), Math.max(stepCount, 0));
  }
  return Math.min(Math.max(value, 0), Math.max(stepCount, 0));
}

function normalizePlannerRetryableErrorTypes(errorTypes = [], fallback = ["tool_error", "runtime_exception"]) {
  const source = Array.isArray(errorTypes) && errorTypes.length > 0 ? errorTypes : fallback;
  return new Set(
    source
      .map((errorType) => cleanText(errorType))
      .filter(Boolean),
  );
}

function buildPlannerLastErrorRecord(result = null) {
  if (!result || typeof result !== "object" || result.ok !== false) {
    return null;
  }
  return {
    error: cleanText(result.error || "") || "business_error",
    trace_id: result.trace_id ?? null,
    data: result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data
      : {},
  };
}

function getLatestPlannerTraceId(results = []) {
  if (!Array.isArray(results)) {
    return null;
  }
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const traceId = results[index]?.trace_id ?? null;
    if (traceId != null) {
      return traceId;
    }
  }
  return null;
}

function countCompletedPlannerSteps(steps = [], previousResults = []) {
  if (!Array.isArray(steps) || !Array.isArray(previousResults)) {
    return 0;
  }

  let completedCount = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const result = previousResults[index];
    if (!result || typeof result !== "object" || result.ok !== true) {
      break;
    }
    const resultAction = cleanText(result.action || "");
    if (resultAction && resultAction !== step.action) {
      break;
    }
    completedCount += 1;
  }
  return completedCount;
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

function applyCreateDocEntryGovernancePayload(action = "", payload = {}) {
  if (cleanText(action) !== "create_doc") {
    return normalizePlannerPayload(payload);
  }

  const normalizedPayload = normalizePlannerPayload(payload);
  return {
    ...normalizedPayload,
    source: cleanText(normalizedPayload.source || "") || "api_doc_create",
    owner: cleanText(normalizedPayload.owner || "") || "planner_agent",
    intent: cleanText(normalizedPayload.intent || "") || "create_doc",
    type: cleanText(normalizedPayload.type || "") || "document_create",
  };
}

function resolveDispatchInput({
  action = "",
  payload = {},
  logger = console,
} = {}) {
  let effectivePayload = applyCreateDocEntryGovernancePayload(action, payload);
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
    "ingest_learning_doc",
    "update_learning_state",
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

function buildEmptyCompanyBrainLearningState() {
  return {
    status: "not_learned",
    structured_summary: buildEmptyCompanyBrainSummary(),
    key_concepts: [],
    tags: [],
    notes: "",
    learned_at: null,
    updated_at: null,
  };
}

function normalizeCompanyBrainLearningState(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return buildEmptyCompanyBrainLearningState();
  }

  return {
    status: cleanText(value.status) || "not_learned",
    structured_summary: value.structured_summary && typeof value.structured_summary === "object"
      ? {
          overview: cleanText(value.structured_summary.overview) || "",
          headings: Array.isArray(value.structured_summary.headings) ? value.structured_summary.headings.map((item) => cleanText(item)).filter(Boolean) : [],
          highlights: Array.isArray(value.structured_summary.highlights) ? value.structured_summary.highlights.map((item) => cleanText(item)).filter(Boolean) : [],
          snippet: cleanText(value.structured_summary.snippet)
            || cleanText(value.structured_summary.overview)
            || "",
          content_length: Number.isFinite(Number(value.structured_summary.content_length)) ? Number(value.structured_summary.content_length) : 0,
        }
      : buildEmptyCompanyBrainSummary(),
    key_concepts: Array.isArray(value.key_concepts) ? value.key_concepts.map((item) => cleanText(item)).filter(Boolean) : [],
    tags: Array.isArray(value.tags) ? value.tags.map((item) => cleanText(item)).filter(Boolean) : [],
    notes: cleanText(value.notes) || "",
    learned_at: cleanText(value.learned_at) || null,
    updated_at: cleanText(value.updated_at) || null,
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
    learning_state: normalizeCompanyBrainLearningState(item?.learning_state),
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
          learning_state: normalizeCompanyBrainLearningState(rawData?.learning_state),
        },
        error,
      },
    };
  }

  if (["ingest_learning_doc", "update_learning_state"].includes(action)) {
    const item = rawData?.doc || rawData?.item || {};
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
          learning_state: normalizeCompanyBrainLearningState(rawData?.learning_state),
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

export function validatePlannerUserInputDecision(decision = {}, { text = "" } = {}) {
  const normalizedDecision = decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision
    : {};
  const effectiveDecision = hardenPlannerUserInputDecisionCandidate({
    text,
    decision: normalizedDecision,
  }).decision;
  const rawSteps = effectiveDecision.steps;
  if (rawSteps !== undefined) {
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return {
        ok: false,
        error: "planner_failed",
      };
    }

    const steps = [];
    for (let index = 0; index < rawSteps.length; index += 1) {
      const rawStep = rawSteps[index];
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
        return {
          ok: false,
          error: "planner_failed",
        };
      }

      const action = cleanText(rawStep.action || "");
      const rawParams = rawStep.params;
      if (rawParams != null && (typeof rawParams !== "object" || Array.isArray(rawParams))) {
        return {
          ok: false,
          error: "planner_failed",
        };
      }

      const params = normalizePlannerPayload(rawParams);
      if (!action) {
        return {
          ok: false,
          error: "planner_failed",
        };
      }

      const contract = getPlannerActionContract(action);
      steps.push({ action, params });

      if (!contract) {
        return {
          ok: false,
          error: normalizePublicPlannerErrorCode(INVALID_ACTION),
          action,
          params,
          steps,
          step_index: index,
        };
      }

      const violations = validateAgainstSchema(contract?.input_schema, params, `steps[${index}].params`);
      if (violations.length > 0) {
        return {
          ok: false,
          error: "contract_violation",
          action,
          params,
          steps,
          step_index: index,
          violations,
        };
      }
    }

    return {
      ok: true,
      steps,
      target_kind: "multi_step",
    };
  }

  const action = cleanText(effectiveDecision.action || "");
  const rawParams = effectiveDecision.params;
  if (rawParams != null && (typeof rawParams !== "object" || Array.isArray(rawParams))) {
    return {
      ok: false,
      error: "planner_failed",
    };
  }
  const params = normalizePlannerPayload(effectiveDecision.params);

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
      error: normalizePublicPlannerErrorCode(INVALID_ACTION),
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
    governance: getDocumentCreateGovernanceContract(),
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
    queryKeys: ["q", "limit", "top_k"],
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
  ["ingest_learning_doc", {
    action: "ingest_learning_doc",
    method: "POST",
    pathname: "/agent/company-brain/learning/ingest",
  }],
  ["update_learning_state", {
    action: "update_learning_state",
    method: "POST",
    pathname: "/agent/company-brain/learning/state",
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
    buildSteps(input = {}) {
      const {
        title = "",
        folder_token = "",
        q = "",
        doc_id = "",
        top_k = null,
      } = input && typeof input === "object" ? input : {};
      const hasLimit = Boolean(input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "limit"));
      const listLimit = hasLimit ? input.limit : 10;
      const searchPayload = top_k !== null && top_k !== undefined
        ? { q, top_k }
        : hasLimit
          ? { q, limit: input.limit }
          : { q, top_k: 5 };
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
          payload: searchPayload,
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
            limit: listLimit,
          },
        },
      ];
    },
  }],
  ["search_and_detail_doc", {
    preset: "search_and_detail_doc",
    buildSteps(input = {}) {
      const {
        q = "",
        doc_id = "",
        top_k = null,
      } = input && typeof input === "object" ? input : {};
      const hasLimit = Boolean(input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "limit"));
      const searchPayload = top_k !== null && top_k !== undefined
        ? { q, top_k }
        : hasLimit
          ? { q, limit: input.limit }
          : { q, top_k: 5 };
      return [
        {
          action: "search_company_brain_docs",
          payload: searchPayload,
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
    governance: tool.governance || null,
  }));
}

export function listPlannerPresets() {
  return Array.from(plannerPresetRegistry.values()).map((preset) => ({
    preset: preset.preset,
    step_actions: Array.isArray(preset.buildSteps?.({}))
      ? preset.buildSteps({})
        .map((step) => cleanText(step?.action || ""))
        .filter(Boolean)
      : [],
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
  const semantics = derivePlannerUserInputSemantics(userIntent);

  let selectedAction = "";
  let reason = "";
  let routingReason = "routing_no_match";

  if (
    normalizedIntent.includes("建立文件並查詢")
    || normalizedIntent.includes("create then search")
    || normalizedIntent.includes("建立後搜尋文件")
    || normalizedIntent.includes("create search doc")
  ) {
    selectedAction = "create_search_detail_list_doc";
    reason = "命中完整流程任務，使用 demo preset。";
    routingReason = "selector_create_search_detail_list_doc";
  } else if (
    normalizedIntent.includes("建立文件後列出知識庫")
    || normalizedIntent.includes("create doc then list docs")
    || normalizedIntent.includes("建立並查看文件列表")
  ) {
    selectedAction = "create_and_list_doc";
    reason = "命中複合任務，優先使用 preset。";
    routingReason = "selector_create_and_list_doc";
  } else if (
    normalizedTaskType === "doc_write"
    || normalizedIntent.includes("建立文件")
    || normalizedIntent.includes("创建文档")
    || normalizedIntent.includes("create doc")
    || normalizedIntent.includes("新建文件")
  ) {
    selectedAction = "create_doc";
    reason = "使用者意圖是建立文件，對應受控文件建立 bridge。";
    routingReason = "selector_create_doc";
  } else if (semantics.wants_document_list) {
    selectedAction = "list_company_brain_docs";
    reason = "使用者意圖是查看文件清單，優先走保守 list action。";
    routingReason = "selector_list_company_brain_docs";
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
    routingReason = "selector_list_company_brain_docs";
  } else if (semantics.wants_scoped_doc_exclusion_search) {
    selectedAction = "search_company_brain_docs";
    reason = "這輪是在文件範圍內重新盤點某個主題集合，所以先 search 候選文件。";
    routingReason = "selector_search_company_brain_docs_scoped_exclusion";
  } else if (
    normalizedTaskType === "knowledge_learning"
    || normalizedIntent.includes("學習這份文件")
    || normalizedIntent.includes("学习这份文件")
    || normalizedIntent.includes("ingest learning")
    || normalizedIntent.includes("learn this doc")
  ) {
    selectedAction = "ingest_learning_doc";
    reason = "使用者意圖是讓系統學習目前文件，對應 learning ingest bridge。";
    routingReason = "selector_ingest_learning_doc";
  } else if (
    normalizedIntent.includes("更新學習狀態")
    || normalizedIntent.includes("更新学习状态")
    || normalizedIntent.includes("update learning state")
  ) {
    selectedAction = "update_learning_state";
    reason = "使用者意圖是更新 learning state，對應 learning state bridge。";
    routingReason = "selector_update_learning_state";
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
    routingReason = "selector_get_runtime_info";
  } else if (semantics.wants_document_search || hasDocSearchIntent(normalizedIntent)) {
    selectedAction = "search_company_brain_docs";
    reason = "使用者意圖是搜尋文件，固定走唯一 search action。";
    routingReason = "selector_search_company_brain_docs";
  } else if (semantics.wants_document_detail) {
    selectedAction = "search_and_detail_doc";
    reason = "使用者意圖是整理或閱讀文件內容，對應 search-and-detail。";
    routingReason = "selector_search_and_detail_doc";
  }

  if (!selectedAction) {
    reason = ROUTING_NO_MATCH;
    routingReason = "routing_no_match";
  }

  const reasoning = normalizeDecisionReasoning({
    why: reason || null,
    alternative: buildUserInputDecisionAlternative({ action: selectedAction }),
  });

  logger?.info?.("planner_tool_select", {
    stage: "planner_tool_select",
    user_intent: normalizedIntent || null,
    task_type: normalizedTaskType || null,
    selected_action: selectedAction || null,
    chosen_action: selectedAction || null,
    fallback_reason: selectedAction ? null : routingReason || null,
    reason: reason || null,
    routing_reason: routingReason || null,
    reasoning,
  });

  return {
    selected_action: selectedAction || null,
    reason: reason || null,
    routing_reason: routingReason || null,
    why: reasoning.why,
    alternative: reasoning.alternative,
  };
}

export function shouldPreferSelectorAction({
  hardRoutedAction = "",
  selectorAction = "",
} = {}) {
  const normalizedHardRoutedAction = cleanText(hardRoutedAction);
  const normalizedSelectorAction = cleanText(selectorAction);

  return normalizedHardRoutedAction === "search_company_brain_docs"
    && Boolean(normalizedSelectorAction)
    && normalizedSelectorAction !== normalizedHardRoutedAction
    && normalizedSelectorAction !== "search_and_detail_doc";
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
  authContext = null,
  signal = null,
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
  const normalizedAuthContext = normalizePlannerAuthContext(authContext);
  const preAbortResult = buildPlannerAbortResult({
    action: runtimeInput.action,
    signal,
  });
  if (preAbortResult) {
    emitToolExecutionLog({
      logger,
      requestId,
      action: runtimeInput.action,
      params: runtimeInput.payload,
      success: false,
      data: buildPlannerToolExecutionData(preAbortResult),
      error: preAbortResult.error,
      traceId: preAbortResult.trace_id || null,
    });
    return preAbortResult;
  }
  if (!tool) {
    const stoppedResult = buildPlannerStoppedResult({
      action: runtimeInput.action,
      error: INVALID_ACTION,
      data: {
        message: `planner_tool_not_allowed:${runtimeInput.action}`,
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
    throwIfPlannerSignalAborted(signal);
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
        ...buildExplicitUserAuthHeaders(normalizedAuthContext, {
          required: actionRequiresExplicitUserAuth(tool.action),
        }),
      },
      signal,
      body: tool.method === "POST"
        ? JSON.stringify(effectivePayload && typeof effectivePayload === "object" ? effectivePayload : {})
        : undefined,
    });

    const rawText = await response.text();
    throwIfPlannerSignalAborted(signal);
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
      const abortResult = buildPlannerAbortResult({
        action: tool.action,
        signal,
        error,
        traceId: stickyTraceId,
      });
      if (abortResult) {
        return abortResult;
      }
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
    && !isPlannerAbortCode(result?.error || "")
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
  authContext = null,
  signal = null,
  sessionKey = "",
} = {}) {
  const preAbortResult = buildPlannerAbortResult({
    action: cleanText(forcedSelection?.selected_action || forcedSelection?.action || "") || null,
    signal,
  });
  if (preAbortResult) {
    return buildPlannerAgentOutput({
      selectedAction: cleanText(forcedSelection?.selected_action || forcedSelection?.action || "") || null,
      executionResult: preAbortResult,
      traceId: preAbortResult.trace_id || null,
      routingReason: cleanText(forcedSelection?.routing_reason || forcedSelection?.reason || "") || "forced_selection",
      taskType,
      payload,
    });
  }
  restorePlannerRuntimeContextFromSummary({ sessionKey });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    logger,
    reason: "pre_run_planner_tool_flow",
    sessionKey,
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
        routing_reason: cleanText(forcedSelection.routing_reason || forcedSelection.reason || "") || "forced_selection",
      }
    : null;
  const plannerDocQueryContext = getPlannerDocQueryContext({ sessionKey });
  const taskLifecycleFollowUp = (!disableAutoRouting && !normalizedForcedSelection)
    ? await maybeRunPlannerTaskLifecycleFollowUp({
        userIntent: agentInput.user_intent,
        activeDoc: plannerDocQueryContext.activeDoc,
        activeTheme: plannerDocQueryContext.activeTheme,
        logger,
      })
    : null;
  throwIfPlannerSignalAborted(signal);
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
            sessionKey,
          });
  const hardRoutedAction = taskLifecycleFollowUp?.selected_action || (!disableAutoRouting ? routedFlow.action : null);
  const routedPayload = taskLifecycleFollowUp?.execution_result?.data || routedFlow.payload;
  const selectorSelection = normalizedForcedSelection
    ? null
    : selector({
        userIntent: agentInput.user_intent,
        taskType: agentInput.task_type,
        logger,
      });
  const prefersSelectorSelection = !normalizedForcedSelection
    && !taskLifecycleFollowUp?.selected_action
    && shouldPreferSelectorAction({
      hardRoutedAction: !disableAutoRouting ? routedFlow.action : null,
      selectorAction: selectorSelection?.selected_action,
    });
  const selection = normalizedForcedSelection
    ? normalizedForcedSelection
    : prefersSelectorSelection
    ? {
        ...selectorSelection,
        reason: selectorSelection?.reason || "命中更具體的 selector 規則，覆蓋 generic search hard route。",
        routing_reason: cleanText(selectorSelection?.routing_reason || "") || "selector_override_generic_search_route",
      }
    : hardRoutedAction
    ? {
        selected_action: hardRoutedAction,
        reason: taskLifecycleFollowUp?.reason || "命中硬路由規則。",
        routing_reason: cleanText(taskLifecycleFollowUp?.routing_reason || routedFlow?.routing_reason || "") || "hard_route_match",
      }
    : selectorSelection;
  const selectionRoutingReason = cleanText(selection?.routing_reason || "")
    || (cleanText(selection?.selected_action || "") ? "selector_match" : "routing_no_match");
  const selectionReasoning = normalizeDecisionReasoning({
    why: selection?.why || selection?.reason || null,
    alternative: selection?.alternative || buildUserInputDecisionAlternative({
      action: selection?.selected_action || null,
    }),
  });

  let executionResult = null;
  let traceId = null;
  let lifecycleSnapshot = taskLifecycleFollowUp?.snapshot || null;
  const selectionAction = cleanText(selection?.selected_action || "");

  if (!selectionAction) {
    maybeInvokePlannerHook(hooks, "onEscalation", {
      from: "planner_selection",
      reason: selectionRoutingReason || ROUTING_NO_MATCH,
    });
    executionResult = buildPlannerStoppedResult({
      action: null,
      error: "business_error",
      data: {
        reason: selectionRoutingReason,
        message: "未命中受控工具規則，保持空選擇。",
        routing_reason: selectionRoutingReason,
      },
      traceId: null,
      stopReason: "business_error",
    });
  } else if (
    !taskLifecycleFollowUp?.execution_result
    && selectionAction !== "mark_resolved"
    && !getPlannerActionContract(selectionAction)
    && !getPlannerPreset(selectionAction)
  ) {
    executionResult = buildPlannerStoppedResult({
      action: selectionAction,
      error: INVALID_ACTION,
      data: {
        reason: selectionRoutingReason || "invalid_action",
        routing_reason: selectionRoutingReason || "invalid_action",
      },
      traceId: null,
    });
  }

  if (!executionResult && selection.selected_action) {
    if (taskLifecycleFollowUp?.execution_result) {
      executionResult = taskLifecycleFollowUp.execution_result;
      traceId = executionResult?.trace_id || null;
    } else if (selection.selected_action === "mark_resolved") {
      const pendingItemAction = taskLifecycleFollowUp?.pending_item_action || null;
      const actionResult = await handlePlannerPendingItemAction({
        itemId: cleanText(pendingItemAction?.item_id || "") || "",
        action: "mark_resolved",
      });
      if (actionResult?.ok === true) {
        executionResult = buildPlannerPendingItemActionResult({
          actionResult,
          task: pendingItemAction?.task || null,
          userIntent: agentInput.user_intent,
        });
      } else {
        executionResult = buildPlannerStoppedResult({
          action: selection.selected_action,
          error: actionResult?.error || "business_error",
          data: actionResult?.data || {},
          traceId: null,
        });
      }
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
          sessionKey,
        }),
        logger,
        authContext,
        signal,
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
          sessionKey,
        }),
        logger,
        authContext,
        signal,
      });
      traceId = executionResult?.trace_id || null;
    }
  }

  const selectedFlow = routedFlow.flow || getPlannerFlowForAction(plannerFlows, selection.selected_action);
  throwIfPlannerSignalAborted(signal);
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
            sessionKey,
          }),
      baseUrl,
      contentReader,
      logger,
      sessionKey,
    });
  }
  throwIfPlannerSignalAborted(signal);
  traceId = executionResult?.trace_id || traceId || null;

  logger?.info?.("planner_end_to_end", buildPlannerTraceEvent({
    eventType: "planner_end_to_end",
    ok: executionResult?.ok ?? false,
    traceId,
    reasoning: selectionReasoning,
    extra: {
      user_intent: cleanText(String(userIntent || "").toLowerCase()) || null,
      task_type: cleanText(String(taskType || "").toLowerCase()) || null,
      selected_action: selection.selected_action || null,
      chosen_action: selection.selected_action || null,
      fallback_reason: cleanText(
        selectionRoutingReason
        || executionResult?.data?.reason
        || executionResult?.data?.stop_reason
        || executionResult?.error
        || ""
      ) || null,
    },
  }));

  if (!taskLifecycleFollowUp?.execution_result && selection.selected_action !== "mark_resolved") {
    syncPlannerFlowContext({
      flow: selectedFlow,
      selectedAction: selection.selected_action,
      executionResult,
      logger,
      sessionKey,
    });
  }

  if (!taskLifecycleFollowUp?.execution_result && selection.selected_action !== "mark_resolved") {
    lifecycleSnapshot = await syncPlannerActionLayerTaskLifecycle({
      flow: selectedFlow,
      context: selectedFlow?.readContext?.({ sessionKey }) || {},
      selectedAction: selection.selected_action,
      userIntent: agentInput.user_intent,
      executionResult,
      traceId,
    });
  }
  if (selection.selected_action === "mark_resolved") {
    lifecycleSnapshot = await getLatestPlannerTaskLifecycleSnapshot();
  }
  executionResult = attachPlannerPendingItems({
    executionResult,
    lifecycleSnapshot,
  });

  recordPlannerConversationExchange({
    userQuery: agentInput.user_intent,
    plannerReply: describePlannerExecutionResult(executionResult),
    sessionKey,
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
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
    sessionKey,
  });

  return buildPlannerAgentOutput({
    selectedAction: selection.selected_action,
    executionResult,
    traceId,
    routingReason: selectionRoutingReason,
    taskType,
    payload: agentInput.payload,
  });
}

// ---------------------------------------------------------------------------
// Planner multi-step runtime
// ---------------------------------------------------------------------------

export async function runPlannerMultiStep({
  steps = [],
  logger = console,
  dispatcher = dispatchPlannerTool,
  stopOnError = true,
  resume_from_step = null,
  previous_results = [],
  max_retries = 0,
  retryable_error_types = ["tool_error", "runtime_exception"],
  authContext = null,
  signal = null,
} = {}) {
  const preAbortResult = buildPlannerAbortResult({ signal });
  if (preAbortResult) {
    return buildPlannerMultiStepOutput({
      ok: false,
      steps: [],
      results: [],
      traceId: preAbortResult.trace_id || null,
      error: preAbortResult.error,
      stopped: true,
      stoppedAtStep: null,
      currentStepIndex: 0,
      lastError: buildPlannerLastErrorRecord(preAbortResult),
      retryCount: 0,
    });
  }
  const normalizedSteps = Array.isArray(steps)
    ? steps
        .map((step) => ({
          action: cleanText(step?.action || ""),
          payload: normalizePlannerPayload(
            step?.params && typeof step.params === "object" && !Array.isArray(step.params)
              ? step.params
              : step?.payload && typeof step.payload === "object" && !Array.isArray(step.payload)
                ? step.payload
                : {},
          ),
        }))
        .filter((step) => step.action)
    : [];

  const completedStepCount = countCompletedPlannerSteps(normalizedSteps, previous_results);
  const hasPreviousResults = Array.isArray(previous_results) && previous_results.length > 0;
  const startStepIndex = hasPreviousResults
    ? completedStepCount
    : normalizePlannerStepIndex(resume_from_step, normalizedSteps.length, 0);
  const results = hasPreviousResults
    ? previous_results.slice(0, completedStepCount)
    : [];
  const retryableErrorTypes = normalizePlannerRetryableErrorTypes(retryable_error_types);
  const maxRetries = Math.max(0, Number.isFinite(Number(max_retries)) ? Number(max_retries) : 0);
  let traceId = getLatestPlannerTraceId(results);
  let error = null;
  let stopped = false;
  let stoppedAtStep = null;
  let currentStepIndex = normalizedSteps.length > 0 ? startStepIndex : null;
  let lastError = null;
  let retryCount = 0;

  for (let index = startStepIndex; index < normalizedSteps.length; index += 1) {
    throwIfPlannerSignalAborted(signal);
    const step = normalizedSteps[index];
    currentStepIndex = index;
    let stepRetryCount = 0;

    while (true) {
      throwIfPlannerSignalAborted(signal);
      const result = await dispatcher({
        action: step.action,
        payload: step.payload,
        logger,
        authContext,
        signal,
      });
      results.push(result);
      traceId = result?.trace_id || traceId;

      if (result?.ok !== false) {
        break;
      }

      lastError = buildPlannerLastErrorRecord(result);
      const retryableError = retryableErrorTypes.has(cleanText(result?.error || ""));
      if (retryableError && stepRetryCount < maxRetries) {
        stepRetryCount += 1;
        retryCount += 1;
        results.pop();
        emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
          eventType: "multi_step_retry_attempt",
          action: step.action,
          error: lastError?.error || result?.error || "business_error",
          retryCount,
          traceId: traceId || lastError?.trace_id || null,
          extra: {
            step_index: index,
            step_retry_count: stepRetryCount,
          },
        }));
        logPlannerTrace(logger, "info", buildPlannerTraceEvent({
          eventType: "planner_multi_step_retry",
          action: step.action,
          error: lastError?.error || result?.error || "business_error",
          retryCount,
          traceId: traceId || lastError?.trace_id || null,
          extra: {
            step_index: index,
            step_retry_count: stepRetryCount,
          },
        }));
        continue;
      }

      error = cleanText(result?.error || "") || "business_error";
      if (stopOnError !== false) {
        stopped = true;
        stoppedAtStep = index;
      }
      break;
    }

    if (stopped) {
      break;
    }
  }

  if (normalizedSteps.length > 0 && stopped !== true) {
    currentStepIndex = normalizedSteps.length;
  }

  logger?.info?.("planner_multi_step", buildPlannerTraceEvent({
    eventType: "planner_multi_step",
    traceId,
    extra: {
      step_count: normalizedSteps.length,
      resume_from_step: Number.isInteger(resume_from_step) ? resume_from_step : null,
      resumed_from_step: startStepIndex,
      actions: normalizedSteps.map((step) => step.action),
      ok_count: results.filter((item) => item?.ok).length,
      retry_count: retryCount,
      stopped,
      stopped_at_step: stoppedAtStep,
    },
  }));

  return buildPlannerMultiStepOutput({
    ok: results.length === normalizedSteps.length
      && results.every((item) => item?.ok === true)
      && stopped !== true,
    steps: normalizedSteps.map((step) => ({ action: step.action })),
    results,
    traceId,
    error,
    stopped,
    stoppedAtStep,
    currentStepIndex,
    lastError,
    retryCount,
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
  resume_from_step = null,
  previous_results = [],
  max_retries = 0,
  retryable_error_types = ["tool_error", "runtime_exception"],
  authContext = null,
  signal = null,
} = {}) {
  const preAbortResult = buildPlannerAbortResult({
    preset,
    signal,
  });
  if (preAbortResult) {
    return preAbortResult;
  }
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
      const completedStepCount = countCompletedPlannerSteps(steps, previous_results);
      const hasPreviousResults = Array.isArray(previous_results) && previous_results.length > 0;
      const executionStartIndex = hasPreviousResults
        ? completedStepCount
        : normalizePlannerStepIndex(resume_from_step, steps.length, 0);
      const results = hasPreviousResults
        ? previous_results.slice(0, completedStepCount)
        : [];
      let traceId = getLatestPlannerTraceId(results);
      let stopped = false;
      let stoppedAtStep = null;
      let completedEarly = false;
      let effectiveDocId = cleanText(String(runtimeInput.input?.doc_id || ""));
      let currentStepIndex = steps.length > 0 ? executionStartIndex : null;
      let retryCount = 0;
      let lastError = null;
      let error = null;
      for (let index = executionStartIndex; index < steps.length; index += 1) {
        throwIfPlannerSignalAborted(signal);
        const step = {
          ...steps[index],
          payload: { ...(steps[index]?.payload || {}) },
        };
        currentStepIndex = index;

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
          max_retries,
          retryable_error_types,
          authContext,
          signal,
        });
        const singleResult = result?.results?.[0] ?? null;
        if (singleResult) {
          results.push(singleResult);
          traceId = singleResult.trace_id || result?.trace_id || traceId;
        }
        retryCount += Number(result?.retry_count || 0);
        if (result?.last_error) {
          lastError = result.last_error;
        }
        if (singleResult?.ok === false) {
          stopped = true;
          stoppedAtStep = index;
          error = cleanText(result?.error || singleResult?.error || "") || "business_error";
          break;
        }
      }
      if (!stopped && !completedEarly && steps.length > 0) {
        currentStepIndex = steps.length;
      }
      execution = {
        steps: steps.slice(0, results.length).map((step) => ({ action: step.action })),
        results,
        trace_id: traceId,
        stopped,
        stopped_at_step: stoppedAtStep,
        completed_early: completedEarly,
        current_step_index: currentStepIndex,
        last_error: lastError,
        retry_count: retryCount,
        error,
      };
    } else {
      const multiStepExecution = await multiStepRunner({
        steps,
        logger,
        stopOnError: false,
        resume_from_step,
        previous_results,
        max_retries,
        retryable_error_types,
        authContext,
        signal,
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
      currentStepIndex: execution.current_step_index,
      lastError: execution.last_error,
      retryCount: execution.retry_count,
      error: execution.error,
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
        current_step_index: finalResult.current_step_index,
        retry_count: finalResult.retry_count,
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
    const abortedResult = buildPlannerAbortResult({
      preset: selectedPreset.preset,
      signal,
      error,
    });
    if (abortedResult) {
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "preset_result",
        preset: selectedPreset.preset,
        ok: false,
        error: abortedResult.error,
        stopped: true,
        stopReason: abortedResult?.data?.stop_reason || abortedResult.error,
        traceId: abortedResult?.trace_id || null,
      }));
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "stopped",
        preset: selectedPreset.preset,
        ok: false,
        error: abortedResult.error,
        stopped: true,
        stopReason: abortedResult?.data?.stop_reason || abortedResult.error,
        traceId: abortedResult?.trace_id || null,
      }));
      return abortedResult;
    }
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

function stringifyPlannerList(items = [], { maxItems = 4, maxItemChars = 120 } = {}) {
  const compact = compactListItems(items, { maxItems, maxItemChars });
  return compact.length > 0 ? compact.join("；") : "none";
}

function buildFocusedTaskContextText(taskDecisionContext = null) {
  const focusedTask = taskDecisionContext?.focused_task && typeof taskDecisionContext.focused_task === "object"
    ? taskDecisionContext.focused_task
    : null;
  if (!focusedTask) {
    return "none";
  }
  return [
    `title: ${cleanText(focusedTask.title) || "未命名 task"}`,
    cleanText(focusedTask.owner) ? `owner: ${cleanText(focusedTask.owner)}` : "",
    cleanText(focusedTask.deadline) ? `deadline: ${cleanText(focusedTask.deadline)}` : "",
    cleanText(focusedTask.task_state) ? `task_state: ${cleanText(focusedTask.task_state)}` : "",
    cleanText(focusedTask.progress_summary) ? `progress_summary: ${cleanText(focusedTask.progress_summary)}` : "",
    cleanText(focusedTask.note) ? `note: ${cleanText(focusedTask.note)}` : "",
    Array.isArray(focusedTask.risks) && focusedTask.risks.length > 0
      ? `risks: ${stringifyPlannerList(focusedTask.risks, { maxItems: 3, maxItemChars: 80 })}`
      : "",
    cleanText(focusedTask.source_title) ? `source_title: ${cleanText(focusedTask.source_title)}` : "",
    cleanText(focusedTask.source_doc_id) ? `source_doc_id: ${cleanText(focusedTask.source_doc_id)}` : "",
    cleanText(focusedTask.source_summary)
      ? `source_summary: ${trimTextForBudget(focusedTask.source_summary, 260, { preserveTail: false })}`
      : "",
  ].filter(Boolean).join("\n");
}

function buildPlannerRecentStepsText({
  activeTask = null,
  recentMessages = [],
} = {}) {
  const lines = [];

  if (Array.isArray(activeTask?.turns) && activeTask.turns.length > 0) {
    lines.push(
      ...activeTask.turns
        .slice(-4)
        .map((turn) => {
          const role = cleanText(turn?.role || "turn");
          const text = cleanText(turn?.text || "");
          return text ? `turn/${role}: ${trimTextForBudget(text, 120, { preserveTail: false })}` : "";
        })
        .filter(Boolean),
    );
  }

  if (Array.isArray(activeTask?.agent_outputs) && activeTask.agent_outputs.length > 0) {
    lines.push(
      ...activeTask.agent_outputs
        .slice(-2)
        .map((item) => {
          const agentId = cleanText(item?.agent_id || "agent");
          const summary = cleanText(item?.summary || "");
          return summary ? `agent_output/${agentId}: ${trimTextForBudget(summary, 120, { preserveTail: false })}` : "";
        })
        .filter(Boolean),
    );
  }

  if (Array.isArray(activeTask?.handoffs) && activeTask.handoffs.length > 0) {
    lines.push(
      ...activeTask.handoffs
        .slice(-2)
        .map((item) => {
          const from = cleanText(item?.from_agent_id || "");
          const to = cleanText(item?.to_agent_id || "");
          const reason = cleanText(item?.reason || "");
          return from && to
            ? `handoff: ${from} -> ${to}${reason ? ` (${trimTextForBudget(reason, 80, { preserveTail: false })})` : ""}`
            : "";
        })
        .filter(Boolean),
    );
  }

  if (Array.isArray(activeTask?.work_plan) && activeTask.work_plan.length > 0) {
    lines.push(
      ...activeTask.work_plan
        .slice(-3)
        .map((item) => {
          const agentId = cleanText(item?.agent_id || "");
          const task = cleanText(item?.task || "");
          const status = cleanText(item?.status || "pending");
          return agentId && task
            ? `work_plan/${status}/${agentId}: ${trimTextForBudget(task, 120, { preserveTail: false })}`
            : "";
        })
        .filter(Boolean),
    );
  }

  if (lines.length === 0 && Array.isArray(recentMessages) && recentMessages.length > 0) {
    lines.push(
      ...recentMessages
        .slice(-4)
        .map((message) => {
          const role = cleanText(message?.role || "message");
          const content = cleanText(message?.content || "");
          return content ? `${role}: ${trimTextForBudget(content, 120, { preserveTail: false })}` : "";
        })
        .filter(Boolean),
    );
  }

  return lines.slice(0, PLANNER_RECENT_STEP_LIMIT).join("\n") || "none";
}

function buildPlannerHighWeightDocSummaryText({
  taskDecisionContext = null,
  latestSummary = null,
  plannerDocQueryContext = {},
} = {}) {
  const lines = [];
  const seenDocKeys = new Set();
  const activeDoc = plannerDocQueryContext?.activeDoc && typeof plannerDocQueryContext.activeDoc === "object"
    ? plannerDocQueryContext.activeDoc
    : latestSummary?.active_doc;
  const activeCandidates = Array.isArray(plannerDocQueryContext?.activeCandidates) && plannerDocQueryContext.activeCandidates.length > 0
    ? plannerDocQueryContext.activeCandidates
    : Array.isArray(latestSummary?.active_candidates)
      ? latestSummary.active_candidates
      : [];
  const activeTheme = cleanText(plannerDocQueryContext?.activeTheme || latestSummary?.active_theme || "");
  const candidateTasks = [
    taskDecisionContext?.focused_task,
    ...(Array.isArray(taskDecisionContext?.reference_tasks) ? taskDecisionContext.reference_tasks : []),
  ]
    .filter((item) => item && typeof item === "object");

  if (activeTheme) {
    lines.push(`active_theme: ${activeTheme}`);
  }
  if (cleanText(activeDoc?.title) || cleanText(activeDoc?.doc_id)) {
    lines.push(`active_doc: ${cleanText(activeDoc?.title || activeDoc?.doc_id)} (${cleanText(activeDoc?.doc_id || "unknown_doc")})`);
  }
  if (activeCandidates.length > 0) {
    lines.push(`active_candidates: ${activeCandidates.slice(0, 3).map((item) => cleanText(item?.title || item?.doc_id)).filter(Boolean).join("、")}`);
  }

  for (const item of candidateTasks) {
    const docKey = cleanText(item?.source_doc_id || item?.source_title || item?.title || "");
    if (!docKey || seenDocKeys.has(docKey)) {
      continue;
    }
    seenDocKeys.add(docKey);
    const summary = cleanText(item?.source_summary);
    const label = cleanText(item?.source_title || item?.source_doc_id || item?.title || docKey);
    if (label && summary) {
      lines.push(`doc_summary/${label}: ${trimTextForBudget(summary, 220, { preserveTail: false })}`);
    } else if (label) {
      lines.push(`doc_ref: ${label}`);
    }
    if (seenDocKeys.size >= PLANNER_HIGH_WEIGHT_DOC_LIMIT) {
      break;
    }
  }

  if (cleanText(latestSummary?.next_step_suggestion)) {
    lines.push(`summary_next_step: ${trimTextForBudget(latestSummary.next_step_suggestion, 160, { preserveTail: false })}`);
  }

  return lines.join("\n") || "none";
}

function buildPlannerLatestSummaryText(latestSummary = null) {
  if (!latestSummary || typeof latestSummary !== "object") {
    return "none";
  }
  const unfinishedItems = Array.isArray(latestSummary.unfinished_items)
    ? latestSummary.unfinished_items.map((item) => cleanText(item?.label || "")).filter(Boolean)
    : [];
  const currentFlows = Array.isArray(latestSummary.current_flows)
    ? latestSummary.current_flows.map((flow) => cleanText(flow?.id || "")).filter(Boolean)
    : [];
  return [
    cleanText(latestSummary?.active_theme) ? `active_theme: ${cleanText(latestSummary.active_theme)}` : "",
    cleanText(latestSummary?.active_doc?.title || latestSummary?.active_doc?.doc_id)
      ? `active_doc: ${cleanText(latestSummary.active_doc.title || latestSummary.active_doc.doc_id)}`
      : "",
    currentFlows.length > 0
      ? `current_flows: ${stringifyPlannerList(currentFlows, { maxItems: 5, maxItemChars: 40 })}`
      : "",
    unfinishedItems.length > 0
      ? `unfinished_items: ${stringifyPlannerList(unfinishedItems, { maxItems: 4, maxItemChars: 90 })}`
      : "",
    cleanText(latestSummary?.next_step_suggestion)
      ? `next_step_suggestion: ${trimTextForBudget(latestSummary.next_step_suggestion, 180, { preserveTail: false })}`
      : "",
  ].filter(Boolean).join("\n") || "none";
}

function buildPlannerActiveTaskText(activeTask = null) {
  if (!activeTask || typeof activeTask !== "object") {
    return "none";
  }
  const workPlan = Array.isArray(activeTask.work_plan)
    ? activeTask.work_plan
        .slice(0, 4)
        .map((item) => {
          const agentId = cleanText(item?.agent_id || "");
          const task = cleanText(item?.task || "");
          const status = cleanText(item?.status || "pending");
          return agentId && task ? `${status}/${agentId}: ${trimTextForBudget(task, 100, { preserveTail: false })}` : "";
        })
        .filter(Boolean)
    : [];
  const pendingQuestions = Array.isArray(activeTask.pending_questions)
    ? activeTask.pending_questions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return [
    cleanText(activeTask.id) ? `task_id: ${cleanText(activeTask.id)}` : "",
    cleanText(activeTask.objective) ? `objective: ${trimTextForBudget(activeTask.objective, 180, { preserveTail: false })}` : "",
    cleanText(activeTask.primary_agent_id) ? `primary_agent_id: ${cleanText(activeTask.primary_agent_id)}` : "",
    cleanText(activeTask.current_agent_id) ? `current_agent_id: ${cleanText(activeTask.current_agent_id)}` : "",
    workPlan.length > 0
      ? `work_plan: ${stringifyPlannerList(workPlan, { maxItems: 4, maxItemChars: 120 })}`
      : "",
    pendingQuestions.length > 0
      ? `pending_questions: ${stringifyPlannerList(pendingQuestions, { maxItems: 3, maxItemChars: 100 })}`
      : "",
  ].filter(Boolean).join("\n") || "none";
}

function buildPlannerRecentDialogueText(recentMessages = []) {
  return Array.isArray(recentMessages) && recentMessages.length > 0
    ? recentMessages
        .slice(-4)
        .map((message) => {
          const role = cleanText(message?.role || "message");
          const content = cleanText(message?.content || "");
          return content ? `${role}: ${trimTextForBudget(content, 90, { preserveTail: false })}` : "";
        })
        .filter(Boolean)
        .join("\n") || "none"
    : "none";
}

function fitPlannerContextWindow(entries = [], maxChars = PLANNER_CONTEXT_WINDOW_MAX_CHARS) {
  const sortedEntries = [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => cleanText(entry?.text) && cleanText(entry?.text) !== "none")
    .sort((left, right) => Number(right?.priority || 0) - Number(left?.priority || 0));
  const sections = {};
  const dropped = [];
  let remainingChars = Math.max(0, maxChars);

  for (const entry of sortedEntries) {
    if (remainingChars <= 0) {
      dropped.push(cleanText(entry?.label || entry?.name || "context"));
      continue;
    }
    const minChars = Number.isFinite(entry?.minChars) ? Number(entry.minChars) : 80;
    const maxEntryChars = Number.isFinite(entry?.maxChars) ? Number(entry.maxChars) : remainingChars;
    const budgetChars = Math.min(maxEntryChars, remainingChars);
    if (budgetChars < minChars) {
      dropped.push(cleanText(entry?.label || entry?.name || "context"));
      continue;
    }
    const compacted = trimTextForBudget(entry.text, budgetChars, {
      keywords: Array.isArray(entry?.keywords) ? entry.keywords : [],
      preserveTail: entry?.preserveTail !== false,
    });
    if (!compacted) {
      continue;
    }
    sections[entry.name] = compacted;
    remainingChars -= compacted.length;
  }

  const droppedSummary = dropped.length > 0
    ? trimTextForBudget(
      `舊上下文已摘要或丟棄：${dropped.join("、")}`,
      Math.min(remainingChars || PLANNER_CONTEXT_WINDOW_SUMMARY_MAX_CHARS, PLANNER_CONTEXT_WINDOW_SUMMARY_MAX_CHARS),
      { preserveTail: false },
    )
    : "none";

  return {
    sections,
    dropped,
    droppedSummary,
  };
}

function buildPlannerContextWindow({
  latestSummary = null,
  recentMessages = [],
  plannerDocQueryContext = {},
  taskDecisionContext = null,
  activeTask = null,
} = {}) {
  return fitPlannerContextWindow([
    {
      name: "focused_task",
      label: "focused_task",
      text: buildFocusedTaskContextText(taskDecisionContext),
      priority: 100,
      maxChars: 620,
      minChars: 120,
      keywords: [
        cleanText(taskDecisionContext?.focused_task?.title || ""),
        cleanText(taskDecisionContext?.focused_task?.source_title || ""),
      ],
      preserveTail: false,
    },
    {
      name: "recent_steps",
      label: "recent_steps",
      text: buildPlannerRecentStepsText({ activeTask, recentMessages }),
      priority: 95,
      maxChars: 520,
      minChars: 120,
      preserveTail: false,
    },
    {
      name: "high_weight_doc_summaries",
      label: "high_weight_doc_summaries",
      text: buildPlannerHighWeightDocSummaryText({
        taskDecisionContext,
        latestSummary,
        plannerDocQueryContext,
      }),
      priority: 90,
      maxChars: 680,
      minChars: 140,
      keywords: [
        cleanText(taskDecisionContext?.focused_task?.source_title || ""),
        cleanText(plannerDocQueryContext?.activeDoc?.title || latestSummary?.active_doc?.title || ""),
      ],
      preserveTail: false,
    },
    {
      name: "planner_task_context",
      label: "planner_task_context",
      text: formatPlannerTaskDecisionPromptSection(taskDecisionContext),
      priority: 85,
      maxChars: 520,
      minChars: 120,
      preserveTail: false,
    },
    {
      name: "latest_summary",
      label: "latest_summary",
      text: buildPlannerLatestSummaryText(latestSummary),
      priority: 65,
      maxChars: 360,
      minChars: 100,
      preserveTail: false,
    },
    {
      name: "active_task",
      label: "active_task",
      text: buildPlannerActiveTaskText(activeTask),
      priority: 55,
      maxChars: 360,
      minChars: 100,
      preserveTail: false,
    },
    {
      name: "recent_dialogue",
      label: "recent_dialogue",
      text: buildPlannerRecentDialogueText(recentMessages),
      priority: 45,
      maxChars: 260,
      minChars: 80,
      preserveTail: false,
    },
  ]);
}

async function buildPlannerPrompt({ text, activeTask = null, sessionKey = "" } = {}) {
  const memorySnapshot = getPlannerConversationMemoryLayer({ sessionKey });
  const latestSummary = memorySnapshot?.latest_summary || null;
  const recentMessages = Array.isArray(memorySnapshot?.recent_messages) ? memorySnapshot.recent_messages : [];
  const plannerDocQueryContext = getPlannerDocQueryContext({ sessionKey });
  const taskDecisionContext = await getPlannerTaskDecisionContext({
    activeDoc: plannerDocQueryContext?.activeDoc || null,
    activeTheme: plannerDocQueryContext?.activeTheme || "",
    userIntent: text,
  });
  const contextWindow = buildPlannerContextWindow({
    latestSummary,
    recentMessages,
    plannerDocQueryContext,
    taskDecisionContext,
    activeTask,
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
    "work_items 僅保留必要工作項，每項必須有 agent_id、task、role，最多 3 條。",
  ]);

  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
    maxTokens: 760,
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
          "最多 3 個角色，包含主責在內。",
          "若有 supporting agent，supporting_agent_ids 最多 2 個，且不要重複 primary_agent_id。",
          "若不需要 supporting agent，supporting_agent_ids 回傳空陣列。",
          "若不需要問題，pending_questions 回傳空陣列。",
          "若不需要工作項，work_items 回傳空陣列；若需要，最多 3 項且每個 agent 只出現一次。",
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
        summaryText: [
          "輸出單一合法 JSON 物件，不要有前後文。",
          'shape: {"action":"start|continue|handoff|clarify","objective":"...","primary_agent_id":"...","next_agent_id":"...","supporting_agent_ids":["..."],"reason":"...","pending_questions":[],"work_items":[]}',
          "優先沿用 focused task、unfinished、blocked、in_progress 提示。",
          "list/search/detail 必須分清楚；找資料前先嘗試對應 tool。",
          "pending_questions 最多 4 條；work_items 最多 3 條；supporting_agent_ids 最多 2 個。",
        ].join("\n"),
        required: true,
        maxTokens: 200,
      },
      {
        name: "agent_registry",
        label: "agent_registry",
        text: agentCatalogText(),
        summaryText: listRegisteredAgents().map((agent) => agent.id).join(", "),
        required: true,
        maxTokens: 160,
      },
      {
        name: "focused_task",
        label: "focused_task",
        text: contextWindow.sections.focused_task || "none",
        summaryText: contextWindow.sections.focused_task || "none",
        required: true,
        maxTokens: 150,
      },
      {
        name: "recent_steps",
        label: "recent_steps",
        text: contextWindow.sections.recent_steps || "none",
        summaryText: contextWindow.sections.recent_steps || "none",
        required: true,
        maxTokens: 130,
      },
      {
        name: "high_weight_doc_summaries",
        label: "high_weight_doc_summaries",
        text: contextWindow.sections.high_weight_doc_summaries || "none",
        summaryText: contextWindow.sections.high_weight_doc_summaries || "none",
        required: true,
        maxTokens: 170,
      },
      {
        name: "latest_summary",
        label: "latest_summary",
        text: contextWindow.sections.latest_summary || "none",
        summaryText: contextWindow.sections.latest_summary || "none",
        required: true,
        maxTokens: 110,
      },
      {
        name: "recent_dialogue",
        label: "recent_dialogue",
        text: contextWindow.sections.recent_dialogue || "none",
        summaryText: contextWindow.sections.recent_dialogue || "none",
        maxTokens: 70,
      },
      {
        name: "planner_task_context",
        label: "planner_task_context",
        text: contextWindow.sections.planner_task_context || "none",
        summaryText: contextWindow.sections.planner_task_context || "none",
        required: true,
        maxTokens: 150,
      },
      {
        name: "active_task",
        label: "active_task",
        text: contextWindow.sections.active_task || "none",
        summaryText: contextWindow.sections.active_task || "none",
        maxTokens: 100,
      },
      {
        name: "older_context",
        label: "older_context",
        text: contextWindow.droppedSummary || "none",
        summaryText: contextWindow.droppedSummary || "none",
        maxTokens: 60,
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
  signal = null,
} = {}) {
  throwIfPlannerSignalAborted(signal);
  if (!llmApiKey) {
    return callOpenClawTextGeneration({
      systemPrompt,
      prompt,
      sessionIdSuffix,
      signal,
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
    signal,
  });
  const data = await response.json();
  throwIfPlannerSignalAborted(signal);
  if (!response.ok) {
    throw new Error(data.error?.message || `executive_planner_failed:${response.status}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function buildPlannerUserInputPrompt({ text = "", sessionKey = "" } = {}) {
  restorePlannerRuntimeContextFromSummary({ sessionKey });
  const latestSummary = getPlannerConversationMemoryLayer({ sessionKey })?.latest_summary || null;
  const recentMessages = (getPlannerConversationMemoryLayer({ sessionKey })?.recent_messages || []).slice(-4);
  const docQueryContext = getPlannerDocQueryContext({ sessionKey });
  const systemPrompt = buildCompactSystemPrompt("你是 Lobster user-input planner。", [
    "所有 user input 必須先被規劃成受控 planner action/preset，禁止直接回答問題。",
    "只輸出單一合法 JSON object，不要 Markdown、不要 code fence、不要前後文、不要多餘欄位。",
    '合法 shape 只有兩種：{"action":"...","params":{}} 或 {"steps":[{"action":"...","params":{}}]}。',
    "單步任務可用相容模式 action/params；只有明確需要多步時才輸出 steps。",
    "action 必須完全對應 target_catalog 裡的名稱。",
    "steps 內的 action 只能使用 type=action 條目，不可放 preset。",
    "params 必須是 object，且需符合對應 contract 的 required params。",
    "如果已有 active_doc 或 active_candidates，優先利用那些 doc_id 做 detail/read 決策。",
    "看文件列表用 list，找資料用 search，讀某份文件內容才用 detail；不要混用。",
    "不可因 recent_dialogue 或 latest_summary 而直接重用上一輪 decision；只有明確是同一 task follow-up 才能沿用。",
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
          '唯一合法 shape 只有兩種：{"action":"...","params":{}} 或 {"steps":[{"action":"...","params":{}}]}。',
          "單步任務可用相容模式 action/params；只有明確需要多步時才輸出 steps。",
          "action 必須來自 target_catalog。",
          "steps 內 action 只能來自 type=action 條目，不可使用 preset。",
          "params 只能放該 action/preset 需要的欄位。",
          "不可直接複製上一輪 decision；如果 user_request 和前一輪不是同一 task，必須重新決策。",
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

function normalizePlannerUserInputText(text = "") {
  return cleanText(String(text || "").toLowerCase()).replace(/\s+/g, " ");
}

function plannerTextHasAny(text = "", keywords = []) {
  return keywords.some((keyword) => text.includes(keyword));
}

function derivePlannerUserInputSemantics(text = "") {
  const normalizedText = normalizePlannerUserInputText(text);
  const conversationSummarySignals = [
    "最近對話",
    "最近对话",
    "最近聊天",
    "最近訊息",
    "最近消息",
    "summary recent conversation",
    "summarize recent conversation",
    "總結最近",
    "总结最近",
    "總結對話",
    "总结对话",
    "整理對話",
    "整理对话",
    "整理聊天",
  ];
  const documentSignals = [
    "文件",
    "文檔",
    "文档",
    "doc",
    "wiki",
    "knowledge",
    "知識",
    "知识",
  ];
  const documentSummarySignals = [
    "整理",
    "總結",
    "总结",
    "摘要",
    "重點",
    "重点",
    "summary",
  ];
  const documentDetailSignals = [
    ...documentSummarySignals,
    "解釋",
    "解释",
    "說明",
    "说明",
    "打開",
    "打开",
    "讀",
    "读",
    "內容",
    "内容",
    "寫了什麼",
    "写了什么",
    "這份文件",
    "这份文件",
    "那份文件",
    "那个文件",
    "這個文件",
    "这个文件",
    "這份",
    "这份",
    "那份",
    "這個",
    "这个",
  ];
  const documentListSignals = [
    "列出",
    "列表",
    "清單",
    "清单",
    "list doc",
    "list docs",
    "文件列表",
    "文檔列表",
    "文档列表",
    "docs list",
    "有哪些文件",
    "有哪些文檔",
    "有哪些文档",
  ];
  const explicitMultiStepSignals = [
    "先",
    "再",
    "然後",
    "然后",
    "之後",
    "之后",
    "接著",
    "接着",
    "最後",
    "最后",
    " after ",
    " then ",
    "create then",
    "建立文件後",
    "建立後",
    "创建文档后",
    "並查詢",
    "并查询",
    "並列出",
    "并列出",
  ];
  const sameTaskSignals = [
    "這個",
    "这个",
    "這份",
    "这份",
    "同一",
    "上一輪",
    "上一轮",
    "剛剛那個",
    "刚刚那个",
    "延續",
    "延续",
    "繼續",
    "继续",
    "same task",
  ];

  const wantsConversationSummary = plannerTextHasAny(normalizedText, conversationSummarySignals);
  const wantsDocumentSummary =
    plannerTextHasAny(normalizedText, documentSummarySignals) && plannerTextHasAny(normalizedText, documentSignals);
  const wantsDocumentList =
    plannerTextHasAny(normalizedText, documentListSignals)
    && plannerTextHasAny(normalizedText, documentSignals);
  const wantsDocumentDetail =
    plannerTextHasAny(normalizedText, documentDetailSignals)
    && (
      plannerTextHasAny(normalizedText, documentSignals)
      || /這份|这份|那份|這個|这个/.test(normalizedText)
    );
  const wantsRuntimeInfo = plannerTextHasAny(normalizedText, [
    "runtime",
    "db path",
    "pid",
    "cwd",
    "service start",
    "運行資訊",
    "运行信息",
  ]);
  const wantsUnsupportedSlashCommand = looksLikeUnsupportedSlashPlannerRequest(normalizedText);
  const wantsMissingAgentRequest = looksLikeMissingAgentPlannerRequest(normalizedText);
  const wantsCreateDoc = plannerTextHasAny(normalizedText, [
    "建立文件",
    "创建文档",
    "create doc",
    "新建文件",
  ]);
  const wantsScopedDocExclusionSearch = hasScopedDocExclusionSearchIntent(normalizedText);
  const wantsDocumentSearch =
    wantsScopedDocExclusionSearch
    || hasDocSearchIntent(normalizedText)
    || plannerTextHasAny(normalizedText, [
      "找文件",
      "查文件",
      "搜尋文件",
      "搜索文件",
      "查知識",
      "查知识",
      "search doc",
      "search docs",
      "search company brain",
    ]);
  const wantsDocumentLookup = wantsDocumentList || wantsDocumentSummary || wantsDocumentDetail || wantsDocumentSearch || plannerTextHasAny(normalizedText, [
    "company brain",
    "知識庫",
    "知识库",
  ]);

  return {
    normalized_text: normalizedText,
    wants_conversation_summary: wantsConversationSummary,
    wants_document_summary: wantsDocumentSummary,
    wants_document_list: wantsDocumentList,
    wants_document_search: wantsDocumentSearch,
    wants_document_detail: wantsDocumentDetail,
    wants_document_lookup: wantsDocumentLookup,
    wants_runtime_info: wantsRuntimeInfo,
    wants_unsupported_slash_command: wantsUnsupportedSlashCommand,
    wants_missing_agent_request: wantsMissingAgentRequest,
    wants_create_doc: wantsCreateDoc,
    wants_scoped_doc_exclusion_search: wantsScopedDocExclusionSearch,
    wants_explicit_multi_step: plannerTextHasAny(normalizedText, explicitMultiStepSignals),
    explicit_same_task: plannerTextHasAny(normalizedText, sameTaskSignals),
  };
}

function buildPlannerConservativeSearchParams({
  text = "",
  params = {},
} = {}) {
  const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
    ? normalizePlannerPayload(params)
    : {};
  const q = cleanText(
    normalizedParams.q
    || normalizedParams.query
    || normalizedParams.keyword
    || normalizedParams.title
    || text,
  );
  if (!q) {
    return null;
  }
  return {
    ...normalizedParams,
    q,
  };
}

function buildPlannerSingleStepDecision(action = "", params = {}) {
  return {
    action: cleanText(action || ""),
    params: params && typeof params === "object" && !Array.isArray(params)
      ? normalizePlannerPayload(params)
      : {},
  };
}

function hardenPlannerUserInputDecisionCandidate({
  text = "",
  decision = {},
} = {}) {
  const normalizedDecision = decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision
    : {};
  const semantics = derivePlannerUserInputSemantics(text);
  const rawSteps = Array.isArray(normalizedDecision.steps) ? normalizedDecision.steps : null;

  if (rawSteps && rawSteps.length > 0) {
    const firstStep = rawSteps[0];
    const firstAction = cleanText(firstStep?.action || "");
    const firstParams = firstStep?.params && typeof firstStep.params === "object" && !Array.isArray(firstStep.params)
      ? normalizePlannerPayload(firstStep.params)
      : {};

    if (semantics.wants_runtime_info && !semantics.wants_document_list && firstAction === "get_runtime_info") {
      return {
        decision: buildPlannerSingleStepDecision("get_runtime_info", firstParams),
        reason: "runtime_query_prefers_single_step",
      };
    }

    if (
      semantics.wants_create_doc
      && !semantics.wants_document_list
      && !semantics.wants_document_search
      && !semantics.wants_document_detail
      && !semantics.wants_explicit_multi_step
      && firstAction === "create_doc"
    ) {
      return {
        decision: buildPlannerSingleStepDecision("create_doc", firstParams),
        reason: "create_doc_prefers_single_step",
      };
    }

    if (
      semantics.wants_document_list
      && !semantics.wants_document_search
      && !semantics.wants_document_detail
      && firstAction === "list_company_brain_docs"
    ) {
      return {
        decision: buildPlannerSingleStepDecision("list_company_brain_docs", firstParams),
        reason: "document_list_prefers_single_step",
      };
    }

    if (
      semantics.wants_document_search
      && !semantics.wants_document_detail
      && firstAction === "search_company_brain_docs"
    ) {
      return {
        decision: buildPlannerSingleStepDecision(
          "search_company_brain_docs",
          buildPlannerConservativeSearchParams({ text, params: firstParams }) || firstParams,
        ),
        reason: "document_search_prefers_single_step",
      };
    }

    return {
      decision: normalizedDecision,
      reason: null,
    };
  }

  const action = cleanText(normalizedDecision.action || "");
  const params = normalizedDecision.params && typeof normalizedDecision.params === "object" && !Array.isArray(normalizedDecision.params)
    ? normalizePlannerPayload(normalizedDecision.params)
    : normalizedDecision.params;

  if (action === "runtime_and_list_docs" && semantics.wants_runtime_info && !semantics.wants_document_list) {
    return {
      decision: buildPlannerSingleStepDecision("get_runtime_info", {}),
      reason: "runtime_query_prefers_single_step",
    };
  }

  if (
    ["create_and_list_doc", "create_search_detail_list_doc"].includes(action)
    && semantics.wants_create_doc
    && !semantics.wants_document_list
    && !semantics.wants_document_search
    && !semantics.wants_document_detail
    && !semantics.wants_explicit_multi_step
  ) {
    return {
      decision: buildPlannerSingleStepDecision("create_doc", params),
      reason: "create_doc_prefers_single_step",
    };
  }

  if (action === "search_and_detail_doc") {
    const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
    const docId = cleanText(normalizedParams.doc_id || "");
    if (docId) {
      return {
        decision: buildPlannerSingleStepDecision("get_company_brain_doc_detail", { doc_id: docId }),
        reason: "doc_detail_with_doc_id_prefers_single_step",
      };
    }
    if (semantics.wants_document_search && !semantics.wants_document_detail) {
      const searchParams = buildPlannerConservativeSearchParams({
        text,
        params: normalizedParams,
      });
      if (searchParams) {
        return {
          decision: buildPlannerSingleStepDecision("search_company_brain_docs", searchParams),
          reason: "document_search_prefers_single_step",
        };
      }
    }
  }

  if (action === "get_company_brain_doc_detail") {
    const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
    const docId = cleanText(normalizedParams.doc_id || "");
    if (!docId) {
      const searchParams = buildPlannerConservativeSearchParams({
        text,
        params: normalizedParams,
      });
      if (searchParams) {
        return {
          decision: buildPlannerSingleStepDecision("search_company_brain_docs", searchParams),
          reason: "missing_doc_id_downgraded_to_search",
        };
      }
    }
  }

  if (action === "search_company_brain_docs") {
    const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
    const searchParams = buildPlannerConservativeSearchParams({
      text,
      params: normalizedParams,
    });
    if (searchParams) {
      return {
        decision: buildPlannerSingleStepDecision("search_company_brain_docs", searchParams),
        reason: cleanText(normalizedParams.q || normalizedParams.query || "") ? null : "search_query_filled_from_user_request",
      };
    }
    if (semantics.wants_document_list && !semantics.wants_document_search) {
      return {
        decision: buildPlannerSingleStepDecision("list_company_brain_docs", normalizedParams),
        reason: "document_list_prefers_single_step",
      };
    }
  }

  return {
    decision: normalizedDecision,
    reason: null,
  };
}

function collectPlannerDecisionActionNames(decision = {}) {
  if (Array.isArray(decision?.steps)) {
    return decision.steps
      .map((step) => cleanText(step?.action || ""))
      .filter(Boolean);
  }
  const action = cleanText(decision?.action || "");
  return action ? [action] : [];
}

function buildPlannerSemanticMismatch({
  decision = {},
  reason = "",
  semantics = null,
} = {}) {
  return {
    error: "semantic_mismatch",
    action: cleanText(decision?.action || "") || null,
    params: normalizePlannerPayload(decision?.params),
    ...(Array.isArray(decision?.steps) ? { steps: decision.steps } : {}),
    reason: cleanText(reason) || "planner_action_semantically_mismatched",
    semantics,
  };
}

function validatePlannerDecisionSemantics({
  text = "",
  decision = {},
} = {}) {
  const semantics = derivePlannerUserInputSemantics(text);
  const actionNames = collectPlannerDecisionActionNames(decision);
  const allowedDocumentActions = new Set([
    "list_company_brain_docs",
    "search_company_brain_docs",
    "get_company_brain_doc_detail",
    "search_and_detail_doc",
    "runtime_and_list_docs",
    "create_search_detail_list_doc",
  ]);
  const allowedCreateActions = new Set([
    "create_doc",
    "create_and_list_doc",
    "create_search_detail_list_doc",
  ]);
  const allowedCreateContinuationActions = new Set([
    ...allowedCreateActions,
    "list_company_brain_docs",
    "search_company_brain_docs",
    "get_company_brain_doc_detail",
  ]);

  if (semantics.wants_conversation_summary) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "conversation_summary_not_supported_by_planner_contract",
        semantics,
      }),
    };
  }

  if (semantics.wants_unsupported_slash_command && actionNames.length > 0) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "slash_command_not_supported_by_planner_tool_flow",
        semantics,
      }),
    };
  }

  if (semantics.wants_missing_agent_request && actionNames.length > 0) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "missing_agent_request_not_supported_by_planner_tool_flow",
        semantics,
      }),
    };
  }

  if (semantics.wants_runtime_info && actionNames.some((name) => name !== "get_runtime_info")) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "runtime_query_routed_to_non_runtime_action",
        semantics,
      }),
    };
  }

  if (
    semantics.wants_create_doc
    && (
      !actionNames.some((name) => allowedCreateActions.has(name))
      || actionNames.some((name) => !allowedCreateContinuationActions.has(name))
    )
  ) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "document_create_query_routed_to_non_create_action",
        semantics,
      }),
    };
  }

  if (
    semantics.wants_document_lookup
    && !semantics.wants_create_doc
    && actionNames.some((name) => !allowedDocumentActions.has(name))
  ) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "document_lookup_query_routed_to_non_document_action",
        semantics,
      }),
    };
  }

  return {
    ok: true,
    semantics,
  };
}

function parsePlannerConversationDecision(value = "") {
  const text = cleanText(value);
  if (!text || !text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getLatestPlannerDecisionContext({ sessionKey = "" } = {}) {
  const recentMessages = Array.isArray(getPlannerConversationMemoryLayer({ sessionKey })?.recent_messages)
    ? getPlannerConversationMemoryLayer({ sessionKey }).recent_messages
    : [];
  let plannerMessage = null;
  let userMessage = null;
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    if (!plannerMessage && message?.role === "planner") {
      plannerMessage = message;
      continue;
    }
    if (plannerMessage && message?.role === "user") {
      userMessage = message;
      break;
    }
  }

  const previousDecision = parsePlannerConversationDecision(plannerMessage?.content || "");
  const previousUserText = cleanText(userMessage?.content || "");
  if (!previousDecision || !previousUserText) {
    return null;
  }

  return {
    previous_user_text: previousUserText,
    previous_user_semantics: derivePlannerUserInputSemantics(previousUserText),
    previous_decision: previousDecision,
  };
}

function canonicalizePlannerDecision(decision = {}) {
  if (!decision || typeof decision !== "object") {
    return "";
  }
  if (Array.isArray(decision.steps)) {
    return JSON.stringify({
      steps: decision.steps.map((step) => ({
        action: cleanText(step?.action || ""),
        params: normalizePlannerPayload(step?.params),
      })),
    });
  }
  return JSON.stringify({
    action: cleanText(decision.action || ""),
    params: normalizePlannerPayload(decision.params),
  });
}

function validatePlannerDecisionFreshness({
  text = "",
  decision = {},
  sessionKey = "",
} = {}) {
  const latestContext = getLatestPlannerDecisionContext({ sessionKey });
  if (!latestContext?.previous_decision) {
    return { ok: true };
  }

  const currentText = normalizePlannerUserInputText(text);
  const previousText = normalizePlannerUserInputText(latestContext.previous_user_text);
  if (!currentText || !previousText || currentText === previousText) {
    return { ok: true };
  }

  const currentSemantics = derivePlannerUserInputSemantics(text);
  if (currentSemantics.explicit_same_task) {
    return { ok: true };
  }

  if (canonicalizePlannerDecision(decision) !== canonicalizePlannerDecision(latestContext.previous_decision)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: "stale_decision_reused",
    action: cleanText(decision?.action || "") || null,
    params: normalizePlannerPayload(decision?.params),
    ...(Array.isArray(decision?.steps) ? { steps: decision.steps } : {}),
    reason: "decision_identical_to_previous_turn_without_explicit_same_task",
    previous_user_text: latestContext.previous_user_text,
  };
}

function buildUserInputDecisionAlternative(decision = {}) {
  if (Array.isArray(decision?.steps) && decision.steps.length > 0) {
    return normalizeDecisionAlternative({
      action: cleanText(decision.steps[0]?.action || "") || null,
      summary: "也可只先執行第一步取得中間結果，但這輪需求需要完整多步流程。",
    });
  }

  const action = cleanText(decision?.action || "");
  switch (action) {
    case "list_company_brain_docs":
      return normalizeDecisionAlternative({
        action: "search_company_brain_docs",
        summary: "若需要縮小範圍，也可先 search；這輪需求更像直接看清單。",
      });
    case "search_company_brain_docs":
      return normalizeDecisionAlternative({
        action: "get_company_brain_doc_detail",
        summary: "若已經有明確 doc_id，也可直接 detail；這輪先 search 是因為尚未鎖定單一文件。",
      });
    case "get_company_brain_doc_detail":
      return normalizeDecisionAlternative({
        action: "search_company_brain_docs",
        summary: "也可先 search 候選文件；這輪已有足夠定位資訊可直接 detail。",
      });
    case "search_and_detail_doc":
      return normalizeDecisionAlternative({
        action: "search_company_brain_docs",
        summary: "也可只先 search 候選文件；這輪需要直接推進到單一文件內容。",
      });
    case "create_doc":
      return normalizeDecisionAlternative({
        action: "create_and_list_doc",
        summary: "也可建立後順手列出文件；這輪只需要先完成建立。",
      });
    case "create_and_list_doc":
      return normalizeDecisionAlternative({
        action: "create_doc",
        summary: "也可只先建立文件；這輪多加 list 是為了立即確認結果。",
      });
    case "runtime_and_list_docs":
      return normalizeDecisionAlternative({
        action: "get_runtime_info",
        summary: "也可只看 runtime 狀態；這輪多加 list 是為了把環境與文件鏡像一起對齊。",
      });
    case "create_search_detail_list_doc":
      return normalizeDecisionAlternative({
        action: "create_doc",
        summary: "也可只先建立文件；這輪選完整 preset 是因為需求包含後續查找與確認。",
      });
    default:
      return normalizeDecisionAlternative({
        action: null,
        summary: "沒有更簡單且同樣安全的替代 action。",
      });
  }
}

function buildUserInputDecisionWhy({
  result = {},
  semantics = null,
} = {}) {
  if (cleanText(result?.reason || "")) {
    if (result?.error) {
      return cleanText(result.reason);
    }
  }

  if (result?.error) {
    switch (cleanText(result.error)) {
      case "semantic_mismatch":
        return "這個 decision 和使用者意圖不一致，所以被 runtime 拒絕。";
      case "stale_decision_reused":
        return "這個 decision 和上一輪完全相同，但目前訊息不是明確的同 task 延續。";
      case INVALID_ACTION:
      case "invalid_action":
        return "模型選到 contract 之外的 action，所以不能直接執行。";
      case ROUTING_NO_MATCH:
        return "目前 routing 沒有命中任何受控 action，所以被 fail-closed 拒絕。";
      case "contract_violation":
        return "decision 的 params 不符合對應 action contract，所以不能安全執行。";
      case FALLBACK_DISABLED:
        return "原本的 fallback 路徑已被關閉，所以這輪會直接停在結構化錯誤。";
      default:
        return "這一輪 planner 沒有產出可安全執行的合法 decision。";
    }
  }

  if (Array.isArray(result?.steps) && result.steps.length > 0) {
    return `使用者需求包含順序依賴，所以決策成 ${result.steps.map((step) => cleanText(step?.action || "")).filter(Boolean).join(" -> ")}。`;
  }

  if (semantics?.wants_runtime_info) {
    return "需求明確在查 runtime / db path / pid 等執行環境資訊。";
  }
  if (semantics?.wants_unsupported_slash_command) {
    return "這輪輸入是未支援的 slash 指令，不應被 planner 工具路徑當成一般查詢執行。";
  }
  if (semantics?.wants_missing_agent_request) {
    return "這輪是在描述不存在的 agent/調用需求，不應被 planner 工具路徑改寫成其他查詢。";
  }
  if (semantics?.wants_create_doc) {
    return "需求核心是建立文件，所以先走受控文件建立路徑。";
  }
  if (cleanText(result?.action || "") === "get_company_brain_doc_detail") {
    return "這輪已經有足夠線索指向單一文件，所以直接走 detail。";
  }
  if (cleanText(result?.action || "") === "search_company_brain_docs") {
    return "需求偏向查資料或找文件，先 search 才能定位候選來源。";
  }
  if (cleanText(result?.action || "") === "list_company_brain_docs") {
    return "需求偏向列出已驗證文件鏡像，而不是鎖定單一文件內容。";
  }
  return "這個 action 最接近目前 user_request，且仍在受控 planner contract 內。";
}

function withUserInputDecisionExplanation(result = {}, {
  text = "",
  semantics = null,
} = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const effectiveSemantics = semantics || derivePlannerUserInputSemantics(text);
  const why = cleanText(result?.why || "") || buildUserInputDecisionWhy({
    result,
    semantics: effectiveSemantics,
  });
  const alternative = normalizeDecisionAlternative(
    result?.alternative,
    buildUserInputDecisionAlternative(result),
  );

  return {
    ...result,
    why: why || null,
    alternative,
  };
}

export async function planUserInputAction({
  text = "",
  requester = requestPlannerJson,
  signal = null,
  sessionKey = "",
} = {}) {
  const preAbortInfo = derivePlannerAbortInfo({ signal });
  if (preAbortInfo) {
    return withUserInputDecisionExplanation({
      error: preAbortInfo.code,
      reason: preAbortInfo.code,
    }, { text });
  }
  restorePlannerRuntimeContextFromSummary({ sessionKey });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    reason: "pre_plan_user_input_action",
    sessionKey,
  });
  let promptInput = await buildPlannerUserInputPrompt({ text, sessionKey });
  let prompt = promptInput.prompt;
  let lastInvalidDecision = null;

  for (let attempt = 0; attempt <= llmJsonRetryMax; attempt += 1) {
    try {
      throwIfPlannerSignalAborted(signal);
      const raw = await requester({
        systemPrompt: promptInput.systemPrompt,
        prompt,
        sessionIdSuffix: cleanText(text).slice(0, 48) || "user-input-planner",
        signal,
      });
      throwIfPlannerSignalAborted(signal);
      const parsed = parseStrictPlannerUserInputJson(raw);
      const validation = validatePlannerUserInputDecision(parsed, { text });
      if (validation.ok) {
        const decision = withUserInputDecisionExplanation(Array.isArray(validation.steps)
          ? {
              steps: validation.steps,
            }
          : {
              action: validation.action,
              params: validation.params,
            }, {
          text,
        });
        const semanticValidation = validatePlannerDecisionSemantics({
          text,
          decision,
        });
        if (!semanticValidation.ok) {
          lastInvalidDecision = semanticValidation;
        } else {
          const freshnessValidation = validatePlannerDecisionFreshness({
            text,
            decision,
            sessionKey,
          });
          if (!freshnessValidation.ok) {
            lastInvalidDecision = freshnessValidation;
          } else {
            recordPlannerConversationExchange({
              userQuery: text,
              plannerReply: JSON.stringify(decision),
              sessionKey,
            });
            maybeCompactPlannerConversationMemory({
              flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
              latestSelectedAction: decision.action || decision.steps?.[0]?.action || "",
              reason: "post_plan_user_input_action",
              sessionKey,
            });
            return decision;
          }
        }
      }

      if (
        validation.error === INVALID_ACTION
        || validation.error === "invalid_action"
        || validation.error === "contract_violation"
        || validation.error === "semantic_mismatch"
        || validation.error === "stale_decision_reused"
      ) {
        lastInvalidDecision = validation;
        break;
      }
    } catch (error) {
      const abortInfo = derivePlannerAbortInfo({ signal, error });
      if (abortInfo) {
        const abortedResult = withUserInputDecisionExplanation({
          error: abortInfo.code,
          reason: abortInfo.code,
        }, { text });
        recordPlannerConversationExchange({
          userQuery: text,
          plannerReply: JSON.stringify(abortedResult),
          sessionKey,
        });
        maybeCompactPlannerConversationMemory({
          flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
          reason: "post_plan_user_input_action_aborted",
          sessionKey,
        });
        return abortedResult;
      }
      // Continue into the bounded retry path below.
    }

    if (attempt >= llmJsonRetryMax) {
      break;
    }
    promptInput = await buildPlannerUserInputPrompt({
      text: `${text}\n請只輸出合法 JSON，且僅能使用 target_catalog 的 action；不可沿用上一輪 decision，必須依這一輪 user_request 重新決策。`,
      sessionKey,
    });
    prompt = promptInput.prompt;
  }

  const errorResult = lastInvalidDecision
    ? withUserInputDecisionExplanation({
        error: lastInvalidDecision.error,
        action: lastInvalidDecision.action,
        params: lastInvalidDecision.params,
        ...(Array.isArray(lastInvalidDecision.steps) ? { steps: lastInvalidDecision.steps } : {}),
        ...(Number.isInteger(lastInvalidDecision.step_index) ? { step_index: lastInvalidDecision.step_index } : {}),
        ...(lastInvalidDecision.violations ? { violations: lastInvalidDecision.violations } : {}),
        ...(cleanText(lastInvalidDecision.reason || "") ? { reason: cleanText(lastInvalidDecision.reason) } : {}),
        ...(cleanText(lastInvalidDecision.previous_user_text || "") ? { previous_user_text: cleanText(lastInvalidDecision.previous_user_text) } : {}),
        ...(lastInvalidDecision.semantics ? { semantics: lastInvalidDecision.semantics } : {}),
      }, {
        text,
        semantics: lastInvalidDecision.semantics || null,
      })
    : withUserInputDecisionExplanation({ error: "planner_failed" }, { text });

  if (errorResult.error === "planner_failed") {
    emitPlannerFailedAlert({
      text,
      reason: cleanText(lastInvalidDecision?.reason || "") || "invalid_or_non_json_planner_output",
      source: "plan_user_input_action",
    });
  }

  recordPlannerConversationExchange({
    userQuery: text,
    plannerReply: JSON.stringify(errorResult),
    sessionKey,
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    reason: "post_plan_user_input_action_failed",
    sessionKey,
  });
  return errorResult;
}

export async function executePlannedUserInput({
  text = "",
  requester = requestPlannerJson,
  logger = console,
  contentReader,
  baseUrl = oauthBaseUrl,
  toolFlowRunner = runPlannerToolFlow,
  multiStepRunner = runPlannerMultiStep,
  dispatcher = dispatchPlannerTool,
  plannedDecision = null,
  resume_from_step = null,
  previous_results = [],
  max_retries = 0,
  retryable_error_types = ["tool_error", "runtime_exception"],
  authContext = null,
  signal = null,
  sessionKey = "",
} = {}) {
  const preAbortInfo = derivePlannerAbortInfo({ signal });
  if (preAbortInfo) {
    return {
      ok: false,
      error: preAbortInfo.code,
      execution_result: null,
      trace_id: null,
      why: null,
      alternative: normalizeDecisionAlternative(null),
    };
  }
  const decision = plannedDecision
    ? (() => {
        const validatedDecision = validatePlannerUserInputDecision(plannedDecision, { text });
        if (validatedDecision?.ok !== true) {
          return withUserInputDecisionExplanation(validatedDecision, { text });
        }
        return withUserInputDecisionExplanation(
          Array.isArray(validatedDecision.steps)
            ? { steps: validatedDecision.steps }
            : {
                action: validatedDecision.action,
                params: validatedDecision.params,
              },
          { text },
        );
      })()
    : await planUserInputAction({ text, requester, signal, sessionKey });
  if (decision?.error) {
    if (decision.error === "semantic_mismatch") {
      let reroutedResult = null;
      try {
        reroutedResult = await toolFlowRunner({
          userIntent: text,
          payload: {},
          logger,
          contentReader,
          baseUrl,
          authContext,
          signal,
          sessionKey,
        });
      } catch (error) {
        const abortedResult = buildPlannerAbortResult({
          signal,
          error,
        });
        if (abortedResult) {
          reroutedResult = buildPlannerAgentOutput({
            selectedAction: null,
            executionResult: abortedResult,
            traceId: abortedResult.trace_id || null,
            routingReason: "semantic_mismatch_reroute_aborted",
          });
        } else {
          throw error;
        }
      }

      if (reroutedResult?.execution_result) {
        logger?.info?.("planner_semantic_mismatch_reroute", {
          original_action: cleanText(decision?.action || decision?.steps?.[0]?.action || "") || null,
          rerouted_action: cleanText(reroutedResult?.selected_action || "") || null,
          reroute_ok: reroutedResult?.execution_result?.ok === true,
          reroute_error: cleanText(reroutedResult?.execution_result?.error || "") || null,
          reroute_reason: cleanText(reroutedResult?.routing_reason || "") || null,
          trace_id: reroutedResult?.trace_id || null,
        });
        return {
          ok: reroutedResult?.execution_result?.ok === true,
          action: cleanText(reroutedResult?.selected_action || "") || null,
          params: null,
          error: cleanText(reroutedResult?.execution_result?.error || "") || null,
          execution_result: reroutedResult?.execution_result || null,
          synthetic_agent_hint: reroutedResult?.synthetic_agent_hint || null,
          trace_id: reroutedResult?.trace_id || null,
          why: "原始 decision 與這輪需求不一致，所以先改走 reroute。",
          alternative: normalizeDecisionAlternative(decision?.alternative),
        };
      }
    }

    if (decision.error === "planner_failed") {
      emitPlannerFailedAlert({
        text,
        reason: "invalid_planned_decision",
        source: "execute_planned_user_input",
      });
    }
    return {
      ok: false,
      ...decision,
      execution_result: null,
      trace_id: null,
    };
  }

  if (Array.isArray(decision.steps)) {
    let runtimeResult;
    try {
      runtimeResult = await multiStepRunner({
        steps: decision.steps,
        logger,
        resume_from_step,
        previous_results,
        max_retries,
        retryable_error_types,
        authContext,
        signal,
        async dispatcher({ action, payload }) {
          return dispatcher({
            action,
            payload,
            logger,
            baseUrl,
            authContext,
            signal,
          });
        },
      });
    } catch (error) {
      const abortedResult = buildPlannerAbortResult({ signal, error });
      if (abortedResult) {
        runtimeResult = buildPlannerMultiStepOutput({
          ok: false,
          steps: decision.steps.map((step) => ({ action: step.action })),
          results: [],
          traceId: abortedResult.trace_id || null,
          error: abortedResult.error,
          stopped: true,
          stoppedAtStep: null,
          currentStepIndex: 0,
          lastError: buildPlannerLastErrorRecord(abortedResult),
          retryCount: 0,
        });
      } else {
        throw error;
      }
    }

    return {
      ok: runtimeResult?.ok === true,
      steps: decision.steps,
      error: cleanText(runtimeResult?.error || "") || null,
      execution_result: runtimeResult || null,
      trace_id: runtimeResult?.trace_id || null,
      why: cleanText(decision?.why || "") || null,
      alternative: normalizeDecisionAlternative(decision?.alternative),
    };
  }

  let runtimeResult;
  try {
    runtimeResult = await toolFlowRunner({
      userIntent: text,
      payload: decision.params,
      logger,
      contentReader,
      baseUrl,
      authContext,
      forcedSelection: {
        selected_action: decision.action,
        reason: "strict_user_input_planner",
      },
      disableAutoRouting: true,
      signal,
      sessionKey,
    });
  } catch (error) {
    const abortedResult = buildPlannerAbortResult({
      action: decision.action,
      signal,
      error,
    });
    if (abortedResult) {
      runtimeResult = buildPlannerAgentOutput({
        selectedAction: decision.action,
        executionResult: abortedResult,
        traceId: abortedResult.trace_id || null,
        routingReason: "strict_user_input_planner",
        payload: decision.params,
      });
    } else {
      throw error;
    }
  }

  return {
    ok: runtimeResult?.execution_result?.ok === true,
    action: decision.action,
    params: decision.params,
    error: cleanText(runtimeResult?.execution_result?.error || "") || null,
    execution_result: runtimeResult?.execution_result || null,
    synthetic_agent_hint: runtimeResult?.synthetic_agent_hint || null,
    trace_id: runtimeResult?.trace_id || null,
    why: cleanText(decision?.why || "") || null,
    alternative: normalizeDecisionAlternative(decision?.alternative),
  };
}

export function buildPlannedUserInputEnvelope(result = {}) {
  const chosenAction = cleanText(result.action || result.steps?.[0]?.action || "") || null;
  const fallbackReason = cleanText(
    result.reason
    || result.execution_result?.data?.reason
    || result.execution_result?.data?.stop_reason
    || result.error
    || "",
  ) || null;
  const reasoning = normalizeDecisionReasoning({
    why: result?.why || "",
    alternative: result?.alternative || null,
  });
  if (!result || typeof result !== "object") {
    emitPlannerFailedAlert({
      reason: "invalid_execution_result_shape",
      source: "planned_user_input_envelope",
    });
    return {
      ok: false,
      error: "planner_failed",
      trace_id: null,
      trace: {
        chosen_action: null,
        fallback_reason: "planner_failed",
        reasoning,
      },
    };
  }

  if (result.error && !result.execution_result) {
    if (cleanText(result.error || "") === "planner_failed") {
      emitPlannerFailedAlert({
        reason: cleanText(result.reason || "") || "planner_failed_without_execution_result",
        source: "planned_user_input_envelope",
      });
    }
    return {
      ok: false,
      error: cleanText(result.error || "") || "planner_failed",
      ...(cleanText(result.action || "") ? { action: cleanText(result.action) } : {}),
      params: normalizePlannerPayload(result.params),
      ...(Array.isArray(result.steps)
        ? {
            steps: result.steps
              .map((step) => ({
                action: cleanText(step?.action || "") || null,
                params: normalizePlannerPayload(step?.params),
              }))
              .filter((step) => step.action),
          }
        : {}),
      ...(Number.isInteger(result.step_index) ? { step_index: result.step_index } : {}),
      ...(Array.isArray(result.violations) ? { violations: result.violations } : {}),
      ...(cleanText(result.reason || "") ? { reason: cleanText(result.reason) } : {}),
      ...(cleanText(result.previous_user_text || "") ? { previous_user_text: cleanText(result.previous_user_text) } : {}),
      ...(result.semantics ? { semantics: result.semantics } : {}),
      why: reasoning.why,
      alternative: reasoning.alternative,
      trace_id: result.trace_id || null,
      trace: {
        chosen_action: chosenAction,
        fallback_reason: fallbackReason,
        reasoning,
      },
    };
  }

  return {
    ok: result.ok === true,
    action: cleanText(result.action || "") || null,
    params: normalizePlannerPayload(result.params),
    ...(Array.isArray(result.steps)
      ? {
          steps: result.steps
            .map((step) => ({
              action: cleanText(step?.action || "") || null,
              params: normalizePlannerPayload(step?.params),
            }))
            .filter((step) => step.action),
        }
      : {}),
    error: cleanText(result.error || "") || null,
    execution_result: result.execution_result?.formatted_output || result.execution_result || null,
    why: reasoning.why,
    alternative: reasoning.alternative,
    trace_id: result.trace_id || null,
    trace: {
      chosen_action: chosenAction,
      fallback_reason: fallbackReason,
      reasoning,
    },
  };
}

function buildExecutiveDecisionAlternative({
  action = "",
  activeTask = null,
  primaryAgentId = "",
  nextAgentId = "",
} = {}) {
  const currentAgentId = cleanText(activeTask?.current_agent_id || "");
  const primaryAgent = cleanText(primaryAgentId || "");
  const nextAgent = cleanText(nextAgentId || "");

  if (action === "handoff") {
    return normalizeDecisionAlternative({
      action: "continue",
      agent_id: currentAgentId || primaryAgent || null,
      summary: "也可維持目前 agent 繼續，但這輪判斷換手更能對準下一步工作型態。",
    });
  }

  if (action === "clarify") {
    return normalizeDecisionAlternative({
      action: activeTask ? "continue" : "start",
      agent_id: nextAgent || primaryAgent || "generalist",
      summary: "也可直接開始執行，但這輪判斷先補關鍵資訊更安全。",
    });
  }

  if (action === "continue") {
    return normalizeDecisionAlternative({
      action: "handoff",
      agent_id: nextAgent && nextAgent !== currentAgentId ? nextAgent : null,
      summary: "若下一步變得更專業化，也可 handoff；這輪先保留上下文連續性。",
    });
  }

  return normalizeDecisionAlternative({
    action: "clarify",
    agent_id: null,
    summary: "也可先問一個關鍵澄清問題；這輪判斷已有足夠資訊可以開始。",
  });
}

function buildExecutiveDecisionWhy({
  action = "",
  reason = "",
  nextAgentId = "",
} = {}) {
  const normalizedReason = cleanText(reason);
  const agentLabel = cleanText(nextAgentId) ? `/${cleanText(nextAgentId)}` : "目前 agent";

  if (action === "handoff") {
    return normalizedReason
      ? `${normalizedReason}，由 ${agentLabel} 接手更符合這輪任務所需能力。`
      : `這一輪需要換成 ${agentLabel} 接手，才能更直接推進目標。`;
  }
  if (action === "clarify") {
    return normalizedReason
      ? `${normalizedReason}，現在缺的資訊會直接阻塞下一步。`
      : "目前缺少關鍵資訊，直接往下做的風險高於先澄清。";
  }
  if (action === "continue") {
    return normalizedReason
      ? `${normalizedReason}，延續 ${agentLabel} 可以保留上下文與現有進度。`
      : `目前已有可延續的工作脈絡，先由 ${agentLabel} 繼續最穩定。`;
  }
  return normalizedReason
    ? `${normalizedReason}，先由 ${agentLabel} 啟動可以最快形成可執行路徑。`
    : `這看起來是新的工作輪次，先由 ${agentLabel} 啟動最穩定。`;
}

function normalizePlannerDecision(decision = {}, fallbackText = "", activeTask = null) {
  const primaryAgentId = cleanText(decision.primary_agent_id || decision.primary_agent || "");
  const nextAgentId = cleanText(decision.next_agent_id || decision.next_agent || primaryAgentId);
  const normalizedPrimaryAgentId = getRegisteredAgent(primaryAgentId) ? primaryAgentId : "generalist";
  const supportingAgentIds = [];
  const supportingSeen = new Set([normalizedPrimaryAgentId]);
  for (const item of Array.isArray(decision.supporting_agent_ids) ? decision.supporting_agent_ids : []) {
    const agentId = cleanText(item);
    if (!agentId || supportingSeen.has(agentId) || !getRegisteredAgent(agentId)) {
      continue;
    }
    supportingSeen.add(agentId);
    supportingAgentIds.push(agentId);
    if (supportingAgentIds.length >= EXECUTIVE_MAX_SUPPORTING_ROLES) {
      break;
    }
  }
  const workItems = [];
  const workItemSeen = new Set();
  for (const item of Array.isArray(decision.work_items) ? decision.work_items : []) {
    const requestedAgentId = cleanText(item?.agent_id || item?.agent || "");
    const normalizedAgentId = getRegisteredAgent(requestedAgentId) ? requestedAgentId : normalizedPrimaryAgentId;
    const task = cleanText(item?.task || "");
    if (!task || workItemSeen.has(normalizedAgentId)) {
      continue;
    }
    workItemSeen.add(normalizedAgentId);
    workItems.push({
      agent_id: normalizedAgentId,
      task,
      role: cleanText(item?.role || ""),
      status: "pending",
    });
    if (workItems.length >= EXECUTIVE_MAX_ROLES) {
      break;
    }
  }
  const normalized = {
    action: cleanText(decision.action || "continue") || "continue",
    objective: cleanText(decision.objective || fallbackText),
    primary_agent_id: normalizedPrimaryAgentId,
    next_agent_id: getRegisteredAgent(nextAgentId) ? nextAgentId : getRegisteredAgent(primaryAgentId) ? primaryAgentId : "generalist",
    supporting_agent_ids: supportingAgentIds,
    reason: cleanText(decision.reason || ""),
    pending_questions: Array.isArray(decision.pending_questions)
      ? decision.pending_questions.map((item) => cleanText(item)).filter(Boolean).slice(0, 4)
      : [],
    work_items: workItems,
  };

  const hardened = applyDeterministicExecutiveAgentSelection(normalized, fallbackText, activeTask);

  return {
    ...hardened,
    why: cleanText(decision?.why || "") || buildExecutiveDecisionWhy({
      action: hardened.action,
      reason: hardened.reason,
      nextAgentId: hardened.next_agent_id,
    }),
    alternative: normalizeDecisionAlternative(
      decision?.alternative,
      buildExecutiveDecisionAlternative({
        action: hardened.action,
        activeTask,
        primaryAgentId: hardened.primary_agent_id,
        nextAgentId: hardened.next_agent_id,
      }),
    ),
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

  normalizedDecision.why = buildExecutiveDecisionWhy({
    action: cleanText(normalizedDecision.action || ""),
    reason: cleanText(normalizedDecision.reason || ""),
    nextAgentId: cleanText(normalizedDecision.next_agent_id || ""),
  });
  normalizedDecision.alternative = normalizeDecisionAlternative(
    normalizedDecision.alternative,
    buildExecutiveDecisionAlternative({
      action: cleanText(normalizedDecision.action || ""),
      primaryAgentId: cleanText(normalizedDecision.primary_agent_id || ""),
      nextAgentId: cleanText(normalizedDecision.next_agent_id || ""),
    }),
  );

  return normalizedDecision;
}

export async function planExecutiveTurn({
  text = "",
  activeTask = null,
  requester = requestPlannerJson,
  logger = console,
  sessionKey = "",
} = {}) {
  restorePlannerRuntimeContextFromSummary({ sessionKey });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    logger,
    reason: "pre_plan_executive_turn",
    sessionKey,
  });
  const promptInput = await buildPlannerPrompt({ text, activeTask, sessionKey });
  let prompt = promptInput.prompt;

  for (let attempt = 0; attempt <= llmJsonRetryMax; attempt += 1) {
    try {
      const raw = await requester({
        systemPrompt: promptInput.systemPrompt,
        prompt,
        sessionIdSuffix: cleanText(activeTask?.id || text).slice(0, 48) || "executive-planner",
      });
      const normalizedDecision = enrichPlannerDecisionWithTaskDriving(
        normalizePlannerDecision(parsePlannerJson(raw), text, activeTask),
        {
          taskDecisionContext: promptInput.taskDecisionContext,
        },
      );
      logPlannerTrace(logger, "info", buildPlannerTraceEvent({
        eventType: "executive_decision",
        action: normalizedDecision.action,
        agent: normalizedDecision.next_agent_id,
        traceId: cleanText(activeTask?.trace_id || "") || null,
        reasoning: {
          why: normalizedDecision.why,
          alternative: normalizedDecision.alternative,
        },
        extra: {
          primary_agent_id: normalizedDecision.primary_agent_id,
          next_agent_id: normalizedDecision.next_agent_id,
          supporting_agent_ids: normalizedDecision.supporting_agent_ids,
          pending_questions_count: normalizedDecision.pending_questions.length,
          work_items_count: normalizedDecision.work_items.length,
        },
      }));
      recordPlannerConversationExchange({
        userQuery: text,
        plannerReply: JSON.stringify(normalizedDecision),
        sessionKey,
      });
      maybeCompactPlannerConversationMemory({
        flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
        logger,
        unfinishedItems: normalizedDecision.pending_questions.map((question) => ({
          type: "pending_question",
          label: question,
        })),
        latestSelectedAction: normalizedDecision.action,
        reason: "post_plan_executive_turn",
        sessionKey,
      });
      return normalizedDecision;
    } catch {
      if (attempt >= llmJsonRetryMax) {
        break;
      }
      prompt = (await buildPlannerPrompt({
        text: `${text}\n請只輸出合法 JSON。`,
        activeTask,
        sessionKey,
      })).prompt;
    }
  }

  const heuristicDecision = normalizePlannerDecision(
    heuristicPlanExecutiveTurn(text, activeTask),
    text,
    activeTask,
  );
  const blockedDecision = {
    error: FALLBACK_DISABLED,
    action: null,
    objective: heuristicDecision.objective || activeTask?.objective || text,
    primary_agent_id: heuristicDecision.primary_agent_id || "generalist",
    next_agent_id: heuristicDecision.next_agent_id || heuristicDecision.primary_agent_id || "generalist",
    supporting_agent_ids: Array.isArray(heuristicDecision.supporting_agent_ids) ? heuristicDecision.supporting_agent_ids : [],
    reason: "executive_planner_fallback_disabled",
    why: "LLM planner 沒有產出可用 JSON，而且 heuristic fallback 已被停用。",
    alternative: normalizeDecisionAlternative({
      action: "clarify",
      agent_id: heuristicDecision.next_agent_id || heuristicDecision.primary_agent_id || "generalist",
      summary: "如需繼續，必須先提供更明確的 agent 指令或讓 planner 重新產生合法 JSON。",
    }),
    pending_questions: [],
    work_items: Array.isArray(heuristicDecision.work_items) ? heuristicDecision.work_items : [],
  };
  logPlannerTrace(logger, "warn", buildPlannerTraceEvent({
    eventType: "executive_decision_failed",
    action: null,
    agent: blockedDecision.next_agent_id,
    traceId: cleanText(activeTask?.trace_id || "") || null,
    reasoning: {
      why: blockedDecision.why,
      alternative: blockedDecision.alternative,
    },
    extra: {
      error: FALLBACK_DISABLED,
    },
  }));
  recordPlannerConversationExchange({
    userQuery: text,
    plannerReply: JSON.stringify(blockedDecision),
    sessionKey,
  });
  maybeCompactPlannerConversationMemory({
    flows: buildPlannerFlowSnapshots(plannerFlows, { sessionKey }),
    logger,
    unfinishedItems: blockedDecision.pending_questions.map((question) => ({
      type: "pending_question",
      label: question,
    })),
    latestSelectedAction: "",
    reason: "post_plan_executive_turn_failed",
    sessionKey,
  });
  return blockedDecision;
}
