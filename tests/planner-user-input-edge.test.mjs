import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { runPlannerUserInputEdge, readPlannerUserInputEdgeMetadata } = await import("../src/planner-user-input-edge.mjs");
const { ROUTING_NO_MATCH } = await import("../src/planner-error-codes.mjs");
const previousAutonomyIngressEnabled = process.env.PLANNER_AUTONOMY_INGRESS_ENABLED;
const previousAutonomyIngressAllowlist = process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST;
const previousAutonomyQueueAuthoritativeEnabled = process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED;
const previousAutonomyQueueAuthoritativeSamplingPercent = process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT;

test.after(() => {
  if (previousAutonomyIngressEnabled == null) {
    delete process.env.PLANNER_AUTONOMY_INGRESS_ENABLED;
  } else {
    process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = previousAutonomyIngressEnabled;
  }
  if (previousAutonomyIngressAllowlist == null) {
    delete process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST;
  } else {
    process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = previousAutonomyIngressAllowlist;
  }
  if (previousAutonomyQueueAuthoritativeEnabled == null) {
    delete process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED;
  } else {
    process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = previousAutonomyQueueAuthoritativeEnabled;
  }
  if (previousAutonomyQueueAuthoritativeSamplingPercent == null) {
    delete process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT;
  } else {
    process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT = previousAutonomyQueueAuthoritativeSamplingPercent;
  }
  testDb.close();
});

test.beforeEach(() => {
  delete process.env.PLANNER_AUTONOMY_INGRESS_ENABLED;
  delete process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST;
  delete process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED;
  delete process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT;
});

test("runPlannerUserInputEdge enqueues planner_user_input_v1 under feature flag + strict allowlist hit", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:autonomy-ingress-session";
  const enqueuedCalls = [];

  const result = await runPlannerUserInputEdge({
    text: "幫我看 runtime",
    sessionKey: "autonomy-ingress-session",
    requestId: "req-ingress-1",
    traceId: "trace-ingress-1",
    handlerName: "planner-edge-test",
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "runtime 正常",
            sources: ["runtime 即時狀態"],
            limitations: [],
          },
        },
      };
    },
    async autonomyJobEnqueuer(args) {
      enqueuedCalls.push(args);
      return {
        ok: true,
        job_id: "job_ingress_1",
        status: "queued",
        trace_id: args.traceId,
      };
    },
    workingMemoryWriter: null,
  });

  assert.equal(enqueuedCalls.length, 1);
  assert.equal(enqueuedCalls[0].jobType, "planner_user_input_v1");
  assert.equal(enqueuedCalls[0].traceId, "trace-ingress-1");
  assert.equal(enqueuedCalls[0].payload?.schema_version, "planner_user_input_v1");
  assert.equal(enqueuedCalls[0].payload?.planner_input?.session_key, "autonomy-ingress-session");
  assert.equal(enqueuedCalls[0].payload?.planner_input?.request_id, "req-ingress-1");
  assert.equal(enqueuedCalls[0].payload?.planner_input?.text, "幫我看 runtime");
  assert.deepEqual(Object.keys(result).sort(), ["plannerEnvelope", "plannerResult", "userResponse"]);
  assert.equal(typeof result?.userResponse?.answer, "string");
  assert.equal(Array.isArray(result?.userResponse?.sources), true);
  assert.equal(Array.isArray(result?.userResponse?.limitations), true);
});

