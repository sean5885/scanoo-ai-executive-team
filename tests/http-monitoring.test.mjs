import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startHttpServer } from "../src/http-server.mjs";
import {
  getRequestMetrics,
  listRecentRequests,
  recordHttpRequest,
  recordTraceEvent,
} from "../src/monitoring-store.mjs";

const execFileAsync = promisify(execFile);

function createLogger() {
  return {
    log() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function startTestServer(t, options = {}) {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("http server records requests with trace_id and exposes trace header", async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const payload = await response.json();

  assert.match(payload.trace_id, /^http_/);
  assert.equal(response.headers.get("x-trace-id"), payload.trace_id);

  const recentRequests = listRecentRequests({ limit: 200 });
  const item = recentRequests.find((entry) => entry.trace_id === payload.trace_id);

  assert.ok(item);
  assert.equal(item.method, "GET");
  assert.equal(item.pathname, "/health");
  assert.equal(item.status_code, 200);
  assert.equal(item.ok, true);
});

test("http monitoring routes expose latest error and metrics", async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();
  const metricsBefore = getRequestMetrics();
  const missingPath = `/__monitoring_missing_${Date.now()}__`;

  const missingResponse = await fetch(`http://127.0.0.1:${port}${missingPath}`);
  const missingPayload = await missingResponse.json();

  assert.equal(missingResponse.status, 404);
  assert.equal(missingPayload.error, "not_found");

  const latestErrorResponse = await fetch(`http://127.0.0.1:${port}/api/monitoring/errors/latest`);
  const latestErrorPayload = await latestErrorResponse.json();

  assert.equal(latestErrorResponse.status, 200);
  assert.equal(latestErrorPayload.ok, true);
  assert.equal(latestErrorPayload.item?.trace_id, missingPayload.trace_id);
  assert.equal(latestErrorPayload.item?.pathname, missingPath);
  assert.equal(latestErrorPayload.item?.error_code, "not_found");

  const metricsResponse = await fetch(`http://127.0.0.1:${port}/api/monitoring/metrics`);
  const metricsPayload = await metricsResponse.json();

  assert.equal(metricsResponse.status, 200);
  assert.equal(metricsPayload.ok, true);
  assert.ok(metricsPayload.metrics.total_requests >= metricsBefore.total_requests + 1);
  assert.ok(metricsPayload.metrics.error_count >= metricsBefore.error_count + 1);

  const requestsResponse = await fetch(`http://127.0.0.1:${port}/api/monitoring/requests?limit=200`);
  const requestsPayload = await requestsResponse.json();

  assert.equal(requestsResponse.status, 200);
  assert.equal(requestsPayload.ok, true);
  assert.equal(Array.isArray(requestsPayload.items), true);
  assert.equal(requestsPayload.items.some((item) => item.trace_id === missingPayload.trace_id), true);
});

test("http server records timed out requests in monitoring store", async (t) => {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
    requestTimeoutMs: 25,
    serviceOverrides: {
      executePlannedUserInput: async ({ signal }) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("查 runtime info")}`, {
    headers: {
      connection: "close",
    },
  });
  const payload = await response.json();
  const traceId = response.headers.get("x-trace-id");

  assert.equal(response.status, 504);
  assert.match(payload.answer || "", /逾時|安全交付/);
  assert.equal("error" in payload, false);
  assert.equal("trace_id" in payload, false);
  assert.match(traceId || "", /^http_/);

  const recentRequests = listRecentRequests({ limit: 200 });
  const item = recentRequests.find((entry) => entry.trace_id === traceId);

  assert.ok(item);
  assert.equal(item.status_code, 504);
  assert.equal(item.error_code, "http_504");
  assert.equal(item.ok, false);
});

test("answer route normalizes the exact leaking runtime query into natural-language output", async (t) => {
  const server = await startTestServer(t, {
    requestTimeoutMs: 180000,
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("查 runtime info")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(payload.answer || "", /runtime|PID|工作目錄|資料庫路徑/);
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.equal("action" in payload, false);
  assert.equal("params" in payload, false);
  assert.equal("error" in payload, false);
  assert.equal("trace" in payload, false);
  assert.equal("trace_id" in payload, false);
  assert.equal("details" in payload, false);
  assert.equal("execution_result" in payload, false);
});

test("answer route converts planner errors into natural-language fallback without internal JSON exposure", async (t) => {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
    serviceOverrides: {
      executePlannedUserInput: async () => ({
        ok: false,
        error: "business_error",
        execution_result: {
          ok: false,
          error: "business_error",
          data: {
            reason: "routing_no_match",
            routing_reason: "routing_no_match",
            stop_reason: "business_error",
          },
          trace_id: "trace_internal_hidden",
        },
        trace_id: "trace_internal_hidden",
      }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("幫我看看")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.match(payload.answer || "", /自然語言|安全完成|安全執行/);
  assert.equal("error" in payload, false);
  assert.equal("trace_id" in payload, false);
  assert.equal("details" in payload, false);
  assert.equal("execution_result" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /routing_no_match|business_error|trace_internal_hidden/);
});

test("monitoring CLI reports recent requests and metrics", async () => {
  const traceId = `cli_test_${Date.now()}`;

  recordHttpRequest({
    traceId,
    requestId: `req_${traceId}`,
    method: "GET",
    pathname: "/__cli_monitoring_test__",
    statusCode: 200,
    payload: { ok: true },
  });

  const recentResult = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "recent", "200"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const recentPayload = JSON.parse(recentResult.stdout);

  assert.equal(recentPayload.ok, true);
  assert.equal(Array.isArray(recentPayload.items), true);
  assert.equal(recentPayload.items.some((item) => item.trace_id === traceId), true);

  const metricsResult = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "metrics"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const metricsPayload = JSON.parse(metricsResult.stdout);

  assert.equal(metricsPayload.ok, true);
  assert.ok(metricsPayload.metrics.total_requests >= 1);
  assert.ok(typeof metricsPayload.metrics.success_rate_percent === "number");
});

test("monitoring learning route returns routing/tool summary", async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();
  const stamp = Date.now();
  for (let index = 0; index < 6; index += 1) {
    for (let sample = 0; sample < 2; sample += 1) {
      const traceId = `http_learning_legacy_${stamp}_${index}_${sample}`;
      const requestId = `req_${traceId}`;
      recordHttpRequest({
        traceId,
        requestId,
        method: "POST",
        pathname: `/api/legacy_learning_${stamp}_${index}`,
        routeName: `legacy_learning_route_${stamp}_${index}`,
        statusCode: 200,
        payload: { ok: true },
        durationMs: 12 + sample,
      });
      recordTraceEvent({
        traceId,
        requestId,
        component: "planner.tool",
        event: "tool_execution",
        payload: {
          event_type: "tool_execution",
          action: `legacy_learning_tool_${stamp}_${index}`,
          trace_id: traceId,
          duration_ms: 12 + sample,
          result: {
            success: true,
            data: {},
            error: null,
          },
        },
      });
    }
  }

  const traceId = `http_learning_${stamp}`;
  const requestId = `req_${traceId}`;

  recordHttpRequest({
    traceId,
    requestId,
    method: "POST",
    pathname: `/api/learning_${stamp}`,
    routeName: `learning_route_${stamp}`,
    statusCode: 200,
    payload: { ok: true },
    durationMs: 15,
  });

  recordTraceEvent({
    traceId,
    requestId,
    component: "planner.tool",
    event: "tool_execution",
    payload: {
      event_type: "tool_execution",
      action: `learning_tool_${stamp}`,
      trace_id: traceId,
      duration_ms: 15,
      result: {
        success: true,
        data: {},
        error: null,
      },
    },
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/learning?lookback_hours=1&min_sample_size=1&request_limit=20&max_tool_items=20`,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.summary);
  assert.ok(Array.isArray(payload.summary.high_success_tools));
  assert.ok(payload.summary.high_success_tools.some((item) => item.tool_name === `learning_tool_${stamp}`));
  assert.ok(payload.summary.high_success_tools.length <= 20);
});

