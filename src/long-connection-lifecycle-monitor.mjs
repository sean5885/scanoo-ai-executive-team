import { emitRateLimitedAlert, formatIdentifierHint } from "./runtime-observability.mjs";

const OPEN_READY_STATE = 1;
const DEFAULT_WATCHDOG_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_WATCHDOG_CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_WATCHDOG_PING_MULTIPLIER = 3;
const WS_MONITOR_ATTACHED = Symbol.for("playground.ws.lifecycle_monitor_attached");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveConfiguredIdleMs() {
  return parsePositiveInt(
    process.env.LARK_LONG_CONNECTION_WATCHDOG_IDLE_MS,
    DEFAULT_WATCHDOG_IDLE_MS,
  );
}

function resolveConfiguredCheckIntervalMs() {
  return parsePositiveInt(
    process.env.LARK_LONG_CONNECTION_WATCHDOG_CHECK_INTERVAL_MS,
    DEFAULT_WATCHDOG_CHECK_INTERVAL_MS,
  );
}

function toIsoTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function normalizeReadyState(value) {
  if (value === OPEN_READY_STATE) {
    return "open";
  }
  if (value === 0) {
    return "connecting";
  }
  if (value === 2) {
    return "closing";
  }
  if (value === 3) {
    return "closed";
  }
  return "unknown";
}

function decodeCloseReason(reason) {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Uint8Array || Buffer.isBuffer(reason)) {
    const text = Buffer.from(reason).toString("utf8").trim();
    return text || null;
  }
  return null;
}

function latestTimestamp(values = []) {
  let current = null;
  for (const value of values) {
    if (Number.isFinite(value) && (current === null || value > current)) {
      current = value;
    }
  }
  return current;
}

function getReconnectInfo(wsClient) {
  try {
    const info = wsClient?.getReconnectInfo?.();
    if (!info || typeof info !== "object") {
      return null;
    }
    return {
      last_connect_time: toIsoTimestamp(Number(info.lastConnectTime)),
      next_connect_time: toIsoTimestamp(Number(info.nextConnectTime)),
    };
  } catch {
    return null;
  }
}

function getPingIntervalMs(wsClient) {
  try {
    const wsConfig = wsClient?.wsConfig?.getWS?.();
    const pingInterval = Number(wsConfig?.pingInterval);
    return Number.isFinite(pingInterval) && pingInterval > 0 ? pingInterval : null;
  } catch {
    return null;
  }
}

function getWsInstance(wsClient) {
  try {
    return wsClient?.wsConfig?.getWSInstance?.() || null;
  } catch {
    return null;
  }
}

function getFrameMetadata(frame = {}) {
  const headers = Array.isArray(frame?.headers) ? frame.headers : [];
  const headerMap = headers.reduce((accumulator, entry) => {
    if (entry?.key) {
      accumulator[entry.key] = entry.value;
    }
    return accumulator;
  }, {});
  return {
    frame_type: typeof headerMap.type === "string" ? headerMap.type : null,
    ws_message_id: formatIdentifierHint(headerMap.message_id),
    ws_trace_id: formatIdentifierHint(headerMap.trace_id),
    ws_sum: Number.isFinite(Number(headerMap.sum)) ? Number(headerMap.sum) : null,
    ws_seq: Number.isFinite(Number(headerMap.seq)) ? Number(headerMap.seq) : null,
    handshake_status: typeof headerMap["handshake-status"] === "string" ? headerMap["handshake-status"] : null,
    handshake_message: typeof headerMap["handshake-msg"] === "string" ? headerMap["handshake-msg"] : null,
    handshake_auth_error_code: typeof headerMap["handshake-autherrcode"] === "string"
      ? headerMap["handshake-autherrcode"]
      : null,
  };
}

