import test from "node:test";
import assert from "node:assert/strict";

import {
  resetSingleMachineRuntimeCoordinationForTests,
  runInSingleMachineRuntimeSession,
} from "../src/single-machine-runtime-coordination.mjs";

test.beforeEach(() => {
  resetSingleMachineRuntimeCoordinationForTests();
});

test("same-session runtime coordination runs work serially", async () => {
  const steps = [];
  let releaseFirst = null;

  const first = runInSingleMachineRuntimeSession({
    accountId: "acct-1",
    sessionKey: "session-1",
    workflow: "executive",
    reason: "first",
  }, async () => {
    steps.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    steps.push("first:end");
  });

  await Promise.resolve();

  const second = runInSingleMachineRuntimeSession({
    accountId: "acct-1",
    sessionKey: "session-1",
    workflow: "executive",
    reason: "second",
  }, async () => {
    steps.push("second:start");
    steps.push("second:end");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(steps, ["first:start"]);

  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(steps, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});
