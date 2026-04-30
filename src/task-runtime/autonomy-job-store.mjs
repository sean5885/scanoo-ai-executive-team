import crypto from "node:crypto";

import db from "../db.mjs";
import { cleanText } from "../message-intent-utils.mjs";
import { nowIso } from "../text-utils.mjs";
import {
  AUTONOMY_JOB_ATTEMPT_STATUS,
  AUTONOMY_JOB_STATUS,
  DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_AUTONOMY_LEASE_MS,
  DEFAULT_AUTONOMY_MAX_ATTEMPTS,
  normalizePositiveInteger,
} from "./autonomy-job-types.mjs";
import {
  EXECUTIVE_WORK_GRAPH_JOB_TYPE,
  claimNextExecutableWorkNode,
  ensureExecutiveWorkGraphTables,
  heartbeatExecutableWorkNodeLease,
  listExecutiveDeadletters,
  replayExecutiveDeadletter,
} from "../executive-work-graph.mjs";

let autonomyTablesReady = false;
const AUTONOMY_OPEN_INCIDENT_SINK_STATE = new Set(["waiting_user", "escalated"]);
const AUTONOMY_OPERATOR_DISPOSITION_ACTION = Object.freeze({
  resumeSameJob: "resume_same_job",
  ackWaitingUser: "ack_waiting_user",
  ackEscalated: "ack_escalated",
});
const AUTONOMY_OPERATOR_DISPOSITION_ACK_ACTION = new Set([
  AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackWaitingUser,
  AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackEscalated,
]);
const AUTONOMY_RUNTIME_FAILURE_DISPOSITION_ACTION = "runtime_failure";
const AUTONOMY_LOOKUP_STATUS = Object.freeze({
  accepted: "accepted",
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  notFound: "not_found",
});
const AUTONOMY_FINAL_PICKUP_INTERMEDIATE_STATUS_PATTERN = /(^|[^a-z])(partial|pending|review)([^a-z]|$)/i;
const AUTONOMY_FINAL_PICKUP_REASON = Object.freeze({
  notReady: "not_ready",
  failed: "failed",
  notFound: "not_found",
});
const AUTONOMY_WORKER_READINESS_REASON = Object.freeze({
  ready: "worker_ready",
  heartbeatMissing: "worker_heartbeat_missing",
  heartbeatInvalid: "worker_heartbeat_invalid",
  heartbeatStale: "worker_heartbeat_stale",
  leaseExpired: "worker_lease_expired",
});

function parseJson(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      error: "json_serialize_failed",
    });
  }
}

function addMsToNowIso(ms = DEFAULT_AUTONOMY_LEASE_MS) {
  return new Date(Date.now() + normalizePositiveInteger(ms, DEFAULT_AUTONOMY_LEASE_MS)).toISOString();
}

function addMsToIso(baseMs = Date.now(), ms = DEFAULT_AUTONOMY_LEASE_MS) {
  const normalizedBaseMs = Number.isFinite(Number(baseMs)) ? Number(baseMs) : Date.now();
  return new Date(
    normalizedBaseMs + normalizePositiveInteger(ms, DEFAULT_AUTONOMY_LEASE_MS),
  ).toISOString();
}

function parseIsoToMs(value = "") {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function upsertAutonomyWorkerHeartbeatRecord({
  workerId = "",
  heartbeatAt = "",
  leaseExpiresAt = "",
  source = "",
} = {}) {
  const normalizedWorkerId = cleanText(workerId);
  const normalizedHeartbeatAt = cleanText(heartbeatAt);
  if (!normalizedWorkerId || !normalizedHeartbeatAt) {
    return false;
  }
  const now = nowIso();
  db.prepare(`
    INSERT INTO autonomy_worker_heartbeats (
      worker_id,
      heartbeat_at,
      lease_expires_at,
      source,
      created_at,
      updated_at
    ) VALUES (
      @worker_id,
      @heartbeat_at,
      @lease_expires_at,
      @source,
      @created_at,
      @updated_at
    )
    ON CONFLICT(worker_id) DO UPDATE SET
      heartbeat_at = excluded.heartbeat_at,
      lease_expires_at = excluded.lease_expires_at,
      source = COALESCE(excluded.source, autonomy_worker_heartbeats.source),
      updated_at = excluded.updated_at
  `).run({
    worker_id: normalizedWorkerId,
    heartbeat_at: normalizedHeartbeatAt,
    lease_expires_at: cleanText(leaseExpiresAt) || null,
    source: cleanText(source) || null,
    created_at: now,
    updated_at: now,
  });
  return true;
}

function readLatestAutonomyWorkerReadinessSignal() {
  const runningAttemptSignal = db.prepare(`
    SELECT
      worker_id,
      heartbeat_at,
      lease_expires_at,
      updated_at,
      created_at
    FROM autonomy_job_attempts
    WHERE status = @running_status
    ORDER BY COALESCE(heartbeat_at, updated_at, created_at) DESC
    LIMIT 1
  `).get({
    running_status: AUTONOMY_JOB_ATTEMPT_STATUS.running,
  });
  const workerHeartbeatSignal = db.prepare(`
    SELECT
      worker_id,
      heartbeat_at,
      lease_expires_at,
      updated_at,
      created_at
    FROM autonomy_worker_heartbeats
    ORDER BY COALESCE(heartbeat_at, updated_at, created_at) DESC
    LIMIT 1
  `).get();
  const candidates = [runningAttemptSignal, workerHeartbeatSignal].filter(Boolean);
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => {
    const leftSignalAt = parseIsoToMs(cleanText(left.heartbeat_at) || cleanText(left.updated_at) || cleanText(left.created_at));
    const rightSignalAt = parseIsoToMs(cleanText(right.heartbeat_at) || cleanText(right.updated_at) || cleanText(right.created_at));
    const normalizedLeft = Number.isFinite(Number(leftSignalAt)) ? Number(leftSignalAt) : Number.NEGATIVE_INFINITY;
    const normalizedRight = Number.isFinite(Number(rightSignalAt)) ? Number(rightSignalAt) : Number.NEGATIVE_INFINITY;
    if (normalizedLeft === normalizedRight) {
      return 0;
    }
    return normalizedRight - normalizedLeft;
  });
  return candidates[0];
}

function readLifecycleSinkFromError(error = null) {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const lifecycleSink = error.lifecycle_sink;
  if (!lifecycleSink || typeof lifecycleSink !== "object" || Array.isArray(lifecycleSink)) {
    return null;
  }
  return lifecycleSink;
}

function readOperatorDispositionFromError(error = null) {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const operatorDisposition = error.operator_disposition;
  if (!operatorDisposition || typeof operatorDisposition !== "object" || Array.isArray(operatorDisposition)) {
    return null;
  }
  return operatorDisposition;
}

function isOpenIncidentSinkState(value = "") {
  return AUTONOMY_OPEN_INCIDENT_SINK_STATE.has(cleanText(value));
}

