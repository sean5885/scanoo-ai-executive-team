const wantsJson = process.argv.includes("--json");

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run daily-status",
    "  npm run daily-status -- --compare-previous",
    "  npm run daily-status -- --compare-snapshot <run-id|path>",
    "  npm run daily-status -- --json",
  ].join("\n"));
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

try {
  let buildDailyStatusReport;
  let buildDailyStatusCompareSummary;
  let getDailyStatusExitCode;
  let renderDailyStatusCompareReport;
  let renderDailyStatusReport;
  let resolvePreviousReleaseCheckSnapshot;
  let resolveReleaseCheckSnapshot;
  let runReleaseCheck;
  let result;

  try {
    ({
      buildDailyStatusCompareSummary,
      buildDailyStatusReport,
      getDailyStatusExitCode,
      renderDailyStatusCompareReport,
      renderDailyStatusReport,
    } = await import("../src/daily-status.mjs"));
    ({ runReleaseCheck } = await import("../src/release-check.mjs"));
    ({
      resolvePreviousReleaseCheckSnapshot,
      resolveReleaseCheckSnapshot,
    } = await import("../src/release-check-history.mjs"));
    result = await runReleaseCheck();
  } finally {
    process.stdout.write = originalWrite;
  }

  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }

  const report = buildDailyStatusReport(result);
  let compareSummary = null;
  let previousReleaseReport = {};
  if (comparePrevious || compareSnapshot) {
    const compareTarget = comparePrevious
      ? await resolvePreviousReleaseCheckSnapshot({
          reference: result?.release_check_archive?.run_id || "latest",
        })
      : await resolveReleaseCheckSnapshot({
          reference: compareSnapshot,
        });
    previousReleaseReport = compareTarget?.report || {};
    compareSummary = buildDailyStatusCompareSummary({
      releaseCheckResult: result,
      previousReleaseReport,
    });
  }

  if (wantsJson && compareSummary) {
    console.log(JSON.stringify(compareSummary, null, 2));
  } else if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (compareSummary) {
    console.log(renderDailyStatusCompareReport({
      releaseCheckResult: result,
      previousReleaseReport,
    }));
  } else {
    console.log(renderDailyStatusReport(result));
  }

  process.exitCode = getDailyStatusExitCode(report);
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`daily-status error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
