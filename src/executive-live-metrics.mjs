import db from "./db.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { ensureExecutiveWorkGraphTables } from "./executive-work-graph.mjs";

const DEFAULT_COLLAB_SAMPLE_THRESHOLDS = Object.freeze({
  graph_min: 100,
  deadletter_min: 20,
  parallel_graph_min: 30,
});

function safeRatio(numerator = 0, denominator = 0, digits = 4) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return null;
  }
  return Number((n / d).toFixed(digits));
}

function parseIsoToMs(value = "") {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePositiveInteger(value = null, fallback = 0, {
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
} = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function resolveSampleThresholds({
  graphMin = null,
  deadletterMin = null,
  parallelGraphMin = null,
} = {}) {
  return {
    graph_min: normalizePositiveInteger(
      graphMin ?? process.env.EXECUTIVE_LIVE_METRICS_GRAPH_MIN_SAMPLE,
      DEFAULT_COLLAB_SAMPLE_THRESHOLDS.graph_min,
    ),
    deadletter_min: normalizePositiveInteger(
      deadletterMin ?? process.env.EXECUTIVE_LIVE_METRICS_DEADLETTER_MIN_SAMPLE,
      DEFAULT_COLLAB_SAMPLE_THRESHOLDS.deadletter_min,
    ),
    parallel_graph_min: normalizePositiveInteger(
      parallelGraphMin ?? process.env.EXECUTIVE_LIVE_METRICS_PARALLEL_GRAPH_MIN_SAMPLE,
      DEFAULT_COLLAB_SAMPLE_THRESHOLDS.parallel_graph_min,
    ),
  };
}

function computePercentile(values = [], percentile = 0.5) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const p = Math.min(1, Math.max(0, Number(percentile)));
  const index = Math.floor((sorted.length - 1) * p);
  return Number(sorted[index].toFixed(4));
}

function classifyGraphTaskType(goal = "", taskId = "") {
  const text = `${cleanText(goal)} ${cleanText(taskId)}`.toLowerCase();
  if (!text) {
    return "unknown";
  }
  if (text.includes("pdf") && (text.includes("cross") || text.includes("跨文件"))) {
    return "pdf_cross_doc";
  }
  if (text.includes("pdf")) {
    return "pdf_single_doc";
  }
  if (text.includes("long-task") || text.includes("long task") || text.includes("長任務") || text.includes("长任务")) {
    return "long_task";
  }
  if (text.includes("multi-agent") || text.includes("multi agent") || text.includes("協作") || text.includes("协作")) {
    return "multi_agent";
  }
  return "general";
}

function summarizeSpeedupRows(rows = []) {
  const graphs = new Map();
  for (const row of rows) {
    const graphId = cleanText(row?.graph_id);
    if (!graphId) {
      continue;
    }
    if (!graphs.has(graphId)) {
      graphs.set(graphId, []);
    }
    graphs.get(graphId).push(row);
  }

  const graphSpeedups = [];
  for (const [graphId, attempts] of graphs.entries()) {
    if (!Array.isArray(attempts) || attempts.length <= 1) {
      continue;
    }
    let serialMs = 0;
    let minStart = null;
    let maxEnd = null;

    for (const attempt of attempts) {
      const startedAt = parseIsoToMs(attempt?.started_at);
      const completedAt = parseIsoToMs(attempt?.completed_at);
      if (startedAt == null || completedAt == null || completedAt < startedAt) {
        continue;
      }
      const durationMs = completedAt - startedAt;
      serialMs += durationMs;
      minStart = minStart == null ? startedAt : Math.min(minStart, startedAt);
      maxEnd = maxEnd == null ? completedAt : Math.max(maxEnd, completedAt);
    }

    if (!Number.isFinite(serialMs) || serialMs <= 0 || minStart == null || maxEnd == null || maxEnd <= minStart) {
      continue;
    }
    const wallMs = maxEnd - minStart;
    const speedup = safeRatio(serialMs, wallMs);
    if (speedup == null) {
      continue;
    }
    graphSpeedups.push({
      graph_id: graphId,
      node_count: attempts.length,
      serial_ms: serialMs,
      wall_ms: wallMs,
      speedup,
    });
  }

  const averageSpeedup = graphSpeedups.length
    ? Number((graphSpeedups.reduce((sum, item) => sum + Number(item.speedup || 0), 0) / graphSpeedups.length).toFixed(4))
    : null;
  const p50Speedup = graphSpeedups.length
    ? computePercentile(graphSpeedups.map((item) => item.speedup), 0.5)
    : null;
  const p90Speedup = graphSpeedups.length
    ? computePercentile(graphSpeedups.map((item) => item.speedup), 0.9)
    : null;

  return {
    graph_count: graphSpeedups.length,
    average_speedup: averageSpeedup,
    p50_speedup: p50Speedup,
    p90_speedup: p90Speedup,
    top_graphs: graphSpeedups
      .sort((a, b) => Number(b.speedup || 0) - Number(a.speedup || 0))
      .slice(0, 10),
  };
}

function buildTaskTypeBuckets(graphRows = []) {
  const buckets = {};
  for (const row of graphRows) {
    const type = classifyGraphTaskType(row?.goal, row?.task_id);
    if (!buckets[type]) {
      buckets[type] = {
        total: 0,
        completed: 0,
        deadletter: 0,
      };
    }
    const status = cleanText(row?.status);
    buckets[type].total += 1;
    if (status === "completed") {
      buckets[type].completed += 1;
    }
    if (status === "deadletter") {
      buckets[type].deadletter += 1;
    }
  }
  return buckets;
}

function buildWindowStats({ lookbackHours = 0, graphRows = [], deadletterTotal = 0, parallelGraphCount = 0 } = {}) {
  const nowMs = Date.now();
  const windows = [24, 72, Number(lookbackHours || 0)].filter((value, index, arr) => value > 0 && arr.indexOf(value) === index);
  const result = {};
  for (const hours of windows) {
    const cutoffMs = nowMs - (hours * 60 * 60 * 1000);
    const windowGraphs = graphRows.filter((row) => {
      const createdAtMs = parseIsoToMs(row?.created_at);
      return createdAtMs != null && createdAtMs >= cutoffMs;
    });
    const completed = windowGraphs.filter((row) => cleanText(row?.status) === "completed").length;
    const deadletter = windowGraphs.filter((row) => cleanText(row?.status) === "deadletter").length;
    result[`last_${hours}h`] = {
      graph_total: windowGraphs.length,
      completed,
      deadletter,
      graph_success_rate: safeRatio(completed, windowGraphs.length),
      observed_deadletter_total: deadletterTotal,
      observed_parallel_graph_count: parallelGraphCount,
    };
  }
  return result;
}

function buildSampleReadiness({
  thresholds = DEFAULT_COLLAB_SAMPLE_THRESHOLDS,
  graphTotal = 0,
  deadletterTotal = 0,
  parallelGraphCount = 0,
} = {}) {
  const missingRequirements = [];
  const hasGraphSample = graphTotal >= Number(thresholds.graph_min || 0);
  const hasDeadletterSample = deadletterTotal >= Number(thresholds.deadletter_min || 0);
  const hasParallelSample = parallelGraphCount >= Number(thresholds.parallel_graph_min || 0);

  if (!hasGraphSample) {
    missingRequirements.push("graph_sample_insufficient");
  }
  if (!hasDeadletterSample) {
    missingRequirements.push("deadletter_sample_insufficient");
  }
  if (!hasParallelSample) {
    missingRequirements.push("parallel_graph_sample_insufficient");
  }

  return {
    thresholds,
    observed: {
      graph_total: graphTotal,
      deadletter_total: deadletterTotal,
      parallel_graph_count: parallelGraphCount,
    },
    has_graph_sample: hasGraphSample,
    has_deadletter_sample: hasDeadletterSample,
    has_parallel_sample: hasParallelSample,
    sample_ready: hasGraphSample && hasDeadletterSample && hasParallelSample,
    missing_requirements: missingRequirements,
  };
}

export function readExecutiveLiveMetrics({
  lookbackHours = 24 * 14,
  sampleThresholds = null,
} = {}) {
  ensureExecutiveWorkGraphTables();

  const resolvedHours = Number.isFinite(Number(lookbackHours))
    ? Math.max(1, Math.min(24 * 90, Number(lookbackHours)))
    : 24 * 14;
  const cutoffIso = new Date(Date.now() - (resolvedHours * 60 * 60 * 1000)).toISOString();
  const thresholds = resolveSampleThresholds({
    graphMin: sampleThresholds?.graph_min,
    deadletterMin: sampleThresholds?.deadletter_min,
    parallelGraphMin: sampleThresholds?.parallel_graph_min,
  });

  const graphDetailRows = db.prepare(`
    SELECT graph_id, task_id, goal, status, created_at
    FROM executive_work_graphs
    WHERE created_at >= @cutoff
  `).all({ cutoff: cutoffIso });

  const graphRows = db.prepare(`
    SELECT status, COUNT(*) AS total
    FROM executive_work_graphs
    WHERE created_at >= @cutoff
    GROUP BY status
  `).all({ cutoff: cutoffIso });

  const graphCounts = {
    total: 0,
    completed: 0,
    deadletter: 0,
    blocked: 0,
    running: 0,
  };
  for (const row of graphRows) {
    const status = cleanText(row?.status);
    const total = Number(row?.total || 0);
    graphCounts.total += total;
    if (status in graphCounts) {
      graphCounts[status] += total;
    }
  }

  const deadletterRows = db.prepare(`
    SELECT status, COUNT(*) AS total
    FROM executive_deadletters
    WHERE created_at >= @cutoff
    GROUP BY status
  `).all({ cutoff: cutoffIso });

  let deadletterTotal = 0;
  let deadletterReplayed = 0;
  for (const row of deadletterRows) {
    const status = cleanText(row?.status);
    const total = Number(row?.total || 0);
    deadletterTotal += total;
    if (status === "replayed") {
      deadletterReplayed += total;
    }
  }

  const attemptRows = db.prepare(`
    SELECT graph_id, node_id, started_at, completed_at
    FROM executive_node_attempts
    WHERE started_at >= @cutoff
      AND completed_at IS NOT NULL
      AND status IN ('completed', 'succeeded')
  `).all({ cutoff: cutoffIso });

  const speedupSummary = summarizeSpeedupRows(attemptRows);
  const collabSampleReadiness = buildSampleReadiness({
    thresholds,
    graphTotal: graphCounts.total,
    deadletterTotal,
    parallelGraphCount: Number(speedupSummary.graph_count || 0),
  });

  return {
    version: "executive_live_metrics_v1",
    lookback_hours: resolvedHours,
    cutoff_at: cutoffIso,
    graph_counts: graphCounts,
    graph_success_rate: safeRatio(graphCounts.completed, graphCounts.total),
    deadletter: {
      total: deadletterTotal,
      replayed: deadletterReplayed,
      replay_rate: safeRatio(deadletterReplayed, deadletterTotal),
    },
    parallel: speedupSummary,
    task_type_buckets: buildTaskTypeBuckets(graphDetailRows),
    window_stats: buildWindowStats({
      lookbackHours: resolvedHours,
      graphRows: graphDetailRows,
      deadletterTotal,
      parallelGraphCount: Number(speedupSummary.graph_count || 0),
    }),
    collab_sample_readiness: collabSampleReadiness,
    sample_ready: collabSampleReadiness.sample_ready === true,
    sample_basis: {
      has_graph_sample: collabSampleReadiness.has_graph_sample === true,
      has_deadletter_sample: collabSampleReadiness.has_deadletter_sample === true,
      has_parallel_sample: collabSampleReadiness.has_parallel_sample === true,
    },
  };
}
