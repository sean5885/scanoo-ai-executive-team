import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlannedUserInputExecutionRuntime,
  PLANNED_USER_INPUT_RUNTIME_VERSION,
} from "../src/execution/planned-user-input-runtime.mjs";

function buildDeps(overrides = {}) {
  return {
    cleanText: (value = "") => String(value || "").trim(),
    derivePlannerAbortInfo: () => null,
    normalizeDecisionAlternative: (value = null) => value,
    resolvePlannerWorkingMemoryContinuation: () => ({ selected_action: "", observability: null }),
    canUseWorkingMemoryAction: () => false,
    buildPlannerWorkingMemoryContinuationParams: () => ({}),
    validatePlannerUserInputDecision: (decision = {}) => ({ ok: true, action: decision.action, params: decision.params }),
    withUserInputDecisionExplanation: (decision = {}) => decision,
    planUserInputAction: async () => ({ action: "get_runtime_info", params: {} }),
    buildTaskLayerPlannerResult: (result = {}) => result,
    resolveRuntimeInfoFastPathDecision: () => null,
    logPlannerWorkingMemoryTrace: () => {},
    createPlannerVisibleTelemetryMonitor: () => null,
    emitPlannerVisibleTelemetryForMonitor: () => {},
    buildPlannerAbortResult: () => null,
    buildPlannerAgentOutput: (payload = {}) => payload,
    normalizePlannerFormattedOutput: (value = null) => value,
    extractPlannerFormattedOutput: () => null,
    copyPlannerVisibleTelemetryContext: () => {},
    resolveDeterministicPlannerFallbackSelection: () => null,
    emitPlannerFailedAlert: () => {},
    buildPlannerMultiStepOutput: (value = {}) => value,
    buildPlannerLastErrorRecord: (value = {}) => value,
    normalizePlannerPayload: (value = {}) => value,
    getPlannerDecisionRepresentativeAction: () => null,
    normalizeDecisionReasoning: ({ why = "", alternative = null } = {}) => ({ why, alternative }),
    defaultRequester: async () => "{}",
    ...overrides,
  };
}

test("planned user input runtime exposes stable version", () => {
  const runtime = createPlannedUserInputExecutionRuntime(buildDeps());
  assert.equal(runtime.version, PLANNED_USER_INPUT_RUNTIME_VERSION);
});

test("planned user input runtime executes strict single-step path", async () => {
  const runtime = createPlannedUserInputExecutionRuntime(buildDeps());
  const result = await runtime.executePlannedUserInput({
    text: "show runtime info",
    requester: async () => "{}",
    toolFlowRunner: async () => ({
      execution_result: { ok: true, data: { answer: "ok" } },
      trace_id: "trace-test",
      formatted_output: { answer_text: "ok" },
    }),
    multiStepRunner: async () => ({ ok: true }),
    dispatcher: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "get_runtime_info");
});
