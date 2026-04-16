import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

import { runTaskLayer } from "../src/task-layer/orchestrator.mjs";

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test("real routing maps multi-task input to checked-in routing identifiers", async () => {
  const called = [];

  await runTaskLayer("做文案+配圖+發布", async (name) => {
    called.push(name);
    return { handledBy: name };
  });

  assert.deepEqual(called, [
    "document_summarize",
    "image_generate",
  ]);
  assert.ok(called.length >= 2);
});
