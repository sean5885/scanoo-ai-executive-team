import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();

const [
  { startHttpServer },
  {
    getAutonomyRolloutGuardrailSnapshot,
    getRequestMetrics,
    listRecentRequests,
    recordHttpRequest,
    recordTraceEvent,
  },
  {
    claimNextAutonomyJob,
    enqueueAutonomyJobRecord,
    ensureAutonomyJobTables,
  },
  { default: db },
] = await Promise.all([
  import("../src/http-server.mjs"),
  import("../src/monitoring-store.mjs"),
  import("../src/task-runtime/autonomy-job-store.mjs"),
  import("../src/db.mjs"),
]);

const execFileAsync = promisify(execFile);
const testEnv = testDb.env;

test.after(() => {
  testDb.close();
});

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

test("monitoring autonomy receipt lookup supports trace/request tokens and fail-soft not_found", async (t) => {
  ensureAutonomyJobTables();
  const stamp = Date.now();
  const traceId = `trace_monitoring_receipt_${stamp}`;
  const requestId = `req_monitoring_receipt_${stamp}`;
  const queued = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId,
    payload: {
      schema_version: "planner_user_input_v1",
      planner_input: {
        text: "monitoring receipt lookup",
        request_id: requestId,
        trace_id: traceId,
      },
    },
    maxAttempts: 1,
  });
  assert.ok(queued?.id);

  const server = await startTestServer(t);
  const { port } = server.address();

  const byTraceResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/receipt?trace_id=${encodeURIComponent(traceId)}`,
  );
  const byTracePayload = await byTraceResponse.json();
  assert.equal(byTraceResponse.status, 200);
  assert.equal(byTracePayload.ok, true);
  assert.equal(byTracePayload.job_id, queued.id);
  assert.equal(byTracePayload.job_type, "planner_user_input_v1");
  assert.equal(byTracePayload.status, "queued");
  assert.equal(byTracePayload.lifecycle_sink, null);
  assert.equal(byTracePayload.reason, null);
  assert.equal(Boolean(byTracePayload.updated_at), true);
  assert.equal("payload_json" in byTracePayload, false);
  assert.equal("result_json" in byTracePayload, false);
  assert.equal("error_json" in byTracePayload, false);
  assert.equal("payload" in byTracePayload, false);
  assert.equal("result" in byTracePayload, false);
  assert.equal("error" in byTracePayload, false);

  const byRequestHeaderResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/receipt`,
    {
      headers: {
        "X-Request-Id": requestId,
      },
    },
  );
  const byRequestHeaderPayload = await byRequestHeaderResponse.json();
  assert.equal(byRequestHeaderResponse.status, 200);
  assert.equal(byRequestHeaderPayload.ok, true);
  assert.equal(byRequestHeaderPayload.job_id, queued.id);
  assert.equal(byRequestHeaderPayload.status, "queued");

  const byMissResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/receipt?trace_id=${encodeURIComponent(`trace_missing_${stamp}`)}`,
  );
  const byMissPayload = await byMissResponse.json();
  assert.equal(byMissResponse.status, 200);
  assert.equal(byMissPayload.ok, true);
  assert.equal(byMissPayload.status, "not_found");
  assert.equal(byMissPayload.job_id, null);
  assert.equal(byMissPayload.job_type, null);
  assert.equal(byMissPayload.lifecycle_sink, null);
  assert.equal(byMissPayload.updated_at, null);
  assert.equal(byMissPayload.reason, null);
});

test("monitoring autonomy final pickup supports completed and fail-soft non-completed states", async (t) => {
  ensureAutonomyJobTables();
  const stamp = Date.now();
  const traceQueued = `trace_monitoring_final_queued_${stamp}`;
  const requestQueued = `req_monitoring_final_queued_${stamp}`;
  const traceCompleted = `trace_monitoring_final_completed_${stamp}`;
  const requestCompleted = `req_monitoring_final_completed_${stamp}`;
  const traceFailed = `trace_monitoring_final_failed_${stamp}`;
  const requestFailed = `req_monitoring_final_failed_${stamp}`;

  const queued = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: traceQueued,
    payload: {
      schema_version: "planner_user_input_v1",
      planner_input: {
        text: "monitoring final pickup queued",
        request_id: requestQueued,
        trace_id: traceQueued,
      },
    },
    maxAttempts: 1,
  });
  const completed = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: traceCompleted,
    payload: {
      schema_version: "planner_user_input_v1",
      planner_input: {
        text: "monitoring final pickup completed",
        request_id: requestCompleted,
        trace_id: traceCompleted,
      },
    },
    maxAttempts: 1,
  });
  const failed = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: traceFailed,
    payload: {
      schema_version: "planner_user_input_v1",
      planner_input: {
        text: "monitoring final pickup failed",
        request_id: requestFailed,
        trace_id: traceFailed,
      },
    },
    maxAttempts: 1,
  });
  assert.ok(queued?.id);
  assert.ok(completed?.id);
  assert.ok(failed?.id);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE autonomy_jobs
    SET status = @status,
        result_json = @result_json,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: completed.id,
    status: "completed",
    result_json: JSON.stringify({
      structured_result: {
        answer: "final completed answer",
        sources: ["source-1", "source-2"],
        limitations: ["limitation-1"],
      },
    }),
    completed_at: now,
    updated_at: now,
  });
  db.prepare(`
    UPDATE autonomy_jobs
    SET status = @status,
        failed_at = @failed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: failed.id,
    status: "failed",
    failed_at: now,
    updated_at: now,
  });

  const server = await startTestServer(t);
  const { port } = server.address();

  const queuedResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/final?trace_id=${encodeURIComponent(traceQueued)}`,
  );
  const queuedPayload = await queuedResponse.json();
  assert.equal(queuedResponse.status, 200);
  assert.equal(queuedPayload.ok, true);
  assert.equal(queuedPayload.status, "queued");
  assert.equal(queuedPayload.answer, null);
  assert.deepEqual(queuedPayload.sources, []);
  assert.deepEqual(queuedPayload.limitations, []);
  assert.equal(queuedPayload.reason, "not_ready");
  assert.equal(Boolean(queuedPayload.updated_at), true);

  const completedResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/final`,
    {
      headers: {
        "X-Request-Id": requestCompleted,
      },
    },
  );
  const completedPayload = await completedResponse.json();
  assert.equal(completedResponse.status, 200);
  assert.equal(completedPayload.ok, true);
  assert.equal(completedPayload.status, "completed");
  assert.equal(completedPayload.answer, "final completed answer");
  assert.deepEqual(completedPayload.sources, ["source-1", "source-2"]);
  assert.deepEqual(completedPayload.limitations, ["limitation-1"]);
  assert.equal(completedPayload.reason, null);

  const failedResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/final?request_id=${encodeURIComponent(requestFailed)}`,
  );
  const failedPayload = await failedResponse.json();
  assert.equal(failedResponse.status, 200);
  assert.equal(failedPayload.ok, true);
  assert.equal(failedPayload.status, "failed");
  assert.equal(failedPayload.answer, null);
  assert.deepEqual(failedPayload.sources, []);
  assert.deepEqual(failedPayload.limitations, []);
  assert.equal(failedPayload.reason, "failed");

  const missingResponse = await fetch(
    `http://127.0.0.1:${port}/api/monitoring/autonomy/final?trace_id=${encodeURIComponent(`trace_missing_final_${stamp}`)}`,
  );
  const missingPayload = await missingResponse.json();
  assert.equal(missingResponse.status, 200);
  assert.equal(missingPayload.ok, true);
  assert.equal(missingPayload.status, "not_found");
  assert.equal(missingPayload.answer, null);
  assert.deepEqual(missingPayload.sources, []);
  assert.deepEqual(missingPayload.limitations, []);
  assert.equal(missingPayload.updated_at, null);
  assert.equal(missingPayload.reason, "not_found");

  assert.equal("job_id" in completedPayload, false);
  assert.equal("job_type" in completedPayload, false);
  assert.equal("payload_json" in completedPayload, false);
  assert.equal("result_json" in completedPayload, false);
  assert.equal("error_json" in completedPayload, false);
  assert.equal("planner_result" in completedPayload, false);
});

