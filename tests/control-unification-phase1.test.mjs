import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveVerificationOutcome } from "../src/executive-closed-loop.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "../src/executive-verifier.mjs";
import { executeWorkItemsSequentially } from "../src/executive-orchestrator.mjs";
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

test("tool_required without dispatch resolves to failed instead of completed", () => {
  const verification = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: [],
      raw_evidence: [
        {
          type: EVIDENCE_TYPES.summary_generated,
          summary: "reply_text_present",
          source: "reply_text",
        },
      ],
      fallback_used: false,
      tool_required: true,
    },
  });
  const outcome = resolveVerificationOutcome(verification);

  assert.equal(verification.pass, false);
  assert.equal(verification.execution_policy_state, "failed");
  assert.equal(outcome.nextState, "failed");
  assert.equal(outcome.nextStatus, "failed");
});

test("specialist fail then generalist fallback stays blocked for tool-required work", async () => {
  const execution = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    mergeAgentId: "ceo",
    workPlan: [
      { agent_id: "consult", task: "查文件與證據", role: "supporting", tool_required: true },
      { agent_id: "ceo", task: "統一收斂", role: "primary", tool_required: true },
    ],
    async executeAgentFn({ agent, requestText }) {
      if (agent.id === "consult") {
        throw new Error("specialist_failed");
      }
      return { text: `${agent.id}:${requestText}` };
    },
  });

  const verification = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: execution.dispatchedActions,
      raw_evidence: [
        {
          type: EVIDENCE_TYPES.summary_generated,
          summary: "reply_text_present",
          source: "reply_text",
        },
      ],
      fallback_used: execution.fallbackUsed,
      tool_required: true,
    },
  });
  const outcome = resolveVerificationOutcome(verification);

  assert.equal(execution.fallbackUsed, true);
  assert.equal(verification.pass, false);
  assert.equal(verification.execution_policy_state, "blocked");
  assert.equal(outcome.nextState, "blocked");
  assert.equal(outcome.nextStatus, "blocked");
});
