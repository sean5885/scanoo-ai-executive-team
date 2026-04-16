import { cleanText } from "../message-intent-utils.mjs";
import { enqueueAutonomyJobRecord } from "../task-runtime/autonomy-job-store.mjs";
import {
  DEFAULT_AUTONOMY_MAX_ATTEMPTS,
  isAutonomyEnabled,
  normalizePositiveInteger,
} from "../task-runtime/autonomy-job-types.mjs";
import {
  buildAutonomyTraceFields,
  createAutonomyTraceContext,
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

export async function enqueueAutonomyJob({
  jobType = "",
  payload = null,
  traceId = "",
  maxAttempts = DEFAULT_AUTONOMY_MAX_ATTEMPTS,
  notBeforeAt = "",
  logger = null,
  enabled = null,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const autonomyEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  const normalizedJobType = cleanText(jobType);

  if (!normalizedJobType) {
    return {
      ok: false,
      error: "missing_job_type",
    };
  }

  if (!autonomyEnabled) {
    const disabledTraceContext = createAutonomyTraceContext({
      traceId,
      source: "enqueue_autonomy_job",
    });
    resolvedLogger.info("autonomy_enqueue_skipped", buildAutonomyTraceFields({
      traceContext: disabledTraceContext,
      fields: {
        reason: "autonomy_disabled",
        job_type: normalizedJobType,
      },
    }));
    return {
      ok: false,
      skipped: true,
      reason: "autonomy_disabled",
      trace_id: disabledTraceContext.trace_id,
    };
  }

  const job = enqueueAutonomyJobRecord({
    jobType: normalizedJobType,
    payload,
    traceId,
    maxAttempts: normalizePositiveInteger(maxAttempts, DEFAULT_AUTONOMY_MAX_ATTEMPTS),
    notBeforeAt,
  });

  if (!job?.id) {
    return {
      ok: false,
      error: "autonomy_enqueue_failed",
    };
  }

  const traceContext = createAutonomyTraceContext({
    traceId: cleanText(traceId) || cleanText(job.trace_id),
    jobId: job.id,
    source: "enqueue_autonomy_job",
  });
  resolvedLogger.info("autonomy_job_enqueued", buildAutonomyTraceFields({
    traceContext,
    fields: {
      job_type: job.job_type,
      status: job.status,
      max_attempts: job.max_attempts,
    },
  }));

  return {
    ok: true,
    action: "enqueue_autonomy_job",
    job_id: job.id,
    status: job.status,
    trace_id: traceContext.trace_id,
    job,
  };
}
