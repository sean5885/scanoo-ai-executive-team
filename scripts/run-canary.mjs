import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanText, detectDocBoundaryIntent } from "../src/message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "../src/planner-error-codes.mjs";

const originalStdoutWriteForImport = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);
let resolveRoutingEvalCase;
try {
  ({ resolveRoutingEvalCase } = await import("../src/routing-eval.mjs"));
} finally {
  process.stdout.write = originalStdoutWriteForImport;
}

export const CANARY_CASES_SCHEMA_VERSION = "canary_cases_v1";
export const CANARY_RUN_SCHEMA_VERSION = "canary_run_report_v1";
export const DEFAULT_CANARY_CASES_PATH = new URL("../evals/canary/cases.json", import.meta.url);
export const DEFAULT_CANARY_OUTPUT_DIR = ".tmp/canary";

const DEFAULT_THRESHOLDS = Object.freeze({
  min_routing_accuracy_ratio: 0.98,
  min_boundary_accuracy_ratio: 0.98,
  min_stability_ratio: 1,
});
const DEFAULT_STABILITY_REPEATS = 3;

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

function toRatio(numerator = 0, denominator = 0, precision = 4) {
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) {
    return 0;
  }
  return Number((Number(numerator) / Number(denominator)).toFixed(precision));
}

function normalizeRoute(route = {}) {
  return {
    lane: cleanText(route?.lane),
    planner_action: cleanText(route?.planner_action),
    agent_or_tool: cleanText(route?.agent_or_tool),
  };
}

function routeSignature(route = {}) {
  const normalized = normalizeRoute(route);
  return `${normalized.lane}::${normalized.planner_action}::${normalized.agent_or_tool}`;
}

function isFailClosedRoute(route = {}) {
  const normalized = normalizeRoute(route);
  return normalized.planner_action === ROUTING_NO_MATCH
    || normalized.agent_or_tool === `error:${ROUTING_NO_MATCH}`;
}

function evaluateRouteMatch(actual = {}, expected = {}) {
  const normalizedActual = normalizeRoute(actual);
  const normalizedExpected = normalizeRoute(expected);
  return {
    pass:
      normalizedActual.lane === normalizedExpected.lane
      && normalizedActual.planner_action === normalizedExpected.planner_action
      && normalizedActual.agent_or_tool === normalizedExpected.agent_or_tool,
    mismatches: ["lane", "planner_action", "agent_or_tool"].filter(
      (key) => normalizedActual[key] !== normalizedExpected[key],
    ),
    actual: normalizedActual,
    expected: normalizedExpected,
  };
}

function evaluateBoundary(testCase = {}, actualRoute = {}) {
  const expectation = testCase?.boundary_expectation && typeof testCase.boundary_expectation === "object"
    ? testCase.boundary_expectation
    : {};
  const issues = [];
  const docBoundaryIntentObserved = detectDocBoundaryIntent(testCase?.text || "").is_high_confidence_doc_boundary === true;
  const expectedDocBoundaryIntent = expectation.doc_boundary_intent;
  if (typeof expectedDocBoundaryIntent === "boolean" && docBoundaryIntentObserved !== expectedDocBoundaryIntent) {
    issues.push({
      code: "boundary_doc_intent_mismatch",
      message: `doc boundary intent expected=${expectedDocBoundaryIntent} actual=${docBoundaryIntentObserved}`,
    });
  }

  const expectedFailClosed = expectation.must_fail_closed;
  const failClosedObserved = isFailClosedRoute(actualRoute);
  if (typeof expectedFailClosed === "boolean" && expectedFailClosed !== failClosedObserved) {
    issues.push({
      code: "boundary_fail_closed_mismatch",
      message: `fail-closed expected=${expectedFailClosed} actual=${failClosedObserved}`,
    });
  }

  const blockedLanes = Array.isArray(expectation.blocked_lanes)
    ? expectation.blocked_lanes.map((lane) => cleanText(lane)).filter(Boolean)
    : [];
  const actualLane = cleanText(actualRoute?.lane);
  if (blockedLanes.includes(actualLane)) {
    issues.push({
      code: "boundary_blocked_lane_violation",
      message: `actual lane ${actualLane} is blocked by boundary expectation`,
    });
  }

  return {
    pass: issues.length === 0,
    issues,
    observed: {
      doc_boundary_intent: docBoundaryIntentObserved,
      fail_closed: failClosedObserved,
      lane: actualLane,
    },
    expected: {
      doc_boundary_intent: typeof expectedDocBoundaryIntent === "boolean" ? expectedDocBoundaryIntent : null,
      must_fail_closed: typeof expectedFailClosed === "boolean" ? expectedFailClosed : null,
      blocked_lanes: blockedLanes,
    },
  };
}

