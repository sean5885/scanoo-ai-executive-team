import crypto from "node:crypto";

import { cleanText } from "./message-intent-utils.mjs";

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
