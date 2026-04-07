import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowTimeoutGovernanceLine,
  classifyWorkflowTimeoutGovernanceFamily,
} from "../src/workflow-timeout-governance.mjs";

test("workflow timeout governance classifies timeout fallback as acceptable", () => {
  assert.equal(
    classifyWorkflowTimeoutGovernanceFamily({
      timedOut: true,
      fallbackUsed: true,
      failClosed: false,
    }),
    "timeout_acceptable",
  );
});

test("workflow timeout governance classifies slow success separately from workflow too slow", () => {
  assert.equal(
    classifyWorkflowTimeoutGovernanceFamily({
      durationMs: 4200,
      slowWarningMs: 3500,
    }),
    "successful_but_slow",
  );
  assert.equal(
    classifyWorkflowTimeoutGovernanceFamily({
      workflowStillRunning: true,
      durationMs: 4200,
      slowWarningMs: 3500,
    }),
    "workflow_too_slow",
  );
});

test("workflow timeout governance renders user-facing guidance line", () => {
  assert.match(
    buildWorkflowTimeoutGovernanceLine({
      family: "timeout_fail_closed",
      workflowLabel: "雲文檔 workflow",
    }),
    /fail-closed/,
  );
});
