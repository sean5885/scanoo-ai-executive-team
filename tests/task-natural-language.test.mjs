import test from "node:test";
import assert from "node:assert/strict";

import { toUserFacing } from "../src/task-layer/task-to-answer.mjs";

test("natural language output includes real content for completed tasks", () => {
  const reply = toUserFacing({
    ok: true,
    summary: {
      copywriting: "done",
      image: "done",
      publish: "done",
    },
    data: {
      copywriting: "這是一段文案",
      image: "img.png",
      publish: true,
    },
    errors: [],
    tasks: ["copywriting", "image", "publish"],
  });

  assert.match(reply.answer, /文案：這是一段文案/);
  assert.match(reply.answer, /圖片：已生成（img\.png）/);
  assert.match(reply.answer, /發布：已完成/);
});
