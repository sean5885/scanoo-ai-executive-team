import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { runPlannerUserInputEdge } = await import("../src/planner-user-input-edge.mjs");
const { ROUTING_NO_MATCH } = await import("../src/planner-error-codes.mjs");

test.after(() => {
  testDb.close();
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
