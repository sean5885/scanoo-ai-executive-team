import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { executiveImprovementStorePath } from "../src/config.mjs";
import {
  buildAgentLearningSummary,
  generateLearningLoopImprovementProposals,
} from "../src/agent-learning-loop.mjs";
import { recordHttpRequest, recordTraceEvent } from "../src/monitoring-store.mjs";

async function snapshotFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function restoreFile(filePath, content) {
  if (content == null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, content, "utf8");
}

test("agent learning summary finds routing failures and tool weight candidates", async (t) => {
  const improvementSnapshot = await snapshotFile(executiveImprovementStorePath);
  t.after(async () => {
    await restoreFile(executiveImprovementStorePath, improvementSnapshot);
  });

  const stamp = Date.now();
  const routeName = `learning_route_${stamp}`;
  const goodTool = `learning_tool_good_${stamp}`;
  const badTool = `learning_tool_bad_${stamp}`;

  const samples = [
    { traceId: `trace_${stamp}_1`, ok: false, error: "not_found", tool: badTool, durationMs: 33 },
    { traceId: `trace_${stamp}_2`, ok: false, error: "tool_error", tool: badTool, durationMs: 44 },
    { traceId: `trace_${stamp}_3`, ok: true, error: null, tool: goodTool, durationMs: 20 },
    { traceId: `trace_${stamp}_4`, ok: true, error: null, tool: goodTool, durationMs: 18 },
  ];

  for (const sample of samples) {
    const requestId = `req_${sample.traceId}`;
    recordHttpRequest({
      traceId: sample.traceId,
      requestId,
      method: "POST",
      pathname: `/api/${routeName}`,
      routeName,
      statusCode: sample.ok ? 200 : 422,
      payload: sample.ok ? { ok: true } : { ok: false, error: sample.error, message: sample.error },
      durationMs: sample.durationMs,
    });
    recordTraceEvent({
      traceId: sample.traceId,
      requestId,
      component: "http.request.learning",
      event: "lane_execution_planned",
      payload: {
        chosen_lane: "knowledge-assistant",
        chosen_action: "planner_user_input",
      },
    });
    recordTraceEvent({
      traceId: sample.traceId,
      requestId,
      component: "http.request.learning",
      event: "planner_tool_select",
      payload: {
        selected_action: sample.tool,
      },
    });
    recordTraceEvent({
      traceId: sample.traceId,
      requestId,
      component: "planner.tool",
      event: "tool_execution",
      level: sample.ok ? "info" : "error",
      payload: {
        event_type: "tool_execution",
        action: sample.tool,
        trace_id: sample.traceId,
        duration_ms: sample.durationMs,
        result: {
          success: sample.ok,
          data: {},
          error: sample.error,
        },
      },
    });
  }

  const summary = buildAgentLearningSummary({
    lookbackHours: 1,
    requestLimit: 50,
    minSampleSize: 2,
    maxRoutingItems: 10,
    maxToolItems: 10,
  });

  const routingIssue = summary.routing_issues.find((item) => item.route_name === routeName);
  assert.ok(routingIssue);
  assert.equal(routingIssue?.failure_count, 2);
  assert.ok(routingIssue?.failure_rate >= 0.5);

  const strongTool = summary.high_success_tools.find((item) => item.tool_name === goodTool);
  assert.ok(strongTool);
  assert.equal(strongTool?.suggested_weight_delta, 0.1);

  const weakTool = summary.low_success_tools.find((item) => item.tool_name === badTool);
  assert.ok(weakTool);
  assert.equal(weakTool?.suggested_weight_delta, -0.1);

  assert.ok(summary.draft_proposals.some((item) => item.category === "routing_improvement"));
  assert.ok(summary.draft_proposals.some((item) => item.category === "tool_weight_adjustment" && item.context?.tool_name === goodTool));

  const repeatedSummary = buildAgentLearningSummary({
    lookbackHours: 1,
    requestLimit: 50,
    minSampleSize: 2,
    maxRoutingItems: 10,
    maxToolItems: 10,
  });
  assert.deepEqual(repeatedSummary, summary);

  const persisted = await generateLearningLoopImprovementProposals({
    accountId: "acct-learning",
    sessionKey: "sess-learning",
    lookbackHours: 1,
    requestLimit: 50,
    minSampleSize: 2,
    maxRoutingItems: 10,
    maxToolItems: 10,
  });

  assert.ok(persisted.proposals.length >= 3);
  assert.ok(persisted.proposals.every((item) => item.status === "pending_approval"));
  assert.ok(persisted.proposals.some((item) => item.context?.tool_name === goodTool));
});
