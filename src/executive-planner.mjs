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
import {
  getRegisteredAgent,
  listRegisteredAgents,
  listRegisteredPersonaAgents,
  parseRegisteredAgentCommand,
  resolveRegisteredAgentFamilyRequest,
} from "./agent-registry.mjs";
import {
  buildExplicitUserAuthHeaders,
  normalizeExplicitUserAuthContext,
} from "./explicit-user-auth.mjs";
import { getDocumentCreateGovernanceContract } from "./lark-write-guard.mjs";
import { cleanText, extractDocumentId } from "./message-intent-utils.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import { fetchDocumentPlainText } from "./skills/document-fetch.mjs";
import { FALLBACK_DISABLED, INVALID_ACTION, ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { hasDocSearchIntent, hasScopedDocExclusionSearchIntent } from "./router.js";
import { createRequestId, emitRateLimitedAlert, emitToolExecutionLog } from "./runtime-observability.mjs";
import { runTaskLayer } from "./task-layer/orchestrator.mjs";
import {
  normalizeTaskLayerResult,
  toUserFacing as taskLayerResultToUserFacing,
} from "./task-layer/task-to-answer.mjs";
import {
  readPlannerWorkingMemoryForRouting,
  compactPlannerConversationMemory as compactPlannerConversationMemoryLayer,
  getPlannerConversationMemory as getPlannerConversationMemoryLayer,
  maybeCompactPlannerConversationMemory,
  recordPlannerConversationMessages,
  resetPlannerConversationMemory,
} from "./planner-conversation-memory.mjs";
import { buildPlannerTaskTraceDiagnostics } from "./planner-working-memory-trace.mjs";
import {
  evaluateUsageLayerIntelligencePass,
  extractUsageLayerDiagnostics,
} from "./usage-layer-intelligence-pass.mjs";
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
  getPlannerFlowOwnership,
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
import {
  buildPlannerSkillSelectionTelemetry,
  getPlannerSkillAction,
  isPlannerSkillActionCatalogVisible,
  listPlannerSkillActions,
  runPlannerSkillBridge,
  selectPlannerSkillActionForTaskType,
} from "./planner/skill-bridge.mjs";
import {
  attachPlannerVisibleTelemetryAdapter,
  attachPlannerVisibleTelemetryContext,
  copyPlannerVisibleTelemetryContext,
  createPlannerVisibleTelemetryContext,
  emitPlannerVisibleTelemetryEvent,
  getPlannerVisibleTelemetryContext,
  hasPlannerVisibleTelemetryEvent,
  updatePlannerVisibleTelemetryContext,
} from "./planner-visible-live-telemetry-runtime.mjs";
import { buildExecutionEnvelope } from "./execution-envelope.mjs";
import {
  getCompanyBrainDocDetailAction,
  listCompanyBrainDocsAction,
  searchCompanyBrainDocsAction,
} from "./company-brain-query.mjs";
import { evaluateExecutionReadiness } from "./execution-readiness-gate.mjs";
import {
  buildExecutionOutcomeObservability,
  normalizeExecutionOutcome,
  scoreExecutionOutcome,
} from "./execution-outcome-scorer.mjs";
import {
  adviseStepNextAction,
  buildStepDecisionAdvisorComparison,
  formatStepDecisionAdvisorBasedOnSummary,
  resolveStepDecisionAdvisorActualAction,
} from "./step-decision-advisor.mjs";
import { formatAdvisorAlignmentSummary } from "./advisor-alignment-evaluator.mjs";
import {
  evaluateDecisionEnginePromotion,
  buildDecisionPromotionAuditRecord,
  applyDecisionPromotionAuditSafety,
  createDecisionPromotionAuditState,
  listDecisionPromotionRollbackDisabledActions,
  resolveDecisionPromotionPolicy,
  resolveDecisionPromotionRollbackGate,
  formatDecisionPromotionAuditSummary,
  formatDecisionPromotionSummary,
  DECISION_ENGINE_PROMOTION_ROLLBACK_REASON_CODE,
} from "./decision-engine-promotion.mjs";
import { formatPromotionControlSurfaceSummary } from "./promotion-control-surface.mjs";
import {
  buildDecisionMetricsScoreboard,
  formatDecisionMetricsScoreboardSummary,
} from "./decision-metrics-scoreboard.mjs";
import { getStoredAccountContext } from "./lark-user-auth.mjs";
import { getDbPath } from "./db.mjs";
import {
  hasAnyTrulyMissingRequiredSlot,
  isSlotActuallyMissing,
} from "./truly-missing-slot.mjs";
import { buildRetryContextPack } from "./retry-context-pack.mjs";
import { resolveToolContract, validateToolInvocation } from "./tool-layer-contract.mjs";
import { executeTool } from "./tool-execution-runtime.mjs";
import { resolveToolResultContinuation } from "./tool-result-continuation.mjs";

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

const ACTION_SYSTEM_PROMPT_FILE = new URL("./prompts/action-system-prompt.txt", import.meta.url);

function readActionSystemPrompt() {
  try {
    return readFileSync(ACTION_SYSTEM_PROMPT_FILE, "utf8");
  } catch (_) {
    return "";
  }
}

const EXECUTIVE_MAX_ROLES = 3;
const EXECUTIVE_MAX_SUPPORTING_ROLES = EXECUTIVE_MAX_ROLES - 1;
const PLANNER_CONTEXT_WINDOW_MAX_CHARS = 2400;
const PLANNER_CONTEXT_WINDOW_SUMMARY_MAX_CHARS = 640;
const LOCAL_PLANNER_RUNTIME_INFO_STARTED_AT = new Date().toISOString();
const LOCAL_PLANNER_READONLY_FALLBACK_ACTIONS = new Set([
  "list_company_brain_docs",
  "search_company_brain_docs",
  "get_company_brain_doc_detail",
  "get_runtime_info",
]);
const PLANNER_FAILED_DETERMINISTIC_FALLBACK_ACTIONS = new Set([
  "list_company_brain_docs",
  "search_company_brain_docs",
  "get_company_brain_doc_detail",
  "get_runtime_info",
  "search_and_detail_doc",
]);
const PLANNER_RECENT_STEP_LIMIT = 6;
const PLANNER_HIGH_WEIGHT_DOC_LIMIT = 3;
const PLANNER_FAILED_ALERT_KEY = "planner_failed:user_input_planner";
const PLANNER_EXPLICIT_AUTH_ACTIONS = new Set([
  "list_company_brain_docs",
  "search_company_brain_docs",
  "get_company_brain_doc_detail",
]);
const PLANNER_ROUTING_REASON_ALIASES = Object.freeze({
  doc_query_scoped_exclusion_search: "doc_query_search",
  selector_search_company_brain_docs_scoped_exclusion: "selector_search_company_brain_docs",
  task_lifecycle_pending_item_action: "task_lifecycle_follow_up",
  forced_detail_for_mirror_runtime: "forced_selection",
});
const FETCH_DOCUMENT_ACTION = "fetch_document";
const FETCH_DOCUMENT_STEP_INTENT = "retrieve document content before reasoning";
const PLANNER_WORKING_MEMORY_MIN_CONFIDENCE = 0.35;
const PLANNER_WORKING_MEMORY_RETRY_PATTERN = /(再試一次|再试一次|重試|重试|retry|run again|再來一次|再来一次)/i;
const PLANNER_WORKING_MEMORY_TOPIC_SWITCH_PATTERN = /(換個題目|换个题目|換題|换题|改問|改问|另一題|另一题|new topic|different question)/i;
const PLANNER_WORKING_MEMORY_ELLIPSIS_FOLLOW_UP_PATTERN = /^(繼續|继续|再來|再来|然後呢|然后呢|下一步|接著|接着|same task)$/i;
const PLANNER_WORKING_MEMORY_RETRYABLE_ERRORS = new Set([
  "tool_error",
  "runtime_exception",
]);
const DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY = Object.freeze({
  max_retries: 2,
  strategy: "same_agent_then_reroute",
});
const PLANNER_WORKING_MEMORY_UNRESOLVED_SLOT_ACTIONS = Object.freeze({
  candidate_selection_required: "search_company_brain_docs",
  missing_document_reference: "search_company_brain_docs",
  needs_doc_candidates: "search_company_brain_docs",
  requires_runtime_context: "get_runtime_info",
});
const PLANNER_WORKING_MEMORY_AGENT_ACTION_HINTS = Object.freeze({
  doc_agent: "search_and_detail_doc",
  runtime_agent: "get_runtime_info",
  meeting_agent: "search_company_brain_docs",
  mixed_agent: "search_company_brain_docs",
});
const PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS = Object.freeze({
  search_company_brain_docs: "doc_agent",
  search_and_detail_doc: "doc_agent",
  get_company_brain_doc_detail: "doc_agent",
  search_and_summarize: "doc_agent",
  document_summarize: "doc_agent",
  get_runtime_info: "runtime_agent",
});
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
const PLANNER_WORKING_MEMORY_FAILURE_CLASSES = new Set([
  "tool_error",
  "missing_slot",
  "capability_gap",
  "invalid_artifact",
  "timeout",
  "unknown",
]);
const PLANNER_WORKING_MEMORY_RECOVERY_POLICIES = new Set([
  "retry_same_step",
  "reroute_owner",
  "ask_user",
  "skip_step",
  "rollback_to_step",
]);
const PLANNER_WORKING_MEMORY_RECOVERY_ACTIONS = new Set([
  ...PLANNER_WORKING_MEMORY_RECOVERY_POLICIES,
  "failed",
]);
const PLANNER_WORKING_MEMORY_ARTIFACT_VALIDITY_STATUSES = new Set([
  "valid",
  "invalid",
  "superseded",
  "missing",
]);
const PLANNER_WORKING_MEMORY_DEPENDENCY_TYPES = new Set([
  "hard",
  "soft",
]);
const PLANNER_WORKING_MEMORY_NON_CRITICAL_STEP_TYPES = new Set([
  "non_critical",
  "optional",
  "best_effort",
]);
const DEFAULT_PLANNER_PROMOTION_AUDIT_SESSION_KEY = "__default__";
const plannerPromotionAuditStates = new Map();

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

const executiveSelectableAgentIds = Object.freeze(
  listRegisteredPersonaAgents().map((agent) => cleanText(agent?.id)).filter(Boolean),
);

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

async function resolvePlannerLocalFallbackAccountId(authContext = null) {
  const explicitAccountId = cleanText(authContext?.account_id || authContext?.accountId || "");
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const storedContext = await getStoredAccountContext("");
  return cleanText(storedContext?.account?.id || "");
}

function buildLocalPlannerRuntimeInfoResult() {
  return buildExecutionEnvelope({
    ok: true,
    action: "get_runtime_info",
    data: {
      db_path: getDbPath(),
      node_pid: process.pid,
      cwd: process.cwd(),
      service_start_time: LOCAL_PLANNER_RUNTIME_INFO_STARTED_AT,
    },
    meta: {
      source: "local_readonly_fallback",
    },
  });
}

function buildLocalPlannerCompanyBrainEnvelope(action = "", result = null) {
  const ok = result?.success === true;
  return buildExecutionEnvelope({
    ok,
    action,
    data: result && typeof result === "object" && !Array.isArray(result)
      ? result
      : {
          success: false,
          data: {},
          error: "runtime_exception",
        },
    meta: {
      source: "local_readonly_fallback",
    },
    error: ok ? null : cleanText(result?.error || "") || "runtime_exception",
  });
}

async function attemptLocalPlannerReadonlyFallback({
  action = "",
  payload = {},
  authContext = null,
} = {}) {
  const normalizedAction = cleanText(action);
  if (!LOCAL_PLANNER_READONLY_FALLBACK_ACTIONS.has(normalizedAction)) {
    return null;
  }

  if (normalizedAction === "get_runtime_info") {
    return buildLocalPlannerRuntimeInfoResult();
  }

  const accountId = await resolvePlannerLocalFallbackAccountId(authContext);
  if (!accountId) {
    return null;
  }

  if (normalizedAction === "list_company_brain_docs") {
    return buildLocalPlannerCompanyBrainEnvelope(normalizedAction, listCompanyBrainDocsAction({
      accountId,
      limit: payload?.limit,
    }));
  }

  if (normalizedAction === "search_company_brain_docs") {
    return buildLocalPlannerCompanyBrainEnvelope(normalizedAction, searchCompanyBrainDocsAction({
      accountId,
      q: payload?.q,
      limit: payload?.limit,
      top_k: payload?.top_k,
      ranking_weights: payload?.ranking_weights,
    }));
  }

  if (normalizedAction === "get_company_brain_doc_detail") {
    return buildLocalPlannerCompanyBrainEnvelope(normalizedAction, getCompanyBrainDocDetailAction({
      accountId,
      docId: payload?.doc_id,
    }));
  }

  return null;
}

function normalizePlannerRoutingReason(routingReason = "", fallback = "") {
  const normalized = cleanText(routingReason) || cleanText(fallback);
  if (!normalized) {
    return null;
  }
  return PLANNER_ROUTING_REASON_ALIASES[normalized] || normalized;
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
  plannerRuntimeInfoFlow,
  plannerOkrFlow,
  plannerBdFlow,
  plannerDeliveryFlow,
  plannerDocQueryFlow,
].filter(Boolean);

function buildPlannerFlowSnapshots(flows = plannerFlows, { sessionKey = "" } = {}) {
  return Array.isArray(flows)
    ? flows.map((flow) => ({
        id: cleanText(flow?.id || "") || null,
        ownership: getPlannerFlowOwnership(flow),
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

const PLANNER_CONTROLLED_EXECUTION_HINT_PATTERNS = [
  /(?:文件|文檔|doc|company brain|runtime|db path|pid|scanoo|okr|雲文檔|云文档)/i,
  /(?:評論|评论).{0,8}(?:改稿|改寫|改写|rewrite)/i,
  /(?:分類|分类|指派|預覽|预览|review|rereview|會議|会议|capture|日程|行程|calendar|待辦|待办|task|todo|對話|对话)/i,
];

function requestLikelyNeedsControlledExecution(requestText = "") {
  const normalized = cleanText(requestText);
  if (!normalized) {
    return false;
  }
  if (/^\s*\/[a-z0-9_-]+/i.test(normalized) || /\bagent\b/i.test(normalized)) {
    return false;
  }
  return PLANNER_CONTROLLED_EXECUTION_HINT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildPlannerRetryHint(requestText = "") {
  const normalized = cleanText(requestText).replace(/\s+/g, " ").slice(0, 36);
  if (!normalized) {
    return "你可以直接把第一步說成可執行動作，我會先從那一步開始。";
  }
  if (/(?:runtime|db path|pid)/i.test(normalized)) {
    return "例如直接說：先查 runtime db path。";
  }
  if (/(?:雲文檔|云文档|分類|分类|指派|review|rereview)/i.test(normalized)) {
    return "例如直接說：先預覽雲文檔分類結果，或先告訴我哪一批文檔要複查。";
  }
  if (/(?:會議|会议|capture)/i.test(normalized)) {
    return "例如直接說：先開始會議記錄，或先幫我看目前是否在持續記錄。";
  }
  if (/(?:文件|文檔|doc|company brain|okr)/i.test(normalized)) {
    return `例如把「${normalized}」拆成先查文件，再整理重點。`;
  }
  return `例如把「${normalized}」先拆成第一個可執行步驟。`;
}

function isPlannerPermissionDeniedError(errorCode = "") {
  const normalized = cleanText(errorCode);
  return normalized === "missing_user_access_token"
    || normalized === "oauth_reauth_required"
    || normalized === "permission_denied"
    || normalized === "entry_governance_required";
}

function isPlannerRoutingNoMatch({ error = "", fallbackReason = "" } = {}) {
  const normalizedError = cleanText(error);
  const normalizedFallbackReason = cleanText(fallbackReason);
  return normalizedError === "routing_error"
    || normalizedFallbackReason === "routing_error"
    || normalizedFallbackReason === "routing_no_match"
    || normalizedFallbackReason === ROUTING_NO_MATCH
    || normalizedError === ROUTING_NO_MATCH;
}

export function resolvePlannerUserFacingFailureClass({
  error = "",
  fallbackReason = "",
  requestText = "",
  action = "",
} = {}) {
  const normalizedError = cleanText(error);
  const normalizedAction = cleanText(action);

  if (isPlannerPermissionDeniedError(normalizedError)) {
    return "permission_denied";
  }
  if (isPlannerRoutingNoMatch({ error: normalizedError, fallbackReason })) {
    return "routing_no_match";
  }
  if (
    requestLikelyNeedsControlledExecution(requestText)
    && !normalizedAction
    && (
      normalizedError === "planner_failed"
      || normalizedError === "tool_error"
      || normalizedError === "runtime_exception"
      || normalizedError === "business_error"
      || normalizedError === "contract_violation"
    )
  ) {
    return "tool_omission";
  }
  if (normalizedError === "planner_failed") {
    return "planner_failed";
  }
  return "generic_fallback";
}

function buildPlannerUserFacingAnswer({
  error = "",
  fallbackReason = "",
  requestText = "",
} = {}) {
  const normalizedError = cleanText(error);
  const failureClass = resolvePlannerUserFacingFailureClass({
    error: normalizedError,
    fallbackReason,
    requestText,
  });

  if (normalizedError === "missing_user_access_token") {
    return "這次我先不直接查文件，因為目前這條文件路徑是 auth-required，而這輪請求沒有帶到可驗證的 Lark 使用者授權。";
  }
  if (normalizedError === "oauth_reauth_required") {
    return "這次我先不直接查文件，因為目前這條文件路徑是 auth-required，而現有的 Lark 使用者授權已失效，需要重新登入授權。";
  }
  if (normalizedError === "entry_governance_required") {
    return "這個動作還卡在受控治理邊界，所以我現在不能直接替你寫入或建立。";
  }
  if (normalizedError === "semantic_mismatch") {
    return "我先沒有直接執行原本那個內部動作，因為它和你這輪的需求不一致。";
  }
  if (failureClass === "routing_no_match") {
    return "這題我先沒走到合適的處理方式，所以先用一般助理的方式接住你。";
  }
  if (failureClass === "tool_omission") {
    return "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。";
  }
  if (normalizedError === "invalid_action" || normalizedError === INVALID_ACTION) {
    return "這題我先不直接往下做，因為目前還缺一個明確的處理方向。";
  }
  if (normalizedError === "request_timeout") {
    return "這次處理逾時了，我還沒有拿到可以安全交付的結果。";
  }
  if (normalizedError === "request_cancelled") {
    return "這次處理被中斷了，所以我先不回傳不完整結果。";
  }
  if (failureClass === "planner_failed") {
    return "這輪不是你問題不清楚，而是我這邊沒有順利排出安全可執行的步驟，所以先不亂做。";
  }
  if (normalizedError === "business_error") {
    return "這次沒有完整處理好，所以我先把目前狀態整理給你。";
  }
  return "這次還沒拿到完整結果，所以我先把目前能確認的部分整理給你。";
}

function buildPlannerUserFacingLimitations({
  error = "",
  fallbackReason = "",
  action = "",
  requestText = "",
} = {}) {
  const normalizedError = cleanText(error);
  const normalizedAction = cleanText(action);
  const failureClass = resolvePlannerUserFacingFailureClass({
    error: normalizedError,
    fallbackReason,
    requestText,
    action: normalizedAction,
  });

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
  if (normalizedError === "entry_governance_required") {
    return normalizePlannerUserFacingList([
      "這類建立/寫入動作還需要補齊受控治理欄位或額外核准，現在不能直接跳過。",
      "如果你要，我可以先幫你整理建立目的、owner 和內容骨架，再進下一步。",
    ]);
  }
  if (normalizedError === "semantic_mismatch") {
    return normalizePlannerUserFacingList([
      "這題看起來像是另一種處理需求，所以我先不亂猜。",
      "如果你是要找文件、看文件內容、查系統狀態，或建立文件，可以把目標再說清楚一點。",
    ]);
  }
  if (failureClass === "routing_no_match") {
    return normalizePlannerUserFacingList([
      "你可以直接說想整理什麼、查哪份文件，或要我看什麼狀態，我會改用更合適的方式處理。",
      "如果你補一句目標或範圍，我通常就能直接往下做。",
    ]);
  }
  if (failureClass === "tool_omission") {
    return normalizePlannerUserFacingList([
      "這類需求要先真的跑到對應工具或 workflow，不能只停在泛化說明。",
      buildPlannerRetryHint(requestText),
    ]);
  }
  if (normalizedError === "invalid_action" || normalizedError === INVALID_ACTION) {
    return normalizePlannerUserFacingList([
      normalizedAction ? `這次先不直接採用「${normalizedAction}」這種做法。` : "這次先不直接採用原本那種做法。",
      "直接描述你想完成的事就好，我會換成更合適的方式處理。",
    ]);
  }
  if (normalizedError === "request_timeout") {
    return normalizePlannerUserFacingList([
      "可以稍後再試一次，或把需求縮小一點，我會先從最可交付的部分開始。",
    ]);
  }
  if (normalizedError === "request_cancelled") {
    return normalizePlannerUserFacingList([
      "這次請求在完成前被取消，所以沒有可安全交付的最終結果。",
    ]);
  }
  if (failureClass === "planner_failed") {
    return normalizePlannerUserFacingList([
      "這輪卡在我這邊的規劃步驟，不代表你的需求本身一定不清楚。",
      `你可以直接重試同一句；如果要更穩，${buildPlannerRetryHint(requestText)}`,
    ]);
  }
  return normalizePlannerUserFacingList([
    "如果你願意，可以換個說法、補一點背景，或把目標資料直接貼給我。",
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

export function buildPlannedUserInputUserFacingReply(result = {}, { requestText = "" } = {}) {
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
      requestText,
    }),
    sources: [],
    limitations: buildPlannerUserFacingLimitations({
      error: errorCode,
      fallbackReason,
      action: envelope?.action || envelope?.trace?.chosen_action || "",
      requestText,
    }),
  };
}

function derivePlannerUnfinishedItems({
  selection = {},
  executionResult = null,
  formattedOutput = null,
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

  const effectiveFormattedOutput = formattedOutput && typeof formattedOutput === "object" && !Array.isArray(formattedOutput)
    ? formattedOutput
    : executionResult?.formatted_output;
  const formatterKind = cleanText(effectiveFormattedOutput?.kind || "");
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

function buildPlannerSkillAdmissionSignals(semantics = null) {
  const normalizedSemantics = semantics && typeof semantics === "object" && !Array.isArray(semantics)
    ? semantics
    : {};
  return {
    wants_document_search: normalizedSemantics.wants_document_search === true,
    wants_document_summary: normalizedSemantics.wants_document_summary === true,
    wants_search_summary: normalizedSemantics.wants_search_summary === true,
    wants_document_detail: normalizedSemantics.wants_document_detail === true,
    wants_document_list: normalizedSemantics.wants_document_list === true,
    wants_scoped_doc_exclusion_search: normalizedSemantics.wants_scoped_doc_exclusion_search === true,
    explicit_same_task: normalizedSemantics.explicit_same_task === true,
  };
}

function evaluatePlannerVisibleSkillAdmission({
  action = "",
  text = "",
  semantics = null,
} = {}) {
  const entry = getPlannerSkillAction(action);
  if (!entry || entry.planner_catalog_eligible !== true) {
    return {
      admitted: false,
      fail_closed: false,
    };
  }

  const boundary = entry.planner_admission_boundary
    && typeof entry.planner_admission_boundary === "object"
    && !Array.isArray(entry.planner_admission_boundary)
    ? entry.planner_admission_boundary
    : null;
  if (!boundary) {
    return {
      admitted: true,
      fail_closed: false,
    };
  }

  const normalizedText = cleanText(text);
  if (!normalizedText) {
    return {
      admitted: false,
      fail_closed: true,
    };
  }

  const signals = buildPlannerSkillAdmissionSignals(semantics || derivePlannerUserInputSemantics(text));
  const requiredSignals = Array.isArray(boundary.require_signals) ? boundary.require_signals : [];
  const forbiddenSignals = Array.isArray(boundary.forbid_signals) ? boundary.forbid_signals : [];
  const missingRequired = requiredSignals.filter((signal) => signals[signal] !== true);
  const hitForbidden = forbiddenSignals.filter((signal) => signals[signal] === true);

  return {
    admitted: missingRequired.length === 0 && hitForbidden.length === 0,
    fail_closed: missingRequired.length > 0 || hitForbidden.length > 0,
    fail_closed_on_ambiguity: boundary.fail_closed_on_ambiguity !== false,
  };
}

function resolvePlannerVisibleSkillAdmissions({
  text = "",
  semantics = null,
} = {}) {
  const skillEntries = listPlannerSkillBridges()
    .filter((entry) => entry?.planner_catalog_eligible === true);
  if (skillEntries.length === 0) {
    return {
      admitted_actions: Object.freeze([]),
      ambiguous: false,
    };
  }

  const admitted = skillEntries
    .filter((entry) => evaluatePlannerVisibleSkillAdmission({
      action: entry.action,
      text,
      semantics,
    }).admitted === true)
    .map((entry) => entry.action);

  const ambiguous = admitted.length > 1 && skillEntries.some((entry) => (
    admitted.includes(entry.action)
    && entry?.planner_admission_boundary?.fail_closed_on_ambiguity !== false
  ));

  return {
    admitted_actions: Object.freeze(ambiguous ? [] : admitted),
    ambiguous,
  };
}

function listPlannerVisibleCandidateSkills() {
  return listPlannerSkillBridges()
    .filter((entry) => entry?.planner_catalog_eligible === true)
    .map((entry) => cleanText(entry?.action))
    .filter(Boolean);
}

function resolvePlannerVisibleTelemetryQueryType({
  taskType = "",
  semantics = null,
} = {}) {
  const normalizedTaskType = cleanText(taskType);
  if (normalizedTaskType === "skill_read" || normalizedTaskType === "knowledge_read_skill") {
    return "search";
  }
  if (normalizedTaskType === "document_summary_skill") {
    return "detail";
  }

  const effectiveSemantics = semantics && typeof semantics === "object" && !Array.isArray(semantics)
    ? semantics
    : {};
  if (effectiveSemantics.wants_search_summary === true && effectiveSemantics.wants_document_detail === true) {
    return "mixed";
  }
  if (effectiveSemantics.explicit_same_task === true && effectiveSemantics.wants_document_detail === true) {
    return "follow-up";
  }
  if (effectiveSemantics.wants_search_summary === true) {
    return "search";
  }
  if (
    effectiveSemantics.wants_document_summary === true
    || effectiveSemantics.wants_document_detail === true
  ) {
    return "detail";
  }
  return null;
}

function resolvePlannerVisibleTelemetryRoutingFamily({
  action = "",
  queryType = null,
} = {}) {
  const normalizedAction = cleanText(action);
  if (normalizedAction === "search_and_summarize") {
    return "planner_visible_search";
  }
  if (normalizedAction === "document_summarize") {
    return "planner_visible_detail";
  }
  if (normalizedAction === "search_company_brain_docs") {
    return "search_company_brain_docs";
  }
  if (normalizedAction === "search_and_detail_doc" || normalizedAction === "get_company_brain_doc_detail") {
    return "search_and_detail_doc";
  }
  if (queryType === "search" || queryType === "mixed") {
    return "search_company_brain_docs";
  }
  if (queryType === "detail" || queryType === "follow-up") {
    return "search_and_detail_doc";
  }
  return "routing_no_match";
}

function createPlannerVisibleTelemetryMonitor({
  text = "",
  taskType = "",
  selectedAction = "",
  decisionReason = "",
  requestId = "",
  traceId = null,
  telemetryAdapter = null,
} = {}) {
  const semantics = derivePlannerUserInputSemantics(text);
  const queryType = resolvePlannerVisibleTelemetryQueryType({
    taskType,
    semantics,
  });
  const candidateSkills = listPlannerVisibleCandidateSkills();
  if (!queryType || candidateSkills.length === 0) {
    return null;
  }

  const selectedSkillEntry = getPlannerSkillAction(selectedAction);
  const selectedSkill = selectedSkillEntry?.planner_catalog_eligible === true
    ? cleanText(selectedSkillEntry.action)
    : null;
  const admissions = resolvePlannerVisibleSkillAdmissions({
    text,
    semantics,
  });
  const failClosed = !selectedSkill && (queryType === "mixed" || queryType === "follow-up");
  const ambiguous = admissions.ambiguous === true || queryType === "mixed";
  const context = createPlannerVisibleTelemetryContext({
    request_id: requestId,
    query_type: queryType,
    candidate_skills: candidateSkills,
    selected_skill: selectedSkill,
    routing_family: resolvePlannerVisibleTelemetryRoutingFamily({
      action: selectedAction,
      queryType,
    }),
    decision_reason: cleanText(decisionReason)
      || (
        failClosed
          ? "planner-visible admission failed closed and routing returned to the existing non-skill family."
          : selectedSkill
            ? "planner-visible skill selection passed and routing committed to the monitored skill path."
            : "planner-visible telemetry monitored the existing non-skill routing family."
      ),
    trace_id: traceId,
    task_type: taskType,
    selector_key: cleanText(selectedSkillEntry?.selector_key) || null,
    skill_surface_layer: cleanText(selectedSkillEntry?.surface_layer) || null,
    skill_promotion_stage: cleanText(selectedSkillEntry?.promotion_stage) || null,
    reason_code: failClosed
      ? ambiguous === true
        ? "ambiguous_fail_closed"
        : "fail_closed"
      : selectedSkill
        ? "admitted"
        : "fallback",
    telemetry_adapter: telemetryAdapter,
  });

  return {
    context,
    admissions,
    ambiguous,
    fail_closed: failClosed,
  };
}

function emitPlannerVisibleTelemetryForMonitor({
  monitor = null,
  selectedAction = "",
} = {}) {
  const context = monitor?.context || null;
  if (!context) {
    return;
  }

  if (
    context.selected_skill
    && !hasPlannerVisibleTelemetryEvent(context, "planner_visible_skill_selected")
  ) {
    emitPlannerVisibleTelemetryEvent({
      event: "planner_visible_skill_selected",
      context,
      extra: {
        reason_code: context.reason_code || "admitted",
        selector_key: context.selector_key,
        admission_outcome: "admitted",
        skill_surface_layer: context.skill_surface_layer,
        skill_promotion_stage: context.skill_promotion_stage,
        task_type: context.task_type,
      },
    });
  }

  if (
    monitor?.fail_closed === true
    && !hasPlannerVisibleTelemetryEvent(context, "planner_visible_fail_closed")
  ) {
    emitPlannerVisibleTelemetryEvent({
      event: "planner_visible_fail_closed",
      context,
      extra: {
        reason_code: context.reason_code || "fail_closed",
        fail_closed_stage: "admission",
        admission_outcome: "fail_closed",
        rejected_skills: context.candidate_skills,
        selector_key: context.selector_key,
        ambiguity_detected: monitor?.ambiguous === true,
        task_type: context.task_type,
      },
    });
  }

  if (
    monitor?.fail_closed === true
    && monitor?.ambiguous === true
    && !hasPlannerVisibleTelemetryEvent(context, "planner_visible_ambiguity")
  ) {
    emitPlannerVisibleTelemetryEvent({
      event: "planner_visible_ambiguity",
      context,
      extra: {
        reason_code: "ambiguous_fail_closed",
        ambiguity_signals: ["multiple_planner_visible_candidates"],
        admission_outcome: "ambiguous_fail_closed",
        rejected_skills: context.candidate_skills,
        selector_key: context.selector_key,
        task_type: context.task_type,
      },
    });
  }

  if (
    monitor?.fail_closed === true
    && !hasPlannerVisibleTelemetryEvent(context, "planner_visible_fallback")
  ) {
    emitPlannerVisibleTelemetryEvent({
      event: "planner_visible_fallback",
      context,
      extra: {
        reason_code: context.reason_code || "fallback",
        fallback_action: cleanText(selectedAction) || null,
        fallback_reason: context.decision_reason,
        fallback_family_source: "baseline_guard",
        task_type: context.task_type,
      },
    });
  }
}

function isPlannerDecisionCatalogVisible(name = "", { text = "", semantics = null } = {}) {
  const normalizedName = cleanText(name);
  if (getPlannerSkillAction(normalizedName)) {
    if (!isPlannerSkillActionCatalogVisible(normalizedName)) {
      return false;
    }
    if (!cleanText(text)) {
      return true;
    }
    return resolvePlannerVisibleSkillAdmissions({
      text,
      semantics,
    }).admitted_actions.includes(normalizedName);
  }
  const entry = getPlannerDecisionContract(name)?.contract || null;
  return cleanText(entry?.planner_visibility || "").toLowerCase() !== "deterministic_only";
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

export function listPlannerDecisionCatalogEntries({ text = "" } = {}) {
  const semantics = cleanText(text) ? derivePlannerUserInputSemantics(text) : null;
  const actionEntries = Object.entries(plannerContract?.actions || {})
    .filter(([name]) => isPlannerDecisionCatalogVisible(name, { text, semantics }))
    .map(([name, contract]) => ({
      name,
      type: "action",
      required_params: summarizePlannerInputSchema(contract?.input_schema),
    }));
  const presetEntries = Object.entries(plannerContract?.presets || {})
    .filter(([name]) => isPlannerDecisionCatalogVisible(name, { text, semantics }))
    .map(([name, contract]) => ({
      name,
      type: "preset",
      required_params: summarizePlannerInputSchema(contract?.input_schema),
    }));
  return [...actionEntries, ...presetEntries];
}

function plannerDecisionCatalogText({ text = "" } = {}) {
  return listPlannerDecisionCatalogEntries({ text })
    .map((entry) => `- ${entry.name}: type=${entry.type}; required_params=${entry.required_params}`)
    .join("\n");
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
  fail_closed: {
    self_heal: 0,
    retry: 0,
    stop_reason: "fail_closed",
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

function logPlannerWorkingMemoryTrace({
  logger = console,
  memoryStage = "",
  sessionKey = "",
  observability = null,
  previousMemorySnapshot = null,
  selectedAction = null,
  routingReason = null,
  level = "debug",
} = {}) {
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const taskTrace = buildPlannerTaskTraceDiagnostics({
    memoryStage,
    memorySnapshot: normalizedObservability.memory_snapshot || null,
    previousMemorySnapshot,
    observability: normalizedObservability,
  });
  const logLevel = typeof logger?.[level] === "function"
    ? level
    : typeof logger?.debug === "function"
      ? "debug"
      : "info";
  logger?.[logLevel]?.("planner_working_memory", {
    stage: "planner_working_memory",
    memory_stage: cleanText(memoryStage) || null,
    session_key: cleanText(sessionKey) || null,
    selected_action: cleanText(selectedAction || "") || null,
    routing_reason: cleanText(routingReason || "") || null,
    ...normalizedObservability,
    task_trace_summary: taskTrace.summary,
    task_trace_diff: taskTrace.diff,
    task_trace_snapshot: taskTrace.snapshot,
    task_trace_text: taskTrace.text,
    task_trace_event_alignment: taskTrace.event_alignment,
  });
  return taskTrace;
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
    "search_and_summarize",
    "document_summarize",
    "get_company_brain_doc_detail",
    "search_and_detail_doc",
    "create_and_list_doc",
    "create_search_detail_list_doc",
    "update_learning_state",
    "ingest_learning_doc",
    "read_task_lifecycle_v1",
    "update_task_lifecycle_v1",
    "mark_resolved",
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
  formattedOutput = null,
  traceId = null,
  routingReason = null,
  taskType = "",
  payload = {},
} = {}) {
  return {
    selected_action: selectedAction,
    execution_result: executionResult,
    formatted_output: normalizePlannerFormattedOutput(formattedOutput),
    routing_reason: normalizePlannerRoutingReason(routingReason) || null,
    synthetic_agent_hint: resolvePlannerAgentExecution({
      taskType,
      payload,
      selectedAction,
    }),
    trace_id: traceId,
  };
}

function normalizePlannerFormattedOutput(formattedOutput = null) {
  if (formattedOutput && typeof formattedOutput === "object" && !Array.isArray(formattedOutput)) {
    return { ...formattedOutput };
  }
  return null;
}

function extractPlannerFormattedOutput(executionResult = null) {
  return normalizePlannerFormattedOutput(executionResult?.formatted_output);
}

function buildTaskLayerPlannerResult(taskLayerResult = null) {
  const normalized = normalizeTaskLayerResult(taskLayerResult);
  const { ok, tasks, results, summary, data, errors, failed } = normalized;
  const userFacing = taskLayerResultToUserFacing(normalized);

  return {
    ok,
    action: "multi_task",
    params: {},
    error: ok ? null : "multi_task_failed",
    execution_result: {
      ok,
      data: {
        mode: "multi_task",
        tasks,
        results,
        summary,
        data,
        errors,
        ...userFacing,
      },
    },
    formatted_output: null,
    trace_id: null,
    why: "task-layer 預先辨識到多個子任務，所以先走 bounded multi-task pre-pass。",
    alternative: normalizeDecisionAlternative({
      action: null,
      agent_id: null,
      summary: "若只要處理其中一件事，也可以退回原本的單一路徑 planner 流程。",
    }),
  };
}

function buildPlannerPendingItemActionFormattedOutput({
  actionResult = null,
  task = null,
  userIntent = "",
} = {}) {
  if (!actionResult || typeof actionResult !== "object") {
    return null;
  }
  const title = cleanText(task?.title) || "未命名 pending item";
  const pendingItems = Array.isArray(actionResult?.data?.pending_items) ? actionResult.data.pending_items : [];
  const summary = title
    ? `已將「${title}」標記完成。`
    : "已將這個 pending item 標記完成。";
  return {
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
  };
}

function buildPlannerFormattedOutput({
  executionResult = null,
  formattedOutput = null,
  lifecycleSnapshot = null,
} = {}) {
  const baseFormattedOutput = normalizePlannerFormattedOutput(formattedOutput)
    || extractPlannerFormattedOutput(executionResult);
  const pendingItems = buildPlannerLifecycleUnfinishedItems(lifecycleSnapshot);

  if (!baseFormattedOutput) {
    return null;
  }

  if (pendingItems.length === 0) {
    return baseFormattedOutput;
  }

  return {
    ...baseFormattedOutput,
    pending_items: pendingItems,
  };
}

export function buildPlannerPendingItemActionResult({
  actionResult = null,
  task = null,
  userIntent = "",
  embedFormattedOutput = true,
} = {}) {
  if (!actionResult || typeof actionResult !== "object") {
    return actionResult;
  }
  if (embedFormattedOutput !== true) {
    return actionResult;
  }
  return {
    ...actionResult,
    formatted_output: buildPlannerPendingItemActionFormattedOutput({
      actionResult,
      task,
      userIntent,
    }),
  };
}

function buildPlannerMultiStepOutput({
  ok = true,
  steps = [],
  results = [],
  executionContext = null,
  traceId = null,
  error = null,
  stopped = false,
  stoppedAtStep = null,
  currentStepIndex = null,
  lastError = null,
  retryCount = 0,
} = {}) {
  const normalizedExecutionContext = executionContext && typeof executionContext === "object" && !Array.isArray(executionContext)
    ? executionContext
    : null;
  return {
    ok,
    steps,
    results,
    execution_context: normalizedExecutionContext && Object.keys(normalizedExecutionContext).length > 0
      ? normalizedExecutionContext
      : null,
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

function normalizePlannerPromotionAuditSessionKey(sessionKey = "") {
  const normalized = cleanText(sessionKey || "");
  return normalized || DEFAULT_PLANNER_PROMOTION_AUDIT_SESSION_KEY;
}

function getPlannerPromotionAuditState({ sessionKey = "" } = {}) {
  const key = normalizePlannerPromotionAuditSessionKey(sessionKey);
  const existingState = plannerPromotionAuditStates.get(key);
  if (existingState && typeof existingState === "object" && !Array.isArray(existingState)) {
    return createDecisionPromotionAuditState(existingState);
  }
  const initialState = createDecisionPromotionAuditState();
  plannerPromotionAuditStates.set(key, initialState);
  return initialState;
}

function setPlannerPromotionAuditState({
  sessionKey = "",
  state = null,
} = {}) {
  const key = normalizePlannerPromotionAuditSessionKey(sessionKey);
  const normalizedState = createDecisionPromotionAuditState(state);
  plannerPromotionAuditStates.set(key, normalizedState);
  return normalizedState;
}

function resetPlannerPromotionAuditState({ sessionKey = "" } = {}) {
  const normalizedSessionKey = cleanText(sessionKey || "");
  if (!normalizedSessionKey) {
    plannerPromotionAuditStates.clear();
    return;
  }
  const key = normalizePlannerPromotionAuditSessionKey(normalizedSessionKey);
  plannerPromotionAuditStates.delete(key);
}

function appendUniqueReasonCode(reasonCodes = [], reasonCode = "") {
  const normalizedReasonCode = cleanText(reasonCode || "");
  if (!normalizedReasonCode) {
    return Array.isArray(reasonCodes) ? reasonCodes : [];
  }
  const normalizedReasonCodes = Array.isArray(reasonCodes)
    ? reasonCodes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  if (!normalizedReasonCodes.includes(normalizedReasonCode)) {
    normalizedReasonCodes.push(normalizedReasonCode);
  }
  return normalizedReasonCodes;
}

export function resetPlannerRuntimeContext({ sessionKey = "" } = {}) {
  resetPlannerFlowContexts(plannerFlows, { sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  resetPlannerPromotionAuditState({ sessionKey });
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

function maybeBackfillPlannerAccountId({
  action = "",
  payload = {},
  authContext = null,
} = {}) {
  const normalizedPayload = normalizePlannerPayload(payload);
  const contract = getPlannerActionContract(action);
  const requiredFields = Array.isArray(contract?.input_schema?.required)
    ? contract.input_schema.required
    : [];
  if (!requiredFields.includes("account_id")) {
    return normalizedPayload;
  }
  const accountId = cleanText(
    normalizedPayload.account_id
    || normalizedPayload.accountId
    || authContext?.account_id
    || authContext?.accountId
    || "",
  );
  if (!accountId) {
    return normalizedPayload;
  }
  return {
    ...normalizedPayload,
    account_id: accountId,
  };
}

function normalizePlannerExecutionContext(context = null) {
  return context && typeof context === "object" && !Array.isArray(context)
    ? { ...context }
    : {};
}

function buildPlannerDocumentExecutionContext(result = null) {
  const data = result?.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data
    : {};
  const documentId = cleanText(data.document_id || "");
  if (!documentId) {
    return null;
  }
  return {
    document: {
      document_id: documentId,
      title: cleanText(data.title || "") || "",
      content: cleanText(data.content || "") || "",
      fetched: data.fetched === true,
    },
  };
}

function mergePlannerExecutionContext(currentContext = null, nextContext = null) {
  const normalizedCurrentContext = normalizePlannerExecutionContext(currentContext);
  const normalizedNextContext = normalizePlannerExecutionContext(nextContext);
  if (Object.keys(normalizedNextContext).length === 0) {
    return normalizedCurrentContext;
  }
  return {
    ...normalizedCurrentContext,
    ...normalizedNextContext,
  };
}

function derivePlannerExecutionContextFromResults(results = []) {
  let executionContext = {};
  for (const result of Array.isArray(results) ? results : []) {
    if (cleanText(result?.action || "") !== FETCH_DOCUMENT_ACTION || result?.ok !== true) {
      continue;
    }
    executionContext = mergePlannerExecutionContext(
      executionContext,
      buildPlannerDocumentExecutionContext(result),
    );
  }
  return executionContext;
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

function normalizeRuntimeInfoActionResult(result = null) {
  if (!result || typeof result !== "object" || result.ok !== true) {
    return result;
  }
  const nestedData = result?.data?.data;
  if (
    nestedData
    && typeof nestedData === "object"
    && !Array.isArray(nestedData)
    && !Array.isArray(result?.data)
    && !Object.prototype.hasOwnProperty.call(result.data || {}, "db_path")
    && (
      Object.prototype.hasOwnProperty.call(nestedData, "db_path")
      || Object.prototype.hasOwnProperty.call(nestedData, "node_pid")
      || Object.prototype.hasOwnProperty.call(nestedData, "cwd")
      || Object.prototype.hasOwnProperty.call(nestedData, "service_start_time")
    )
  ) {
    return {
      ...result,
      data: {
        ...nestedData,
      },
    };
  }
  return result;
}

function normalizePlannerDispatchActionResult(action = "", result = null) {
  if (cleanText(action) === "get_runtime_info") {
    return normalizeRuntimeInfoActionResult(result);
  }
  return normalizeCompanyBrainActionResult(action, result);
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

function buildPlannerSkillToolExecutionExtra({
  skillAction = null,
  result = null,
} = {}) {
  if (!skillAction || typeof skillAction !== "object") {
    return {};
  }

  const stopReason = cleanText(result?.data?.stop_reason || result?.error || "");
  return {
    skill_bridge: true,
    skill_name: cleanText(skillAction.skill_name) || null,
    skill_surface_layer: cleanText(skillAction.surface_layer) || null,
    skill_promotion_stage: cleanText(skillAction.promotion_stage) || null,
    skill_catalog_eligible: skillAction.planner_catalog_eligible === true,
    skill_selector_key: cleanText(skillAction.selector_key) || null,
    skill_selector_task_types: Array.isArray(skillAction.selector_task_types)
      ? skillAction.selector_task_types.map((item) => cleanText(item)).filter(Boolean)
      : [],
    skill_routing_reason: cleanText(skillAction.routing_reason) || null,
    skill_fail_closed: result?.ok === false && stopReason === "fail_closed",
    skill_stop_reason: stopReason || null,
  };
}

function shapePlannerSkillDispatchPayload({
  action = "",
  userIntent = "",
  payload = {},
  authContext = null,
} = {}) {
  const skillAction = getPlannerSkillAction(action);
  const normalizedPayload = normalizePlannerPayload(payload);
  if (!skillAction) {
    return normalizedPayload;
  }

  const shapedPayload = {
    ...normalizedPayload,
    q: cleanText(normalizedPayload.q || normalizedPayload.query || userIntent) || "",
  };
  return maybeBackfillPlannerAccountId({
    action: skillAction.action,
    payload: shapedPayload,
    authContext,
  });
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

async function dispatchPlannerFetchDocument({
  payload = {},
  requestText = "",
  authContext = null,
  documentFetcher = fetchDocumentPlainText,
  signal = null,
} = {}) {
  const preAbortResult = buildPlannerAbortResult({
    action: FETCH_DOCUMENT_ACTION,
    signal,
  });
  if (preAbortResult) {
    return preAbortResult;
  }

  const normalizedPayload = normalizePlannerPayload(payload);
  const effectivePayload = maybeAttachReferencedDocumentId({
    text: requestText,
    action: FETCH_DOCUMENT_ACTION,
    params: normalizedPayload,
  });
  const docId = cleanText(effectivePayload.doc_id || "");
  if (!docId) {
    return buildPlannerStoppedResult({
      action: FETCH_DOCUMENT_ACTION,
      error: "business_error",
      data: {
        message: "planner_fetch_document_missing_document_reference",
      },
      traceId: null,
    });
  }

  try {
    const fetchResult = await documentFetcher({
      document_id: docId,
      raw_card: normalizedPayload.raw_card ?? requestText ?? null,
      auth: authContext,
    });
    if (fetchResult?.ok !== true) {
      const failureType = cleanText(fetchResult?.error?.type || "") || "not_found";
      return buildPlannerStoppedResult({
        action: FETCH_DOCUMENT_ACTION,
        error: "fail_closed",
        data: {
          reason: failureType,
          failure_mode: "fail_closed",
          document_id: cleanText(fetchResult?.error?.document_id || "") || docId || null,
          message: cleanText(fetchResult?.error?.message || "") || null,
        },
        traceId: null,
        stopReason: "fail_closed",
      });
    }

    return {
      ok: true,
      action: FETCH_DOCUMENT_ACTION,
      data: {
        document_id: cleanText(fetchResult?.document_id || "") || docId,
        title: cleanText(fetchResult?.title || "") || "",
        content: cleanText(fetchResult?.content || "") || "",
        fetched: true,
      },
      trace_id: null,
    };
  } catch (error) {
    const abortResult = buildPlannerAbortResult({
      action: FETCH_DOCUMENT_ACTION,
      signal,
      error,
    });
    if (abortResult) {
      return abortResult;
    }
    return buildPlannerStoppedResult({
      action: FETCH_DOCUMENT_ACTION,
      error: "fail_closed",
      data: {
        reason: "runtime_exception",
        failure_mode: "fail_closed",
        message: error instanceof Error ? error.message : String(error),
        document_id: docId,
      },
      traceId: null,
      stopReason: "fail_closed",
    });
  }
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
  const semantics = cleanText(text) ? derivePlannerUserInputSemantics(text) : null;
  const effectiveDecision = enforceFetchDocumentStepRequirement({
    text,
    decision: hardenPlannerUserInputDecisionCandidate({
      text,
      decision: normalizedDecision,
    }).decision,
  });
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

      const params = maybeAttachReferencedDocumentId({
        text,
        action,
        params: normalizePlannerPayload(rawParams),
      });
      if (!action) {
        return {
          ok: false,
          error: "planner_failed",
        };
      }

      const validatedStep = buildPlannerValidatedStep({
        action,
        params,
        intent: rawStep.intent,
        required: rawStep.required,
      });
      const contract = getPlannerActionContract(action);
      steps.push(validatedStep);

      if (action === FETCH_DOCUMENT_ACTION) {
        continue;
      }

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
  const params = maybeAttachReferencedDocumentId({
    text,
    action: cleanText(effectiveDecision.action || ""),
    params: normalizePlannerPayload(effectiveDecision.params),
  });

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

  if (getPlannerSkillAction(action) && !isPlannerSkillActionCatalogVisible(action)) {
    return {
      ok: false,
      error: normalizePublicPlannerErrorCode(INVALID_ACTION),
      action,
      params,
    };
  }

  if (
    getPlannerSkillAction(action)
    && cleanText(text)
    && !isPlannerDecisionCatalogVisible(action, { text, semantics })
  ) {
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

export function listPlannerSkillBridges() {
  return listPlannerSkillActions();
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

function canUseWorkingMemoryAction(action = "", {
  text = "",
  semantics = null,
} = {}) {
  const normalizedAction = cleanText(action);
  if (!normalizedAction) {
    return false;
  }
  if (!getPlannerActionContract(normalizedAction) && !getPlannerPreset(normalizedAction)) {
    return false;
  }
  if (cleanText(text) && !isPlannerDecisionCatalogVisible(normalizedAction, {
    text,
    semantics: semantics && typeof semantics === "object" && !Array.isArray(semantics)
      ? semantics
      : null,
  })) {
    return false;
  }
  if (getPlannerSkillAction(normalizedAction)) {
    if (!isPlannerSkillActionCatalogVisible(normalizedAction)) {
      return false;
    }
    if (cleanText(text) && !isPlannerDecisionCatalogVisible(normalizedAction, {
      text,
      semantics: semantics && typeof semantics === "object" && !Array.isArray(semantics)
        ? semantics
        : null,
    })) {
      return false;
    }
  }
  return true;
}

function normalizePlannerWorkingMemoryRetryPolicy(retryPolicy = null) {
  if (!retryPolicy || typeof retryPolicy !== "object" || Array.isArray(retryPolicy)) {
    return { ...DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY };
  }
  const maxRetries = Number(retryPolicy.max_retries);
  const strategy = cleanText(retryPolicy.strategy || "");
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || !strategy) {
    return { ...DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY };
  }
  if (!["same_agent", "reroute", "same_agent_then_reroute"].includes(strategy)) {
    return { ...DEFAULT_PLANNER_WORKING_MEMORY_RETRY_POLICY };
  }
  return {
    max_retries: Math.floor(maxRetries),
    strategy,
  };
}

function derivePlannerWorkingMemorySlotState({
  workingMemory = null,
} = {}) {
  const slotState = Array.isArray(workingMemory?.slot_state)
    ? workingMemory.slot_state
    : [];
  const activeSlots = slotState.filter((slot) => {
    const ttl = cleanText(slot?.ttl || "");
    if (!ttl) {
      return true;
    }
    const expiresAt = Date.parse(ttl);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  });
  if (activeSlots.length > 0) {
    return activeSlots;
  }
  const unresolvedSlots = Array.isArray(workingMemory?.unresolved_slots)
    ? workingMemory.unresolved_slots
    : [];
  return unresolvedSlots
    .map((slotKey) => cleanText(slotKey))
    .filter(Boolean)
    .map((slotKey) => ({
      slot_key: slotKey,
      required_by: null,
      status: "missing",
      source: "inferred",
      ttl: null,
    }));
}

function derivePlannerWorkingMemorySlotCoverage({
  workingMemory = null,
  unresolvedSlots = [],
} = {}) {
  const slotState = derivePlannerWorkingMemorySlotState({ workingMemory });
  const normalizedUnresolved = Array.isArray(unresolvedSlots)
    ? unresolvedSlots.map((slot) => cleanText(slot)).filter(Boolean)
    : [];
  const trulyMissingCheck = hasAnyTrulyMissingRequiredSlot({
    required_slots: normalizedUnresolved,
    unresolved_slots: normalizedUnresolved,
    slot_state: slotState,
  });
  const filledSlotKeys = new Set(slotState
    .filter((slot) => {
      const slotKey = cleanText(slot?.slot_key || "");
      if (!slotKey) {
        return false;
      }
      return isSlotActuallyMissing(slot) !== true;
    })
    .map((slot) => cleanText(slot?.slot_key || ""))
    .filter(Boolean));
  const hasStateMissing = slotState.some((slot) => isSlotActuallyMissing(slot) === true);
  const hasUnresolvedGap = trulyMissingCheck.has_any_truly_missing_required_slot === true;
  return {
    slot_state: slotState,
    filled_slot_keys: Array.from(filledSlotKeys),
    unresolved_slots: normalizedUnresolved,
    has_missing_slots: hasStateMissing || hasUnresolvedGap,
    has_reusable_filled_slot: filledSlotKeys.size > 0,
    unresolved_slots_covered: normalizedUnresolved.length > 0
      && normalizedUnresolved.every((slotKey) => filledSlotKeys.has(slotKey)),
  };
}

function derivePlannerWorkingMemoryUnresolvedSlots({
  workingMemory = null,
} = {}) {
  const slotCoverage = derivePlannerWorkingMemorySlotCoverage({
    workingMemory,
    unresolvedSlots: Array.isArray(workingMemory?.unresolved_slots)
      ? workingMemory.unresolved_slots
      : [],
  });
  const slotState = slotCoverage.slot_state;
  const unresolvedFromSlotState = Array.from(new Set(slotState
    .filter((slot) => isSlotActuallyMissing(slot) === true)
    .map((slot) => cleanText(slot?.slot_key || ""))
    .filter(Boolean)));
  if (unresolvedFromSlotState.length > 0) {
    return unresolvedFromSlotState;
  }
  const fallbackUnresolved = Array.isArray(workingMemory?.unresolved_slots)
    ? workingMemory.unresolved_slots
      .map((slot) => cleanText(slot))
      .filter(Boolean)
    : [];
  if (fallbackUnresolved.length === 0) {
    return [];
  }
  const filledSlotKeys = new Set(slotCoverage.filled_slot_keys || []);
  return fallbackUnresolved.filter((slotKey) => !filledSlotKeys.has(slotKey));
}

function resolvePlannerWorkingMemoryActionFromSlots(slotHints = []) {
  if (!Array.isArray(slotHints)) {
    return "";
  }
  for (const slot of slotHints) {
    const normalizedSlot = typeof slot === "string"
      ? cleanText(slot)
      : cleanText(slot?.slot_key || "");
    if (!normalizedSlot) {
      continue;
    }
    const action = PLANNER_WORKING_MEMORY_UNRESOLVED_SLOT_ACTIONS[normalizedSlot];
    if (action) {
      return action;
    }
  }
  return "";
}

function resolvePlannerWorkingMemoryTaskType(workingMemory = null) {
  return cleanText(workingMemory?.task_type || workingMemory?.inferred_task_type || "");
}

function resolvePlannerWorkingMemoryOwnerAction({
  workingMemory = null,
  text = "",
  semantics = null,
} = {}) {
  const currentOwnerAgent = cleanText(workingMemory?.current_owner_agent || workingMemory?.last_selected_agent || "");
  const ownerActionHint = PLANNER_WORKING_MEMORY_AGENT_ACTION_HINTS[currentOwnerAgent] || "";
  const nextBestAction = cleanText(workingMemory?.next_best_action || "");
  const reusableSkillAction = cleanText(workingMemory?.last_selected_skill || "");
  const candidateActions = [
    nextBestAction,
    ownerActionHint,
    reusableSkillAction,
  ];
  return candidateActions.find((action) => canUseWorkingMemoryAction(action, { text, semantics })) || "";
}

function resolvePlannerWorkingMemoryRerouteAction({
  workingMemory = null,
  text = "",
  semantics = null,
} = {}) {
  const taskType = resolvePlannerWorkingMemoryTaskType(workingMemory);
  const mappedTaskTypeAction = (() => {
    if (taskType === "runtime_info") {
      return "get_runtime_info";
    }
    if (taskType === "skill_read") {
      return "search_and_summarize";
    }
    if (taskType === "doc_write") {
      return "create_doc";
    }
    if (taskType === "document_lookup") {
      return "search_company_brain_docs";
    }
    return "";
  })();
  const currentOwnerAgent = cleanText(workingMemory?.current_owner_agent || "");
  const ownerActionHint = PLANNER_WORKING_MEMORY_AGENT_ACTION_HINTS[currentOwnerAgent] || "";
  const unresolvedAction = resolvePlannerWorkingMemoryActionFromSlots(
    derivePlannerWorkingMemoryUnresolvedSlots({ workingMemory }),
  );
  const candidateActions = [
    mappedTaskTypeAction,
    unresolvedAction,
    cleanText(workingMemory?.next_best_action || ""),
  ];
  return candidateActions.find((action) => action && action !== ownerActionHint && canUseWorkingMemoryAction(action, {
    text,
    semantics,
  })) || "";
}

function listPlannerWorkingMemoryKnownOwnerAgents({
  workingMemory = null,
  currentPlanStep = null,
} = {}) {
  const owners = new Set();
  const addOwner = (value = "") => {
    const normalized = cleanText(value || "");
    if (normalized) {
      owners.add(normalized);
    }
  };
  addOwner(workingMemory?.current_owner_agent);
  addOwner(workingMemory?.last_selected_agent);
  addOwner(currentPlanStep?.step?.owner_agent);
  const planSteps = Array.isArray(currentPlanStep?.plan?.steps)
    ? currentPlanStep.plan.steps
    : Array.isArray(workingMemory?.execution_plan?.steps)
      ? workingMemory.execution_plan.steps
      : [];
  for (const step of planSteps) {
    addOwner(step?.owner_agent);
  }
  for (const ownerAgent of Object.keys(PLANNER_WORKING_MEMORY_AGENT_ACTION_HINTS)) {
    addOwner(ownerAgent);
  }
  for (const ownerAgent of Object.values(PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS)) {
    addOwner(ownerAgent);
  }
  return Array.from(owners);
}

function buildPromotedRerouteDecisionContext({
  workingMemory = null,
  currentPlanStep = null,
  observability = null,
  text = "",
  semantics = null,
} = {}) {
  const currentOwnerAgent = cleanText(workingMemory?.current_owner_agent || "") || null;
  const expectedOwnerAgent = cleanText(currentPlanStep?.step?.owner_agent || "") || null;
  const ownerMismatch = Boolean(currentOwnerAgent && expectedOwnerAgent && currentOwnerAgent !== expectedOwnerAgent);
  const capabilityGap = cleanText(observability?.failure_class || "") === "capability_gap";
  const rerouteAction = resolvePlannerWorkingMemoryRerouteAction({
    workingMemory,
    text,
    semantics,
  });
  const rerouteTarget = ownerMismatch
    ? expectedOwnerAgent
    : cleanText(PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[rerouteAction] || "") || null;
  const knownOwners = listPlannerWorkingMemoryKnownOwnerAgents({
    workingMemory,
    currentPlanStep,
  });
  const rerouteTargetVerified = Boolean(
    rerouteTarget
    && rerouteTarget !== currentOwnerAgent
    && knownOwners.includes(rerouteTarget),
  );
  return {
    previous_owner_agent: currentOwnerAgent,
    current_owner_agent: rerouteTarget,
    expected_owner_agent: expectedOwnerAgent,
    reroute_action: rerouteAction || null,
    reroute_target: rerouteTarget,
    reroute_reason: ownerMismatch
      ? "owner_mismatch"
      : capabilityGap
        ? "capability_gap"
        : null,
    reroute_source: "promoted_decision_engine_v1",
    reroute_target_verified: rerouteTargetVerified,
  };
}

function resolvePromotedRerouteExecution({
  workingMemory = null,
  currentPlanStep = null,
  observability = null,
  text = "",
  semantics = null,
  canUseAction = null,
} = {}) {
  const canUse = typeof canUseAction === "function"
    ? canUseAction
    : () => false;
  const currentOwnerAgent = cleanText(workingMemory?.current_owner_agent || "") || null;
  const expectedOwnerAgent = cleanText(currentPlanStep?.step?.owner_agent || "") || null;
  const expectedAction = cleanText(currentPlanStep?.step?.intended_action || "");
  const knownOwners = listPlannerWorkingMemoryKnownOwnerAgents({
    workingMemory,
    currentPlanStep,
  });
  const ownerMismatch = Boolean(
    currentOwnerAgent
    && expectedOwnerAgent
    && currentOwnerAgent !== expectedOwnerAgent,
  );
  if (ownerMismatch) {
    if (!knownOwners.includes(expectedOwnerAgent)) {
      return {
        ok: false,
        reason_code: "reroute_target_unverified",
        reroute_reason: "owner_mismatch",
      };
    }
    if (!expectedAction || !canUse(expectedAction)) {
      return {
        ok: false,
        reason_code: "reroute_target_unverified",
        reroute_reason: "owner_mismatch",
      };
    }
    return {
      ok: true,
      reroute_action: expectedAction,
      previous_owner_agent: currentOwnerAgent,
      current_owner_agent: expectedOwnerAgent,
      reroute_target: expectedOwnerAgent,
      reroute_reason: "owner_mismatch",
      reroute_source: "promoted_decision_engine_v1",
      reroute_target_verified: true,
    };
  }

  const capabilityGap = cleanText(observability?.failure_class || "") === "capability_gap"
    || cleanText(observability?.recovery_action || "") === "reroute_owner";
  if (!capabilityGap) {
    return {
      ok: false,
      reason_code: "reroute_signals_missing",
      reroute_reason: null,
    };
  }
  const rerouteAction = resolvePlannerWorkingMemoryRerouteAction({
    workingMemory,
    text,
    semantics,
  });
  const capabilityCandidates = [];
  const addCandidate = (ownerAgent = "") => {
    const normalized = cleanText(ownerAgent || "");
    if (!normalized || normalized === currentOwnerAgent || capabilityCandidates.includes(normalized)) {
      return;
    }
    capabilityCandidates.push(normalized);
  };
  const actionOwner = cleanText(PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[rerouteAction] || "");
  addCandidate(actionOwner);
  addCandidate(expectedOwnerAgent);
  const matchingPlanStep = Array.isArray(currentPlanStep?.plan?.steps)
    ? currentPlanStep.plan.steps.find((step) =>
      cleanText(step?.intended_action || "") === rerouteAction
      && cleanText(step?.owner_agent || "")
      && cleanText(step?.owner_agent || "") !== currentOwnerAgent)
    : null;
  addCandidate(cleanText(matchingPlanStep?.owner_agent || ""));
  if (capabilityCandidates.length !== 1) {
    return {
      ok: false,
      reason_code: "reroute_target_unverified",
      reroute_reason: "capability_gap",
    };
  }
  const targetOwner = capabilityCandidates[0];
  if (!knownOwners.includes(targetOwner)) {
    return {
      ok: false,
      reason_code: "reroute_target_unverified",
      reroute_reason: "capability_gap",
    };
  }
  const candidateAction = rerouteAction || expectedAction;
  if (!candidateAction || !canUse(candidateAction)) {
    return {
      ok: false,
      reason_code: "reroute_target_unverified",
      reroute_reason: "capability_gap",
    };
  }
  return {
    ok: true,
    reroute_action: candidateAction,
    previous_owner_agent: currentOwnerAgent,
    current_owner_agent: targetOwner,
    reroute_target: targetOwner,
    reroute_reason: "capability_gap",
    reroute_source: "promoted_decision_engine_v1",
    reroute_target_verified: true,
  };
}

function derivePlannerWorkingMemoryRetryMode({
  retryPolicy = null,
  retryCount = 0,
} = {}) {
  const normalizedPolicy = normalizePlannerWorkingMemoryRetryPolicy(retryPolicy);
  if (normalizedPolicy.strategy === "same_agent") {
    return "same_agent";
  }
  if (normalizedPolicy.strategy === "reroute") {
    return "reroute";
  }
  return retryCount + 1 >= normalizedPolicy.max_retries
    ? "reroute"
    : "same_agent";
}

function isPlannerWorkingMemoryTopicSwitch({
  userIntent = "",
  taskType = "",
  semantics = null,
  workingMemory = null,
} = {}) {
  const normalizedIntent = cleanText(userIntent);
  if (!normalizedIntent) {
    return false;
  }
  if (PLANNER_WORKING_MEMORY_TOPIC_SWITCH_PATTERN.test(normalizedIntent)) {
    return true;
  }
  const normalizedSemantics = semantics && typeof semantics === "object" && !Array.isArray(semantics)
    ? semantics
    : derivePlannerUserInputSemantics(normalizedIntent);
  const inferredTaskType = resolvePlannerWorkingMemoryTaskType(workingMemory);
  const normalizedTaskType = cleanText(taskType || "");
  if (normalizedSemantics.wants_runtime_info && inferredTaskType && inferredTaskType !== "runtime_info") {
    return true;
  }
  if (normalizedSemantics.wants_document_lookup && inferredTaskType === "runtime_info") {
    return true;
  }
  if (normalizedTaskType && inferredTaskType && normalizedTaskType !== inferredTaskType) {
    return true;
  }
  return false;
}

function normalizePlannerWorkingMemoryFailureClass(failureClass = null, { allowNull = true } = {}) {
  const normalized = cleanText(failureClass || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return PLANNER_WORKING_MEMORY_FAILURE_CLASSES.has(normalized)
    ? normalized
    : null;
}

function normalizePlannerWorkingMemoryRecoveryPolicy(recoveryPolicy = null, { allowNull = true } = {}) {
  const normalized = cleanText(recoveryPolicy || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return PLANNER_WORKING_MEMORY_RECOVERY_POLICIES.has(normalized)
    ? normalized
    : null;
}

function buildDefaultPlannerWorkingMemoryRecoveryState() {
  return {
    last_failure_class: null,
    recovery_attempt_count: 0,
    last_recovery_action: null,
    rollback_target_step_id: null,
  };
}

function normalizePlannerWorkingMemoryRecoveryState(value = null, { allowMissing = true } = {}) {
  if ((value === null || value === undefined || value === "") && allowMissing) {
    return buildDefaultPlannerWorkingMemoryRecoveryState();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized = buildDefaultPlannerWorkingMemoryRecoveryState();
  if (Object.prototype.hasOwnProperty.call(value, "last_failure_class")) {
    const failureClass = normalizePlannerWorkingMemoryFailureClass(value.last_failure_class, { allowNull: true });
    if (value.last_failure_class !== null && value.last_failure_class !== undefined && value.last_failure_class !== "" && !failureClass) {
      return null;
    }
    normalized.last_failure_class = failureClass;
  }
  if (Object.prototype.hasOwnProperty.call(value, "recovery_attempt_count")) {
    const attemptCount = Number(value.recovery_attempt_count);
    if (!Number.isFinite(attemptCount) || attemptCount < 0) {
      return null;
    }
    normalized.recovery_attempt_count = Math.floor(attemptCount);
  }
  if (Object.prototype.hasOwnProperty.call(value, "last_recovery_action")) {
    const recoveryAction = cleanText(value.last_recovery_action || "");
    if (value.last_recovery_action !== null && value.last_recovery_action !== undefined && value.last_recovery_action !== ""
      && !PLANNER_WORKING_MEMORY_RECOVERY_ACTIONS.has(recoveryAction)) {
      return null;
    }
    normalized.last_recovery_action = recoveryAction || null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "rollback_target_step_id")) {
    normalized.rollback_target_step_id = cleanText(value.rollback_target_step_id || "") || null;
  }
  return normalized;
}

function normalizePlannerWorkingMemoryArtifactValidityStatus(value = "", { allowNull = true } = {}) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return PLANNER_WORKING_MEMORY_ARTIFACT_VALIDITY_STATUSES.has(normalized)
    ? normalized
    : null;
}

function normalizePlannerWorkingMemoryDependencyType(value = "", { allowNull = true } = {}) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return allowNull ? null : null;
  }
  return PLANNER_WORKING_MEMORY_DEPENDENCY_TYPES.has(normalized)
    ? normalized
    : null;
}

function normalizePlannerWorkingMemoryExecutionPlanArtifacts(artifacts = []) {
  if (artifacts === null || artifacts === undefined || artifacts === "") {
    return [];
  }
  if (!Array.isArray(artifacts)) {
    return null;
  }
  const normalizedArtifacts = [];
  const seenArtifactIds = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      return null;
    }
    const artifactId = cleanText(artifact.artifact_id || "");
    const artifactType = cleanText(artifact.artifact_type || "");
    const producedByStepId = cleanText(artifact.produced_by_step_id || "");
    const validityStatus = normalizePlannerWorkingMemoryArtifactValidityStatus(artifact.validity_status, { allowNull: false });
    if (!artifactId || !artifactType || !producedByStepId || !validityStatus || seenArtifactIds.has(artifactId)) {
      return null;
    }
    seenArtifactIds.add(artifactId);
    normalizedArtifacts.push({
      artifact_id: artifactId,
      artifact_type: artifactType,
      produced_by_step_id: producedByStepId,
      validity_status: validityStatus,
      consumed_by_step_ids: Array.isArray(artifact.consumed_by_step_ids)
        ? Array.from(new Set(artifact.consumed_by_step_ids.map((item) => cleanText(item)).filter(Boolean)))
        : [],
      supersedes_artifact_id: cleanText(artifact.supersedes_artifact_id || "") || null,
      metadata: artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
        ? { ...artifact.metadata }
        : null,
    });
  }
  return normalizedArtifacts;
}

function normalizePlannerWorkingMemoryExecutionPlanDependencyEdges(edges = []) {
  if (edges === null || edges === undefined || edges === "") {
    return [];
  }
  if (!Array.isArray(edges)) {
    return null;
  }
  const normalizedEdges = [];
  const seenEdgeKeys = new Set();
  for (const edge of edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      return null;
    }
    const fromStepId = cleanText(edge.from_step_id || "");
    const toStepId = cleanText(edge.to_step_id || "");
    const viaArtifactId = cleanText(edge.via_artifact_id || "");
    const dependencyType = normalizePlannerWorkingMemoryDependencyType(edge.dependency_type, { allowNull: false });
    if (!fromStepId || !toStepId || !viaArtifactId || !dependencyType) {
      return null;
    }
    const edgeKey = `${fromStepId}->${toStepId}#${viaArtifactId}`;
    if (seenEdgeKeys.has(edgeKey)) {
      return null;
    }
    seenEdgeKeys.add(edgeKey);
    normalizedEdges.push({
      from_step_id: fromStepId,
      to_step_id: toStepId,
      via_artifact_id: viaArtifactId,
      dependency_type: dependencyType,
    });
  }
  return normalizedEdges;
}

function validatePlannerWorkingMemoryExecutionPlanGraph(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return false;
  }
  const stepIds = new Set(Array.isArray(plan.steps) ? plan.steps.map((step) => step.step_id) : []);
  const planId = cleanText(plan.plan_id || "");
  const artifacts = Array.isArray(plan.artifacts) ? plan.artifacts : [];
  const dependencyEdges = Array.isArray(plan.dependency_edges) ? plan.dependency_edges : [];
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const canReferenceStep = (stepId = "", artifact = null) => {
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
    if (!canReferenceStep(artifact.produced_by_step_id, artifact)) {
      return false;
    }
    for (const consumedStepId of Array.isArray(artifact.consumed_by_step_ids) ? artifact.consumed_by_step_ids : []) {
      if (!canReferenceStep(consumedStepId, artifact)) {
        return false;
      }
    }
    const supersedesId = cleanText(artifact.supersedes_artifact_id || "");
    if (supersedesId && !artifactMap.has(supersedesId)) {
      return false;
    }
  }
  for (const edge of dependencyEdges) {
    const artifact = artifactMap.get(edge.via_artifact_id);
    if (!artifact) {
      return false;
    }
    if (!canReferenceStep(edge.from_step_id, artifact) || !canReferenceStep(edge.to_step_id, artifact)) {
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

function normalizePlannerWorkingMemoryExecutionPlan(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  const planId = cleanText(plan.plan_id || "");
  const planStatus = cleanText(plan.plan_status || "");
  if (!planId || !PLANNER_WORKING_MEMORY_PLAN_STATUSES.has(planStatus)) {
    return null;
  }
  const steps = Array.isArray(plan.steps)
    ? plan.steps
        .map((step) => {
          const stepId = cleanText(step?.step_id || "");
          const stepType = cleanText(step?.step_type || "");
          const ownerAgent = cleanText(step?.owner_agent || "");
          const intendedAction = cleanText(step?.intended_action || "");
          const status = cleanText(step?.status || "");
          const failureClass = normalizePlannerWorkingMemoryFailureClass(step?.failure_class, { allowNull: true });
          const recoveryPolicy = normalizePlannerWorkingMemoryRecoveryPolicy(step?.recovery_policy, { allowNull: true });
          const recoveryState = normalizePlannerWorkingMemoryRecoveryState(step?.recovery_state, { allowMissing: true });
          const outcome = normalizeExecutionOutcome(step?.outcome, { allowNull: true });
          if (!stepId || !intendedAction || !PLANNER_WORKING_MEMORY_STEP_STATUSES.has(status)) {
            return null;
          }
          if ((step?.failure_class !== null && step?.failure_class !== undefined && step?.failure_class !== "" && !failureClass)
            || (step?.recovery_policy !== null && step?.recovery_policy !== undefined && step?.recovery_policy !== "" && !recoveryPolicy)
            || !recoveryState
            || ((step?.outcome !== null && step?.outcome !== undefined && step?.outcome !== "") && !outcome)) {
            return null;
          }
          return {
            step_id: stepId,
            step_type: stepType || null,
            owner_agent: ownerAgent || null,
            intended_action: intendedAction,
            status,
            retryable: step?.retryable !== false,
            depends_on: Array.isArray(step?.depends_on)
              ? step.depends_on.map((item) => cleanText(item)).filter(Boolean)
              : [],
            artifact_refs: Array.isArray(step?.artifact_refs)
              ? step.artifact_refs.map((item) => cleanText(item)).filter(Boolean)
              : [],
            slot_requirements: Array.isArray(step?.slot_requirements)
              ? step.slot_requirements.map((slot) => cleanText(slot)).filter(Boolean)
              : [],
            failure_class: failureClass,
            recovery_policy: recoveryPolicy,
            recovery_state: recoveryState,
            outcome,
          };
        })
        .filter(Boolean)
    : [];
  const artifacts = normalizePlannerWorkingMemoryExecutionPlanArtifacts(plan.artifacts);
  const dependencyEdges = normalizePlannerWorkingMemoryExecutionPlanDependencyEdges(plan.dependency_edges);
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
  if (!validatePlannerWorkingMemoryExecutionPlanGraph(normalizedPlan)) {
    return null;
  }
  return normalizedPlan;
}

function resolvePlannerWorkingMemoryCurrentPlanStep(plan = null) {
  const normalizedPlan = normalizePlannerWorkingMemoryExecutionPlan(plan);
  if (!normalizedPlan || normalizedPlan.plan_status !== "active") {
    return {
      plan: normalizedPlan,
      step: null,
    };
  }
  const currentStep = normalizedPlan.current_step_id
    ? normalizedPlan.steps.find((step) => step.step_id === normalizedPlan.current_step_id) || null
    : normalizedPlan.steps.find((step) =>
      step.status === "pending"
      || step.status === "running"
      || step.status === "blocked"
      || step.status === "failed") || null;
  return {
    plan: normalizedPlan,
    step: currentStep,
  };
}

function resolvePlannerWorkingMemoryCurrentStepDependencyGuard({
  plan = null,
  step = null,
} = {}) {
  if (!plan || !step) {
    return {
      blocked: false,
      issue: null,
    };
  }
  const dependencyEdges = Array.isArray(plan.dependency_edges) ? plan.dependency_edges : [];
  const artifacts = Array.isArray(plan.artifacts) ? plan.artifacts : [];
  if (dependencyEdges.length === 0 || artifacts.length === 0) {
    return {
      blocked: false,
      issue: null,
    };
  }
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const incomingEdges = dependencyEdges.filter((edge) => cleanText(edge?.to_step_id || "") === cleanText(step.step_id || ""));
  if (incomingEdges.length === 0) {
    return {
      blocked: false,
      issue: null,
    };
  }
  const collectIssue = (edge = null, artifact = null) => {
    const artifactId = cleanText(artifact?.artifact_id || edge?.via_artifact_id || "") || null;
    const artifactType = cleanText(artifact?.artifact_type || "") || null;
    const validityStatus = cleanText(artifact?.validity_status || "") || "missing";
    const producedByStepId = cleanText(artifact?.produced_by_step_id || "") || null;
    const dependencyType = cleanText(edge?.dependency_type || "") || null;
    const affectedDownstreamSteps = dependencyEdges
      .filter((candidate) =>
        cleanText(candidate?.via_artifact_id || "") === artifactId
        && cleanText(candidate?.dependency_type || "") === dependencyType)
      .map((candidate) => cleanText(candidate?.to_step_id || ""))
      .filter(Boolean);
    return {
      artifact_id: artifactId,
      artifact_type: artifactType,
      validity_status: validityStatus,
      produced_by_step_id: producedByStepId,
      affected_downstream_steps: affectedDownstreamSteps.length > 0
        ? Array.from(new Set(affectedDownstreamSteps))
        : null,
      dependency_type: dependencyType,
      artifact_superseded: validityStatus === "superseded" || Boolean(cleanText(artifact?.supersedes_artifact_id || "")),
      dependency_blocked_step: cleanText(edge?.to_step_id || step.step_id || "") || null,
      rollback_target_step_id: producedByStepId,
    };
  };

  const hardIssue = incomingEdges
    .map((edge) => {
      const artifact = artifactMap.get(cleanText(edge?.via_artifact_id || "")) || null;
      const validityStatus = cleanText(artifact?.validity_status || "") || "missing";
      if (cleanText(edge?.dependency_type || "") !== "hard") {
        return null;
      }
      if (validityStatus === "valid") {
        return null;
      }
      return collectIssue(edge, artifact);
    })
    .find(Boolean);
  if (hardIssue) {
    return {
      blocked: true,
      issue: hardIssue,
    };
  }
  const softIssue = incomingEdges
    .map((edge) => {
      const artifact = artifactMap.get(cleanText(edge?.via_artifact_id || "")) || null;
      const validityStatus = cleanText(artifact?.validity_status || "") || "missing";
      if (cleanText(edge?.dependency_type || "") !== "soft") {
        return null;
      }
      if (validityStatus === "valid") {
        return null;
      }
      return collectIssue(edge, artifact);
    })
    .find(Boolean);
  return {
    blocked: false,
    issue: softIssue || null,
  };
}

function resolvePlannerExecutionReadinessPrimaryReason(readiness = null) {
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return "";
  }
  return cleanText((Array.isArray(readiness.blocking_reason_codes) ? readiness.blocking_reason_codes[0] : "") || "");
}

function resolvePlannerExecutionReadinessFailureClass(readiness = null) {
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return null;
  }
  const blockingReasons = Array.isArray(readiness.blocking_reason_codes)
    ? readiness.blocking_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  if (blockingReasons.includes("invalid_artifact")) {
    return "invalid_artifact";
  }
  if (blockingReasons.includes("missing_slot")) {
    return "missing_slot";
  }
  if (blockingReasons.includes("owner_mismatch")) {
    return "capability_gap";
  }
  if (blockingReasons.includes("recovery_in_progress")) {
    return "tool_error";
  }
  if (blockingReasons.includes("blocked_dependency")
    || blockingReasons.includes("plan_invalidated")
    || blockingReasons.includes("malformed_plan_state")) {
    return "unknown";
  }
  return null;
}

function applyPlannerExecutionReadinessObservability({
  observability = null,
  readiness = null,
} = {}) {
  if (!observability || typeof observability !== "object" || Array.isArray(observability)) {
    return;
  }
  const normalizedReadiness = readiness && typeof readiness === "object" && !Array.isArray(readiness)
    ? readiness
    : null;
  observability.readiness = normalizedReadiness
    ? {
        is_ready: normalizedReadiness.is_ready === true,
        blocking_reason_codes: Array.isArray(normalizedReadiness.blocking_reason_codes)
          ? normalizedReadiness.blocking_reason_codes
          : [],
        missing_slots: Array.isArray(normalizedReadiness.missing_slots)
          ? normalizedReadiness.missing_slots
          : [],
        invalid_artifacts: Array.isArray(normalizedReadiness.invalid_artifacts)
          ? normalizedReadiness.invalid_artifacts
          : [],
        blocked_dependencies: Array.isArray(normalizedReadiness.blocked_dependencies)
          ? normalizedReadiness.blocked_dependencies
          : [],
        owner_ready: normalizedReadiness.owner_ready !== false,
        recovery_ready: normalizedReadiness.recovery_ready !== false,
        recommended_action: cleanText(normalizedReadiness.recommended_action || "") || "proceed",
      }
    : null;
  observability.blocking_reason_codes = observability.readiness?.blocking_reason_codes || [];
  observability.missing_slots = observability.readiness?.missing_slots || [];
  observability.invalid_artifacts = observability.readiness?.invalid_artifacts || [];
  observability.blocked_dependencies = observability.readiness?.blocked_dependencies || [];
  observability.owner_ready = typeof observability.readiness?.owner_ready === "boolean"
    ? observability.readiness.owner_ready
    : null;
  observability.recovery_ready = typeof observability.readiness?.recovery_ready === "boolean"
    ? observability.readiness.recovery_ready
    : null;
  observability.recommended_action = observability.readiness?.recommended_action || null;
  const firstInvalidArtifact = Array.isArray(observability.readiness?.invalid_artifacts)
    ? observability.readiness.invalid_artifacts.find((item) => item && typeof item === "object") || null
    : null;
  if (firstInvalidArtifact) {
    observability.artifact_id = cleanText(firstInvalidArtifact.artifact_id || "") || observability.artifact_id;
    observability.artifact_type = cleanText(firstInvalidArtifact.artifact_type || "") || observability.artifact_type;
    observability.validity_status = cleanText(firstInvalidArtifact.validity_status || "") || observability.validity_status;
    observability.produced_by_step_id = cleanText(firstInvalidArtifact.produced_by_step_id || "") || observability.produced_by_step_id;
    observability.affected_downstream_steps = Array.isArray(firstInvalidArtifact.affected_downstream_steps)
      ? firstInvalidArtifact.affected_downstream_steps
      : observability.affected_downstream_steps;
    observability.dependency_type = cleanText(firstInvalidArtifact.dependency_type || "") || observability.dependency_type;
    observability.dependency_blocked_step = cleanText(firstInvalidArtifact.blocked_step_id || "") || observability.dependency_blocked_step;
  }
  if ((!observability.dependency_blocked_step || observability.dependency_blocked_step === "none")
    && Array.isArray(observability.readiness?.blocked_dependencies)
    && observability.readiness.blocked_dependencies.length > 0) {
    observability.dependency_blocked_step = cleanText(observability.readiness.blocked_dependencies[0]?.step_id || "") || null;
  }
}

function resolvePlannerExecutionReadiness({
  workingMemory = null,
  currentPlanStep = null,
  unresolvedSlots = [],
  taskId = null,
  slotStateOverride = null,
} = {}) {
  const rawExecutionPlan = workingMemory?.execution_plan;
  const hasRawPlan = rawExecutionPlan && typeof rawExecutionPlan === "object" && !Array.isArray(rawExecutionPlan);
  const planStatus = cleanText(currentPlanStep?.plan?.plan_status || rawExecutionPlan?.plan_status || "");
  if (!hasRawPlan && !currentPlanStep?.plan) {
    return null;
  }
  if (planStatus && planStatus !== "active" && planStatus !== "invalidated") {
    return null;
  }
  return evaluateExecutionReadiness({
    plan: currentPlanStep?.plan || rawExecutionPlan || null,
    step: currentPlanStep?.step || null,
    current_owner_agent: cleanText(workingMemory?.current_owner_agent || "") || null,
    task_id: cleanText(taskId || "") || null,
    abandoned_task_ids: Array.isArray(workingMemory?.abandoned_task_ids) ? workingMemory.abandoned_task_ids : [],
    unresolved_slots: Array.isArray(unresolvedSlots) ? unresolvedSlots : [],
    slot_state: Array.isArray(slotStateOverride)
      ? slotStateOverride
      : Array.isArray(workingMemory?.slot_state)
        ? workingMemory.slot_state
        : [],
  });
}

function derivePlannerRecoveryPolicyFromOutcome({
  outcomeStatus = "",
  retryWorthiness = null,
} = {}) {
  const normalizedStatus = cleanText(outcomeStatus || "");
  if (normalizedStatus === "blocked") {
    return "ask_user";
  }
  if (normalizedStatus === "failed") {
    return "ask_user";
  }
  if (normalizedStatus === "partial" && retryWorthiness === true) {
    return "retry_same_step";
  }
  return null;
}

function applyPlannerExecutionOutcomeObservability({
  observability = null,
  currentPlanStep = null,
  executionReadiness = null,
  unresolvedSlots = [],
  stopError = "",
} = {}) {
  if (!observability || typeof observability !== "object" || Array.isArray(observability)) {
    return;
  }
  const normalizedStep = currentPlanStep?.step && typeof currentPlanStep.step === "object" && !Array.isArray(currentPlanStep.step)
    ? currentPlanStep.step
    : null;
  const normalizedReadiness = executionReadiness && typeof executionReadiness === "object" && !Array.isArray(executionReadiness)
    ? executionReadiness
    : observability.readiness;
  const stepStatus = (() => {
    const transition = cleanText(observability.task_status_transition || "");
    const normalizedStepStatus = cleanText(normalizedStep?.status || "");
    if (transition.endsWith("->blocked")) {
      return "blocked";
    }
    if (transition.endsWith("->failed")) {
      return "failed";
    }
    if (transition.endsWith("->running")) {
      return "running";
    }
    if (transition.endsWith("->completed")) {
      return "completed";
    }
    if (normalizedStepStatus) {
      return normalizedStepStatus;
    }
    if (cleanText(observability.recovery_action || "") === "failed") {
      return "failed";
    }
    if (cleanText(observability.recovery_action || "") === "ask_user") {
      return "blocked";
    }
    return "";
  })();
  const outcome = scoreExecutionOutcome({
    stepStatus,
    requiredSlots: Array.isArray(normalizedStep?.slot_requirements)
      ? normalizedStep.slot_requirements
      : [],
    missingSlots: Array.isArray(normalizedReadiness?.missing_slots)
      ? normalizedReadiness.missing_slots
      : Array.isArray(unresolvedSlots)
        ? unresolvedSlots
        : [],
    artifactsProducedCount: 0,
    error: cleanText(stopError || ""),
    failureClass: cleanText(observability.failure_class || ""),
    readiness: normalizedReadiness,
    recoveryAction: cleanText(observability.recovery_action || ""),
    recoveryPolicy: cleanText(observability.recovery_policy || ""),
    artifactValidityStatus: cleanText(observability.validity_status || "") || null,
    hasUserVisibleOutputFlag: false,
  });
  const outcomeObservability = buildExecutionOutcomeObservability(outcome);
  Object.assign(observability, outcomeObservability);
  const fallbackRecoveryPolicy = derivePlannerRecoveryPolicyFromOutcome({
    outcomeStatus: outcomeObservability.outcome_status,
    retryWorthiness: outcomeObservability.retry_worthiness,
  });
  if (!cleanText(observability.recovery_policy || "") && fallbackRecoveryPolicy) {
    observability.recovery_policy = fallbackRecoveryPolicy;
  }
  if (!cleanText(observability.recovery_action || "")) {
    if (observability.recovery_policy === "retry_same_step") {
      observability.recovery_action = "retry_same_step";
    } else if (observability.recovery_policy === "ask_user") {
      observability.recovery_action = "ask_user";
    }
  }
}

function isNonCriticalExecutionPlanStep(step = null) {
  const stepType = cleanText(step?.step_type || "");
  return PLANNER_WORKING_MEMORY_NON_CRITICAL_STEP_TYPES.has(stepType);
}

function applyStepDecisionAdvisorObservability({
  observability = null,
  currentPlanStep = null,
  taskId = null,
  retryPolicy = null,
  retryCount = 0,
} = {}) {
  if (!observability || typeof observability !== "object" || Array.isArray(observability)) {
    return;
  }
  const normalizedStep = currentPlanStep?.step && typeof currentPlanStep.step === "object" && !Array.isArray(currentPlanStep.step)
    ? currentPlanStep.step
    : null;
  const normalizedReadiness = observability.readiness && typeof observability.readiness === "object" && !Array.isArray(observability.readiness)
    ? observability.readiness
    : null;
  const hasAdvisableStep = Boolean(
    cleanText(observability.plan_id || "")
    || cleanText(observability.current_step || "")
    || normalizedReadiness
    || cleanText(observability.outcome_status || ""),
  );
  if (!hasAdvisableStep) {
    observability.advisor = null;
    observability.advisor_based_on_summary = null;
    observability.advisor_vs_actual = null;
    observability.advisor_alignment = null;
    observability.advisor_alignment_summary = null;
    observability.decision_promotion = null;
    observability.decision_promotion_summary = null;
    observability.promotion_policy = null;
    observability.promotion_policy_summary = null;
    observability.promotion_audit = null;
    observability.promotion_audit_summary = null;
    observability.decision_scoreboard = null;
    observability.decision_scoreboard_summary = null;
    observability.highest_maturity_actions = null;
    observability.rollback_disabled_actions = null;
    observability.reroute_target = null;
    observability.reroute_reason = null;
    observability.reroute_source = null;
    observability.reroute_target_verified = null;
    return;
  }
  const blockedDependencies = Array.isArray(observability.blocked_dependencies)
    ? observability.blocked_dependencies
    : [];
  const invalidArtifacts = Array.isArray(observability.invalid_artifacts)
    ? observability.invalid_artifacts
    : [];
  const normalizedRetryCount = Number.isFinite(Number(retryCount))
    ? Math.max(0, Number(retryCount))
    : 0;
  const retryBudgetMax = Number.isFinite(Number(retryPolicy?.max_retries))
    ? Math.max(0, Number(retryPolicy.max_retries))
    : null;
  const retryBudgetRemaining = retryBudgetMax !== null
    ? Math.max(0, retryBudgetMax - normalizedRetryCount)
    : null;
  const advisorDecision = adviseStepNextAction({
    readiness: normalizedReadiness,
    outcome: {
      outcome_status: observability.outcome_status,
      outcome_confidence: observability.outcome_confidence,
      outcome_evidence: observability.outcome_evidence,
      artifact_quality: observability.artifact_quality,
      retry_worthiness: observability.retry_worthiness,
      user_visible_completeness: observability.user_visible_completeness,
    },
    recovery: {
      recovery_policy: cleanText(observability.recovery_policy || "") || null,
      recovery_action: cleanText(observability.recovery_action || "") || null,
      recovery_attempt_count: Number.isFinite(Number(observability.recovery_attempt_count))
        ? Number(observability.recovery_attempt_count)
        : 0,
      rollback_target_step_id: cleanText(observability.rollback_target_step_id || "") || null,
      retry_allowed: normalizedStep?.retryable !== false,
      retry_budget_max: retryBudgetMax,
      retry_budget_remaining: retryBudgetRemaining,
      retry_budget_exhausted: retryBudgetRemaining !== null
        ? retryBudgetRemaining <= 0
        : false,
      skip_allowed: cleanText(observability.recovery_action || "") === "skip_step"
        || cleanText(observability.recovery_policy || "") === "skip_step"
        || isNonCriticalExecutionPlanStep(normalizedStep),
      continuation_allowed: cleanText(observability.recovery_action || "") !== "failed",
    },
    artifact: {
      artifact_id: cleanText(observability.artifact_id || "") || null,
      artifact_type: cleanText(observability.artifact_type || "") || null,
      validity_status: cleanText(observability.validity_status || "") || null,
      dependency_type: cleanText(observability.dependency_type || "") || null,
      dependency_blocked_step: cleanText(observability.dependency_blocked_step || "") || null,
      invalid_artifacts: invalidArtifacts,
      blocked_dependency_count: blockedDependencies.length,
      dependencies_allow_skip: blockedDependencies.length === 0,
    },
    task_plan: {
      task_id: cleanText(taskId || "") || null,
      plan_id: cleanText(observability.plan_id || "") || null,
      plan_status: cleanText(observability.plan_status || "") || null,
      current_step_id: cleanText(observability.current_step || "") || null,
      current_step_status: cleanText(normalizedStep?.status || "") || null,
      failure_class: cleanText(observability.failure_class || "") || null,
      step_retryable: normalizedStep?.retryable !== false,
      step_non_critical: isNonCriticalExecutionPlanStep(normalizedStep),
      malformed_input: Boolean(cleanText(observability.plan_id || "") && cleanText(observability.current_step || "") && !normalizedStep),
    },
  });
  observability.advisor = advisorDecision;
  observability.advisor_based_on_summary = formatStepDecisionAdvisorBasedOnSummary(advisorDecision.based_on);
  observability.advisor_vs_actual = null;
  observability.advisor_alignment = null;
  observability.advisor_alignment_summary = null;
  observability.decision_promotion = null;
  observability.decision_promotion_summary = null;
  observability.promotion_policy = null;
  observability.promotion_policy_summary = null;
  observability.promotion_audit = null;
  observability.promotion_audit_summary = null;
  observability.decision_scoreboard = null;
  observability.decision_scoreboard_summary = null;
  observability.highest_maturity_actions = null;
  observability.rollback_disabled_actions = null;
  observability.reroute_target = null;
  observability.reroute_reason = null;
  observability.reroute_source = null;
  observability.reroute_target_verified = null;
  observability.ask_user_gate = null;
  observability.ask_user_blocked_reason = null;
  observability.ask_user_recalibrated = false;
  observability.ask_user_recalibration_summary = null;
}

function applyStepDecisionAdvisorComparisonObservability({
  observability = null,
  selectedAction = "",
  routingLocked = false,
  stopError = "",
  taskPhase = "",
  taskStatus = "",
  promotionPolicy = null,
  decisionScoreboard = null,
  rerouteContext = null,
  askUserGateContext = null,
} = {}) {
  if (!observability || typeof observability !== "object" || Array.isArray(observability)) {
    return null;
  }
  if (!observability.advisor || typeof observability.advisor !== "object" || Array.isArray(observability.advisor)) {
    return null;
  }
  const actualNextAction = resolveStepDecisionAdvisorActualAction({
    selected_action: selectedAction,
    recovery_action: cleanText(observability.recovery_action || "") || null,
    task_phase: taskPhase,
    task_status: taskStatus,
    routing_locked: routingLocked === true,
    stop_error: stopError,
  });
  const advisorAlignment = buildStepDecisionAdvisorComparison({
    decision: observability.advisor,
    actual_next_action: actualNextAction,
    alignment_context: {
      readiness: observability.readiness && typeof observability.readiness === "object" && !Array.isArray(observability.readiness)
        ? observability.readiness
        : null,
      outcome: {
        outcome_status: observability.outcome_status,
        outcome_confidence: observability.outcome_confidence,
        outcome_evidence: observability.outcome_evidence,
        artifact_quality: observability.artifact_quality,
        retry_worthiness: observability.retry_worthiness,
        user_visible_completeness: observability.user_visible_completeness,
      },
      recovery: {
        recovery_policy: cleanText(observability.recovery_policy || "") || null,
        recovery_action: cleanText(observability.recovery_action || "") || null,
        recovery_attempt_count: Number.isFinite(Number(observability.recovery_attempt_count))
          ? Number(observability.recovery_attempt_count)
          : 0,
      },
      routing_overrode_advisor: routingLocked === false
        && Boolean(cleanText(selectedAction || ""))
        && cleanText(observability.advisor.recommended_next_action || "") !== "proceed"
        && actualNextAction === "proceed",
      recovery_overrode_advisor: Boolean(cleanText(observability.recovery_action || "")),
      malformed_input: observability.advisor?.based_on?.task_plan_summary?.malformed_input === true,
    },
  });
  observability.advisor_vs_actual = advisorAlignment;
  observability.advisor_alignment = advisorAlignment;
  observability.advisor_alignment_summary = formatAdvisorAlignmentSummary(advisorAlignment);
  const advisorBasedOn = observability.advisor.based_on && typeof observability.advisor.based_on === "object"
    && !Array.isArray(observability.advisor.based_on)
    ? observability.advisor.based_on
    : {};
  const promotionDecision = evaluateDecisionEnginePromotion({
    advisor: observability.advisor,
    advisor_alignment: advisorAlignment,
    readiness: advisorBasedOn.readiness_summary || null,
    outcome: advisorBasedOn.outcome_summary || null,
    recovery: advisorBasedOn.recovery_summary || null,
    artifact: advisorBasedOn.artifact_summary || null,
    task_plan: advisorBasedOn.task_plan_summary || null,
    promotion_policy: promotionPolicy,
    decision_scoreboard: decisionScoreboard,
    reroute_context: rerouteContext,
    ask_user_gate: askUserGateContext,
  });
  observability.decision_promotion = promotionDecision;
  observability.decision_promotion_summary = formatDecisionPromotionSummary(promotionDecision);
  observability.ask_user_gate = promotionDecision?.ask_user_gate || null;
  observability.ask_user_blocked_reason = cleanText(promotionDecision?.ask_user_blocked_reason || "") || null;
  observability.ask_user_recalibrated = promotionDecision?.ask_user_recalibrated === true;
  observability.ask_user_recalibration_summary = cleanText(promotionDecision?.ask_user_recalibration_summary || "") || null;
  return {
    actual_next_action: actualNextAction,
    promotion_decision: promotionDecision,
  };
}

function resolveTaskTransitionTarget(transition = "", fallback = "") {
  const normalizedTransition = cleanText(transition || "");
  if (!normalizedTransition || !normalizedTransition.includes("->")) {
    return cleanText(fallback || "") || null;
  }
  const [, toRaw] = normalizedTransition.split("->");
  return cleanText(toRaw || "") || cleanText(fallback || "") || null;
}

function resolvePlannerWorkingMemoryExecutionPlanAction({
  workingMemory = null,
  text = "",
  semantics = null,
  allowFailedStep = false,
  allowBlockedStep = false,
} = {}) {
  const { plan, step } = resolvePlannerWorkingMemoryCurrentPlanStep(workingMemory?.execution_plan || null);
  if (!plan || !step) {
    return null;
  }
  if (step.status === "completed" || step.status === "skipped") {
    return null;
  }
  if (step.status === "failed" && !allowFailedStep) {
    return null;
  }
  if (step.status === "blocked" && !allowBlockedStep) {
    return null;
  }
  const dependencyGuard = resolvePlannerWorkingMemoryCurrentStepDependencyGuard({
    plan,
    step,
  });
  if (dependencyGuard?.blocked) {
    return {
      plan_id: plan.plan_id,
      plan_status: plan.plan_status,
      current_step_id: step.step_id,
      step_status: step.status,
      step_retryable: step.retryable !== false,
      action: null,
      slot_requirements: step.slot_requirements || [],
      blocked_by_dependency: true,
      dependency_issue: dependencyGuard.issue,
    };
  }
  const intendedAction = cleanText(step.intended_action || "");
  if (!intendedAction || !canUseWorkingMemoryAction(intendedAction, { text, semantics })) {
    if (dependencyGuard?.issue) {
      return {
        plan_id: plan.plan_id,
        plan_status: plan.plan_status,
        current_step_id: step.step_id,
        step_status: step.status,
        step_retryable: step.retryable !== false,
        action: null,
        slot_requirements: step.slot_requirements || [],
        blocked_by_dependency: false,
        dependency_issue: dependencyGuard.issue,
      };
    }
    return null;
  }
  return {
    plan_id: plan.plan_id,
    plan_status: plan.plan_status,
    current_step_id: step.step_id,
    step_status: step.status,
    step_retryable: step.retryable !== false,
    action: intendedAction,
    slot_requirements: step.slot_requirements || [],
    blocked_by_dependency: false,
    dependency_issue: dependencyGuard?.issue || null,
  };
}

function resolvePlannerWorkingMemoryFailedStepRecovery({
  workingMemory = null,
  text = "",
  semantics = null,
} = {}) {
  const { plan, step } = resolvePlannerWorkingMemoryCurrentPlanStep(workingMemory?.execution_plan || null);
  if (!plan || !step || step.status !== "failed") {
    return null;
  }
  const recoveryState = step.recovery_state && typeof step.recovery_state === "object" && !Array.isArray(step.recovery_state)
    ? step.recovery_state
    : buildDefaultPlannerWorkingMemoryRecoveryState();
  const failureClass = normalizePlannerWorkingMemoryFailureClass(
    step.failure_class || recoveryState.last_failure_class,
    { allowNull: true },
  ) || "unknown";
  const recoveryPolicy = normalizePlannerWorkingMemoryRecoveryPolicy(step.recovery_policy, { allowNull: true }) || "ask_user";
  const recoveryAction = cleanText(recoveryState.last_recovery_action || recoveryPolicy || "ask_user");
  const rollbackTargetStepId = cleanText(recoveryState.rollback_target_step_id || "") || null;
  const recoveryAttemptCount = Number.isFinite(Number(recoveryState.recovery_attempt_count))
    ? Number(recoveryState.recovery_attempt_count)
    : 0;
  const canUseAction = (action = "", { bypassVisibility = false } = {}) => {
    const normalizedAction = cleanText(action || "");
    if (!normalizedAction) {
      return false;
    }
    if (!getPlannerActionContract(normalizedAction) && !getPlannerPreset(normalizedAction)) {
      return false;
    }
    if (bypassVisibility) {
      return true;
    }
    return canUseWorkingMemoryAction(normalizedAction, { text, semantics });
  };
  const response = {
    plan_id: plan.plan_id,
    plan_status: plan.plan_status,
    current_step_id: step.step_id,
    failure_class: failureClass,
    recovery_policy: recoveryPolicy,
    recovery_action: recoveryAction,
    recovery_attempt_count: recoveryAttemptCount,
    rollback_target_step_id: rollbackTargetStepId,
    skipped_step_ids: null,
    selected_action: null,
    reason: null,
    routing_reason: null,
    handoff: null,
  };

  if (recoveryAction === "retry_same_step" && canUseAction(step.intended_action, { bypassVisibility: true })) {
    response.selected_action = step.intended_action;
    response.reason = "working_memory_recovery_retry_same_step";
    response.routing_reason = response.reason;
    return response;
  }
  if (recoveryAction === "reroute_owner") {
    const rerouteAction = resolvePlannerWorkingMemoryRerouteAction({
      workingMemory,
      text,
      semantics,
    });
    if (rerouteAction && canUseAction(rerouteAction)) {
      response.selected_action = rerouteAction;
      response.reason = "working_memory_recovery_reroute_owner";
      response.routing_reason = response.reason;
      response.handoff = {
        from: cleanText(step.owner_agent || workingMemory?.current_owner_agent || "") || null,
        to: PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[rerouteAction] || null,
        reason: "capability_gap",
      };
      return response;
    }
    response.recovery_action = "ask_user";
    response.reason = "working_memory_recovery_ask_user";
    response.routing_reason = response.reason;
    return response;
  }
  if (recoveryAction === "rollback_to_step") {
    const rollbackTarget = rollbackTargetStepId
      ? (plan.steps || []).find((candidate) => cleanText(candidate?.step_id || "") === rollbackTargetStepId) || null
      : null;
    if (rollbackTarget?.intended_action && canUseAction(rollbackTarget.intended_action)) {
      response.selected_action = rollbackTarget.intended_action;
      response.current_step_id = rollbackTarget.step_id;
      response.reason = "working_memory_recovery_rollback_to_step";
      response.routing_reason = response.reason;
      return response;
    }
    response.recovery_action = "ask_user";
    response.reason = "working_memory_recovery_ask_user";
    response.routing_reason = response.reason;
    return response;
  }
  if (recoveryAction === "skip_step") {
    const currentIndex = (plan.steps || []).findIndex((candidate) => candidate.step_id === step.step_id);
    const nextStep = currentIndex >= 0
      ? (plan.steps || []).slice(currentIndex + 1).find((candidate) =>
        candidate
        && candidate.status !== "completed"
        && candidate.status !== "skipped")
      : null;
    response.skipped_step_ids = [step.step_id];
    if (nextStep?.intended_action && canUseAction(nextStep.intended_action)) {
      response.selected_action = nextStep.intended_action;
      response.current_step_id = nextStep.step_id;
      response.reason = "working_memory_recovery_skip_step";
      response.routing_reason = response.reason;
      return response;
    }
    response.reason = "working_memory_recovery_skip_step_noop";
    response.routing_reason = response.reason;
    return response;
  }
  if (recoveryAction === "ask_user") {
    response.reason = "working_memory_recovery_ask_user";
    response.routing_reason = response.reason;
    return response;
  }

  response.recovery_action = "failed";
  response.reason = "working_memory_recovery_failed_closed";
  response.routing_reason = response.reason;
  return response;
}

function resolvePlannerWorkingMemoryContinuation({
  userIntent = "",
  taskType = "",
  payload = {},
  sessionKey = "",
  logger = console,
  stage = "routing",
} = {}) {
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const ctx = { ...normalizedPayload };
  const readResult = readPlannerWorkingMemoryForRouting({ sessionKey });
  const observability = {
    memory_read_attempted: true,
    memory_hit: readResult?.observability?.memory_hit === true,
    memory_miss: readResult?.observability?.memory_miss !== false,
    memory_used_in_routing: false,
    memory_snapshot: readResult?.observability?.memory_snapshot || null,
    outcome_status: null,
    outcome_confidence: null,
    outcome_evidence: null,
    artifact_quality: null,
    retry_worthiness: null,
    user_visible_completeness: null,
    advisor: null,
    advisor_based_on_summary: null,
    advisor_vs_actual: null,
    advisor_alignment: null,
    advisor_alignment_summary: null,
    decision_promotion: null,
    decision_promotion_summary: null,
    promotion_policy: null,
    promotion_policy_summary: null,
    promotion_audit: null,
    promotion_audit_summary: null,
    decision_scoreboard: null,
    decision_scoreboard_summary: null,
    highest_maturity_actions: null,
    rollback_disabled_actions: null,
    reroute_target: null,
    reroute_reason: null,
    reroute_source: null,
    reroute_target_verified: null,
    ask_user_gate: null,
    ask_user_blocked_reason: null,
    ask_user_recalibrated: false,
    ask_user_recalibration_summary: null,
    slot_suppressed_ask: false,
    usage_layer: null,
    usage_layer_summary: null,
  };
  const applyUsageLayerPass = ({
    selectedAction = "",
    routingReason = "",
    unresolvedSlots = [],
    currentPlanStep = null,
    candidateActions = [],
    workingMemory = null,
    semantics = null,
  } = {}) => {
    const usagePass = evaluateUsageLayerIntelligencePass({
      requestText: userIntent,
      taskType,
      workingMemory,
      observability,
      unresolvedSlots,
      currentPlanStep: currentPlanStep?.step || null,
      semantics,
      routingReason,
      selectedAction,
      candidateActions,
      plannerEnvelope: null,
      userResponse: null,
    });
    observability.usage_layer = extractUsageLayerDiagnostics(usagePass);
    observability.usage_layer_summary = cleanText(usagePass?.summary || "") || null;
    return usagePass;
  };
  logPlannerWorkingMemoryTrace({
    logger,
    memoryStage: `${cleanText(stage) || "routing"}_pre_read`,
    sessionKey,
    observability,
    level: "debug",
  });
  const workingMemory = readResult?.data && typeof readResult.data === "object" && !Array.isArray(readResult.data)
    ? readResult.data
    : null;

  if (!workingMemory) {
    applyUsageLayerPass({
      selectedAction: "",
      routingReason: "working_memory_miss_new_task",
      unresolvedSlots: [],
      currentPlanStep: null,
      candidateActions: [],
      workingMemory: null,
      semantics: null,
    });
    return {
      selected_action: null,
      reason: null,
      routing_reason: null,
      routing_locked: false,
      stop_error: null,
      payload: ctx,
      observability,
    };
  }

  const semantics = derivePlannerUserInputSemantics(userIntent);
  const confidence = Number.isFinite(Number(workingMemory.confidence))
    ? Number(workingMemory.confidence)
    : null;
  const hasConfidence = confidence !== null;
  const confidenceAllowed = !hasConfidence || confidence >= PLANNER_WORKING_MEMORY_MIN_CONFIDENCE;
  const taskId = cleanText(workingMemory.task_id || "") || null;
  const taskStatus = cleanText(workingMemory.task_status || "") || "running";
  const taskPhase = cleanText(workingMemory.task_phase || "") || "init";
  const retryCount = Number.isFinite(Number(workingMemory.retry_count))
    ? Number(workingMemory.retry_count)
    : 0;
  const retryPolicy = normalizePlannerWorkingMemoryRetryPolicy(workingMemory.retry_policy);
  const unresolvedSlots = derivePlannerWorkingMemoryUnresolvedSlots({ workingMemory });
  const currentPlanStep = resolvePlannerWorkingMemoryCurrentPlanStep(workingMemory.execution_plan || null);
  const currentStepSlotRequirements = Array.from(new Set(
    (Array.isArray(currentPlanStep?.step?.slot_requirements)
      ? currentPlanStep.step.slot_requirements
      : [])
      .map((slot) => cleanText(slot))
      .filter(Boolean),
  ));
  const waitingUserSlotCoverage = hasAnyTrulyMissingRequiredSlot({
    required_slots: [
      ...currentStepSlotRequirements,
      ...unresolvedSlots,
    ],
    unresolved_slots: unresolvedSlots,
    slot_state: Array.isArray(workingMemory?.slot_state)
      ? workingMemory.slot_state
      : [],
  });
  const waitingUserRequiredSlotsFilled = taskPhase === "waiting_user"
    && waitingUserSlotCoverage.required_slots.length > 0
    && waitingUserSlotCoverage.malformed_input !== true
    && waitingUserSlotCoverage.has_any_truly_missing_required_slot !== true;
  if (waitingUserRequiredSlotsFilled) {
    ctx.__force_resume_after_slot_fill = true;
  }
  const effectiveUnresolvedSlots = waitingUserRequiredSlotsFilled
    ? []
    : unresolvedSlots;
  const retrySlots = {};
  for (const slotEntry of Array.isArray(workingMemory?.slot_state) ? workingMemory.slot_state : []) {
    const slotKey = cleanText(slotEntry?.slot_key || slotEntry?.key || "");
    if (!slotKey) {
      continue;
    }
    const status = cleanText(slotEntry?.status || "");
    const slotFilled = status === "filled"
      && slotEntry?.valid !== false
      && slotEntry?.expired !== true;
    if (slotFilled) {
      retrySlots[slotKey] = true;
    } else if (!Object.prototype.hasOwnProperty.call(retrySlots, slotKey)) {
      retrySlots[slotKey] = null;
    }
  }
  const retryRecoveryState = normalizePlannerWorkingMemoryRecoveryState(workingMemory?.recovery_state, { allowMissing: true })
    || buildDefaultPlannerWorkingMemoryRecoveryState();
  const retryPack = buildRetryContextPack({
    intent: cleanText(
      taskType
      || resolvePlannerWorkingMemoryTaskType(workingMemory)
      || workingMemory?.current_goal
      || currentPlanStep?.step?.intended_action
      || "",
    ) || null,
    slots: retrySlots,
    required_slots: Array.from(new Set(
      (Array.isArray(waitingUserSlotCoverage.required_slots) ? waitingUserSlotCoverage.required_slots : [])
        .map((slotKey) => cleanText(slotKey))
        .filter(Boolean),
    )),
    waiting_user: taskPhase === "waiting_user",
    last_failure: {
      class: retryRecoveryState.last_failure_class || null,
    },
    last_action: cleanText(currentPlanStep?.step?.intended_action || workingMemory?.next_best_action || ""),
    user_input_delta: userIntent,
  });

  if (retryPack.resume_instead_of_retry) {
    ctx.__retry_mode = "resume";
    ctx.__resumable_step = retryPack.resumable_step;
    ctx.__retry_user_visible_message =
      (retryPack.latest_user_delta ? `你剛補充了「${retryPack.latest_user_delta}」，` : ``) +
      (retryPack.resumable_step
        ? `我現在直接接著幫你處理「${retryPack.resumable_step}」。`
        : `我直接接著幫你處理下一步。`);
  }

  if (retryPack.degraded_retry) {
    ctx.__retry_mode = "degraded";
    ctx.__retry_degraded_reason = retryPack.degraded_reason_codes;
    ctx.__retry_user_visible_message = `目前資訊還不完整，我先整理已知內容再幫你往下處理。`;
  }

  const topicSwitch = isPlannerWorkingMemoryTopicSwitch({
    userIntent,
    taskType,
    semantics,
    workingMemory,
  });
  observability.task_id = taskId;
  observability.task_phase_transition = null;
  observability.task_status_transition = null;
  observability.agent_handoff = null;
  observability.retry_attempt = null;
  observability.slot_update = null;
  observability.plan_id = cleanText(currentPlanStep?.plan?.plan_id || "") || null;
  observability.plan_status = cleanText(currentPlanStep?.plan?.plan_status || "") || null;
  observability.current_step = cleanText(currentPlanStep?.step?.step_id || currentPlanStep?.plan?.current_step_id || "") || null;
  observability.step_transition = null;
  observability.failure_class = null;
  observability.recovery_policy = null;
  observability.recovery_action = null;
  observability.recovery_attempt_count = null;
  observability.rollback_target_step_id = null;
  observability.skipped_step_ids = null;
  observability.artifact_id = null;
  observability.artifact_type = null;
  observability.validity_status = null;
  observability.produced_by_step_id = null;
  observability.affected_downstream_steps = null;
  observability.dependency_type = null;
  observability.artifact_superseded = false;
  observability.dependency_blocked_step = null;
  observability.resumed_from_waiting_user = false;
  observability.resumed_from_retry = false;
  observability.readiness = null;
  observability.blocking_reason_codes = [];
  observability.missing_slots = [];
  observability.invalid_artifacts = [];
  observability.blocked_dependencies = [];
  observability.owner_ready = null;
  observability.recovery_ready = null;
  observability.recommended_action = null;
  observability.outcome_status = null;
  observability.outcome_confidence = null;
  observability.outcome_evidence = null;
  observability.artifact_quality = null;
  observability.retry_worthiness = null;
  observability.user_visible_completeness = null;
  observability.advisor = null;
  observability.advisor_based_on_summary = null;
  observability.advisor_vs_actual = null;
  observability.advisor_alignment = null;
  observability.advisor_alignment_summary = null;
  observability.decision_promotion = null;
  observability.decision_promotion_summary = null;
  observability.promotion_policy = null;
  observability.promotion_policy_summary = null;
  observability.promotion_audit = null;
  observability.promotion_audit_summary = null;
  observability.decision_scoreboard = null;
  observability.decision_scoreboard_summary = null;
  observability.highest_maturity_actions = null;
  observability.rollback_disabled_actions = null;
  observability.reroute_target = null;
  observability.reroute_reason = null;
  observability.reroute_source = null;
  observability.reroute_target_verified = null;
  observability.ask_user_gate = null;
  observability.ask_user_blocked_reason = null;
  observability.ask_user_recalibrated = false;
  observability.ask_user_recalibration_summary = null;
  observability.slot_suppressed_ask = false;
  observability.plan_invalidated = topicSwitch && currentPlanStep?.plan
    ? {
        plan_id: currentPlanStep.plan.plan_id,
        reason: "topic_switch",
      }
    : null;
  observability.task_abandoned = topicSwitch && taskId
    ? {
        task_id: taskId,
        reason: "topic_switch",
      }
    : null;
  if (topicSwitch) {
    applyUsageLayerPass({
      selectedAction: "",
      routingReason: "topic_switch_new_task",
      unresolvedSlots: effectiveUnresolvedSlots,
      currentPlanStep,
      candidateActions: [],
      workingMemory,
      semantics,
    });
    return {
      selected_action: null,
      reason: null,
      routing_reason: null,
      routing_locked: false,
      stop_error: null,
      payload: ctx,
      observability,
    };
  }
  const dependencyGuard = resolvePlannerWorkingMemoryCurrentStepDependencyGuard({
    plan: currentPlanStep?.plan || null,
    step: currentPlanStep?.step || null,
  });
  if (dependencyGuard?.issue && typeof dependencyGuard.issue === "object") {
    observability.artifact_id = dependencyGuard.issue.artifact_id || null;
    observability.artifact_type = dependencyGuard.issue.artifact_type || null;
    observability.validity_status = dependencyGuard.issue.validity_status || null;
    observability.produced_by_step_id = dependencyGuard.issue.produced_by_step_id || null;
    observability.affected_downstream_steps = Array.isArray(dependencyGuard.issue.affected_downstream_steps)
      ? dependencyGuard.issue.affected_downstream_steps
      : null;
    observability.dependency_type = dependencyGuard.issue.dependency_type || null;
    observability.artifact_superseded = dependencyGuard.issue.artifact_superseded === true;
    observability.dependency_blocked_step = dependencyGuard.issue.dependency_blocked_step || null;
  }
  const normalizedIntent = cleanText(userIntent);
  const waitingUserSlotFillAttempt = taskPhase === "waiting_user"
    && effectiveUnresolvedSlots.length > 0
    && normalizedIntent
    && !PLANNER_WORKING_MEMORY_ELLIPSIS_FOLLOW_UP_PATTERN.test(normalizedIntent);
  const readinessSlotStateOverride = (() => {
    if (!waitingUserSlotFillAttempt) {
      return null;
    }
    const provisionalSlotKeys = Array.from(new Set([
      ...(Array.isArray(currentPlanStep?.step?.slot_requirements)
        ? currentPlanStep.step.slot_requirements
        : []),
      ...effectiveUnresolvedSlots,
    ].map((slotKey) => cleanText(slotKey)).filter(Boolean)));
    if (provisionalSlotKeys.length === 0) {
      return [];
    }
    const requiredBy = cleanText(currentPlanStep?.step?.intended_action || "") || null;
    return provisionalSlotKeys.map((slotKey) => ({
      slot_key: slotKey,
      required_by: requiredBy,
      status: "filled",
      source: "inferred",
      ttl: null,
    }));
  })();
  const readinessUnresolvedSlots = waitingUserSlotFillAttempt
    ? []
    : effectiveUnresolvedSlots;
  const unresolvedAction = resolvePlannerWorkingMemoryActionFromSlots(effectiveUnresolvedSlots);
  const executionReadiness = resolvePlannerExecutionReadiness({
    workingMemory,
    currentPlanStep,
    unresolvedSlots: readinessUnresolvedSlots,
    taskId,
    slotStateOverride: readinessSlotStateOverride,
  });
  applyPlannerExecutionReadinessObservability({
    observability,
    readiness: executionReadiness,
  });
  const shouldContinueSameTask = Boolean(
    semantics.explicit_same_task
    || PLANNER_WORKING_MEMORY_RETRY_PATTERN.test(normalizedIntent)
    || PLANNER_WORKING_MEMORY_ELLIPSIS_FOLLOW_UP_PATTERN.test(normalizedIntent),
  );

  let selectedAction = "";
  let reason = "";
  let routingReason = "";
  let routingLocked = false;
  let stopError = null;
  let recoveryDecisionLocked = false;
  const runningOwnerAction = resolvePlannerWorkingMemoryOwnerAction({
    workingMemory,
    text: userIntent,
    semantics,
  });
  const waitingResumePlanAction = confidenceAllowed
    && taskPhase === "waiting_user"
    && effectiveUnresolvedSlots.length === 0
    ? resolvePlannerWorkingMemoryExecutionPlanAction({
        workingMemory,
        text: userIntent,
        semantics,
        allowBlockedStep: true,
        allowFailedStep: true,
      })
    : null;
  const waitingResumeAction = cleanText(
    retryPack.resumable_step
    || waitingResumePlanAction?.action
    || currentPlanStep?.step?.intended_action
    || runningOwnerAction
    || workingMemory?.next_best_action
    || "",
  );
  const shouldForceWaitingResume = Boolean(
    confidenceAllowed
    && taskPhase === "waiting_user"
    && effectiveUnresolvedSlots.length === 0
    && waitingResumeAction
    && canUseWorkingMemoryAction(waitingResumeAction, { text: userIntent, semantics }),
  );
  const slotCoverageForSuppression = derivePlannerWorkingMemorySlotCoverage({
    workingMemory,
    unresolvedSlots: effectiveUnresolvedSlots,
  });
  if (confidenceAllowed && executionReadiness && executionReadiness.is_ready === false && !shouldForceWaitingResume) {
    recoveryDecisionLocked = true;
    routingLocked = true;
    const primaryReadinessReason = resolvePlannerExecutionReadinessPrimaryReason(executionReadiness);
    stopError = primaryReadinessReason || null;
    observability.failure_class = resolvePlannerExecutionReadinessFailureClass(executionReadiness);
    const recommendedAction = cleanText(executionReadiness.recommended_action || "") || "fail";
    const rollbackTargetStepId = cleanText(executionReadiness.rollback_target_step_id || "") || null;
    const rollbackTargetStep = rollbackTargetStepId
      ? (currentPlanStep?.plan?.steps || []).find((candidate) => cleanText(candidate?.step_id || "") === rollbackTargetStepId) || null
      : null;
    const transitionToWaitingUser = () => {
      observability.task_phase_transition = `${taskPhase}->waiting_user`;
      observability.task_status_transition = `${taskStatus}->blocked`;
      observability.recovery_policy = "ask_user";
      observability.recovery_action = "ask_user";
      observability.slot_update = {
        mode: "ask_user",
        pending_slots: Array.isArray(executionReadiness.missing_slots)
          ? executionReadiness.missing_slots
          : effectiveUnresolvedSlots,
      };
    };
    if (recommendedAction === "rollback") {
      const rollbackAction = cleanText(rollbackTargetStep?.intended_action || "");
      observability.recovery_policy = "rollback_to_step";
      observability.recovery_action = "rollback_to_step";
      observability.rollback_target_step_id = rollbackTargetStepId || null;
      observability.recovery_attempt_count = retryCount + 1;
      if (rollbackAction && canUseWorkingMemoryAction(rollbackAction, { text: userIntent, semantics })) {
        selectedAction = rollbackAction;
        reason = "working_memory_execution_readiness_rollback";
        routingReason = reason;
        observability.current_step = rollbackTargetStepId || observability.current_step;
        observability.task_phase_transition = `${taskPhase}->retrying`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: "same_step",
        };
        observability.resumed_from_retry = true;
      } else {
        reason = "working_memory_execution_readiness_ask_user";
        routingReason = reason;
        transitionToWaitingUser();
      }
    } else if (recommendedAction === "reroute") {
      const rerouteAction = resolvePlannerWorkingMemoryRerouteAction({
        workingMemory,
        text: userIntent,
        semantics,
      });
      observability.recovery_policy = "reroute_owner";
      observability.recovery_action = "reroute_owner";
      observability.recovery_attempt_count = retryCount + 1;
      if (rerouteAction && canUseWorkingMemoryAction(rerouteAction, { text: userIntent, semantics })) {
        selectedAction = rerouteAction;
        reason = "working_memory_execution_readiness_reroute";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->retrying`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: "reroute",
        };
        observability.agent_handoff = {
          from: cleanText(workingMemory.current_owner_agent || "") || null,
          to: PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[rerouteAction] || null,
          reason: "capability_gap",
        };
        observability.resumed_from_retry = true;
      } else {
        reason = "working_memory_execution_readiness_ask_user";
        routingReason = reason;
        transitionToWaitingUser();
      }
    } else if (recommendedAction === "retry") {
      const retryAction = cleanText(currentPlanStep?.step?.intended_action || "");
      observability.recovery_policy = "retry_same_step";
      observability.recovery_action = "retry_same_step";
      observability.recovery_attempt_count = retryCount + 1;
      if (retryAction && canUseWorkingMemoryAction(retryAction, { text: userIntent, semantics })) {
        selectedAction = retryAction;
        reason = "working_memory_execution_readiness_retry";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->retrying`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: "same_step",
        };
        observability.resumed_from_retry = true;
      } else {
        reason = "working_memory_execution_readiness_fail_closed";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->failed`;
        observability.task_status_transition = `${taskStatus}->failed`;
      }
    } else if (recommendedAction === "skip") {
      const currentIndex = (currentPlanStep?.plan?.steps || []).findIndex((candidate) =>
        cleanText(candidate?.step_id || "") === cleanText(currentPlanStep?.step?.step_id || ""));
      const nextStep = currentIndex >= 0
        ? (currentPlanStep?.plan?.steps || []).slice(currentIndex + 1).find((candidate) =>
          candidate
          && cleanText(candidate.status || "") !== "completed"
          && cleanText(candidate.status || "") !== "skipped")
        : null;
      const skipAction = cleanText(nextStep?.intended_action || "");
      observability.recovery_policy = "skip_step";
      observability.recovery_action = "skip_step";
      observability.skipped_step_ids = currentPlanStep?.step?.step_id
        ? [currentPlanStep.step.step_id]
        : null;
      if (skipAction && canUseWorkingMemoryAction(skipAction, { text: userIntent, semantics })) {
        selectedAction = skipAction;
        reason = "working_memory_execution_readiness_skip";
        routingReason = reason;
        observability.current_step = cleanText(nextStep?.step_id || "") || observability.current_step;
        observability.task_phase_transition = `${taskPhase}->executing`;
        observability.task_status_transition = `${taskStatus}->running`;
      } else {
        reason = "working_memory_execution_readiness_fail_closed";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->failed`;
        observability.task_status_transition = `${taskStatus}->failed`;
      }
    } else if (recommendedAction === "ask_user") {
      reason = "working_memory_execution_readiness_ask_user";
      routingReason = reason;
      transitionToWaitingUser();
      stopError = primaryReadinessReason || "missing_slot";
    } else {
      reason = "working_memory_execution_readiness_fail_closed";
      routingReason = reason;
      observability.recovery_policy = "ask_user";
      observability.recovery_action = "failed";
      observability.task_phase_transition = `${taskPhase}->failed`;
      observability.task_status_transition = `${taskStatus}->failed`;
      stopError = primaryReadinessReason || "business_error";
    }
  } else if (
    confidenceAllowed
    && taskStatus === "failed"
  ) {
    const recoveryDecision = resolvePlannerWorkingMemoryFailedStepRecovery({
      workingMemory,
      text: userIntent,
      semantics,
    });
    if (recoveryDecision) {
      recoveryDecisionLocked = true;
      selectedAction = recoveryDecision.selected_action || "";
      reason = recoveryDecision.reason || "";
      routingReason = recoveryDecision.routing_reason || reason || "";
      observability.failure_class = recoveryDecision.failure_class || null;
      observability.recovery_policy = recoveryDecision.recovery_policy || null;
      observability.recovery_action = recoveryDecision.recovery_action || null;
      observability.recovery_attempt_count = Number.isFinite(Number(recoveryDecision.recovery_attempt_count))
        ? Number(recoveryDecision.recovery_attempt_count)
        : null;
      observability.rollback_target_step_id = recoveryDecision.rollback_target_step_id || null;
      observability.skipped_step_ids = Array.isArray(recoveryDecision.skipped_step_ids) && recoveryDecision.skipped_step_ids.length > 0
        ? recoveryDecision.skipped_step_ids
        : null;
      observability.plan_id = recoveryDecision.plan_id || observability.plan_id;
      observability.plan_status = recoveryDecision.plan_status || observability.plan_status;
      observability.current_step = recoveryDecision.current_step_id || observability.current_step;
      if (selectedAction) {
        observability.task_phase_transition = "failed->retrying";
        observability.task_status_transition = "failed->failed";
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: recoveryDecision.recovery_action === "reroute_owner" ? "reroute" : "same_step",
        };
        observability.resumed_from_retry = true;
      } else if (recoveryDecision.recovery_action === "ask_user") {
        observability.task_phase_transition = "failed->waiting_user";
        observability.task_status_transition = "failed->blocked";
      }
      if (recoveryDecision.handoff && typeof recoveryDecision.handoff === "object" && !Array.isArray(recoveryDecision.handoff)) {
        observability.agent_handoff = {
          from: cleanText(recoveryDecision.handoff.from || "") || null,
          to: cleanText(recoveryDecision.handoff.to || "") || null,
          reason: cleanText(recoveryDecision.handoff.reason || "") || "capability_gap",
        };
      }
    } else if (retryCount < retryPolicy.max_retries) {
      const retryPlanAction = resolvePlannerWorkingMemoryExecutionPlanAction({
        workingMemory,
        text: userIntent,
        semantics,
        allowFailedStep: true,
        allowBlockedStep: true,
      });
      if (retryPlanAction?.blocked_by_dependency) {
        recoveryDecisionLocked = true;
        const dependencyIssue = retryPlanAction.dependency_issue || {};
        observability.failure_class = "invalid_artifact";
        observability.recovery_policy = dependencyIssue.rollback_target_step_id
          ? "rollback_to_step"
          : "ask_user";
        observability.recovery_action = observability.recovery_policy;
        observability.rollback_target_step_id = dependencyIssue.rollback_target_step_id || null;
        observability.artifact_id = dependencyIssue.artifact_id || observability.artifact_id;
        observability.artifact_type = dependencyIssue.artifact_type || observability.artifact_type;
        observability.validity_status = dependencyIssue.validity_status || observability.validity_status;
        observability.produced_by_step_id = dependencyIssue.produced_by_step_id || observability.produced_by_step_id;
        observability.affected_downstream_steps = Array.isArray(dependencyIssue.affected_downstream_steps)
          ? dependencyIssue.affected_downstream_steps
          : observability.affected_downstream_steps;
        observability.dependency_type = dependencyIssue.dependency_type || observability.dependency_type;
        observability.artifact_superseded = dependencyIssue.artifact_superseded === true || observability.artifact_superseded === true;
        observability.dependency_blocked_step = dependencyIssue.dependency_blocked_step || observability.dependency_blocked_step;
        observability.task_phase_transition = "failed->waiting_user";
        observability.task_status_transition = "failed->blocked";
        reason = "working_memory_artifact_dependency_ask_user";
        routingReason = reason;
      }
      const retryMode = derivePlannerWorkingMemoryRetryMode({
        retryPolicy,
        retryCount,
      });
      const retryAction = retryMode === "reroute"
        ? resolvePlannerWorkingMemoryRerouteAction({
            workingMemory,
            text: userIntent,
            semantics,
          })
        : retryPlanAction?.action || runningOwnerAction;
      if (!recoveryDecisionLocked && retryAction && canUseWorkingMemoryAction(retryAction, { text: userIntent, semantics })) {
        selectedAction = retryAction;
        reason = retryMode === "reroute"
          ? "working_memory_retry_reroute"
          : retryPlanAction?.action && retryAction === retryPlanAction.action
            ? "working_memory_retry_same_step"
            : "working_memory_retry_same_agent";
        routingReason = reason;
        observability.task_phase_transition = "failed->retrying";
        observability.task_status_transition = "failed->failed";
        observability.retry_attempt = {
          task_id: taskId,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: retryMode,
        };
        observability.recovery_action = retryMode === "reroute" ? "reroute_owner" : "retry_same_step";
        observability.recovery_policy = observability.recovery_action;
        observability.recovery_attempt_count = retryCount + 1;
        observability.resumed_from_retry = Boolean(retryPlanAction?.action && retryAction === retryPlanAction.action);
        if (retryPlanAction?.action && retryAction === retryPlanAction.action) {
          observability.plan_id = retryPlanAction.plan_id || observability.plan_id;
          observability.plan_status = retryPlanAction.plan_status || observability.plan_status;
          observability.current_step = retryPlanAction.current_step_id || observability.current_step;
        }
        if (retryMode === "reroute") {
          const fromAgent = cleanText(workingMemory.current_owner_agent || "") || null;
          const toAgent = PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[retryAction] || null;
          observability.agent_handoff = {
            from: fromAgent,
            to: toAgent,
            reason: "retry",
          };
        }
      }
    }
  } else if (
    confidenceAllowed
    && taskPhase === "waiting_user"
    && effectiveUnresolvedSlots.length > 0
  ) {
    const waitingPlanAction = resolvePlannerWorkingMemoryExecutionPlanAction({
      workingMemory,
      text: userIntent,
      semantics,
      allowBlockedStep: true,
      allowFailedStep: true,
    });
    if (waitingPlanAction?.blocked_by_dependency) {
      recoveryDecisionLocked = true;
      const dependencyIssue = waitingPlanAction.dependency_issue || {};
      observability.failure_class = "invalid_artifact";
      observability.recovery_policy = dependencyIssue.rollback_target_step_id
        ? "rollback_to_step"
        : "ask_user";
      observability.recovery_action = observability.recovery_policy;
      observability.rollback_target_step_id = dependencyIssue.rollback_target_step_id || null;
      observability.artifact_id = dependencyIssue.artifact_id || observability.artifact_id;
      observability.artifact_type = dependencyIssue.artifact_type || observability.artifact_type;
      observability.validity_status = dependencyIssue.validity_status || observability.validity_status;
      observability.produced_by_step_id = dependencyIssue.produced_by_step_id || observability.produced_by_step_id;
      observability.affected_downstream_steps = Array.isArray(dependencyIssue.affected_downstream_steps)
        ? dependencyIssue.affected_downstream_steps
        : observability.affected_downstream_steps;
      observability.dependency_type = dependencyIssue.dependency_type || observability.dependency_type;
      observability.artifact_superseded = dependencyIssue.artifact_superseded === true || observability.artifact_superseded === true;
      observability.dependency_blocked_step = dependencyIssue.dependency_blocked_step || observability.dependency_blocked_step;
      observability.task_phase_transition = "waiting_user->waiting_user";
      observability.task_status_transition = "blocked->blocked";
      reason = "working_memory_artifact_dependency_ask_user";
      routingReason = reason;
    }
    const waitingActionCandidates = [
      waitingPlanAction?.action || "",
      unresolvedAction,
      cleanText(workingMemory.next_best_action || ""),
      runningOwnerAction,
    ];
    const waitingAction = waitingActionCandidates.find((action) => canUseWorkingMemoryAction(action, {
      text: userIntent,
      semantics,
    })) || "";
    if (!recoveryDecisionLocked && waitingAction) {
      selectedAction = waitingAction;
      reason = waitingPlanAction?.action && waitingAction === waitingPlanAction.action
        ? "working_memory_waiting_user_resume_plan_step"
        : "working_memory_waiting_user_slot_fill";
      routingReason = reason;
      observability.task_phase_transition = "waiting_user->executing";
      observability.task_status_transition = "blocked->running";
      observability.slot_update = {
        mode: "slot_fill",
        pending_slots: effectiveUnresolvedSlots,
      };
      observability.resumed_from_waiting_user = Boolean(waitingPlanAction?.action && waitingAction === waitingPlanAction.action);
      if (waitingPlanAction?.action && waitingAction === waitingPlanAction.action) {
        observability.plan_id = waitingPlanAction.plan_id || observability.plan_id;
        observability.plan_status = waitingPlanAction.plan_status || observability.plan_status;
        observability.current_step = waitingPlanAction.current_step_id || observability.current_step;
      }
    }
  } else if (
    confidenceAllowed
    && taskPhase === "waiting_user"
    && effectiveUnresolvedSlots.length === 0
  ) {
    if (waitingResumeAction && canUseWorkingMemoryAction(waitingResumeAction, { text: userIntent, semantics })) {
      selectedAction = waitingResumeAction;
      reason = "working_memory_waiting_user_resume_plan_step";
      routingReason = reason;
      observability.task_phase_transition = "waiting_user->executing";
      observability.task_status_transition = "blocked->running";
      observability.slot_update = {
        mode: "slot_resume",
        pending_slots: [],
      };
      observability.resumed_from_waiting_user = true;
      ctx.__slot_fill_resumed = true;
      observability.plan_id = waitingResumePlanAction?.plan_id || observability.plan_id;
      observability.plan_status = waitingResumePlanAction?.plan_status || observability.plan_status;
      observability.current_step = waitingResumePlanAction?.current_step_id || observability.current_step;
    }
  }
  if (
    !selectedAction
    && !recoveryDecisionLocked
    && confidenceAllowed
    && taskStatus === "running"
    && effectiveUnresolvedSlots.length === 0
  ) {
    const activePlanAction = resolvePlannerWorkingMemoryExecutionPlanAction({
      workingMemory,
      text: userIntent,
      semantics,
      allowBlockedStep: false,
      allowFailedStep: false,
    });
    if (activePlanAction?.action) {
      selectedAction = activePlanAction.action;
      reason = "working_memory_active_plan_continuation";
      routingReason = "working_memory_active_plan_continuation";
      observability.plan_id = activePlanAction.plan_id || observability.plan_id;
      observability.plan_status = activePlanAction.plan_status || observability.plan_status;
      observability.current_step = activePlanAction.current_step_id || observability.current_step;
    }
  }
  if (
    !selectedAction
    && !recoveryDecisionLocked
    && confidenceAllowed
    && taskStatus === "running"
    && effectiveUnresolvedSlots.length === 0
    && runningOwnerAction
  ) {
    selectedAction = runningOwnerAction;
    reason = "working_memory_running_owner";
    routingReason = "working_memory_running_owner";
  } else if (!selectedAction && !recoveryDecisionLocked && confidenceAllowed && unresolvedAction && canUseWorkingMemoryAction(unresolvedAction, {
    text: userIntent,
    semantics,
  })) {
    selectedAction = unresolvedAction;
    reason = "working_memory_unresolved_slots";
    routingReason = "working_memory_unresolved_slots";
  } else if (!selectedAction && !recoveryDecisionLocked && confidenceAllowed && shouldContinueSameTask) {
    const skillAction = cleanText(workingMemory.last_selected_skill || "");
    const nextBestAction = cleanText(workingMemory.next_best_action || "");
    const agentActionHint = PLANNER_WORKING_MEMORY_AGENT_ACTION_HINTS[cleanText(workingMemory.last_selected_agent || "")] || "";
    const skillActionReusable = skillAction
      && getPlannerSkillAction(skillAction)
      && isPlannerSkillActionCatalogVisible(skillAction)
      && isPlannerDecisionCatalogVisible(skillAction, {
        text: userIntent,
        semantics,
      })
      ? skillAction
      : "";
    const candidateActions = [
      skillActionReusable,
      nextBestAction,
      agentActionHint,
    ];
    const reusableAction = candidateActions.find((action) => canUseWorkingMemoryAction(action, {
      text: userIntent,
      semantics,
    }));
    if (reusableAction) {
      selectedAction = reusableAction;
      reason = skillAction && reusableAction === skillAction
        ? "working_memory_reuse_skill"
        : "working_memory_reuse_action";
      routingReason = reason;
    }
  }
  const askLikeSignal = cleanText(observability?.recovery_action || "") === "ask_user"
    || cleanText(observability?.recovery_policy || "") === "ask_user"
    || cleanText(observability?.recommended_action || "") === "ask_user"
    || cleanText(observability?.decision_promotion?.promoted_action || "") === "ask_user";
  if (
    confidenceAllowed
    && askLikeSignal
    && slotCoverageForSuppression.has_reusable_filled_slot
    && !slotCoverageForSuppression.has_missing_slots
  ) {
    const suppressionCandidates = [
      waitingResumePlanAction?.action || "",
      cleanText(currentPlanStep?.step?.intended_action || ""),
      runningOwnerAction,
      cleanText(workingMemory?.next_best_action || ""),
      cleanText(workingMemory?.last_selected_skill || ""),
    ].map((candidate) => cleanText(candidate)).filter(Boolean);
    const suppressionAction = suppressionCandidates.find((candidate) => canUseWorkingMemoryAction(candidate, {
      text: userIntent,
      semantics,
    })) || "";
    if (suppressionAction) {
      selectedAction = suppressionAction;
      reason = taskPhase === "waiting_user"
        ? "working_memory_slot_suppressed_resume_plan_step"
        : "working_memory_slot_suppressed_resume";
      routingReason = reason;
      routingLocked = false;
      recoveryDecisionLocked = false;
      stopError = null;
      observability.slot_suppressed_ask = true;
      observability.recovery_policy = null;
      observability.recovery_action = null;
      observability.task_phase_transition = `${taskPhase}->executing`;
      observability.task_status_transition = `${taskStatus}->running`;
      observability.slot_update = {
        mode: "slot_resume",
        pending_slots: [],
      };
      observability.resumed_from_waiting_user = taskPhase === "waiting_user";
      if (taskPhase === "waiting_user") {
        ctx.__slot_fill_resumed = true;
      }
      if (waitingResumePlanAction?.action && suppressionAction === waitingResumePlanAction.action) {
        observability.plan_id = waitingResumePlanAction.plan_id || observability.plan_id;
        observability.plan_status = waitingResumePlanAction.plan_status || observability.plan_status;
        observability.current_step = waitingResumePlanAction.current_step_id || observability.current_step;
      }
    }
  }
  if (!selectedAction && !recoveryDecisionLocked && confidenceAllowed) {
    const usageFallback = evaluateUsageLayerIntelligencePass({
      requestText: userIntent,
      taskType,
      workingMemory,
      observability,
      unresolvedSlots: effectiveUnresolvedSlots,
      currentPlanStep: currentPlanStep?.step || null,
      semantics,
      routingReason,
      selectedAction: "",
      candidateActions: [
        cleanText(currentPlanStep?.step?.intended_action || ""),
        unresolvedAction,
        cleanText(workingMemory?.next_best_action || ""),
        runningOwnerAction,
        cleanText(workingMemory?.last_selected_skill || ""),
      ],
      plannerEnvelope: null,
      userResponse: null,
    });
    if (usageFallback?.behavior?.prefer_continuation === true) {
      const continuationCandidates = Array.isArray(usageFallback?.behavior?.continuation_action_candidates)
        ? usageFallback.behavior.continuation_action_candidates
          .map((candidate) => cleanText(candidate))
          .filter(Boolean)
        : [];
      const fallbackAction = continuationCandidates
        .find((candidate) => canUseWorkingMemoryAction(candidate, { text: userIntent, semantics })) || "";
      if (fallbackAction) {
        selectedAction = fallbackAction;
        const activeStepAction = cleanText(currentPlanStep?.step?.intended_action || "");
        reason = fallbackAction === activeStepAction
          ? "working_memory_active_plan_continuation"
          : "working_memory_reuse_action";
        routingReason = reason;
      }
    }
  }

  applyPlannerExecutionOutcomeObservability({
    observability,
    currentPlanStep,
    executionReadiness,
    unresolvedSlots: effectiveUnresolvedSlots,
    stopError,
  });
  applyStepDecisionAdvisorObservability({
    observability,
    currentPlanStep,
    taskId,
    retryPolicy,
    retryCount,
  });
  const promotionAuditState = getPlannerPromotionAuditState({ sessionKey });
  const rollbackDisabledActions = listDecisionPromotionRollbackDisabledActions({
    state: promotionAuditState,
  });
  const promotionPolicy = resolveDecisionPromotionPolicy({
    state: promotionAuditState,
    rollback_disabled_actions: rollbackDisabledActions,
  });
  observability.promotion_policy = promotionPolicy;
  observability.promotion_policy_summary = formatPromotionControlSurfaceSummary(promotionPolicy);
  const prePromotionScoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: promotionAuditState,
    promotion_policy: promotionPolicy,
    observability,
  });
  const rerouteDecisionContext = buildPromotedRerouteDecisionContext({
    workingMemory,
    currentPlanStep,
    observability,
    text: userIntent,
    semantics,
  });
  const currentStepAction = cleanText(currentPlanStep?.step?.intended_action || "");
  const nextBestAction = cleanText(workingMemory?.next_best_action || "");
  const currentStepResumeAvailable = Boolean(
    currentStepAction
    && canUseWorkingMemoryAction(currentStepAction, { text: userIntent, semantics }),
  );
  const nextBestActionAvailable = Boolean(
    nextBestAction
    && canUseWorkingMemoryAction(nextBestAction, { text: userIntent, semantics }),
  );
  const waitingResumeAvailable = Boolean(
    waitingResumeAction
    && canUseWorkingMemoryAction(waitingResumeAction, { text: userIntent, semantics }),
  );
  const askUserGateContext = {
    task_phase: taskPhase,
    required_slots: waitingUserSlotCoverage.required_slots,
    unresolved_slots: effectiveUnresolvedSlots,
    truly_missing_slots: waitingUserSlotCoverage.truly_missing_slots,
    slot_state: Array.isArray(workingMemory?.slot_state)
      ? workingMemory.slot_state
      : [],
    current_step_action: currentStepAction || null,
    next_best_action: nextBestAction || null,
    current_step_resume_available: currentStepResumeAvailable,
    next_best_action_available: nextBestActionAvailable,
    resume_action_available: waitingResumeAvailable,
    slot_suppressed_ask: observability.slot_suppressed_ask === true
      || (slotCoverageForSuppression.has_reusable_filled_slot && !slotCoverageForSuppression.has_missing_slots),
    waiting_user_all_required_slots_filled: waitingUserRequiredSlotsFilled,
    continuation_ready: retryPack.continuation_ready === true
      || shouldForceWaitingResume
      || waitingResumeAvailable
      || currentStepResumeAvailable
      || nextBestActionAvailable,
    malformed_input: waitingUserSlotCoverage.malformed_input === true,
  };
  const advisorComparison = applyStepDecisionAdvisorComparisonObservability({
    observability,
    selectedAction,
    routingLocked,
    stopError,
    taskPhase: resolveTaskTransitionTarget(observability.task_phase_transition, taskPhase),
    taskStatus: resolveTaskTransitionTarget(observability.task_status_transition, taskStatus),
    promotionPolicy,
    decisionScoreboard: prePromotionScoreboard,
    rerouteContext: rerouteDecisionContext,
    askUserGateContext,
  });
  let promotionDecision = advisorComparison?.promotion_decision
    && typeof advisorComparison.promotion_decision === "object"
    && !Array.isArray(advisorComparison.promotion_decision)
    ? advisorComparison.promotion_decision
    : null;
  const promotionCandidateAction = cleanText(
    promotionDecision?.promoted_action
    || observability.advisor?.recommended_next_action
    || "",
  );
  const promotionRollbackGate = resolveDecisionPromotionRollbackGate({
    state: promotionAuditState,
    promoted_action: promotionCandidateAction,
    promotion_policy: promotionPolicy,
  });
  if (
    promotionDecision?.promotion_applied === true
    && promotionCandidateAction
    && promotionRollbackGate.promotion_allowed !== true
  ) {
    const gatedPromotionDecision = {
      ...promotionDecision,
      promoted_action: null,
      promotion_applied: false,
      safety_gate_passed: false,
      promotion_confidence: "low",
      promotion_reason_codes: appendUniqueReasonCode(
        promotionDecision?.promotion_reason_codes,
        DECISION_ENGINE_PROMOTION_ROLLBACK_REASON_CODE,
      ),
    };
    observability.decision_promotion = gatedPromotionDecision;
    observability.decision_promotion_summary = formatDecisionPromotionSummary(gatedPromotionDecision);
    observability.ask_user_gate = gatedPromotionDecision.ask_user_gate || null;
    observability.ask_user_blocked_reason = cleanText(gatedPromotionDecision.ask_user_blocked_reason || "") || null;
    observability.ask_user_recalibrated = gatedPromotionDecision.ask_user_recalibrated === true;
    observability.ask_user_recalibration_summary = cleanText(gatedPromotionDecision.ask_user_recalibration_summary || "") || null;
    promotionDecision = gatedPromotionDecision;
  }
  const promotedAction = cleanText(promotionDecision?.promoted_action || "");
  if (promotionDecision?.promotion_applied === true && (promotedAction === "ask_user" || promotedAction === "retry" || promotedAction === "reroute" || promotedAction === "fail")) {
    routingLocked = true;
    selectedAction = "";
    if (promotedAction === "ask_user") {
      reason = "decision_engine_promotion_ask_user";
      routingReason = reason;
      observability.task_phase_transition = `${taskPhase}->waiting_user`;
      observability.task_status_transition = `${taskStatus}->blocked`;
      observability.recovery_policy = "ask_user";
      observability.recovery_action = "ask_user";
      observability.slot_update = {
        mode: "ask_user",
        pending_slots: Array.isArray(executionReadiness?.missing_slots)
          ? executionReadiness.missing_slots
          : effectiveUnresolvedSlots,
      };
      if (!cleanText(stopError || "")) {
        stopError = resolvePlannerExecutionReadinessPrimaryReason(executionReadiness) || "missing_slot";
      }
    } else if (promotedAction === "retry") {
      const retryAction = cleanText(currentPlanStep?.step?.intended_action || "");
      observability.recovery_policy = "retry_same_step";
      observability.recovery_action = "retry_same_step";
      observability.recovery_attempt_count = retryCount + 1;
      if (retryAction && canUseWorkingMemoryAction(retryAction, { text: userIntent, semantics })) {
        selectedAction = retryAction;
        reason = "decision_engine_promotion_retry";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->retrying`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: "same_step",
        };
        observability.resumed_from_retry = true;
      } else {
        reason = "decision_engine_promotion_retry_fail_closed";
        routingReason = reason;
        observability.recovery_action = "failed";
        observability.task_phase_transition = `${taskPhase}->failed`;
        observability.task_status_transition = `${taskStatus}->failed`;
        if (!cleanText(stopError || "")) {
          stopError = resolvePlannerExecutionReadinessPrimaryReason(executionReadiness) || "business_error";
        }
      }
    } else if (promotedAction === "reroute") {
      const rerouteDecision = resolvePromotedRerouteExecution({
        workingMemory,
        currentPlanStep,
        observability,
        text: userIntent,
        semantics,
        canUseAction: (action) => canUseWorkingMemoryAction(action, { text: userIntent, semantics }),
      });
      if (rerouteDecision.ok === true) {
        selectedAction = rerouteDecision.reroute_action;
        reason = "decision_engine_promotion_reroute";
        routingReason = reason;
        observability.task_phase_transition = `${taskPhase}->retrying`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.recovery_policy = "reroute_owner";
        observability.recovery_action = "reroute_owner";
        observability.recovery_attempt_count = retryCount + 1;
        observability.retry_attempt = {
          task_id: taskId,
          from: retryCount,
          retry_count: retryCount + 1,
          max_retries: retryPolicy.max_retries,
          strategy: retryPolicy.strategy,
          mode: "reroute",
        };
        observability.agent_handoff = {
          from: rerouteDecision.previous_owner_agent || null,
          to: rerouteDecision.current_owner_agent || null,
          reason: rerouteDecision.reroute_reason || "capability_gap",
        };
        observability.reroute_target = rerouteDecision.reroute_target || rerouteDecision.current_owner_agent || null;
        observability.reroute_reason = rerouteDecision.reroute_reason || null;
        observability.reroute_source = rerouteDecision.reroute_source || "promoted_decision_engine_v1";
        observability.reroute_target_verified = rerouteDecision.reroute_target_verified === true;
        observability.resumed_from_retry = true;
        promotionDecision = {
          ...promotionDecision,
          previous_owner_agent: rerouteDecision.previous_owner_agent || null,
          current_owner_agent: rerouteDecision.current_owner_agent || null,
          reroute_target: observability.reroute_target,
          reroute_reason: observability.reroute_reason,
          reroute_source: observability.reroute_source,
          reroute_target_verified: true,
        };
        observability.decision_promotion = promotionDecision;
        observability.decision_promotion_summary = formatDecisionPromotionSummary(promotionDecision);
      } else {
        reason = "decision_engine_promotion_reroute_fail_closed";
        routingReason = reason;
        observability.recovery_policy = cleanText(observability.recovery_policy || "") || "ask_user";
        observability.recovery_action = "failed";
        observability.task_phase_transition = `${taskPhase}->failed`;
        observability.task_status_transition = `${taskStatus}->failed`;
        observability.reroute_target = null;
        observability.reroute_reason = rerouteDecision.reroute_reason || null;
        observability.reroute_source = "promoted_decision_engine_v1";
        observability.reroute_target_verified = false;
        const failClosedPromotionDecision = {
          ...promotionDecision,
          promoted_action: null,
          promotion_applied: false,
          safety_gate_passed: false,
          promotion_confidence: "low",
          previous_owner_agent: cleanText(workingMemory?.current_owner_agent || "") || null,
          current_owner_agent: null,
          reroute_target: null,
          reroute_reason: observability.reroute_reason,
          reroute_source: observability.reroute_source,
          reroute_target_verified: false,
          promotion_reason_codes: appendUniqueReasonCode(
            promotionDecision?.promotion_reason_codes,
            rerouteDecision.reason_code || "reroute_target_unverified",
          ),
        };
        promotionDecision = failClosedPromotionDecision;
        observability.decision_promotion = failClosedPromotionDecision;
        observability.decision_promotion_summary = formatDecisionPromotionSummary(failClosedPromotionDecision);
        if (!cleanText(stopError || "")) {
          stopError = resolvePlannerExecutionReadinessPrimaryReason(executionReadiness) || "business_error";
        }
      }
    } else if (promotedAction === "fail") {
      reason = "decision_engine_promotion_fail";
      routingReason = reason;
      observability.task_phase_transition = `${taskPhase}->failed`;
      observability.task_status_transition = `${taskStatus}->failed`;
      observability.recovery_policy = cleanText(observability.recovery_policy || "") || "ask_user";
      observability.recovery_action = "failed";
      if (!cleanText(stopError || "")) {
        stopError = resolvePlannerExecutionReadinessPrimaryReason(executionReadiness) || "business_error";
      }
    }
  }
  const finalTaskStatus = resolveTaskTransitionTarget(observability.task_status_transition, taskStatus);
  const advisorBasedOn = observability.advisor?.based_on
    && typeof observability.advisor.based_on === "object"
    && !Array.isArray(observability.advisor.based_on)
    ? observability.advisor.based_on
    : {};
  const promotionAuditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: promotedAction || promotionCandidateAction || null,
    promotion_decision: promotionDecision,
    advisor: observability.advisor || null,
    advisor_alignment: observability.advisor_alignment || observability.advisor_vs_actual || null,
    readiness: advisorBasedOn.readiness_summary || observability.readiness || null,
    outcome: advisorBasedOn.outcome_summary || {
      outcome_status: observability.outcome_status,
      outcome_confidence: observability.outcome_confidence,
      outcome_evidence: observability.outcome_evidence,
      artifact_quality: observability.artifact_quality,
      retry_worthiness: observability.retry_worthiness,
      user_visible_completeness: observability.user_visible_completeness,
    },
    recovery: advisorBasedOn.recovery_summary || {
      recovery_policy: observability.recovery_policy,
      recovery_action: observability.recovery_action,
      recovery_attempt_count: observability.recovery_attempt_count,
      rollback_target_step_id: observability.rollback_target_step_id,
    },
    artifact: advisorBasedOn.artifact_summary || {
      artifact_id: observability.artifact_id,
      artifact_type: observability.artifact_type,
      validity_status: observability.validity_status,
      produced_by_step_id: observability.produced_by_step_id,
      affected_downstream_steps: observability.affected_downstream_steps,
      dependency_type: observability.dependency_type,
      dependency_blocked_step: observability.dependency_blocked_step,
    },
    task_plan: advisorBasedOn.task_plan_summary || {
      task_id: taskId,
      plan_id: observability.plan_id,
      plan_status: observability.plan_status,
      current_step_id: observability.current_step,
    },
    final_step_status: finalTaskStatus,
    outcome_status: observability.outcome_status,
    user_visible_completeness: observability.user_visible_completeness,
    rollback_flag: promotionRollbackGate.rollback_flag === true,
  });
  const promotionSafetyResult = applyDecisionPromotionAuditSafety({
    state: promotionAuditState,
    audit_record: promotionAuditRecord,
    promotion_policy: promotionPolicy,
  });
  setPlannerPromotionAuditState({
    sessionKey,
    state: promotionSafetyResult.next_state,
  });
  observability.promotion_audit = promotionSafetyResult.audit_record;
  observability.promotion_audit_summary = formatDecisionPromotionAuditSummary(promotionSafetyResult.audit_record);
  const decisionScoreboard = buildDecisionMetricsScoreboard({
    promotion_audit_state: promotionSafetyResult.next_state,
    promotion_policy: promotionPolicy,
    observability,
  });
  observability.decision_scoreboard = decisionScoreboard;
  observability.decision_scoreboard_summary = formatDecisionMetricsScoreboardSummary(decisionScoreboard);
  observability.highest_maturity_actions = Array.isArray(decisionScoreboard.highest_maturity_actions)
    ? decisionScoreboard.highest_maturity_actions
    : [];
  observability.rollback_disabled_actions = Array.isArray(decisionScoreboard.rollback_disabled_actions)
    ? decisionScoreboard.rollback_disabled_actions
    : [];
  applyUsageLayerPass({
    selectedAction,
    routingReason,
    unresolvedSlots: effectiveUnresolvedSlots,
    currentPlanStep,
    candidateActions: [
      cleanText(currentPlanStep?.step?.intended_action || ""),
      unresolvedAction,
      cleanText(workingMemory?.next_best_action || ""),
      runningOwnerAction,
      cleanText(workingMemory?.last_selected_skill || ""),
    ],
    workingMemory,
    semantics,
  });
  observability.memory_used_in_routing = Boolean(selectedAction) || routingLocked;
  return {
    selected_action: selectedAction || null,
    reason: reason || null,
    routing_reason: routingReason || null,
    routing_locked: routingLocked === true,
    stop_error: cleanText(stopError || "") || null,
    payload: ctx,
    observability,
  };
}

function buildPlannerWorkingMemoryContinuationParams({
  action = "",
  text = "",
  payload = {},
  workingMemory = null,
} = {}) {
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? normalizePlannerPayload(payload)
    : {};
  const normalizedAction = cleanText(action);
  if (normalizedAction === "search_company_brain_docs" || normalizedAction === "search_and_summarize") {
    const query = cleanText(normalizedPayload.q || normalizedPayload.query || text || workingMemory?.current_goal || "");
    return query
      ? {
          ...normalizedPayload,
          q: query,
        }
      : normalizedPayload;
  }
  return normalizedPayload;
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

  const skillSelection = selectPlannerSkillActionForTaskType({
    taskType: normalizedTaskType,
  });
  const skillSelectionTelemetry = buildPlannerSkillSelectionTelemetry({
    taskType: normalizedTaskType,
    selection: skillSelection,
  });

  if (skillSelection.ok === true) {
    selectedAction = skillSelection.action;
    reason = skillSelection.reason;
    routingReason = skillSelection.routing_reason;
  } else if (
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
    routingReason = "selector_search_company_brain_docs";
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
  routingReason = normalizePlannerRoutingReason(routingReason);

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
    ...skillSelectionTelemetry,
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

  if (getPlannerSkillAction(normalizedSelectorAction)) {
    return true;
  }

  return normalizedHardRoutedAction === "search_company_brain_docs"
    && Boolean(normalizedSelectorAction)
    && normalizedSelectorAction !== normalizedHardRoutedAction
    && normalizedSelectorAction !== "search_and_detail_doc";
}

function resolveSelectionOwnerAgent({
  action = "",
  workingMemory = null,
  currentPlanStep = null,
} = {}) {
  const normalizedAction = cleanText(action || "");
  if (!normalizedAction) {
    return null;
  }
  const planStep = currentPlanStep?.step && typeof currentPlanStep.step === "object" && !Array.isArray(currentPlanStep.step)
    ? currentPlanStep.step
    : null;
  if (cleanText(planStep?.intended_action || "") === normalizedAction) {
    const stepOwner = cleanText(planStep?.owner_agent || "");
    if (stepOwner) {
      return stepOwner;
    }
  }
  const actionOwner = cleanText(PLANNER_WORKING_MEMORY_ACTION_OWNER_HINTS[normalizedAction] || "");
  if (actionOwner) {
    return actionOwner;
  }
  const nextBestAction = cleanText(workingMemory?.next_best_action || "");
  if (nextBestAction && nextBestAction === normalizedAction) {
    return cleanText(workingMemory?.current_owner_agent || workingMemory?.last_selected_agent || "") || null;
  }
  return null;
}

function shouldAllowOwnerSwitchForSelection({
  selectedOwner = "",
  currentOwner = "",
  observability = null,
  currentPlanStep = null,
} = {}) {
  const normalizedSelectedOwner = cleanText(selectedOwner || "");
  const normalizedCurrentOwner = cleanText(currentOwner || "");
  if (!normalizedSelectedOwner || !normalizedCurrentOwner || normalizedSelectedOwner === normalizedCurrentOwner) {
    return true;
  }
  const failureClass = cleanText(observability?.failure_class || "");
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const recoveryPolicy = cleanText(observability?.recovery_policy || "");
  const handoffReason = cleanText(observability?.agent_handoff?.reason || observability?.reroute_reason || "");
  const readinessReasons = Array.isArray(observability?.blocking_reason_codes)
    ? observability.blocking_reason_codes.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const explicitOwnerMismatch = failureClass === "owner_mismatch"
    || handoffReason === "owner_mismatch"
    || readinessReasons.includes("owner_mismatch");
  const explicitCapabilityGap = failureClass === "capability_gap"
    || handoffReason === "capability_gap";
  const rerouteAllowed = recoveryAction === "reroute_owner" || recoveryPolicy === "reroute_owner";
  const expectedOwner = cleanText(currentPlanStep?.step?.owner_agent || "");
  const explicitStepOwnerSwitch = Boolean(expectedOwner && normalizedSelectedOwner === expectedOwner && expectedOwner !== normalizedCurrentOwner);
  return rerouteAllowed
    || explicitOwnerMismatch
    || explicitCapabilityGap
    || explicitStepOwnerSwitch;
}

function applyOwnerContinuitySelectionGuard({
  selection = null,
  userIntent = "",
  workingMemory = null,
  observability = null,
} = {}) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return {
      selection,
      guard_applied: false,
    };
  }
  const selectedAction = cleanText(selection?.selected_action || "");
  if (!selectedAction) {
    return {
      selection,
      guard_applied: false,
    };
  }
  const currentPlanStep = resolvePlannerWorkingMemoryCurrentPlanStep(workingMemory?.execution_plan || null);
  const currentOwner = cleanText(workingMemory?.current_owner_agent || workingMemory?.last_selected_agent || "");
  const selectedOwner = resolveSelectionOwnerAgent({
    action: selectedAction,
    workingMemory,
    currentPlanStep,
  });
  if (!currentOwner || !selectedOwner || currentOwner === selectedOwner) {
    return {
      selection,
      guard_applied: false,
    };
  }
  const allowSwitch = shouldAllowOwnerSwitchForSelection({
    selectedOwner,
    currentOwner,
    observability,
    currentPlanStep,
  });
  if (allowSwitch) {
    return {
      selection,
      guard_applied: false,
    };
  }
  const semantics = derivePlannerUserInputSemantics(userIntent);
  const ownerAction = resolvePlannerWorkingMemoryOwnerAction({
    workingMemory,
    text: userIntent,
    semantics,
  });
  const fallbackAction = cleanText(ownerAction || "");
  const fallbackOwner = resolveSelectionOwnerAgent({
    action: fallbackAction,
    workingMemory,
    currentPlanStep,
  });
  if (!fallbackAction || fallbackAction === selectedAction || !canUseWorkingMemoryAction(fallbackAction, { text: userIntent, semantics })) {
    return {
      selection,
      guard_applied: false,
    };
  }
  if (!fallbackOwner || fallbackOwner !== currentOwner) {
    return {
      selection,
      guard_applied: false,
    };
  }
  return {
    selection: {
      ...selection,
      selected_action: fallbackAction,
      reason: `owner continuity guard: 保持 ${currentOwner}，不做非必要 owner 切換。`,
      routing_reason: normalizePlannerRoutingReason(
        cleanText(selection?.routing_reason || ""),
        "working_memory_owner_continuity_guard",
      ) || "working_memory_owner_continuity_guard",
    },
    guard_applied: true,
  };
}

// ---------------------------------------------------------------------------
// Planner action dispatch runtime
// ---------------------------------------------------------------------------

export async function dispatchPlannerTool({
  action = "",
  payload = {},
  requestText = "",
  documentFetcher = fetchDocumentPlainText,
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
  const skillAction = getPlannerSkillAction(runtimeInput.action);
  const normalizedAuthContext = normalizePlannerAuthContext(authContext);
  const runtimePayload = maybeBackfillPlannerAccountId({
    action: runtimeInput.action,
    payload: runtimeInput.payload,
    authContext: normalizedAuthContext,
  });
  const preAbortResult = buildPlannerAbortResult({
    action: runtimeInput.action,
    signal,
  });
  if (preAbortResult) {
    emitToolExecutionLog({
      logger,
      requestId,
      action: runtimeInput.action,
      params: runtimePayload,
      success: false,
      data: buildPlannerToolExecutionData(preAbortResult),
      error: preAbortResult.error,
      traceId: preAbortResult.trace_id || null,
    });
    return preAbortResult;
  }
  if (runtimeInput.action === FETCH_DOCUMENT_ACTION) {
    const fetchDocumentResult = await dispatchPlannerFetchDocument({
      payload: runtimePayload,
      requestText,
      authContext: normalizedAuthContext,
      documentFetcher,
      signal,
    });
    emitToolExecutionLog({
      logger,
      requestId,
      action: runtimeInput.action,
      params: runtimePayload,
      success: fetchDocumentResult?.ok === true,
      data: buildPlannerToolExecutionData(fetchDocumentResult),
      error: fetchDocumentResult?.ok === false ? fetchDocumentResult?.error || "business_error" : null,
      traceId: fetchDocumentResult?.trace_id || null,
    });
    return fetchDocumentResult;
  }
  if (!tool && !skillAction) {
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
      params: runtimePayload,
      success: false,
      data: buildPlannerToolExecutionData(stoppedResult),
      error: stoppedResult.error,
      traceId: stoppedResult.trace_id || null,
    });
    return stoppedResult;
  }

  const dispatchTargetAction = tool?.action || skillAction?.action || runtimeInput.action;
  const resolvedInput = resolveDispatchInput({
    action: dispatchTargetAction,
    payload: runtimePayload,
    logger,
  });
  if (!resolvedInput.ok) {
    logPlannerTrace(logger, "warn", buildPlannerTraceEvent({
      eventType: "planner_tool_dispatch",
      action: dispatchTargetAction,
      ok: false,
      error: "contract_violation",
      extra: {
        phase: "input",
        violations: resolvedInput.result?.data?.violations || [],
      },
    }));
    const stoppedResult = withDispatchMeta(buildPlannerStoppedResult({
      action: dispatchTargetAction,
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
      action: dispatchTargetAction,
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
      action: dispatchTargetAction,
      params: runtimePayload,
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

  if (skillAction) {
    const bridgeResult = await runPlannerSkillBridge({
      action: skillAction.action,
      payload: effectivePayload,
      logger,
      signal,
    });
    const outputValidation = validateOutput(skillAction.action, bridgeResult);
    const bridgeValidatedResult = outputValidation.ok
      ? bridgeResult
      : buildPlannerStoppedResult({
          action: skillAction.action,
          error: "contract_violation",
          data: {
            phase: "output",
            violations: outputValidation.violations,
            raw: bridgeResult,
          },
          traceId: bridgeResult?.trace_id || null,
        });
    const retryCount = selfHealRetryCount;
    const normalizedResult = bridgeValidatedResult?.ok === false
      ? buildPlannerStoppedResult({
          action: skillAction.action,
          error: bridgeValidatedResult?.error || "business_error",
          data: bridgeValidatedResult?.data || {},
          traceId: bridgeValidatedResult?.trace_id || null,
        })
      : bridgeValidatedResult;
    if (normalizedResult?.ok === false) {
      emitPlannerRuntimeTrace(logger, buildPlannerTraceEvent({
        eventType: "stopped",
        action: skillAction.action,
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
      action: skillAction.action,
      params: effectivePayload,
      success: finalResult?.ok === true,
      data: buildPlannerToolExecutionData(finalResult),
      error: finalResult?.ok === false ? finalResult?.error || "business_error" : null,
      traceId: finalResult?.trace_id || null,
      extra: buildPlannerSkillToolExecutionExtra({
        skillAction,
        result: finalResult,
      }),
    });
    return finalResult;
  }

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
    const data = normalizePlannerDispatchActionResult(
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
        const localFallback = await attemptLocalPlannerReadonlyFallback({
          action: tool.action,
          payload: effectivePayload,
          authContext: normalizedAuthContext,
        });
        if (localFallback) {
          return localFallback;
        }
      }
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

async function runSafeToolExecution(action = "", actionArgs = {}, ctx = {}) {
  const normalizedAction = cleanText(action || "");
  if (!normalizedAction || !ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
    return null;
  }

  const toolContract = resolveToolContract(normalizedAction);
  if (!toolContract) {
    return null;
  }

  const toolCheck = validateToolInvocation(normalizedAction, actionArgs || {});
  ctx.__tool_layer_contract = {
    action: normalizedAction,
    capability: toolContract.capability,
    valid: toolCheck.ok === true,
    invalid_reason: toolCheck.ok ? null : toolCheck.reason,
    missing_args: Array.isArray(toolCheck.missing) ? toolCheck.missing : [],
  };

  if (!toolCheck.ok) {
    ctx.__tool_layer_blocked = true;
    return {
      next_action: "resume_previous_task",
      reason: "tool_layer_blocked",
      resume: true,
    };
  }

  try {
    const toolRes = await executeTool(normalizedAction, actionArgs || {}, ctx);
    ctx.__tool_execution = toolRes;
    if (!toolRes?.ok) {
      ctx.__tool_execution_failed = true;
    }
  } catch (_) {
    ctx.__tool_execution_failed = true;
  }

  if (ctx.__tool_execution) {
    const continuation = resolveToolResultContinuation(ctx.__tool_execution, ctx);
    ctx.__tool_result_continuation = continuation;
    if (continuation?.next_action === "retry") {
      ctx.__resumed_from_tool_failure = true;
    }
    if (continuation?.next_action === "continue_planner") {
      ctx.__resumed_from_tool_success = true;
    }
    if (continuation?.next_action === "fallback") {
      ctx.__tool_fallback_triggered = true;
    }
    return continuation;
  }

  return null;
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
  requestId = "",
  telemetryContext = null,
  telemetryAdapter = null,
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
      routingReason: normalizePlannerRoutingReason(
        cleanText(forcedSelection?.routing_reason || forcedSelection?.reason || ""),
        "forced_selection",
      ) || "forced_selection",
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
        routing_reason: normalizePlannerRoutingReason(
          cleanText(forcedSelection.routing_reason || forcedSelection.reason || ""),
          "forced_selection",
        ) || "forced_selection",
      }
    : null;
  const memoryContinuation = resolvePlannerWorkingMemoryContinuation({
    userIntent: agentInput.user_intent,
    taskType: agentInput.task_type,
    payload: agentInput.payload,
    sessionKey,
    logger,
    stage: "runPlannerToolFlow",
  });
  const memoryRoutingLocked = !normalizedForcedSelection && memoryContinuation?.routing_locked === true;
  const plannerDocQueryContext = getPlannerDocQueryContext({ sessionKey });
  const taskLifecycleFollowUp = (!disableAutoRouting && !normalizedForcedSelection && !memoryRoutingLocked)
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
    : memoryRoutingLocked
      ? {
          flow: null,
          action: null,
          payload: memoryContinuation?.payload || agentInput.payload,
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
    || memoryRoutingLocked
    ? null
    : selector({
        userIntent: agentInput.user_intent,
        taskType: agentInput.task_type,
        logger,
      });
  const lockedMemorySelection = !normalizedForcedSelection && memoryRoutingLocked
    ? {
        selected_action: cleanText(memoryContinuation?.selected_action || "") || null,
        reason: cleanText(memoryContinuation?.reason || "") || "working_memory_execution_readiness_gate",
        routing_reason: normalizePlannerRoutingReason(
          cleanText(memoryContinuation?.routing_reason || ""),
          "working_memory_execution_readiness_gate",
        ) || "working_memory_execution_readiness_gate",
      }
    : null;
  const memorySelection = !normalizedForcedSelection
    && !memoryRoutingLocked
    && !taskLifecycleFollowUp?.selected_action
    && !disableAutoRouting
    && !cleanText(hardRoutedAction || "")
    && cleanText(memoryContinuation?.selected_action || "")
    ? {
        selected_action: cleanText(memoryContinuation.selected_action) || null,
        reason: cleanText(memoryContinuation.reason || "") || "working_memory_reuse_action",
        routing_reason: normalizePlannerRoutingReason(
          cleanText(memoryContinuation.routing_reason || ""),
          "working_memory_reuse_action",
        ) || "working_memory_reuse_action",
      }
    : null;
  const prefersSelectorSelection = !normalizedForcedSelection
    && !taskLifecycleFollowUp?.selected_action
    && shouldPreferSelectorAction({
      hardRoutedAction: !disableAutoRouting ? routedFlow.action : null,
      selectorAction: selectorSelection?.selected_action,
    });
  const initialSelection = normalizedForcedSelection
    ? normalizedForcedSelection
    : lockedMemorySelection
    ? lockedMemorySelection
    : prefersSelectorSelection
    ? {
        ...selectorSelection,
        reason: selectorSelection?.reason || "命中更具體的 selector 規則，覆蓋 generic search hard route。",
        routing_reason: normalizePlannerRoutingReason(
          cleanText(selectorSelection?.routing_reason || ""),
          "selector_override_generic_search_route",
        ) || "selector_override_generic_search_route",
      }
    : memorySelection
    ? memorySelection
    : hardRoutedAction
    ? {
        selected_action: hardRoutedAction,
        reason: taskLifecycleFollowUp?.reason || "命中硬路由規則。",
        routing_reason: normalizePlannerRoutingReason(
          cleanText(taskLifecycleFollowUp?.routing_reason || routedFlow?.routing_reason || ""),
          "hard_route_match",
        ) || "hard_route_match",
      }
    : selectorSelection;
  const workingMemorySnapshot = memoryContinuation?.observability?.memory_snapshot
    && typeof memoryContinuation.observability.memory_snapshot === "object"
    && !Array.isArray(memoryContinuation.observability.memory_snapshot)
    ? memoryContinuation.observability.memory_snapshot
    : null;
  const ownerGuardedSelection = (!normalizedForcedSelection && !memoryRoutingLocked && !taskLifecycleFollowUp?.selected_action)
    ? applyOwnerContinuitySelectionGuard({
        selection: initialSelection,
        userIntent: agentInput.user_intent,
        workingMemory: workingMemorySnapshot,
        observability: memoryContinuation?.observability || null,
      })
    : { selection: initialSelection, guard_applied: false };
  const selection = ownerGuardedSelection.selection;
  const memoryUsedInRouting = memoryRoutingLocked || Boolean(memorySelection && selection === memorySelection);
  if (memoryContinuation?.observability && typeof memoryContinuation.observability === "object") {
    memoryContinuation.observability.memory_used_in_routing = memoryUsedInRouting;
    if (ownerGuardedSelection.guard_applied === true) {
      memoryContinuation.observability.owner_continuity_guard_applied = true;
    }
  }
  logPlannerWorkingMemoryTrace({
    logger,
    memoryStage: "runPlannerToolFlow_router_decision",
    sessionKey,
    observability: memoryContinuation?.observability || null,
    selectedAction: selection?.selected_action || null,
    routingReason: selection?.routing_reason || null,
    level: "debug",
  });
  const selectionRoutingReason = normalizePlannerRoutingReason(cleanText(selection?.routing_reason || ""))
    || (cleanText(selection?.selected_action || "") ? "selector_match" : "routing_no_match");
  const selectionReasoning = normalizeDecisionReasoning({
    why: selection?.why || selection?.reason || null,
    alternative: selection?.alternative || buildUserInputDecisionAlternative({
      action: selection?.selected_action || null,
    }),
  });
  const existingPlannerVisibleTelemetryContext = getPlannerVisibleTelemetryContext(telemetryContext)
    || (telemetryContext && typeof telemetryContext === "object" && !Array.isArray(telemetryContext)
      ? telemetryContext
      : null);
  const plannerVisibleMonitor = existingPlannerVisibleTelemetryContext
    ? {
        context: updatePlannerVisibleTelemetryContext(existingPlannerVisibleTelemetryContext, {
          selected_skill: getPlannerSkillAction(selection?.selected_action)?.planner_catalog_eligible === true
            ? cleanText(selection?.selected_action || "") || null
            : null,
          routing_family: resolvePlannerVisibleTelemetryRoutingFamily({
            action: selection?.selected_action,
            queryType: existingPlannerVisibleTelemetryContext?.query_type || null,
          }),
          decision_reason: selectionReasoning.why || selection?.reason || null,
          task_type: agentInput.task_type,
        }),
      }
    : createPlannerVisibleTelemetryMonitor({
        text: agentInput.user_intent,
        taskType: agentInput.task_type,
        selectedAction: selection?.selected_action,
        decisionReason: selectionReasoning.why || selection?.reason || null,
        requestId,
        telemetryAdapter,
      });
  if (plannerVisibleMonitor?.context) {
    attachPlannerVisibleTelemetryAdapter(plannerVisibleMonitor.context, telemetryAdapter);
  }
  emitPlannerVisibleTelemetryForMonitor({
    monitor: plannerVisibleMonitor,
    selectedAction: selection?.selected_action,
  });

  let executionResult = null;
  let formattedOutput = null;
  let traceId = null;
  let lifecycleSnapshot = taskLifecycleFollowUp?.snapshot || null;
  const selectionAction = cleanText(selection?.selected_action || "");
  const lockedStopError = memoryRoutingLocked
    ? cleanText(memoryContinuation?.stop_error || "")
    : "";

  if (!selectionAction) {
    maybeInvokePlannerHook(hooks, "onEscalation", {
      from: "planner_selection",
      reason: selectionRoutingReason || ROUTING_NO_MATCH,
    });
    executionResult = buildPlannerStoppedResult({
      action: null,
      error: lockedStopError || "business_error",
      data: {
        reason: selectionRoutingReason,
        message: memoryRoutingLocked
          ? "execution_readiness_gate_blocked"
          : "未命中受控工具規則，保持空選擇。",
        routing_reason: selectionRoutingReason,
        ...(memoryRoutingLocked && memoryContinuation?.observability?.readiness
          ? {
              readiness: memoryContinuation.observability.readiness,
              recommended_action: cleanText(memoryContinuation?.observability?.recommended_action || "") || null,
            }
          : {}),
      },
      traceId: null,
      stopReason: lockedStopError || "business_error",
    });
  } else if (
    !taskLifecycleFollowUp?.execution_result
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
      formattedOutput = extractPlannerFormattedOutput(executionResult);
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
          embedFormattedOutput: false,
        });
        formattedOutput = buildPlannerPendingItemActionFormattedOutput({
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
      const dispatchPayload = buildPlannerFlowPayload({
        flow: selectedFlow,
        action: selection.selected_action,
        userIntent: agentInput.user_intent,
        payload: agentInput.payload,
        logger,
        sessionKey,
      });
      await runSafeToolExecution(selection.selected_action, dispatchPayload, {
        retry_count: Number.isFinite(Number(workingMemorySnapshot?.retry_count))
          ? Number(workingMemorySnapshot.retry_count)
          : 0,
        retry_policy: workingMemorySnapshot?.retry_policy || null,
        waiting_user: workingMemorySnapshot?.task_phase === "waiting_user",
      });
      executionResult = await dispatcher({
        action: selection.selected_action,
        payload: shapePlannerSkillDispatchPayload({
          action: selection.selected_action,
          userIntent: agentInput.user_intent,
          payload: dispatchPayload,
          authContext,
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
    formattedOutput = normalizePlannerFormattedOutput(formattedOutput)
      || extractPlannerFormattedOutput(executionResult);
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
      ...(memoryContinuation?.observability && typeof memoryContinuation.observability === "object"
        ? memoryContinuation.observability
        : {}),
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
  formattedOutput = buildPlannerFormattedOutput({
    executionResult,
    formattedOutput,
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
        formattedOutput,
      }),
      buildPlannerLifecycleUnfinishedItems(lifecycleSnapshot),
    ),
    latestSelectedAction: selection.selected_action,
    latestTraceId: traceId,
    logger,
    reason: "post_run_planner_tool_flow",
    sessionKey,
  });

  const plannerOutput = buildPlannerAgentOutput({
    selectedAction: selection.selected_action,
    executionResult,
    formattedOutput,
    traceId,
    routingReason: selectionRoutingReason,
    taskType,
    payload: agentInput.payload,
  });
  if (plannerVisibleMonitor?.context) {
    updatePlannerVisibleTelemetryContext(plannerVisibleMonitor.context, {
      trace_id: traceId || executionResult?.trace_id || null,
    });
    attachPlannerVisibleTelemetryContext(plannerOutput, plannerVisibleMonitor.context);
  }
  return plannerOutput;
}

// ---------------------------------------------------------------------------
// Planner multi-step runtime
// ---------------------------------------------------------------------------

export async function runPlannerMultiStep({
  steps = [],
  logger = console,
  dispatcher = dispatchPlannerTool,
  documentFetcher = fetchDocumentPlainText,
  requestText = "",
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
      executionContext: null,
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
  let executionContext = derivePlannerExecutionContextFromResults(results);
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
      const result = step.action === FETCH_DOCUMENT_ACTION
        ? await dispatchPlannerFetchDocument({
            payload: step.payload,
            requestText,
            authContext,
            documentFetcher,
            signal,
          })
        : await dispatcher({
            action: step.action,
            payload: step.payload,
            requestText,
            context: executionContext,
            logger,
            authContext,
            signal,
          });
      results.push(result);
      traceId = result?.trace_id || traceId;

      if (result?.ok !== false) {
        if (step.action === FETCH_DOCUMENT_ACTION) {
          executionContext = mergePlannerExecutionContext(
            executionContext,
            buildPlannerDocumentExecutionContext(result),
          );
        }
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
    executionContext,
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
  const explicitAgentRequest = resolveRegisteredAgentFamilyRequest(text, {
    includeSlashCommand: true,
    includePersonaMentions: true,
    includeKnowledgeCommands: false,
  });
  const explicitAgentId = cleanText(explicitAgentRequest?.agent?.id || "");

  if (explicitAgentId && explicitAgentId !== "generalist") {
    return {
      action: activeTask ? "handoff" : "start",
      objective: text,
      primary_agent_id: activeTask?.primary_agent_id || explicitAgentId,
      next_agent_id: explicitAgentId,
      supporting_agent_ids: activeTask?.supporting_agent_ids || [],
      reason: explicitAgentRequest?.surface === "slash_command"
        ? `使用者明確指定 /${explicitAgentId}`
        : `使用者明確提到 ${explicitAgentId}`,
      pending_questions: [],
    };
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
  const actionSystemPrompt = readActionSystemPrompt();
  const messages = [
    ...(actionSystemPrompt ? [{ role: "system", content: actionSystemPrompt }] : []),
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
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
      messages,
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
    `如果 user_request 內有 document card、document_id 或 file link，steps 第一項必須是 {"action":"${FETCH_DOCUMENT_ACTION}","intent":"${FETCH_DOCUMENT_STEP_INTENT}","required":true}。`,
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
          `若 user_request 帶 document card、document_id 或 file link，steps 第一項必須加 {"action":"${FETCH_DOCUMENT_ACTION}","intent":"${FETCH_DOCUMENT_STEP_INTENT}","required":true}。`,
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
        text: plannerDecisionCatalogText({ text }),
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
    "那個文件",
    "那个文件",
    "這個文件",
    "这个文件",
    "這份",
    "这份",
    "那份",
    "這個",
    "这个",
    "那個",
    "那个",
    "這篇",
    "这篇",
    "那篇",
    "這則",
    "这则",
    "那則",
    "那则",
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
    "那個",
    "那个",
    "那份",
    "那篇",
    "這篇",
    "这篇",
    "那則",
    "那则",
    "這則",
    "这则",
    "第1份",
    "第一份",
    "第2份",
    "第二份",
    "第3份",
    "第三份",
    "第1個",
    "第一個",
    "第2個",
    "第二個",
    "第3個",
    "第三個",
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
  const wantsSearchSummary = wantsDocumentSearch && plannerTextHasAny(normalizedText, documentSummarySignals);
  const wantsDocumentLookup = wantsDocumentList || wantsDocumentSummary || wantsDocumentDetail || wantsDocumentSearch || plannerTextHasAny(normalizedText, [
    "company brain",
    "知識庫",
    "知识库",
  ]);

  return {
    normalized_text: normalizedText,
    wants_conversation_summary: wantsConversationSummary,
    wants_document_summary: wantsDocumentSummary,
    wants_search_summary: wantsSearchSummary,
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

function buildFetchDocumentStep() {
  return {
    action: FETCH_DOCUMENT_ACTION,
    intent: FETCH_DOCUMENT_STEP_INTENT,
    required: true,
  };
}

function normalizePlannerDecisionStep(step = {}) {
  const normalizedStep = {
    action: cleanText(step?.action || ""),
  };
  const rawParams = step?.params && typeof step.params === "object" && !Array.isArray(step.params)
    ? step.params
    : step?.payload && typeof step.payload === "object" && !Array.isArray(step.payload)
      ? step.payload
      : null;
  if (rawParams) {
    normalizedStep.params = normalizePlannerPayload(rawParams);
  }
  const intent = cleanText(step?.intent || "");
  if (intent) {
    normalizedStep.intent = intent;
  }
  if (typeof step?.required === "boolean") {
    normalizedStep.required = step.required;
  }
  return normalizedStep;
}

function buildPlannerValidatedStep({
  action = "",
  params = undefined,
  intent = "",
  required = undefined,
} = {}) {
  const normalizedAction = cleanText(action || "");
  const normalizedIntent = cleanText(intent || "");
  const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
    ? normalizePlannerPayload(params)
    : {};
  const step = {
    action: normalizedAction,
  };
  if (normalizedAction !== FETCH_DOCUMENT_ACTION) {
    step.params = normalizedParams;
  }
  if (normalizedIntent) {
    step.intent = normalizedIntent;
  }
  if (typeof required === "boolean") {
    step.required = required;
  }
  return step;
}

function derivePlannerDocumentReference(text = "") {
  const rawText = cleanText(text);
  const documentId = cleanText(extractDocumentId({ text: rawText }));
  const hasDocumentIdField = /\bdocument_id\b/i.test(rawText);
  const hasFileLink = /https?:\/\/\S+\/(?:docx|wiki)\//i.test(rawText);
  const hasFileLinkKeyword = /(?:file link|文件連結|文件链接|檔案連結|档案链接)/i.test(rawText);
  const hasDocumentCard = /(?:document card|文件卡片|文檔卡片|文档卡片)/i.test(rawText);
  return {
    document_id: documentId || null,
    has_reference: Boolean(documentId || hasDocumentIdField || hasFileLink || hasFileLinkKeyword || hasDocumentCard),
  };
}

function maybeAttachReferencedDocumentId({
  text = "",
  action = "",
  params = {},
} = {}) {
  const normalizedAction = cleanText(action || "");
  const normalizedParams = normalizePlannerPayload(params);
  if (
    ![
      FETCH_DOCUMENT_ACTION,
      "get_company_brain_doc_detail",
      "search_and_detail_doc",
      "document_summarize",
    ].includes(normalizedAction)
  ) {
    return normalizedParams;
  }
  if (cleanText(normalizedParams.doc_id || "")) {
    return normalizedParams;
  }
  const referencedDocument = derivePlannerDocumentReference(text);
  if (!cleanText(referencedDocument.document_id || "")) {
    return normalizedParams;
  }
  return {
    ...normalizedParams,
    doc_id: referencedDocument.document_id,
  };
}

function enforceFetchDocumentStepRequirement({
  text = "",
  decision = {},
} = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return decision;
  }
  const referencedDocument = derivePlannerDocumentReference(text);
  if (!referencedDocument.has_reference) {
    return decision;
  }

  const normalizedSteps = Array.isArray(decision.steps)
    ? decision.steps
      .map((step) => normalizePlannerDecisionStep(step))
      .filter((step) => cleanText(step.action))
      .map((step) => ({
        ...step,
        ...(step.params
          ? { params: maybeAttachReferencedDocumentId({ text, action: step.action, params: step.params }) }
          : {}),
      }))
    : cleanText(decision.action || "")
      ? [buildPlannerValidatedStep({
          action: cleanText(decision.action || ""),
          params: maybeAttachReferencedDocumentId({
            text,
            action: cleanText(decision.action || ""),
            params: decision.params,
          }),
        })]
      : [];

  if (normalizedSteps.length === 0) {
    return decision;
  }

  const remainingSteps = normalizedSteps.filter((step) => cleanText(step.action) !== FETCH_DOCUMENT_ACTION);
  return {
    steps: [
      buildFetchDocumentStep(),
      ...remainingSteps,
    ],
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
    ? maybeAttachReferencedDocumentId({
        text,
        action,
        params: normalizePlannerPayload(normalizedDecision.params),
      })
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

  if (action === "search_and_summarize") {
    const normalizedParams = params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
    const query = cleanText(normalizedParams.q || normalizedParams.query || "");
    if (!query) {
      return {
        decision: buildPlannerSingleStepDecision("search_and_summarize", {
          ...normalizedParams,
          q: cleanText(text) || "",
        }),
        reason: "skill_query_filled_from_user_request",
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

function getPlannerDecisionRepresentativeAction(decision = {}) {
  const actionNames = collectPlannerDecisionActionNames(decision);
  return actionNames.find((action) => action !== FETCH_DOCUMENT_ACTION) || actionNames[0] || null;
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
  const semanticActionNames = actionNames.filter((name) => name !== FETCH_DOCUMENT_ACTION);
  const allowedDocumentActions = new Set([
    "list_company_brain_docs",
    "search_company_brain_docs",
    "search_and_summarize",
    "document_summarize",
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

  if (semantics.wants_unsupported_slash_command && semanticActionNames.length > 0) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "slash_command_not_supported_by_planner_tool_flow",
        semantics,
      }),
    };
  }

  if (semantics.wants_missing_agent_request && semanticActionNames.length > 0) {
    return {
      ok: false,
      ...buildPlannerSemanticMismatch({
        decision,
        reason: "missing_agent_request_not_supported_by_planner_tool_flow",
        semantics,
      }),
    };
  }

  if (semantics.wants_runtime_info && semanticActionNames.some((name) => name !== "get_runtime_info")) {
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
      !semanticActionNames.some((name) => allowedCreateActions.has(name))
      || semanticActionNames.some((name) => !allowedCreateContinuationActions.has(name))
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
    && semanticActionNames.some((name) => !allowedDocumentActions.has(name))
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
      action: getPlannerDecisionRepresentativeAction(decision),
      summary: "也可只先執行第一步取得中間結果，但這輪需求需要完整多步流程。",
    });
  }

  const action = cleanText(decision?.action || "");
  switch (action) {
    case "search_and_summarize":
      return normalizeDecisionAlternative({
        action: "search_company_brain_docs",
        summary: "也可只先 search 候選文件；這輪需要受控 read-only skill 直接輸出摘要。",
      });
    case "document_summarize":
      return normalizeDecisionAlternative({
        action: "get_company_brain_doc_detail",
        summary: "也可直接走一般 detail；這輪需要受控 read-only skill 把單一文件整理成固定摘要。",
      });
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
  const representativeAction = getPlannerDecisionRepresentativeAction(result);
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
  if (representativeAction === "get_company_brain_doc_detail") {
    return "這輪已經有足夠線索指向單一文件，所以直接走 detail。";
  }
  if (representativeAction === "search_company_brain_docs") {
    return "需求偏向查資料或找文件，先 search 才能定位候選來源。";
  }
  if (representativeAction === "search_and_summarize") {
    return "這輪需求被明確約束為 read-only skill 摘要路徑，所以不直接走一般 search bridge。";
  }
  if (representativeAction === "document_summarize") {
    return "這輪需求被明確約束為單一文件的 read-only skill 摘要路徑，所以不直接走一般 detail bridge。";
  }
  if (representativeAction === "list_company_brain_docs") {
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
              latestSelectedAction: cleanText(decision.action || "") || getPlannerDecisionRepresentativeAction(decision) || "",
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

function resolveDeterministicPlannerFallbackSelection({
  text = "",
  logger = console,
  sessionKey = "",
} = {}) {
  const agentInput = buildPlannerAgentInput({
    userIntent: text,
    taskType: "",
    payload: {},
  });
  const routedFlow = resolvePlannerFlowRoute({
    flows: plannerFlows,
    userIntent: agentInput.user_intent,
    payload: agentInput.payload,
    logger,
    sessionKey,
  });
  const selectorSelection = selectPlannerTool({
    userIntent: agentInput.user_intent,
    taskType: agentInput.task_type,
    logger,
  });
  const prefersSelectorSelection = shouldPreferSelectorAction({
    hardRoutedAction: routedFlow.action,
    selectorAction: selectorSelection?.selected_action,
  });
  const selection = prefersSelectorSelection
    ? {
        ...selectorSelection,
        reason: selectorSelection?.reason || "命中更具體的 selector 規則，覆蓋 generic search hard route。",
        routing_reason: normalizePlannerRoutingReason(
          cleanText(selectorSelection?.routing_reason || ""),
          "selector_override_generic_search_route",
        ) || "selector_override_generic_search_route",
      }
    : routedFlow.action
      ? {
          selected_action: routedFlow.action,
          reason: "命中硬路由規則。",
          routing_reason: normalizePlannerRoutingReason(
            cleanText(routedFlow?.routing_reason || ""),
            "hard_route_match",
          ) || "hard_route_match",
        }
      : selectorSelection;
  const selectedAction = cleanText(selection?.selected_action || "");
  if (!PLANNER_FAILED_DETERMINISTIC_FALLBACK_ACTIONS.has(selectedAction)) {
    return null;
  }
  return {
    selection: {
      selected_action: selectedAction,
      reason: cleanText(selection?.reason || "") || "deterministic_planner_failed_fallback",
      routing_reason: normalizePlannerRoutingReason(
        cleanText(selection?.routing_reason || ""),
        "deterministic_planner_failed_fallback",
      ) || "deterministic_planner_failed_fallback",
    },
    payload: buildPlannerFlowPayload({
      flow: routedFlow.flow,
      action: selectedAction,
      userIntent: agentInput.user_intent,
      payload: routedFlow.payload,
      logger,
      sessionKey,
    }),
  };
}

function resolveWorkingMemorySeedDecision({
  text = "",
  taskType = "",
  payload = {},
  sessionKey = "",
  logger = console,
} = {}) {
  const memoryContinuation = resolvePlannerWorkingMemoryContinuation({
    userIntent: text,
    taskType,
    payload,
    sessionKey,
    logger,
    stage: "executePlannedUserInput",
  });
  const selectedAction = cleanText(memoryContinuation?.selected_action || "");
  if (!selectedAction || !canUseWorkingMemoryAction(selectedAction, { text })) {
    return {
      decision: null,
      observability: memoryContinuation?.observability || null,
    };
  }
  const workingMemorySnapshot = memoryContinuation?.observability?.memory_snapshot
    && typeof memoryContinuation.observability.memory_snapshot === "object"
    && !Array.isArray(memoryContinuation.observability.memory_snapshot)
    ? memoryContinuation.observability.memory_snapshot
    : null;
  return {
    decision: {
      action: selectedAction,
      params: buildPlannerWorkingMemoryContinuationParams({
        action: selectedAction,
        text,
        payload,
        workingMemory: workingMemorySnapshot,
      }),
      reason: cleanText(memoryContinuation?.reason || "") || "working_memory_reuse_action",
    },
    observability: memoryContinuation?.observability || null,
  };
}

export async function executePlannedUserInput({
  text = "",
  requester = requestPlannerJson,
  logger = console,
  contentReader,
  documentFetcher = fetchDocumentPlainText,
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
  requestId = "",
  telemetryAdapter = null,
  runSkill = null,
  taskLayerRunner = runTaskLayer,
} = {}) {
  const preAbortInfo = derivePlannerAbortInfo({ signal });
  if (preAbortInfo) {
    return {
      ok: false,
      error: preAbortInfo.code,
      execution_result: null,
      formatted_output: null,
      trace_id: null,
      why: null,
      alternative: normalizeDecisionAlternative(null),
    };
  }
  if (typeof runSkill === "function" && typeof taskLayerRunner === "function") {
    try {
      const taskLayerResult = await taskLayerRunner(text, runSkill);
      if (Array.isArray(taskLayerResult?.tasks) && taskLayerResult.tasks.length > 1) {
        return buildTaskLayerPlannerResult(taskLayerResult);
      }
    } catch (error) {
      logger?.warn?.("planner_task_layer_prepass_failed", {
        error: cleanText(error?.message || "") || String(error),
      });
    }
  }
  const memorySeedDecision = plannedDecision
    ? { decision: null, observability: null }
    : resolveWorkingMemorySeedDecision({
        text,
        taskType: "",
        payload: {},
        sessionKey,
        logger,
      });
  const prePlannedDecision = plannedDecision || memorySeedDecision.decision;
  const decision = prePlannedDecision
    ? (() => {
        const validatedDecision = validatePlannerUserInputDecision(prePlannedDecision, { text });
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
  const memorySeedObservability = memorySeedDecision?.observability
    && typeof memorySeedDecision.observability === "object"
    ? {
        ...memorySeedDecision.observability,
        memory_used_in_routing: Boolean(!plannedDecision && memorySeedDecision.decision && !decision?.error),
      }
    : null;
  if (memorySeedObservability) {
    logPlannerWorkingMemoryTrace({
      logger,
      memoryStage: "executePlannedUserInput_preplan",
      sessionKey,
      observability: memorySeedObservability,
      selectedAction: memorySeedDecision?.decision?.action || null,
      level: "debug",
    });
  }
  const plannerVisibleMonitor = !decision?.error && !Array.isArray(decision?.steps)
    ? createPlannerVisibleTelemetryMonitor({
        text,
        selectedAction: decision?.action,
        decisionReason: decision?.why || "",
        requestId,
        telemetryAdapter,
      })
    : null;
  emitPlannerVisibleTelemetryForMonitor({
    monitor: plannerVisibleMonitor,
    selectedAction: decision?.action,
  });
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
          telemetryAdapter,
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
            formattedOutput: null,
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
          ...(() => {
            const output = {
              ok: reroutedResult?.execution_result?.ok === true,
              action: cleanText(reroutedResult?.selected_action || "") || null,
              params: null,
              error: cleanText(reroutedResult?.execution_result?.error || "") || null,
              execution_result: reroutedResult?.execution_result || null,
              formatted_output: normalizePlannerFormattedOutput(
                reroutedResult?.formatted_output || extractPlannerFormattedOutput(reroutedResult?.execution_result),
              ),
              synthetic_agent_hint: reroutedResult?.synthetic_agent_hint || null,
              trace_id: reroutedResult?.trace_id || null,
              why: "原始 decision 與這輪需求不一致，所以先改走 reroute。",
              alternative: normalizeDecisionAlternative(decision?.alternative),
            };
            copyPlannerVisibleTelemetryContext(reroutedResult, output);
            return output;
          })(),
        };
      }
    }

    if (decision.error === "planner_failed") {
      const deterministicFallback = resolveDeterministicPlannerFallbackSelection({
        text,
        logger,
        sessionKey,
      });
      if (deterministicFallback?.selection?.selected_action) {
        let reroutedResult;
        try {
          reroutedResult = await toolFlowRunner({
            userIntent: text,
            payload: deterministicFallback.payload || {},
            logger,
            contentReader,
            baseUrl,
            authContext,
            forcedSelection: deterministicFallback.selection,
            disableAutoRouting: true,
            signal,
            sessionKey,
            requestId: plannerVisibleMonitor?.context?.request_id || requestId,
            telemetryContext: plannerVisibleMonitor?.context || null,
            telemetryAdapter,
          });
        } catch (error) {
          const abortedResult = buildPlannerAbortResult({
            action: deterministicFallback.selection.selected_action,
            signal,
            error,
          });
          if (abortedResult) {
            reroutedResult = buildPlannerAgentOutput({
              selectedAction: deterministicFallback.selection.selected_action,
              executionResult: abortedResult,
              traceId: abortedResult.trace_id || null,
              routingReason: deterministicFallback.selection.routing_reason,
              payload: deterministicFallback.payload || {},
            });
          } else {
            throw error;
          }
        }

        if (reroutedResult?.execution_result) {
          const output = {
            ok: reroutedResult?.execution_result?.ok === true,
            action: cleanText(reroutedResult?.selected_action || deterministicFallback.selection.selected_action) || null,
            params: deterministicFallback.payload || {},
            error: cleanText(reroutedResult?.execution_result?.error || "") || null,
            execution_result: reroutedResult?.execution_result || null,
            formatted_output: normalizePlannerFormattedOutput(
              reroutedResult?.formatted_output || extractPlannerFormattedOutput(reroutedResult?.execution_result),
            ),
            synthetic_agent_hint: reroutedResult?.synthetic_agent_hint || null,
            trace_id: reroutedResult?.trace_id || null,
            why: "strict planner decision 缺失時，改走 bounded deterministic read/runtime fallback。",
            alternative: normalizeDecisionAlternative(decision?.alternative),
          };
          copyPlannerVisibleTelemetryContext(reroutedResult, output);
          return output;
        }
      }
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
      formatted_output: null,
      trace_id: null,
    };
  }

  if (Array.isArray(decision.steps)) {
    let runtimeResult;
    try {
      runtimeResult = await multiStepRunner({
        steps: decision.steps,
        logger,
        requestText: text,
        documentFetcher,
        resume_from_step,
        previous_results,
        max_retries,
        retryable_error_types,
        authContext,
        signal,
        async dispatcher({ action, payload, requestText: stepRequestText, context }) {
          return dispatcher({
            action,
            payload,
            requestText: stepRequestText,
            context,
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
      formatted_output: null,
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
      requestId: plannerVisibleMonitor?.context?.request_id || requestId,
      telemetryContext: plannerVisibleMonitor?.context || null,
      telemetryAdapter,
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

  const output = {
    ok: runtimeResult?.execution_result?.ok === true,
    action: decision.action,
    params: decision.params,
    error: cleanText(runtimeResult?.execution_result?.error || "") || null,
    execution_result: runtimeResult?.execution_result || null,
    formatted_output: normalizePlannerFormattedOutput(
      runtimeResult?.formatted_output || extractPlannerFormattedOutput(runtimeResult?.execution_result),
    ),
    synthetic_agent_hint: runtimeResult?.synthetic_agent_hint || null,
    trace_id: runtimeResult?.trace_id || null,
    why: cleanText(decision?.why || "") || null,
    alternative: normalizeDecisionAlternative(decision?.alternative),
  };
  copyPlannerVisibleTelemetryContext(runtimeResult, output);
  return output;
}

export function buildPlannedUserInputEnvelope(result = {}) {
  const chosenAction = cleanText(result.action || "") || getPlannerDecisionRepresentativeAction(result) || null;
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
      formatted_output: null,
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
    const envelope = {
      ok: false,
      error: cleanText(result.error || "") || "planner_failed",
      ...(cleanText(result.action || "") ? { action: cleanText(result.action) } : {}),
      params: normalizePlannerPayload(result.params),
      ...(Array.isArray(result.steps)
        ? {
            steps: result.steps
              .map((step) => ({
                action: cleanText(step?.action || "") || null,
                ...(step?.params && typeof step.params === "object" && !Array.isArray(step.params)
                  ? { params: normalizePlannerPayload(step.params) }
                  : {}),
                ...(cleanText(step?.intent || "") ? { intent: cleanText(step.intent) } : {}),
                ...(typeof step?.required === "boolean" ? { required: step.required } : {}),
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
      formatted_output: null,
      trace_id: result.trace_id || null,
      trace: {
        chosen_action: chosenAction,
        fallback_reason: fallbackReason,
        reasoning,
      },
    };
    copyPlannerVisibleTelemetryContext(result, envelope);
    return envelope;
  }

  const envelope = {
    ok: result.ok === true,
    action: cleanText(result.action || "") || null,
    params: normalizePlannerPayload(result.params),
    ...(Array.isArray(result.steps)
      ? {
          steps: result.steps
            .map((step) => ({
              action: cleanText(step?.action || "") || null,
              ...(step?.params && typeof step.params === "object" && !Array.isArray(step.params)
                ? { params: normalizePlannerPayload(step.params) }
                : {}),
              ...(cleanText(step?.intent || "") ? { intent: cleanText(step.intent) } : {}),
              ...(typeof step?.required === "boolean" ? { required: step.required } : {}),
            }))
            .filter((step) => step.action),
        }
      : {}),
    error: cleanText(result.error || "") || null,
    execution_result: result.execution_result || null,
    formatted_output: normalizePlannerFormattedOutput(
      result.formatted_output || extractPlannerFormattedOutput(result.execution_result),
    ),
    why: reasoning.why,
    alternative: reasoning.alternative,
    trace_id: result.trace_id || null,
    trace: {
      chosen_action: chosenAction,
      fallback_reason: fallbackReason,
      reasoning,
    },
  };
  copyPlannerVisibleTelemetryContext(result, envelope);
  return envelope;
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
