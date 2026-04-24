import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CANARY_RUN_SCHEMA_VERSION,
  DEFAULT_CANARY_CASES_PATH,
  DEFAULT_CANARY_OUTPUT_DIR,
  resolveLatestCanaryReportPath,
  runCanary,
} from "./run-canary.mjs";

const CANARY_CHECK_SCHEMA_VERSION = "canary_check_report_v1";

function hasFlag(argv = [], flag = "") {
  return argv.includes(flag);
}

function getArgValue(argv = [], flag = "") {
  const inlinePrefix = `${flag}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index] || "";
    if (current === flag) {
      return argv[index + 1] || null;
    }
    if (current.startsWith(inlinePrefix)) {
      return current.slice(inlinePrefix.length) || null;
    }
  }
  return null;
}

function parsePositiveInt(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function cleanPath(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return path.resolve(process.cwd(), normalized);
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/check-canary.mjs",
    "  node scripts/check-canary.mjs --strict",
    "  node scripts/check-canary.mjs --strict --report .tmp/canary/runs/<run-id>.json",
    "  node scripts/check-canary.mjs --strict --cases=100",
  ].join("\n"));
}

async function loadReportFromPath(reportPath = "") {
  const raw = await readFile(reportPath, "utf8");
  return JSON.parse(raw);
}

function validateRunReportShape(report = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return "canary run report must be an object";
  }
  if (String(report.schema_version || "") !== CANARY_RUN_SCHEMA_VERSION) {
    return `unsupported canary run schema_version: ${String(report.schema_version || "unknown")}`;
  }
  if (!report.gate || typeof report.gate !== "object") {
    return "canary run report missing gate";
  }
  if (!report.metrics || typeof report.metrics !== "object") {
    return "canary run report missing metrics";
  }
  return null;
}

function isDirectExecution() {
  const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return import.meta.url === entryPath;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    printUsage();
    return;
  }

  const strictMode = hasFlag(argv, "--strict");
  const reportArg = getArgValue(argv, "--report");
  const outputDir = getArgValue(argv, "--out-dir") || DEFAULT_CANARY_OUTPUT_DIR;

  let source = {
    mode: "fresh_run",
    report_path: null,
  };
  let runReport = null;

  if (reportArg) {
    const reportPath = cleanPath(reportArg);
    runReport = await loadReportFromPath(reportPath);
    source = {
      mode: "explicit_report",
      report_path: reportPath,
    };
  } else {
    const latestReportPath = await resolveLatestCanaryReportPath({ baseDir: outputDir });
    if (latestReportPath) {
      runReport = await loadReportFromPath(latestReportPath);
      source = {
        mode: "latest_report",
        report_path: latestReportPath,
      };
    } else {
      runReport = await runCanary({
        casesPath: getArgValue(argv, "--cases-file") || DEFAULT_CANARY_CASES_PATH,
        casesRequested: parsePositiveInt(getArgValue(argv, "--cases"), null),
        stabilityRepeats: parsePositiveInt(getArgValue(argv, "--repeats"), null),
        persist: true,
        outputDir,
        runLabel: "check-fresh-run",
      });
      source = {
        mode: "fresh_run",
        report_path: runReport?.artifacts?.report_path || null,
      };
    }
  }

  const shapeIssue = validateRunReportShape(runReport);
  if (shapeIssue) {
    throw new Error(shapeIssue);
  }

  const checkReport = {
    schema_version: CANARY_CHECK_SCHEMA_VERSION,
    checked_at: new Date().toISOString(),
    strict_mode: strictMode,
    source,
    run_id: runReport.run_id || null,
    gate: runReport.gate,
    thresholds: runReport.thresholds || null,
    metrics: runReport.metrics || null,
    degradation_reasons: Array.isArray(runReport?.gate?.degradation_reasons)
      ? runReport.gate.degradation_reasons
      : [],
  };

  console.log(JSON.stringify(checkReport, null, 2));

  if (strictMode && runReport?.gate?.passed !== true) {
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(`check-canary error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
