import test from "node:test";
import assert from "node:assert/strict";

import { aggregateResults } from "../src/task-layer/task-aggregator.mjs";

test("aggregateResults produces unified summary, data, and errors", () => {
  const result = aggregateResults({
    tasks: ["a", "b"],
    results: [
      { task: "a", ok: true, result: 1 },
      { task: "b", ok: false, error: "err" },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.tasks, ["a", "b"]);
  assert.deepEqual(result.results, [
    { task: "a", ok: true, result: 1 },
    { task: "b", ok: false, error: "err" },
  ]);
  assert.deepEqual(result.summary, {
    a: "done",
    b: "failed",
  });
  assert.deepEqual(result.data, { a: 1 });
  assert.deepEqual(result.errors, [{ task: "b", error: "err" }]);
});
