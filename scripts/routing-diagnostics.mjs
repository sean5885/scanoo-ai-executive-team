import path from "node:path";

import { cleanText } from "../src/message-intent-utils.mjs";
import {
  buildRoutingDiagnosticsSummary,
} from "../src/routing-eval-diagnostics.mjs";
import {
  readRoutingDiagnosticsManifest,
  resolvePreviousRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsTag,
} from "../src/routing-diagnostics-history.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "../src/planner-error-codes.mjs";

const ROUTING_ERROR_CODES = [
  ROUTING_NO_MATCH,
  INVALID_ACTION,
  FALLBACK_DISABLED,
];

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function buildSignedNumber(value = 0, precision = 4) {
  const normalized = Number(value || 0);
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(precision)}`;
}

function normalizeErrorMetric(metric = {}) {
  return {
    expected: Number(metric?.expected || 0),
    actual: Number(metric?.actual || 0),
    matched: Number(metric?.matched || 0),
    misses: Number(metric?.misses || 0),
  };
}

function formatBucketMetric(metric = null) {
  if (!metric) {
    return "none";
  }
  return `${metric.accuracy_ratio} (${metric.hits}/${metric.total})`;
}

function collectTrendChanges(record = {}, { limit = 3 } = {}) {
  return Object.entries(record || {})
    .filter(([, metric]) => metric?.status && metric.status !== "unchanged")
    .sort((left, right) => (
      Math.abs(Number(right?.[1]?.delta_accuracy_ratio || 0))
      - Math.abs(Number(left?.[1]?.delta_accuracy_ratio || 0))
      || left[0].localeCompare(right[0])
    ))
    .slice(0, limit)
    .map(([name, metric]) => {
      const delta = metric?.delta_accuracy_ratio === null
        ? "n/a"
        : buildSignedNumber(metric.delta_accuracy_ratio, 4);
      return `${name}: ${formatBucketMetric(metric.current)} vs ${formatBucketMetric(metric.previous)} | delta ${delta} | ${metric.status}`;
    });
}

function buildComparisonLabel(compareTarget = null) {
  if (!compareTarget) {
    return "none";
  }
  return cleanText(compareTarget?.label)
    || cleanText(compareTarget?.ref)
    || cleanText(compareTarget?.type)
    || "custom";
}

function buildCurrentLabel(snapshot = {}) {
  return cleanText(snapshot?.run_id)
    ? `snapshot:${cleanText(snapshot.run_id)}`
    : cleanText(snapshot?.label) || "latest";
}

function formatRoutingDiagnosticsDigest({
  diagnosticsSummary = {},
  currentSnapshot = null,
  compareTarget = null,
  manifestPath = "",
  archivedView = false,
} = {}) {
  const decision = diagnosticsSummary?.decision_advice?.minimal_decision || {
    action: "observe_only",
    severity: "info",
    summary: "No actionable drift detected from trend or error breakdown.",
  };
  const trend = diagnosticsSummary?.decision_advice?.trend || diagnosticsSummary?.trend_report || {
    available: false,
    status: "unknown",
    accuracy_ratio: {
      current: Number(diagnosticsSummary?.accuracy_ratio || 0),
      previous: null,
      delta: null,
    },
  };
  const trendDelta = diagnosticsSummary?.trend_report?.delta || null;
  const laneChanges = trendDelta ? collectTrendChanges(trendDelta.by_lane_accuracy) : [];
  const actionChanges = trendDelta ? collectTrendChanges(trendDelta.by_action_accuracy) : [];
  const errors = ROUTING_ERROR_CODES.map((code) => {
    const metric = normalizeErrorMetric(diagnosticsSummary?.error_breakdown?.[code] || {});
    return `${code}: actual ${metric.actual} | misses ${metric.misses}`;
  }).join(" ; ");

  const snapshotPath = cleanText(currentSnapshot?.path);
  const currentLabel = buildCurrentLabel(currentSnapshot?.snapshot || currentSnapshot || {});
  const timestamp = cleanText(currentSnapshot?.snapshot?.timestamp) || cleanText(currentSnapshot?.timestamp) || "unknown";
  const scope = cleanText(currentSnapshot?.snapshot?.scope) || cleanText(currentSnapshot?.scope) || "routing-eval";
  const stage = cleanText(currentSnapshot?.snapshot?.stage) || cleanText(currentSnapshot?.stage) || "run";
  const compareLabel = buildComparisonLabel(compareTarget);

  const lines = [
    "Routing Diagnostics",
    `Current: ${currentLabel} | ${scope}/${stage} | ${timestamp}`,
    `Compare: ${compareLabel}${archivedView ? " | archived" : ""}`,
    `Decision: ${decision.action || "observe_only"} (${decision.severity || "info"})`,
    `Accuracy: ${Number(diagnosticsSummary?.accuracy_ratio || 0)} | trend ${trend.status || "unknown"}${trend.available ? ` | delta ${buildSignedNumber(trend.accuracy_ratio?.delta, 4)}` : ""}`,
    decision.summary || "No actionable drift detected from trend or error breakdown.",
    `Errors: ${errors}`,
  ];

  if (trendDelta) {
    lines.push(
      `Trend: miss delta ${buildSignedNumber(trendDelta?.miss_count?.delta, 0)} | case delta ${buildSignedNumber(trendDelta?.total_cases?.delta, 0)}`,
    );
  }

  if (laneChanges.length > 0) {
    lines.push(`Lane changes: ${laneChanges.join(" ; ")}`);
  }

  if (actionChanges.length > 0) {
    lines.push(`Action changes: ${actionChanges.join(" ; ")}`);
  }

  if (snapshotPath) {
    lines.push(`Snapshot: ${path.relative(process.cwd(), snapshotPath) || snapshotPath}`);
  }
  if (manifestPath) {
    lines.push(`Manifest: ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
  }

  return lines.join("\n");
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run routing:diagnostics",
    "  npm run routing:diagnostics -- --compare-previous",
    "  npm run routing:diagnostics -- --compare-snapshot <run-id|path>",
    "  npm run routing:diagnostics -- --compare-tag <git-tag>",
  ].join("\n"));
}

