import { usageLayerEvals } from "./usage-layer-evals.mjs";
import { runPlannerUserInputEdge } from "../../src/planner-user-input-edge.mjs";
import { renderUserResponseText } from "../../src/user-response-normalizer.mjs";
import { resolveRoutingEvalCase } from "../../src/routing-eval.mjs";
import { cleanText } from "../../src/message-intent-utils.mjs";
import {
  buildCloudOrganizationPreviewReply,
  buildCloudOrganizationReviewReplyCached,
  buildCloudOrganizationWhyReply,
} from "../../src/cloud-doc-organization-workflow.mjs";
import { getStoredAccountContext } from "../../src/lark-user-auth.mjs";
import { buildLaneIntroReply } from "../../src/capability-lane.mjs";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

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
  /這個|這份|這批|這些|這則|這篇|這份文件|第\d+份/u,
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

function toPercent(numerator = 0, denominator = 0) {
  if (denominator <= 0) {
    return "0.00%";
  }
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function extractKeywords(text = "") {
  return [...new Set(
    (normalizeText(text).match(TOKEN_PATTERN) || [])
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
  )];
}

function hasKeywordOverlap(replyText = "", requestText = "") {
  const normalizedReply = normalizeText(replyText);
  return extractKeywords(requestText).some((keyword) => normalizedReply.includes(keyword));
}

function looksGenericReply({ replyText = "", requestText = "" } = {}) {
  const normalizedReply = normalizeText(replyText);
  if (!normalizedReply) {
    return true;
  }
  if (normalizedReply.length < 36) {
    return true;
  }
  if (GENERIC_PATTERNS.some((pattern) => pattern.test(normalizedReply))) {
    return true;
  }
  if (STRUCTURED_REPLY_EXEMPT_PATTERNS.some((pattern) => pattern.test(normalizedReply))) {
    return false;
  }
  return !hasKeywordOverlap(normalizedReply, requestText);
}

function isClarificationReply(replyText = "") {
  const normalizedReply = normalizeText(replyText);
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(normalizedReply));
}

function isPartialSuccessReply(replyText = "") {
  const normalizedReply = normalizeText(replyText);
  return PARTIAL_SUCCESS_PATTERNS.some((pattern) => pattern.test(normalizedReply));
}

function requestLikelyNeedsClarification(requestText = "") {
  const normalizedRequest = normalizeText(requestText);
  return DEICTIC_PATTERNS.some((pattern) => pattern.test(normalizedRequest));
}

