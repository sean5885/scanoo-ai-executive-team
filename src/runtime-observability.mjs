import crypto from "node:crypto";

import { cleanText } from "./message-intent-utils.mjs";
import { recordTraceEvent } from "./monitoring-store.mjs";

const DEFAULT_RUNTIME_ALERT_RATE_LIMIT_MS = 60_000;
const runtimeAlertState = new Map();

function inferLogStatus({ level = "info", event = "", fields = {} } = {}) {
  const explicitStatus = cleanText(fields?.status);
  if (explicitStatus) {
    return explicitStatus;
  }
  if (typeof fields?.ok === "boolean") {
    return fields.ok ? "success" : "error";
  }

  const normalizedEvent = cleanText(event) || "";
  if (normalizedEvent.endsWith("_started")) {
    return "started";
  }
  if (
    normalizedEvent.endsWith("_completed")
    || normalizedEvent.endsWith("_succeeded")
    || normalizedEvent.endsWith("_finished")
    || normalizedEvent.endsWith("_ready")
  ) {
    return "success";
  }
  if (normalizedEvent.endsWith("_skipped")) {
    return "skipped";
  }
  if (normalizedEvent.endsWith("_failed")) {
    return level === "warn" ? "warning" : "error";
  }
  if (level === "error") {
    return "error";
  }
  if (level === "warn") {
    return "warning";
  }
  return "info";
}

function inferLogAction({ event = "", baseFields = {}, fields = {} } = {}) {
  return (
    cleanText(fields?.action)
    || cleanText(fields?.route)
    || cleanText(fields?.stage)
    || cleanText(baseFields?.action)
    || cleanText(event)
    || null
  );
}

function writeStructuredLog({ logger = console, level = "info", label = "lobster_runtime", payload = {} } = {}) {
  const fallback = logger?.log ? logger.log.bind(logger) : console.log.bind(console);
  const sink = typeof logger?.[level] === "function" ? logger[level].bind(logger) : fallback;
  if (logger === console) {
    sink(JSON.stringify(payload));
    return;
  }
  sink(label, payload);
}

function compactError(error) {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "unknown_error",
    };
  }
  return {
    message: typeof error === "string" ? error : String(error),
  };
}

export function formatIdentifierHint(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }
  if (text.length <= 10) {
    return text;
  }
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function summarizeLarkEvent(event = {}) {
  const message = event?.message || {};
  return {
    message_id: formatIdentifierHint(message.message_id),
    chat_id: formatIdentifierHint(message.chat_id),
    chat_type: cleanText(message.chat_type) || null,
    msg_type: cleanText(message.message_type || message.msg_type) || null,
    parent_id: formatIdentifierHint(message.parent_id),
    upper_message_id: formatIdentifierHint(message.upper_message_id),
    root_id: formatIdentifierHint(message.root_id),
    sender_open_id: formatIdentifierHint(event?.sender?.sender_id?.open_id),
  };
}