function parseJsonPayload(payload) {
  if (!payload) {
    return null;
  }
  try {
    const text = new TextDecoder("utf-8").decode(payload).trim();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseEventEnvelope(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      callback_kind: "unknown",
      parsed_event_type: null,
      envelope_version: "unknown",
      challenge_present: false,
      is_lark_event: false,
    };
  }

  if ("schema" in raw) {
    const parsedEventType = typeof raw?.header?.event_type === "string" ? raw.header.event_type : null;
    return {
      callback_kind: raw?.challenge ? "challenge" : (parsedEventType ? "event" : "unknown"),
      parsed_event_type: parsedEventType,
      envelope_version: "v2",
      challenge_present: typeof raw?.challenge === "string" && raw.challenge.length > 0,
      is_lark_event: Boolean(parsedEventType),
    };
  }

  if (typeof raw?.event?.type === "string") {
    return {
      callback_kind: raw?.challenge ? "challenge" : "event",
      parsed_event_type: raw.event.type,
      envelope_version: "v1",
      challenge_present: typeof raw?.challenge === "string" && raw.challenge.length > 0,
      is_lark_event: true,
    };
  }

  if (typeof raw?.type === "string") {
    return {
      callback_kind: raw.type === "url_verification" ? "challenge" : "event",
      parsed_event_type: raw.type,
      envelope_version: "flat",
      challenge_present: typeof raw?.challenge === "string" && raw.challenge.length > 0,
      is_lark_event: true,
    };
  }

  return {
    callback_kind: raw?.challenge ? "challenge" : "unknown",
    parsed_event_type: null,
    envelope_version: "unknown",
    challenge_present: typeof raw?.challenge === "string" && raw.challenge.length > 0,
    is_lark_event: false,
  };
}