function normalizeEvalCase(testCase = {}) {
  return {
    text: testCase.user_text,
    context: testCase.context || {},
    scope: testCase.scope || {},
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
  if (normalizedUserFailureClass === "tool_omission" && hasRouteSelectedControlledExecutor(route)) {
    const envelopeError = normalizeText(plannerEnvelope?.error || "");
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
  const envelopeError = normalizeText(plannerEnvelope?.error || "");
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

async function runCloudDocWorkflowEvalCase(testCase = {}, route = {}) {
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
  };
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

function summarizeFailReasons(result = {}) {
  const reasons = [];
  if (result.first_turn_success !== true) {
    reasons.push(`first_turn_success_miss(${result.actual_success_type} vs ${result.expected_success_type})`);
  }
  if (result.wrong_route === true) {
    reasons.push(
      `wrong_route(${result.actual_lane}/${result.actual_action}/${result.actual_tool} vs ${result.expected_lane}/${result.expected_planner_action}/${result.expected_agent_or_tool})`,
    );
  }
  if (result.tool_omission === true) {
    reasons.push(`tool_omission(executed=${result.executed_target || "none"})`);
  }
  if (result.generic === true && result.should_fail_if_generic === true) {
    reasons.push("generic_reply");
  }
  if (result.unnecessary_clarification === true) {
    reasons.push("unnecessary_clarification");
  }
  return reasons;
}

async function runUsageLayerEvalCase(testCase = {}) {
  const route = resolveRoutingEvalCase(normalizeEvalCase(testCase));
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(15_000) : null;
  let execution;
  if (normalizeText(route?.lane || "") === "cloud_doc_workflow") {
    execution = await runCloudDocWorkflowEvalCase(testCase, route);
  } else if (normalizeText(route?.lane || "") === "doc_editor") {
    execution = await runDocEditorEvalCase(testCase, route);
  } else {
    execution = await runPlannerUserInputEdge({
      text: testCase.user_text,
      logger: noopLogger,
      signal,
      sessionKey: `usage-layer-eval:${testCase.id}`,
      requestId: `usage-layer-eval:${testCase.id}`,
    });
  }
  const plannerEnvelope = execution?.plannerEnvelope || {};
  const userResponse = execution?.userResponse || {};
  const replyText = normalizeText(execution?.replyText || renderUserResponseText(userResponse));
  const executedTarget = inferExecutedTarget({
    envelope: plannerEnvelope,
    route,
  });
  const failureClass = resolveFailureClass({
    testCase,
    userResponse,
    route,
    plannerEnvelope,
    executedTarget,
  });
  const replyMode = classifyReplyMode({ userResponse, route, replyText });
  const actualSuccessType = classifySuccessType(replyMode);
  const generic = failureClass && failureClass !== "generic_fallback"
    ? false
    : looksGenericReply({
        replyText,
        requestText: testCase.user_text,
      });
  const unnecessaryClarification = actualSuccessType === "clarify"
    && !requestLikelyNeedsClarification(testCase.user_text);
  const wrongRoute = normalizeText(route?.lane || "") !== normalizeText(testCase.expected_lane || "")
    || normalizeText(route?.planner_action || "") !== normalizeText(testCase.expected_planner_action || "")
    || normalizeText(route?.agent_or_tool || "") !== normalizeText(testCase.expected_agent_or_tool || "");
  const successTypeHit = normalizeText(actualSuccessType) === normalizeText(testCase.expected_success_type);
  const genericFail = testCase.should_fail_if_generic === true && generic === true;
  const firstTurnSuccess = successTypeHit && !genericFail;
  const toolOmission = testCase.tool_required === true && !isControlledTarget(executedTarget);

  return {
    id: testCase.id,
    source_anchor: testCase.source_anchor || null,
    user_text: testCase.user_text,
    expected_lane: testCase.expected_lane,
    expected_planner_action: testCase.expected_planner_action,
    expected_agent_or_tool: testCase.expected_agent_or_tool,
    expected_success_type: testCase.expected_success_type,
    expected_reply_mode: testCase.expected_reply_mode,
    should_fail_if_generic: testCase.should_fail_if_generic === true,
    actual_lane: normalizeText(route?.lane || "") || "unknown",
    actual_action: normalizeText(route?.planner_action || "") || "unknown",
    actual_tool: normalizeText(route?.agent_or_tool || "") || "unknown",
    executed_action: normalizeText(plannerEnvelope?.action || "") || null,
    executed_target: executedTarget,
    reply_text: replyText,
    actual_reply_mode: replyMode,
    actual_success_type: actualSuccessType,
    failure_class: failureClass,
    generic,
    unnecessary_clarification: unnecessaryClarification,
    first_turn_success: firstTurnSuccess,
    wrong_route: wrongRoute,
    tool_omission: toolOmission,
  };
}

function summarizeResults(results = []) {
  const total = results.length;
  const toolRequiredCases = results.filter((item) => usageLayerEvals.find((entry) => entry.id === item.id)?.tool_required === true);
  const genericSensitiveCases = results.filter((item) => item.should_fail_if_generic === true);
  const clarifyCases = results.filter((item) => item.actual_success_type === "clarify");
  const firstTurnSuccessCount = results.filter((item) => item.first_turn_success === true).length;
  const wrongRouteCount = results.filter((item) => item.wrong_route === true).length;
  const toolOmissionCount = toolRequiredCases.filter((item) => item.tool_omission === true).length;
  const genericFailCount = genericSensitiveCases.filter((item) => item.generic === true).length;
  const unnecessaryClarificationCount = clarifyCases.filter((item) => item.unnecessary_clarification === true).length;
  const failCases = results
    .map((item) => ({
      ...item,
      fail_reasons: summarizeFailReasons(item),
    }))
    .filter((item) => item.fail_reasons.length > 0)
    .sort((left, right) => right.fail_reasons.length - left.fail_reasons.length)
    .slice(0, 5);
  const failureBreakdown = results.reduce((acc, item) => {
    const key = normalizeText(item.failure_class || "") || "none";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topFailureCategories = Object.entries(failureBreakdown)
    .filter(([key]) => key !== "none")
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([failureClass, count]) => ({ failure_class: failureClass, count }));

  return {
    total,
    metrics: {
      FTHR: toPercent(firstTurnSuccessCount, total),
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
      clarify_cases: clarifyCases.length,
      unnecessary_clarification: unnecessaryClarificationCount,
      reply_discipline_logged_cases: total,
    },
    failure_breakdown: failureBreakdown,
    top_failure_categories: topFailureCategories,
    top_fail_cases: failCases,
  };
}

function printSummary(summary = {}) {
  console.log("=== Usage Layer Eval Summary ===");
  console.log(`Total: ${summary.total}`);
  console.log(`FTHR: ${summary.metrics.FTHR}`);
  console.log(`WRR: ${summary.metrics.WRR}`);
  console.log(`TOR: ${summary.metrics.TOR}`);
  console.log(`GRR: ${summary.metrics.GRR}`);
  console.log(`UCR: ${summary.metrics.UCR}`);
  console.log(`RDR: ${summary.metrics.RDR} (${summary.counts.reply_discipline_logged_cases} cases logged for manual reply-discipline review)`);
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
  console.log("Top 5 fail cases:");
  if (!Array.isArray(summary.top_fail_cases) || summary.top_fail_cases.length === 0) {
    console.log("- none");
    return;
  }
  for (const item of summary.top_fail_cases) {
    console.log(`- ${item.user_text} | ${item.fail_reasons.join("; ")}`);
  }
}

async function main() {
  const results = [];
  for (const testCase of usageLayerEvals) {
    const result = await runUsageLayerEvalCase(testCase);
    results.push(result);
  }
  const summary = summarizeResults(results);
  printSummary(summary);
}

main().catch((error) => {
  console.error("usage-layer runner failed");
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
