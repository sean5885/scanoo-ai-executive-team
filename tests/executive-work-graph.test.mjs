import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const {
  EXECUTIVE_ARTIFACT_TYPE,
  claimNextExecutableWorkNode,
  completeExecutableWorkNode,
  ensureExecutiveWorkGraphTables,
  failExecutableWorkNode,
  getExecutiveWorkGraphSummary,
  listExecutiveDeadletters,
  listExecutiveWorkArtifacts,
  persistExecutiveWorkGraph,
  replayExecutiveDeadletter,
  scheduleExecutableWorkNodes,
  startExecutableWorkNodeExecution,
  validateExecutiveWorkGraph,
} = await import("../src/executive-work-graph.mjs");

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

function createGraph() {
  return {
    graph_id: "wg_test_1",
    task_id: "task_test_1",
    goal: "test goal",
    merge_node_id: "n_merge",
    nodes: [
      {
        node_id: "n1",
        specialist_id: "tech",
        input_contract: { required_fields: ["request_text", "context_refs"] },
        allowed_tools: ["search_company_brain_docs"],
        output_contract: {
          type: "structured_output",
          schema: { answer: "string", sources: "array", limitations: "array" },
        },
        retry_policy: { max_retries: 1, backoff_ms: [10] },
      },
      {
        node_id: "n_merge",
        specialist_id: "generalist",
        input_contract: { required_fields: ["artifact_refs", "request_text"] },
        allowed_tools: ["get_runtime_info"],
        output_contract: {
          type: "structured_output",
          schema: { answer: "string", sources: "array", limitations: "array" },
        },
        retry_policy: { max_retries: 0, backoff_ms: [] },
      },
    ],
    edges: [
      { from: "n1", to: "n_merge", dependency: "hard" },
    ],
  };
}

test("validateExecutiveWorkGraph rejects malformed graph", () => {
  const result = validateExecutiveWorkGraph({
    graph_id: "",
    task_id: "",
    goal: "",
    nodes: [],
    edges: [],
    merge_node_id: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.includes("missing_nodes"), true);
});

test("persist + claim + complete work graph node lifecycle", () => {
  const persisted = persistExecutiveWorkGraph({ graph: createGraph() });
  assert.equal(persisted?.ok, true);

  const firstClaim = claimNextExecutableWorkNode({
    graphId: "wg_test_1",
    workerId: "worker_graph_1",
  });
  assert.equal(firstClaim?.node?.node_id, "n1");

  const started = startExecutableWorkNodeExecution({
    graphId: "wg_test_1",
    nodeId: "n1",
    attemptId: firstClaim.attempt.id,
    workerId: "worker_graph_1",
  });
  assert.equal(started?.ok, true);

  const completed = completeExecutableWorkNode({
    graphId: "wg_test_1",
    nodeId: "n1",
    attemptId: firstClaim.attempt.id,
    workerId: "worker_graph_1",
    artifacts: [{
      artifact_type: EXECUTIVE_ARTIFACT_TYPE.structured_output,
      payload: {
        answer: "ok",
      },
    }],
  });
  assert.equal(completed?.ok, true);

  scheduleExecutableWorkNodes("wg_test_1");
  const mergeClaim = claimNextExecutableWorkNode({
    graphId: "wg_test_1",
    workerId: "worker_graph_1",
  });
  assert.equal(mergeClaim?.node?.node_id, "n_merge");

  const artifacts = listExecutiveWorkArtifacts({ graphId: "wg_test_1", nodeId: "n1" });
  assert.equal(artifacts.length > 0, true);
});

test("deadletter path can be replayed", () => {
  const persisted = persistExecutiveWorkGraph({ graph: createGraph() });
  assert.equal(persisted?.ok, true);

  const firstClaim = claimNextExecutableWorkNode({
    graphId: "wg_test_1",
    workerId: "worker_graph_1",
  });
  assert.equal(firstClaim?.node?.node_id, "n1");

  startExecutableWorkNodeExecution({
    graphId: "wg_test_1",
    nodeId: "n1",
    attemptId: firstClaim.attempt.id,
    workerId: "worker_graph_1",
  });

  const failed = failExecutableWorkNode({
    graphId: "wg_test_1",
    nodeId: "n1",
    attemptId: firstClaim.attempt.id,
    workerId: "worker_graph_1",
    failureClass: "tool_error",
    lastError: "forced_fail",
    retryPolicy: { max_retries: 0, backoff_ms: [] },
  });
  assert.equal(failed?.ok, true);

  const deadletters = listExecutiveDeadletters({ graphId: "wg_test_1" });
  assert.equal(deadletters.length, 1);

  const replayed = replayExecutiveDeadletter({
    deadletterId: deadletters[0].id,
    operatorId: "operator_1",
    reason: "resume",
  });
  assert.equal(replayed?.ok, true);

  const summary = getExecutiveWorkGraphSummary("wg_test_1");
  assert.equal(summary?.counters?.queued >= 1, true);
});
