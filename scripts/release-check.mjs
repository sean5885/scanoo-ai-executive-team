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
  let getReleaseCheckExitCode;
  let runReleaseCheck;
  let renderReleaseCheckReport;
  let result;

  try {
    ({
      getReleaseCheckExitCode,
      runReleaseCheck,
      renderReleaseCheckReport,
    } = await import("../src/release-check.mjs"));
    result = await runReleaseCheck();
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = result?.report || {
    overall_status: "fail",
    blocking_checks: ["system_regression"],
    suggested_next_step: "release-check 執行失敗，先看 system regression 的基礎模組：src/agent-registry.mjs、src/http-route-contracts.mjs、src/*-service.mjs。",
    failing_area: "mixed",
    representative_fail_case: ["release-check execution failed"],
    drilldown_source: ["release-check triage"],
  };

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReleaseCheckReport(report));
  }

  process.exitCode = getReleaseCheckExitCode(report);
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