export function createLongConnectionLifecycleMonitor({
  wsClient,
  eventDispatcher = null,
  logger,
  now = () => Date.now(),
  onExit = (code) => process.exit(code),
  watchdogIdleMs = resolveConfiguredIdleMs(),
  watchdogCheckIntervalMs = resolveConfiguredCheckIntervalMs(),
} = {}) {
  if (!wsClient) {
    throw new Error("wsClient is required");
  }
  if (!logger || typeof logger.info !== "function" || typeof logger.warn !== "function" || typeof logger.error !== "function") {
    throw new Error("logger with info/warn/error is required");
  }

  const wsLogger = typeof logger.child === "function"
    ? logger.child("ws_runtime", { action: "ws_lifecycle" })
    : logger;

  const state = {
    startedAt: now(),
    readyAt: null,
    lastConnectAttemptAt: null,
    lastReconnectAt: null,
    lastRawMessageAt: null,
    lastPingReceivedAt: null,
    lastPongAt: null,
    lastIngressAt: null,
    lastCloseAt: null,
    shutdownRequested: false,
    watchdogTriggered: false,
  };

  function hasRegisteredHandle(eventType) {
    if (!eventType) {
      return false;
    }
    try {
      return wsClient?.eventDispatcher?.handles?.has?.(eventType) === true
        || eventDispatcher?.handles?.has?.(eventType) === true;
    } catch {
      return false;
    }
  }

  function resolveEffectiveIdleMs() {
    const pingIntervalMs = getPingIntervalMs(wsClient);
    if (!pingIntervalMs) {
      return watchdogIdleMs;
    }
    return Math.max(watchdogIdleMs, pingIntervalMs * DEFAULT_WATCHDOG_PING_MULTIPLIER);
  }

  function getLastActivityAt() {
    return latestTimestamp([
      state.lastIngressAt,
      state.lastPongAt,
      state.lastPingReceivedAt,
      state.lastRawMessageAt,
      state.readyAt,
    ]);
  }

  function buildCommonFields(extra = {}) {
    const wsInstance = getWsInstance(wsClient);
    const lastActivityAt = getLastActivityAt();
    return {
      ready_state: normalizeReadyState(wsInstance?.readyState),
      last_activity_at: toIsoTimestamp(lastActivityAt),
      last_event_at: toIsoTimestamp(state.lastIngressAt),
      last_pong_at: toIsoTimestamp(state.lastPongAt),
      reconnect_info: getReconnectInfo(wsClient),
      ...extra,
    };
  }

  function attachWsInstanceListeners(wsInstance) {
    if (!wsInstance || wsInstance[WS_MONITOR_ATTACHED]) {
      return;
    }

    wsInstance[WS_MONITOR_ATTACHED] = true;

    wsInstance.on("message", (payload) => {
      state.lastRawMessageAt = now();
      wsLogger.info("ws_message_received", buildCommonFields({
        payload_size_bytes: Number.isFinite(Number(payload?.length)) ? Number(payload.length) : null,
      }));
    });

    wsInstance.on("ping", () => {
      state.lastPingReceivedAt = now();
      wsLogger.info("ws_ping_received", buildCommonFields());
    });

    wsInstance.on("pong", () => {
      state.lastPongAt = now();
      wsLogger.info("ws_pong_received", buildCommonFields());
    });

    wsInstance.on("close", (code, reason) => {
      state.lastCloseAt = now();
      wsLogger.warn("ws_closed", buildCommonFields({
        close_code: Number.isFinite(Number(code)) ? Number(code) : null,
        close_reason: decodeCloseReason(reason),
        idle_ms_since_last_activity: (() => {
          const lastActivityAt = getLastActivityAt();
          return Number.isFinite(lastActivityAt) ? Math.max(0, now() - lastActivityAt) : null;
        })(),
      }));
    });
  }

  const originalConnect = wsClient.connect.bind(wsClient);
  wsClient.connect = async (...args) => {
    state.lastConnectAttemptAt = now();
    wsLogger.info("ws_connect_attempted", buildCommonFields({
      connect_attempt_at: toIsoTimestamp(state.lastConnectAttemptAt),
    }));

    const connected = await originalConnect(...args);
    const wsInstance = getWsInstance(wsClient);
    attachWsInstanceListeners(wsInstance);

    if (connected) {
      state.readyAt = now();
      wsLogger.info("ws_opened", buildCommonFields({
        ready_at: toIsoTimestamp(state.readyAt),
      }));
      return connected;
    }

    wsLogger.warn("ws_connect_failed", buildCommonFields({
      connect_attempt_at: toIsoTimestamp(state.lastConnectAttemptAt),
    }));
    return connected;
  };

  const originalReConnect = wsClient.reConnect.bind(wsClient);
  wsClient.reConnect = async (isStart = false) => {
    state.lastReconnectAt = now();
    wsLogger.info(isStart ? "ws_start_requested" : "ws_reconnect_requested", buildCommonFields({
      is_start: isStart,
      reconnect_requested_at: toIsoTimestamp(state.lastReconnectAt),
    }));
    return originalReConnect(isStart);
  };

  const originalPingLoop = wsClient.pingLoop.bind(wsClient);
  wsClient.pingLoop = (...args) => {
    wsLogger.info("ws_ping_sent", buildCommonFields({
      ping_interval_ms: getPingIntervalMs(wsClient),
    }));
    return originalPingLoop(...args);
  };

  const originalHandleControlData = wsClient.handleControlData.bind(wsClient);
  wsClient.handleControlData = async (frame) => {
    const metadata = getFrameMetadata(frame);
    const payload = parseJsonPayload(frame?.payload);
    if (metadata.frame_type === "pong") {
      state.lastPongAt = now();
    }
    if (metadata.frame_type === "ping") {
      state.lastPingReceivedAt = now();
    }
    wsLogger.info("ws_control_frame_received", buildCommonFields({
      ...metadata,
      control_kind: metadata.frame_type || "unknown",
      control_payload_kind: payload ? "json" : "none",
      control_payload_keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 8) : [],
    }));
    return originalHandleControlData(frame);
  };

  const originalMergeData = wsClient?.dataCache?.mergeData?.bind(wsClient.dataCache);
  if (typeof originalMergeData === "function") {
    wsClient.dataCache.mergeData = (params = {}) => {
      const mergedData = originalMergeData(params);
      if (mergedData) {
        const classification = parseEventEnvelope(mergedData);
        wsLogger.info("ws_event_payload_classified", buildCommonFields({
          ws_message_id: formatIdentifierHint(params?.message_id),
          ws_trace_id: formatIdentifierHint(params?.trace_id),
          ws_sum: Number.isFinite(Number(params?.sum)) ? Number(params.sum) : null,
          ws_seq: Number.isFinite(Number(params?.seq)) ? Number(params.seq) : null,
          ...classification,
          registered_handler: hasRegisteredHandle(classification.parsed_event_type),
        }));
      }
      return mergedData;
    };
  }

  const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
  wsClient.handleEventData = async (frame) => {
    state.lastRawMessageAt = now();
    wsLogger.info("ws_event_frame_received", buildCommonFields(getFrameMetadata(frame)));
    return originalHandleEventData(frame);
  };

  if (eventDispatcher && typeof eventDispatcher.invoke === "function") {
    const originalInvoke = eventDispatcher.invoke.bind(eventDispatcher);
    eventDispatcher.invoke = async (data, params) => {
      const classification = parseEventEnvelope(data);
      wsLogger.info("ws_event_dispatch_attempted", buildCommonFields({
        ...classification,
        registered_handler: hasRegisteredHandle(classification.parsed_event_type),
      }));
      const result = await originalInvoke(data, params);
      wsLogger.info("ws_event_dispatch_completed", buildCommonFields({
        ...classification,
        registered_handler: hasRegisteredHandle(classification.parsed_event_type),
        dispatch_result_type: result == null ? "null" : typeof result,
        dispatch_result_preview: typeof result === "string" ? result.slice(0, 120) : null,
      }));
      return result;
    };
  }

  const originalClose = wsClient.close.bind(wsClient);
  wsClient.close = (params = {}) => {
    state.shutdownRequested = true;
    wsLogger.info("ws_close_requested", buildCommonFields({
      force: params?.force === true,
    }));
    return originalClose(params);
  };

  function runWatchdogCheck() {
    if (state.shutdownRequested || state.watchdogTriggered) {
      return false;
    }

    const wsInstance = getWsInstance(wsClient);
    if (!wsInstance || wsInstance.readyState !== OPEN_READY_STATE) {
      return false;
    }

    const lastActivityAt = getLastActivityAt();
    if (!Number.isFinite(lastActivityAt)) {
      return false;
    }

    const effectiveIdleMs = resolveEffectiveIdleMs();
    const idleMs = now() - lastActivityAt;
    if (idleMs < effectiveIdleMs) {
      return false;
    }

    state.watchdogTriggered = true;
    const details = buildCommonFields({
      idle_ms: idleMs,
      watchdog_idle_ms: effectiveIdleMs,
      last_ping_received_at: toIsoTimestamp(state.lastPingReceivedAt),
    });

    wsLogger.error("ws_watchdog_triggered", details);
    emitRateLimitedAlert({
      consoleLike: console,
      code: "ws_ingress_watchdog_triggered",
      scope: "long_connection",
      message: "WebSocket ingress activity stalled; exiting so LaunchAgent can restart the bot.",
      dedupeKey: "ws_ingress_watchdog_triggered",
      details,
    });
    onExit(1);
    return true;
  }

  const watchdogTimer = setInterval(runWatchdogCheck, watchdogCheckIntervalMs);
  if (typeof watchdogTimer?.unref === "function") {
    watchdogTimer.unref();
  }

  wsLogger.info("ws_watchdog_started", {
    action: "ws_watchdog",
    status: "started",
    watchdog_idle_ms: watchdogIdleMs,
    watchdog_check_interval_ms: watchdogCheckIntervalMs,
  });

  return {
    markIngressEvent(fields = {}) {
      state.lastIngressAt = now();
      wsLogger.info("ws_ingress_event_observed", buildCommonFields(fields));
    },
    stop() {
      state.shutdownRequested = true;
      clearInterval(watchdogTimer);
    },
    getState() {
      return {
        ...state,
        readyState: normalizeReadyState(getWsInstance(wsClient)?.readyState),
        lastActivityAt: getLastActivityAt(),
      };
    },
    runWatchdogCheck,
  };
}
