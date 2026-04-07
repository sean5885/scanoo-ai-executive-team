import test from "node:test";
import assert from "node:assert/strict";

import { runTaskLayer } from "../src/task-layer/orchestrator.mjs";

test("real routing maps multi-task input to checked-in routing identifiers", async () => {
  const called = [];

  await runTaskLayer("做文案+配圖+發布", async (name) => {
    called.push(name);
    return { handledBy: name };
  });

  assert.deepEqual(called, [
    "document_summarize",
    "image_generate",
    "message_send",
  ]);
  assert.ok(called.length >= 2);
});
