import crypto from "node:crypto";

import db from "./db.mjs";
import { registerImprovementWorkflowProposals } from "./executive-improvement-workflow.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { nowIso } from "./text-utils.mjs";

const DEFAULT_LOOKBACK_HOURS = 24 * 7;
const DEFAULT_REQUEST_LIMIT = 200;
const MAX_REQUEST_LIMIT = 2_000;
const DEFAULT_MIN_SAMPLE_SIZE = 3;
const DEFAULT_MAX_ROUTING_ITEMS = 5;
const DEFAULT_MAX_TOOL_ITEMS = 5;
const TRACE_ID_CHUNK_SIZE = 200;
const SAMPLE_TRACE_LIMIT = 5;
const COMMON_ERROR_LIMIT = 3;

const listRequestsForLearningStmt = db.prepare(`
  SELECT
    trace_id,
    request_id,
    method,
    pathname,
    route_name,
    status_code,
    ok,
    error_code,
    error_message,
    duration_ms,
    started_at,
    finished_at
  FROM http_request_monitor
  WHERE finished_at >= ?
  ORDER BY finished_at DESC
  LIMIT ?
`);

function clampInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function toFixedNumber(value, digits = 2) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Number(normalized.toFixed(digits));
}

function toPercent(value) {
  return toFixedNumber(Number(value || 0) * 100, 2);
}

