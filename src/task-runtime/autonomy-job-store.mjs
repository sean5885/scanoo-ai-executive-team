import crypto from "node:crypto";

import db from "../db.mjs";
import { cleanText } from "../message-intent-utils.mjs";
import { nowIso } from "../text-utils.mjs";
import {
  AUTONOMY_JOB_ATTEMPT_STATUS,
  AUTONOMY_JOB_STATUS,
  DEFAULT_AUTONOMY_LEASE_MS,
  DEFAULT_AUTONOMY_MAX_ATTEMPTS,
  normalizePositiveInteger,
} from "./autonomy-job-types.mjs";

let autonomyTablesReady = false;

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

    CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_claim
    ON autonomy_jobs(status, next_run_at, lease_expires_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_trace
    ON autonomy_jobs(trace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_autonomy_job_attempts_job
    ON autonomy_job_attempts(job_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_autonomy_job_attempts_trace
    ON autonomy_job_attempts(trace_id, created_at DESC);
  `);

  autonomyTablesReady = true;
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

    return {
      ok: true,
      lease_expires_at: leaseExpiresAt,
      job: getAutonomyJobById(normalizedJobId),
      attempt: getAutonomyJobAttemptById(normalizedAttemptId),
    };
  });

  return heartbeatTx();
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
      error_json: stringifyJson(error),
    });
    if (Number(attemptUpdate.changes || 0) !== 1) {
      return {
        ok: false,
        error: "attempt_not_running",
      };
    }

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
      error_json: stringifyJson(error),
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
