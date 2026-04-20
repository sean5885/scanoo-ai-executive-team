import { cleanText } from "../message-intent-utils.mjs";
import { nowIso } from "../text-utils.mjs";
import { heartbeatAutonomyWorker } from "../task-runtime/autonomy-job-store.mjs";
import {
  DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_AUTONOMY_LEASE_MS,
  DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  isAutonomyEnabled,
  normalizePositiveInteger,
} from "../task-runtime/autonomy-job-types.mjs";
import { startAutonomyWorkerLoop } from "./autonomy-worker-loop.mjs";

const RUNTIME_MANAGER_STATUS = Object.freeze({
  running: "running",
  stopped: "stopped",
  error: "error",
});
const DEFAULT_IDLE_HEARTBEAT_INTERVAL_MS = 3_000;

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

const runtimeState = {
  status: RUNTIME_MANAGER_STATUS.stopped,
  workerId: null,
  startedAt: null,
  stoppedAt: null,
  lastHeartbeatAt: null,
  error: null,
  pollIntervalMs: DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  workerHeartbeatIntervalMs: DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  idleHeartbeatIntervalMs: DEFAULT_IDLE_HEARTBEAT_INTERVAL_MS,
  workerLoopHandle: null,
  heartbeatTimer: null,
};

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return noopLogger;
}

function compactError(error) {
  if (error instanceof Error) {
    return {
      name: cleanText(error.name) || "Error",
      message: cleanText(error.message) || "runtime_error",
      stack: cleanText(error.stack) || null,
    };
  }
  return {
    name: "RuntimeError",
    message: cleanText(error) || "runtime_error",
    stack: null,
  };
}

function readRuntimeStatus() {
  return {
    status: runtimeState.status,
    worker_id: runtimeState.workerId,
    started_at: runtimeState.startedAt,
    stopped_at: runtimeState.stoppedAt,
    last_heartbeat_at: runtimeState.lastHeartbeatAt,
    poll_interval_ms: runtimeState.pollIntervalMs,
    worker_heartbeat_interval_ms: runtimeState.workerHeartbeatIntervalMs,
    idle_heartbeat_interval_ms: runtimeState.idleHeartbeatIntervalMs,
    error: runtimeState.error,
  };
}

function clearRuntimeHandles({
  clearIntervalFn = clearInterval,
} = {}) {
  if (runtimeState.heartbeatTimer) {
    try {
      clearIntervalFn(runtimeState.heartbeatTimer);
    } catch {}
    runtimeState.heartbeatTimer = null;
  }
  if (runtimeState.workerLoopHandle && typeof runtimeState.workerLoopHandle.stop === "function") {
    try {
      runtimeState.workerLoopHandle.stop();
    } catch {}
  }
  runtimeState.workerLoopHandle = null;
}

export function getAutonomyRuntimeManagerStatus() {
  return readRuntimeStatus();
}