function isSuppressedByOperatorAck(error = null) {
  const operatorDisposition = readOperatorDispositionFromError(error);
  const latestAction = cleanText(operatorDisposition?.latest?.action);
  if (!latestAction) {
    return false;
  }
  return AUTONOMY_OPERATOR_DISPOSITION_ACK_ACTION.has(latestAction);
}

function normalizeAutonomyDispositionAction(action = "") {
  const normalizedAction = cleanText(action);
  if (!normalizedAction) {
    return null;
  }
  if (
    normalizedAction !== AUTONOMY_OPERATOR_DISPOSITION_ACTION.resumeSameJob
    && normalizedAction !== AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackWaitingUser
    && normalizedAction !== AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackEscalated
  ) {
    return null;
  }
  return normalizedAction;
}

function normalizeAutonomyDispositionPrecondition(precondition = null) {
  if (!precondition || typeof precondition !== "object" || Array.isArray(precondition)) {
    return {
      expected_updated_at: null,
    };
  }
  return {
    expected_updated_at: cleanText(precondition.expected_updated_at) || null,
  };
}

function readAutonomyLookupRequestIdFromPayload(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const plannerInput = payload.planner_input;
  if (plannerInput && typeof plannerInput === "object" && !Array.isArray(plannerInput)) {
    const plannerRequestId = cleanText(plannerInput.request_id);
    if (plannerRequestId) {
      return plannerRequestId;
    }
  }
  return cleanText(payload.request_id) || null;
}

function projectAutonomyLookupStatus(status = "") {
  const normalizedStatus = cleanText(status);
  if (normalizedStatus === AUTONOMY_JOB_STATUS.queued) {
    return AUTONOMY_LOOKUP_STATUS.queued;
  }
  if (normalizedStatus === AUTONOMY_JOB_STATUS.running) {
    return AUTONOMY_LOOKUP_STATUS.running;
  }
  if (normalizedStatus === AUTONOMY_JOB_STATUS.completed) {
    return AUTONOMY_LOOKUP_STATUS.completed;
  }
  if (normalizedStatus === AUTONOMY_JOB_STATUS.failed) {
    return AUTONOMY_LOOKUP_STATUS.failed;
  }
  return AUTONOMY_LOOKUP_STATUS.accepted;
}

function normalizeAutonomyFinalPickupResultObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeAutonomyFinalPickupStringList(items = []) {
  return Array.isArray(items)
    ? items
      .map((item) => cleanText(item))
      .filter(Boolean)
    : [];
}

function readAutonomyFinalPickupStructuredResult(result = null) {
  const normalized = normalizeAutonomyFinalPickupResultObject(result);
  if (!normalized) {
    return null;
  }
  const structuredResult = normalizeAutonomyFinalPickupResultObject(
    normalized.structured_result !== undefined ? normalized.structured_result : normalized.structuredResult,
  );
  if (!structuredResult) {
    return null;
  }
  return {
    answer: cleanText(structuredResult.answer) || null,
    sources: normalizeAutonomyFinalPickupStringList(structuredResult.sources),
    limitations: normalizeAutonomyFinalPickupStringList(structuredResult.limitations),
  };
}

function readAutonomyFinalPickupReplyText(result = null) {
  const normalized = normalizeAutonomyFinalPickupResultObject(result);
  if (!normalized) {
    return null;
  }
  return cleanText(
    normalized.reply_text
    ?? normalized.replyText
    ?? normalized.reply?.text
    ?? "",
  ) || null;
}

function hasAutonomyFinalPickupIntermediateSignal(result = null) {
  const normalized = normalizeAutonomyFinalPickupResultObject(result);
  if (!normalized) {
    return false;
  }
  const plannerResult = normalizeAutonomyFinalPickupResultObject(normalized.planner_result);
  const verifierGateResult = normalizeAutonomyFinalPickupResultObject(normalized.verifier_gate_result);
  const candidates = [
    normalized.status,
    normalized.final_status,
    normalized.finalStatus,
    normalized.state,
    normalized.lifecycle_state,
    normalized.task_state,
    normalized.task_status,
    plannerResult?.status,
    plannerResult?.final_status,
    plannerResult?.finalStatus,
    plannerResult?.state,
    plannerResult?.lifecycle_state,
    plannerResult?.task_state,
    verifierGateResult?.reason,
    verifierGateResult?.status,
    verifierGateResult?.task_state,
  ];
  return candidates.some((candidate) => {
    const normalizedValue = cleanText(candidate);
    if (!normalizedValue) {
      return false;
    }
    return AUTONOMY_FINAL_PICKUP_INTERMEDIATE_STATUS_PATTERN.test(normalizedValue.toLowerCase());
  });
}

function isAutonomyFinalPickupTrulyCompleted(result = null) {
  const normalized = normalizeAutonomyFinalPickupResultObject(result);
  if (!normalized) {
    return true;
  }
  const verifierGateResult = normalizeAutonomyFinalPickupResultObject(normalized.verifier_gate_result);
  if (verifierGateResult?.pass === false) {
    return false;
  }
  if (hasAutonomyFinalPickupIntermediateSignal(normalized)) {
    return false;
  }
  return true;
}

function toAutonomyFinalPickupReason(status = "") {
  const normalizedStatus = cleanText(status);
  if (normalizedStatus === AUTONOMY_LOOKUP_STATUS.failed) {
    return AUTONOMY_FINAL_PICKUP_REASON.failed;
  }
  if (normalizedStatus === AUTONOMY_LOOKUP_STATUS.notFound) {
    return AUTONOMY_FINAL_PICKUP_REASON.notFound;
  }
  if (normalizedStatus === AUTONOMY_LOOKUP_STATUS.completed) {
    return null;
  }
  return AUTONOMY_FINAL_PICKUP_REASON.notReady;
}

function toAutonomyJobFinalPickupNotFoundRecord() {
  return {
    answer: null,
    sources: [],
    limitations: [],
    status: AUTONOMY_LOOKUP_STATUS.notFound,
    updated_at: null,
    reason: AUTONOMY_FINAL_PICKUP_REASON.notFound,
  };
}

function toAutonomyJobFinalPickupPendingRecord({
  status = "",
  updatedAt = "",
} = {}) {
  return {
    answer: null,
    sources: [],
    limitations: [],
    status: cleanText(status) || AUTONOMY_LOOKUP_STATUS.accepted,
    updated_at: cleanText(updatedAt) || null,
    reason: toAutonomyFinalPickupReason(status),
  };
}

function toAutonomyJobFinalPickupCompletedRecord({
  result = null,
  updatedAt = "",
} = {}) {
  const structuredResult = readAutonomyFinalPickupStructuredResult(result);
  return {
    answer: structuredResult?.answer || readAutonomyFinalPickupReplyText(result) || null,
    sources: structuredResult?.sources || [],
    limitations: structuredResult?.limitations || [],
    status: AUTONOMY_LOOKUP_STATUS.completed,
    updated_at: cleanText(updatedAt) || null,
    reason: null,
  };
}

