import test from "node:test";
import assert from "node:assert/strict";

import { runTaskLayer } from "../src/task-layer/orchestrator.mjs";
import { classifyTask } from "../src/task-layer/task-classifier.mjs";

test("classifyTask returns stable task tags from keyword heuristics", () => {
  assert.deepEqual(classifyTask("請幫我寫文案、做配圖，最後發布"), [
    "copywriting",
    "image",
    "publish",
  ]);
  assert.deepEqual(classifyTask("只是查詢資料"), []);
});

test("runTaskLayer maps tasks to skills and records per-task failures", async () => {
  const calls = [];
  const result = await runTaskLayer("請幫我寫文案、做配圖，最後發布", async (skill, payload) => {
    calls.push({ skill, payload });
    if (skill === "publish_agent") {
      throw new Error("publish blocked");
    }
    return { handledBy: skill, task: payload.task };
  });

  assert.deepEqual(result.tasks, ["copywriting", "image", "publish"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    copywriting: "done",
    image: "done",
    publish: "failed",
  });
  assert.deepEqual(result.data, {
    copywriting: {
      handledBy: "copy_agent",
      task: "copywriting",
    },
    image: {
      handledBy: "image_agent",
      task: "image",
    },
  });
  assert.deepEqual(result.errors, [
    {
      task: "publish",
      error: "publish blocked",
    },
  ]);
  assert.deepEqual(calls, [
    {
      skill: "copy_agent",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "copywriting",
      },
    },
    {
      skill: "image_agent",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "image",
      },
    },
    {
      skill: "publish_agent",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "publish",
      },
    },
  ]);
  assert.deepEqual(result.results, [
    {
      task: "copywriting",
      ok: true,
      result: {
        handledBy: "copy_agent",
        task: "copywriting",
      },
    },
    {
      task: "image",
      ok: true,
      result: {
        handledBy: "image_agent",
        task: "image",
      },
    },
    {
      task: "publish",
      ok: false,
      error: "publish blocked",
    },
  ]);
});
