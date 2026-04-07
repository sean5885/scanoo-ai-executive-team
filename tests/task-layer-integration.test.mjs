import test from "node:test";
import assert from "node:assert/strict";

import { executePlannedUserInput } from "../src/executive-planner.mjs";

test("executePlannedUserInput short-circuits to multi-task result when task-layer detects multiple tasks", async () => {
  let requesterCalled = false;
  const result = await executePlannedUserInput({
    text: "做文案、配圖、最後發布",
    async requester() {
      requesterCalled = true;
      return JSON.stringify({ action: "get_runtime_info", params: {} });
    },
    async runSkill(name, payload) {
      return { name, task: payload.task };
    },
  });

  assert.equal(requesterCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.action, "multi_task");
  assert.equal(result.execution_result?.data?.mode, "multi_task");
  assert.deepEqual(result.execution_result?.data?.tasks, ["copywriting", "image", "publish"]);
  assert.equal(result.execution_result?.data?.results?.length, 3);
  assert.match(result.execution_result?.data?.answer || "", /多任務路徑/);
});

test("executePlannedUserInput falls back to the original planner flow when task-layer finds at most one task", async () => {
  let requesterCalled = false;
  let toolFlowCalled = false;
  const result = await executePlannedUserInput({
    text: "幫我做文案",
    async requester() {
      requesterCalled = true;
      return JSON.stringify({ action: "get_runtime_info", params: {} });
    },
    async runSkill(name, payload) {
      return { name, task: payload.task };
    },
    async toolFlowRunner() {
      toolFlowCalled = true;
      return {
        selected_action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "runtime info ready",
            sources: ["tool flow fallback"],
            limitations: [],
          },
        },
        formatted_output: null,
        trace_id: "trace_task_layer_fallback",
      };
    },
  });

  assert.equal(requesterCalled, true);
  assert.equal(toolFlowCalled, true);
  assert.equal(result.action, "get_runtime_info");
  assert.equal(result.execution_result?.data?.answer, "runtime info ready");
  assert.equal(result.trace_id, "trace_task_layer_fallback");
});