function toAutonomyJobFinalPickupRecord(row = null) {
  if (!row) {
    return toAutonomyJobFinalPickupNotFoundRecord();
  }
  const updatedAt = cleanText(row.updated_at) || null;
  const result = parseJson(row.result_json);
  const projectedStatus = projectAutonomyLookupStatus(row.status);
  if (projectedStatus !== AUTONOMY_LOOKUP_STATUS.completed) {
    return toAutonomyJobFinalPickupPendingRecord({
      status: projectedStatus,
      updatedAt,
    });
  }
  if (!isAutonomyFinalPickupTrulyCompleted(result)) {
    return toAutonomyJobFinalPickupPendingRecord({
      status: AUTONOMY_LOOKUP_STATUS.running,
      updatedAt,
    });
  }
  return toAutonomyJobFinalPickupCompletedRecord({
    result,
    updatedAt,
  });
}

function toAutonomyJobLookupNotFoundRecord() {
  return {
    job_id: null,
    job_type: null,
    status: AUTONOMY_LOOKUP_STATUS.notFound,
    lifecycle_sink: null,
    updated_at: null,
    reason: null,
  };
}

function toAutonomyJobLookupRecord(row = null) {
  if (!row) {
    return toAutonomyJobLookupNotFoundRecord();
  }
  const error = parseJson(row.error_json);
  const lifecycleSink = readLifecycleSinkFromError(error);
  const failureClass = cleanText(lifecycleSink?.failure_class) || null;
  const routingHint = cleanText(lifecycleSink?.routing_hint) || null;
  const hasReason = Boolean(failureClass || routingHint);
  return {
    job_id: cleanText(row.job_id) || null,
    job_type: cleanText(row.job_type) || null,
    status: projectAutonomyLookupStatus(row.status),
    lifecycle_sink: cleanText(lifecycleSink?.state) || null,
    updated_at: cleanText(row.updated_at) || null,
    reason: hasReason
      ? {
          failure_class: failureClass,
          routing_hint: routingHint,
        }
      : null,
  };
}

function readAutonomyLatestJobLookupRowByTraceId(traceId = "") {
  const normalizedTraceId = cleanText(traceId);
  if (!normalizedTraceId) {
    return null;
  }
  return db.prepare(`
    SELECT
      id AS job_id,
      job_type,
      status,
      updated_at,
      error_json,
      result_json
    FROM autonomy_jobs
    WHERE trace_id = @trace_id
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get({
    trace_id: normalizedTraceId,
  });
}

function readAutonomyLatestJobLookupRowByRequestId(requestId = "") {
  const normalizedRequestId = cleanText(requestId);
  if (!normalizedRequestId) {
    return null;
  }
  const rows = db.prepare(`
    SELECT
      id AS job_id,
      job_type,
      status,
      updated_at,
      error_json,
      result_json,
      payload_json
    FROM autonomy_jobs
    WHERE payload_json IS NOT NULL
      AND instr(payload_json, @request_id) > 0
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `).all({
    request_id: normalizedRequestId,
  });
  for (const row of rows) {
    const payload = parseJson(row.payload_json);
    const rowRequestId = readAutonomyLookupRequestIdFromPayload(payload);
    if (rowRequestId && rowRequestId === normalizedRequestId) {
      return row;
    }
  }
  return null;
}

function toAutonomyOpenIncidentRecord(row = null, { includeOperatorDisposition = false } = {}) {
  if (!row) {
    return null;
  }
  const error = parseJson(row.error_json);
  const lifecycleSink = readLifecycleSinkFromError(error);
  const lifecycleSinkState = cleanText(lifecycleSink?.state);
  if (!isOpenIncidentSinkState(lifecycleSinkState)) {
    return null;
  }
  if (isSuppressedByOperatorAck(error)) {
    return null;
  }
  const incident = {
    job_id: row.job_id || null,
    attempt_id: row.attempt_id || null,
    lifecycle_sink: lifecycleSinkState,
    failure_class: cleanText(lifecycleSink?.failure_class) || null,
    routing_hint: cleanText(lifecycleSink?.routing_hint) || null,
    trace_id: cleanText(row.job_trace_id) || cleanText(row.attempt_trace_id) || null,
    updated_at: row.updated_at || null,
  };
  if (includeOperatorDisposition) {
    incident.operator_disposition = readOperatorDispositionFromError(error) || null;
  }
  return incident;
}

function mergeOperatorDispositionErrorMetadata({
  error = null,
  at = "",
  action = "",
  reason = "",
  operatorId = "",
  requestId = "",
  expectedUpdatedAt = "",
  replaySpec = null,
} = {}) {
  const baseError = error && typeof error === "object" && !Array.isArray(error)
    ? { ...error }
    : {};
  const previousOperatorDisposition = baseError.operator_disposition;
  const history = Array.isArray(previousOperatorDisposition?.history)
    ? previousOperatorDisposition.history.slice(0)
    : [];
  const entry = {
    at: cleanText(at) || nowIso(),
    action: cleanText(action) || null,
    reason: cleanText(reason) || null,
  };
  const normalizedOperatorId = cleanText(operatorId) || null;
  const normalizedRequestId = cleanText(requestId) || null;
  const normalizedExpectedUpdatedAt = cleanText(expectedUpdatedAt) || null;
  if (normalizedOperatorId) {
    entry.operator_id = normalizedOperatorId;
  }
  if (normalizedRequestId) {
    entry.request_id = normalizedRequestId;
  }
  if (normalizedExpectedUpdatedAt) {
    entry.expected_updated_at = normalizedExpectedUpdatedAt;
  }
  history.push(entry);
  baseError.operator_disposition = {
    latest: entry,
    history,
    replay_spec: replaySpec || null,
  };
  return baseError;
}

function mergeFailureErrorWithOperatorDispositionHistory({
  previousError = null,
  nextFailureError = null,
  failedAt = "",
} = {}) {
  const previousOperatorDisposition = readOperatorDispositionFromError(previousError);
  if (!previousOperatorDisposition) {
    return nextFailureError;
  }

  const baseError = nextFailureError && typeof nextFailureError === "object" && !Array.isArray(nextFailureError)
    ? { ...nextFailureError }
    : {};
  const history = Array.isArray(previousOperatorDisposition.history)
    ? previousOperatorDisposition.history.slice(0)
    : [];
  if (
    history.length === 0
    && previousOperatorDisposition.latest
    && typeof previousOperatorDisposition.latest === "object"
    && !Array.isArray(previousOperatorDisposition.latest)
  ) {
    history.push(previousOperatorDisposition.latest);
  }
  const lifecycleSink = readLifecycleSinkFromError(baseError);
  const runtimeFailureEntry = {
    at: cleanText(failedAt) || nowIso(),
    action: AUTONOMY_RUNTIME_FAILURE_DISPOSITION_ACTION,
    reason: cleanText(lifecycleSink?.reason) || cleanText(baseError.reason) || "runtime_failure",
  };
  history.push(runtimeFailureEntry);
  baseError.operator_disposition = {
    ...previousOperatorDisposition,
    latest: runtimeFailureEntry,
    history,
    replay_spec: previousOperatorDisposition.replay_spec || null,
  };
  return baseError;
}

function readAutonomyOpenIncidentByJobId(jobId = "", { includeOperatorDisposition = false } = {}) {
  const normalizedJobId = cleanText(jobId);
  if (!normalizedJobId) {
    return null;
  }
  const row = db.prepare(`
    SELECT
      jobs.id AS job_id,
      jobs.last_attempt_id AS attempt_id,
      jobs.trace_id AS job_trace_id,
      attempts.trace_id AS attempt_trace_id,
      jobs.updated_at AS updated_at,
      jobs.error_json AS error_json
    FROM autonomy_jobs jobs
    LEFT JOIN autonomy_job_attempts attempts
      ON attempts.id = jobs.last_attempt_id
    WHERE jobs.id = @job_id
      AND jobs.status = @failed_status
    LIMIT 1
  `).get({
    job_id: normalizedJobId,
    failed_status: AUTONOMY_JOB_STATUS.failed,
  });
  return toAutonomyOpenIncidentRecord(row, { includeOperatorDisposition });
}

export function getAutonomyOpenIncidentByJobId(jobId = "") {
  ensureAutonomyJobTables();
  return readAutonomyOpenIncidentByJobId(jobId, {
    includeOperatorDisposition: true,
  });
}

export function lookupAutonomyJobReceiptByTraceId(traceId = "") {
  ensureAutonomyJobTables();
  const row = readAutonomyLatestJobLookupRowByTraceId(traceId);
  return toAutonomyJobLookupRecord(row);
}

export function lookupAutonomyJobReceiptByRequestId(requestId = "") {
  ensureAutonomyJobTables();
  const row = readAutonomyLatestJobLookupRowByRequestId(requestId);
  return toAutonomyJobLookupRecord(row);
}

export function lookupAutonomyJobFinalPickupByTraceId(traceId = "") {
  ensureAutonomyJobTables();
  const row = readAutonomyLatestJobLookupRowByTraceId(traceId);
  return toAutonomyJobFinalPickupRecord(row);
}

export function lookupAutonomyJobFinalPickupByRequestId(requestId = "") {
  ensureAutonomyJobTables();
  const row = readAutonomyLatestJobLookupRowByRequestId(requestId);
  return toAutonomyJobFinalPickupRecord(row);
}

export function readAutonomyQueueBacklogMetrics({
  nowAt = "",
} = {}) {
  ensureAutonomyJobTables();
  const nowMs = parseIsoToMs(nowAt) ?? Date.now();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = @queued THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN status = @running THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = @failed THEN 1 ELSE 0 END) AS failed_count,
      MIN(
        CASE
          WHEN status = @queued
            THEN COALESCE(next_run_at, created_at)
          ELSE NULL
        END
      ) AS oldest_queued_at
    FROM autonomy_jobs
  `).get({
    queued: AUTONOMY_JOB_STATUS.queued,
    running: AUTONOMY_JOB_STATUS.running,
    failed: AUTONOMY_JOB_STATUS.failed,
  }) || {};
  const oldestQueuedAt = cleanText(row.oldest_queued_at) || null;
  const oldestQueuedMs = parseIsoToMs(oldestQueuedAt);
  return {
    queued_count: Number.isFinite(Number(row.queued_count)) ? Number(row.queued_count) : 0,
    running_count: Number.isFinite(Number(row.running_count)) ? Number(row.running_count) : 0,
    failed_count: Number.isFinite(Number(row.failed_count)) ? Number(row.failed_count) : 0,
    oldest_queued_at: oldestQueuedAt,
    oldest_queued_age_ms: oldestQueuedMs == null
      ? null
      : Math.max(0, nowMs - oldestQueuedMs),
  };
}

