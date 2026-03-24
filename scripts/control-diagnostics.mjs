import { cleanText } from "../src/message-intent-utils.mjs";
import {
  archiveControlDiagnosticsSnapshot,
  readControlDiagnosticsManifest,
  resolveControlDiagnosticsSnapshot,
} from "../src/control-diagnostics-history.mjs";

let controlDiagnosticsToolsPromise = null;

async function loadControlDiagnosticsTools() {
  if (!controlDiagnosticsToolsPromise) {
    controlDiagnosticsToolsPromise = (async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        return await import("../src/control-diagnostics.mjs");
      } finally {
        process.stdout.write = originalWrite;
      }
    })();
  }
  return controlDiagnosticsToolsPromise;
}

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function buildCompareLabel(compareTarget = null) {
  if (!compareTarget) {
    return "none";
  }
  return cleanText(compareTarget?.label)
    || cleanText(compareTarget?.ref)
    || cleanText(compareTarget?.type)
    || "custom";
}

function buildCurrentLabel(runId = "") {
  return cleanText(runId)
    ? `snapshot:${cleanText(runId)}`
    : "current";
}

function buildSignedNumber(value = 0) {
  const normalized = Number(value || 0);
  return `${normalized >= 0 ? "+" : ""}${normalized}`;
}

function buildStatusMarker(status = "same") {
  if (status === "worse") {
    return "↑";
  }
  if (status === "better") {
    return "↓";
  }
  return "=";
}

function buildFieldStatus(field = "", currentSummary = {}, previousSummary = {}) {
  if (field.endsWith("_status")) {
    const currentStatus = cleanText(currentSummary?.[field]) || "fail";
    const previousStatus = cleanText(previousSummary?.[field]) || "fail";
    if (currentStatus === previousStatus) {
      return {
        marker: "=",
        line: `= ${field}: ${currentStatus}`,
      };
    }
    const status = currentStatus === "fail"
      ? "worse"
      : previousStatus === "fail"
        ? "better"
        : currentStatus === "degrade"
          ? "worse"
          : "better";
    return {
      marker: buildStatusMarker(status),
      line: `${buildStatusMarker(status)} ${field}: ${previousStatus} -> ${currentStatus}`,
    };
  }

  const currentValue = Number(currentSummary?.[field] || 0);
  const previousValue = Number(previousSummary?.[field] || 0);
  const delta = currentValue - previousValue;

  if (delta === 0) {
    return {
      marker: "=",
      line: `= ${field}: ${currentValue}`,
    };
  }

  const status = delta > 0 ? "worse" : "better";
  return {
    marker: buildStatusMarker(status),
    line: `${buildStatusMarker(status)} ${field}: ${previousValue} -> ${currentValue} (${buildSignedNumber(delta)})`,
  };
}

function formatControlDiagnosticsReport(report = {}) {
  const diagnosticsSummary = report?.diagnostics_summary || {};
  const controlSummary = report?.control_summary || {};
  const routingSummary = report?.routing_summary || {};
  const writeSummary = report?.write_summary || {};
  const decision = report?.decision || {};

  return [
    "Control Diagnostics",
    `summary: overall=${cleanText(diagnosticsSummary?.overall_status) || "fail"} | control=${cleanText(diagnosticsSummary?.control_status) || "fail"} | routing=${cleanText(diagnosticsSummary?.routing_status) || "fail"} | write=${cleanText(diagnosticsSummary?.write_status) || "fail"}`,
    `control_summary: issues=${Number(controlSummary?.issue_count || 0)} | decisions=${Object.keys(controlSummary?.decision_counts || {}).length} | owners=${Object.keys(controlSummary?.owner_counts || {}).length} | integrations=${Array.isArray(controlSummary?.integration_points) ? controlSummary.integration_points.length : 0}`,
    `routing_summary: status=${cleanText(routingSummary?.status) || "fail"} | accuracy=${Number(routingSummary?.diagnostics_summary?.accuracy_ratio || 0)} | compare=${routingSummary?.compare?.available === true ? (routingSummary.compare.has_obvious_regression === true ? "regression" : "stable") : "unavailable"} | doc_boundary_regression=${routingSummary?.diagnostics_summary?.doc_boundary_regression === true}`,
    `write_summary: issues=${Number(writeSummary?.issue_count || 0)} | guarded_operations=${Array.isArray(writeSummary?.guarded_operations) ? writeSummary.guarded_operations.length : 0} | create_surfaces=${Array.isArray(writeSummary?.create_guard_surfaces) ? writeSummary.create_guard_surfaces.length : 0}`,
    `decision: ${cleanText(decision?.action) || "observe_only"} | line ${cleanText(decision?.line) || "none"}`,
    cleanText(decision?.summary) || "Control, write, and routing diagnostics are stable.",
    `next: ${cleanText(decision?.suggested_next_step) || "No repair is needed."}`,
  ].join("\n");
}

