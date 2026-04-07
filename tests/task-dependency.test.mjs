import test from "node:test";
import assert from "node:assert/strict";

import { sortTasks } from "../src/task-layer/task-dependency.mjs";

test("sortTasks normalizes detected task order", () => {
  const result = sortTasks(["publish", "copywriting", "image"]);

  assert.deepEqual(result, ["copywriting", "image", "publish"]);
});
