import { cleanText } from "../message-intent-utils.mjs";
import {
  claimNextAutonomyJob,
  completeAutonomyAttempt,
  failAutonomyAttempt,
  heartbeatAutonomyAttempt,
} from "../task-runtime/autonomy-job-store.mjs";
import {
  DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_AUTONOMY_LEASE_MS,
  DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  isAutonomyEnabled,
  normalizePositiveInteger,
} from "../task-runtime/autonomy-job-types.mjs";
import {
  buildAutonomyTraceFields,
  createAutonomyJobAttemptTraceContext,
} from "../trace/autonomy-trace-context.mjs";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return noopLogger;
}

function buildNormalizedError(error) {
  if (error instanceof Error) {
    return {
      name: cleanText(error.name) || "Error",
      message: cleanText(error.message) || "unknown_error",
      stack: cleanText(error.stack) || null,
    };
  }
  return {
    name: "RuntimeError",
    message: cleanText(error) || "unknown_error",
  };
}

function shouldResultBeTreatedAsFailure(result = null) {
  return result && typeof result === "object" && result.ok === false;
}

export async function runAutonomyWorkerOnce({
  workerId = "",
  executeJob = async () => ({ ok: true }),
  logger = null,
  enabled = null,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  heartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedWorkerId) {
    return {
      ok: false,
      error: "missing_worker_id",
    };
  }

  const autonomyEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  if (!autonomyEnabled) {
    return {
      ok: true,
      skipped: true,
      reason: "autonomy_disabled",
    };
  }

  const claim = claimNextAutonomyJob({
    workerId: normalizedWorkerId,
    leaseMs: normalizePositiveInteger(leaseMs, DEFAULT_AUTONOMY_LEASE_MS),
  });
  if (!claim?.job?.id || !claim?.attempt?.id) {
    if (claim?.skipped) {
      return {
        ok: true,
        claimed: false,
        skipped: true,
        reason: cleanText(claim.reason) || "claim_skipped",
      };
    }
    return {
      ok: true,
      claimed: false,
    };
  }

  const traceContext = createAutonomyJobAttemptTraceContext({
    job: claim.job,
    attempt: claim.attempt,
    workerId: normalizedWorkerId,
    source: "autonomy_worker_loop",
  });
  resolvedLogger.info("autonomy_job_claimed", buildAutonomyTraceFields({
    traceContext,
    fields: {
      job_type: claim.job.job_type,
      status: claim.job.status,
    },
  }));

  const normalizedHeartbeatIntervalMs = normalizePositiveInteger(
    heartbeatIntervalMs,
    DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  );
  let heartbeatTimer = null;
  const beginHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      const heartbeat = heartbeatAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        leaseMs,
      });
      if (heartbeat?.ok !== true) {
        resolvedLogger.warn("autonomy_job_heartbeat_failed", buildAutonomyTraceFields({
          traceContext,
          fields: {
            error: cleanText(heartbeat?.error) || "heartbeat_failed",
          },
        }));
      }
    }, normalizedHeartbeatIntervalMs);
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  beginHeartbeat();
  try {
    const executionResult = await executeJob({
      job: claim.job,
      attempt: claim.attempt,
      traceContext,
      logger: resolvedLogger,
    });

    if (shouldResultBeTreatedAsFailure(executionResult)) {
      const normalizedFailure = {
        error: cleanText(executionResult.error) || "job_execution_failed",
        data: executionResult.data || null,
      };
      failAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        error: normalizedFailure,
      });
      resolvedLogger.warn("autonomy_job_failed", buildAutonomyTraceFields({
        traceContext,
        fields: normalizedFailure,
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        job_id: claim.job.id,
        attempt_id: claim.attempt.id,
        trace_id: traceContext.trace_id,
      };
    }

    const complete = completeAutonomyAttempt({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: normalizedWorkerId,
      result: executionResult,
    });
    if (complete?.ok !== true) {
      resolvedLogger.warn("autonomy_job_complete_failed", buildAutonomyTraceFields({
        traceContext,
        fields: {
          error: cleanText(complete?.error) || "complete_failed",
        },
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        error: cleanText(complete?.error) || "complete_failed",
      };
    }

    resolvedLogger.info("autonomy_job_completed", buildAutonomyTraceFields({
      traceContext,
      fields: {
        status: cleanText(complete?.job?.status) || "completed",
      },
    }));
    return {
      ok: true,
      claimed: true,
      completed: true,
      job_id: claim.job.id,
      attempt_id: claim.attempt.id,
      trace_id: traceContext.trace_id,
      result: executionResult,
    };
  } catch (error) {
    const normalizedError = buildNormalizedError(error);
    const failed = failAutonomyAttempt({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: normalizedWorkerId,
      error: normalizedError,
    });
    resolvedLogger.error("autonomy_job_failed", buildAutonomyTraceFields({
      traceContext,
      fields: {
        error: normalizedError.message,
        retry_scheduled: failed?.retry_scheduled === true,
      },
    }));
    return {
      ok: false,
      claimed: true,
      failed: true,
      job_id: claim.job.id,
      attempt_id: claim.attempt.id,
      trace_id: traceContext.trace_id,
      error: normalizedError,
      retry_scheduled: failed?.retry_scheduled === true,
    };
  } finally {
    stopHeartbeat();
  }
}

export function startAutonomyWorkerLoop({
  workerId = "",
  executeJob = async () => ({ ok: true }),
  logger = null,
  enabled = null,
  pollIntervalMs = DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  heartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const normalizedWorkerId = cleanText(workerId) || `autonomy-worker-${process.pid}`;
  const autonomyEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  if (!autonomyEnabled) {
    resolvedLogger.info("autonomy_worker_loop_not_started", {
      worker_id: normalizedWorkerId,
      reason: "autonomy_disabled",
    });
    return {
      started: false,
      worker_id: normalizedWorkerId,
      stop() {},
    };
  }

  let running = false;
  let stopped = false;
  const interval = normalizePositiveInteger(
    pollIntervalMs,
    DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
    { min: 250, max: 600_000 },
  );

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await runAutonomyWorkerOnce({
        workerId: normalizedWorkerId,
        executeJob,
        logger: resolvedLogger,
        leaseMs,
        heartbeatIntervalMs,
        enabled: true,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);
  void tick();

  resolvedLogger.info("autonomy_worker_loop_started", {
    worker_id: normalizedWorkerId,
    poll_interval_ms: interval,
  });

  return {
    started: true,
    worker_id: normalizedWorkerId,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      resolvedLogger.info("autonomy_worker_loop_stopped", {
        worker_id: normalizedWorkerId,
      });
    },
  };
}
