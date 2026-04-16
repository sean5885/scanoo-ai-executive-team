import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

import { toUserFacing } from "../src/task-layer/task-to-answer.mjs";

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test("natural language output fail-closes unregistered publish success while preserving other completed tasks", () => {
  const reply = toUserFacing({
    ok: true,
    results: [
      {
        task: "copywriting",
        status: "done",
        ok: true,
        skill: "document_summarize",
        result: "這是一段文案",
      },
      {
        task: "image",
        status: "done",
        ok: true,
        skill: "image_generate",
        result: "img.png",
      },
      {
        task: "publish",
        status: "done",
        ok: true,
        skill: "message_send",
        result: true,
      },
    ],
    tasks: ["copywriting", "image", "publish"],
  });

  assert.match(reply.answer, /文案：這是一段文案/);
  assert.match(reply.answer, /圖片：已生成（img\.png）/);
  assert.doesNotMatch(reply.answer, /發布：已完成/);
  assert.deepEqual(reply.limitations, [
    "發布 目前映射到的能力未在 checked-in skill registry 註冊，系統已 fail-closed。",
    "下一步：你可以讓我直接重試失敗項目，或指定要優先完成的子任務。",
  ]);
});