export function startAutonomyRuntimeManager({
  logger = null,
  workerId = "",
  enabled = null,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  pollIntervalMs = DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  workerHeartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  idleHeartbeatIntervalMs = DEFAULT_IDLE_HEARTBEAT_INTERVAL_MS,
  executeJob = null,
  plannerExecutor = undefined,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  startWorkerLoop = startAutonomyWorkerLoop,
  heartbeatWorker = heartbeatAutonomyWorker,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  if (runtimeState.status === RUNTIME_MANAGER_STATUS.running) {
    resolvedLogger.info("autonomy_runtime_manager_already_running", {
      worker_id: runtimeState.workerId,
      status: runtimeState.status,
    });
    return {
      ok: true,
      started: false,
      reason: "already_running",
      ...readRuntimeStatus(),
    };
  }

  clearRuntimeHandles({ clearIntervalFn });
  runtimeState.error = null;

  const normalizedWorkerId = cleanText(workerId) || `autonomy-runtime-worker-${process.pid}`;
  const normalizedEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  const normalizedPollIntervalMs = normalizePositiveInteger(
    pollIntervalMs,
    DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
    { min: 250, max: 600_000 },
  );
  const normalizedWorkerHeartbeatIntervalMs = normalizePositiveInteger(
    workerHeartbeatIntervalMs,
    DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
    { min: 250, max: 600_000 },
  );
  const normalizedIdleHeartbeatIntervalMs = normalizePositiveInteger(
    idleHeartbeatIntervalMs,
    DEFAULT_IDLE_HEARTBEAT_INTERVAL_MS,
    { min: 2_000, max: 5_000 },
  );

  runtimeState.workerId = normalizedWorkerId;
  runtimeState.pollIntervalMs = normalizedPollIntervalMs;
  runtimeState.workerHeartbeatIntervalMs = normalizedWorkerHeartbeatIntervalMs;
  runtimeState.idleHeartbeatIntervalMs = normalizedIdleHeartbeatIntervalMs;
  runtimeState.startedAt = null;
  runtimeState.stoppedAt = null;
  runtimeState.lastHeartbeatAt = null;

  if (!normalizedEnabled) {
    runtimeState.status = RUNTIME_MANAGER_STATUS.stopped;
    runtimeState.error = {
      reason: "autonomy_disabled",
      message: "autonomy_runtime_manager_disabled",
      at: nowIso(),
    };
    resolvedLogger.info("autonomy_runtime_manager_not_started", {
      worker_id: normalizedWorkerId,
      reason: "autonomy_disabled",
    });
    return {
      ok: true,
      started: false,
      reason: "autonomy_disabled",
      ...readRuntimeStatus(),
    };
  }

  const writeIdleHeartbeat = () => {
    try {
      const heartbeat = heartbeatWorker({
        workerId: normalizedWorkerId,
        leaseMs,
      });
      if (heartbeat?.ok !== true) {
        runtimeState.status = RUNTIME_MANAGER_STATUS.error;
        runtimeState.error = {
          reason: cleanText(heartbeat?.error) || "heartbeat_failed",
          message: "autonomy_runtime_manager_heartbeat_failed",
          at: nowIso(),
        };
        resolvedLogger.warn("autonomy_runtime_manager_heartbeat_failed", {
          worker_id: normalizedWorkerId,
          error: runtimeState.error.reason,
        });
        return;
      }
      runtimeState.lastHeartbeatAt = cleanText(heartbeat.heartbeat_at) || nowIso();
      runtimeState.status = RUNTIME_MANAGER_STATUS.running;
      runtimeState.error = null;
    } catch (error) {
      runtimeState.status = RUNTIME_MANAGER_STATUS.error;
      runtimeState.error = {
        reason: "runtime_exception",
        message: "autonomy_runtime_manager_heartbeat_exception",
        details: compactError(error),
        at: nowIso(),
      };
      resolvedLogger.error("autonomy_runtime_manager_heartbeat_exception", {
        worker_id: normalizedWorkerId,
        error: runtimeState.error.details,
      });
    }
  };

  try {
    const workerLoopArgs = {
      workerId: normalizedWorkerId,
      logger: resolvedLogger,
      enabled: true,
      pollIntervalMs: normalizedPollIntervalMs,
      leaseMs,
      heartbeatIntervalMs: normalizedWorkerHeartbeatIntervalMs,
    };
    if (typeof executeJob === "function") {
      workerLoopArgs.executeJob = executeJob;
    }
    if (typeof plannerExecutor === "function") {
      workerLoopArgs.plannerExecutor = plannerExecutor;
    }

    const workerLoopHandle = startWorkerLoop(workerLoopArgs);
    if (!workerLoopHandle || workerLoopHandle.started !== true) {
      runtimeState.status = RUNTIME_MANAGER_STATUS.error;
      runtimeState.error = {
        reason: "worker_loop_not_started",
        message: "autonomy_runtime_manager_worker_not_started",
        at: nowIso(),
      };
      resolvedLogger.warn("autonomy_runtime_manager_worker_not_started", {
        worker_id: normalizedWorkerId,
      });
      return {
        ok: false,
        started: false,
        reason: "worker_loop_not_started",
        ...readRuntimeStatus(),
      };
    }
    runtimeState.workerLoopHandle = workerLoopHandle;
    runtimeState.heartbeatTimer = setIntervalFn(() => {
      writeIdleHeartbeat();
    }, normalizedIdleHeartbeatIntervalMs);
    writeIdleHeartbeat();
    runtimeState.status = RUNTIME_MANAGER_STATUS.running;
    runtimeState.startedAt = nowIso();

    resolvedLogger.info("autonomy_runtime_manager_started", {
      worker_id: normalizedWorkerId,
      poll_interval_ms: normalizedPollIntervalMs,
      heartbeat_interval_ms: normalizedIdleHeartbeatIntervalMs,
    });

    return {
      ok: true,
      started: true,
      ...readRuntimeStatus(),
    };
  } catch (error) {
    clearRuntimeHandles({ clearIntervalFn });
    runtimeState.status = RUNTIME_MANAGER_STATUS.error;
    runtimeState.error = {
      reason: "runtime_exception",
      message: "autonomy_runtime_manager_start_failed",
      details: compactError(error),
      at: nowIso(),
    };
    resolvedLogger.error("autonomy_runtime_manager_start_failed", {
      worker_id: normalizedWorkerId,
      error: runtimeState.error.details,
    });
    return {
      ok: false,
      started: false,
      reason: "runtime_exception",
      ...readRuntimeStatus(),
    };
  }
}

export function stopAutonomyRuntimeManager({
  logger = null,
  clearIntervalFn = clearInterval,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const normalizedWorkerId = cleanText(runtimeState.workerId) || null;
  let stopError = null;

  if (runtimeState.heartbeatTimer) {
    try {
      clearIntervalFn(runtimeState.heartbeatTimer);
    } catch (error) {
      stopError = compactError(error);
    }
    runtimeState.heartbeatTimer = null;
  }

  if (runtimeState.workerLoopHandle && typeof runtimeState.workerLoopHandle.stop === "function") {
    try {
      runtimeState.workerLoopHandle.stop();
    } catch (error) {
      stopError = compactError(error);
    }
  }
  runtimeState.workerLoopHandle = null;

  runtimeState.stoppedAt = nowIso();
  if (stopError) {
    runtimeState.status = RUNTIME_MANAGER_STATUS.error;
    runtimeState.error = {
      reason: "runtime_exception",
      message: "autonomy_runtime_manager_stop_failed",
      details: stopError,
      at: runtimeState.stoppedAt,
    };
    resolvedLogger.error("autonomy_runtime_manager_stop_failed", {
      worker_id: normalizedWorkerId,
      error: stopError,
    });
  } else {
    runtimeState.status = RUNTIME_MANAGER_STATUS.stopped;
    runtimeState.error = null;
    resolvedLogger.info("autonomy_runtime_manager_stopped", {
      worker_id: normalizedWorkerId,
    });
  }

  return readRuntimeStatus();
}