function safeJsonParse(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeBoolean(value) {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return null;
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

function buildSinceIso(lookbackHours) {
  return new Date(Date.now() - (lookbackHours * 60 * 60 * 1000)).toISOString();
}

function toRequestRecord(row = {}) {
  return {
    trace_id: cleanText(row.trace_id) || null,
    request_id: cleanText(row.request_id) || null,
    method: cleanText(row.method) || "GET",
    pathname: cleanText(row.pathname) || "/",
    route_name: cleanText(row.route_name) || null,
    status_code: Number.isFinite(Number(row.status_code)) ? Number(row.status_code) : null,
    ok: normalizeBoolean(row.ok),
    error_code: cleanText(row.error_code) || null,
    error_message: cleanText(row.error_message) || null,
    duration_ms: normalizeDuration(row.duration_ms) ?? 0,
    started_at: cleanText(row.started_at) || null,
    finished_at: cleanText(row.finished_at) || null,
  };
}

function toTraceEventRecord(row = {}) {
  return {
    id: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
    trace_id: cleanText(row.trace_id) || null,
    request_id: cleanText(row.request_id) || null,
    component: cleanText(row.component) || null,
    event: cleanText(row.event) || null,
    level: cleanText(row.level) || null,
    payload: safeJsonParse(row.payload_json),
    created_at: cleanText(row.created_at) || null,
  };
}

function chunk(items = [], chunkSize = TRACE_ID_CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

function listTraceEventsForTraceIds(traceIds = []) {
  const normalizedTraceIds = Array.from(new Set(
    (Array.isArray(traceIds) ? traceIds : [])
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
  if (!normalizedTraceIds.length) {
    return [];
  }

  const rows = [];
  for (const group of chunk(normalizedTraceIds)) {
    const placeholders = group.map(() => "?").join(", ");
    const stmt = db.prepare(`
      SELECT
        id,
        trace_id,
        request_id,
        component,
        event,
        level,
        payload_json,
        created_at
      FROM http_request_trace_events
      WHERE trace_id IN (${placeholders})
      ORDER BY id ASC
    `);
    rows.push(...stmt.all(...group));
  }

  return rows.map(toTraceEventRecord);
}

function pickLatestEvent(events = [], matcher) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (matcher(events[index])) {
      return events[index];
    }
  }
  return null;
}

function computeLatencyStats(samples = []) {
  const latencies = samples
    .map((item) => normalizeDuration(item))
    .filter((item) => item != null)
    .sort((left, right) => left - right);
  if (!latencies.length) {
    return {
      avg_latency_ms: 0,
      p95_latency_ms: 0,
    };
  }
  const avg = latencies.reduce((sum, item) => sum + item, 0) / latencies.length;
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
  return {
    avg_latency_ms: Math.round(avg),
    p95_latency_ms: latencies[p95Index],
  };
}

function summarizeErrors(errorMap = new Map(), limit = COMMON_ERROR_LIMIT) {
  return Array.from(errorMap.entries())
    .map(([error_type, count]) => ({ error_type, count }))
    .sort((left, right) => right.count - left.count || left.error_type.localeCompare(right.error_type))
    .slice(0, limit);
}

function collectErrorType(request = {}, events = []) {
  if (request.error_code) {
    return request.error_code;
  }
  const failureEvent = pickLatestEvent(events, (event) => (
    event?.level === "error"
    || event?.payload?.ok === false
    || cleanText(event?.payload?.error)
    || cleanText(event?.payload?.result?.error)
  ));
  return cleanText(
    failureEvent?.payload?.error
      || failureEvent?.payload?.error_code
      || failureEvent?.payload?.result?.error,
  ) || null;
}

function buildRoutingDescriptor(request = {}, events = []) {
  const laneEvent = pickLatestEvent(events, (event) => (
    event?.event === "lane_execution_planned"
    || event?.event === "lane_selected"
    || event?.event === "lane_resolved"
  ));
  const plannerEvent = pickLatestEvent(events, (event) => (
    event?.event === "planner_tool_select"
    || event?.event === "executive_orchestrator_decision"
    || event?.event === "planner_end_to_end"
  ));

  const chosenLane = cleanText(
    laneEvent?.payload?.chosen_lane
      || laneEvent?.payload?.capability_lane
      || laneEvent?.payload?.lane,
  ) || null;
  const chosenAction = cleanText(
    laneEvent?.payload?.chosen_action
      || plannerEvent?.payload?.chosen_action
      || plannerEvent?.payload?.selected_action
      || plannerEvent?.payload?.action,
  ) || null;
  const selectedAction = cleanText(
    plannerEvent?.payload?.selected_action
      || plannerEvent?.payload?.action,
  ) || null;
  const routeName = cleanText(request.route_name) || cleanText(plannerEvent?.payload?.route) || request.pathname || "/";
  const routingKey = [routeName, chosenLane, chosenAction || selectedAction]
    .filter(Boolean)
    .join(" | ");

  return {
    route_name: routeName,
    chosen_lane: chosenLane,
    chosen_action: chosenAction,
    selected_action: selectedAction,
    routing_key: routingKey || routeName || request.pathname || "/",
  };
}

function incrementCounter(map, key) {
  const normalizedKey = cleanText(key);
  if (!normalizedKey) {
    return;
  }
  map.set(normalizedKey, Number(map.get(normalizedKey) || 0) + 1);
}

function truncateLabel(value = "", max = 80) {
  const text = cleanText(value);
  if (!text || text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function buildRoutingDraftProposal(item, lookbackHours) {
  const topError = item.common_errors[0]?.error_type || "unknown_error";
  return {
    id: crypto.randomUUID(),
    category: "routing_improvement",
    mode: "human_approval",
    title: `Review routing: ${truncateLabel(item.routing_key, 60)}`,
    description: `最近 ${lookbackHours}h 內，routing "${item.routing_key}" 失敗 ${item.failure_count}/${item.sample_count} 次（${item.failure_rate_percent}%），主要錯誤是 ${topError}。建議調整 routing hint、fallback 順序或 hard-route 規則。`,
    target: "lane-executor",
    context: {
      source: "learning_loop",
      learning_kind: "routing",
      routing_key: item.routing_key,
      route_name: item.route_name,
      chosen_lane: item.chosen_lane,
      chosen_action: item.chosen_action,
      selected_action: item.selected_action,
      lookback_hours: lookbackHours,
      sample_count: item.sample_count,
      failure_count: item.failure_count,
      failure_rate: item.failure_rate,
      failure_rate_percent: item.failure_rate_percent,
      avg_latency_ms: item.avg_latency_ms,
      p95_latency_ms: item.p95_latency_ms,
      common_errors: item.common_errors,
      sample_trace_ids: item.sample_trace_ids,
    },
  };
}

function buildToolDraftProposal(item, lookbackHours) {
  const delta = Number(item.suggested_weight_delta || 0);
  if (!delta) {
    return null;
  }
  const direction = delta > 0 ? "increase" : "decrease";
  return {
    id: crypto.randomUUID(),
    category: "tool_weight_adjustment",
    mode: "human_approval",
    title: `${direction === "increase" ? "Increase" : "Decrease"} tool weight: ${item.tool_name}`,
    description: `最近 ${lookbackHours}h 內，tool "${item.tool_name}" 成功 ${item.success_count}/${item.sample_count} 次（${item.success_rate_percent}%），建議人工審核後再將 routing 權重 ${direction} ${Math.abs(delta)}。`,
    target: "executive-planner",
    context: {
      source: "learning_loop",
      learning_kind: "tool_weight",
      tool_name: item.tool_name,
      suggested_weight_delta: delta,
      lookback_hours: lookbackHours,
      sample_count: item.sample_count,
      success_count: item.success_count,
      failure_count: item.failure_count,
      success_rate: item.success_rate,
      success_rate_percent: item.success_rate_percent,
      avg_latency_ms: item.avg_latency_ms,
      p95_latency_ms: item.p95_latency_ms,
      common_errors: item.common_errors,
      sample_trace_ids: item.sample_trace_ids,
    },
  };
}

function buildRequestSummary(requests = []) {
  const total = requests.length;
  const successCount = requests.filter((item) => item.ok === true).length;
  const failureCount = requests.filter((item) => item.ok === false || item.error_code).length;
  const latency = computeLatencyStats(requests.map((item) => item.duration_ms));
  return {
    total_requests: total,
    success_count: successCount,
    failure_count: failureCount,
    success_rate: total > 0 ? successCount / total : 0,
    success_rate_percent: total > 0 ? toPercent(successCount / total) : 0,
    failure_rate: total > 0 ? failureCount / total : 0,
    failure_rate_percent: total > 0 ? toPercent(failureCount / total) : 0,
    ...latency,
  };
}

function buildRoutingInsights(requests = [], traceEventsByTraceId = new Map(), minSampleSize, maxItems) {
  const buckets = new Map();

  for (const request of requests) {
    const events = traceEventsByTraceId.get(request.trace_id) || [];
    const descriptor = buildRoutingDescriptor(request, events);
    const key = descriptor.routing_key;
    if (!key) {
      continue;
    }
    if (!buckets.has(key)) {
      buckets.set(key, {
        routing_key: key,
        route_name: descriptor.route_name,
        chosen_lane: descriptor.chosen_lane,
        chosen_action: descriptor.chosen_action,
        selected_action: descriptor.selected_action,
        sample_count: 0,
        success_count: 0,
        failure_count: 0,
        latencies: [],
        error_counts: new Map(),
        sample_trace_ids: [],
      });
    }
    const bucket = buckets.get(key);
    bucket.sample_count += 1;
    bucket.latencies.push(request.duration_ms);
    if (request.ok === true && !request.error_code) {
      bucket.success_count += 1;
    } else {
      bucket.failure_count += 1;
      incrementCounter(bucket.error_counts, collectErrorType(request, events));
    }
    if (bucket.sample_trace_ids.length < SAMPLE_TRACE_LIMIT && request.trace_id) {
      bucket.sample_trace_ids.push(request.trace_id);
    }
  }

  return Array.from(buckets.values())
    .filter((item) => item.sample_count >= minSampleSize && item.failure_count > 0)
    .map((item) => {
      const failureRate = item.sample_count > 0 ? item.failure_count / item.sample_count : 0;
      return {
        routing_key: item.routing_key,
        route_name: item.route_name,
        chosen_lane: item.chosen_lane,
        chosen_action: item.chosen_action,
        selected_action: item.selected_action,
        sample_count: item.sample_count,
        success_count: item.success_count,
        failure_count: item.failure_count,
        failure_rate: toFixedNumber(failureRate, 4),
        failure_rate_percent: toPercent(failureRate),
        ...computeLatencyStats(item.latencies),
        common_errors: summarizeErrors(item.error_counts),
        sample_trace_ids: item.sample_trace_ids.slice(0, SAMPLE_TRACE_LIMIT),
      };
    })
    .sort((left, right) => (
      right.failure_rate - left.failure_rate
      || right.failure_count - left.failure_count
      || right.sample_count - left.sample_count
      || left.routing_key.localeCompare(right.routing_key)
    ))
    .slice(0, maxItems);
}

function buildToolInsights(events = [], minSampleSize, maxItems) {
  const buckets = new Map();

  for (const event of events) {
    if (event?.event !== "tool_execution") {
      continue;
    }
    const action = cleanText(event?.payload?.action);
    if (!action) {
      continue;
    }
    if (!buckets.has(action)) {
      buckets.set(action, {
        tool_name: action,
        sample_count: 0,
        success_count: 0,
        failure_count: 0,
        latencies: [],
        error_counts: new Map(),
        sample_trace_ids: [],
      });
    }
    const bucket = buckets.get(action);
    const success = event?.payload?.result?.success === true;
    const errorType = cleanText(event?.payload?.result?.error || event?.payload?.error);
    const durationMs = normalizeDuration(event?.payload?.duration_ms);

    bucket.sample_count += 1;
    if (success) {
      bucket.success_count += 1;
    } else {
      bucket.failure_count += 1;
      incrementCounter(bucket.error_counts, errorType || "tool_error");
    }
    if (durationMs != null) {
      bucket.latencies.push(durationMs);
    }
    if (bucket.sample_trace_ids.length < SAMPLE_TRACE_LIMIT && event.trace_id) {
      bucket.sample_trace_ids.push(event.trace_id);
    }
  }

  const normalized = Array.from(buckets.values())
    .filter((item) => item.sample_count >= minSampleSize)
    .map((item) => {
      const successRate = item.sample_count > 0 ? item.success_count / item.sample_count : 0;
      let suggestedWeightDelta = 0;
      if (successRate >= 0.8 && item.success_count >= minSampleSize) {
        suggestedWeightDelta = 0.1;
      } else if (successRate <= 0.4 && item.failure_count >= 2) {
        suggestedWeightDelta = -0.1;
      }

      return {
        tool_name: item.tool_name,
        sample_count: item.sample_count,
        success_count: item.success_count,
        failure_count: item.failure_count,
        success_rate: toFixedNumber(successRate, 4),
        success_rate_percent: toPercent(successRate),
        suggested_weight_delta: suggestedWeightDelta,
        ...computeLatencyStats(item.latencies),
        common_errors: summarizeErrors(item.error_counts),
        sample_trace_ids: item.sample_trace_ids.slice(0, SAMPLE_TRACE_LIMIT),
      };
    });

  const highSuccessTools = normalized
    .filter((item) => item.suggested_weight_delta > 0)
    .sort((left, right) => (
      right.success_rate - left.success_rate
      || right.sample_count - left.sample_count
      || left.tool_name.localeCompare(right.tool_name)
    ))
    .slice(0, maxItems);

  const lowSuccessTools = normalized
    .filter((item) => item.suggested_weight_delta < 0)
    .sort((left, right) => (
      left.success_rate - right.success_rate
      || right.failure_count - left.failure_count
      || right.sample_count - left.sample_count
      || left.tool_name.localeCompare(right.tool_name)
    ))
    .slice(0, maxItems);

  const totalToolExecutions = normalized.reduce((sum, item) => sum + item.sample_count, 0);
  const totalToolSuccess = normalized.reduce((sum, item) => sum + item.success_count, 0);
  const totalToolFailures = normalized.reduce((sum, item) => sum + item.failure_count, 0);

  return {
    totals: {
      total_tool_executions: totalToolExecutions,
      success_count: totalToolSuccess,
      failure_count: totalToolFailures,
      success_rate: totalToolExecutions > 0 ? totalToolSuccess / totalToolExecutions : 0,
      success_rate_percent: totalToolExecutions > 0 ? toPercent(totalToolSuccess / totalToolExecutions) : 0,
    },
    high_success_tools: highSuccessTools,
    low_success_tools: lowSuccessTools,
  };
}

export function buildAgentLearningSummary({
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  requestLimit = DEFAULT_REQUEST_LIMIT,
  minSampleSize = DEFAULT_MIN_SAMPLE_SIZE,
  maxRoutingItems = DEFAULT_MAX_ROUTING_ITEMS,
  maxToolItems = DEFAULT_MAX_TOOL_ITEMS,
} = {}) {
  const normalizedLookbackHours = clampInteger(lookbackHours, DEFAULT_LOOKBACK_HOURS, 24 * 30);
  const normalizedRequestLimit = clampInteger(requestLimit, DEFAULT_REQUEST_LIMIT, MAX_REQUEST_LIMIT);
  const normalizedMinSampleSize = clampInteger(minSampleSize, DEFAULT_MIN_SAMPLE_SIZE, 50);
  const normalizedMaxRoutingItems = clampInteger(maxRoutingItems, DEFAULT_MAX_ROUTING_ITEMS, 20);
  const normalizedMaxToolItems = clampInteger(maxToolItems, DEFAULT_MAX_TOOL_ITEMS, 20);
  const sinceIso = buildSinceIso(normalizedLookbackHours);

  const requests = listRequestsForLearningStmt
    .all(sinceIso, normalizedRequestLimit)
    .map(toRequestRecord);
  const traceEvents = listTraceEventsForTraceIds(requests.map((item) => item.trace_id));
  const traceEventsByTraceId = new Map();
  for (const event of traceEvents) {
    if (!traceEventsByTraceId.has(event.trace_id)) {
      traceEventsByTraceId.set(event.trace_id, []);
    }
    traceEventsByTraceId.get(event.trace_id).push(event);
  }

  const requestSummary = buildRequestSummary(requests);
  const routingIssues = buildRoutingInsights(
    requests,
    traceEventsByTraceId,
    normalizedMinSampleSize,
    normalizedMaxRoutingItems,
  );
  const toolInsights = buildToolInsights(
    traceEvents,
    normalizedMinSampleSize,
    normalizedMaxToolItems,
  );
  const draftProposals = [
    ...routingIssues
      .filter((item) => item.failure_rate >= 0.4 && item.failure_count >= 2)
      .map((item) => buildRoutingDraftProposal(item, normalizedLookbackHours)),
    ...toolInsights.high_success_tools
      .map((item) => buildToolDraftProposal(item, normalizedLookbackHours))
      .filter(Boolean),
    ...toolInsights.low_success_tools
      .map((item) => buildToolDraftProposal(item, normalizedLookbackHours))
      .filter(Boolean),
  ];

  return {
    generated_at: nowIso(),
    lookback_hours: normalizedLookbackHours,
    request_limit: normalizedRequestLimit,
    min_sample_size: normalizedMinSampleSize,
    sampled_requests: requests.length,
    sampled_traces: traceEventsByTraceId.size,
    request_metrics: requestSummary,
    routing_issues: routingIssues,
    tool_metrics: toolInsights.totals,
    high_success_tools: toolInsights.high_success_tools,
    low_success_tools: toolInsights.low_success_tools,
    draft_proposals: draftProposals,
  };
}

export async function generateLearningLoopImprovementProposals({
  accountId = "",
  sessionKey = "",
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  requestLimit = DEFAULT_REQUEST_LIMIT,
  minSampleSize = DEFAULT_MIN_SAMPLE_SIZE,
  maxRoutingItems = DEFAULT_MAX_ROUTING_ITEMS,
  maxToolItems = DEFAULT_MAX_TOOL_ITEMS,
} = {}) {
  const summary = buildAgentLearningSummary({
    lookbackHours,
    requestLimit,
    minSampleSize,
    maxRoutingItems,
    maxToolItems,
  });

  const proposals = await registerImprovementWorkflowProposals({
    accountId,
    sessionKey,
    reflection: {
      error_type: "learning_loop",
    },
    proposals: summary.draft_proposals,
  });

  return {
    summary,
    proposals,
  };
}
