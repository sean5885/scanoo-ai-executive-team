const wantsJson = process.argv.includes("--json");
const wantsTrend = process.argv.includes("--trend");

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
    "  npm run daily-status -- --trend",
    "  npm run daily-status -- --trend --trend-count <n>",
    "  npm run daily-status -- --compare-previous",
    "  npm run daily-status -- --compare-snapshot <run-id|path>",
    "  npm run daily-status -- --json",
  ].join("\n"));
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

try {
  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const trendCount = getArgValue("--trend-count");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }
  if (wantsTrend && selectors.length > 0) {
    throw new Error("Choose either --trend or compare mode, not both");
  }
  if (!wantsTrend && trendCount !== null) {
    throw new Error("--trend-count requires --trend");
  }

  if (wantsTrend) {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true);

    let renderDailyStatusTrendReport;
    let trendReader;
    let trendSummary;

    try {
      ({
        readDailyStatusTrendSummary: trendReader,
        renderDailyStatusTrendReport,
      } = await import("../src/daily-status.mjs"));
      trendSummary = await trendReader({
        ...(trendCount !== null ? { count: trendCount } : {}),
        ...(process.env.RELEASE_CHECK_ARCHIVE_DIR ? { releaseCheckArchiveDir: process.env.RELEASE_CHECK_ARCHIVE_DIR } : {}),
        ...(process.env.SYSTEM_SELF_CHECK_ARCHIVE_DIR ? { selfCheckArchiveDir: process.env.SYSTEM_SELF_CHECK_ARCHIVE_DIR } : {}),
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    if (wantsJson) {
      console.log(JSON.stringify({ trend_summary: trendSummary }, null, 2));
    } else {
      console.log(renderDailyStatusTrendReport(trendSummary));
    }
    process.exitCode = 0;
  } else {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true);

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
  }
} catch (error) {
  console.error(`daily-status error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
