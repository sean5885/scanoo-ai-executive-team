import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { createLongConnectionLifecycleMonitor } = await import("../src/long-connection-lifecycle-monitor.mjs");

test.after(() => {
  testDb.close();
});

function createLoggerCalls() {
  const calls = [];

  function createLogger(component = "long_connection", baseFields = {}) {
    return {
      info(event, payload = {}) {
        calls.push({ level: "info", component, event, payload: { ...baseFields, ...payload } });
      },
      warn(event, payload = {}) {
        calls.push({ level: "warn", component, event, payload: { ...baseFields, ...payload } });
      },
      error(event, payload = {}) {
        calls.push({ level: "error", component, event, payload: { ...baseFields, ...payload } });
      },
      child(nextComponent, childFields = {}) {
        return createLogger(`${component}.${nextComponent}`, {
          ...baseFields,
          ...(childFields && typeof childFields === "object" ? childFields : {}),
        });
      },
    };
  }

  return {
    calls,
    logger: createLogger(),
  };
}

class FakeWsInstance extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }
}

class FakeWsClient {
  constructor(instance) {
    this.instance = instance;
    this.reconnectCalls = [];
    this.closeCalls = [];
    this.connectCalls = 0;
    this.dataCache = {
      mergeData(params) {
        return params?.data || null;
      },
    };
    this.wsConfig = {
      getWSInstance: () => this.instance,
      getWS: () => ({
        pingInterval: 1000,
      }),
    };
  }

  async connect() {
    this.connectCalls += 1;
    return true;
  }

  async reConnect(isStart = false) {
    this.reconnectCalls.push(isStart);
    return true;
  }

  pingLoop() {}

  async handleControlData(frame) {
    return frame;
  }

  async handleEventData(frame) {
    return frame;
  }

  close(params = {}) {
    this.closeCalls.push(params);
    return true;
  }

  getReconnectInfo() {
    return {
      lastConnectTime: 0,
      nextConnectTime: 0,
    };
  }
}

test("long connection lifecycle monitor exits when websocket ingress stays idle past the watchdog threshold", async () => {
  let now = Date.UTC(2026, 2, 31, 14, 30, 0);
  const exitCodes = [];
  const { calls, logger } = createLoggerCalls();
  const wsInstance = new FakeWsInstance();
  const wsClient = new FakeWsClient(wsInstance);

  const monitor = createLongConnectionLifecycleMonitor({
    wsClient,
    logger,
    now: () => now,
    watchdogIdleMs: 5_000,
    watchdogCheckIntervalMs: 60_000,
    onExit(code) {
      exitCodes.push(code);
    },
  });

  await wsClient.connect();
  wsInstance.emit("pong");
  now += 4_000;
  assert.equal(monitor.runWatchdogCheck(), false);

  now += 2_000;
  assert.equal(monitor.runWatchdogCheck(), true);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(calls.some((entry) => entry.event === "ws_watchdog_triggered"), true);

  monitor.stop();
});

test("long connection lifecycle monitor records ingress events and reconnect lifecycle", async () => {
  let now = Date.UTC(2026, 2, 31, 14, 45, 0);
  const { calls, logger } = createLoggerCalls();
  const wsInstance = new FakeWsInstance();
  const wsClient = new FakeWsClient(wsInstance);

  const monitor = createLongConnectionLifecycleMonitor({
    wsClient,
    logger,
    now: () => now,
    watchdogIdleMs: 5_000,
    watchdogCheckIntervalMs: 60_000,
    onExit() {
      throw new Error("watchdog should not exit in this test");
    },
  });

  await wsClient.reConnect(true);
  await wsClient.connect();
  wsInstance.emit("message", Buffer.from("frame"));
  now += 500;
  monitor.markIngressEvent({
    trace_id: "evt_live_1",
    event_id: "om_event_live_1",
  });

  const state = monitor.getState();
  assert.ok(Number.isFinite(state.lastIngressAt));
  assert.equal(state.readyState, "open");
  assert.equal(calls.some((entry) => entry.event === "ws_start_requested"), true);
  assert.equal(calls.some((entry) => entry.event === "ws_opened"), true);
  assert.equal(calls.some((entry) => entry.event === "ws_message_received"), true);
  assert.equal(calls.some((entry) => entry.event === "ws_ingress_event_observed"), true);

  monitor.stop();
});

test("long connection lifecycle monitor classifies decoded event payloads and dispatcher attempts", async () => {
  const { calls, logger } = createLoggerCalls();
  const wsInstance = new FakeWsInstance();
  const wsClient = new FakeWsClient(wsInstance);
  const eventDispatcher = {
    handles: new Map([
      ["im.message.receive_v1", async () => undefined],
    ]),
    async invoke() {
      return "handled";
    },
  };

  const monitor = createLongConnectionLifecycleMonitor({
    wsClient,
    eventDispatcher,
    logger,
    watchdogIdleMs: 5_000,
    watchdogCheckIntervalMs: 60_000,
  });

  wsClient.dataCache.mergeData({
    message_id: "om_ws_1",
    trace_id: "trace_ws_1",
    sum: 1,
    seq: 0,
    data: {
      schema: "2.0",
      header: {
        event_type: "im.message.receive_v1",
      },
      event: {
        message: {
          message_id: "om_event_1",
        },
      },
    },
  });
  await eventDispatcher.invoke({
    schema: "2.0",
    header: {
      event_type: "im.message.receive_v1",
    },
    event: {},
  }, { needCheck: false });

  assert.equal(calls.some((entry) => entry.event === "ws_event_payload_classified"), true);
  assert.equal(calls.some((entry) => entry.event === "ws_event_dispatch_attempted"), true);
  assert.equal(calls.some((entry) => entry.event === "ws_event_dispatch_completed"), true);
  assert.equal(
    calls.some((entry) => entry.event === "ws_event_payload_classified" && entry.payload.parsed_event_type === "im.message.receive_v1"),
    true,
  );

  monitor.stop();
});