test("monitoring CLI learning command returns draft proposals", async () => {
  const stamp = Date.now();
  for (const suffix of ["a", "b"]) {
    const traceId = `cli_learning_${stamp}_${suffix}`;
    const requestId = `req_${traceId}`;

    recordHttpRequest({
      traceId,
      requestId,
      method: "POST",
      pathname: `/api/cli_learning_${stamp}`,
      routeName: `cli_learning_route_${stamp}`,
      statusCode: 422,
      payload: { ok: false, error: "not_found", message: "missing" },
      durationMs: 31,
    });
    recordTraceEvent({
      traceId,
      requestId,
      component: "http.request.learning",
      event: "lane_execution_planned",
      payload: {
        chosen_lane: "knowledge-assistant",
        chosen_action: "planner_user_input",
      },
    });
    recordTraceEvent({
      traceId,
      requestId,
      component: "planner.tool",
      event: "tool_execution",
      level: "error",
      payload: {
        event_type: "tool_execution",
        action: `cli_learning_tool_${stamp}`,
        trace_id: traceId,
        duration_ms: 31,
        result: {
          success: false,
          data: {},
          error: "not_found",
        },
      },
    });
  }

  const result = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "learning", "1", "1"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const repeated = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "learning", "1", "1"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const payload = JSON.parse(result.stdout);
  const repeatedPayload = JSON.parse(repeated.stdout);

  assert.equal(payload.ok, true);
  assert.deepEqual(repeatedPayload.summary, payload.summary);
  assert.ok(Array.isArray(payload.summary.draft_proposals));
  assert.ok(payload.summary.low_success_tools.some((item) => item.tool_name === `cli_learning_tool_${stamp}`));
});

