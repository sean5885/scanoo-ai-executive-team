import test from "node:test";
import assert from "node:assert/strict";

import { listTraceEvents } from "../src/monitoring-store.mjs";
import {
  buildToolExecutionLog,
  createRequestId,
  createRuntimeLogger,
  createTraceId,
  emitRateLimitedAlert,
  emitToolExecutionLog,
  formatIdentifierHint,
  resetRuntimeAlertsForTests,
  summarizeLarkEvent,
} from "../src/runtime-observability.mjs";

test("formatIdentifierHint 會縮短較長識別碼", () => {
  assert.equal(formatIdentifierHint("om_1234567890abcdef"), "om_123...cdef");
  assert.equal(formatIdentifierHint("short_id"), "short_id");
  assert.equal(formatIdentifierHint(""), null);
});

test("summarizeLarkEvent 會抽出並遮罩關鍵事件欄位", () => {
  const summary = summarizeLarkEvent({
    message: {
      message_id: "om_1234567890abcdef",
      chat_id: "oc_1234567890abcdef",
      chat_type: "group",
      message_type: "text",
      parent_id: "om_parent_123456",
      root_id: "om_root_abcdef12",
    },
    sender: {
      sender_id: {
        open_id: "ou_1234567890abcdef",
      },
    },
  });

  assert.equal(summary.chat_type, "group");
  assert.equal(summary.msg_type, "text");
  assert.equal(summary.message_id, "om_123...cdef");
  assert.equal(summary.chat_id, "oc_123...cdef");
  assert.equal(summary.parent_id, "om_par...3456");
  assert.equal(summary.root_id, "om_roo...ef12");
  assert.equal(summary.sender_open_id, "ou_123...cdef");
});

test("createRuntimeLogger 會輸出結構化 runtime log", () => {
  const calls = [];
  const logger = createRuntimeLogger({
    logger: {
      info(...args) {
        calls.push(args);
      },
    },
    component: "test_component",
  });

  logger.info("lane_resolved", { capability_lane: "doc-editor" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "lobster_runtime");
  assert.equal(calls[0][1].component, "test_component");
  assert.equal(calls[0][1].event, "lane_resolved");
  assert.equal(calls[0][1].event_type, "lane_resolved");
  assert.equal(calls[0][1].action, "lane_resolved");
  assert.equal(calls[0][1].status, "info");
  assert.equal(calls[0][1].capability_lane, "doc-editor");
  assert.ok(typeof calls[0][1].ts === "string");
  assert.ok(typeof calls[0][1].timestamp === "string");
});

test("createTraceId 會建立可讀 trace id，child logger 會繼承 base fields", () => {
  const calls = [];
  const logger = createRuntimeLogger({
    logger: {
      info(...args) {
        calls.push(args);
      },
    },
    component: "root",
    baseFields: {
      trace_id: createTraceId("evt"),
    },
  });

  logger.child("lane", { request_kind: "lark_event" }).info("tool_called", {
    tool_name: "sendMessage",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0][1].trace_id, /^evt_/);
  assert.equal(calls[0][1].request_kind, "lark_event");
  assert.equal(calls[0][1].tool_name, "sendMessage");
  assert.equal(calls[0][1].action, "tool_called");
});

test("buildToolExecutionLog 會產生統一 tool execution log shape", () => {
  const log = buildToolExecutionLog({
    requestId: createRequestId("tool"),
    action: "create_doc",
    params: { title: "Weekly report" },
    success: true,
    data: { document_id: "doc_123" },
    error: null,
    traceId: "trace_doc_123",
  });

  assert.match(log.request_id, /^tool_/);
  assert.equal(log.event_type, "tool_execution");
  assert.equal(log.status, "success");
  assert.equal(log.action, "create_doc");
  assert.deepEqual(log.params, { title: "Weekly report" });
  assert.deepEqual(log.result, {
    success: true,
    data: { document_id: "doc_123" },
    error: null,
  });
  assert.equal(log.trace_id, "trace_doc_123");
});

test("emitToolExecutionLog 會在失敗時輸出錯誤等級 log", () => {
  const calls = [];
  const traceId = `trace_fail_${Date.now()}`;
  emitToolExecutionLog({
    logger: {
      error(...args) {
        calls.push(args);
      },
    },
    requestId: "req_123",
    action: "search_company_brain_docs",
    params: { q: "okr" },
    success: false,
    data: { message: "timeout" },
    error: "runtime_exception",
    traceId,
    durationMs: 42,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "lobster_tool_execution");
  assert.equal(calls[0][1].event_type, "tool_execution");
  assert.equal(calls[0][1].status, "error");
  assert.equal(calls[0][1].request_id, "req_123");
  assert.equal(calls[0][1].result.success, false);
  assert.equal(calls[0][1].result.error, "runtime_exception");
  assert.equal(calls[0][1].duration_ms, 42);

  const persisted = listTraceEvents({ traceId }).find((item) => item.event === "tool_execution");
  assert.ok(persisted);
  assert.equal(persisted?.payload?.action, "search_company_brain_docs");
  assert.equal(persisted?.payload?.duration_ms, 42);
});

test("emitRateLimitedAlert 會在 rate limit 期間抑制重複 alert", () => {
  resetRuntimeAlertsForTests();
  const calls = [];
  const consoleLike = {
    error(...args) {
      calls.push(args);
    },
  };

  const first = emitRateLimitedAlert({
    consoleLike,
    code: "planner_failed",
    scope: "test",
    dedupeKey: "planner_failed:test",
    message: "planner failed",
    now: 1000,
    minIntervalMs: 60_000,
  });
  const second = emitRateLimitedAlert({
    consoleLike,
    code: "planner_failed",
    scope: "test",
    dedupeKey: "planner_failed:test",
    message: "planner failed",
    now: 2000,
    minIntervalMs: 60_000,
  });
  const third = emitRateLimitedAlert({
    consoleLike,
    code: "planner_failed",
    scope: "test",
    dedupeKey: "planner_failed:test",
    message: "planner failed",
    now: 62_000,
    minIntervalMs: 60_000,
  });

  assert.equal(first.emitted, true);
  assert.equal(second.emitted, false);
  assert.equal(second.suppressed, true);
  assert.equal(third.emitted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "[lobster_alert]");
  assert.equal(calls[0][1].event_type, "runtime_alert");
  assert.equal(calls[0][1].action, "planner_failed");
  assert.equal(calls[0][1].status, "alert");
  assert.equal(calls[1][1].suppressed_duplicates, 1);
  resetRuntimeAlertsForTests();
});
