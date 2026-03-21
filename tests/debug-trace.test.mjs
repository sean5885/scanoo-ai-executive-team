import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  recordHttpRequest,
  recordTraceEvent,
} from "../src/monitoring-store.mjs";

const execFileAsync = promisify(execFile);

function runDebugTrace(traceId) {
  return execFileAsync(process.execPath, ["scripts/debug-trace.mjs", traceId], {
    cwd: process.cwd(),
    env: process.env,
  });
}

test("debug trace CLI reports missing trace", async () => {
  const traceId = `missing_trace_${Date.now()}`;

  await assert.rejects(
    runDebugTrace(traceId),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(`Trace not found: ${traceId}`));
      return true;
    },
  );
});

test("debug trace CLI reconstructs a successful trace", async () => {
  const traceId = `trace_success_${Date.now()}`;
  const requestId = `req_${traceId}`;

  recordHttpRequest({
    traceId,
    requestId,
    method: "POST",
    pathname: "/api/answer",
    routeName: "knowledge_answer",
    statusCode: 200,
    payload: { ok: true },
    durationMs: 18,
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_input",
    payload: {
      request_input: {
        method: "POST",
        pathname: "/api/answer",
        body: {
          q: "查 runtime info",
        },
      },
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "lane_execution_planned",
    payload: {
      chosen_lane: "knowledge-assistant",
      chosen_action: "planner_user_input",
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "planner_tool_select",
    payload: {
      selected_action: "get_runtime_info",
      reasoning: {
        why: "使用者意圖是查詢當前執行環境資訊，對應 runtime info bridge。",
        alternative: {
          action: "get_runtime_info",
          agent_id: null,
          summary: null,
        },
      },
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "action_result",
    payload: {
      action: "get_runtime_info",
      ok: true,
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_finished",
    payload: {
      status_code: 200,
      ok: true,
    },
  });

  const result = await runDebugTrace(traceId);

  assert.match(result.stdout, /Trace/);
  assert.match(result.stdout, new RegExp(`trace_id: ${traceId}`));
  assert.match(result.stdout, /Request Input/);
  assert.match(result.stdout, /"q": "查 runtime info"/);
  assert.match(result.stdout, /Planner Decision/);
  assert.match(result.stdout, /action: get_runtime_info/);
  assert.match(result.stdout, /why: 使用者意圖是查詢當前執行環境資訊，對應 runtime info bridge。/);
  assert.match(result.stdout, /Lane \/ Action/);
  assert.match(result.stdout, /lane: knowledge-assistant/);
  assert.match(result.stdout, /Timeline/);
  assert.match(result.stdout, /Step 1/);
  assert.match(result.stdout, /Failure Point\n  none/);
});

test("debug trace CLI locates the failing step for error traces", async () => {
  const traceId = `trace_error_${Date.now()}`;
  const requestId = `req_${traceId}`;

  recordHttpRequest({
    traceId,
    requestId,
    method: "POST",
    pathname: "/api/answer",
    routeName: "knowledge_answer",
    statusCode: 422,
    payload: {
      ok: false,
      error: "not_found",
      message: "planner tool not found",
    },
    durationMs: 25,
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_input",
    payload: {
      request_input: {
        method: "POST",
        pathname: "/api/answer",
        body: {
          q: "查不存在的動作",
        },
      },
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "planner_tool_select",
    payload: {
      selected_action: "missing_action",
      reasoning: {
        why: "測試用：故意選到不存在的 action。",
      },
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "action_result",
    level: "error",
    payload: {
      action: "missing_action",
      ok: false,
      error: "not_found",
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "route_failed",
    level: "error",
    payload: {
      route: "knowledge_answer",
      error: "not_found",
      error_message: "planner tool not found",
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_finished",
    payload: {
      status_code: 422,
      ok: false,
      error: "not_found",
      error_message: "planner tool not found",
    },
  });

  const result = await runDebugTrace(traceId);

  assert.match(result.stdout, /Final Result/);
  assert.match(result.stdout, /error: not_found/);
  assert.match(result.stdout, /Failure Point/);
  assert.match(result.stdout, /layer: http.request.knowledge_answer/);
  assert.match(result.stdout, /event: route_failed/);
  assert.match(result.stdout, /message: planner tool not found/);
  assert.match(result.stdout, /status_code: 422/);
});

test("debug trace CLI reconstructs timeout failures", async () => {
  const traceId = `trace_timeout_${Date.now()}`;
  const requestId = `req_${traceId}`;

  recordHttpRequest({
    traceId,
    requestId,
    method: "GET",
    pathname: "/answer",
    routeName: "knowledge_answer",
    statusCode: 504,
    payload: {
      ok: false,
      error: "request_timeout",
      message: "Request timed out after 25ms.",
      timeout_ms: 25,
    },
    durationMs: 25,
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_input",
    payload: {
      request_input: {
        method: "GET",
        pathname: "/answer",
        query: {
          q: "查 runtime info",
        },
      },
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_timeout",
    level: "error",
    payload: {
      error: "request_timeout",
      message: "Request timed out after 25ms.",
      timeout_ms: 25,
      status_code: 504,
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.knowledge_answer",
    event: "route_failed",
    level: "error",
    payload: {
      route: "knowledge_answer",
      error: "request_timeout",
      error_message: "Request timed out after 25ms.",
      timeout_ms: 25,
      aborted: true,
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request",
    event: "request_finished",
    payload: {
      status_code: 504,
      ok: false,
      error: "request_timeout",
      error_message: "Request timed out after 25ms.",
      timeout_ms: 25,
    },
  });

  const result = await runDebugTrace(traceId);

  assert.match(result.stdout, /Final Result/);
  assert.match(result.stdout, /error: request_timeout/);
  assert.match(result.stdout, /timeout_ms: 25/);
  assert.match(result.stdout, /Failure Point/);
  assert.match(result.stdout, /event: route_failed/);
  assert.match(result.stdout, /message: Request timed out after 25ms\./);
});
