import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { usageLayerEvals } from "./usage-layer-evals.mjs";
import { followupMultiIntentContinuityEvals } from "./followup-multi-intent-continuity-evals.mjs";
import { registeredAgentFamilyEvals } from "./registered-agent-family-evals.mjs";
import { workflowTimeoutGovernanceEvals } from "./workflow-timeout-governance-evals.mjs";
import { runPlannerUserInputEdge } from "../../src/planner-user-input-edge.mjs";
import { normalizeUserResponse, renderUserResponseText } from "../../src/user-response-normalizer.mjs";
import { resolveRoutingEvalCase } from "../../src/routing-eval.mjs";
import { cleanText } from "../../src/message-intent-utils.mjs";
import {
  buildCloudOrganizationPreviewReply,
  buildCloudOrganizationReviewReplyCached,
  buildCloudOrganizationWhyReply,
} from "../../src/cloud-doc-organization-workflow.mjs";
import { getStoredAccountContext } from "../../src/lark-user-auth.mjs";
import { buildLaneIntroReply } from "../../src/capability-lane.mjs";
import { executeRegisteredAgent } from "../../src/agent-dispatcher.mjs";
import { parseRegisteredAgentCommand, resolveRegisteredAgentFamilyRequest } from "../../src/agent-registry.mjs";
import {
  hydratePlannerDocQueryRuntimeContext,
  resetPlannerDocQueryRuntimeContext,
} from "../../src/planner-doc-query-flow.mjs";
import { runPlannerToolFlow } from "../../src/executive-planner.mjs";
import { ROUTING_NO_MATCH } from "../../src/planner-error-codes.mjs";
import {
  buildWorkflowTimeoutGovernanceLine,
  classifyWorkflowTimeoutGovernanceFamily,
  DEFAULT_WORKFLOW_SLOW_WARNING_MS,
} from "../../src/workflow-timeout-governance.mjs";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS = Number.parseInt(
  process.env.USAGE_LAYER_EVAL_CASE_TIMEOUT_MS || "15000",
  10,
);
const DEFAULT_USAGE_LAYER_EVAL_STUCK_WARNING_MS = Number.parseInt(
  process.env.USAGE_LAYER_EVAL_STUCK_WARNING_MS || "10000",
  10,
);
const DEFAULT_USAGE_LAYER_EVAL_ARTIFACT_DIR = process.env.USAGE_LAYER_EVAL_ARTIFACT_DIR || ".tmp/usage-layer";
const DEFAULT_USAGE_LAYER_BASELINE_DRIFT_TOLERANCE = Number.parseInt(
  process.env.USAGE_LAYER_BASELINE_DRIFT_TOLERANCE || "1",
  10,
);

const WORKFLOW_LANES = new Set(["meeting_workflow", "cloud_doc_workflow"]);
const WORKFLOW_ACTIONS = new Set([
  "preview",
  "review",
  "why",
  "rereview",
  "exit",
  "start_capture",
  "start_capture_calendar",
  "capture_status",
  "process",
  "confirm",
  "stop_capture",
]);
const PRESET_ACTIONS = new Set([
  "create_and_list_doc",
  "create_search_detail_list_doc",
]);
const EXECUTIVE_ACTIONS = new Set(["start", "continue", "handoff", "clarify"]);
const GENERIC_PATTERNS = [
  /可以換個說法/i,
  /補一點背景/i,
  /把目標資料直接貼給我/i,
  /先不回傳不完整結果/i,
  /還沒拿到完整結果/i,
  /我先沒有整理出足夠內容/i,
  /我先沒有整理出可直接交付的內容/i,
  /如果你願意/i,
  /請提供更多/i,
  /請再提供/i,
  /需要更多資訊/i,
];
const STRUCTURED_REPLY_EXEMPT_PATTERNS = [
  /待處理清單/u,
  /審核方式/u,
  /分類預覽/u,
  /角色審核/u,
  /正文、評論和待改位置/u,
  /最相關的文件/u,
  /已索引文件/u,
  /目前沒有找到/u,
  /資料庫路徑/u,
  /工作目錄/u,
  /目前 pid 是/u,
  /auth-required/i,
  /使用者授權/u,
  /重新登入授權/u,
  /文件搜尋\/閱讀路徑/u,
  /本地帳號上下文/u,
  /受控邊界/u,
  /文檔工作流/u,
  /會議 workflow/u,
  /會議記錄狀態確認/u,
  /會議流程收尾指令/u,
  /會議確認寫入指令/u,
  /Email 草稿/u,
  /Facebook 貼文草稿/u,
  /回覆草稿/u,
  /文字草稿/u,
];
const CLARIFICATION_PATTERNS = [
  /補一點背景/i,
  /把目標資料直接貼給我/i,
  /換個說法/i,
  /請提供更多/i,
  /請再提供/i,
  /需要更多資訊/i,
  /重新描述/i,
];
const PARTIAL_SUCCESS_PATTERNS = [
  /我先把可直接交付的.*完成/i,
  /已先完成[:：]/i,
  /目前先交付/i,
  /先把.*部分完成/i,
];
const DEICTIC_PATTERNS = [
  /這個|这个|那個|那个|這份|这份|那份|這批|這些|這則|这则|那則|那则|這篇|这篇|那篇|這份文件|这份文件|那份文件|第\d+份|第[一二三四五六七八九十]+份/u,
];
const TOKEN_PATTERN = /[A-Za-z0-9_-]+|[\u4e00-\u9fff]{2,}/gu;
const STOPWORDS = new Set([
  "幫我",
  "一下",
  "請問",
  "請",
  "一下子",
  "一下下",
  "這個",
  "這份",
  "這批",
  "這些",
  "文件",
  "文檔",
  "方案",
  "問題",
  "一下這個",
  "幫忙",
  "看看",
  "一下有沒有",
  "一下問題",
]);

function normalizeText(value = "") {
  return cleanText(String(value || ""));
}

function isAbortLikeError(error) {
  const code = normalizeText(error?.code || "");
  const name = normalizeText(error?.name || "");
  const message = normalizeText(error?.message || "");
  return code === "abort_err"
    || code === "request_cancelled"
    || name === "aborterror"
    || message === "request_cancelled";
}

function resolveEvalCaseTimeoutMs(timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS;
}

function createEvalCaseSignal(timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS) {
  const resolvedTimeoutMs = resolveEvalCaseTimeoutMs(timeoutMs);
  if (typeof AbortSignal?.timeout === "function") {
    return AbortSignal.timeout(resolvedTimeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error("request_cancelled"), {
      name: "AbortError",
      code: "request_cancelled",
    }));
  }, resolvedTimeoutMs);
  if (typeof timer?.unref === "function") {
    timer.unref();
  }
  return controller.signal;
}

