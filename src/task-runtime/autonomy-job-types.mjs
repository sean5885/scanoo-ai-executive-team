import { cleanText } from "../message-intent-utils.mjs";

export const AUTONOMY_JOB_STATUS = Object.freeze({
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
});

export const AUTONOMY_JOB_ATTEMPT_STATUS = Object.freeze({
  running: "running",
  completed: "completed",
  failed: "failed",
});

export const AUTONOMY_JOB_STATUS_VALUES = Object.freeze(Object.values(AUTONOMY_JOB_STATUS));
export const AUTONOMY_JOB_ATTEMPT_STATUS_VALUES = Object.freeze(Object.values(AUTONOMY_JOB_ATTEMPT_STATUS));

export const DEFAULT_AUTONOMY_MAX_ATTEMPTS = 1;
export const DEFAULT_AUTONOMY_LEASE_MS = 30_000;
export const DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_AUTONOMY_POLL_INTERVAL_MS = 5_000;

export function normalizeAutonomyJobStatus(status = "") {
  const normalized = cleanText(status).toLowerCase();
  return AUTONOMY_JOB_STATUS_VALUES.includes(normalized) ? normalized : AUTONOMY_JOB_STATUS.queued;
}

export function normalizeAutonomyJobAttemptStatus(status = "") {
  const normalized = cleanText(status).toLowerCase();
  return AUTONOMY_JOB_ATTEMPT_STATUS_VALUES.includes(normalized)
    ? normalized
    : AUTONOMY_JOB_ATTEMPT_STATUS.running;
}

export function normalizePositiveInteger(value, fallback = 1, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function isAutonomyEnabled(value = process.env.AUTONOMY_ENABLED) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
