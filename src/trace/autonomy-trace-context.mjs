import crypto from "node:crypto";

import { cleanText } from "../message-intent-utils.mjs";

export function createAutonomyTraceId(prefix = "autonomy") {
  const normalizedPrefix = cleanText(prefix) || "autonomy";
  return `${normalizedPrefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createAutonomyTraceContext({
  traceId = "",
  jobId = "",
  attemptId = "",
  workerId = "",
  source = "",
} = {}) {
  return {
    trace_id: cleanText(traceId) || createAutonomyTraceId("autonomy"),
    job_id: cleanText(jobId) || null,
    attempt_id: cleanText(attemptId) || null,
    worker_id: cleanText(workerId) || null,
    source: cleanText(source) || null,
  };
}

export function buildAutonomyTraceFields({
  traceContext = null,
  fields = null,
} = {}) {
  const context = traceContext && typeof traceContext === "object" && !Array.isArray(traceContext)
    ? traceContext
    : {};
  const payload = fields && typeof fields === "object" && !Array.isArray(fields)
    ? fields
    : {};
  return {
    ...payload,
    trace_id: cleanText(context.trace_id) || null,
    job_id: cleanText(context.job_id) || null,
    attempt_id: cleanText(context.attempt_id) || null,
    worker_id: cleanText(context.worker_id) || null,
    trace_source: cleanText(context.source) || null,
  };
}

export function createAutonomyJobAttemptTraceContext({
  job = null,
  attempt = null,
  workerId = "",
  traceId = "",
  source = "",
} = {}) {
  return createAutonomyTraceContext({
    traceId: cleanText(traceId) || cleanText(job?.trace_id) || cleanText(attempt?.trace_id),
    jobId: cleanText(job?.id || attempt?.job_id),
    attemptId: cleanText(attempt?.id),
    workerId,
    source: cleanText(source) || "autonomy_worker_loop",
  });
}
