import test from "node:test";
import assert from "node:assert/strict";

import {
  createImprovementProposal,
  createImprovementProposals,
} from "../src/executive-improvement.mjs";

test("improvement layer emits a lightweight routing_fix proposal", () => {
  const proposal = createImprovementProposal({
    what_went_wrong: ["wrong_routing", "robotic_response"],
    verification_result: {
      pass: false,
      issues: ["wrong_routing"],
    },
  });

  assert.deepEqual(proposal, {
    type: "routing_fix",
    summary: "Routing or delegation did not match the task shape.",
    action_suggestion: "Adjust routing hints and delegation thresholds so similar requests stay on the right execution path.",
  });
});

test("improvement layer maps planning_error to prompt_fix", () => {
  const proposal = createImprovementProposal({
    error_type: "planning_error",
  });

  assert.deepEqual(proposal, {
    type: "prompt_fix",
    summary: "The execution plan did not translate cleanly into a grounded response contract.",
    action_suggestion: "Tighten prompt instructions so the planned task, output contract, and success criteria stay aligned.",
  });
});

test("improvement layer maps missing_info to knowledge_gap", () => {
  const proposal = createImprovementProposal({
    error_type: "missing_info",
    missing_elements: ["owner", "deadline"],
  });

  assert.deepEqual(proposal, {
    type: "knowledge_gap",
    summary: "The run stopped on missing information that still needs verified inputs. Missing: owner, deadline.",
    action_suggestion: "Collect the missing information first and keep the response scoped to verified knowledge until those gaps are closed.",
  });
});

test("improvement layer maps tool_failure to retry_strategy", () => {
  const proposal = createImprovementProposal({
    error_type: "tool_failure",
    missing_elements: ["source_fetch"],
  });

  assert.deepEqual(proposal, {
    type: "retry_strategy",
    summary: "The task needs a retry path because a required tool step failed. Missing: source_fetch.",
    action_suggestion: "Retry the failed tool step with explicit fail-soft handling, validation checks, and a clear stop condition if the dependency stays unavailable.",
  });
});

test("compatibility wrapper still returns one workflow proposal for closed-loop integration", () => {
  const proposals = createImprovementProposals({
    reflection: {
      what_went_wrong: ["missing_owner"],
      missing_elements: ["owner"],
      verification_result: {
        pass: false,
        issues: ["missing_owner"],
      },
      error_type: "missing_owner",
    },
    task: {
      current_agent_id: "meeting",
      task_type: "meeting_processing",
    },
  });

  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0], {
    category: "meeting_agent_improvement",
    mode: "auto_apply",
    risk_level: "low_risk",
    title: "Add controlled retry path",
    description: "Retry with explicit validation steps and fail-soft stopping conditions for missing fields, permissions, or tool failures.",
    target: "meeting-agent",
  });
});
