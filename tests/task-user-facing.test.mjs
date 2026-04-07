import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTaskLayerResult, toUserFacing } from "../src/task-layer/task-to-answer.mjs";

test("normalizeTaskLayerResult rebuilds summary and errors from partial task-layer input", () => {
  const result = normalizeTaskLayerResult({
    tasks: ["copywriting", "publish"],
    summary: { copywriting: "done", publish: "failed" },
    data: {
      copywriting: {
        handledBy: "copy_agent",
      },
    },
    errors: [{ task: "publish", error: "publish blocked" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, {
    copywriting: "done",
    publish: "failed",
  });
  assert.deepEqual(result.errors, [
    { task: "publish", error: "publish blocked" },
  ]);
  assert.equal(result.results.length, 2);
});

test("toUserFacing renders canonical answer, sources, and limitations for mixed task results", () => {
  const reply = toUserFacing({
    ok: false,
    summary: { copywriting: "done", publish: "failed" },
    data: {
      copywriting: { answer: "新品上市，現在就來看看。" },
    },
    errors: [{ task: "publish", error: "publish blocked" }],
    tasks: ["copywriting", "publish"],
  });

  assert.equal(reply.ok, true);
  assert.equal(reply.answer, "文案：新品上市，現在就來看看。");
  assert.deepEqual(reply.sources, [
    "任務拆解：文案、發布。",
    "文案 已完成執行。",
  ]);
  assert.deepEqual(reply.limitations, [
    "發布 目前未完成：publish blocked。",
  ]);
});
