import db from "./db.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { ensureExecutiveWorkGraphTables } from "./executive-work-graph.mjs";

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

  return {
    graph_count: graphSpeedups.length,
    average_speedup: averageSpeedup,
    top_graphs: graphSpeedups
      .sort((a, b) => Number(b.speedup || 0) - Number(a.speedup || 0))
      .slice(0, 10),
  };
}

export function readExecutiveLiveMetrics({ lookbackHours = 24 * 14 } = {}) {
  ensureExecutiveWorkGraphTables();

  const resolvedHours = Number.isFinite(Number(lookbackHours))
    ? Math.max(1, Math.min(24 * 90, Number(lookbackHours)))
    : 24 * 14;
  const cutoffIso = new Date(Date.now() - (resolvedHours * 60 * 60 * 1000)).toISOString();

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
      AND status = 'completed'
  `).all({ cutoff: cutoffIso });

  const speedupSummary = summarizeSpeedupRows(attemptRows);
  const hasGraphSample = graphCounts.total >= 10;
  const hasDeadletterSample = deadletterTotal >= 1;
  const hasParallelSample = Number(speedupSummary.graph_count || 0) >= 1;

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
    sample_ready: hasGraphSample && hasDeadletterSample && hasParallelSample,
    sample_basis: {
      has_graph_sample: hasGraphSample,
      has_deadletter_sample: hasDeadletterSample,
      has_parallel_sample: hasParallelSample,
    },
  };
}
