const wantsJson = process.argv.includes("--json");

function printUsage() {
  console.log([
    "Usage:",
    "  npm run daily-status",
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
  let getDailyStatusExitCode;
  let renderDailyStatusReport;
  let runReleaseCheck;
  let result;

  try {
    ({
      buildDailyStatusReport,
      getDailyStatusExitCode,
      renderDailyStatusReport,
    } = await import("../src/daily-status.mjs"));
    ({ runReleaseCheck } = await import("../src/release-check.mjs"));
    result = await runReleaseCheck();
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = buildDailyStatusReport(result);

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDailyStatusReport(result));
  }

  process.exitCode = getDailyStatusExitCode(report);
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`daily-status error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