test("runPlannerUserInputEdge falls back to sync planner path when enqueue fails", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:autonomy-ingress-fallback";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT = "0";
  let plannerExecuted = false;

  const result = await runPlannerUserInputEdge({
    text: "幫我整理重點",
    sessionKey: "autonomy-ingress-fallback",
    traceId: "trace-ingress-fallback",
    async autonomyJobEnqueuer() {
      throw new Error("queue_unavailable");
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "search_and_summarize",
        execution_result: {
          ok: true,
          data: {
            answer: "這是同步路徑回覆",
            sources: ["同步執行證據"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(plannerExecuted, true);
  assert.equal(metadata?.execution_mode, "queue_shadow");
  assert.equal(result?.userResponse?.ok, true);
  assert.match(result?.userResponse?.answer || "", /同步路徑回覆/);
});

test("runPlannerUserInputEdge queue_authoritative sampling 0% always downgrades to queue_shadow", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-authoritative-sampling-zero";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT = "0";
  let plannerExecuted = false;
  let enqueueCalled = false;
  let workerReadinessChecked = false;

  const result = await runPlannerUserInputEdge({
    text: "queue authoritative sampling 0%",
    sessionKey: "queue-authoritative-sampling-zero",
    requestId: "req-sampling-zero",
    traceId: "trace-sampling-zero",
    async autonomyWorkerReadinessChecker() {
      workerReadinessChecked = true;
      return {
        ready: true,
        reason: "worker_ready",
      };
    },
    async autonomyJobEnqueuer() {
      enqueueCalled = true;
      return {
        ok: true,
        job_id: "job_queue_shadow_sampling_zero",
        trace_id: "trace-sampling-zero",
      };
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "search_and_summarize",
        execution_result: {
          ok: true,
          data: {
            answer: "sampling 0% still keeps sync planner",
            sources: ["queue shadow + sync"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(workerReadinessChecked, false);
  assert.equal(enqueueCalled, true);
  assert.equal(plannerExecuted, true);
  assert.equal(result?.userResponse?.ok, true);
  assert.equal(metadata?.execution_mode, "queue_shadow");
  assert.equal(metadata?.queue_enqueue_accepted, true);
  assert.equal(metadata?.planner_sync_executed, true);
  assert.equal(metadata?.queue_fallback_to_sync, false);
});

test("runPlannerUserInputEdge queue_authoritative mode skips sync planner execution after enqueue accepted", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-authoritative-session";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT = "100";
  let plannerExecuted = false;
  let workerReadinessChecked = false;

  const result = await runPlannerUserInputEdge({
    text: "這輪要走 queue authority",
    sessionKey: "queue-authoritative-session",
    traceId: "trace-queue-authoritative",
    async autonomyWorkerReadinessChecker() {
      workerReadinessChecked = true;
      return {
        ready: true,
        reason: "worker_ready",
      };
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "不應該走到這裡",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    async autonomyJobEnqueuer() {
      return {
        ok: true,
        job_id: "job_queue_authoritative_1",
        status: "queued",
        trace_id: "trace-queue-authoritative",
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(workerReadinessChecked, true);
  assert.equal(plannerExecuted, false);
  assert.deepEqual(Object.keys(result).sort(), ["plannerEnvelope", "plannerResult", "userResponse"]);
  assert.equal(result?.plannerResult?.action, "queue_authoritative_pending");
  assert.equal(result?.userResponse?.ok, true);
  assert.match(result?.userResponse?.limitations?.[0] || "", /非最終完成/);
  assert.equal(metadata?.execution_mode, "queue_authoritative");
  assert.equal(metadata?.completion_final, false);
  assert.equal(metadata?.completion_authority, "worker_verifier");
  assert.equal(metadata?.queue_enqueue_accepted, true);
  assert.equal(metadata?.planner_sync_executed, false);
});

test("runPlannerUserInputEdge queue_authoritative sampling is deterministic and request_id has higher priority than trace_id", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-authoritative-sampling-stable";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT = "50";

  async function runOnce({ requestId, traceId }) {
    let plannerExecuted = false;
    const result = await runPlannerUserInputEdge({
      text: "sampling stable check",
      sessionKey: "queue-authoritative-sampling-stable",
      requestId,
      traceId,
      async autonomyWorkerReadinessChecker() {
        return {
          ready: true,
          reason: "worker_ready",
        };
      },
      async autonomyJobEnqueuer() {
        return {
          ok: true,
          job_id: "job_sampling_stable",
          trace_id: traceId,
        };
      },
      async plannerExecutor() {
        plannerExecuted = true;
        return {
          ok: true,
          action: "get_runtime_info",
          execution_result: {
            ok: true,
            data: {
              answer: "sync fallback path",
              sources: ["sync"],
              limitations: [],
            },
          },
        };
      },
      workingMemoryWriter: null,
    });
    return {
      mode: readPlannerUserInputEdgeMetadata(result)?.execution_mode,
      plannerExecuted,
    };
  }

  const sameRequestDifferentTraceModes = new Set();
  const sameRequestDifferentTraceSyncFlags = new Set();
  for (let index = 0; index < 12; index += 1) {
    const run = await runOnce({
      requestId: "req-sampling-stable-priority",
      traceId: `trace-variant-${index}`,
    });
    sameRequestDifferentTraceModes.add(run.mode);
    sameRequestDifferentTraceSyncFlags.add(run.plannerExecuted);
  }
  assert.equal(sameRequestDifferentTraceModes.size, 1);
  assert.equal(sameRequestDifferentTraceSyncFlags.size, 1);

  const sameTraceWithoutRequestModes = new Set();
  for (let index = 0; index < 12; index += 1) {
    const run = await runOnce({
      requestId: "",
      traceId: "trace-sampling-stable-fallback",
    });
    sameTraceWithoutRequestModes.add(run.mode);
  }
  assert.equal(sameTraceWithoutRequestModes.size, 1);
});

test("runPlannerUserInputEdge queue_authoritative mode fail-soft falls back to sync planner when enqueue fails", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-authoritative-fallback";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  let plannerExecuted = false;

  const result = await runPlannerUserInputEdge({
    text: "queue authority fallback",
    sessionKey: "queue-authoritative-fallback",
    traceId: "trace-queue-authoritative-fallback",
    async autonomyWorkerReadinessChecker() {
      return {
        ready: true,
        reason: "worker_ready",
      };
    },
    async autonomyJobEnqueuer() {
      throw new Error("queue_unavailable");
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "search_and_summarize",
        execution_result: {
          ok: true,
          data: {
            answer: "這是 queue_authoritative fallback 的同步結果",
            sources: ["sync fallback"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(plannerExecuted, true);
  assert.equal(result?.userResponse?.ok, true);
  assert.match(result?.userResponse?.answer || "", /fallback 的同步結果/);
  assert.equal(metadata?.execution_mode, "queue_authoritative");
  assert.equal(metadata?.completion_final, true);
  assert.equal(metadata?.completion_authority, "sync_planner");
  assert.equal(metadata?.queue_fallback_to_sync, true);
});

test("runPlannerUserInputEdge queue_authoritative mode fail-closes to sync planner when worker is not ready", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-authoritative-worker-gate";
  process.env.PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED = "true";
  let plannerExecuted = false;
  let enqueueCalled = false;

  const result = await runPlannerUserInputEdge({
    text: "queue authority worker gate",
    sessionKey: "queue-authoritative-worker-gate",
    traceId: "trace-queue-authoritative-worker-gate",
    async autonomyWorkerReadinessChecker() {
      return {
        ready: false,
        reason: "worker_heartbeat_missing",
      };
    },
    async autonomyJobEnqueuer() {
      enqueueCalled = true;
      return {
        ok: true,
        job_id: "job_should_not_be_enqueued",
      };
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "search_and_summarize",
        execution_result: {
          ok: true,
          data: {
            answer: "worker not ready fallback sync",
            sources: ["sync fallback"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(plannerExecuted, true);
  assert.equal(enqueueCalled, false);
  assert.equal(result?.userResponse?.ok, true);
  assert.match(result?.userResponse?.answer || "", /fallback sync/);
  assert.equal(metadata?.execution_mode, "sync_authoritative");
  assert.equal(metadata?.queue_fallback_to_sync, true);
  assert.equal(metadata?.queue_enqueue_accepted, false);
  assert.equal(metadata?.enqueue_failure_reason, "worker_heartbeat_missing");
});

test("runPlannerUserInputEdge keeps queue_shadow behavior even when worker-ready gate is not ready", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:queue-shadow-still-enqueue";
  let plannerExecuted = false;
  let enqueueCalled = false;

  const result = await runPlannerUserInputEdge({
    text: "queue shadow still enqueue",
    sessionKey: "queue-shadow-still-enqueue",
    traceId: "trace-queue-shadow-still-enqueue",
    async autonomyWorkerReadinessChecker() {
      return {
        ready: false,
        reason: "worker_heartbeat_missing",
      };
    },
    async autonomyJobEnqueuer() {
      enqueueCalled = true;
      return {
        ok: true,
        job_id: "job_queue_shadow",
        trace_id: "trace-queue-shadow-still-enqueue",
      };
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "queue shadow sync still executed",
            sources: ["queue shadow"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  const metadata = readPlannerUserInputEdgeMetadata(result);
  assert.equal(enqueueCalled, true);
  assert.equal(plannerExecuted, true);
  assert.equal(result?.userResponse?.ok, true);
  assert.equal(metadata?.execution_mode, "queue_shadow");
  assert.equal(metadata?.queue_enqueue_accepted, true);
  assert.equal(metadata?.queue_fallback_to_sync, false);
});

test("runPlannerUserInputEdge keeps sync path when allowlist does not match", async () => {
  process.env.PLANNER_AUTONOMY_INGRESS_ENABLED = "true";
  process.env.PLANNER_AUTONOMY_INGRESS_ALLOWLIST = "session:someone-else";
  let enqueueCalled = false;
  let plannerExecuted = false;

  await runPlannerUserInputEdge({
    text: "這輪不入隊",
    sessionKey: "session-not-allowlisted",
    async autonomyJobEnqueuer() {
      enqueueCalled = true;
      return {
        ok: true,
      };
    },
    async plannerExecutor() {
      plannerExecuted = true;
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "同步路徑",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });

  assert.equal(enqueueCalled, false);
  assert.equal(plannerExecuted, true);
});

test("runPlannerUserInputEdge keeps planner execute -> envelope -> normalize on one shared helper", async () => {
  const calls = [];
  const plannerResult = {
    ok: true,
    action: "get_runtime_info",
    execution_result: {
      ok: true,
      action: "get_runtime_info",
      data: {
        answer: "runtime 正常",
        sources: ["runtime 即時狀態"],
        limitations: [],
      },
    },
  };

  const result = await runPlannerUserInputEdge({
    text: "幫我看 runtime",
    traceId: "trace-edge-1",
    handlerName: "planner-edge-test",
    async plannerExecutor(args) {
      calls.push(["execute", args.text, args.requestId || null]);
      return plannerResult;
    },
    envelopeBuilder(value) {
      calls.push(["envelope", value.action]);
      return {
        ok: true,
        action: value.action,
        trace: {
          chosen_action: value.action,
          fallback_reason: null,
        },
      };
    },
    envelopeDecorator(envelope, value) {
      calls.push(["decorate", value.action]);
      return {
        ...envelope,
        trace: {
          ...envelope.trace,
          edge_surface: "shared",
        },
      };
    },
    responseNormalizer(args) {
      calls.push(["normalize", args.plannerEnvelope.trace.edge_surface, args.requestText, args.traceId, args.handlerName]);
      return {
        ok: true,
        answer: "runtime 正常",
        sources: ["runtime 即時狀態"],
        limitations: [],
      };
    },
    workingMemoryWriter: null,
  });

  assert.equal(result.plannerResult, plannerResult);
  assert.equal(result.plannerEnvelope.trace.edge_surface, "shared");
  assert.deepEqual(result.userResponse, {
    ok: true,
    answer: "runtime 正常",
    sources: ["runtime 即時狀態"],
    limitations: [],
  });
  assert.deepEqual(calls, [
    ["execute", "幫我看 runtime", null],
    ["envelope", "get_runtime_info"],
    ["decorate", "get_runtime_info"],
    ["normalize", "shared", "幫我看 runtime", "trace-edge-1", "planner-edge-test"],
  ]);
});

test("runPlannerUserInputEdge recovers meeting planner_failed into a bounded workflow handoff reply", async () => {
  const result = await runPlannerUserInputEdge({
    text: "我要開會了",
    async plannerExecutor() {
      return {
        ok: false,
        error: "planner_failed",
      };
    },
  });

  assert.equal(result.plannerEnvelope.ok, true);
  assert.equal(result.plannerEnvelope.error, null);
  assert.equal(result.userResponse.ok, true);
  assert.equal(result.userResponse.failure_class, null);
  assert.match(result.userResponse.answer || "", /會議/);
  assert.doesNotMatch(result.userResponse.answer || "", /planner_failed/i);
});

test("runPlannerUserInputEdge recovers executive planner_failed into an owner-aware brief", async () => {
  const result = await runPlannerUserInputEdge({
    text: "先請各個 agent 一起看這批文檔，最後再統一收斂建議",
    async plannerExecutor() {
      return {
        ok: false,
        error: "planner_failed",
      };
    },
  });

  assert.equal(result.plannerEnvelope.ok, true);
  assert.equal(result.plannerEnvelope.error, null);
  assert.equal(result.userResponse.ok, true);
  assert.equal(result.userResponse.failure_class, null);
  assert.match(result.userResponse.answer || "", /executive|agent|協作|收斂/i);
});

test("runPlannerUserInputEdge recovers explicit persona-style executive requests into agent-aware brief text", async () => {
  const result = await runPlannerUserInputEdge({
    text: "請 consult agent 做方案比較",
    async plannerExecutor() {
      return {
        ok: false,
        error: "planner_failed",
      };
    },
  });

  assert.equal(result.plannerEnvelope.ok, true);
  assert.equal(result.userResponse.ok, true);
  assert.equal(result.userResponse.failure_class, null);
  assert.match(result.userResponse.answer || "", /\/consult/);
  assert.doesNotMatch(result.userResponse.answer || "", /planner_failed/i);
});

test("runPlannerUserInputEdge fail-closes unsupported reminder requests instead of surfacing planner_failed", async () => {
  const result = await runPlannerUserInputEdge({
    text: "晚點提醒我一下",
    async plannerExecutor() {
      return {
        ok: false,
        error: "planner_failed",
      };
    },
  });

  assert.equal(result.plannerEnvelope.ok, false);
  assert.equal(result.plannerEnvelope.error, ROUTING_NO_MATCH);
  assert.equal(result.userResponse.ok, false);
  assert.equal(result.userResponse.failure_class, "routing_no_match");
  assert.match(result.userResponse.answer || "", /合適的處理方式|一般助理/);
  assert.doesNotMatch(result.userResponse.answer || "", /planner_failed/i);
});

test("runPlannerUserInputEdge writes working-memory patch at answer boundary when output is stable", async () => {
  const memoryWrites = [];
  const result = await runPlannerUserInputEdge({
    text: "幫我整理 onboarding 重點",
    sessionKey: "wm-boundary-session",
    async plannerExecutor() {
      return {
        ok: true,
        action: "search_and_summarize",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "這是整理後的重點。",
            sources: ["onboarding v1"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter(input) {
      memoryWrites.push(input);
      return {
        ok: true,
        observability: {
          memory_snapshot: {
            current_goal: "幫我整理 onboarding 重點",
          },
        },
      };
    },
  });

  assert.equal(result.userResponse.ok, true);
  assert.equal(memoryWrites.length, 1);
  assert.equal(memoryWrites[0].sessionKey, "wm-boundary-session");
  assert.equal(memoryWrites[0].source, "planner_answer_boundary_v1");
  assert.equal(memoryWrites[0].patch.current_goal, "幫我整理 onboarding 重點");
  assert.equal(memoryWrites[0].patch.inferred_task_type, "skill_read");
  assert.equal(memoryWrites[0].patch.last_selected_agent, "doc_agent");
  assert.equal(memoryWrites[0].patch.last_selected_skill, "search_and_summarize");
  assert.equal(Array.isArray(memoryWrites[0].patch.unresolved_slots), true);
});

test("runPlannerUserInputEdge skips working-memory write when response is not stable", async () => {
  let writeAttempted = false;
  await runPlannerUserInputEdge({
    text: "這輪先不用回覆",
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {},
        },
      };
    },
    responseNormalizer() {
      return {
        ok: true,
        answer: null,
        sources: [],
        limitations: [],
      };
    },
    async workingMemoryWriter() {
      writeAttempted = true;
      return {
        ok: true,
      };
    },
  });

  assert.equal(writeAttempted, false);
});

test("runPlannerUserInputEdge adds retry continuity context and usage-layer diagnostics", async () => {
  const memoryLogs = [];
  const result = await runPlannerUserInputEdge({
    text: "再試一次",
    sessionKey: "wm-usage-retry",
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    async plannerExecutor() {
      return {
        ok: true,
        action: "search_company_brain_docs",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "已完成重試。",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter() {
      return {
        ok: true,
        observability: {
          memory_snapshot: {
            task_id: "task-usage-retry",
            task_type: "document_lookup",
            task_phase: "retrying",
            task_status: "failed",
            current_owner_agent: "doc_agent",
            next_best_action: "search_company_brain_docs",
            unresolved_slots: [],
            slot_state: [],
          },
          resumed_from_retry: true,
          recovery_action: "retry_same_step",
        },
      };
    },
  });

  assert.equal(result.userResponse.ok, true);
  assert.match((result.userResponse.sources || [])[0] || "", /上一輪|重試|剛剛那一步|核對/);
  const boundaryLog = memoryLogs.find((item) => item?.memory_stage === "answer_boundary_write_back");
  assert.ok(boundaryLog);
  assert.equal(typeof boundaryLog?.usage_layer_summary, "string");
  assert.equal(boundaryLog?.usage_layer?.interpreted_as_continuation, true);
  assert.equal(boundaryLog?.usage_layer?.retry_context_applied, true);
});

test("runPlannerUserInputEdge adds reroute continuity context and surfaces usage issue codes", async () => {
  const memoryLogs = [];
  const result = await runPlannerUserInputEdge({
    text: "接著改由 runtime 處理",
    sessionKey: "wm-usage-reroute",
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_runtime_info",
        synthetic_agent_hint: {
          agent: "runtime_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "runtime 路徑已更新。",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter() {
      return {
        ok: true,
        observability: {
          memory_snapshot: {
            task_id: "task-usage-reroute",
            task_type: "document_lookup",
            task_phase: "retrying",
            task_status: "failed",
            current_owner_agent: "runtime_agent",
            previous_owner_agent: "doc_agent",
            next_best_action: "get_runtime_info",
            unresolved_slots: [],
            slot_state: [],
          },
          resumed_from_retry: true,
          recovery_action: "reroute_owner",
          agent_handoff: {
            from: "doc_agent",
            to: "runtime_agent",
            reason: "capability_gap",
          },
        },
      };
    },
  });

  assert.equal(result.userResponse.ok, true);
  assert.match((result.userResponse.sources || [])[0] || "", /改由 runtime_agent/);
  const boundaryLog = memoryLogs.find((item) => item?.memory_stage === "answer_boundary_write_back");
  assert.ok(boundaryLog);
  assert.equal(Array.isArray(boundaryLog?.usage_layer?.usage_issue_codes), true);
  assert.equal(boundaryLog.usage_layer.usage_issue_codes.includes("reroute_without_user_visible_context"), false);
});

test("runPlannerUserInputEdge suppresses redundant ask_user when filled slot is reusable", async () => {
  const memoryLogs = [];
  const result = await runPlannerUserInputEdge({
    text: "我剛剛已經給過了",
    sessionKey: "wm-usage-slot-suppress",
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    async plannerExecutor() {
      return {
        ok: false,
        error: "missing_slot",
        execution_result: {
          ok: false,
          data: {
            answer: "請再提供文件編號。",
            sources: [],
            limitations: ["請補文件編號"],
          },
        },
      };
    },
    workingMemoryWriter() {
      return {
        ok: true,
        observability: {
          slot_suppressed_ask: true,
          recovery_action: "ask_user",
          recommended_action: "ask_user",
          memory_snapshot: {
            task_id: "task-usage-slot-suppress",
            task_type: "document_lookup",
            task_phase: "waiting_user",
            task_status: "blocked",
            current_owner_agent: "doc_agent",
            next_best_action: "get_company_brain_doc_detail",
            unresolved_slots: [],
            slot_state: [
              {
                slot_key: "candidate_selection_required",
                status: "filled",
                ttl: "2030-01-01T00:00:00.000Z",
              },
            ],
          },
        },
      };
    },
  });

  assert.equal(result.userResponse.ok, true);
  assert.match(result.userResponse.answer || "", /不再重複向你詢問|直接接續原步驟/);
  const boundaryLog = memoryLogs.find((item) => item?.memory_stage === "answer_boundary_write_back");
  assert.ok(boundaryLog);
  assert.equal(boundaryLog?.usage_layer?.slot_suppressed_ask, true);
});
