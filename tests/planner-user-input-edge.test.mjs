import test from "node:test";
import assert from "node:assert/strict";

const { runPlannerUserInputEdge } = await import("../src/planner-user-input-edge.mjs");

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
      calls.push(["normalize", args.plannerEnvelope.trace.edge_surface, args.traceId, args.handlerName]);
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
    ["normalize", "shared", "trace-edge-1", "planner-edge-test"],
  ]);
});