function evaluateStability(testCase = {}, repeats = DEFAULT_STABILITY_REPEATS) {
  const effectiveRepeats = Math.max(1, Number(repeats) || DEFAULT_STABILITY_REPEATS);
  const routeRuns = [];
  for (let round = 0; round < effectiveRepeats; round += 1) {
    const route = resolveRoutingEvalCase(testCase);
    routeRuns.push({
      lane: cleanText(route?.lane),
      planner_action: cleanText(route?.planner_action),
      agent_or_tool: cleanText(route?.agent_or_tool),
      route_source: cleanText(route?.route_source) || null,
    });
  }

  const signatures = Array.from(new Set(routeRuns.map((route) => routeSignature(route))));
  return {
    pass: signatures.length === 1,
    unique_route_count: signatures.length,
    route_runs: routeRuns,
  };
}

function selectCases(allCases = [], requestedCount = null) {
  if (!Array.isArray(allCases) || allCases.length === 0) {
    return [];
  }

  const limit = parsePositiveInt(requestedCount, allCases.length);
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = index % allCases.length;
    selected.push({
      sample_index: index + 1,
      ...allCases[sourceIndex],
    });
  }
  return selected;
}

function normalizeThresholds(thresholds = {}) {
  return {
    min_routing_accuracy_ratio: Number(thresholds?.min_routing_accuracy_ratio ?? DEFAULT_THRESHOLDS.min_routing_accuracy_ratio),
    min_boundary_accuracy_ratio: Number(thresholds?.min_boundary_accuracy_ratio ?? DEFAULT_THRESHOLDS.min_boundary_accuracy_ratio),
    min_stability_ratio: Number(thresholds?.min_stability_ratio ?? DEFAULT_THRESHOLDS.min_stability_ratio),
  };
}

function buildThresholdFailure({
  code = "",
  metric = "",
  current = 0,
  threshold = 0,
  sampleCaseIds = [],
} = {}) {
  return {
    code,
    metric,
    current: Number(current),
    threshold: Number(threshold),
    delta: Number((Number(current) - Number(threshold)).toFixed(4)),
    sample_case_ids: sampleCaseIds,
  };
}

function evaluateGate({ metrics = {}, thresholds = {}, caseResults = [] } = {}) {
  const failures = [];

  if (Number(metrics.routing_accuracy_ratio || 0) < Number(thresholds.min_routing_accuracy_ratio || 0)) {
    failures.push(buildThresholdFailure({
      code: "routing_accuracy_below_threshold",
      metric: "routing_accuracy_ratio",
      current: metrics.routing_accuracy_ratio,
      threshold: thresholds.min_routing_accuracy_ratio,
      sampleCaseIds: caseResults
        .filter((item) => item.routing?.pass !== true)
        .slice(0, 5)
        .map((item) => item.case_id),
    }));
  }

  if (Number(metrics.boundary_accuracy_ratio || 0) < Number(thresholds.min_boundary_accuracy_ratio || 0)) {
    failures.push(buildThresholdFailure({
      code: "boundary_accuracy_below_threshold",
      metric: "boundary_accuracy_ratio",
      current: metrics.boundary_accuracy_ratio,
      threshold: thresholds.min_boundary_accuracy_ratio,
      sampleCaseIds: caseResults
        .filter((item) => item.boundary?.pass !== true)
        .slice(0, 5)
        .map((item) => item.case_id),
    }));
  }

  if (Number(metrics.stability_ratio || 0) < Number(thresholds.min_stability_ratio || 0)) {
    failures.push(buildThresholdFailure({
      code: "stability_ratio_below_threshold",
      metric: "stability_ratio",
      current: metrics.stability_ratio,
      threshold: thresholds.min_stability_ratio,
      sampleCaseIds: caseResults
        .filter((item) => item.stability?.pass !== true)
        .slice(0, 5)
        .map((item) => item.case_id),
    }));
  }

  return {
    passed: failures.length === 0,
    status: failures.length === 0 ? "pass" : "fail",
    degradation_reasons: failures,
  };
}

