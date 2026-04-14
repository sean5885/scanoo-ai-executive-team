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
      if (payload.task === "copywriting") {
        return { answer: "新品開跑，限時搶先看。" };
      }
      if (payload.task === "image") {
        return { url: "hero.png" };
      }
      if (payload.task === "publish") {
        return true;
      }
      return { name, task: payload.task };
    },
  });

  assert.equal(requesterCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.action, "multi_task");
  assert.equal(result.execution_result?.data?.mode, "multi_task");
  assert.deepEqual(result.execution_result?.data?.tasks, ["copywriting", "image", "publish"]);
  assert.equal(result.execution_result?.data?.results?.length, 3);
  assert.deepEqual(result.execution_result?.data?.summary, {
    copywriting: "done",
    image: "done",
    publish: "done",
  });
  assert.equal(
    result.execution_result?.data?.answer,
    "文案：新品開跑，限時搶先看。\n圖片：已生成（hero.png）\n發布：已完成",
  );
  assert.deepEqual(result.execution_result?.data?.sources, [
    "任務拆解：文案、圖片、發布。",
    "文案 已完成執行。",
    "圖片 已完成執行。",
    "發布 已完成執行。",
  ]);
  assert.deepEqual(result.execution_result?.data?.limitations, [
    "下一步：如果你要，我可以把每個子任務展開成更完整的最終稿或後續步驟。",
  ]);
  assert.equal(result.execution_result?.data?.partial, false);
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

test("executePlannedUserInput keeps image task fail-closed when backend is unavailable", async () => {
  const result = await executePlannedUserInput({
    text: "做文案、配圖、最後發布",
    async requester() {
      return JSON.stringify({ action: "get_runtime_info", params: {} });
    },
    async runSkill(name, payload) {
      if (payload.task === "copywriting") {
        return { answer: "新品開跑，限時搶先看。" };
      }
      if (payload.task === "image") {
        return {
          ok: false,
          error: "business_error",
          details: {
            failure_class: "capability_gap",
            reason: "image_backend_unavailable",
          },
        };
      }
      if (payload.task === "publish") {
        return true;
      }
      return { name, task: payload.task };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "multi_task");
  assert.deepEqual(result.execution_result?.data?.summary, {
    copywriting: "done",
    image: "blocked",
    publish: "done",
  });
  assert.equal(result.execution_result?.data?.partial, true);
  assert.match(result.execution_result?.data?.answer, /文案：新品開跑，限時搶先看。/);
  assert.doesNotMatch(result.execution_result?.data?.answer, /圖片：已生成/);
  assert.deepEqual(result.execution_result?.data?.limitations, [
    "圖片 目前缺少可用 image backend，系統已 fail-closed 並阻擋偽成功輸出。",
    "下一步：你可以讓我直接重試失敗項目，或指定要優先完成的子任務。",
  ]);
});
