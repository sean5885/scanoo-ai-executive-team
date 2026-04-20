import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  startAutonomyRuntimeManager,
  stopAutonomyRuntimeManager,
  getAutonomyRuntimeManagerStatus,
} = await import("../src/worker/autonomy-runtime-manager.mjs");

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

test.after(() => {
  stopAutonomyRuntimeManager({ logger: noopLogger });
  testDb.close();
});

test.beforeEach(() => {
  stopAutonomyRuntimeManager({ logger: noopLogger });
});

test("autonomy runtime manager start/stop is fail-soft and non-throwing", () => {
  let stopCalled = 0;
  let clearCalled = 0;

  const started = startAutonomyRuntimeManager({
    logger: noopLogger,
    enabled: true,
    workerId: "runtime-manager-start-stop",
    startWorkerLoop() {
      return {
        started: true,
        worker_id: "runtime-manager-start-stop",
        stop() {
          stopCalled += 1;
        },
      };
    },
    heartbeatWorker() {
      return {
        ok: true,
        heartbeat_at: new Date().toISOString(),
      };
    },
    setIntervalFn() {
      return "timer-start-stop";
    },
    clearIntervalFn(timerId) {
      assert.equal(timerId, "timer-start-stop");
      clearCalled += 1;
    },
  });

  assert.equal(started.status, "running");
  assert.equal(getAutonomyRuntimeManagerStatus().status, "running");

  const stopped = stopAutonomyRuntimeManager({
    logger: noopLogger,
    clearIntervalFn(timerId) {
      assert.equal(timerId, "timer-start-stop");
      clearCalled += 1;
    },
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopCalled, 1);
  assert.equal(clearCalled, 1);
});

test("autonomy runtime manager prevents double start", () => {
  let workerStartCount = 0;

  const startWorkerLoop = () => {
    workerStartCount += 1;
    return {
      started: true,
      worker_id: "runtime-manager-reentry",
      stop() {},
    };
  };

  const first = startAutonomyRuntimeManager({
    logger: noopLogger,
    enabled: true,
    workerId: "runtime-manager-reentry",
    startWorkerLoop,
    heartbeatWorker() {
      return { ok: true, heartbeat_at: new Date().toISOString() };
    },
    setIntervalFn() {
      return "timer-reentry";
    },
  });
  assert.equal(first.status, "running");
  assert.equal(workerStartCount, 1);

  const second = startAutonomyRuntimeManager({
    logger: noopLogger,
    enabled: true,
    workerId: "runtime-manager-reentry",
    startWorkerLoop,
    heartbeatWorker() {
      return { ok: true, heartbeat_at: new Date().toISOString() };
    },
    setIntervalFn() {
      return "timer-should-not-be-used";
    },
  });

  assert.equal(second.status, "running");
  assert.equal(second.reason, "already_running");
  assert.equal(workerStartCount, 1);
});

test("autonomy runtime manager triggers idle heartbeat timer callback", () => {
  let heartbeatCalls = 0;
  let timerTick = null;

  const status = startAutonomyRuntimeManager({
    logger: noopLogger,
    enabled: true,
    workerId: "runtime-manager-heartbeat",
    startWorkerLoop() {
      return {
        started: true,
        worker_id: "runtime-manager-heartbeat",
        stop() {},
      };
    },
    heartbeatWorker() {
      heartbeatCalls += 1;
      return {
        ok: true,
        heartbeat_at: new Date().toISOString(),
      };
    },
    setIntervalFn(callback) {
      timerTick = callback;
      return "timer-heartbeat";
    },
  });

  assert.equal(status.status, "running");
  assert.equal(heartbeatCalls, 1);
  assert.equal(typeof timerTick, "function");

  timerTick();
  assert.equal(heartbeatCalls, 2);
});
