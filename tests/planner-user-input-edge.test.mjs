import test from "node:test";
import assert from "node:assert/strict";

const { runPlannerUserInputEdge } = await import("../src/planner-user-input-edge.mjs");
const { ROUTING_NO_MATCH } = await import("../src/planner-error-codes.mjs");

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
  assert.match(result.userResponse.answer || "", /提醒/);
  assert.doesNotMatch(result.userResponse.answer || "", /planner_failed/i);
});