test("learning proposal route persists pending improvements for human review", async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();
  const stamp = Date.now();
  const traceId = `route_learning_${stamp}`;
  const requestId = `req_${traceId}`;

  recordHttpRequest({
    traceId,
    requestId,
    method: "POST",
    pathname: `/api/route_learning_${stamp}`,
    routeName: `route_learning_${stamp}`,
    statusCode: 422,
    payload: { ok: false, error: "tool_error", message: "boom" },
    durationMs: 29,
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "http.request.learning",
    event: "lane_execution_planned",
    payload: {
      chosen_lane: "knowledge-assistant",
      chosen_action: "planner_user_input",
    },
  });
  recordTraceEvent({
    traceId,
    requestId,
    component: "planner.tool",
    event: "tool_execution",
    level: "error",
    payload: {
      event_type: "tool_execution",
      action: `route_learning_tool_${stamp}`,
      trace_id: traceId,
      duration_ms: 29,
      result: {
        success: false,
        data: {},
        error: "tool_error",
      },
    },
  });

  const response = await fetch(`http://127.0.0.1:${port}/agent/improvements/learning/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      account_id: "acct-http-learning",
      session_key: "sess-http-learning",
      lookback_hours: 1,
      min_sample_size: 1,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.items));
  assert.ok(payload.items.every((item) => item.status === "pending_approval"));
});

test("monitoring dashboard page renders rates and recent request sections", async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();
  const missingPath = `/__monitoring_dashboard_missing_${Date.now()}__`;

  await fetch(`http://127.0.0.1:${port}${missingPath}`);
  const response = await fetch(`http://127.0.0.1:${port}/monitoring?requests_limit=200&errors_limit=200`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("x-trace-id") || "", /^http_/);
  assert.match(html, /Monitoring Dashboard/);
  assert.match(html, /Success Rate/);
  assert.match(html, /Error Rate/);
  assert.match(html, /Recent Errors/);
  assert.match(html, /Recent Requests/);
  assert.match(html, new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("monitoring CLI dashboard prints rates plus recent errors and requests", async () => {
  const successTraceId = `cli_dashboard_success_${Date.now()}`;
  const errorTraceId = `${successTraceId}_error`;
  const successPath = `/__cli_dashboard_success_${Date.now()}__`;
  const errorPath = `/__cli_dashboard_error_${Date.now()}__`;

  recordHttpRequest({
    traceId: successTraceId,
    requestId: `req_${successTraceId}`,
    method: "GET",
    pathname: successPath,
    statusCode: 200,
    payload: { ok: true },
  });
  recordHttpRequest({
    traceId: errorTraceId,
    requestId: `req_${errorTraceId}`,
    method: "POST",
    pathname: errorPath,
    statusCode: 500,
    payload: { ok: false, error: "cli_dashboard_error", message: "boom" },
  });

  const result = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "dashboard", "200", "200"], {
    cwd: process.cwd(),
    env: process.env,
  });

  assert.match(result.stdout, /Lobster Monitoring Dashboard/);
  assert.match(result.stdout, /Success rate:/);
  assert.match(result.stdout, /Error rate:/);
  assert.match(result.stdout, /Recent errors/);
  assert.match(result.stdout, /Recent requests/);
  assert.match(result.stdout, new RegExp(successPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, new RegExp(errorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