test("monitoring rollout guardrail snapshot aggregates ingress/backlog/readiness and emits alerts", () => {
  ensureAutonomyJobTables();
  db.exec(`
    DELETE FROM http_request_trace_events;
    DELETE FROM autonomy_job_attempts;
    DELETE FROM autonomy_jobs;
  `);

  const decisionAt = "2026-04-20T00:10:00.000Z";
  const nowAt = "2026-04-20T00:20:00.000Z";
  for (let index = 0; index < 4; index += 1) {
    recordTraceEvent({
      traceId: `trace_rollout_mode_${index}`,
      requestId: `req_rollout_mode_${index}`,
      component: "http.request.monitoring",
      event: "planner_autonomy_ingress_mode_decision",
      payload: {
        mode: "queue_authoritative",
        reason: null,
      },
      createdAt: decisionAt,
    });
  }
  recordTraceEvent({
    traceId: "trace_rollout_sampling_1",
    requestId: "req_rollout_sampling_1",
    component: "http.request.monitoring",
    event: "planner_autonomy_queue_authoritative_sampling_miss",
    payload: {
      reason: "queue_authoritative_sampling_miss",
    },
    createdAt: decisionAt,
  });
  recordTraceEvent({
    traceId: "trace_rollout_sampling_2",
    requestId: "req_rollout_sampling_2",
    component: "http.request.monitoring",
    event: "planner_autonomy_queue_authoritative_sampling_miss",
    payload: {
      reason: "queue_authoritative_sampling_percent_zero",
    },
    createdAt: decisionAt,
  });
  recordTraceEvent({
    traceId: "trace_rollout_worker_gate",
    requestId: "req_rollout_worker_gate",
    component: "http.request.monitoring",
    event: "planner_autonomy_queue_authoritative_gate_fallback_sync",
    payload: {
      reason: "worker_heartbeat_stale",
    },
    createdAt: decisionAt,
  });
  for (let index = 0; index < 3; index += 1) {
    recordTraceEvent({
      traceId: `trace_rollout_enqueue_ok_${index}`,
      requestId: `req_rollout_enqueue_ok_${index}`,
      component: "http.request.monitoring",
      event: "planner_autonomy_ingress_enqueued",
      payload: {
        mode: "queue_shadow",
      },
      createdAt: decisionAt,
    });
  }
  recordTraceEvent({
    traceId: "trace_rollout_enqueue_fail",
    requestId: "req_rollout_enqueue_fail",
    component: "http.request.monitoring",
    event: "planner_autonomy_ingress_fallback_sync",
    payload: {
      reason: "enqueue_exception",
    },
    createdAt: decisionAt,
  });

  const running = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: "trace_rollout_backlog_running",
    payload: { scope: "rollout" },
    maxAttempts: 1,
  });
  const claim = claimNextAutonomyJob({
    workerId: "worker-rollout-ready",
    leaseMs: 60_000,
  });
  assert.equal(claim?.job?.id, running.id);
  const queuedOld = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: "trace_rollout_backlog_old",
    payload: { scope: "rollout" },
    maxAttempts: 1,
  });
  const failed = enqueueAutonomyJobRecord({
    jobType: "planner_user_input_v1",
    traceId: "trace_rollout_backlog_failed",
    payload: { scope: "rollout" },
    maxAttempts: 1,
  });
  db.prepare(`
    UPDATE autonomy_jobs
    SET created_at = @created_at,
        next_run_at = @next_run_at
    WHERE id = @job_id
  `).run({
    created_at: "2026-04-20T00:00:00.000Z",
    next_run_at: "2026-04-20T00:00:00.000Z",
    job_id: queuedOld.id,
  });
  db.prepare(`
    UPDATE autonomy_jobs
    SET status = @status
    WHERE id = @job_id
  `).run({
    status: "failed",
    job_id: failed.id,
  });

  const snapshot = getAutonomyRolloutGuardrailSnapshot({
    lookbackMinutes: 30,
    nowAt,
  });
  assert.equal(snapshot?.ingress?.queue_authoritative_mode_decision_count, 4);
  assert.equal(snapshot?.ingress?.queue_authoritative_gate_fallback_sync_count, 1);
  assert.equal(snapshot?.ingress?.sampling_miss_count, 2);
  assert.equal(snapshot?.ingress?.enqueue_attempt_count, 4);
  assert.equal(snapshot?.ingress?.enqueue_fail_fallback_sync_count, 1);
  assert.equal(snapshot?.ingress?.queue_authoritative_gate_fallback_rate, 0.25);
  assert.equal(snapshot?.ingress?.enqueue_fail_fallback_rate, 0.25);
  assert.equal(snapshot?.queue_backlog?.queued_count, 1);
  assert.equal(snapshot?.queue_backlog?.running_count, 1);
  assert.equal(snapshot?.queue_backlog?.failed_count, 1);
  assert.equal(snapshot?.queue_backlog?.oldest_queued_age_ms, 20 * 60 * 1_000);
  assert.equal(snapshot?.worker_readiness?.ready, true);
  assert.equal(snapshot?.worker_readiness?.readiness_state, "ready");
  assert.equal(Number.isFinite(Number(snapshot?.worker_readiness?.lease_remaining_ms)), true);
  const alertCodes = new Set((snapshot?.alerts || []).map((item) => item?.code));
  assert.equal(alertCodes.has("autonomy_queue_gate_fallback_rate_high"), true);
  assert.equal(alertCodes.has("autonomy_enqueue_fail_fallback_rate_high"), true);
  assert.equal(alertCodes.has("autonomy_queue_oldest_age_high"), true);
  assert.equal(alertCodes.has("autonomy_worker_not_ready"), false);
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
    serviceOverrides: {
      executePlannedUserInput: async () => ({
        ok: true,
        action: "get_runtime_info",
        planner_action: "get_runtime_info",
        answer: "系統目前運作正常，沒有異常。",
        sources: [],
        execution_result: {
          ok: true,
          kind: "get_runtime_info",
          db_path: "/tmp/test-runtime.sqlite",
          node_pid: 4321,
          cwd: "/tmp/test-runtime",
          service_start_time: "2026-03-27T15:00:00.000Z",
        },
      }),
    },
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

