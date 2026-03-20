import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLifecycleTransition,
  canTransitionTaskState,
  getAllowedTaskTransitions,
  isTerminalTaskState,
} from "../src/executive-lifecycle.mjs";

test("lifecycle allows created to planned path", () => {
  assert.equal(canTransitionTaskState("created", "clarified"), true);
  assert.equal(canTransitionTaskState("clarified", "planned"), true);
  assert.equal(canTransitionTaskState("planned", "executing"), true);
  assert.match(getAllowedTaskTransitions("planned").join(","), /executing/);
});

test("lifecycle blocks invalid transition", () => {
  const result = buildLifecycleTransition({
    from: "created",
    to: "completed",
    reason: "skip_verification",
  });

  assert.equal(result.ok, false);
});

test("completed and failed are terminal states", () => {
  assert.equal(isTerminalTaskState("completed"), true);
  assert.equal(isTerminalTaskState("failed"), true);
  assert.equal(isTerminalTaskState("executing"), false);
});

test("verification failure cannot jump directly to failed", () => {
  assert.equal(canTransitionTaskState("verifying", "failed"), false);
  assert.equal(canTransitionTaskState("verifying", "blocked"), true);
  assert.equal(canTransitionTaskState("verifying", "escalated"), true);
});