function formatControlDiagnosticsCompareReport({
  report = {},
  currentRunId = "",
  compareTarget = null,
  manifestPath = "",
  compareFields = [],
} = {}) {
  const currentSummary = report?.diagnostics_summary || {};
  const previousSummary = compareTarget?.report?.diagnostics_summary || {};
  const lines = [
    "Control Diagnostics Compare",
    `Current: ${buildCurrentLabel(currentRunId)}`,
    `Compare: ${buildCompareLabel(compareTarget)}`,
  ];

  for (const field of compareFields) {
    lines.push(buildFieldStatus(field, currentSummary, previousSummary).line);
  }

  if (manifestPath) {
    lines.push(`Manifest: ${manifestPath}`);
  }

  return lines.join("\n");
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run control:diagnostics",
    "  npm run control:diagnostics -- --compare-previous",
    "  npm run control:diagnostics -- --compare-snapshot <run-id|path>",
    "  npm run control:diagnostics -- --json",
  ].join("\n"));
}

async function resolveCompareTarget() {
  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }

  if (comparePrevious) {
    return resolveControlDiagnosticsSnapshot({
      reference: "latest",
    });
  }

  if (compareSnapshot) {
    return resolveControlDiagnosticsSnapshot({
      reference: compareSnapshot,
    });
  }

  return null;
}

async function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const wantsJson = process.argv.includes("--json");
  const compareTarget = await resolveCompareTarget();
  const {
    CONTROL_DIAGNOSTICS_COMPARE_FIELDS,
    buildControlDiagnosticsCompareSummary,
    runControlDiagnostics,
  } = await loadControlDiagnosticsTools();
  const report = await runControlDiagnostics();

  if (compareTarget) {
    report.compare_summary = buildControlDiagnosticsCompareSummary({
      currentSummary: report?.diagnostics_summary || {},
      previousSummary: compareTarget?.report?.diagnostics_summary || {},
    });
  }

  const archiveRecord = await archiveControlDiagnosticsSnapshot({
    commandName: "control:diagnostics",
    report,
  });
  const archivedReport = archiveRecord?.report || {
    ...report,
    run_id: archiveRecord?.run_id || null,
    timestamp: archiveRecord?.timestamp || null,
  };

  if (wantsJson) {
    console.log(JSON.stringify(archivedReport, null, 2));
  } else if (compareTarget) {
    const manifest = await readControlDiagnosticsManifest();
    console.log(formatControlDiagnosticsCompareReport({
      report: archivedReport,
      currentRunId: archiveRecord?.run_id || "",
      compareTarget,
      manifestPath: manifest?.manifest_path || "",
      compareFields: CONTROL_DIAGNOSTICS_COMPARE_FIELDS,
    }));
  } else {
    console.log(formatControlDiagnosticsReport(archivedReport));
  }

  if (cleanText(archivedReport?.diagnostics_summary?.overall_status) === "fail") {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`control diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
