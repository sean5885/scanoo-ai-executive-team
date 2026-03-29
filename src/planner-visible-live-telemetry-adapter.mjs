import { appendFileSync } from "node:fs";
import { cleanText } from "./message-intent-utils.mjs";

export const DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE = 200;

function cloneEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {};
  }
  return { ...event };
}

function normalizeBufferSize(maxBufferSize) {
  return Number.isInteger(maxBufferSize) && maxBufferSize > 0
    ? maxBufferSize
    : DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE;
}

function trimEventBuffer(state) {
  const overflow = state.events.length - state.maxBufferSize;
  if (overflow > 0) {
    state.events.splice(0, overflow);
  }
}

export function isPlannerVisibleTelemetryAdapter(adapter = null) {
  return Boolean(adapter && typeof adapter.emit === "function");
}

export function createInMemoryTelemetryAdapter({
  maxBufferSize = DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE,
} = {}) {
  const state = {
    maxBufferSize: normalizeBufferSize(maxBufferSize),
    events: [],
  };

  return Object.freeze({
    kind: "in_memory",
    emit(event = {}) {
      const normalizedEvent = cloneEvent(event);
      state.events.push(normalizedEvent);
      trimEventBuffer(state);
      return cloneEvent(normalizedEvent);
    },
    flush() {
      return state.events.length;
    },
    getBuffer({
      request_id = "",
    } = {}) {
      const normalizedRequestId = cleanText(request_id);
      return state.events
        .filter((event) => !normalizedRequestId || event.request_id === normalizedRequestId)
        .map((event) => cloneEvent(event));
    },
    reset({
      maxBufferSize: nextMaxBufferSize = state.maxBufferSize,
    } = {}) {
      state.maxBufferSize = normalizeBufferSize(nextMaxBufferSize);
      state.events.length = 0;
    },
  });
}

export function createStructuredLogTelemetryAdapter({
  destination = "console",
  consoleLike = console,
  filePath = "",
  writer = null,
} = {}) {
  const normalizedDestination = cleanText(destination) === "file" ? "file" : "console";
  const normalizedFilePath = cleanText(filePath);
  const state = {
    events: [],
    logLines: [],
  };

  function writeLine(line) {
    if (typeof writer === "function") {
      writer(line);
      return;
    }
    if (normalizedDestination === "file" && normalizedFilePath) {
      appendFileSync(normalizedFilePath, `${line}\n`, "utf8");
      return;
    }
    if (consoleLike?.info) {
      consoleLike.info(line);
      return;
    }
    console.info(line);
  }

  return Object.freeze({
    kind: "structured_log",
    emit(event = {}) {
      const normalizedEvent = cloneEvent(event);
      const serializedEvent = JSON.stringify(normalizedEvent);
      state.events.push(normalizedEvent);
      state.logLines.push(serializedEvent);
      writeLine(serializedEvent);
      return cloneEvent(normalizedEvent);
    },
    flush() {
      return state.logLines.length;
    },
    getBuffer() {
      return state.events.map((event) => cloneEvent(event));
    },
    getLogBuffer() {
      return [...state.logLines];
    },
    reset() {
      state.events.length = 0;
      state.logLines.length = 0;
    },
  });
}