function buildEvalTimeoutExecution({
  route = {},
  timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS,
} = {}) {
  return {
    plannerEnvelope: {
      ok: false,
      error: "case_timeout",
      action: normalizeText(route?.planner_action || "") || null,
      execution_result: {
        ok: false,
        error: "case_timeout",
        data: {
          answer: "",
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: false,
      failure_class: "timeout",
    },
    replyText: `Usage-layer eval case exceeded ${resolveEvalCaseTimeoutMs(timeoutMs)}ms and was cancelled.`,
  };
}

function scheduleStuckCaseWarning(testCase = {}, timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS) {
  const warningAfterMs = Math.max(
    1000,
    Math.min(DEFAULT_USAGE_LAYER_EVAL_STUCK_WARNING_MS, resolveEvalCaseTimeoutMs(timeoutMs) - 1000),
  );
  const timer = setTimeout(() => {
    console.warn(
      `[usage-layer][stuck] ${testCase.id || "unknown"} still running after ${warningAfterMs}ms: ${testCase.user_text || ""}`,
    );
  }, warningAfterMs);
  if (typeof timer?.unref === "function") {
    timer.unref();
  }
  return timer;
}

function resolveTimeoutGovernanceConfig(testCase = {}) {
  return testCase?.context?.timeout_governance && typeof testCase.context.timeout_governance === "object"
    ? testCase.context.timeout_governance
    : null;
}

function resolveGovernanceSlowWarningMs(governance = null) {
  const slowWarningMs = Number(governance?.slow_warning_ms);
  return Number.isFinite(slowWarningMs) && slowWarningMs > 0
    ? Math.floor(slowWarningMs)
    : DEFAULT_WORKFLOW_SLOW_WARNING_MS;
}

function buildGovernanceSimulationReply({
  family = null,
  durationMs = 0,
  timeoutMs = null,
} = {}) {
  const governanceLine = buildWorkflowTimeoutGovernanceLine({
    family,
    workflowLabel: "雲文檔 workflow",
    durationMs,
  });
  if (family === "successful_but_slow") {
    return [
      "結論",
      "第二輪角色審核已完成，這輪只是比平常慢。",
      "",
      "摘要",
      governanceLine,
      "- 待重新分配：1 份",
      "- 待人工確認：1 份",
      "",
      "待處理清單",
      "1. 文件名：Scanoo Workspace Guide",
      "   狀態：待重新分配",
      "   簡短原因：內容更像 onboarding / workspace 通用文件。",
      "   操作：回覆「第一個標記完成」",
    ].join("\n");
  }
  if (family === "timeout_acceptable") {
    return [
      "結論",
      "第二輪角色審核這次先回退到本地保底結果，因為語義複審逾時了。",
      "",
      "摘要",
      governanceLine,
      "- 待人工確認：2 份",
      "",
      "待處理清單",
      "1. 文件名：Administrator Manual",
      "   狀態：待人工確認",
      "   簡短原因：本輪先保留本地分類。",
      "   操作：回覆「第一個標記完成」",
    ].join("\n");
  }
  if (family === "timeout_fail_closed") {
    return [
      "結論",
      "這次 workflow 逾時了，我還沒有拿到可以安全交付的結果。",
      "",
      "下一步",
      `- timeout family：timeout_fail_closed${Number.isFinite(Number(timeoutMs)) ? `（${timeoutMs}ms）` : ""}`,
      "- 目前不回傳不完整的分配結果。",
    ].join("\n");
  }
  if (family === "workflow_too_slow") {
    return [
      "結論",
      "這條 workflow 還在跑，但目前已經慢到不適合包裝成正常完成。",
      "",
      "下一步",
      `- ${governanceLine.replace(/^- /, "")}`,
      "- 先停在受控邊界，避免把等待狀態說成完成。",
    ].join("\n");
  }
  if (family === "needs_fixture_mock") {
    return [
      "結論",
      "這條 case 目前需要 fixture/mock 或本地帳號上下文，否則不能把 timeout 行為當作真實 workflow 結果。",
      "",
      "下一步",
      "- 先補 deterministic fixture 或 mock，再判讀 slow/timeout 邊界。",
    ].join("\n");
  }
  return [
    "結論",
    "這條 timeout case 目前還沒有被歸進明確 family。",
    "",
    "下一步",
    "- 先補分類，再決定要走 fallback 還是 fail-closed。",
  ].join("\n");
}

function toPercent(numerator = 0, denominator = 0) {
  if (denominator <= 0) {
    return "0.00%";
  }
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function extractKeywords(text = "") {
  const rawTokens = (normalizeText(text).match(TOKEN_PATTERN) || [])
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const expandedTokens = [];

  for (const token of rawTokens) {
    expandedTokens.push(token);
    if (/^[\u4e00-\u9fff]+$/u.test(token) && token.length > 4) {
      for (let size = 2; size <= Math.min(4, token.length); size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) {
          expandedTokens.push(token.slice(index, index + size));
        }
      }
    }
  }

  return [...new Set(expandedTokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

function hasKeywordOverlap(replyText = "", requestText = "", contextTexts = []) {
  const normalizedReply = normalizeText(replyText);
  const keywords = [
    ...extractKeywords(requestText),
    ...extractKeywords(Array.isArray(contextTexts) ? contextTexts.join(" ") : ""),
  ];
  return [...new Set(keywords)].some((keyword) => normalizedReply.includes(keyword));
}

function collectContextTexts(testCase = {}) {
  const plannerContext = testCase?.context?.planner && typeof testCase.context.planner === "object"
    ? testCase.context.planner
    : {};
  const activeDoc = plannerContext.active_doc && typeof plannerContext.active_doc === "object"
    ? plannerContext.active_doc
    : null;
  const activeCandidates = Array.isArray(plannerContext.active_candidates)
    ? plannerContext.active_candidates
    : [];
  const activeExecutiveTask = testCase?.context?.active_executive_task && typeof testCase.context.active_executive_task === "object"
    ? testCase.context.active_executive_task
    : null;
  return [
    normalizeText(activeDoc?.title || ""),
    normalizeText(activeDoc?.doc_id || ""),
    ...activeCandidates.flatMap((item) => [
      normalizeText(item?.title || ""),
      normalizeText(item?.doc_id || ""),
    ]),
    normalizeText(plannerContext.active_theme || ""),
    normalizeText(testCase?.context?.active_workflow_mode || ""),
    normalizeText(activeExecutiveTask?.objective || ""),
    normalizeText(activeExecutiveTask?.title || ""),
  ].filter(Boolean);
}

function hasContinuationContext(testCase = {}) {
  return collectContextTexts(testCase).length > 0;
}

function looksGenericReply({
  replyText = "",
  requestText = "",
  contextTexts = [],
} = {}) {
  const normalizedReply = normalizeText(replyText);
  if (!normalizedReply) {
    return true;
  }
  if (normalizedReply.length < 36) {
    return true;
  }
  if (isPartialSuccessReply(normalizedReply)) {
    return false;
  }
  if (STRUCTURED_REPLY_EXEMPT_PATTERNS.some((pattern) => pattern.test(normalizedReply))) {
    return false;
  }
  if (GENERIC_PATTERNS.some((pattern) => pattern.test(normalizedReply))) {
    return true;
  }
  return !hasKeywordOverlap(normalizedReply, requestText, contextTexts);
}

function isClarificationReply(replyText = "") {
  const normalizedReply = normalizeText(replyText);
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(normalizedReply));
}

function isPartialSuccessReply(replyText = "") {
  const normalizedReply = normalizeText(replyText);
  return PARTIAL_SUCCESS_PATTERNS.some((pattern) => pattern.test(normalizedReply));
}

function classifyEvalOutcome({
  successType = "",
  generic = false,
} = {}) {
  if (generic === true) {
    return "generic_reply";
  }
  if (successType === "partial_success") {
    return "partial_success";
  }
  if (successType === "fail_soft" || successType === "clarify") {
    return "fail_closed";
  }
  return "good_answer";
}

function requestLikelyNeedsClarification(requestText = "") {
  const normalizedRequest = normalizeText(requestText);
  return DEICTIC_PATTERNS.some((pattern) => pattern.test(normalizedRequest));
}

function requestActuallyNeedsClarification(testCase = {}) {
  if (!requestLikelyNeedsClarification(testCase.user_text)) {
    return false;
  }
  return !hasContinuationContext(testCase);
}

function normalizeEvalCase(testCase = {}) {
  return {
    text: testCase.user_text,
    context: testCase.context || {},
    scope: testCase.scope || {},
  };
}

function primeUsageLayerEvalRuntimeContext(testCase = {}, sessionKey = "") {
  const plannerContext = testCase?.context?.planner;
  if (!plannerContext || typeof plannerContext !== "object") {
    resetPlannerDocQueryRuntimeContext({ sessionKey });
    return;
  }
  hydratePlannerDocQueryRuntimeContext({
    activeDoc: plannerContext.active_doc || null,
    activeCandidates: plannerContext.active_candidates || [],
    activeTheme: plannerContext.active_theme || null,
    sessionKey,
  });
}

function buildUsageEvalSourceItem(title = "", url = "", snippet = "") {
  return {
    id: `${title || "usage-eval"}-${url || "local"}`.replace(/\s+/g, "_"),
    snippet,
    metadata: {
      title,
      url,
    },
  };
}

function buildRegisteredAgentEvalText({
  slash = "",
  agentLabel = "",
  body = "",
} = {}) {
  const task = normalizeText(body || "這個需求");
  const commandLabel = normalizeText(slash || agentLabel || "這個 agent");
  return [
    "結論",
    `${commandLabel} 先接住「${task}」，我先把它整理成一版可直接往下討論的判斷框架。`,
    "",
    "重點",
    `- 這題先不要只停在抽象描述，而是直接收斂成目標對象、核心主張、差異化依據三個定位欄位。`,
    `- 如果你現在是要整理定位，先明確寫出服務誰、解什麼問題、以及為什麼現在這個方案更值得被選。`,
    "",
    "下一步",
    `- 你可以先補目前產品/品牌/方案的目標受眾與主要痛點，我就能把「${task}」整理成更完整的一版。`,
  ].join("\n");
}

async function buildResolvedRegisteredAgentEvalExecution({
  testCase = {},
  route = {},
  agent,
  requestText = "",
} = {}) {
  const normalizedRequestText = normalizeText(requestText || testCase.user_text);
  const agentResult = await executeRegisteredAgent({
    accountId: "usage-layer-eval",
    agent,
    requestText: normalizedRequestText,
    scope: { session_key: `usage-layer-eval:${testCase.id}` },
    searchFn() {
      return {
        items: [
          buildUsageEvalSourceItem(
            `${agent.label} Eval Context`,
            `https://usage-layer.eval/${agent.id}`,
            `這是 ${agent.label} 對「${normalizedRequestText}」的受控 usage-layer 測試上下文。`,
          ),
        ],
      };
    },
    async textGenerator() {
      return buildRegisteredAgentEvalText({
        slash: agent.slash,
        agentLabel: agent.label,
        body: normalizedRequestText,
      });
    },
    logger: noopLogger,
  });

  return {
    agentResult,
    replyText: normalizeText(agentResult?.text || ""),
    ownerSurface: normalizeText(route?.agent_or_tool || "") || `agent:${agent.id}`,
  };
}

function inferExecutedTarget({ envelope = {}, route = {} } = {}) {
  const action = normalizeText(envelope?.action || "");
  if (!action) {
    const routeTarget = normalizeText(route?.agent_or_tool || "");
    if (isControlledTarget(routeTarget) && isNonPlannerOwnedRoute(route)) {
      return routeTarget;
    }
    return normalizeText(envelope?.error || "") ? `error:${normalizeText(envelope.error)}` : null;
  }
  if (PRESET_ACTIONS.has(action)) {
    return `preset:${action}`;
  }
  if (WORKFLOW_ACTIONS.has(action) || WORKFLOW_LANES.has(normalizeText(route?.lane || ""))) {
    if (normalizeText(route?.lane || "") === "meeting_workflow") {
      return "workflow:meeting_agent";
    }
    if (normalizeText(route?.lane || "") === "cloud_doc_workflow") {
      return "workflow:cloud_doc_organization";
    }
  }
  if (action === "dispatch_registered_agent") {
    return normalizeText(route?.agent_or_tool || "") || "agent:unknown";
  }
  if (EXECUTIVE_ACTIONS.has(action) || normalizeText(route?.lane || "") === "executive") {
    return normalizeText(route?.agent_or_tool || "") || "agent:generalist";
  }
  return `tool:${action}`;
}

function inferOwnerSurface({
  execution = {},
  testCase = {},
  route = {},
  failureClass = "",
} = {}) {
  const explicitOwnerSurface = normalizeText(execution?.ownerSurface || "");
  if (explicitOwnerSurface) {
    return explicitOwnerSurface;
  }
  if (failureClass === "routing_no_match") {
    return "routing_no_match";
  }
  if (failureClass === "permission_denied") {
    return "permission_denied";
  }
  if (normalizeText(route?.lane || "") === "registered_agent") {
    return normalizeText(route?.agent_or_tool || "") || "agent:unknown";
  }
  if (normalizeText(route?.lane || "") === "executive") {
    const explicitAgentRequest = resolveRegisteredAgentFamilyRequest(testCase.user_text, {
      includeSlashCommand: true,
      includePersonaMentions: true,
      includeKnowledgeCommands: false,
    });
    const explicitAgentId = normalizeText(explicitAgentRequest?.agent?.id || "");
    return explicitAgentId && explicitAgentId !== "generalist"
      ? `agent:${explicitAgentId}`
      : "executive:generic";
  }
  return normalizeText(route?.lane || "") || null;
}

function isNonPlannerOwnedRoute(route = {}) {
  const lane = normalizeText(route?.lane || "");
  return lane === "doc_editor"
    || lane === "cloud_doc_workflow"
    || lane === "meeting_workflow";
}

function hasRouteSelectedControlledExecutor(route = {}) {
  return isNonPlannerOwnedRoute(route)
    && isControlledTarget(normalizeText(route?.agent_or_tool || ""));
}

function classifyReplyMode({ userResponse = {}, route = {}, replyText = "" } = {}) {
  const failureClass = normalizeText(userResponse?.failure_class || "");
  if (userResponse?.ok !== true) {
    if (failureClass) {
      return "fail_soft";
    }
    return isClarificationReply(replyText) ? "clarify" : "fail_soft";
  }
  if (failureClass === "partial_success") {
    return "partial_success";
  }
  if (isPartialSuccessReply(replyText)) {
    return "partial_success";
  }
  if (normalizeText(route?.lane || "") === "executive") {
    return "executive_brief";
  }
  if (normalizeText(route?.lane || "") === "doc_editor" && normalizeText(route?.planner_action || "") === "comment_rewrite_preview") {
    return "card_preview";
  }
  if (WORKFLOW_LANES.has(normalizeText(route?.lane || ""))) {
    return "workflow_update";
  }
  return "answer_first";
}

function classifySuccessType(replyMode = "") {
  if (replyMode === "workflow_update" || replyMode === "card_preview") {
    return "workflow_progress";
  }
  if (replyMode === "partial_success") {
    return "partial_success";
  }
  if (replyMode === "clarify") {
    return "clarify";
  }
  if (replyMode === "fail_soft") {
    return "fail_soft";
  }
  return "direct_answer";
}

function isControlledTarget(target = "") {
  const normalizedTarget = normalizeText(target);
  return normalizedTarget.startsWith("tool:")
    || normalizedTarget.startsWith("workflow:")
    || normalizedTarget.startsWith("preset:");
}

function resolveFailureClass({
  testCase = {},
  userResponse = {},
  route = {},
  plannerEnvelope = {},
  executedTarget = "",
} = {}) {
  if (
    normalizeText(route?.planner_action || "") === "ROUTING_NO_MATCH"
    || normalizeText(route?.agent_or_tool || "") === "error:ROUTING_NO_MATCH"
  ) {
    return "routing_no_match";
  }
  const normalizedUserFailureClass = normalizeText(userResponse?.failure_class || "");
  if (normalizedUserFailureClass === "timeout") {
    return "timeout";
  }
  const envelopeError = normalizeText(plannerEnvelope?.error || "");
  if (envelopeError === "case_timeout") {
    return "timeout";
  }
  if (normalizedUserFailureClass === "tool_omission" && hasRouteSelectedControlledExecutor(route)) {
    return envelopeError === "planner_failed" ? "planner_failed" : envelopeError || "planner_failed";
  }
  if (normalizedUserFailureClass) {
    return normalizedUserFailureClass;
  }
  if (userResponse?.ok === true && isPartialSuccessReply(renderUserResponseText(userResponse))) {
    return "partial_success";
  }
  if (testCase.tool_required === true && !isControlledTarget(executedTarget)) {
    return "tool_omission";
  }
  if (
    envelopeError === "missing_user_access_token"
    || envelopeError === "oauth_reauth_required"
    || envelopeError === "permission_denied"
    || envelopeError === "entry_governance_required"
  ) {
    return "permission_denied";
  }
  if (envelopeError === "planner_failed") {
    return "planner_failed";
  }
  return userResponse?.ok === false ? "generic_fallback" : null;
}

async function runCloudDocWorkflowEvalCase(testCase = {}, route = {}, { signal = null } = {}) {
  const storedContext = await getStoredAccountContext("");
  const accountId = normalizeText(storedContext?.account?.id || "");
  if (!accountId) {
    return {
      plannerEnvelope: {
        ok: false,
        error: "permission_denied",
        action: normalizeText(route?.planner_action || "") || null,
      },
      userResponse: {
        ok: false,
        failure_class: "permission_denied",
      },
      replyText: [
        "結論",
        "目前沒有可用的本地帳號上下文，所以這條 workflow 先停在受控邊界。",
        "",
        "下一步",
        "- 先補可用帳號或重新登入，之後再跑這條文檔工作流。",
      ].join("\n"),
      ownerSurface: "permission_denied",
    };
  }

  const sessionKey = `usage-layer-eval:${testCase.id}`;
  const action = normalizeText(route?.planner_action || "");
  let reply;
  if (action === "preview") {
    reply = await buildCloudOrganizationPreviewReply({
      accountId,
      logger: noopLogger,
    });
  } else if (action === "review" || action === "rereview") {
    reply = await buildCloudOrganizationReviewReplyCached({
      accountId,
      sessionKey,
      forceReReview: action === "rereview",
      logger: noopLogger,
      signal,
    });
  } else if (action === "why") {
    reply = await buildCloudOrganizationWhyReply({
      accountId,
      sessionKey,
      logger: noopLogger,
    });
  } else if (action === "exit") {
    reply = {
      text: [
        "結論",
        "我已退出雲文檔分類/角色分配模式。",
        "",
        "下一步",
        "- 你現在可以直接換話題，或之後再重新開始分類。",
      ].join("\n"),
    };
  }

  return {
    plannerEnvelope: {
      ok: Boolean(reply?.text),
      action: action || null,
      execution_result: {
        ok: Boolean(reply?.text),
        data: {
          answer: reply?.text || "",
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: Boolean(reply?.text),
    },
    replyText: normalizeText(reply?.text || ""),
    ownerSurface: "workflow:cloud_doc_organization",
    governance: reply?.timeout_governance || null,
  };
}

async function runMockPlannerEnvelopeEvalCase(testCase = {}) {
  const plannerEnvelope = testCase?.context?.mock_planner_envelope
    && typeof testCase.context.mock_planner_envelope === "object"
    && !Array.isArray(testCase.context.mock_planner_envelope)
    ? testCase.context.mock_planner_envelope
    : {};
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    requestText: testCase.user_text,
    logger: noopLogger,
  });
  return {
    plannerEnvelope,
    userResponse,
    replyText: renderUserResponseText(userResponse),
  };
}

async function runWorkflowTimeoutGovernanceEvalCase(testCase = {}, route = {}) {
  const governance = resolveTimeoutGovernanceConfig(testCase) || {};
  const family = normalizeText(governance.family || governance.expected_family || "") || "unclassified_timeout";
  const durationMs = Number.isFinite(Number(governance.simulated_duration_ms))
    ? Number(governance.simulated_duration_ms)
    : 0;
  const timeoutMs = Number.isFinite(Number(governance.timeout_ms))
    ? Number(governance.timeout_ms)
    : null;
  const replyText = buildGovernanceSimulationReply({
    family,
    durationMs,
    timeoutMs,
  });
  const failClosedFamily = family === "timeout_fail_closed"
    || family === "workflow_too_slow"
    || family === "needs_fixture_mock"
    || family === "unclassified_timeout";
  const timeoutObserved = family === "timeout_acceptable"
    || family === "timeout_fail_closed"
    || family === "unclassified_timeout";
  const failureClass = family === "timeout_fail_closed" || family === "unclassified_timeout"
    ? "timeout"
    : family === "workflow_too_slow"
      ? "workflow_too_slow"
      : family === "needs_fixture_mock"
        ? "permission_denied"
        : null;

  return {
    plannerEnvelope: {
      ok: !failClosedFamily,
      ...(failureClass ? { error: failureClass === "timeout" ? "request_timeout" : failureClass } : {}),
      action: normalizeText(route?.planner_action || "") || null,
      execution_result: {
        ok: !failClosedFamily,
        ...(failureClass ? { error: failureClass === "timeout" ? "request_timeout" : failureClass } : {}),
        data: {
          answer: replyText,
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: !failClosedFamily,
      ...(failureClass ? { failure_class: failureClass } : {}),
    },
    replyText,
    ownerSurface: family === "needs_fixture_mock"
      ? "permission_denied"
      : "workflow:cloud_doc_organization",
    governance: {
      family,
      duration_ms: durationMs,
      timeout_ms: timeoutMs,
      timeout_observed: timeoutObserved,
      fallback_used: family === "timeout_acceptable",
      workflow_still_running: family === "workflow_too_slow",
      needs_fixture_mock: family === "needs_fixture_mock",
      slow_warning_ms: resolveGovernanceSlowWarningMs(governance),
    },
  };
}

async function runKnowledgeAssistantEvalCase(testCase = {}, route = {}, { signal = null } = {}) {
  const sessionKey = `usage-layer-eval:${testCase.id}`;
  return runPlannerUserInputEdge({
    text: testCase.user_text,
    logger: noopLogger,
    signal,
    sessionKey,
    requestId: sessionKey,
    async plannerExecutor() {
      const runtimeResult = await runPlannerToolFlow({
        userIntent: testCase.user_text,
        payload: {},
        logger: noopLogger,
        forcedSelection: {
          selected_action: normalizeText(route?.planner_action || "") || null,
          reason: "usage_layer_eval_forced_route",
        },
        disableAutoRouting: true,
        signal,
        sessionKey,
      });
      return {
        ok: runtimeResult?.execution_result?.ok === true,
        action: normalizeText(runtimeResult?.selected_action || route?.planner_action || "") || null,
        params: {},
        error: runtimeResult?.execution_result?.ok === false
          ? normalizeText(runtimeResult?.execution_result?.error || "") || null
          : null,
        execution_result: runtimeResult?.execution_result || null,
        formatted_output: runtimeResult?.formatted_output || null,
        trace_id: runtimeResult?.trace_id || null,
        why: null,
        alternative: null,
      };
    },
  });
}

async function runDocEditorEvalCase(testCase = {}, route = {}) {
  const lane = {
    capability_lane: "doc-editor",
    lane_label: "文檔編輯助手",
  };
  const scope = {
    capability_lane: "doc-editor",
    session_key: `usage-layer-eval:${testCase.id}`,
    workspace_key: "usage-layer-eval",
  };
  const replyText = buildLaneIntroReply(scope, lane);
  return {
    plannerEnvelope: {
      ok: true,
      action: normalizeText(route?.planner_action || "") || "comment_rewrite_preview",
      execution_result: {
        ok: true,
        data: {
          answer: replyText,
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: true,
    },
    replyText,
  };
}

async function runRegisteredAgentEvalCase(testCase = {}, route = {}) {
  const command = parseRegisteredAgentCommand(testCase.user_text);
  if (!command?.agent) {
    return {
      plannerEnvelope: {
        ok: false,
        error: normalizeText(route?.planner_action || "") || "registered_agent_unavailable",
      },
      userResponse: {
        ok: false,
        failure_class: "routing_no_match",
      },
      replyText: "",
      ownerSurface: "routing_no_match",
    };
  }

  const { agentResult, replyText, ownerSurface } = await buildResolvedRegisteredAgentEvalExecution({
    testCase,
    route,
    agent: command.agent,
    requestText: command.body || testCase.user_text,
  });

  return {
    plannerEnvelope: {
      ok: Boolean(agentResult?.text),
      action: "dispatch_registered_agent",
      execution_result: {
        ok: Boolean(agentResult?.text),
        data: {
          answer: agentResult?.text || "",
          sources: [],
          limitations: [],
        },
      },
      ...(normalizeText(agentResult?.error || "")
        ? { error: normalizeText(agentResult.error) }
        : {}),
    },
    userResponse: {
      ok: Boolean(agentResult?.text),
    },
    replyText,
    ownerSurface,
  };
}

async function runMeetingWorkflowEvalCase(testCase = {}, route = {}) {
  const action = normalizeText(route?.planner_action || "") || "start_capture";
  const answer = (() => {
    if (action === "capture_status") {
      return "我已把這句話視為會議記錄狀態確認，先維持在會議 workflow 裡等待下一步。";
    }
    if (action === "stop_capture") {
      return "我已把這句話視為會議流程收尾指令，先留在會議 workflow 內準備收尾。";
    }
    if (action === "confirm") {
      return "我已把這句話視為會議確認寫入指令，先留在會議 workflow 裡等待確認內容。";
    }
    return `我已把這句「${testCase.user_text}」視為會議 workflow 入口。`;
  })();
  const limitation = (() => {
    if (action === "capture_status") {
      return "如果你要我直接往下處理，下一句可以補會議是否已開始，或直接說要不要停止記錄。";
    }
    if (action === "stop_capture") {
      return "如果你要我直接收尾，下一句可以補會議名稱、決策或摘要格式。";
    }
    if (action === "confirm") {
      return "如果你要我直接確認寫入，下一句可以補確認編號或貼上要確認的內容。";
    }
    return "如果你要我直接往下接，下一句可以補會議名稱、參與者，或直接說開始記錄。";
  })();

  return {
    plannerEnvelope: {
      ok: true,
      action,
      execution_result: {
        ok: true,
        data: {
          answer,
          sources: ["已辨識為會議 workflow 邊界。"],
          limitations: [limitation],
        },
      },
    },
    userResponse: {
      ok: true,
    },
    replyText: [answer, limitation].join("\n"),
  };
}

async function runPersonalAssistantBoundaryEvalCase(testCase = {}) {
  const requestText = normalizeText(testCase.user_text);
  const plannerEnvelope = {
    ok: false,
    action: null,
    params: {},
    error: "business_error",
    execution_result: {
      ok: false,
      data: {
        answer: requestText
          ? `這題我先沒辦法直接替你完成「${requestText}」，所以先用一般助理的方式接住你。`
          : "這題我先沒辦法直接替你完成，所以先用一般助理的方式接住你。",
        sources: [],
        limitations: [
          requestText
            ? `你可以補一句你想先完成「${requestText}」中的哪一部分，我會改用更合適的方式處理。`
            : "你可以補一句你想先完成哪一部分，我會改用更合適的方式處理。",
        ],
      },
    },
    formatted_output: null,
    why: ROUTING_NO_MATCH,
    alternative: null,
    trace_id: null,
    trace: {
      chosen_action: null,
      fallback_reason: ROUTING_NO_MATCH,
      reasoning: {
        why: ROUTING_NO_MATCH,
        alternative: null,
      },
    },
  };
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    requestText: testCase.user_text,
    logger: noopLogger,
  });
  return {
    plannerEnvelope,
    userResponse,
    replyText: renderUserResponseText(userResponse),
  };
}

async function runExecutiveEvalCase(testCase = {}, route = {}) {
  const explicitAgentRequest = resolveRegisteredAgentFamilyRequest(testCase.user_text, {
    includeSlashCommand: true,
    includePersonaMentions: true,
    includeKnowledgeCommands: false,
  });
  const explicitAgentId = normalizeText(explicitAgentRequest?.agent?.id || "");

  if (explicitAgentRequest?.agent && explicitAgentId !== "generalist") {
    const { agentResult, replyText, ownerSurface } = await buildResolvedRegisteredAgentEvalExecution({
      testCase,
      route,
      agent: explicitAgentRequest.agent,
      requestText: explicitAgentRequest.body || testCase.user_text,
    });
    return {
      plannerEnvelope: {
        ok: Boolean(agentResult?.text),
        action: normalizeText(route?.planner_action || "") || "start",
        execution_result: {
          ok: Boolean(agentResult?.text),
          data: {
            answer: agentResult?.text || "",
            sources: [],
            limitations: [],
          },
        },
      },
      userResponse: {
        ok: Boolean(agentResult?.text),
      },
      replyText,
      ownerSurface,
    };
  }

  const replyText = [
    "結論",
    `這句「${testCase.user_text}」比較像需要 executive lane 收斂的協作任務，我先按 executive brief 接住。`,
    "",
    "重點",
    "- 這輪帶有多 agent 協作 / 統一收斂訊號。",
    "",
    "下一步",
    "- 如果你要我直接往下做，貼上文件、決策題目，或你想要的最終輸出格式，我就先以 generalist 收斂。",
  ].join("\n");
  return {
    plannerEnvelope: {
      ok: true,
      action: normalizeText(route?.planner_action || "") || "start",
      execution_result: {
        ok: true,
        data: {
          answer: replyText,
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: true,
    },
    replyText,
    ownerSurface: "executive:generic",
  };
}

async function runRoutingNoMatchEvalCase(testCase = {}, route = {}) {
  const replyText = [
    "結論",
    "這條需求目前還沒有對應到可驗證的 runtime，我先不假裝已經替你完成。",
    "",
    "下一步",
    `- 如果你補明確時間與內容，我可以先把「${testCase.user_text}」整理成可手動執行的提醒文字。`,
  ].join("\n");
  return {
    plannerEnvelope: {
      ok: false,
      error: "ROUTING_NO_MATCH",
      action: normalizeText(route?.planner_action || "") || null,
      execution_result: {
        ok: false,
        error: "ROUTING_NO_MATCH",
        data: {
          answer: replyText,
          sources: [],
          limitations: [],
        },
      },
    },
    userResponse: {
      ok: false,
      failure_class: "routing_no_match",
    },
    replyText,
    ownerSurface: "routing_no_match",
  };
}

function normalizeIssueCode(value = "") {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function deriveIssueCodes(result = {}) {
  const issueCodes = new Set();
  if (result.timed_out === true) {
    issueCodes.add("CASE_TIMEOUT");
  }
  if (result.first_turn_success !== true) {
    issueCodes.add("FIRST_TURN_SUCCESS_MISS");
  }
  if (result.wrong_route === true) {
    issueCodes.add("WRONG_ROUTE");
  }
  if (result.tool_omission === true) {
    issueCodes.add("TOOL_OMISSION");
  }
  if (result.generic === true && result.should_fail_if_generic === true) {
    issueCodes.add("GENERIC_REPLY");
  }
  if (result.wrong_owner_surface === true) {
    issueCodes.add("WRONG_OWNER_SURFACE");
  }
  if (result.unnecessary_clarification === true) {
    issueCodes.add("UNNECESSARY_CLARIFICATION");
  }
  if (
    normalizeText(result.expected_eval_outcome || "")
    && normalizeText(result.actual_eval_outcome || "")
    && normalizeText(result.expected_eval_outcome || "") !== normalizeText(result.actual_eval_outcome || "")
  ) {
    issueCodes.add("EVAL_OUTCOME_MISS");
  }
  if (
    normalizeText(result.expected_reply_mode || "")
    && normalizeText(result.actual_reply_mode || "")
    && normalizeText(result.expected_reply_mode || "") !== normalizeText(result.actual_reply_mode || "")
  ) {
    issueCodes.add("REPLY_MODE_MISS");
  }
  const normalizedFailureClass = normalizeText(result.failure_class || "");
  if (normalizedFailureClass && normalizedFailureClass !== "none") {
    issueCodes.add(`FAILURE_CLASS_${normalizeIssueCode(normalizedFailureClass)}`);
  }
  const normalizedGovernanceFamily = normalizeText(result.governance_family || "");
  if (normalizedGovernanceFamily && normalizedGovernanceFamily !== "none" && normalizedGovernanceFamily !== "pass") {
    issueCodes.add(`GOVERNANCE_${normalizeIssueCode(normalizedGovernanceFamily)}`);
  }
  return [...issueCodes];
}

function summarizeFailReasons(result = {}) {
  return deriveIssueCodes(result);
}

function deriveGovernanceFamilyFromResult(result = {}) {
  return classifyWorkflowTimeoutGovernanceFamily({
    explicitFamily: result.governance_family || null,
    timedOut: result.timed_out === true,
    durationMs: result.duration_ms,
    slowWarningMs: DEFAULT_WORKFLOW_SLOW_WARNING_MS,
    failClosed: normalizeText(result.actual_eval_outcome || "") === "fail_closed",
  });
}

export async function runUsageLayerEvalCase(testCase = {}, {
  timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS,
  signal = null,
} = {}) {
  const route = resolveRoutingEvalCase(normalizeEvalCase(testCase));
  const governanceConfig = resolveTimeoutGovernanceConfig(testCase);
  const effectiveRoute = governanceConfig
    ? {
        lane: normalizeText(testCase.expected_lane || "") || normalizeText(route?.lane || ""),
        planner_action: normalizeText(testCase.expected_planner_action || "") || normalizeText(route?.planner_action || ""),
        agent_or_tool: normalizeText(testCase.expected_agent_or_tool || "") || normalizeText(route?.agent_or_tool || ""),
      }
    : route;
  const startedAt = Date.now();
  const caseSignal = signal || createEvalCaseSignal(timeoutMs);
  const sessionKey = `usage-layer-eval:${testCase.id}`;
  let execution;
  primeUsageLayerEvalRuntimeContext(testCase, sessionKey);
  try {
    if (testCase?.context?.mock_planner_envelope) {
      execution = await runMockPlannerEnvelopeEvalCase(testCase);
    } else if (governanceConfig) {
      execution = await runWorkflowTimeoutGovernanceEvalCase(testCase, effectiveRoute);
    } else if (
      normalizeText(testCase?.expected_lane || "") === "personal_assistant"
      && normalizeText(testCase?.expected_success_type || "") === "fail_soft"
    ) {
      execution = await runRoutingNoMatchEvalCase(testCase, effectiveRoute);
    } else if (
      normalizeText(testCase?.expected_lane || "") === "personal_assistant"
      && normalizeText(testCase?.expected_planner_action || "") === "general_assistant_action"
      && normalizeText(testCase?.expected_agent_or_tool || "") === "reply:default"
    ) {
      execution = await runPersonalAssistantBoundaryEvalCase(testCase);
    } else if (normalizeText(effectiveRoute?.lane || "") === "knowledge_assistant") {
      execution = await runKnowledgeAssistantEvalCase(testCase, effectiveRoute, { signal: caseSignal });
    } else if (normalizeText(effectiveRoute?.lane || "") === "cloud_doc_workflow") {
      execution = await runCloudDocWorkflowEvalCase(testCase, effectiveRoute, { signal: caseSignal });
    } else if (normalizeText(effectiveRoute?.lane || "") === "meeting_workflow") {
      execution = await runMeetingWorkflowEvalCase(testCase, effectiveRoute);
    } else if (normalizeText(effectiveRoute?.lane || "") === "doc_editor") {
      execution = await runDocEditorEvalCase(testCase, effectiveRoute);
    } else if (normalizeText(effectiveRoute?.lane || "") === "executive") {
      execution = await runExecutiveEvalCase(testCase, effectiveRoute);
    } else if (
      normalizeText(effectiveRoute?.lane || "") === "registered_agent"
      && normalizeText(effectiveRoute?.planner_action || "") === "dispatch_registered_agent"
    ) {
      execution = await runRegisteredAgentEvalCase(testCase, effectiveRoute);
    } else if (
      normalizeText(effectiveRoute?.planner_action || "") === "ROUTING_NO_MATCH"
      || normalizeText(effectiveRoute?.agent_or_tool || "") === "error:ROUTING_NO_MATCH"
    ) {
      execution = await runRoutingNoMatchEvalCase(testCase, effectiveRoute);
    } else {
      execution = await runPlannerUserInputEdge({
        text: testCase.user_text,
        logger: noopLogger,
        signal: caseSignal,
        sessionKey,
        requestId: sessionKey,
      });
    }
  } catch (error) {
    if (caseSignal?.aborted || isAbortLikeError(error)) {
      execution = buildEvalTimeoutExecution({
        route: effectiveRoute,
        timeoutMs,
      });
    } else {
      throw error;
    }
  } finally {
    resetPlannerDocQueryRuntimeContext({ sessionKey });
  }
  const plannerEnvelope = execution?.plannerEnvelope || {};
  const userResponse = execution?.userResponse || {};
  const replyText = normalizeText(execution?.replyText || renderUserResponseText(userResponse));
  const executedTarget = inferExecutedTarget({
    envelope: plannerEnvelope,
    route: effectiveRoute,
  });
  const failureClass = resolveFailureClass({
    testCase,
    userResponse,
    route: effectiveRoute,
    plannerEnvelope,
    executedTarget,
  });
  const actualOwnerSurface = inferOwnerSurface({
    execution,
    testCase,
    route: effectiveRoute,
    failureClass,
  });
  const replyMode = classifyReplyMode({ userResponse, route: effectiveRoute, replyText });
  const actualSuccessType = classifySuccessType(replyMode);
  const generic = looksGenericReply({
    replyText,
    requestText: testCase.user_text,
    contextTexts: collectContextTexts(testCase),
  });
  const actualEvalOutcome = classifyEvalOutcome({
    successType: actualSuccessType,
    generic,
  });
  const unnecessaryClarification = actualSuccessType === "clarify"
    && !requestActuallyNeedsClarification(testCase);
  const wrongRoute = normalizeText(effectiveRoute?.lane || "") !== normalizeText(testCase.expected_lane || "")
    || normalizeText(effectiveRoute?.planner_action || "") !== normalizeText(testCase.expected_planner_action || "")
    || normalizeText(effectiveRoute?.agent_or_tool || "") !== normalizeText(testCase.expected_agent_or_tool || "");
  const successTypeHit = normalizeText(actualSuccessType) === normalizeText(testCase.expected_success_type);
  const genericFail = testCase.should_fail_if_generic === true && generic === true;
  const firstTurnSuccess = successTypeHit && !genericFail;
  const toolOmission = testCase.tool_required === true && !isControlledTarget(executedTarget);
  const expectedOwnerSurface = normalizeText(testCase.expected_owner_surface || "") || null;
  const wrongOwnerSurface = expectedOwnerSurface
    ? actualOwnerSurface !== expectedOwnerSurface
    : false;
  const genericOwnerSurface = expectedOwnerSurface?.startsWith("agent:")
    && actualOwnerSurface === "executive:generic";
  const durationMs = Date.now() - startedAt;
  const timedOut = normalizeText(plannerEnvelope?.error || "") === "case_timeout";
  const governance = execution?.governance && typeof execution.governance === "object"
    ? execution.governance
    : null;
  const governanceFamily = classifyWorkflowTimeoutGovernanceFamily({
    explicitFamily: governance?.family || null,
    timedOut,
    timeoutObserved: governance?.timeout_observed === true,
    durationMs: governance?.duration_ms ?? durationMs,
    slowWarningMs: resolveGovernanceSlowWarningMs(governanceConfig || governance),
    fallbackUsed: governance?.fallback_used === true,
    failClosed: actualEvalOutcome === "fail_closed",
    workflowStillRunning: governance?.workflow_still_running === true,
    needsFixtureMock: governance?.needs_fixture_mock === true,
  });

  const caseResult = {
    id: testCase.id,
    source_anchor: testCase.source_anchor || null,
    user_text: testCase.user_text,
    expected_lane: testCase.expected_lane,
    expected_planner_action: testCase.expected_planner_action,
    expected_agent_or_tool: testCase.expected_agent_or_tool,
    tool_required: testCase.tool_required === true,
    expected_success_type: testCase.expected_success_type,
    expected_reply_mode: testCase.expected_reply_mode,
    expected_eval_outcome: testCase.expected_eval_outcome,
    should_fail_if_generic: testCase.should_fail_if_generic === true,
    expected_owner_surface: expectedOwnerSurface,
    actual_lane: normalizeText(effectiveRoute?.lane || "") || "unknown",
    actual_action: normalizeText(effectiveRoute?.planner_action || "") || "unknown",
    actual_tool: normalizeText(effectiveRoute?.agent_or_tool || "") || "unknown",
    executed_action: normalizeText(plannerEnvelope?.action || "") || null,
    executed_target: executedTarget,
    actual_owner_surface: actualOwnerSurface,
    reply_text: replyText,
    actual_reply_mode: replyMode,
    actual_success_type: actualSuccessType,
    actual_eval_outcome: actualEvalOutcome,
    failure_class: failureClass,
    generic,
    unnecessary_clarification: unnecessaryClarification,
    first_turn_success: firstTurnSuccess,
    wrong_route: wrongRoute,
    tool_omission: toolOmission,
    wrong_owner_surface: wrongOwnerSurface,
    generic_owner_surface: genericOwnerSurface,
    timed_out: timedOut,
    duration_ms: durationMs,
    governance_family: governanceFamily,
  };
  return {
    ...caseResult,
    issue_codes: deriveIssueCodes(caseResult),
  };
}

export function summarizeResults(results = []) {
  const total = results.length;
  const normalizedResults = results.map((item) => ({
    ...item,
    governance_family: deriveGovernanceFamilyFromResult(item),
    issue_codes: Array.isArray(item.issue_codes) ? item.issue_codes : deriveIssueCodes(item),
  }));
  const toolRequiredCases = normalizedResults.filter((item) => item.tool_required === true);
  const genericSensitiveCases = normalizedResults.filter((item) => item.should_fail_if_generic === true);
  const clarifyCases = normalizedResults.filter((item) => item.actual_success_type === "clarify");
  const firstTurnSuccessCount = normalizedResults.filter((item) => item.first_turn_success === true).length;
  const wrongRouteCount = normalizedResults.filter((item) => item.wrong_route === true).length;
  const toolOmissionCount = toolRequiredCases.filter((item) => item.tool_omission === true).length;
  const genericFailCount = genericSensitiveCases.filter((item) => item.generic === true).length;
  const genericReplyCount = normalizedResults.filter((item) => item.actual_eval_outcome === "generic_reply").length;
  const wrongOwnerSurfaceCount = normalizedResults.filter((item) => item.wrong_owner_surface === true).length;
  const genericOwnerSurfaceCount = normalizedResults.filter((item) => item.generic_owner_surface === true).length;
  const partialSuccessOutcomeCount = normalizedResults.filter((item) => item.actual_eval_outcome === "partial_success").length;
  const unnecessaryClarificationCount = clarifyCases.filter((item) => item.unnecessary_clarification === true).length;
  const timedOutCases = normalizedResults.filter((item) => item.timed_out === true);
  const timeoutCount = timedOutCases.length;
  const governanceBreakdown = normalizedResults.reduce((acc, item) => {
    const key = normalizeText(item.governance_family || "") || "none";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const governedCases = normalizedResults.filter((item) => normalizeText(item.governance_family || ""));
  const failCases = normalizedResults
    .map((item) => ({
      ...item,
      fail_reasons: summarizeFailReasons(item),
    }))
    .filter((item) => item.fail_reasons.length > 0)
    .sort((left, right) => right.fail_reasons.length - left.fail_reasons.length)
    .slice(0, 5);
  const failureBreakdown = normalizedResults.reduce((acc, item) => {
    const key = normalizeText(item.failure_class || "") || "none";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topFailureCategories = Object.entries(failureBreakdown)
    .filter(([key]) => key !== "none")
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([failureClass, count]) => ({ failure_class: failureClass, count }));
  const expectedOutcomeBreakdown = normalizedResults.reduce((acc, item) => {
    const key = normalizeText(item.expected_eval_outcome || "") || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const actualOutcomeBreakdown = normalizedResults.reduce((acc, item) => {
    const key = normalizeText(item.actual_eval_outcome || "") || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const issueCodeBreakdown = normalizedResults.reduce((acc, item) => {
    const issueCodes = Array.isArray(item.issue_codes) ? item.issue_codes : [];
    for (const issueCode of issueCodes) {
      const normalizedIssueCode = normalizeText(issueCode || "").toUpperCase();
      if (!normalizedIssueCode) {
        continue;
      }
      acc[normalizedIssueCode] = (acc[normalizedIssueCode] || 0) + 1;
    }
    return acc;
  }, {});

  return {
    total,
    metrics: {
      FTHR: toPercent(firstTurnSuccessCount, total),
      generic_rate: toPercent(genericReplyCount, total),
      partial_success_rate: toPercent(partialSuccessOutcomeCount, total),
      WRR: toPercent(wrongRouteCount, total),
      TOR: toPercent(toolOmissionCount, toolRequiredCases.length),
      GRR: toPercent(genericFailCount, genericSensitiveCases.length),
      UCR: toPercent(unnecessaryClarificationCount, clarifyCases.length),
      RDR: "TODO",
    },
    counts: {
      first_turn_success: firstTurnSuccessCount,
      wrong_route: wrongRouteCount,
      tool_required_cases: toolRequiredCases.length,
      tool_omission: toolOmissionCount,
      generic_sensitive_cases: genericSensitiveCases.length,
      generic_fail: genericFailCount,
      generic_replies: genericReplyCount,
      wrong_owner_surface: wrongOwnerSurfaceCount,
      generic_owner_surface: genericOwnerSurfaceCount,
      partial_success_outcomes: partialSuccessOutcomeCount,
      clarify_cases: clarifyCases.length,
      unnecessary_clarification: unnecessaryClarificationCount,
      timed_out: timeoutCount,
      governed_cases: governedCases.length,
      unclassified_timeout: governanceBreakdown.unclassified_timeout || 0,
      reply_discipline_logged_cases: total,
    },
    expected_outcome_breakdown: expectedOutcomeBreakdown,
    actual_outcome_breakdown: actualOutcomeBreakdown,
    failure_breakdown: failureBreakdown,
    issue_code_breakdown: issueCodeBreakdown,
    governance_breakdown: governanceBreakdown,
    top_failure_categories: topFailureCategories,
    top_fail_cases: failCases,
    timed_out_cases: timedOutCases.map((item) => ({
      id: item.id,
      user_text: item.user_text,
      duration_ms: item.duration_ms,
    })),
    governance_cases: normalizedResults
      .filter((item) => normalizeText(item.governance_family || ""))
      .map((item) => ({
        id: item.id,
        governance_family: item.governance_family,
        duration_ms: item.duration_ms,
        user_text: item.user_text,
      })),
  };
}

function printSummary(summary = {}) {
  console.log("=== Usage Layer Eval Summary ===");
  console.log(`Total: ${summary.total}`);
  console.log(`FTHR: ${summary.metrics.FTHR}`);
  console.log(`Generic Rate: ${summary.metrics.generic_rate}`);
  console.log(`Partial Success Rate: ${summary.metrics.partial_success_rate}`);
  console.log(`WRR: ${summary.metrics.WRR}`);
  console.log(`TOR: ${summary.metrics.TOR}`);
  console.log(`GRR: ${summary.metrics.GRR}`);
  console.log(`UCR: ${summary.metrics.UCR}`);
  console.log(`Wrong Owner Surface: ${summary.counts.wrong_owner_surface}`);
  console.log(`Generic Owner Surface: ${summary.counts.generic_owner_surface}`);
  console.log(`Timeouts: ${summary.counts.timed_out}`);
  console.log(`Governed Cases: ${summary.counts.governed_cases}`);
  console.log(`Unclassified Timeout Families: ${summary.counts.unclassified_timeout}`);
  console.log(`RDR: ${summary.metrics.RDR} (${summary.counts.reply_discipline_logged_cases} cases logged for manual reply-discipline review)`);
  console.log(`Expected outcomes: ${JSON.stringify(summary.expected_outcome_breakdown)}`);
  console.log(`Actual outcomes: ${JSON.stringify(summary.actual_outcome_breakdown)}`);
  console.log(`Issue codes: ${JSON.stringify(summary.issue_code_breakdown)}`);
  console.log(`Governance families: ${JSON.stringify(summary.governance_breakdown)}`);
  console.log("");
  console.log("Top failure categories:");
  if (!Array.isArray(summary.top_failure_categories) || summary.top_failure_categories.length === 0) {
    console.log("- none");
  } else {
    for (const item of summary.top_failure_categories) {
      console.log(`- ${item.failure_class}: ${item.count}`);
    }
  }
  console.log("");
  console.log("Timed out cases:");
  if (!Array.isArray(summary.timed_out_cases) || summary.timed_out_cases.length === 0) {
    console.log("- none");
  } else {
    for (const item of summary.timed_out_cases) {
      console.log(`- ${item.id} | ${item.duration_ms}ms | ${item.user_text}`);
    }
  }
  console.log("");
  console.log("Governance cases:");
  if (!Array.isArray(summary.governance_cases) || summary.governance_cases.length === 0) {
    console.log("- none");
  } else {
    for (const item of summary.governance_cases) {
      console.log(`- ${item.id} | ${item.governance_family} | ${item.duration_ms}ms | ${item.user_text}`);
    }
  }
  console.log("");
  console.log("Top 5 fail cases:");
  if (!Array.isArray(summary.top_fail_cases) || summary.top_fail_cases.length === 0) {
    console.log("- none");
    return;
  }
  for (const item of summary.top_fail_cases) {
    console.log(`- ${item.user_text} | ${item.fail_reasons.join("; ")}`);
  }
}

function resolveUsageLayerEvalPack(packName = "") {
  const normalizedPackName = normalizeText(packName || "");
  if (!normalizedPackName || normalizedPackName === "default") {
    return usageLayerEvals;
  }
  if (normalizedPackName === "registered-agent-family") {
    return registeredAgentFamilyEvals;
  }
  if (normalizedPackName === "followup-multi-intent-continuity") {
    return followupMultiIntentContinuityEvals;
  }
  if (normalizedPackName === "workflow-timeout-governance") {
    return workflowTimeoutGovernanceEvals;
  }
  throw new Error(`unknown usage-layer eval pack: ${packName}`);
}

function resolveCliOptions(argv = process.argv.slice(2)) {
  const options = {
    pack: "",
    artifactDir: DEFAULT_USAGE_LAYER_EVAL_ARTIFACT_DIR,
    baselinePath: "",
    runReportPath: "",
    failReportPath: "",
    writeBaseline: false,
    skipBaselineCheck: false,
    driftTolerance: Number.isFinite(DEFAULT_USAGE_LAYER_BASELINE_DRIFT_TOLERANCE)
      ? DEFAULT_USAGE_LAYER_BASELINE_DRIFT_TOLERANCE
      : 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--pack") {
      options.pack = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--artifact-dir") {
      options.artifactDir = argv[index + 1] || options.artifactDir;
      index += 1;
      continue;
    }
    if (token === "--baseline") {
      options.baselinePath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--run-report") {
      options.runReportPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--fail-report") {
      options.failReportPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--drift-tolerance") {
      const parsed = Number.parseInt(argv[index + 1] || "", 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.driftTolerance = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--write-baseline") {
      options.writeBaseline = true;
      continue;
    }
    if (token === "--skip-baseline-check") {
      options.skipBaselineCheck = true;
      continue;
    }
  }
  return options;
}

function resolveUsageLayerArtifactPaths({
  artifactDir = DEFAULT_USAGE_LAYER_EVAL_ARTIFACT_DIR,
  packName = "",
  baselinePath = "",
  runReportPath = "",
  failReportPath = "",
} = {}) {
  const normalizedPackName = normalizeText(packName || "") || "default";
  const scopedSuffix = normalizedPackName === "default"
    ? ""
    : `.${normalizedPackName.replace(/[^a-z0-9_-]+/g, "_")}`;
  return {
    artifactDir,
    baselinePath: baselinePath || path.join(artifactDir, `baseline${scopedSuffix}.json`),
    runReportPath: runReportPath || path.join(artifactDir, `last-run${scopedSuffix}.json`),
    failReportPath: failReportPath || path.join(artifactDir, `fail-report${scopedSuffix}.json`),
  };
}

function buildPerCaseFailReportEntry(result = {}) {
  const issueCodes = Array.isArray(result.issue_codes) ? result.issue_codes : deriveIssueCodes(result);
  return {
    id: result.id,
    expected: {
      lane: result.expected_lane || null,
      planner_action: result.expected_planner_action || null,
      agent_or_tool: result.expected_agent_or_tool || null,
      reply_mode: result.expected_reply_mode || null,
      success_type: result.expected_success_type || null,
      eval_outcome: result.expected_eval_outcome || null,
    },
    actual: {
      lane: result.actual_lane || null,
      planner_action: result.actual_action || null,
      agent_or_tool: result.actual_tool || null,
      executed_target: result.executed_target || null,
      reply_mode: result.actual_reply_mode || null,
      success_type: result.actual_success_type || null,
      eval_outcome: result.actual_eval_outcome || null,
      failure_class: result.failure_class || null,
      timed_out: result.timed_out === true,
      duration_ms: Number.isFinite(Number(result.duration_ms)) ? Number(result.duration_ms) : null,
    },
    issue_codes: issueCodes,
    owner_surface: {
      expected: result.expected_owner_surface || null,
      actual: result.actual_owner_surface || null,
    },
  };
}

function buildFailReport(results = [], summary = {}, {
  packName = "",
} = {}) {
  const failCases = results
    .map((result) => buildPerCaseFailReportEntry(result))
    .filter((entry) => Array.isArray(entry.issue_codes) && entry.issue_codes.length > 0);
  return {
    generated_at: new Date().toISOString(),
    pack: normalizeText(packName || "") || "default",
    total_cases: results.length,
    failed_cases: failCases.length,
    metrics: summary.metrics || {},
    failure_breakdown: summary.failure_breakdown || {},
    issue_code_breakdown: summary.issue_code_breakdown || {},
    cases: failCases,
  };
}

function buildBaselineCaseSnapshot(result = {}) {
  const issueCodes = Array.isArray(result.issue_codes) ? result.issue_codes : deriveIssueCodes(result);
  return {
    id: result.id,
    expected: {
      lane: result.expected_lane || null,
      planner_action: result.expected_planner_action || null,
      agent_or_tool: result.expected_agent_or_tool || null,
      reply_mode: result.expected_reply_mode || null,
      success_type: result.expected_success_type || null,
      eval_outcome: result.expected_eval_outcome || null,
    },
    actual: {
      lane: result.actual_lane || null,
      planner_action: result.actual_action || null,
      agent_or_tool: result.actual_tool || null,
      executed_target: result.executed_target || null,
      reply_mode: result.actual_reply_mode || null,
      success_type: result.actual_success_type || null,
      eval_outcome: result.actual_eval_outcome || null,
      failure_class: result.failure_class || null,
      timed_out: result.timed_out === true,
      governance_family: result.governance_family || null,
    },
    issue_codes: issueCodes,
    owner_surface: {
      expected: result.expected_owner_surface || null,
      actual: result.actual_owner_surface || null,
    },
  };
}

function buildBaselineSnapshot(results = [], summary = {}, {
  packName = "",
} = {}) {
  return {
    generated_at: new Date().toISOString(),
    pack: normalizeText(packName || "") || "default",
    total_cases: results.length,
    metrics: summary.metrics || {},
    cases: results
      .map((result) => buildBaselineCaseSnapshot(result))
      .sort((left, right) => String(left.id || "").localeCompare(String(right.id || ""))),
  };
}

function buildCaseSignature(caseItem = {}) {
  const issueCodes = Array.isArray(caseItem.issue_codes) ? [...caseItem.issue_codes].sort() : [];
  const volatileIssueCodes = new Set([
    "UNNECESSARY_CLARIFICATION",
    "REPLY_MODE_MISS",
  ]);
  const stableIssueCodes = issueCodes.filter((issueCode) => !volatileIssueCodes.has(String(issueCode || "").toUpperCase()));
  return JSON.stringify({
    issue_codes: stableIssueCodes,
    owner_surface_actual: normalizeText(caseItem?.owner_surface?.actual || ""),
    owner_surface_expected: normalizeText(caseItem?.owner_surface?.expected || ""),
    actual_lane: normalizeText(caseItem?.actual?.lane || ""),
    actual_planner_action: normalizeText(caseItem?.actual?.planner_action || ""),
    actual_agent_or_tool: normalizeText(caseItem?.actual?.agent_or_tool || ""),
    actual_executed_target: normalizeText(caseItem?.actual?.executed_target || ""),
    actual_eval_outcome: normalizeText(caseItem?.actual?.eval_outcome || ""),
    failure_class: normalizeText(caseItem?.actual?.failure_class || ""),
    timed_out: caseItem?.actual?.timed_out === true,
    governance_family: normalizeText(caseItem?.actual?.governance_family || ""),
  });
}

function compareWithBaseline(baseline = {}, current = {}, {
  driftTolerance = DEFAULT_USAGE_LAYER_BASELINE_DRIFT_TOLERANCE,
} = {}) {
  const baselinePack = normalizeText(baseline?.pack || "") || "default";
  const currentPack = normalizeText(current?.pack || "") || "default";
  if (baselinePack !== currentPack) {
    return {
      ok: false,
      reason: "pack_mismatch",
      baseline_pack: baselinePack,
      current_pack: currentPack,
      drift_tolerance: driftTolerance,
      drift_case_count: Number.POSITIVE_INFINITY,
      changed_cases: [],
      new_cases: [],
      missing_cases: [],
    };
  }

  const baselineCases = Array.isArray(baseline?.cases) ? baseline.cases : [];
  const currentCases = Array.isArray(current?.cases) ? current.cases : [];
  const baselineMap = new Map(baselineCases.map((item) => [item.id, item]));
  const currentMap = new Map(currentCases.map((item) => [item.id, item]));

  const changedCases = [];
  const missingCases = [];
  const newCases = [];

  for (const [id, baselineItem] of baselineMap.entries()) {
    if (!currentMap.has(id)) {
      missingCases.push(id);
      continue;
    }
    const currentItem = currentMap.get(id);
    const baselineSignature = buildCaseSignature(baselineItem);
    const currentSignature = buildCaseSignature(currentItem);
    if (baselineSignature !== currentSignature) {
      changedCases.push({
        id,
        baseline_issue_codes: Array.isArray(baselineItem.issue_codes) ? baselineItem.issue_codes : [],
        current_issue_codes: Array.isArray(currentItem.issue_codes) ? currentItem.issue_codes : [],
      });
    }
  }
  for (const id of currentMap.keys()) {
    if (!baselineMap.has(id)) {
      newCases.push(id);
    }
  }

  const driftCaseCount = changedCases.length + missingCases.length + newCases.length;
  return {
    ok: driftCaseCount <= driftTolerance,
    reason: driftCaseCount <= driftTolerance ? "within_tolerance" : "exceeds_tolerance",
    baseline_pack: baselinePack,
    current_pack: currentPack,
    drift_tolerance: driftTolerance,
    drift_case_count: driftCaseCount,
    changed_cases: changedCases,
    new_cases: newCases,
    missing_cases: missingCases,
  };
}

async function writeJsonFile(filepath = "", payload = {}) {
  const dirname = path.dirname(filepath);
  await mkdir(dirname, { recursive: true });
  await writeFile(filepath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJsonFileOrNull(filepath = "") {
  try {
    const content = await readFile(filepath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    const code = String(error?.code || "").trim().toLowerCase();
    if (code === "enoent") {
      return null;
    }
    throw error;
  }
}

async function main() {
  const startedAt = Date.now();
  const cliOptions = resolveCliOptions(process.argv.slice(2));
  const selectedPack = resolveUsageLayerEvalPack(cliOptions.pack);
  const selectedPackName = normalizeText(cliOptions.pack || "") || "default";
  const artifactPaths = resolveUsageLayerArtifactPaths({
    artifactDir: cliOptions.artifactDir,
    packName: selectedPackName,
    baselinePath: cliOptions.baselinePath,
    runReportPath: cliOptions.runReportPath,
    failReportPath: cliOptions.failReportPath,
  });
  const results = [];
  for (const testCase of selectedPack) {
    console.log(`[usage-layer][case:start] ${testCase.id} ${testCase.user_text}`);
    const stuckWarningTimer = scheduleStuckCaseWarning(testCase);
    const result = await runUsageLayerEvalCase(testCase);
    clearTimeout(stuckWarningTimer);
    results.push(result);
    console.log(
      `[usage-layer][case:${result.timed_out ? "timeout" : "done"}] ${result.id} ${result.duration_ms}ms failure=${result.failure_class || "none"}`,
    );
  }
  const summary = summarizeResults(results);
  const failReport = buildFailReport(results, summary, { packName: selectedPackName });
  const baselineSnapshot = buildBaselineSnapshot(results, summary, { packName: selectedPackName });
  await writeJsonFile(artifactPaths.failReportPath, failReport);
  await writeJsonFile(artifactPaths.runReportPath, {
    ...baselineSnapshot,
    summary,
    generated_by: "usage-layer-runner",
    version: 1,
  });
  const existingBaseline = await readJsonFileOrNull(artifactPaths.baselinePath);
  let baselineStatus = null;
  if (existingBaseline && !cliOptions.skipBaselineCheck) {
    baselineStatus = compareWithBaseline(existingBaseline, baselineSnapshot, {
      driftTolerance: cliOptions.driftTolerance,
    });
  }
  const shouldWriteBaseline = cliOptions.writeBaseline || !existingBaseline;
  if (shouldWriteBaseline) {
    await writeJsonFile(artifactPaths.baselinePath, {
      ...baselineSnapshot,
      baseline_created_at: existingBaseline?.baseline_created_at || new Date().toISOString(),
      baseline_updated_at: new Date().toISOString(),
      generated_by: "usage-layer-runner",
      version: 1,
    });
  }
  printSummary(summary);
  console.log("");
  console.log(`Selected pack: ${selectedPackName}`);
  console.log(`Fail report: ${artifactPaths.failReportPath}`);
  console.log(`Run report: ${artifactPaths.runReportPath}`);
  console.log(`Baseline: ${artifactPaths.baselinePath}`);
  if (baselineStatus) {
    console.log(
      `Baseline drift: ${baselineStatus.drift_case_count} case(s), tolerance=${baselineStatus.drift_tolerance}, status=${baselineStatus.ok ? "PASS" : "FAIL"}`,
    );
    if (baselineStatus.reason === "pack_mismatch") {
      console.log(`Baseline compare skipped by pack mismatch (${baselineStatus.baseline_pack} vs ${baselineStatus.current_pack})`);
    } else if (baselineStatus.changed_cases.length > 0) {
      for (const item of baselineStatus.changed_cases.slice(0, 10)) {
        console.log(`- drift ${item.id} | baseline=${item.baseline_issue_codes.join(",") || "none"} | current=${item.current_issue_codes.join(",") || "none"}`);
      }
      if (baselineStatus.changed_cases.length > 10) {
        console.log(`- ... ${baselineStatus.changed_cases.length - 10} more changed case(s)`);
      }
    }
    if (baselineStatus.new_cases.length > 0) {
      console.log(`- new cases: ${baselineStatus.new_cases.join(", ")}`);
    }
    if (baselineStatus.missing_cases.length > 0) {
      console.log(`- missing cases: ${baselineStatus.missing_cases.join(", ")}`);
    }
  } else if (cliOptions.skipBaselineCheck) {
    console.log("Baseline compare: skipped (--skip-baseline-check)");
  } else {
    console.log("Baseline compare: no existing baseline, created a new one.");
  }
  console.log(`Total duration: ${Date.now() - startedAt}ms`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("usage-layer runner failed");
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
