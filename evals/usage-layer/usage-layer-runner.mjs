import { pathToFileURL } from "node:url";
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
import { executeRegisteredAgent } from "../../src/agent-dispatcher.mjs";
import { parseRegisteredAgentCommand } from "../../src/agent-registry.mjs";

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
    };
  }

  const agentResult = await executeRegisteredAgent({
    accountId: "usage-layer-eval",
    agent: command.agent,
    requestText: command.body || testCase.user_text,
    scope: { session_key: `usage-layer-eval:${testCase.id}` },
    searchFn() {
      return {
        items: [
          buildUsageEvalSourceItem(
            `${command.agent.label} Eval Context`,
            `https://usage-layer.eval/${command.agent.id}`,
            `這是 ${command.agent.label} 對「${command.body || testCase.user_text}」的受控 usage-layer 測試上下文。`,
          ),
        ],
      };
    },
    async textGenerator() {
      return buildRegisteredAgentEvalText({
        slash: command.agent.slash,
        agentLabel: command.agent.label,
        body: command.body || testCase.user_text,
      });
    },
    logger: noopLogger,
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
    replyText: normalizeText(agentResult?.text || ""),
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

async function runExecutiveEvalCase(testCase = {}, route = {}) {
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
  };
}

function summarizeFailReasons(result = {}) {
  const reasons = [];
  if (result.timed_out === true) {
    reasons.push(`case_timeout(${result.duration_ms}ms)`);
  }
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

export async function runUsageLayerEvalCase(testCase = {}, {
  timeoutMs = DEFAULT_USAGE_LAYER_EVAL_CASE_TIMEOUT_MS,
  signal = null,
} = {}) {
  const route = resolveRoutingEvalCase(normalizeEvalCase(testCase));
  const startedAt = Date.now();
  const caseSignal = signal || createEvalCaseSignal(timeoutMs);
  let execution;
  try {
    if (normalizeText(route?.lane || "") === "cloud_doc_workflow") {
      execution = await runCloudDocWorkflowEvalCase(testCase, route, { signal: caseSignal });
    } else if (normalizeText(route?.lane || "") === "meeting_workflow") {
      execution = await runMeetingWorkflowEvalCase(testCase, route);
    } else if (normalizeText(route?.lane || "") === "doc_editor") {
      execution = await runDocEditorEvalCase(testCase, route);
    } else if (normalizeText(route?.lane || "") === "executive") {
      execution = await runExecutiveEvalCase(testCase, route);
    } else if (
      normalizeText(route?.lane || "") === "registered_agent"
      && normalizeText(route?.planner_action || "") === "dispatch_registered_agent"
    ) {
      execution = await runRegisteredAgentEvalCase(testCase, route);
    } else if (
      normalizeText(route?.planner_action || "") === "ROUTING_NO_MATCH"
      || normalizeText(route?.agent_or_tool || "") === "error:ROUTING_NO_MATCH"
    ) {
      execution = await runRoutingNoMatchEvalCase(testCase, route);
    } else {
      execution = await runPlannerUserInputEdge({
        text: testCase.user_text,
        logger: noopLogger,
        signal: caseSignal,
        sessionKey: `usage-layer-eval:${testCase.id}`,
        requestId: `usage-layer-eval:${testCase.id}`,
      });
    }
  } catch (error) {
    if (caseSignal?.aborted || isAbortLikeError(error)) {
      execution = buildEvalTimeoutExecution({
        route,
        timeoutMs,
      });
    } else {
      throw error;
    }
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
  const durationMs = Date.now() - startedAt;
  const timedOut = normalizeText(plannerEnvelope?.error || "") === "case_timeout";

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
    timed_out: timedOut,
    duration_ms: durationMs,
  };
}

export function summarizeResults(results = []) {
  const total = results.length;
  const toolRequiredCases = results.filter((item) => usageLayerEvals.find((entry) => entry.id === item.id)?.tool_required === true);
  const genericSensitiveCases = results.filter((item) => item.should_fail_if_generic === true);
  const clarifyCases = results.filter((item) => item.actual_success_type === "clarify");
  const firstTurnSuccessCount = results.filter((item) => item.first_turn_success === true).length;
  const wrongRouteCount = results.filter((item) => item.wrong_route === true).length;
  const toolOmissionCount = toolRequiredCases.filter((item) => item.tool_omission === true).length;
  const genericFailCount = genericSensitiveCases.filter((item) => item.generic === true).length;
  const unnecessaryClarificationCount = clarifyCases.filter((item) => item.unnecessary_clarification === true).length;
  const timedOutCases = results.filter((item) => item.timed_out === true);
  const timeoutCount = timedOutCases.length;
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
      timed_out: timeoutCount,
      reply_discipline_logged_cases: total,
    },
    failure_breakdown: failureBreakdown,
    top_failure_categories: topFailureCategories,
    top_fail_cases: failCases,
    timed_out_cases: timedOutCases.map((item) => ({
      id: item.id,
      user_text: item.user_text,
      duration_ms: item.duration_ms,
    })),
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
  console.log(`Timeouts: ${summary.counts.timed_out}`);
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
  console.log("Timed out cases:");
  if (!Array.isArray(summary.timed_out_cases) || summary.timed_out_cases.length === 0) {
    console.log("- none");
  } else {
    for (const item of summary.timed_out_cases) {
      console.log(`- ${item.id} | ${item.duration_ms}ms | ${item.user_text}`);
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
  const startedAt = Date.now();
  const results = [];
  for (const testCase of usageLayerEvals) {
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
  printSummary(summary);
  console.log("");
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
