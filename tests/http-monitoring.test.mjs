import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startHttpServer } from "../src/http-server.mjs";
import {
  getRequestMetrics,
  listRecentRequests,
  recordHttpRequest,
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

async function startTestServer(t) {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
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
