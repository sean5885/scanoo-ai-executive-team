import crypto from "node:crypto";

import { cleanText } from "./message-intent-utils.mjs";

const DEFAULT_RUNTIME_ALERT_RATE_LIMIT_MS = 60_000;
const runtimeAlertState = new Map();

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

  sink("[lobster_alert]", {
    ts: new Date(now).toISOString(),
    code: normalizedCode,
    scope: normalizedScope,
    message: normalizedMessage,
    rate_limit_ms: normalizedInterval,
    dedupe_key: normalizedDedupeKey,
    suppressed_duplicates: suppressedCount,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  });

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
  const fallback = logger?.log ? logger.log.bind(logger) : console.log.bind(console);
  const sink = typeof logger?.[level] === "function" ? logger[level].bind(logger) : fallback;
  sink("lobster_tool_execution", entry);
  return entry;
}

export function createRuntimeLogger({
  logger = console,
  component = "runtime",
  baseFields = {},
} = {}) {
  const fallback = logger?.log ? logger.log.bind(logger) : console.log.bind(console);

  function emit(level, event, fields = {}) {
    const sink = typeof logger?.[level] === "function" ? logger[level].bind(logger) : fallback;
    sink("lobster_runtime", {
      ts: new Date().toISOString(),
      component,
      event,
      ...baseFields,
      ...fields,
    });
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
