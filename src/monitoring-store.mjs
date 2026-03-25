import db from "./db.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_ERROR_LIMIT = 10;
const DEFAULT_DASHBOARD_RECENT_LIMIT = 10;
const DEFAULT_DASHBOARD_ERROR_LIMIT = 10;
const DEFAULT_TRACE_EVENT_LIMIT = 500;
const MAX_LIMIT = 200;
const MAX_TRACE_EVENT_LIMIT = 1_000;
const MAX_TRACE_DEPTH = 5;
const MAX_TRACE_ARRAY_ITEMS = 10;
const MAX_TRACE_OBJECT_KEYS = 30;
const MAX_TRACE_STRING_LENGTH = 600;
const REDACTED_VALUE = "[REDACTED]";
const sensitiveExactKeys = new Set([
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "password",
  "secret",
  "client_secret",
  "app_secret",
  "code",
  "token",
]);

const upsertRequestStmt = db.prepare(`
  INSERT INTO http_request_monitor (
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
  ) VALUES (
    @trace_id,
    @request_id,
    @method,
    @pathname,
    @route_name,
    @status_code,
    @ok,
    @error_code,
    @error_message,
    @duration_ms,
    @started_at,
    @finished_at
  )
  ON CONFLICT(trace_id) DO UPDATE SET
    request_id = excluded.request_id,
    method = excluded.method,
    pathname = excluded.pathname,
    route_name = excluded.route_name,
    status_code = excluded.status_code,
    ok = excluded.ok,
    error_code = excluded.error_code,
    error_message = excluded.error_message,
    duration_ms = excluded.duration_ms,
    started_at = excluded.started_at,
    finished_at = excluded.finished_at
`);

const listRecentRequestsStmt = db.prepare(`
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
  ORDER BY finished_at DESC, rowid DESC, trace_id DESC
  LIMIT ?
`);

const listRecentErrorsStmt = db.prepare(`
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
  WHERE error_code IS NOT NULL OR COALESCE(status_code, 0) >= 400
  ORDER BY finished_at DESC, rowid DESC, trace_id DESC
  LIMIT ?
`);

const metricsStmt = db.prepare(`
  SELECT
    COUNT(*) AS total_requests,
    SUM(CASE WHEN error_code IS NULL AND COALESCE(status_code, 0) < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN error_code IS NOT NULL OR COALESCE(status_code, 0) >= 400 THEN 1 ELSE 0 END) AS error_count
  FROM http_request_monitor
`);

const insertTraceEventStmt = db.prepare(`
  INSERT INTO http_request_trace_events (
    trace_id,
    request_id,
    component,
    event,
    level,
    payload_json,
    created_at
  ) VALUES (
    @trace_id,
    @request_id,
    @component,
    @event,
    @level,
    @payload_json,
    @created_at
  )
`);

const getRequestByTraceIdStmt = db.prepare(`
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
  WHERE trace_id = ?
  LIMIT 1
`);

const listTraceEventsStmt = db.prepare(`
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
  WHERE trace_id = ?
  ORDER BY id ASC
  LIMIT ?
`);

