import { cleanText } from "../src/message-intent-utils.mjs";
import {
  PLANNER_DIAGNOSTICS_COMPARE_FIELDS,
  buildPlannerDiagnosticsCompareSummary,
  renderPlannerContractConsistencyReport,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";
import {
  archivePlannerDiagnosticsSnapshot,
  readPlannerDiagnosticsManifest,
  resolvePlannerDiagnosticsSnapshot,
} from "../src/planner-diagnostics-history.mjs";

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
  if (field === "gate") {
    const currentGate = cleanText(currentSummary?.gate) === "pass" ? "pass" : "fail";
    const previousGate = cleanText(previousSummary?.gate) === "pass" ? "pass" : "fail";
    if (currentGate === previousGate) {
      return {
        marker: "=",
        line: `= gate: ${currentGate}`,
      };
    }
    const status = currentGate === "fail" ? "worse" : "better";
    return {
      marker: buildStatusMarker(status),
      line: `${buildStatusMarker(status)} gate: ${previousGate} -> ${currentGate}`,
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

function formatPlannerDiagnosticsCompareReport({
  report = {},
  currentRunId = "",
  compareTarget = null,
  manifestPath = "",
} = {}) {
  const currentSummary = report?.diagnostics_summary || {};
  const previousSummary = compareTarget?.report?.diagnostics_summary || {};
  const lines = [
    "Planner Diagnostics Compare",
    `Current: ${buildCurrentLabel(currentRunId)}`,
    `Compare: ${buildCompareLabel(compareTarget)}`,
  ];

  for (const field of PLANNER_DIAGNOSTICS_COMPARE_FIELDS) {
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
    "  npm run planner:diagnostics",
    "  npm run planner:diagnostics -- --compare-previous",
    "  npm run planner:diagnostics -- --compare-snapshot <run-id|path>",
    "  npm run planner:diagnostics -- --json",
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
    return resolvePlannerDiagnosticsSnapshot({
      reference: "latest",
    });
  }

  if (compareSnapshot) {
    return resolvePlannerDiagnosticsSnapshot({
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
  const report = runPlannerContractConsistencyCheck();

  if (compareTarget) {
    report.compare_summary = buildPlannerDiagnosticsCompareSummary({
      currentSummary: report?.diagnostics_summary || {},
      previousSummary: compareTarget?.report?.diagnostics_summary || {},
    });
  }

  const archiveRecord = await archivePlannerDiagnosticsSnapshot({
    commandName: "planner:diagnostics",
    report,
  });

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (compareTarget) {
    const manifest = await readPlannerDiagnosticsManifest();
    console.log(formatPlannerDiagnosticsCompareReport({
      report,
      currentRunId: archiveRecord?.run_id || "",
      compareTarget,
      manifestPath: manifest?.manifest_path || "",
    }));
  } else {
    console.log(renderPlannerContractConsistencyReport(report));
  }

  if (report?.gate?.ok === false) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`planner diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
