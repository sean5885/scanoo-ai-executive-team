import test from "node:test";
import assert from "node:assert/strict";

import { usageLayerEvals } from "../evals/usage-layer/usage-layer-evals.mjs";
import { runUsageLayerEvalCase } from "../evals/usage-layer/usage-layer-runner.mjs";

test("usage-layer runner executes registered slash-agent cases on the agent answer path", async () => {
  const testCase = usageLayerEvals.find((entry) => entry.id === "entry-008");
  assert.ok(testCase, "missing entry-008 usage-layer case");

  const result = await runUsageLayerEvalCase(testCase);

  assert.equal(result.actual_lane, "registered_agent");
  assert.equal(result.actual_action, "dispatch_registered_agent");
  assert.equal(result.executed_target, "agent:cmo");
  assert.equal(result.actual_success_type, "direct_answer");
  assert.equal(result.generic, false);
  assert.equal(result.first_turn_success, true);
  assert.match(result.reply_text, /\/cmo/);
  assert.match(result.reply_text, /整理定位/);
});
