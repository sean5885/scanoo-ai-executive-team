import { cleanText } from "../src/message-intent-utils.mjs";
import {
  archivePlannerDiagnosticsSnapshot,
  readPlannerDiagnosticsManifest,
  resolvePlannerDiagnosticsSnapshot,
} from "../src/planner-diagnostics-history.mjs";

let plannerDiagnosticsModulePromise = null;

function withStdoutSuppressed(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
    callback?.();
    return true;
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        process.stdout.write = originalWrite;
      });
    }
    process.stdout.write = originalWrite;
    return result;
  } catch (error) {
    process.stdout.write = originalWrite;
    throw error;
  }
}

async function loadPlannerDiagnosticsModule({ suppressStdout = false } = {}) {
  if (plannerDiagnosticsModulePromise) {
    return plannerDiagnosticsModulePromise;
  }

  const load = () => import("../src/planner-contract-consistency.mjs");
  plannerDiagnosticsModulePromise = suppressStdout
    ? withStdoutSuppressed(load)
    : load();
  return plannerDiagnosticsModulePromise;
}

async function runWithOptionalStdoutSuppression(fn, { suppressStdout = false } = {}) {
  if (!suppressStdout) {
    return fn();
  }

  return withStdoutSuppressed(fn);
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
  compareFields = [],
} = {}) {
  const currentSummary = report?.diagnostics_summary || {};
  const previousSummary = compareTarget?.report?.diagnostics_summary || {};
  const lines = [
    "Planner Diagnostics Compare",
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
  const {
    PLANNER_DIAGNOSTICS_COMPARE_FIELDS,
    buildPlannerDiagnosticsCompareSummary,
    renderPlannerContractConsistencyReport,
    runPlannerContractConsistencyCheck,
  } = await loadPlannerDiagnosticsModule({
    suppressStdout: wantsJson,
  });
  const compareTarget = await resolveCompareTarget();
  const report = await runWithOptionalStdoutSuppression(
    () => runPlannerContractConsistencyCheck(),
    { suppressStdout: wantsJson },
  );

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
      compareFields: PLANNER_DIAGNOSTICS_COMPARE_FIELDS,
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
