import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { resolveCapabilityLane, buildLaneFailureReply } from "./capability-lane.mjs";
import {
  looksLikeMeetingCaptureStatusQuery,
  resolveLaneExecutionPlan,
} from "./lane-executor.mjs";
import { parseMeetingCommand } from "./meeting-agent.mjs";
import {
  CLOUD_DOC_ORGANIZATION_MODE,
  resolveCloudOrganizationAction,
} from "./cloud-doc-organization-workflow.mjs";
import { parseRegisteredAgentCommand } from "./agent-registry.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  looksLikeExecutiveStart,
  selectPlannerTool,
  shouldPreferSelectorAction,
} from "./executive-planner.mjs";
import { resolvePlannerFlowRoute } from "./planner-flow-runtime.mjs";
import {
  hydratePlannerDocQueryRuntimeContext,
  resetPlannerDocQueryRuntimeContext,
} from "./planner-doc-query-flow.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { plannerDocQueryFlow } from "./planner-doc-query-flow.mjs";
import { plannerRuntimeInfoFlow } from "./planner-runtime-info-flow.mjs";
import { plannerOkrFlow } from "./planner-okr-flow.mjs";
import { plannerBdFlow } from "./planner-bd-flow.mjs";
import { plannerDeliveryFlow } from "./planner-delivery-flow.mjs";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

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

const plannerPresets = new Set([
  "create_and_list_doc",
  "create_search_detail_list_doc",
]);

export const ROUTING_EVAL_MIN_ACCURACY_RATIO = 0.9;

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeLaneName(lane = "") {
  const normalized = cleanText(lane);
  if (!normalized) {
    return "personal_assistant";
  }
  return normalized.replace(/-/g, "_");
}

function normalizePlannerAction(action = "") {
  return cleanText(action) || null;
}

function normalizeAgentOrTool(value = "") {
  return cleanText(value) || null;
}

function percentile(values = [], ratio = 0.95) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function countMatches(items = [], predicate) {
  return items.reduce((count, item) => (predicate(item) ? count + 1 : count), 0);
}

function buildBucketAccuracy(results = [], selector = () => "", matchKey = "overall") {
  const buckets = new Map();

  for (const item of Array.isArray(results) ? results : []) {
    const bucketKey = cleanText(selector(item)) || "unknown";
    const metric = buckets.get(bucketKey) || { hits: 0, total: 0 };
    metric.total += 1;
    if (item?.matches?.[matchKey] === true) {
      metric.hits += 1;
    }
    buckets.set(bucketKey, metric);
  }

  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([bucketKey, metric]) => {
        const accuracyRatio = metric.total > 0 ? Number((metric.hits / metric.total).toFixed(4)) : 0;
        return [
          bucketKey,
          {
            hits: metric.hits,
            total: metric.total,
            accuracy_ratio: accuracyRatio,
            accuracy: Number((accuracyRatio * 100).toFixed(2)),
          },
        ];
      }),
  );
}

function buildEvalEvent(testCase = {}) {
  const text = cleanText(testCase.text);
  const scope = testCase.scope && typeof testCase.scope === "object" && !Array.isArray(testCase.scope)
    ? { ...testCase.scope }
    : {};
  const messagePayload = testCase.message && typeof testCase.message === "object" && !Array.isArray(testCase.message)
    ? { ...testCase.message }
    : {};

  if (!cleanText(messagePayload.text)) {
    messagePayload.text = text;
  }

  return {
    text,
    message: {
      chat_id: cleanText(scope.chat_id) || `chat-${cleanText(testCase.id) || "eval"}`,
      msg_type: cleanText(messagePayload.msg_type) || "text",
      content: JSON.stringify(messagePayload),
      parent_id: cleanText(scope.parent_id) || "",
      root_id: cleanText(scope.root_id) || "",
    },
  };
}

