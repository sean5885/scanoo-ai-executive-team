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
