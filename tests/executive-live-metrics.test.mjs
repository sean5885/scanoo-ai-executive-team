import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;

const {
  EXECUTIVE_ARTIFACT_TYPE,
  ensureExecutiveWorkGraphTables,
  persistExecutiveWorkGraph,
  scheduleExecutableWorkNodes,
  claimNextExecutableWorkNode,
  startExecutableWorkNodeExecution,
  completeExecutableWorkNode,
} = await import("../src/executive-work-graph.mjs");
const { readExecutiveLiveMetrics } = await import("../src/executive-live-metrics.mjs");

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildGraph() {
  return {
    graph_id: "metrics_status_alignment_graph",
    task_id: "metrics_status_alignment_task",
    goal: "multi-agent-collab metrics status alignment",
    merge_node_id: "n_merge",
    nodes: [
      {
        node_id: "n_a",
        specialist_id: "generalist",
        input_contract: { required_fields: ["request_text", "context_refs"] },
        allowed_tools: [],
        output_contract: {
          type: "structured_output",
          schema: { answer: "string", sources: "array", limitations: "array" },
        },
        retry_policy: { max_retries: 0, backoff_ms: [] },
      },
      {
        node_id: "n_b",
        specialist_id: "generalist",
        input_contract: { required_fields: ["request_text", "context_refs"] },
        allowed_tools: [],
        output_contract: {
          type: "structured_output",
          schema: { answer: "string", sources: "array", limitations: "array" },
        },
        retry_policy: { max_retries: 0, backoff_ms: [] },
      },
      {
        node_id: "n_merge",
        specialist_id: "generalist",
        input_contract: { required_fields: ["artifact_refs", "request_text"] },
        allowed_tools: [],
        output_contract: {
          type: "structured_output",
          schema: { answer: "string", sources: "array", limitations: "array" },
        },
        retry_policy: { max_retries: 0, backoff_ms: [] },
      },
    ],
    edges: [
      { from: "n_a", to: "n_merge", dependency: "hard" },
      { from: "n_b", to: "n_merge", dependency: "hard" },
    ],
  };
}

test.after(() => {
  testDb.close();
});

test.beforeEach(() => {
  ensureExecutiveWorkGraphTables();
  db.exec(`
    DELETE FROM executive_deadletters;
    DELETE FROM executive_artifacts;
    DELETE FROM executive_node_leases;
    DELETE FROM executive_node_attempts;
    DELETE FROM executive_work_edges;
    DELETE FROM executive_work_nodes;
    DELETE FROM executive_work_graphs;
  `);
});

test("executive live metrics counts succeeded attempts in parallel speedup", async () => {
  const persisted = persistExecutiveWorkGraph({ graph: buildGraph() });
  assert.equal(persisted?.ok, true);

  scheduleExecutableWorkNodes("metrics_status_alignment_graph");
  const claimA = claimNextExecutableWorkNode({
    graphId: "metrics_status_alignment_graph",
    workerId: "metrics-worker",
  });
  const claimB = claimNextExecutableWorkNode({
    graphId: "metrics_status_alignment_graph",
    workerId: "metrics-worker",
  });
  assert.equal(Boolean(claimA?.node?.node_id), true);
  assert.equal(Boolean(claimB?.node?.node_id), true);

  const startA = startExecutableWorkNodeExecution({
    graphId: "metrics_status_alignment_graph",
    nodeId: claimA.node.node_id,
    attemptId: claimA.attempt.id,
    workerId: "metrics-worker",
  });
  const startB = startExecutableWorkNodeExecution({
    graphId: "metrics_status_alignment_graph",
    nodeId: claimB.node.node_id,
    attemptId: claimB.attempt.id,
    workerId: "metrics-worker",
  });
  assert.equal(startA?.ok, true);
  assert.equal(startB?.ok, true);

  await sleep(40);

  const completeA = completeExecutableWorkNode({
    graphId: "metrics_status_alignment_graph",
    nodeId: claimA.node.node_id,
    attemptId: claimA.attempt.id,
    workerId: "metrics-worker",
    artifacts: [{
      artifact_type: EXECUTIVE_ARTIFACT_TYPE.structured_output,
      payload: { answer: "node-a-done" },
    }],
  });
  const completeB = completeExecutableWorkNode({
    graphId: "metrics_status_alignment_graph",
    nodeId: claimB.node.node_id,
    attemptId: claimB.attempt.id,
    workerId: "metrics-worker",
    artifacts: [{
      artifact_type: EXECUTIVE_ARTIFACT_TYPE.structured_output,
      payload: { answer: "node-b-done" },
    }],
  });
  assert.equal(completeA?.ok, true);
  assert.equal(completeB?.ok, true);

  const metrics = readExecutiveLiveMetrics({ lookbackHours: 24 * 30 });
  assert.equal(metrics?.parallel?.graph_count >= 1, true);
  assert.equal(Number.isFinite(Number(metrics?.parallel?.average_speedup)), true);
});
