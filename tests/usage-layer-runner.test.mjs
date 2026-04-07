import test from "node:test";
import assert from "node:assert/strict";

import { usageLayerEvals } from "../evals/usage-layer/usage-layer-evals.mjs";
import { followupMultiIntentContinuityEvals } from "../evals/usage-layer/followup-multi-intent-continuity-evals.mjs";
import { registeredAgentFamilyEvals } from "../evals/usage-layer/registered-agent-family-evals.mjs";
import { workflowTimeoutGovernanceEvals } from "../evals/usage-layer/workflow-timeout-governance-evals.mjs";
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
      tool_required: true,
      expected_eval_outcome: "good_answer",
      should_fail_if_generic: true,
      actual_success_type: "fail_soft",
      actual_eval_outcome: "fail_closed",
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
  assert.equal(summary.metrics.generic_rate, "0.00%");
  assert.equal(summary.metrics.partial_success_rate, "0.00%");
  assert.equal(summary.actual_outcome_breakdown.fail_closed, 1);
  assert.deepEqual(summary.timed_out_cases, [
    {
      id: "entry-timeout",
      user_text: "把非 scanoo 的文檔摘出去",
      duration_ms: 20001,
    },
  ]);
  assert.equal(summary.counts.unclassified_timeout, 0);
  assert.equal(summary.governance_breakdown.timeout_fail_closed, 1);
});

test("usage-layer eval pack expands to quality-gate scale without expected generic replies", () => {
  assert.equal(usageLayerEvals.length >= 40 && usageLayerEvals.length <= 60, true);
  assert.equal(
    usageLayerEvals.some((entry) => entry.expected_eval_outcome === "generic_reply"),
    false,
  );
  assert.equal(
    usageLayerEvals.some((entry) => entry.expected_eval_outcome === "partial_success"),
    true,
  );
  assert.equal(
    usageLayerEvals.some((entry) => entry.expected_eval_outcome === "fail_closed"),
    true,
  );
});

test("usage-layer runner keeps persona-style registered-agent family on the owner-aware answer surface", async () => {
  const testCase = registeredAgentFamilyEvals.find((entry) => entry.id === "registered-agent-family-007");
  assert.ok(testCase, "missing registered-agent-family-007");

  const result = await runUsageLayerEvalCase(testCase);

  assert.equal(result.actual_lane, "executive");
  assert.equal(result.executed_target, "agent:consult");
  assert.equal(result.actual_owner_surface, "agent:consult");
  assert.equal(result.wrong_owner_surface, false);
  assert.match(result.reply_text, /\/consult/);
});

test("registered-agent family pack stays bounded and covers owner surface plus fail-closed edges", () => {
  assert.equal(registeredAgentFamilyEvals.length >= 15 && registeredAgentFamilyEvals.length <= 20, true);
  assert.equal(
    registeredAgentFamilyEvals.some((entry) => entry.expected_owner_surface?.startsWith("agent:")),
    true,
  );
  assert.equal(
    registeredAgentFamilyEvals.some((entry) => entry.expected_owner_surface === "permission_denied"),
    true,
  );
  assert.equal(
    registeredAgentFamilyEvals.some((entry) => entry.expected_owner_surface === "routing_no_match"),
    true,
  );
});

test("follow-up and multi-intent continuity pack stays focused and covers partial plus fail-closed edges", () => {
  assert.equal(followupMultiIntentContinuityEvals.length >= 15 && followupMultiIntentContinuityEvals.length <= 20, true);
  assert.equal(
    followupMultiIntentContinuityEvals.some((entry) => entry.expected_eval_outcome === "partial_success"),
    true,
  );
  assert.equal(
    followupMultiIntentContinuityEvals.some((entry) => entry.expected_eval_outcome === "fail_closed"),
    true,
  );
});

test("usage-layer runner keeps contextual second-turn follow-up replies out of generic fallback", async () => {
  const testCase = followupMultiIntentContinuityEvals.find((entry) => entry.id === "continuity-001");
  assert.ok(testCase, "missing continuity-001");

  const result = await runUsageLayerEvalCase(testCase);

  assert.equal(result.actual_lane, "knowledge_assistant");
  assert.equal(result.actual_action, "get_company_brain_doc_detail");
  assert.equal(result.generic, false);
  assert.equal(result.first_turn_success, true);
  assert.match(result.reply_text, /Onboarding SOP/);
});

test("usage-layer runner marks successful lookup-plus-delivery requests as partial success", async () => {
  const testCase = followupMultiIntentContinuityEvals.find((entry) => entry.id === "multi-intent-010");
  assert.ok(testCase, "missing multi-intent-010");

  const result = await runUsageLayerEvalCase(testCase);

  assert.equal(result.actual_eval_outcome, "partial_success");
  assert.equal(result.actual_success_type, "partial_success");
  assert.equal(result.generic, false);
  assert.match(result.reply_text, /OKR Weekly Review/);
  assert.match(result.reply_text, /不能直接替你送出|手動貼上/);
});

test("workflow timeout governance pack stays bounded to the controlled timeout families", () => {
  assert.equal(workflowTimeoutGovernanceEvals.length, 5);
  assert.deepEqual(
    workflowTimeoutGovernanceEvals.map((entry) => entry.context?.timeout_governance?.family),
    [
      "successful_but_slow",
      "timeout_acceptable",
      "timeout_fail_closed",
      "workflow_too_slow",
      "needs_fixture_mock",
    ],
  );
});

test("usage-layer runner reports workflow timeout governance family for deterministic timeout pack cases", async () => {
  const timeoutAcceptableCase = workflowTimeoutGovernanceEvals.find((entry) => entry.id === "workflow-timeout-002");
  assert.ok(timeoutAcceptableCase, "missing workflow-timeout-002");

  const timeoutAcceptableResult = await runUsageLayerEvalCase(timeoutAcceptableCase);
  assert.equal(timeoutAcceptableResult.governance_family, "timeout_acceptable");
  assert.equal(timeoutAcceptableResult.actual_success_type, "workflow_progress");
  assert.match(timeoutAcceptableResult.reply_text, /可接受慢路徑 timeout/);

  const failClosedCase = workflowTimeoutGovernanceEvals.find((entry) => entry.id === "workflow-timeout-003");
  assert.ok(failClosedCase, "missing workflow-timeout-003");

  const failClosedResult = await runUsageLayerEvalCase(failClosedCase);
  assert.equal(failClosedResult.governance_family, "timeout_fail_closed");
  assert.equal(failClosedResult.actual_eval_outcome, "fail_closed");
});