export function createTraceId(prefix = "trace") {
  const normalizedPrefix = cleanText(prefix) || "trace";
  return `${normalizedPrefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function createRequestId(prefix = "req") {
  return createTraceId(prefix);
}

export function resetRuntimeAlertsForTests() {
  runtimeAlertState.clear();
}

export function emitRateLimitedAlert({
  consoleLike = console,
  code = "",
  scope = "",
  message = "",
  dedupeKey = "",
  details = {},
  minIntervalMs = DEFAULT_RUNTIME_ALERT_RATE_LIMIT_MS,
  now = Date.now(),
} = {}) {
  const normalizedCode = cleanText(code) || "runtime_alert";
  const normalizedScope = cleanText(scope) || "runtime";
  const normalizedMessage = cleanText(message) || normalizedCode;
  const normalizedDedupeKey = cleanText(dedupeKey) || `${normalizedCode}:${normalizedScope}`;
  const normalizedInterval = Number.isFinite(Number(minIntervalMs)) && Number(minIntervalMs) > 0
    ? Number(minIntervalMs)
    : DEFAULT_RUNTIME_ALERT_RATE_LIMIT_MS;
  const previous = runtimeAlertState.get(normalizedDedupeKey);

  if (previous && now - previous.emittedAt < normalizedInterval) {
    runtimeAlertState.set(normalizedDedupeKey, {
      emittedAt: previous.emittedAt,
      suppressedCount: Number(previous.suppressedCount || 0) + 1,
    });
    return {
      emitted: false,
      suppressed: true,
      dedupe_key: normalizedDedupeKey,
      code: normalizedCode,
      scope: normalizedScope,
    };
  }

  const suppressedCount = Number(previous?.suppressedCount || 0);
  runtimeAlertState.set(normalizedDedupeKey, {
    emittedAt: now,
    suppressedCount: 0,
  });

  const fallback = consoleLike?.log ? consoleLike.log.bind(consoleLike) : console.error.bind(console);
  const sink = typeof consoleLike?.error === "function" ? consoleLike.error.bind(consoleLike) : fallback;

  const payload = {
    ts: new Date(now).toISOString(),
    timestamp: new Date(now).toISOString(),
    event: "runtime_alert",
    event_type: "runtime_alert",
    trace_id: cleanText(details?.trace_id) || null,
    action: normalizedCode,
    status: "alert",
    code: normalizedCode,
    scope: normalizedScope,
    message: normalizedMessage,
    rate_limit_ms: normalizedInterval,
    dedupe_key: normalizedDedupeKey,
    suppressed_duplicates: suppressedCount,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  };
  if (consoleLike === console) {
    sink(JSON.stringify(payload));
  } else {
    sink("[lobster_alert]", payload);
  }

  return {
    emitted: true,
    suppressed: false,
    dedupe_key: normalizedDedupeKey,
    code: normalizedCode,
    scope: normalizedScope,
  };
}

function toToolLogObject(value, fallbackKey = "value") {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return { [fallbackKey]: value };
}

export function buildToolExecutionLog({
  requestId = null,
  action = "",
  params = {},
  success = false,
  data = {},
  error = null,
  traceId = null,
  extra = {},
} = {}) {
  return {
    ts: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    event: "tool_execution",
    event_type: "tool_execution",
    status: success === true ? "success" : "error",
    request_id: cleanText(requestId) || createRequestId("req"),
    action: cleanText(action) || null,
    params: toToolLogObject(params, "params"),
    result: {
      success: success === true,
      data: toToolLogObject(data, "data"),
      error: cleanText(error) || null,
    },
    trace_id: cleanText(traceId) || null,
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
  };
}

export function emitToolExecutionLog({
  logger = console,
  requestId = null,
  action = "",
  params = {},
  success = false,
  data = {},
  error = null,
  traceId = null,
  extra = {},
} = {}) {
  const entry = buildToolExecutionLog({
    requestId,
    action,
    params,
    success,
    data,
    error,
    traceId,
    extra,
  });
  const level = entry.result.success ? "info" : "error";
  writeStructuredLog({
    logger,
    level,
    label: "lobster_tool_execution",
    payload: entry,
  });
  return entry;
}

export function createRuntimeLogger({
  logger = console,
  component = "runtime",
  baseFields = {},
} = {}) {
  function emit(level, event, fields = {}) {
    const timestamp = new Date().toISOString();
    const payload = {
      ts: timestamp,
      timestamp,
      component,
      event_type: event,
      event,
      action: inferLogAction({ event, baseFields, fields }),
      status: inferLogStatus({ level, event, fields }),
      ...baseFields,
      ...fields,
    };
    writeStructuredLog({
      logger,
      level,
      label: "lobster_runtime",
      payload,
    });
    try {
      recordTraceEvent({
        traceId: payload.trace_id,
        requestId: payload.request_id || null,
        component: payload.component || component,
        event,
        level,
        payload,
        createdAt: payload.ts,
      });
    } catch {
      // Monitoring persistence must stay fail-soft and must not break the caller's main path.
    }
  }

  return {
    info(event, fields = {}) {
      emit("info", event, fields);
    },
    warn(event, fields = {}) {
      emit("warn", event, fields);
    },
    error(event, fields = {}) {
      emit("error", event, fields);
    },
    child(nextComponent, childFields = {}) {
      const childComponent = cleanText(nextComponent) || component;
      return createRuntimeLogger({
        logger,
        component: `${component}.${childComponent}`,
        baseFields: {
          ...baseFields,
          ...(childFields && typeof childFields === "object" ? childFields : {}),
        },
      });
    },
    compactError,
  };
}