function validateCanaryPack(pack = {}) {
  const issues = [];
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    return ["canary cases pack must be an object"];
  }
  if (cleanText(pack.schema_version) !== CANARY_CASES_SCHEMA_VERSION) {
    issues.push(`unsupported canary cases schema_version: ${cleanText(pack.schema_version) || "unknown"}`);
  }
  if (!Array.isArray(pack.cases) || pack.cases.length === 0) {
    issues.push("canary cases pack must provide non-empty cases[]");
  }

  for (const [index, testCase] of (pack.cases || []).entries()) {
    const id = cleanText(testCase?.id);
    if (!id) {
      issues.push(`cases[${index}] missing id`);
    }
    if (!cleanText(testCase?.text)) {
      issues.push(`cases[${index}] missing text`);
    }
    if (!cleanText(testCase?.expected_route?.lane)) {
      issues.push(`cases[${index}] missing expected_route.lane`);
    }
    if (!cleanText(testCase?.expected_route?.planner_action)) {
      issues.push(`cases[${index}] missing expected_route.planner_action`);
    }
    if (!cleanText(testCase?.expected_route?.agent_or_tool)) {
      issues.push(`cases[${index}] missing expected_route.agent_or_tool`);
    }
  }

  return issues;
}

function resolveCasesPath(casesPath = DEFAULT_CANARY_CASES_PATH) {
  if (casesPath instanceof URL) {
    return fileURLToPath(casesPath);
  }
  return path.resolve(process.cwd(), String(casesPath || ""));
}

function resolveOutputPaths(baseDir = DEFAULT_CANARY_OUTPUT_DIR, runId = "") {
  const outputDir = path.resolve(process.cwd(), baseDir);
  return {
    outputDir,
    runsDir: path.join(outputDir, "runs"),
    reportPath: path.join(outputDir, "runs", `${runId}.json`),
    latestPointerPath: path.join(outputDir, "latest-run.json"),
  };
}

