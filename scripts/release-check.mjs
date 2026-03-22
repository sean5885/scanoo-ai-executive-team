const wantsJson = process.argv.includes("--json");

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
    "  npm run release-check -- --compare-previous",
    "  npm run release-check -- --compare-snapshot <run-id|path>",
    "  npm run release-check -- --json",
  ].join("\n"));
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
    result = await runReleaseCheck();
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
