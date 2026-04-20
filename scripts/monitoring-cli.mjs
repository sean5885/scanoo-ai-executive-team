import {
  getMonitoringDashboard,
  getLatestError,
  getAutonomyRolloutGuardrailSnapshot,
  getRequestMetrics,
  listRecentErrors,
  listRecentRequests,
} from "../src/monitoring-store.mjs";
import { buildAgentLearningSummary } from "../src/agent-learning-loop.mjs";

function printUsage() {
  console.log(
    [
      "Usage: node scripts/monitoring-cli.mjs <command> [limit]",
      "",
      "Commands:",
      "  dashboard [recentLimit] [errorLimit]   Show a compact monitoring dashboard",
      "  recent [limit]   Show recent requests (default: 50)",
      "  errors [limit]   Show recent error requests (default: 10)",
      "  error            Show the latest error request",
      "  metrics          Show request success/error metrics",
      "  autonomy-rollout [lookbackMinutes] [maxHeartbeatLagMs]   Show autonomy ingress/queue/readiness guardrail metrics",
      "  learning [lookbackHours] [minSampleSize]   Show routing/tool learning summary",
    ].join("\n"),
  );
}

const command = String(process.argv[2] || "recent").trim().toLowerCase();
const limit = process.argv[3];
const errorLimit = process.argv[4];

function formatRate(label, count, total, percent) {
  return `${label}: ${percent.toFixed(2)}% (${count}/${total})`;
}

function formatRequestLine(item = {}) {
  const status = item.error_code || item.status_code || "unknown";
  const duration = Number.isFinite(Number(item.duration_ms)) ? `${Number(item.duration_ms)}ms` : "n/a";
  return [
    item.finished_at || item.started_at || "unknown_time",
    item.method || "GET",
    item.pathname || "/",
    `status=${status}`,
    `duration=${duration}`,
    `trace=${item.trace_id || "n/a"}`,
  ].join(" | ");
}

function printDashboard() {
  const dashboard = getMonitoringDashboard({
    recentLimit: limit,
    errorLimit,
  });
  const lines = [
    "Lobster Monitoring Dashboard",
    `Generated: ${dashboard.generated_at}`,
    "",
    formatRate(
      "Success rate",
      dashboard.metrics.success_count,
      dashboard.metrics.total_requests,
      dashboard.metrics.success_rate_percent,
    ),
    formatRate(
      "Error rate",
      dashboard.metrics.error_count,
      dashboard.metrics.total_requests,
      dashboard.metrics.error_rate_percent,
    ),
    "",
    `Recent errors (${dashboard.recent_errors.length}):`,
    ...(dashboard.recent_errors.length
      ? dashboard.recent_errors.map((item) => `- ${formatRequestLine(item)}`)
      : ["- none"]),
    "",
    `Recent requests (${dashboard.recent_requests.length}):`,
    ...(dashboard.recent_requests.length
      ? dashboard.recent_requests.map((item) => `- ${formatRequestLine(item)}`)
      : ["- none"]),
  ];
  console.log(lines.join("\n"));
}

if (command === "dashboard") {
  printDashboard();
} else if (command === "recent") {
  const items = listRecentRequests({ limit });
  console.log(JSON.stringify({
    ok: true,
    total: items.length,
    items,
  }, null, 2));
} else if (command === "errors") {
  const items = listRecentErrors({ limit });
  console.log(JSON.stringify({
    ok: true,
    total: items.length,
    items,
  }, null, 2));
} else if (command === "error") {
  console.log(JSON.stringify({
    ok: true,
    item: getLatestError(),
  }, null, 2));
} else if (command === "metrics") {
  const metrics = getRequestMetrics();
  console.log(JSON.stringify({
    ok: true,
    metrics: {
      ...metrics,
      success_rate_percent: Number((metrics.success_rate * 100).toFixed(2)),
      error_rate_percent: Number((metrics.error_rate * 100).toFixed(2)),
    },
  }, null, 2));
} else if (command === "autonomy-rollout") {
  const snapshot = getAutonomyRolloutGuardrailSnapshot({
    lookbackMinutes: limit,
    maxHeartbeatLagMs: errorLimit,
  });
  console.log(JSON.stringify({
    ok: true,
    snapshot,
  }, null, 2));
} else if (command === "learning") {
  const summary = buildAgentLearningSummary({
    lookbackHours: limit,
    minSampleSize: errorLimit,
  });
  console.log(JSON.stringify({
    ok: true,
    summary,
  }, null, 2));
} else {
  printUsage();
  process.exitCode = 1;
}