export async function loadCanaryCases({ casesPath = DEFAULT_CANARY_CASES_PATH } = {}) {
  const resolvedPath = resolveCasesPath(casesPath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  const issues = validateCanaryPack(parsed);
  if (issues.length > 0) {
    throw new Error(`canary cases invalid: ${issues.join("; ")}`);
  }
  return {
    path: resolvedPath,
    pack: parsed,
  };
}

export async function persistCanaryReport(report = {}, { baseDir = DEFAULT_CANARY_OUTPUT_DIR } = {}) {
  const runId = cleanText(report?.run_id);
  if (!runId) {
    throw new Error("cannot persist canary report without run_id");
  }
  const paths = resolveOutputPaths(baseDir, runId);
  await mkdir(paths.runsDir, { recursive: true });
  await writeFile(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(paths.latestPointerPath, `${JSON.stringify({
    run_id: runId,
    report_path: paths.reportPath,
    generated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  return {
    report_path: paths.reportPath,
    latest_pointer_path: paths.latestPointerPath,
  };
}

export async function resolveLatestCanaryReportPath({ baseDir = DEFAULT_CANARY_OUTPUT_DIR } = {}) {
  const outputDir = path.resolve(process.cwd(), baseDir);
  const latestPointerPath = path.join(outputDir, "latest-run.json");
  if (!existsSync(latestPointerPath)) {
    return null;
  }
  const pointerRaw = await readFile(latestPointerPath, "utf8");
  const pointer = JSON.parse(pointerRaw);
  const reportPath = cleanText(pointer?.report_path);
  if (!reportPath) {
    return null;
  }
  return path.resolve(process.cwd(), reportPath);
}

export async function runCanary({
  casesPath = DEFAULT_CANARY_CASES_PATH,
  casesRequested = null,
  stabilityRepeats = null,
  persist = true,
  outputDir = DEFAULT_CANARY_OUTPUT_DIR,
  runLabel = "cli",
  includeCaseResults = false,
} = {}) {
  const loaded = await loadCanaryCases({ casesPath });
  const pack = loaded.pack;
  const selectedCases = selectCases(pack.cases || [], casesRequested);
  const repeats = parsePositiveInt(stabilityRepeats, parsePositiveInt(pack.default_stability_repeats, DEFAULT_STABILITY_REPEATS));
  const thresholds = normalizeThresholds(pack.thresholds);

  const caseResults = selectedCases.map((testCase) => {
    const stability = evaluateStability(testCase, repeats);
    const representativeRoute = stability.route_runs[0] || {
      lane: "",
      planner_action: "",
      agent_or_tool: "",
    };
    const routing = evaluateRouteMatch(representativeRoute, testCase.expected_route || {});
    const boundary = evaluateBoundary(testCase, representativeRoute);

    const failureCodes = [];
    if (!routing.pass) {
      failureCodes.push("routing_mismatch");
    }
    if (!boundary.pass) {
      failureCodes.push(...boundary.issues.map((issue) => issue.code));
    }
    if (!stability.pass) {
      failureCodes.push("stability_drift_detected");
    }

    return {
      sample_index: Number(testCase.sample_index || 0),
      case_id: cleanText(testCase.id),
      source_case_id: cleanText(testCase.source_case_id) || null,
      category: cleanText(testCase.category) || null,
      text: cleanText(testCase.text),
      routing,
      boundary,
      stability: {
        pass: stability.pass,
        unique_route_count: stability.unique_route_count,
        route_runs: stability.route_runs,
      },
      fail_reasons: Array.from(new Set(failureCodes)),
    };
  });

  const totalCases = caseResults.length;
  const routingPassCount = caseResults.filter((item) => item.routing.pass === true).length;
  const boundaryPassCount = caseResults.filter((item) => item.boundary.pass === true).length;
  const stableCaseCount = caseResults.filter((item) => item.stability.pass === true).length;

  const metrics = {
    total_cases: totalCases,
    total_case_executions: totalCases * repeats,
    routing_pass_count: routingPassCount,
    boundary_pass_count: boundaryPassCount,
    stable_case_count: stableCaseCount,
    routing_mismatch_count: totalCases - routingPassCount,
    boundary_mismatch_count: totalCases - boundaryPassCount,
    unstable_case_count: totalCases - stableCaseCount,
    routing_accuracy_ratio: toRatio(routingPassCount, totalCases),
    boundary_accuracy_ratio: toRatio(boundaryPassCount, totalCases),
    stability_ratio: toRatio(stableCaseCount, totalCases),
  };

  const gate = evaluateGate({
    metrics,
    thresholds,
    caseResults,
  });

  const runId = `canary-${Date.now()}`;
  const report = {
    schema_version: CANARY_RUN_SCHEMA_VERSION,
    run_id: runId,
    generated_at: new Date().toISOString(),
    run_label: cleanText(runLabel) || "cli",
    input: {
      cases_path: loaded.path,
      cases_in_pack: Array.isArray(pack.cases) ? pack.cases.length : 0,
      cases_requested: parsePositiveInt(casesRequested, null),
      cases_selected: totalCases,
      stability_repeats: repeats,
    },
    thresholds,
    metrics,
    gate,
    top_failures: caseResults
      .filter((item) => item.fail_reasons.length > 0)
      .slice(0, 10),
    ...(includeCaseResults ? { case_results: caseResults } : {}),
  };

  if (persist) {
    report.artifacts = await persistCanaryReport(report, { baseDir: outputDir });
  }

  return report;
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/run-canary.mjs",
    "  node scripts/run-canary.mjs --cases=100",
    "  node scripts/run-canary.mjs --cases=100 --repeats=3 --cases-file evals/canary/cases.json",
    "  node scripts/run-canary.mjs --cases=100 --include-cases",
  ].join("\n"));
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

  const report = await runCanary({
    casesPath: getArgValue(argv, "--cases-file") || DEFAULT_CANARY_CASES_PATH,
    casesRequested: parsePositiveInt(getArgValue(argv, "--cases"), null),
    stabilityRepeats: parsePositiveInt(getArgValue(argv, "--repeats"), null),
    persist: !hasFlag(argv, "--no-persist"),
    outputDir: getArgValue(argv, "--out-dir") || DEFAULT_CANARY_OUTPUT_DIR,
    runLabel: "manual",
    includeCaseResults: hasFlag(argv, "--include-cases"),
  });

  console.log(JSON.stringify(report, null, 2));
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(`run-canary error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
