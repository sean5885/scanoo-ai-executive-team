import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveVerificationOutcome } from "../src/executive-closed-loop.mjs";
import { shouldPreferActiveExecutiveTask } from "../src/lane-executor.mjs";

test("verifier fail does not resolve to completed", () => {
  const outcome = resolveVerificationOutcome({
    pass: false,
    fake_completion: false,
    required_evidence_present: false,
  });

  assert.notEqual(outcome.nextState, "completed");
  assert.notEqual(outcome.nextStatus, "completed");
  assert.equal(outcome.nextState, "executing");
  assert.equal(outcome.nextStatus, "retrying");
});

test("active_task follow-up prefers same-session executive workflow", () => {
  assert.equal(
    shouldPreferActiveExecutiveTask({
      activeTask: {
        id: "task-1",
        status: "active",
        workflow: "executive",
      },
      lane: "personal-assistant",
      wantsCloudOrganizationFollowUp: true,
    }),
    true,
  );

  assert.equal(
    shouldPreferActiveExecutiveTask({
      activeTask: null,
      lane: "personal-assistant",
      wantsCloudOrganizationFollowUp: true,
    }),
    false,
  );
});

test("lane-executor does not directly declare executive task completion", () => {
  const source = fs.readFileSync(new URL("../src/lane-executor.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /updateExecutiveTask\s*\(/);
  assert.doesNotMatch(source, /clearActiveExecutiveTask\s*\(/);
  assert.doesNotMatch(source, /status\s*:\s*["']completed["']/);
  assert.doesNotMatch(source, /lifecycle_state\s*:\s*["']completed["']/);
});
