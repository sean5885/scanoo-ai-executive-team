import db from "./db.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";

const insertIdempotencyStmt = db.prepare(`
  INSERT OR IGNORE INTO http_request_idempotency (
    scope_key,
    account_id,
    method,
    pathname,
    idempotency_key,
    status_code,
    response_json,
    first_trace_id,
    first_request_id,
    created_at,
    updated_at
  ) VALUES (
    @scope_key,
    @account_id,
    @method,
    @pathname,
    @idempotency_key,
    @status_code,
    @response_json,
    @first_trace_id,
    @first_request_id,
    @created_at,
    @updated_at
  )
`);

const getIdempotencyStmt = db.prepare(`
  SELECT
    scope_key,
    account_id,
    method,
    pathname,
    idempotency_key,
    status_code,
    response_json,
    first_trace_id,
    first_request_id,
    created_at,
    updated_at
  FROM http_request_idempotency
  WHERE scope_key = ?
  LIMIT 1
`);

function safeParseJson(value) {
  if (!normalizeText(value)) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStatusCode(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : 200;
}

export function buildHttpIdempotencyScopeKey({
  accountId = null,
  method = "POST",
  pathname = "/",
  idempotencyKey = "",
} = {}) {
  const normalizedMethod = normalizeText(method)?.toUpperCase() || "POST";
  const normalizedPathname = normalizeText(pathname) || "/";
  const normalizedAccountId = normalizeText(accountId) || "";
  const normalizedIdempotencyKey = normalizeText(idempotencyKey) || "";

  if (!normalizedIdempotencyKey) {
    return "";
  }

  return [
    normalizedMethod,
    normalizedPathname,
    normalizedAccountId,
    normalizedIdempotencyKey,
  ].join(":");
}

function toRecord(row = null) {
  if (!row) {
    return null;
  }
  return {
    scope_key: row.scope_key || null,
    account_id: row.account_id || null,
    method: row.method || null,
    pathname: row.pathname || null,
    idempotency_key: row.idempotency_key || null,
    status_code: normalizeStatusCode(row.status_code),
    response_payload: safeParseJson(row.response_json),
    first_trace_id: row.first_trace_id || null,
    first_request_id: row.first_request_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export function getHttpIdempotencyRecord({
  accountId = null,
  method = "POST",
  pathname = "/",
  idempotencyKey = "",
  scopeKey = "",
} = {}) {
  const resolvedScopeKey = normalizeText(scopeKey) || buildHttpIdempotencyScopeKey({
    accountId,
    method,
    pathname,
    idempotencyKey,
  });
  if (!resolvedScopeKey) {
    return null;
  }

  return toRecord(getIdempotencyStmt.get(resolvedScopeKey));
}

export function storeHttpIdempotencyRecord({
  accountId = null,
  method = "POST",
  pathname = "/",
  idempotencyKey = "",
  statusCode = 200,
  responsePayload = null,
  firstTraceId = null,
  firstRequestId = null,
} = {}) {
  const scopeKey = buildHttpIdempotencyScopeKey({
    accountId,
    method,
    pathname,
    idempotencyKey,
  });
  if (!scopeKey) {
    return null;
  }

  const timestamp = nowIso();
  insertIdempotencyStmt.run({
    scope_key: scopeKey,
    account_id: normalizeText(accountId) || null,
    method: normalizeText(method)?.toUpperCase() || "POST",
    pathname: normalizeText(pathname) || "/",
    idempotency_key: normalizeText(idempotencyKey),
    status_code: normalizeStatusCode(statusCode),
    response_json: JSON.stringify(responsePayload ?? null),
    first_trace_id: normalizeText(firstTraceId) || null,
    first_request_id: normalizeText(firstRequestId) || null,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getHttpIdempotencyRecord({ scopeKey });
}