async function resolveCompareTarget(currentSnapshot = null) {
  const compareSnapshot = getArgValue("--compare-snapshot");
  const compareTag = getArgValue("--compare-tag");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    Boolean(compareTag),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous, --compare-snapshot, or --compare-tag");
  }

  if (comparePrevious) {
    return resolvePreviousRoutingDiagnosticsSnapshot({
      reference: cleanText(currentSnapshot?.snapshot?.run_id) || "latest",
    });
  }

  if (compareSnapshot) {
    return resolveRoutingDiagnosticsSnapshot({
      reference: compareSnapshot,
    });
  }

  if (compareTag) {
    return resolveRoutingDiagnosticsTag({
      tag: compareTag,
    });
  }

  return null;
}

async function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const manifest = await readRoutingDiagnosticsManifest();
  const currentSnapshot = await resolveRoutingDiagnosticsSnapshot({
    reference: "latest",
  });
  const compareTarget = await resolveCompareTarget(currentSnapshot);
  const diagnosticsSummary = compareTarget
    ? buildRoutingDiagnosticsSummary({
        run: currentSnapshot.run,
        previousRun: compareTarget.run,
        currentLabel: buildCurrentLabel(currentSnapshot?.snapshot || currentSnapshot),
        previousLabel: compareTarget.label || "previous",
      })
    : currentSnapshot?.snapshot?.diagnostics_summary || buildRoutingDiagnosticsSummary({
        run: currentSnapshot.run,
        previousRun: null,
        currentLabel: buildCurrentLabel(currentSnapshot?.snapshot || currentSnapshot),
      });

  const effectiveCompareTarget = compareTarget || currentSnapshot?.snapshot?.compare_target || null;
  const archivedView = !compareTarget && Boolean(currentSnapshot?.snapshot?.compare_target);

  console.log(formatRoutingDiagnosticsDigest({
    diagnosticsSummary,
    currentSnapshot,
    compareTarget: effectiveCompareTarget,
    manifestPath: manifest?.manifest_path || "",
    archivedView,
  }));
}

try {
  await main();
} catch (error) {
  console.error(`routing diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
