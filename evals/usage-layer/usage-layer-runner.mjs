import { usageLayerEvals } from "./usage-layer-evals.mjs";
import { runPlannerUserInputEdge } from "../../src/planner-user-input-edge.mjs";
import { renderUserResponseText } from "../../src/user-response-normalizer.mjs";
import { resolveRoutingEvalCase } from "../../src/routing-eval.mjs";
import { cleanText } from "../../src/message-intent-utils.mjs";

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

function classifyReplyMode({ userResponse = {}, route = {}, replyText = "" } = {}) {
  if (userResponse?.ok !== true) {
    return isClarificationReply(replyText) ? "clarify" : "fail_soft";
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
  const { plannerEnvelope, userResponse } = await runPlannerUserInputEdge({
    text: testCase.user_text,
    logger: noopLogger,
    signal,
    sessionKey: `usage-layer-eval:${testCase.id}`,
    requestId: `usage-layer-eval:${testCase.id}`,
  });
  const replyText = renderUserResponseText(userResponse);
  const replyMode = classifyReplyMode({ userResponse, route, replyText });
  const actualSuccessType = classifySuccessType(replyMode);
  const generic = looksGenericReply({
    replyText,
    requestText: testCase.user_text,
  });
  const unnecessaryClarification = actualSuccessType === "clarify"
    && !requestLikelyNeedsClarification(testCase.user_text);
  const executedTarget = inferExecutedTarget({
    envelope: plannerEnvelope,
    route,
  });
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
