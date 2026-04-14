import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTaskLayerResult, toUserFacing } from "../src/task-layer/task-to-answer.mjs";

test("normalizeTaskLayerResult rebuilds summary and errors from partial task-layer input", () => {
  const result = normalizeTaskLayerResult({
    tasks: ["copywriting", "publish"],
    summary: { copywriting: "done", publish: "failed" },
    data: {
      copywriting: {
        handledBy: "document_summarize",
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
  assert.equal(result.partial, true);
  assert.equal(result.results[0].status, "done");
  assert.equal(result.results[1].status, "failed");
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
  assert.equal(reply.partial, true);
  assert.equal(reply.answer, "文案：新品上市，現在就來看看。");
  assert.deepEqual(reply.sources, [
    "任務拆解：文案、發布。",
    "文案 已完成執行。",
  ]);
  assert.deepEqual(reply.limitations, [
    "發布 這一步目前未完成（publish blocked）。",
    "下一步：你可以讓我直接重試失敗項目，或指定要優先完成的子任務。",
  ]);
});

test("toUserFacing does not render placeholder image URL as a successful image result", () => {
  const reply = toUserFacing({
    ok: true,
    summary: {
      image: "done",
    },
    data: {
      image: {
        url: "https://dummyimage.com/512x512/000/fff.png&text=cat",
      },
    },
    errors: [],
    tasks: ["image"],
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.partial, false);
  assert.equal(reply.answer, "這輪先依多任務路徑拆出 1 個子任務：圖片，但目前都還沒有成功完成。");
  assert.deepEqual(reply.sources, [
    "任務拆解：圖片。",
  ]);
  assert.deepEqual(reply.limitations, [
    "圖片 輸出被安全規則攔截（placeholder URL 不視為有效圖片結果）。",
    "下一步：你可以讓我直接重試失敗項目，或指定要優先完成的子任務。",
  ]);
});
