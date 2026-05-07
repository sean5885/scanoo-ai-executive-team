import { randomUUID } from "node:crypto";

import {
  EXECUTIVE_ARTIFACT_TYPE,
  claimNextExecutableWorkNode,
  completeExecutableWorkNode,
  failExecutableWorkNode,
  persistExecutiveWorkGraph,
  replayExecutiveDeadletter,
  scheduleExecutableWorkNodes,
  startExecutableWorkNodeExecution,
  updateExecutiveWorkGraphStatus,
  listExecutiveDeadletters,
} from "../src/executive-work-graph.mjs";
import { readExecutiveLiveMetrics } from "../src/executive-live-metrics.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function normalizePositiveInteger(value = null, fallback = 0, { min = 1, max = 100000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function buildParallelGraph({ graphId = "", taskId = "", goal = "" } = {}) {
  return {
    graph_id: graphId,
    task_id: taskId,
    goal,
    merge_node_id: "n_merge",
    nodes: [
      {
        node_id: "n_a",
        specialist_id: "generalist",
        task: "collect lane evidence A",
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
        task: "collect lane evidence B",
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
        task: "merge artifacts into final answer",
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

function buildDeadletterGraph({ graphId = "", taskId = "", goal = "" } = {}) {
  return {
    graph_id: graphId,
    task_id: taskId,
    goal,
    merge_node_id: "n_merge",
    nodes: [
      {
        node_id: "n_fail",
        specialist_id: "generalist",
        task: "simulate specialist failure for deadletter replay",
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
        task: "merge artifacts",
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
      { from: "n_fail", to: "n_merge", dependency: "hard" },
    ],
  };
}

function buildStructuredArtifact({ nodeId = "", text = "" } = {}) {
  const answer = cleanText(text) || "ok";
  return {
    artifact_type: EXECUTIVE_ARTIFACT_TYPE.structured_output,
    payload: {
      node_id: cleanText(nodeId) || null,
      answer,
      text: answer,
      sources: [],
      limitations: [],
    },
  };
}

function safePushError(errors = [], context = "", error = null) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
  errors.push({
    context: cleanText(context) || "unknown_context",
    error: cleanText(message) || "unknown_error",
  });
}

async function runParallelGraph({
  graph = null,
  workerId = "",
  parallelNodeDurationMs = 120,
  mergeNodeDurationMs = 20,
}) {
  const persisted = persistExecutiveWorkGraph({ graph });
  if (persisted?.ok !== true) {
    return { ok: false, error: persisted?.error || "persist_failed" };
  }

  scheduleExecutableWorkNodes(graph.graph_id);
  const firstClaim = claimNextExecutableWorkNode({
    graphId: graph.graph_id,
    workerId,
  });
  const secondClaim = claimNextExecutableWorkNode({
    graphId: graph.graph_id,
    workerId,
  });
  if (!firstClaim?.node?.node_id || !secondClaim?.node?.node_id) {
    return { ok: false, error: "parallel_node_claim_failed" };
  }

  const startA = startExecutableWorkNodeExecution({
    graphId: graph.graph_id,
    nodeId: firstClaim.node.node_id,
    attemptId: firstClaim.attempt.id,
    workerId,
  });
  const startB = startExecutableWorkNodeExecution({
    graphId: graph.graph_id,
    nodeId: secondClaim.node.node_id,
    attemptId: secondClaim.attempt.id,
    workerId,
  });
  if (startA?.ok !== true || startB?.ok !== true) {
    return { ok: false, error: "parallel_node_start_failed" };
  }

  await sleep(parallelNodeDurationMs);

  const completeA = completeExecutableWorkNode({
    graphId: graph.graph_id,
    nodeId: firstClaim.node.node_id,
    attemptId: firstClaim.attempt.id,
    workerId,
    artifacts: [
      buildStructuredArtifact({
        nodeId: firstClaim.node.node_id,
        text: `${graph.graph_id}:node_a_done`,
      }),
    ],
  });
  const completeB = completeExecutableWorkNode({
    graphId: graph.graph_id,
    nodeId: secondClaim.node.node_id,
    attemptId: secondClaim.attempt.id,
    workerId,
    artifacts: [
      buildStructuredArtifact({
        nodeId: secondClaim.node.node_id,
        text: `${graph.graph_id}:node_b_done`,
      }),
    ],
  });
  if (completeA?.ok !== true || completeB?.ok !== true) {
    return { ok: false, error: "parallel_node_complete_failed" };
  }

  scheduleExecutableWorkNodes(graph.graph_id);
  const mergeClaim = claimNextExecutableWorkNode({
    graphId: graph.graph_id,
    workerId,
  });
  if (!mergeClaim?.node?.node_id) {
    return { ok: false, error: "merge_node_claim_failed" };
  }
  const mergeStarted = startExecutableWorkNodeExecution({
    graphId: graph.graph_id,
    nodeId: mergeClaim.node.node_id,
    attemptId: mergeClaim.attempt.id,
    workerId,
  });
  if (mergeStarted?.ok !== true) {
    return { ok: false, error: "merge_node_start_failed" };
  }

  await sleep(mergeNodeDurationMs);
  const mergeCompleted = completeExecutableWorkNode({
    graphId: graph.graph_id,
    nodeId: mergeClaim.node.node_id,
    attemptId: mergeClaim.attempt.id,
    workerId,
    artifacts: [
      buildStructuredArtifact({
        nodeId: mergeClaim.node.node_id,
        text: `${graph.graph_id}:merge_done`,
      }),
    ],
  });
  if (mergeCompleted?.ok !== true) {
    return { ok: false, error: "merge_node_complete_failed" };
  }

  const status = updateExecutiveWorkGraphStatus({
    graphId: graph.graph_id,
    status: "completed",
  });
  if (status?.ok !== true) {
    return { ok: false, error: status?.error || "graph_status_update_failed" };
  }

  return { ok: true };
}

async function runDeadletterGraph({
  graph = null,
  workerId = "",
}) {
  const persisted = persistExecutiveWorkGraph({ graph });
  if (persisted?.ok !== true) {
    return { ok: false, error: persisted?.error || "persist_failed" };
  }

  scheduleExecutableWorkNodes(graph.graph_id);
  const claim = claimNextExecutableWorkNode({
    graphId: graph.graph_id,
    workerId,
  });
  if (!claim?.node?.node_id) {
    return { ok: false, error: "deadletter_node_claim_failed" };
  }
  const startResult = startExecutableWorkNodeExecution({
    graphId: graph.graph_id,
    nodeId: claim.node.node_id,
    attemptId: claim.attempt.id,
    workerId,
  });
  if (startResult?.ok !== true) {
    return { ok: false, error: "deadletter_node_start_failed" };
  }

  const failResult = failExecutableWorkNode({
    graphId: graph.graph_id,
    nodeId: claim.node.node_id,
    attemptId: claim.attempt.id,
    workerId,
    failureClass: "tool_error",
    lastError: "bootstrap_forced_deadletter",
    nextManualAction: "replay_deadletter",
    retryPolicy: { max_retries: 0, backoff_ms: [] },
  });
  if (failResult?.ok !== true) {
    return { ok: false, error: failResult?.error || "deadletter_node_fail_failed" };
  }

  const status = updateExecutiveWorkGraphStatus({
    graphId: graph.graph_id,
    status: "deadletter",
  });
  if (status?.ok !== true) {
    return { ok: false, error: status?.error || "graph_status_update_failed" };
  }

  const deadletters = listExecutiveDeadletters({
    graphId: graph.graph_id,
    limit: 10,
  });
  const deadletterId = cleanText(deadletters?.[0]?.id || "");
  if (!deadletterId) {
    return { ok: false, error: "deadletter_record_missing" };
  }
  return {
    ok: true,
    deadletter_id: deadletterId,
  };
}

async function main() {
  const wantsJson = process.argv.includes("--json");
  const workerId = cleanText(getArgValue("--worker-id")) || "collab-bootstrap-worker";
  const runPrefix = cleanText(getArgValue("--run-prefix")) || "collab-bootstrap";
  const parallelGraphCount = normalizePositiveInteger(getArgValue("--parallel-graphs"), 80, { min: 1, max: 5000 });
  const deadletterGraphCount = normalizePositiveInteger(getArgValue("--deadletter-graphs"), 20, { min: 1, max: 1000 });
  const parallelNodeDurationMs = normalizePositiveInteger(getArgValue("--parallel-node-duration-ms"), 120, { min: 10, max: 10000 });
  const mergeNodeDurationMs = normalizePositiveInteger(getArgValue("--merge-node-duration-ms"), 20, { min: 5, max: 5000 });
  const replayOperatorId = cleanText(getArgValue("--replay-operator-id")) || "collab-bootstrap-operator";
  const runId = `${runPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const errors = [];
  let parallelCreated = 0;
  let parallelFailed = 0;
  let deadletterCreated = 0;
  let deadletterFailed = 0;
  const replayCandidates = [];
  let replaySucceeded = 0;
  let replayFailed = 0;

  for (let index = 0; index < parallelGraphCount; index += 1) {
    const graphId = `${runId}-parallel-${String(index + 1).padStart(4, "0")}`;
    const graph = buildParallelGraph({
      graphId,
      taskId: `${graphId}-task`,
      goal: `multi-agent-collab parallel sample ${index + 1}`,
    });
    try {
      const result = await runParallelGraph({
        graph,
        workerId,
        parallelNodeDurationMs,
        mergeNodeDurationMs,
      });
      if (result?.ok === true) {
        parallelCreated += 1;
      } else {
        parallelFailed += 1;
        safePushError(errors, `parallel_graph:${graphId}`, result?.error || "parallel_graph_failed");
      }
    } catch (error) {
      parallelFailed += 1;
      safePushError(errors, `parallel_graph:${graphId}`, error);
    }
  }

  for (let index = 0; index < deadletterGraphCount; index += 1) {
    const graphId = `${runId}-deadletter-${String(index + 1).padStart(4, "0")}`;
    const graph = buildDeadletterGraph({
      graphId,
      taskId: `${graphId}-task`,
      goal: `multi-agent-collab deadletter replay sample ${index + 1}`,
    });
    try {
      const result = await runDeadletterGraph({
        graph,
        workerId,
      });
      if (result?.ok === true) {
        deadletterCreated += 1;
        replayCandidates.push({
          graph_id: graphId,
          deadletter_id: cleanText(result.deadletter_id),
        });
      } else {
        deadletterFailed += 1;
        safePushError(errors, `deadletter_graph:${graphId}`, result?.error || "deadletter_graph_failed");
      }
    } catch (error) {
      deadletterFailed += 1;
      safePushError(errors, `deadletter_graph:${graphId}`, error);
    }
  }

  for (const item of replayCandidates) {
    const replayResult = replayExecutiveDeadletter({
      deadletterId: item.deadletter_id,
      operatorId: replayOperatorId,
      reason: "collab_sample_bootstrap_replay",
    });
    if (replayResult?.ok === true) {
      replaySucceeded += 1;
    } else {
      replayFailed += 1;
      safePushError(errors, `deadletter_replay:${item.deadletter_id}`, replayResult?.error || "deadletter_replay_failed");
    }
  }

  const liveMetrics = readExecutiveLiveMetrics();
  const report = {
    version: "collab_sample_bootstrap_report_v1",
    run_id: runId,
    generated_at: new Date().toISOString(),
    config: {
      worker_id: workerId,
      parallel_graphs: parallelGraphCount,
      deadletter_graphs: deadletterGraphCount,
      parallel_node_duration_ms: parallelNodeDurationMs,
      merge_node_duration_ms: mergeNodeDurationMs,
      replay_operator_id: replayOperatorId,
    },
    results: {
      parallel_created: parallelCreated,
      parallel_failed: parallelFailed,
      deadletter_created: deadletterCreated,
      deadletter_failed: deadletterFailed,
      deadletter_replay_attempted: replayCandidates.length,
      deadletter_replay_succeeded: replaySucceeded,
      deadletter_replay_failed: replayFailed,
    },
    metrics_snapshot: {
      graph_total: Number(liveMetrics?.graph_counts?.total || 0),
      deadletter_total: Number(liveMetrics?.deadletter?.total || 0),
      deadletter_replay_rate: liveMetrics?.deadletter?.replay_rate ?? null,
      parallel_graph_count: Number(liveMetrics?.parallel?.graph_count || 0),
      parallel_average_speedup: liveMetrics?.parallel?.average_speedup ?? null,
      parallel_p50_speedup: liveMetrics?.parallel?.p50_speedup ?? null,
      parallel_p90_speedup: liveMetrics?.parallel?.p90_speedup ?? null,
      collab_sample_readiness: liveMetrics?.collab_sample_readiness || null,
      sample_ready: liveMetrics?.sample_ready === true,
      sample_basis: liveMetrics?.sample_basis || null,
    },
    errors: errors.slice(0, 200),
  };

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log([
      "Collab Sample Bootstrap",
      `run_id: ${report.run_id}`,
      `parallel_created: ${parallelCreated}/${parallelGraphCount}`,
      `deadletter_created: ${deadletterCreated}/${deadletterGraphCount}`,
      `deadletter_replay: ${replaySucceeded}/${replayCandidates.length}`,
      `graph_total: ${report.metrics_snapshot.graph_total}`,
      `deadletter_replay_rate: ${report.metrics_snapshot.deadletter_replay_rate ?? "null"}`,
      `parallel_avg_speedup: ${report.metrics_snapshot.parallel_average_speedup ?? "null"}`,
      `parallel_p50_speedup: ${report.metrics_snapshot.parallel_p50_speedup ?? "null"}`,
      `parallel_p90_speedup: ${report.metrics_snapshot.parallel_p90_speedup ?? "null"}`,
      `sample_ready: ${report.metrics_snapshot.sample_ready ? "true" : "false"}`,
      `sample_missing: ${
        Array.isArray(report.metrics_snapshot?.collab_sample_readiness?.missing_requirements)
          && report.metrics_snapshot.collab_sample_readiness.missing_requirements.length
          ? report.metrics_snapshot.collab_sample_readiness.missing_requirements.join(",")
          : "none"
      }`,
      `errors: ${errors.length}`,
    ].join("\n"));
  }

  if (
    parallelFailed > 0
    || deadletterFailed > 0
    || replayFailed > 0
  ) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`collab-sample-bootstrap error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
