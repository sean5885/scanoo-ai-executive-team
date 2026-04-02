import test from "node:test";
import assert from "node:assert/strict";

import { usageLayerEvals } from "../evals/usage-layer/usage-layer-evals.mjs";
import { runUsageLayerEvalCase, summarizeResults } from "../evals/usage-layer/usage-layer-runner.mjs";

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

test("usage-layer summary reports timed out cases separately", () => {
  const summary = summarizeResults([
    {
      id: "entry-timeout",
      user_text: "把非 scanoo 的文檔摘出去",
      should_fail_if_generic: true,
      actual_success_type: "fail_soft",
      expected_success_type: "workflow_progress",
      actual_lane: "cloud_doc_workflow",
      actual_action: "rereview",
      actual_tool: "workflow:cloud_doc_organization",
      expected_lane: "cloud_doc_workflow",
      expected_planner_action: "rereview",
      expected_agent_or_tool: "workflow:cloud_doc_organization",
      first_turn_success: false,
      wrong_route: false,
      tool_omission: false,
      generic: false,
      unnecessary_clarification: false,
      failure_class: "timeout",
      timed_out: true,
      duration_ms: 20001,
    },
  ]);

  assert.equal(summary.counts.timed_out, 1);
  assert.equal(summary.failure_breakdown.timeout, 1);
  assert.deepEqual(summary.timed_out_cases, [
    {
      id: "entry-timeout",
      user_text: "把非 scanoo 的文檔摘出去",
      duration_ms: 20001,
    },
  ]);
});
