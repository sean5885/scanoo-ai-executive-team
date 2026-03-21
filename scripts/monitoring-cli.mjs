import {
  getLatestError,
  getRequestMetrics,
  listRecentErrors,
  listRecentRequests,
} from "../src/monitoring-store.mjs";

function printUsage() {
  console.log(
    [
      "Usage: node scripts/monitoring-cli.mjs <command> [limit]",
      "",
      "Commands:",
      "  recent [limit]   Show recent requests (default: 50)",
      "  errors [limit]   Show recent error requests (default: 10)",
      "  error            Show the latest error request",
      "  metrics          Show request success/error metrics",
    ].join("\n"),
  );
}

const command = String(process.argv[2] || "recent").trim().toLowerCase();
const limit = process.argv[3];

if (command === "recent") {
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
} else {
  printUsage();
  process.exitCode = 1;
}
