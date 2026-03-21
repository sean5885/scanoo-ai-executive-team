import db from "./db.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_ERROR_LIMIT = 10;
const MAX_LIMIT = 200;

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
  ORDER BY finished_at DESC
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
  ORDER BY finished_at DESC
  LIMIT ?
`);

const metricsStmt = db.prepare(`
  SELECT
    COUNT(*) AS total_requests,
    SUM(CASE WHEN error_code IS NULL AND COALESCE(status_code, 0) < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN error_code IS NOT NULL OR COALESCE(status_code, 0) >= 400 THEN 1 ELSE 0 END) AS error_count
  FROM http_request_monitor
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
  upsertRequestStmt.run(row);
  return toRequestRecord(row);
}

export function listRecentRequests({ limit = DEFAULT_RECENT_LIMIT } = {}) {
  return listRecentRequestsStmt.all(clampLimit(limit, DEFAULT_RECENT_LIMIT)).map(toRequestRecord);
}

export function listRecentErrors({ limit = DEFAULT_ERROR_LIMIT } = {}) {
  return listRecentErrorsStmt.all(clampLimit(limit, DEFAULT_ERROR_LIMIT)).map(toRequestRecord);
}

export function getLatestError() {
  const rows = listRecentErrors({ limit: 1 });
  return rows[0] || null;
}

export function getRequestMetrics() {
  const row = metricsStmt.get() || {};
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