function clampLimit(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeStatusCode(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBooleanToInt(value) {
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return null;
}

function normalizeMessage(value) {
  return normalizeText(value) || null;
}

function isClosedDbError(error) {
  return /database connection is not open/i.test(String(error?.message || ""));
}

function safeJsonParse(value) {
  if (!normalizeText(value)) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return sensitiveExactKeys.has(normalized)
    || normalized.endsWith("_token")
    || normalized.endsWith("_secret")
    || normalized.endsWith("_password")
    || normalized.endsWith("_cookie")
    || normalized.endsWith("_authorization");
}

function truncateString(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_TRACE_STRING_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_TRACE_STRING_LENGTH - 1)}…`;
}

export function sanitizeTracePayload(value, depth = 0, keyName = "") {
  if (value == null) {
    return value;
  }
  if (isSensitiveKey(keyName)) {
    return REDACTED_VALUE;
  }
  if (depth >= MAX_TRACE_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_TRACE_ARRAY_ITEMS).map((item) => sanitizeTracePayload(item, depth + 1, keyName));
  }
  if (value instanceof Error) {
    return {
      name: truncateString(value.name || "Error"),
      message: truncateString(value.message || "unknown_error"),
    };
  }
  if (typeof value === "object") {
    const output = {};
    const entries = Object.entries(value).slice(0, MAX_TRACE_OBJECT_KEYS);
    for (const [entryKey, entryValue] of entries) {
      output[entryKey] = sanitizeTracePayload(entryValue, depth + 1, entryKey);
    }
    return output;
  }
  return truncateString(value);
}

function toRow(record = {}) {
  return {
    trace_id: normalizeText(record.trace_id) || null,
    request_id: normalizeText(record.request_id) || null,
    method: normalizeText(record.method) || "GET",
    pathname: normalizeText(record.pathname) || "/",
    route_name: normalizeText(record.route_name) || null,
    status_code: normalizeStatusCode(record.status_code),
    ok: normalizeBooleanToInt(record.ok),
    error_code: normalizeText(record.error_code) || null,
    error_message: normalizeMessage(record.error_message),
    duration_ms: Math.max(0, Number.parseInt(String(record.duration_ms || "0"), 10) || 0),
    started_at: normalizeText(record.started_at) || nowIso(),
    finished_at: normalizeText(record.finished_at) || nowIso(),
  };
}

function toRequestRecord(row = {}) {
  return {
    trace_id: row.trace_id || null,
    request_id: row.request_id || null,
    method: row.method || null,
    pathname: row.pathname || null,
    route_name: row.route_name || null,
    status_code: Number.isFinite(row.status_code) ? row.status_code : null,
    ok: row.ok == null ? null : Boolean(row.ok),
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    duration_ms: Number.isFinite(row.duration_ms) ? row.duration_ms : 0,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
  };
}

function toTraceEventRow(record = {}) {
  const payload = sanitizeTracePayload(record.payload ?? null);
  return {
    trace_id: normalizeText(record.trace_id) || null,
    request_id: normalizeText(record.request_id) || null,
    component: normalizeText(record.component) || null,
    event: normalizeText(record.event) || null,
    level: normalizeText(record.level) || "info",
    payload_json: payload == null ? null : JSON.stringify(payload),
    created_at: normalizeText(record.created_at) || nowIso(),
  };
}

function toTraceEventRecord(row = {}) {
  return {
    id: Number.isFinite(row.id) ? row.id : null,
    trace_id: row.trace_id || null,
    request_id: row.request_id || null,
    component: row.component || null,
    event: row.event || null,
    level: row.level || null,
    payload: safeJsonParse(row.payload_json),
    created_at: row.created_at || null,
  };
}

function clampTraceEventLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TRACE_EVENT_LIMIT;
  }
  return Math.min(parsed, MAX_TRACE_EVENT_LIMIT);
}

function pickLatestEvent(events = [], matcher) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (matcher(event)) {
      return event;
    }
  }
  return null;
}

function derivePlannerDecision(events = []) {
  return pickLatestEvent(events, (event) => (
    event?.event === "executive_orchestrator_decision"
    || event?.event === "planner_end_to_end"
    || event?.event === "planner_tool_select"
  ));
}

function deriveLaneAction(events = []) {
  return pickLatestEvent(events, (event) => (
    event?.event === "lane_execution_planned"
    || event?.event === "lane_selected"
    || event?.event === "lane_resolved"
    || event?.event === "lane_execution_result"
  ));
}

function deriveRequestInput(events = []) {
  return events.find((event) => event?.event === "request_input") || null;
}

function hasErrorSignal(event = {}) {
  const payload = event?.payload || {};
  const payloadError = normalizeText(payload?.error || "") || null;
  return event?.level === "error"
    || payload?.ok === false
    || payloadError != null
    || /(?:failed|stopped)$/i.test(String(event?.event || ""));
}

function deriveFailurePoint(events = [], request = null) {
  const event = pickLatestEvent(events, (candidate) => hasErrorSignal(candidate) && candidate?.event !== "request_finished");
  if (event) {
    return event;
  }
  const requestFinishedEvent = pickLatestEvent(events, hasErrorSignal);
  if (requestFinishedEvent) {
    return requestFinishedEvent;
  }
  if (request && (request.error_code || (Number(request.status_code || 0) >= 400))) {
    return {
      id: null,
      trace_id: request.trace_id,
      request_id: request.request_id,
      component: "http.request",
      event: "request_finished",
      level: "error",
      payload: {
        status_code: request.status_code,
        error: request.error_code,
        error_message: request.error_message,
      },
      created_at: request.finished_at,
    };
  }
  return null;
}

function deriveFinalResult(request = null, events = []) {
  const completionEvent = pickLatestEvent(events, (event) => (
    event?.event === "request_finished"
    || event?.event === "route_succeeded"
    || event?.event === "route_failed"
    || /(?:completed|failed|succeeded)$/i.test(String(event?.event || ""))
  ));

  return {
    request,
    event: completionEvent,
  };
}

function deriveOutcome({ statusCode = null, payload = null } = {}) {
  const normalizedStatusCode = normalizeStatusCode(statusCode);
  const responsePayload =
    payload && !Array.isArray(payload) && typeof payload === "object"
      ? payload
      : null;
  const payloadOk = typeof responsePayload?.ok === "boolean" ? responsePayload.ok : null;
  const payloadError = normalizeText(responsePayload?.error) || null;
  const payloadMessage = normalizeMessage(responsePayload?.message);
  const inferredError = payloadError || (normalizedStatusCode != null && normalizedStatusCode >= 400
    ? `http_${normalizedStatusCode}`
    : null);
  const ok = payloadOk != null ? payloadOk : normalizedStatusCode == null ? null : normalizedStatusCode < 400;

  return {
    ok,
    error_code: inferredError,
    error_message: payloadMessage,
  };
}

export function recordHttpRequest({
  traceId,
  requestId = null,
  method = "GET",
  pathname = "/",
  routeName = null,
  statusCode = null,
  payload = null,
  durationMs = 0,
  startedAt = null,
  finishedAt = null,
} = {}) {
  const trace_id = normalizeText(traceId);
  if (!trace_id) {
    return null;
  }

  const outcome = deriveOutcome({ statusCode, payload });
  const row = toRow({
    trace_id,
    request_id: requestId,
    method,
    pathname,
    route_name: routeName,
    status_code: statusCode,
    ok: outcome.ok,
    error_code: outcome.error_code,
    error_message: outcome.error_message,
    duration_ms: durationMs,
    started_at: startedAt,
    finished_at: finishedAt,
  });
  try {
    upsertRequestStmt.run(row);
  } catch (error) {
    if (!isClosedDbError(error)) {
      throw error;
    }
  }
  return toRequestRecord(row);
}

export function listRecentRequests({ limit = DEFAULT_RECENT_LIMIT } = {}) {
  try {
    return listRecentRequestsStmt.all(clampLimit(limit, DEFAULT_RECENT_LIMIT)).map(toRequestRecord);
  } catch (error) {
    if (isClosedDbError(error)) {
      return [];
    }
    throw error;
  }
}

export function listRecentErrors({ limit = DEFAULT_ERROR_LIMIT } = {}) {
  try {
    return listRecentErrorsStmt.all(clampLimit(limit, DEFAULT_ERROR_LIMIT)).map(toRequestRecord);
  } catch (error) {
    if (isClosedDbError(error)) {
      return [];
    }
    throw error;
  }
}

export function getRequestByTraceId(traceId) {
  const normalizedTraceId = normalizeText(traceId);
  if (!normalizedTraceId) {
    return null;
  }
  try {
    const row = getRequestByTraceIdStmt.get(normalizedTraceId);
    return row ? toRequestRecord(row) : null;
  } catch (error) {
    if (isClosedDbError(error)) {
      return null;
    }
    throw error;
  }
}

export function recordTraceEvent({
  traceId,
  requestId = null,
  component = null,
  event = "",
  level = "info",
  payload = null,
  createdAt = null,
} = {}) {
  const row = toTraceEventRow({
    trace_id: traceId,
    request_id: requestId,
    component,
    event,
    level,
    payload,
    created_at: createdAt,
  });
  if (!row.trace_id || !row.event) {
    return null;
  }
  try {
    const info = insertTraceEventStmt.run(row);
    return toTraceEventRecord({
      ...row,
      id: Number.isFinite(Number(info?.lastInsertRowid)) ? Number(info.lastInsertRowid) : null,
    });
  } catch (error) {
    if (isClosedDbError(error)) {
      return null;
    }
    throw error;
  }
}

export function listTraceEvents({ traceId, limit = DEFAULT_TRACE_EVENT_LIMIT } = {}) {
  const normalizedTraceId = normalizeText(traceId);
  if (!normalizedTraceId) {
    return [];
  }
  try {
    return listTraceEventsStmt.all(normalizedTraceId, clampTraceEventLimit(limit)).map(toTraceEventRecord);
  } catch (error) {
    if (isClosedDbError(error)) {
      return [];
    }
    throw error;
  }
}

export function getTraceDebugSnapshot(traceId, { limit = DEFAULT_TRACE_EVENT_LIMIT } = {}) {
  const normalizedTraceId = normalizeText(traceId);
  if (!normalizedTraceId) {
    return null;
  }
  const request = getRequestByTraceId(normalizedTraceId);
  const events = listTraceEvents({ traceId: normalizedTraceId, limit });

  if (!request && !events.length) {
    return null;
  }

  return {
    trace_id: normalizedTraceId,
    request,
    request_input: deriveRequestInput(events),
    planner_decision: derivePlannerDecision(events),
    lane_action: deriveLaneAction(events),
    final_result: deriveFinalResult(request, events),
    failure_point: deriveFailurePoint(events, request),
    events,
  };
}

export function getLatestError() {
  const rows = listRecentErrors({ limit: 1 });
  return rows[0] || null;
}

export function getRequestMetrics() {
  let row = {};
  try {
    row = metricsStmt.get() || {};
  } catch (error) {
    if (!isClosedDbError(error)) {
      throw error;
    }
  }
  const totalRequests = Number(row.total_requests || 0);
  const successCount = Number(row.success_count || 0);
  const errorCount = Number(row.error_count || 0);

  return {
    total_requests: totalRequests,
    success_count: successCount,
    error_count: errorCount,
    success_rate: totalRequests > 0 ? successCount / totalRequests : 0,
    error_rate: totalRequests > 0 ? errorCount / totalRequests : 0,
  };
}

export function getMonitoringDashboard({
  recentLimit = DEFAULT_DASHBOARD_RECENT_LIMIT,
  errorLimit = DEFAULT_DASHBOARD_ERROR_LIMIT,
} = {}) {
  const metrics = getRequestMetrics();
  return {
    generated_at: nowIso(),
    request_limit: clampLimit(recentLimit, DEFAULT_DASHBOARD_RECENT_LIMIT),
    error_limit: clampLimit(errorLimit, DEFAULT_DASHBOARD_ERROR_LIMIT),
    metrics: {
      ...metrics,
      success_rate_percent: Number((metrics.success_rate * 100).toFixed(2)),
      error_rate_percent: Number((metrics.error_rate * 100).toFixed(2)),
    },
    latest_error: getLatestError(),
    recent_errors: listRecentErrors({ limit: errorLimit }),
    recent_requests: listRecentRequests({ limit: recentLimit }),
  };
}