function inferDocEditorAction(text = "") {
  return /評論|评论|改稿|rewrite|修改/.test(text)
    ? {
        planner_action: "comment_rewrite_preview",
        agent_or_tool: "tool:lark_doc_rewrite_from_comments",
      }
    : {
        planner_action: "document_read",
        agent_or_tool: "tool:lark_doc_read",
      };
}

function inferLaneToolForAction(action = "", lane = "") {
  if (action === "calendar_summary") {
    return "tool:lark_calendar_primary";
  }
  if (action === "tasks_summary") {
    return "tool:lark_tasks_list";
  }
  if (action === "summarize_recent_dialogue") {
    return "tool:lark_messages_list";
  }
  if (action === "draft_group_reply") {
    return lane === "group_shared_assistant"
      ? "tool:lark_message_reply_card"
      : "tool:lark_messages_list";
  }
  if (action === "bitable_preview") {
    return "tool:bitable_read";
  }
  if (action === ROUTING_NO_MATCH) {
    return `error:${ROUTING_NO_MATCH}`;
  }
  return action ? "reply:default" : null;
}

function normalizeScope(scope = {}) {
  return {
    chat_type: cleanText(scope?.chat_type) === "group" ? "group" : "p2p",
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

function resolveExecutiveFallback(text = "", activeTask = null) {
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

function resolvePlannerDecision(text = "", plannerContext = {}) {
  resetPlannerDocQueryRuntimeContext();
  hydratePlannerDocQueryRuntimeContext({
    activeDoc: plannerContext?.active_doc || null,
    activeCandidates: plannerContext?.active_candidates || [],
    activeTheme: plannerContext?.active_theme || null,
  });

  const routedFlow = resolvePlannerFlowRoute({
    flows: plannerFlows,
    userIntent: text,
    payload: plannerContext?.payload || {},
    logger: noopLogger,
  });
  const selector = selectPlannerTool({
    userIntent: text,
    taskType: plannerContext?.task_type || "",
    logger: noopLogger,
  });
  const prefersSelector = shouldPreferSelectorAction({
    hardRoutedAction: routedFlow?.action,
    selectorAction: selector?.selected_action,
  });
  const action = normalizePlannerAction(
    (prefersSelector ? selector?.selected_action : routedFlow?.action)
    || selector?.selected_action
    || "",
  );

  return {
    planner_action: action || ROUTING_NO_MATCH,
    agent_or_tool: action
      ? plannerPresets.has(action)
        ? `preset:${action}`
        : `tool:${action}`
      : `error:${ROUTING_NO_MATCH}`,
    source: prefersSelector
      ? "planner_selector_override"
      : normalizePlannerAction(routedFlow?.action)
        ? "planner_flow"
        : normalizePlannerAction(selector?.selected_action)
          ? "planner_selector"
          : "routing_no_match",
  };
}

function resolveCapabilityRoute(testCase = {}) {
  const event = buildEvalEvent(testCase);
  const lane = resolveCapabilityLane(normalizeScope(testCase.scope), event);
  const normalizedLane = normalizeLaneName(lane?.capability_lane);

  if (normalizedLane === "knowledge_assistant") {
    const plannerDecision = resolvePlannerDecision(cleanText(testCase.text), testCase.context?.planner || {});
    return {
      lane: normalizedLane,
      planner_action: plannerDecision.planner_action,
      agent_or_tool: plannerDecision.agent_or_tool,
      route_source: plannerDecision.source,
    };
  }

  if (normalizedLane === "doc_editor") {
    return {
      lane: normalizedLane,
      ...inferDocEditorAction(cleanText(testCase.text)),
      route_source: "doc_editor_lane",
    };
  }

  const lanePlan = resolveLaneExecutionPlan({
    event,
    scope: {
      capability_lane: lane?.capability_lane,
    },
  });
  const plannerAction = normalizePlannerAction(lanePlan?.chosen_action);

  if (!plannerAction && normalizeLaneName(lanePlan?.fallback_reason || "") === "semantic_mismatch_document_request_in_personal_lane") {
    return {
      lane: normalizedLane,
      planner_action: "semantic_mismatch",
      agent_or_tool: null,
      route_source: "lane_semantic_mismatch",
    };
  }

  return {
    lane: normalizedLane,
    planner_action: plannerAction || ROUTING_NO_MATCH,
    agent_or_tool: inferLaneToolForAction(plannerAction || ROUTING_NO_MATCH, normalizedLane),
    route_source: "lane_execution_plan",
  };
}

export function resolveRoutingEvalCase(testCase = {}) {
  const text = cleanText(testCase.text);
  const activeWorkflowMode = cleanText(testCase?.context?.active_workflow_mode || "");
  const activeExecutiveTask = testCase?.context?.active_executive_task || null;

  if (Boolean(testCase?.context?.meeting_capture_active) && looksLikeMeetingCaptureStatusQuery(text)) {
    return {
      lane: "meeting_workflow",
      planner_action: "capture_status",
      agent_or_tool: "workflow:meeting_agent",
      route_source: "meeting_capture_status",
    };
  }

  const meetingCommand = parseMeetingCommand(text);
  if (meetingCommand) {
    return {
      lane: "meeting_workflow",
      planner_action: normalizePlannerAction(meetingCommand.action),
      agent_or_tool: "workflow:meeting_agent",
      route_source: "meeting_command",
    };
  }

  const cloudAction = resolveCloudOrganizationAction({
    text,
    activeWorkflowMode: activeWorkflowMode || null,
  });
  if (cloudAction && cloudAction !== "none") {
    return {
      lane: "cloud_doc_workflow",
      planner_action: normalizePlannerAction(cloudAction),
      agent_or_tool: "workflow:cloud_doc_organization",
      route_source: activeWorkflowMode === CLOUD_DOC_ORGANIZATION_MODE ? "cloud_doc_follow_up" : "cloud_doc_entry",
    };
  }

  const registeredAgent = parseRegisteredAgentCommand(text);
  if (registeredAgent?.error === ROUTING_NO_MATCH) {
    return {
      lane: "registered_agent",
      planner_action: ROUTING_NO_MATCH,
      agent_or_tool: `error:${ROUTING_NO_MATCH}`,
      route_source: "slash_agent_no_match",
    };
  }
  if (registeredAgent?.agent?.id) {
    return {
      lane: "registered_agent",
      planner_action: "dispatch_registered_agent",
      agent_or_tool: `agent:${registeredAgent.agent.id}`,
      route_source: "slash_agent_command",
    };
  }

  if (looksLikeExecutiveStart(text) || activeExecutiveTask) {
    const decision = resolveExecutiveFallback(text, activeExecutiveTask);
    return {
      lane: "executive",
      planner_action: normalizePlannerAction(decision.action),
      agent_or_tool: `agent:${cleanText(decision.next_agent_id) || "generalist"}`,
      route_source: "executive_fallback_heuristic",
    };
  }

  return resolveCapabilityRoute(testCase);
}

function compareExpected(actual = {}, expected = {}) {
  const laneHit = cleanText(actual.lane) === cleanText(expected.lane);
  const plannerHit = cleanText(actual.planner_action) === cleanText(expected.planner_action);
  const agentToolHit = cleanText(actual.agent_or_tool) === cleanText(expected.agent_or_tool);
  return {
    lane: laneHit,
    planner_action: plannerHit,
    agent_or_tool: agentToolHit,
    overall: laneHit && plannerHit && agentToolHit,
  };
}

export function evaluateRoutingCase(testCase = {}) {
  const startedAt = performance.now();
  const actual = resolveRoutingEvalCase(testCase);
  const latencyMs = Number((performance.now() - startedAt).toFixed(3));
  const matches = compareExpected(actual, testCase.expected || {});
  const missDimensions = ["lane", "planner_action", "agent_or_tool"].filter((key) => matches[key] === false);

  return {
    id: cleanText(testCase.id),
    category: cleanText(testCase.category),
    name: cleanText(testCase.name || "") || null,
    text: cleanText(testCase.text),
    expected: {
      lane: normalizeLaneName(testCase?.expected?.lane),
      planner_action: normalizePlannerAction(testCase?.expected?.planner_action),
      agent_or_tool: normalizeAgentOrTool(testCase?.expected?.agent_or_tool),
    },
    actual: {
      lane: normalizeLaneName(actual.lane),
      planner_action: normalizePlannerAction(actual.planner_action),
      agent_or_tool: normalizeAgentOrTool(actual.agent_or_tool),
      route_source: cleanText(actual.route_source) || null,
    },
    matches,
    miss_dimensions: missDimensions,
    latency_ms: latencyMs,
  };
}

export function summarizeRoutingEval(results = []) {
  const total = Array.isArray(results) ? results.length : 0;
  const latencies = results.map((item) => Number(item.latency_ms || 0));
  const misses = results
    .filter((item) => item.matches?.overall === false)
    .sort((left, right) => (
      right.miss_dimensions.length - left.miss_dimensions.length
      || Number(right.latency_ms || 0) - Number(left.latency_ms || 0)
    ));

  function buildMetric(key) {
    const hits = countMatches(results, (item) => item.matches?.[key] === true);
    const accuracyRatio = total > 0 ? Number((hits / total).toFixed(4)) : 0;
    return {
      hits,
      total,
      accuracy_ratio: accuracyRatio,
      accuracy: Number((accuracyRatio * 100).toFixed(2)),
    };
  }

  return {
    total_cases: total,
    overall: buildMetric("overall"),
    lane_accuracy: buildMetric("lane"),
    planner_accuracy: buildMetric("planner_action"),
    agent_tool_accuracy: buildMetric("agent_or_tool"),
    by_lane_accuracy: buildBucketAccuracy(results, (item) => item?.expected?.lane, "overall"),
    by_action_accuracy: buildBucketAccuracy(results, (item) => item?.expected?.planner_action, "overall"),
    latency_ms: {
      avg: total > 0 ? Number((latencies.reduce((sum, value) => sum + value, 0) / total).toFixed(3)) : 0,
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
      max: total > 0 ? Number(Math.max(...latencies).toFixed(3)) : 0,
    },
    top_miss_cases: misses.slice(0, 10),
    miss_count: misses.length,
  };
}

export async function loadRoutingEvalSet(source = new URL("../evals/routing-eval-set.mjs", import.meta.url)) {
  const moduleUrl = typeof source === "string" ? pathToFileURL(source).href : source.href;
  const loaded = await import(moduleUrl);
  return Array.isArray(loaded.routingEvalSet) ? loaded.routingEvalSet : [];
}

export function validateRoutingEvalSet(testCases = []) {
  const issues = [];
  if (!Array.isArray(testCases)) {
    return ["routing eval set must be an array"];
  }

  if (testCases.length < 50 || testCases.length > 100) {
    issues.push(`routing eval set must contain 50~100 cases, got ${testCases.length}`);
  }

  const seen = new Set();
  for (const testCase of testCases) {
    const id = cleanText(testCase?.id);
    if (!id) {
      issues.push("routing eval case is missing id");
      continue;
    }
    if (seen.has(id)) {
      issues.push(`duplicate routing eval case id: ${id}`);
    }
    seen.add(id);
    if (!cleanText(testCase?.category)) {
      issues.push(`routing eval case ${id} is missing category`);
    }
    if (!cleanText(testCase?.text)) {
      issues.push(`routing eval case ${id} is missing text`);
    }
    if (!cleanText(testCase?.expected?.lane)) {
      issues.push(`routing eval case ${id} is missing expected.lane`);
    }
    if (!cleanText(testCase?.expected?.planner_action)) {
      issues.push(`routing eval case ${id} is missing expected.planner_action`);
    }
    if (!cleanText(testCase?.expected?.agent_or_tool)) {
      issues.push(`routing eval case ${id} is missing expected.agent_or_tool`);
    }
  }

  return issues;
}

export async function runRoutingEval({ testCases = null } = {}) {
  const cases = Array.isArray(testCases) ? testCases : await loadRoutingEvalSet();
  const validationIssues = validateRoutingEvalSet(cases);
  if (validationIssues.length > 0) {
    return {
      ok: false,
      threshold: {
        metric: "overall_accuracy_ratio",
        min_accuracy_ratio: ROUTING_EVAL_MIN_ACCURACY_RATIO,
      },
      validation_issues: validationIssues,
      results: [],
      summary: summarizeRoutingEval([]),
    };
  }

  const results = cases.map((testCase) => evaluateRoutingCase(testCase));
  const summary = summarizeRoutingEval(results);
  return {
    ok: summary.overall.accuracy_ratio >= ROUTING_EVAL_MIN_ACCURACY_RATIO,
    threshold: {
      metric: "overall_accuracy_ratio",
      min_accuracy_ratio: ROUTING_EVAL_MIN_ACCURACY_RATIO,
    },
    validation_issues: [],
    results,
    summary,
  };
}

export function formatRoutingEvalReport(run = {}) {
  const summary = run?.summary || summarizeRoutingEval([]);
  const minAccuracyRatio = Number(
    run?.threshold?.min_accuracy_ratio ?? ROUTING_EVAL_MIN_ACCURACY_RATIO,
  );
  const minAccuracyPercent = Number((minAccuracyRatio * 100).toFixed(2));
  const byLaneEntries = Object.entries(summary.by_lane_accuracy || {});
  const byActionEntries = Object.entries(summary.by_action_accuracy || {});
  const lines = [
    "Routing Eval",
    `Cases: ${summary.total_cases}`,
    `Gate: overall accuracy >= ${minAccuracyPercent}% (${minAccuracyRatio})`,
    `Overall accuracy: ${summary.overall.accuracy}% (${summary.overall.hits}/${summary.overall.total})`,
    `Lane accuracy: ${summary.lane_accuracy.accuracy}% (${summary.lane_accuracy.hits}/${summary.lane_accuracy.total})`,
    `Planner accuracy: ${summary.planner_accuracy.accuracy}% (${summary.planner_accuracy.hits}/${summary.planner_accuracy.total})`,
    `Agent/tool accuracy: ${summary.agent_tool_accuracy.accuracy}% (${summary.agent_tool_accuracy.hits}/${summary.agent_tool_accuracy.total})`,
    `Latency: avg ${summary.latency_ms.avg} ms | p95 ${summary.latency_ms.p95} ms | max ${summary.latency_ms.max} ms`,
    `Gate result: ${run?.ok ? "pass" : "fail"}`,
    "",
    "By lane accuracy",
  ];

  if (byLaneEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [lane, metric] of byLaneEntries) {
      lines.push(`- ${lane}: ${metric.accuracy}% (${metric.hits}/${metric.total})`);
    }
  }

  lines.push("");
  lines.push("By action accuracy");

  if (byActionEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [action, metric] of byActionEntries) {
      lines.push(`- ${action}: ${metric.accuracy}% (${metric.hits}/${metric.total})`);
    }
  }

  lines.push("");
  lines.push(
    "Top miss cases",
  );

  if (!Array.isArray(summary.top_miss_cases) || summary.top_miss_cases.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }

  for (const miss of summary.top_miss_cases) {
    const mismatchDetail = miss.miss_dimensions
      .map((key) => `${key}: expected=${miss.expected?.[key] || "-"} actual=${miss.actual?.[key] || "-"}`)
      .join(" | ");
    lines.push(`- ${miss.id} [${miss.category}] ${mismatchDetail}`);
  }

  return lines.join("\n");
}

export {
  CLOUD_DOC_ORGANIZATION_MODE,
  buildLaneFailureReply,
};