export function readAutonomyWorkerReadiness({
  nowAt = "",
  maxHeartbeatLagMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS * 3,
} = {}) {
  ensureAutonomyJobTables();
  const nowMs = parseIsoToMs(nowAt) ?? Date.now();
  const normalizedMaxHeartbeatLagMs = normalizePositiveInteger(
    maxHeartbeatLagMs,
    DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS * 3,
    { min: 1_000, max: 10 * 60 * 1_000 },
  );
  const row = readLatestAutonomyWorkerReadinessSignal();
  if (!row) {
    return {
      ready: false,
      readiness_state: "not_ready",
      reason: AUTONOMY_WORKER_READINESS_REASON.heartbeatMissing,
      worker_id: null,
      heartbeat_at: null,
      lease_expires_at: null,
      lease_remaining_ms: null,
      heartbeat_lag_ms: null,
      max_heartbeat_lag_ms: normalizedMaxHeartbeatLagMs,
    };
  }

  const heartbeatAt = cleanText(row.heartbeat_at) || cleanText(row.updated_at) || cleanText(row.created_at) || null;
  const leaseExpiresAt = cleanText(row.lease_expires_at) || null;
  const heartbeatMs = parseIsoToMs(heartbeatAt);
  const leaseExpiresMs = parseIsoToMs(leaseExpiresAt);
  const leaseRemainingMs = leaseExpiresMs == null ? null : leaseExpiresMs - nowMs;
  if (heartbeatMs == null) {
    return {
      ready: false,
      readiness_state: "not_ready",
      reason: AUTONOMY_WORKER_READINESS_REASON.heartbeatInvalid,
      worker_id: cleanText(row.worker_id) || null,
      heartbeat_at: heartbeatAt,
      lease_expires_at: leaseExpiresAt,
      lease_remaining_ms: leaseRemainingMs,
      heartbeat_lag_ms: null,
      max_heartbeat_lag_ms: normalizedMaxHeartbeatLagMs,
    };
  }

  const heartbeatLagMs = Math.max(0, nowMs - heartbeatMs);
  const leaseReady = leaseExpiresMs != null && leaseExpiresMs > nowMs;
  if (!leaseReady) {
    return {
      ready: false,
      readiness_state: "not_ready",
      reason: AUTONOMY_WORKER_READINESS_REASON.leaseExpired,
      worker_id: cleanText(row.worker_id) || null,
      heartbeat_at: heartbeatAt,
      lease_expires_at: leaseExpiresAt,
      lease_remaining_ms: leaseRemainingMs,
      heartbeat_lag_ms: heartbeatLagMs,
      max_heartbeat_lag_ms: normalizedMaxHeartbeatLagMs,
    };
  }
  if (heartbeatLagMs > normalizedMaxHeartbeatLagMs) {
    return {
      ready: false,
      readiness_state: "not_ready",
      reason: AUTONOMY_WORKER_READINESS_REASON.heartbeatStale,
      worker_id: cleanText(row.worker_id) || null,
      heartbeat_at: heartbeatAt,
      lease_expires_at: leaseExpiresAt,
      lease_remaining_ms: leaseRemainingMs,
      heartbeat_lag_ms: heartbeatLagMs,
      max_heartbeat_lag_ms: normalizedMaxHeartbeatLagMs,
    };
  }
  return {
    ready: true,
    readiness_state: "ready",
    reason: AUTONOMY_WORKER_READINESS_REASON.ready,
    worker_id: cleanText(row.worker_id) || null,
    heartbeat_at: heartbeatAt,
    lease_expires_at: leaseExpiresAt,
    lease_remaining_ms: leaseRemainingMs,
    heartbeat_lag_ms: heartbeatLagMs,
    max_heartbeat_lag_ms: normalizedMaxHeartbeatLagMs,
  };
}

