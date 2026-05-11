const wantsJson = process.argv.includes("--json");
const writeSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_WRITE_SUMMARY_FIXTURE || "";
const usageSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_USAGE_SUMMARY_FIXTURE || "";
const productionEvalFixturePath = process.env.RELEASE_CHECK_PRODUCTION_EVAL_FIXTURE || "";
const executiveLiveMetricsFixturePath = process.env.RELEASE_CHECK_EXECUTIVE_LIVE_METRICS_FIXTURE || "";
const memoryInfluenceFixturePath = process.env.RELEASE_CHECK_MEMORY_INFLUENCE_FIXTURE || "";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function renderCompareValue(value = "unchanged") {
  if (value === "better") {
    return "變好";
  }
  if (value === "worse") {
    return "變差";
  }
  return "無變化";
}

function renderChangedValue(value = false) {
  return value ? "有改變" : "無改變";
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run release-check",
    "  npm run release-check -- --memory-influence-gate",
    "  npm run release-check -- --memory-influence-gate --require-memory-influence-gate",
    "  npm run release-check -- --compare-previous",
    "  npm run release-check -- --compare-snapshot <run-id|path>",
    "  npm run release-check -- --json",
  ].join("\n"));
}

async function resolveRuntimeOverrides() {
  const enableMemoryInfluenceGate = process.argv.includes("--memory-influence-gate")
    || process.env.RELEASE_CHECK_ENABLE_MEMORY_INFLUENCE_GATE === "1";
  const requireMemoryInfluenceGate = process.argv.includes("--require-memory-influence-gate")
    || process.env.RELEASE_CHECK_REQUIRE_MEMORY_INFLUENCE_GATE === "1";
  if (
    !writeSummaryFixturePath
    && !usageSummaryFixturePath
    && !productionEvalFixturePath
    && !executiveLiveMetricsFixturePath
    && !memoryInfluenceFixturePath
    && !enableMemoryInfluenceGate
    && !requireMemoryInfluenceGate
  ) {
    return {};
  }

  const { readFile } = await import("node:fs/promises");
  const overrides = {};

  if (writeSummaryFixturePath) {
    const raw = await readFile(writeSummaryFixturePath, "utf8");
    const summary = JSON.parse(raw);
    overrides.writeCheck = async () => summary;
  }

  if (usageSummaryFixturePath) {
    const raw = await readFile(usageSummaryFixturePath, "utf8");
    const summary = JSON.parse(raw);
    overrides.usageLayerCheck = async () => summary;
  }
  if (productionEvalFixturePath) {
    const raw = await readFile(productionEvalFixturePath, "utf8");
    overrides.productionEvalReport = JSON.parse(raw);
  }
  if (executiveLiveMetricsFixturePath) {
    const raw = await readFile(executiveLiveMetricsFixturePath, "utf8");
    overrides.executiveLiveMetrics = JSON.parse(raw);
  }
  if (memoryInfluenceFixturePath) {
    const raw = await readFile(memoryInfluenceFixturePath, "utf8");
    const summary = JSON.parse(raw);
    overrides.memoryInfluenceCheck = async () => summary;
  } else if (enableMemoryInfluenceGate || requireMemoryInfluenceGate) {
    const caseCount = Number.parseInt(getArgValue("--memory-gate-cases") || "", 10);
    const memoryHitRateMin = Number.parseFloat(getArgValue("--memory-hit-rate-min") || "");
    const actionChangedRateMin = Number.parseFloat(getArgValue("--action-changed-rate-min") || "");
    const gateConfig = {
      ...(Number.isFinite(caseCount) && caseCount > 0 ? { caseCount } : {}),
      ...(Number.isFinite(memoryHitRateMin) ? { memoryHitRateMin } : {}),
      ...(Number.isFinite(actionChangedRateMin) ? { actionChangedRateMin } : {}),
    };
    overrides.memoryInfluenceCheck = async () => {
      const { buildMemoryInfluenceReport } = await import("../src/memory-influence-gate.mjs");
      return buildMemoryInfluenceReport(gateConfig);
    };
  }
  if (requireMemoryInfluenceGate) {
    overrides.memoryInfluenceGateRequired = true;
  }

  return overrides;
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

try {
  let getReleaseCheckExitCode;
  let buildReleaseCheckCompareSummary;
  let runReleaseCheck;
  let renderReleaseCheckReport;
  let resolvePreviousReleaseCheckSnapshot;
  let resolveReleaseCheckSnapshot;
  let result;

  try {
    ({
      buildReleaseCheckCompareSummary,
      getReleaseCheckExitCode,
      runReleaseCheck,
      renderReleaseCheckReport,
    } = await import("../src/release-check.mjs"));
    ({
      resolvePreviousReleaseCheckSnapshot,
      resolveReleaseCheckSnapshot,
    } = await import("../src/release-check-history.mjs"));
    result = await runReleaseCheck(await resolveRuntimeOverrides());
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = result?.report || {
    overall_status: "fail",
    blocking_checks: ["system_regression"],
    doc_boundary_regression: false,
    suggested_next_step: "release-check 執行失敗，先看 system regression 的基礎模組：src/agent-registry.mjs、src/http-route-contracts.mjs、src/*-service.mjs。",
    action_hint: "inspect blocking_checks and representative_fail_case",
    failing_area: "mixed",
    representative_fail_case: ["release-check execution failed"],
    drilldown_source: ["release-check triage"],
  };
  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }

  let compareSummary = null;
  if (comparePrevious || compareSnapshot) {
    const compareTarget = comparePrevious
      ? await resolvePreviousReleaseCheckSnapshot({
          reference: result?.release_check_archive?.run_id || "latest",
        })
      : await resolveReleaseCheckSnapshot({
          reference: compareSnapshot,
        });
    compareSummary = buildReleaseCheckCompareSummary({
      currentReport: report,
      previousReport: compareTarget?.report || {},
    });
  }

  if (wantsJson && compareSummary) {
    console.log(JSON.stringify(compareSummary, null, 2));
  } else if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (compareSummary) {
    console.log([
      `release 狀態：${renderCompareValue(compareSummary.release_status)}`,
      `blocking_checks：${renderChangedValue(compareSummary.blocking_checks_changed)}`,
      `suggested_next_step：${renderChangedValue(compareSummary.suggested_next_step_changed)}`,
    ].join("\n"));
  } else {
    console.log(renderReleaseCheckReport(report));
  }

  process.exitCode = getReleaseCheckExitCode(report);
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