test("answer route keeps sources on the shared canonical mapper and strips snippet noise", async (t) => {
  const server = await startTestServer(t, {
    requestTimeoutMs: 180000,
    serviceOverrides: {
      executePlannedUserInput: async () => ({
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          kind: "search",
          match_reason: "delivery owner",
          items: [
            {
              title: "Delivery SOP",
              doc_id: "doc_delivery_sop",
              url: "https://larksuite.com/docx/doc_delivery_sop",
              reason: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- delivery owner checklist stays explicit before completion.",
            },
            {
              title: "No Snippet Source",
              doc_id: "doc_delivery_empty",
              url: "https://larksuite.com/docx/doc_delivery_empty",
              reason: "",
            },
          ],
        },
      }),
    },
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("查文件 owner checklist")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.sources.length, 1);
  assert.match(payload.sources[0], /Delivery SOP：delivery owner checklist stays explicit before completion\./);
  assert.match(payload.sources[0], /https:\/\/larksuite\.com\/docx\/doc_delivery_sop/);
  assert.doesNotMatch(payload.sources[0], /\/Users\/|Back to \[?README|\[object Object\]/);
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
  assert.match(payload.answer || "", /一般助理|目前狀態|能確認/);
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
    env: testEnv,
  });
  const recentPayload = JSON.parse(recentResult.stdout);

  assert.equal(recentPayload.ok, true);
  assert.equal(Array.isArray(recentPayload.items), true);
  assert.equal(recentPayload.items.some((item) => item.trace_id === traceId), true);

  const metricsResult = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "metrics"], {
    cwd: process.cwd(),
    env: testEnv,
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
    env: testEnv,
  });
  const repeated = await execFileAsync(process.execPath, ["scripts/monitoring-cli.mjs", "learning", "1", "1"], {
    cwd: process.cwd(),
    env: testEnv,
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
  assert.ok(payload.items.every((item) => ["pending_approval", "applied", "rolled_back"].includes(item.status)));
  assert.ok(payload.items.filter((item) => item.status === "applied").every((item) => item.effect_evidence && item.effect_evidence.before_value != null && item.effect_evidence.after_value != null));
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
    env: testEnv,
  });

  assert.match(result.stdout, /Lobster Monitoring Dashboard/);
  assert.match(result.stdout, /Success rate:/);
  assert.match(result.stdout, /Error rate:/);
  assert.match(result.stdout, /Recent errors/);
  assert.match(result.stdout, /Recent requests/);
  assert.match(result.stdout, new RegExp(successPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, new RegExp(errorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