function toAutonomyJobRecord(row = null) {
  if (!row) {
    return null;
  }
  const error = parseJson(row.error_json);
  return {
    id: row.id || null,
    job_type: row.job_type || null,
    status: row.status || null,
    payload: parseJson(row.payload_json),
    trace_id: row.trace_id || null,
    lease_owner: row.lease_owner || null,
    lease_expires_at: row.lease_expires_at || null,
    next_run_at: row.next_run_at || null,
    attempt_count: Number.isFinite(Number(row.attempt_count)) ? Number(row.attempt_count) : 0,
    max_attempts: Number.isFinite(Number(row.max_attempts)) ? Number(row.max_attempts) : DEFAULT_AUTONOMY_MAX_ATTEMPTS,
    last_attempt_id: row.last_attempt_id || null,
    result: parseJson(row.result_json),
    error,
    lifecycle_sink: readLifecycleSinkFromError(error),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    failed_at: row.failed_at || null,
  };
}

function toAutonomyJobAttemptRecord(row = null) {
  if (!row) {
    return null;
  }
  const error = parseJson(row.error_json);
  return {
    id: row.id || null,
    job_id: row.job_id || null,
    worker_id: row.worker_id || null,
    status: row.status || null,
    trace_id: row.trace_id || null,
    lease_expires_at: row.lease_expires_at || null,
    started_at: row.started_at || null,
    heartbeat_at: row.heartbeat_at || null,
    completed_at: row.completed_at || null,
    failed_at: row.failed_at || null,
    result: parseJson(row.result_json),
    error,
    lifecycle_sink: readLifecycleSinkFromError(error),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export function ensureAutonomyJobTables() {
  if (autonomyTablesReady) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      trace_id TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      next_run_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      last_attempt_id TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS autonomy_job_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trace_id TEXT,
      lease_expires_at TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES autonomy_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS autonomy_worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_claim
    ON autonomy_jobs(status, next_run_at, lease_expires_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_trace
    ON autonomy_jobs(trace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_autonomy_job_attempts_job
    ON autonomy_job_attempts(job_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_autonomy_job_attempts_trace
    ON autonomy_job_attempts(trace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_autonomy_worker_heartbeats_signal
    ON autonomy_worker_heartbeats(heartbeat_at DESC, updated_at DESC, created_at DESC);
  `);

  autonomyTablesReady = true;
  ensureExecutiveWorkGraphTables();
}

export function enqueueExecutiveWorkGraphJob({
  graphId = "",
  taskId = "",
  accountId = "",
  sessionKey = "",
  requestText = "",
  traceId = "",
  maxAttempts = 3,
} = {}) {
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return null;
  }
  return enqueueAutonomyJobRecord({
    jobType: EXECUTIVE_WORK_GRAPH_JOB_TYPE,
    traceId,
    maxAttempts,
    payload: {
      schema_version: EXECUTIVE_WORK_GRAPH_JOB_TYPE,
      graph_id: normalizedGraphId,
      task_id: cleanText(taskId) || null,
      account_id: cleanText(accountId) || null,
      session_key: cleanText(sessionKey) || null,
      request_text: cleanText(requestText) || null,
    },
  });
}

export function claimNextExecutiveWorkNode({
  graphId = "",
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
} = {}) {
  ensureExecutiveWorkGraphTables();
  return claimNextExecutableWorkNode({
    graphId,
    workerId,
    leaseMs,
  });
}

export function heartbeatExecutiveWorkNode({
  graphId = "",
  nodeId = "",
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
} = {}) {
  ensureExecutiveWorkGraphTables();
  return heartbeatExecutableWorkNodeLease({
    graphId,
    nodeId,
    workerId,
    leaseMs,
  });
}

export function listExecutiveWorkDeadletters({
  graphId = "",
  limit = 100,
} = {}) {
  ensureExecutiveWorkGraphTables();
  return listExecutiveDeadletters({
    graphId,
    limit,
  });
}

export function replayExecutiveWorkDeadletter({
  deadletterId = "",
  operatorId = "",
  reason = "",
} = {}) {
  ensureExecutiveWorkGraphTables();
  return replayExecutiveDeadletter({
    deadletterId,
    operatorId,
    reason,
  });
}

export function enqueueAutonomyJobRecord({
  jobType = "",
  payload = null,
  traceId = "",
  maxAttempts = DEFAULT_AUTONOMY_MAX_ATTEMPTS,
  notBeforeAt = "",
} = {}) {
  ensureAutonomyJobTables();

  const normalizedJobType = cleanText(jobType);
  if (!normalizedJobType) {
    return null;
  }

  const now = nowIso();
  const id = crypto.randomUUID();
  const resolvedMaxAttempts = normalizePositiveInteger(maxAttempts, DEFAULT_AUTONOMY_MAX_ATTEMPTS);
  const nextRunAt = cleanText(notBeforeAt) || now;
  db.prepare(`
    INSERT INTO autonomy_jobs (
      id,
      job_type,
      status,
      payload_json,
      trace_id,
      lease_owner,
      lease_expires_at,
      next_run_at,
      attempt_count,
      max_attempts,
      last_attempt_id,
      result_json,
      error_json,
      created_at,
      updated_at,
      started_at,
      completed_at,
      failed_at
    ) VALUES (
      @id,
      @job_type,
      @status,
      @payload_json,
      @trace_id,
      NULL,
      NULL,
      @next_run_at,
      0,
      @max_attempts,
      NULL,
      NULL,
      NULL,
      @created_at,
      @updated_at,
      NULL,
      NULL,
      NULL
    )
  `).run({
    id,
    job_type: normalizedJobType,
    status: AUTONOMY_JOB_STATUS.queued,
    payload_json: stringifyJson(payload),
    trace_id: cleanText(traceId) || null,
    next_run_at: nextRunAt,
    max_attempts: resolvedMaxAttempts,
    created_at: now,
    updated_at: now,
  });

  return getAutonomyJobById(id);
}

export function getAutonomyJobById(jobId = "") {
  ensureAutonomyJobTables();
  const normalizedJobId = cleanText(jobId);
  if (!normalizedJobId) {
    return null;
  }
  const row = db.prepare(`
    SELECT *
    FROM autonomy_jobs
    WHERE id = ?
    LIMIT 1
  `).get(normalizedJobId);
  return toAutonomyJobRecord(row);
}

export function getAutonomyJobAttemptById(attemptId = "") {
  ensureAutonomyJobTables();
  const normalizedAttemptId = cleanText(attemptId);
  if (!normalizedAttemptId) {
    return null;
  }
  const row = db.prepare(`
    SELECT *
    FROM autonomy_job_attempts
    WHERE id = ?
    LIMIT 1
  `).get(normalizedAttemptId);
  return toAutonomyJobAttemptRecord(row);
}

export function claimNextAutonomyJob({
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  traceId = "",
} = {}) {
  ensureAutonomyJobTables();

  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedWorkerId) {
    return null;
  }

  const claimTx = db.transaction(() => {
    const now = nowIso();
    const candidate = db.prepare(`
      SELECT *
      FROM autonomy_jobs
      WHERE (
        status = @queued
        AND (next_run_at IS NULL OR next_run_at <= @now)
      )
      OR (
        status = @running
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= @now
      )
      ORDER BY
        CASE status WHEN @queued THEN 0 ELSE 1 END ASC,
        COALESCE(next_run_at, created_at) ASC,
        created_at ASC
      LIMIT 1
    `).get({
      queued: AUTONOMY_JOB_STATUS.queued,
      running: AUTONOMY_JOB_STATUS.running,
      now,
    });

    if (!candidate) {
      return null;
    }

    const normalizedTraceId = cleanText(traceId) || cleanText(candidate.trace_id) || null;
    const maxAttempts = normalizePositiveInteger(candidate.max_attempts, DEFAULT_AUTONOMY_MAX_ATTEMPTS);
    const attemptCount = Number.isFinite(Number(candidate.attempt_count)) ? Number(candidate.attempt_count) : 0;
    if (attemptCount >= maxAttempts) {
      db.prepare(`
        UPDATE autonomy_jobs
        SET status = @status,
            lease_owner = NULL,
            lease_expires_at = NULL,
            failed_at = @failed_at,
            updated_at = @updated_at,
            error_json = @error_json
        WHERE id = @id
      `).run({
        id: candidate.id,
        status: AUTONOMY_JOB_STATUS.failed,
        failed_at: now,
        updated_at: now,
        error_json: stringifyJson({
          error: "max_attempts_exhausted",
          max_attempts: maxAttempts,
          attempt_count: attemptCount,
        }),
      });
      return {
        skipped: true,
        reason: "max_attempts_exhausted",
        job: getAutonomyJobById(candidate.id),
        attempt: null,
      };
    }

    const attemptId = crypto.randomUUID();
    const leaseExpiresAt = addMsToNowIso(leaseMs);
    const updated = db.prepare(`
      UPDATE autonomy_jobs
      SET status = @status,
          lease_owner = @lease_owner,
          lease_expires_at = @lease_expires_at,
          attempt_count = attempt_count + 1,
          last_attempt_id = @last_attempt_id,
          started_at = COALESCE(started_at, @started_at),
          updated_at = @updated_at,
          trace_id = COALESCE(@trace_id, trace_id)
      WHERE id = @id
        AND (
          (
            status = @queued
            AND (next_run_at IS NULL OR next_run_at <= @now)
          )
          OR (
            status = @running
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= @now
          )
        )
    `).run({
      id: candidate.id,
      status: AUTONOMY_JOB_STATUS.running,
      lease_owner: normalizedWorkerId,
      lease_expires_at: leaseExpiresAt,
      last_attempt_id: attemptId,
      started_at: now,
      updated_at: now,
      trace_id: normalizedTraceId,
      queued: AUTONOMY_JOB_STATUS.queued,
      running: AUTONOMY_JOB_STATUS.running,
      now,
    });

    if (Number(updated.changes || 0) !== 1) {
      return null;
    }

    db.prepare(`
      INSERT INTO autonomy_job_attempts (
        id,
        job_id,
        worker_id,
        status,
        trace_id,
        lease_expires_at,
        started_at,
        heartbeat_at,
        completed_at,
        failed_at,
        result_json,
        error_json,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @job_id,
        @worker_id,
        @status,
        @trace_id,
        @lease_expires_at,
        @started_at,
        @heartbeat_at,
        NULL,
        NULL,
        NULL,
        NULL,
        @created_at,
        @updated_at
      )
    `).run({
      id: attemptId,
      job_id: candidate.id,
      worker_id: normalizedWorkerId,
      status: AUTONOMY_JOB_ATTEMPT_STATUS.running,
      trace_id: normalizedTraceId,
      lease_expires_at: leaseExpiresAt,
      started_at: now,
      heartbeat_at: now,
      created_at: now,
      updated_at: now,
    });
    upsertAutonomyWorkerHeartbeatRecord({
      workerId: normalizedWorkerId,
      heartbeatAt: now,
      leaseExpiresAt,
      source: "running_attempt",
    });

    return {
      skipped: false,
      reason: null,
      job: getAutonomyJobById(candidate.id),
      attempt: getAutonomyJobAttemptById(attemptId),
    };
  });

  return claimTx();
}

export function heartbeatAutonomyAttempt({
  jobId = "",
  attemptId = "",
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
} = {}) {
  ensureAutonomyJobTables();

  const normalizedJobId = cleanText(jobId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedJobId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_heartbeat_input",
    };
  }

  const heartbeatTx = db.transaction(() => {
    const now = nowIso();
    const leaseExpiresAt = addMsToNowIso(leaseMs);
    const updatedJob = db.prepare(`
      UPDATE autonomy_jobs
      SET lease_expires_at = @lease_expires_at,
          updated_at = @updated_at
      WHERE id = @id
        AND status = @status
        AND lease_owner = @lease_owner
    `).run({
      id: normalizedJobId,
      lease_expires_at: leaseExpiresAt,
      updated_at: now,
      status: AUTONOMY_JOB_STATUS.running,
      lease_owner: normalizedWorkerId,
    });

    const updatedAttempt = db.prepare(`
      UPDATE autonomy_job_attempts
      SET lease_expires_at = @lease_expires_at,
          heartbeat_at = @heartbeat_at,
          updated_at = @updated_at
      WHERE id = @id
        AND job_id = @job_id
        AND worker_id = @worker_id
        AND status = @status
    `).run({
      id: normalizedAttemptId,
      job_id: normalizedJobId,
      worker_id: normalizedWorkerId,
      status: AUTONOMY_JOB_ATTEMPT_STATUS.running,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
      updated_at: now,
    });

    if (Number(updatedJob.changes || 0) !== 1 || Number(updatedAttempt.changes || 0) !== 1) {
      return {
        ok: false,
        error: "attempt_not_running",
      };
    }
    upsertAutonomyWorkerHeartbeatRecord({
      workerId: normalizedWorkerId,
      heartbeatAt: now,
      leaseExpiresAt,
      source: "running_attempt",
    });

    return {
      ok: true,
      lease_expires_at: leaseExpiresAt,
      job: getAutonomyJobById(normalizedJobId),
      attempt: getAutonomyJobAttemptById(normalizedAttemptId),
    };
  });

  return heartbeatTx();
}

export function heartbeatAutonomyWorker({
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  nowAt = "",
} = {}) {
  ensureAutonomyJobTables();
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_worker_heartbeat_input",
    };
  }
  const nowMs = parseIsoToMs(nowAt);
  const heartbeatAt = nowMs == null ? nowIso() : new Date(nowMs).toISOString();
  const leaseExpiresAt = addMsToIso(nowMs == null ? Date.now() : nowMs, leaseMs);
  upsertAutonomyWorkerHeartbeatRecord({
    workerId: normalizedWorkerId,
    heartbeatAt,
    leaseExpiresAt,
    source: "idle_worker",
  });
  return {
    ok: true,
    worker_id: normalizedWorkerId,
    heartbeat_at: heartbeatAt,
    lease_expires_at: leaseExpiresAt,
  };
}

export function completeAutonomyAttempt({
  jobId = "",
  attemptId = "",
  workerId = "",
  result = null,
} = {}) {
  ensureAutonomyJobTables();

  const normalizedJobId = cleanText(jobId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedJobId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_complete_input",
    };
  }

  const completeTx = db.transaction(() => {
    const now = nowIso();
    const attemptUpdate = db.prepare(`
      UPDATE autonomy_job_attempts
      SET status = @status,
          completed_at = @completed_at,
          updated_at = @updated_at,
          result_json = @result_json
      WHERE id = @id
        AND job_id = @job_id
        AND worker_id = @worker_id
        AND status = @running_status
    `).run({
      id: normalizedAttemptId,
      job_id: normalizedJobId,
      worker_id: normalizedWorkerId,
      running_status: AUTONOMY_JOB_ATTEMPT_STATUS.running,
      status: AUTONOMY_JOB_ATTEMPT_STATUS.completed,
      completed_at: now,
      updated_at: now,
      result_json: stringifyJson(result),
    });
    if (Number(attemptUpdate.changes || 0) !== 1) {
      return {
        ok: false,
        error: "attempt_not_running",
      };
    }

    db.prepare(`
      UPDATE autonomy_jobs
      SET status = @status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = @completed_at,
          updated_at = @updated_at,
          result_json = @result_json,
          error_json = NULL
      WHERE id = @id
        AND lease_owner = @lease_owner
    `).run({
      id: normalizedJobId,
      lease_owner: normalizedWorkerId,
      status: AUTONOMY_JOB_STATUS.completed,
      completed_at: now,
      updated_at: now,
      result_json: stringifyJson(result),
    });

    return {
      ok: true,
      job: getAutonomyJobById(normalizedJobId),
      attempt: getAutonomyJobAttemptById(normalizedAttemptId),
    };
  });

  return completeTx();
}

export function failAutonomyAttempt({
  jobId = "",
  attemptId = "",
  workerId = "",
  error = null,
  retryable = true,
} = {}) {
  ensureAutonomyJobTables();

  const normalizedJobId = cleanText(jobId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedJobId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_fail_input",
    };
  }

  const failTx = db.transaction(() => {
    const now = nowIso();
    const currentJob = db.prepare(`
      SELECT *
      FROM autonomy_jobs
      WHERE id = ?
      LIMIT 1
    `).get(normalizedJobId);
    if (!currentJob) {
      return {
        ok: false,
        error: "job_not_found",
      };
    }
    const mergedError = mergeFailureErrorWithOperatorDispositionHistory({
      previousError: parseJson(currentJob.error_json),
      nextFailureError: error,
      failedAt: now,
    });
    const mergedErrorJson = stringifyJson(mergedError);

    const attemptUpdate = db.prepare(`
      UPDATE autonomy_job_attempts
      SET status = @status,
          failed_at = @failed_at,
          updated_at = @updated_at,
          error_json = @error_json
      WHERE id = @id
        AND job_id = @job_id
        AND worker_id = @worker_id
        AND status = @running_status
    `).run({
      id: normalizedAttemptId,
      job_id: normalizedJobId,
      worker_id: normalizedWorkerId,
      status: AUTONOMY_JOB_ATTEMPT_STATUS.failed,
      running_status: AUTONOMY_JOB_ATTEMPT_STATUS.running,
      failed_at: now,
      updated_at: now,
      error_json: mergedErrorJson,
    });
    if (Number(attemptUpdate.changes || 0) !== 1) {
      return {
        ok: false,
        error: "attempt_not_running",
      };
    }

    const attemptCount = Number.isFinite(Number(currentJob.attempt_count)) ? Number(currentJob.attempt_count) : 0;
    const maxAttempts = normalizePositiveInteger(currentJob.max_attempts, DEFAULT_AUTONOMY_MAX_ATTEMPTS);
    const canRetry = retryable === true && attemptCount < maxAttempts;
    const nextStatus = canRetry ? AUTONOMY_JOB_STATUS.queued : AUTONOMY_JOB_STATUS.failed;

    db.prepare(`
      UPDATE autonomy_jobs
      SET status = @status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_run_at = @next_run_at,
          failed_at = @failed_at,
          updated_at = @updated_at,
          error_json = @error_json
      WHERE id = @id
    `).run({
      id: normalizedJobId,
      status: nextStatus,
      next_run_at: canRetry ? now : null,
      failed_at: canRetry ? null : now,
      updated_at: now,
      error_json: mergedErrorJson,
    });

    return {
      ok: true,
      retry_scheduled: canRetry,
      job: getAutonomyJobById(normalizedJobId),
      attempt: getAutonomyJobAttemptById(normalizedAttemptId),
    };
  });

  return failTx();
}

export function listAutonomyOpenIncidents({
  limit = 100,
} = {}) {
  ensureAutonomyJobTables();
  const resolvedLimit = normalizePositiveInteger(limit, 100);
  const rows = db.prepare(`
    SELECT
      jobs.id AS job_id,
      jobs.last_attempt_id AS attempt_id,
      jobs.trace_id AS job_trace_id,
      attempts.trace_id AS attempt_trace_id,
      jobs.updated_at AS updated_at,
      jobs.error_json AS error_json
    FROM autonomy_jobs jobs
    LEFT JOIN autonomy_job_attempts attempts
      ON attempts.id = jobs.last_attempt_id
    WHERE jobs.status = @failed_status
    ORDER BY jobs.updated_at DESC, jobs.created_at DESC
    LIMIT @limit
  `).all({
    failed_status: AUTONOMY_JOB_STATUS.failed,
    limit: resolvedLimit,
  });

  const incidents = [];
  for (const row of rows) {
    const incident = toAutonomyOpenIncidentRecord(row);
    if (incident) {
      incidents.push(incident);
    }
  }
  return incidents;
}

export function buildAutonomyIncidentReplaySpec({
  incident = null,
  action = "",
  reason = "",
  generatedAt = "",
} = {}) {
  if (!incident || typeof incident !== "object" || Array.isArray(incident)) {
    return null;
  }
  const jobId = cleanText(incident.job_id);
  if (!jobId) {
    return null;
  }
  const lifecycleSink = cleanText(incident.lifecycle_sink);
  if (!isOpenIncidentSinkState(lifecycleSink)) {
    return null;
  }
  const normalizedAction = normalizeAutonomyDispositionAction(action);
  return {
    version: "autonomy_incident_replay_spec_v1",
    generated_at: cleanText(generatedAt) || nowIso(),
    action: normalizedAction || null,
    reason: cleanText(reason) || null,
    incident: {
      job_id: jobId,
      attempt_id: cleanText(incident.attempt_id) || null,
      lifecycle_sink: lifecycleSink,
      failure_class: cleanText(incident.failure_class) || null,
      routing_hint: cleanText(incident.routing_hint) || null,
      trace_id: cleanText(incident.trace_id) || null,
      updated_at: cleanText(incident.updated_at) || null,
    },
  };
}

export function applyAutonomyIncidentDisposition({
  jobId = "",
  action = "",
  reason = "",
  precondition = null,
  operatorId = "",
  requestId = "",
  operator_id = "",
  request_id = "",
  expected_updated_at = "",
} = {}) {
  ensureAutonomyJobTables();

  const normalizedJobId = cleanText(jobId);
  const normalizedAction = normalizeAutonomyDispositionAction(action);
  const normalizedPrecondition = normalizeAutonomyDispositionPrecondition(precondition);
  const normalizedExpectedUpdatedAt = cleanText(normalizedPrecondition.expected_updated_at || expected_updated_at) || null;
  const normalizedOperatorId = cleanText(operatorId || operator_id) || null;
  const normalizedRequestId = cleanText(requestId || request_id) || null;
  if (!normalizedJobId || !normalizedAction) {
    return {
      ok: false,
      error: "invalid_operator_disposition_input",
    };
  }

  const dispositionTx = db.transaction(() => {
    const incident = readAutonomyOpenIncidentByJobId(normalizedJobId);
    if (!incident) {
      return {
        ok: false,
        error: "open_incident_not_found",
      };
    }

    if (
      normalizedAction === AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackWaitingUser
      && incident.lifecycle_sink !== "waiting_user"
    ) {
      return {
        ok: false,
        error: "operator_action_lifecycle_sink_mismatch",
      };
    }
    if (
      normalizedAction === AUTONOMY_OPERATOR_DISPOSITION_ACTION.ackEscalated
      && incident.lifecycle_sink !== "escalated"
    ) {
      return {
        ok: false,
        error: "operator_action_lifecycle_sink_mismatch",
      };
    }

    const now = nowIso();
    const normalizedReason = cleanText(reason) || null;
    const currentJob = getAutonomyJobById(normalizedJobId);
    const replaySpec = buildAutonomyIncidentReplaySpec({
      incident,
      action: normalizedAction,
      reason: normalizedReason,
      generatedAt: now,
    });
    const nextError = mergeOperatorDispositionErrorMetadata({
      error: currentJob?.error,
      at: now,
      action: normalizedAction,
      reason: normalizedReason,
      operatorId: normalizedOperatorId,
      requestId: normalizedRequestId,
      expectedUpdatedAt: normalizedExpectedUpdatedAt,
      replaySpec,
    });

    if (normalizedAction === AUTONOMY_OPERATOR_DISPOSITION_ACTION.resumeSameJob) {
      const updated = db.prepare(`
        UPDATE autonomy_jobs
        SET status = @queued_status,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_run_at = @next_run_at,
            max_attempts = CASE
              WHEN max_attempts <= attempt_count THEN attempt_count + 1
              ELSE max_attempts
            END,
            failed_at = NULL,
            updated_at = @updated_at,
            error_json = @error_json
        WHERE id = @job_id
          AND status = @failed_status
          AND (@expected_updated_at IS NULL OR updated_at = @expected_updated_at)
      `).run({
        job_id: normalizedJobId,
        queued_status: AUTONOMY_JOB_STATUS.queued,
        failed_status: AUTONOMY_JOB_STATUS.failed,
        expected_updated_at: normalizedExpectedUpdatedAt,
        next_run_at: now,
        updated_at: now,
        error_json: stringifyJson(nextError),
      });
      if (Number(updated.changes || 0) !== 1) {
        if (normalizedExpectedUpdatedAt) {
          const staleRow = db.prepare(`
            SELECT id, status, updated_at
            FROM autonomy_jobs
            WHERE id = @job_id
            LIMIT 1
          `).get({
            job_id: normalizedJobId,
          });
          if (staleRow) {
            return {
              ok: false,
              error: "precondition_failed",
              stale: true,
              expected_updated_at: normalizedExpectedUpdatedAt,
              current_updated_at: cleanText(staleRow.updated_at) || null,
            };
          }
        }
        return {
          ok: false,
          error: "open_incident_not_found",
        };
      }
    } else {
      const updated = db.prepare(`
        UPDATE autonomy_jobs
        SET updated_at = @updated_at,
            error_json = @error_json
        WHERE id = @job_id
          AND status = @failed_status
          AND (@expected_updated_at IS NULL OR updated_at = @expected_updated_at)
      `).run({
        job_id: normalizedJobId,
        failed_status: AUTONOMY_JOB_STATUS.failed,
        expected_updated_at: normalizedExpectedUpdatedAt,
        updated_at: now,
        error_json: stringifyJson(nextError),
      });
      if (Number(updated.changes || 0) !== 1) {
        if (normalizedExpectedUpdatedAt) {
          const staleRow = db.prepare(`
            SELECT id, status, updated_at
            FROM autonomy_jobs
            WHERE id = @job_id
            LIMIT 1
          `).get({
            job_id: normalizedJobId,
          });
          if (staleRow) {
            return {
              ok: false,
              error: "precondition_failed",
              stale: true,
              expected_updated_at: normalizedExpectedUpdatedAt,
              current_updated_at: cleanText(staleRow.updated_at) || null,
            };
          }
        }
        return {
          ok: false,
          error: "open_incident_not_found",
        };
      }
    }

    return {
      ok: true,
      rescheduled: normalizedAction === AUTONOMY_OPERATOR_DISPOSITION_ACTION.resumeSameJob,
      disposition: {
        at: now,
        action: normalizedAction,
        reason: normalizedReason,
        operator_id: normalizedOperatorId,
        request_id: normalizedRequestId,
        expected_updated_at: normalizedExpectedUpdatedAt,
      },
      replay_spec: replaySpec,
      incident,
      job: getAutonomyJobById(normalizedJobId),
    };
  });

  return dispositionTx();
}
