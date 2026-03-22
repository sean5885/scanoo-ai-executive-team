const wantsJson = process.argv.includes("--json");

function printUsage() {
  console.log([
    "Usage:",
    "  npm run release-check",
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
  let runReleaseCheck;
  let renderReleaseCheckReport;
  let result;

  try {
    ({
      runReleaseCheck,
      renderReleaseCheckReport,
    } = await import("../src/release-check.mjs"));
    result = await runReleaseCheck();
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = result?.report || {
    overall_status: "fail",
    blocking_checks: ["self_check_base"],
    suggested_next_step: "release-check 執行失敗，先檢查 self-check 與其依賴模組。",
  };

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReleaseCheckReport(report));
  }

  if (report.overall_status !== "pass") {
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
